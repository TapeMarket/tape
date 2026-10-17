// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {PerpMath} from "../src/libraries/PerpMath.sol";
import {Coin} from "../src/Coin.sol";
import {Staking} from "../src/Staking.sol";
import {LossMining} from "../src/LossMining.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {Sweeper} from "../src/periphery/Sweeper.sol";
import {SweeperBase} from "../src/periphery/SweeperBase.sol";
import {Batcher} from "../src/periphery/Batcher.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {MockPyth} from "./mocks/Mocks.sol";

// ----------------------------------------------------------------------------------------------
// Hostile and awkward coins, hooks, stakers and callers
// ----------------------------------------------------------------------------------------------

/// @dev Burns a share of every transfer: 1% unless told otherwise.
contract FeeCoin is ERC20 {
    uint256 public feeBps = 100;

    constructor() ERC20("Fee", "FEE") {
        _mint(msg.sender, 1_000_000_000e18);
    }

    function setFee(uint256 bps) external {
        feeBps = bps;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}

interface ITokenHook {
    function onTokenTransfer(address from, address to, uint256 amount) external;
}

/// @dev ERC-777 in spirit: a registered sender is called before a transfer, a registered
///      recipient after it.
contract HookCoin is ERC20 {
    mapping(address => bool) public hooked;

    constructor() ERC20("Hook", "HOOK") {
        _mint(msg.sender, 1_000_000_000e18);
    }

    function register() external {
        hooked[msg.sender] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (hooked[from]) ITokenHook(from).onTokenTransfer(from, to, value);
        super._update(from, to, value);
        if (hooked[to]) ITokenHook(to).onTokenTransfer(from, to, value);
    }
}

/// @dev A staker that tries to get back into Staking from inside the coin's transfer hook, and
///      has the Exchange push fees (which lands `notify`, the one unguarded entry) while it is there.
contract ReentrantStaker is ITokenHook {
    Staking public immutable staking;
    Exchange public immutable ex;
    uint256 public attempts;
    uint256 public blocked;
    uint256 public pushed;
    bool public armed;

    constructor(Staking staking_, HookCoin coin_, Exchange ex_) {
        staking = staking_;
        ex = ex_;
        coin_.register();
        coin_.approve(address(staking_), type(uint256).max);
    }

    function arm(bool on) external {
        armed = on;
    }

    function stake(uint256 amount) external {
        staking.stake(amount);
    }

    function unstake(uint256 amount) external {
        staking.unstake(amount);
    }

    function claim() external returns (uint256) {
        return staking.claim();
    }

    function onTokenTransfer(address, address, uint256) external {
        if (!armed) return;
        _try(abi.encodeCall(Staking.stake, (1)));
        _try(abi.encodeCall(Staking.unstake, (1)));
        _try(abi.encodeCall(Staking.claim, ()));
        try ex.pushStakerFees() returns (uint256 amount) {
            pushed += amount;
        } catch {}
    }

    function _try(bytes memory data) private {
        ++attempts;
        (bool ok, bytes memory reason) = address(staking).call(data);
        if (!ok && bytes4(reason) == ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector) {
            ++blocked;
        }
    }
}

/// @dev One coin, several ways to misbehave when LossMining pays a loser.
contract TrickCoin is ERC20 {
    enum Mode {
        Plain,
        Revert,
        ReturnFalse,
        Blacklist,
        BurnGas,
        Reenter,
        Heavy
    }

    Exchange public immutable ex;
    Mode public mode;
    address public banned;
    uint128 public tried;
    uint128 public blocked;

    constructor(Exchange ex_) ERC20("Trick", "TRICK") {
        ex = ex_;
        _mint(msg.sender, 1_000_000_000e18);
    }

    function set(Mode mode_, address banned_) external {
        mode = mode_;
        banned = banned_;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        Mode m = mode;
        if (m == Mode.Revert) revert("transfers are off");
        if (m == Mode.ReturnFalse) return false;
        if (m == Mode.Blacklist && to == banned) revert("blacklisted");
        if (m == Mode.BurnGas) {
            while (true) {}
        }
        if (m == Mode.Reenter) {
            uint128 refused = _reenter(abi.encodeCall(Exchange.harvest, (1)))
                + _reenter(abi.encodeCall(Exchange.deposit, (1)))
                + _reenter(abi.encodeCall(Exchange.donate, (1)))
                + _reenter(abi.encodeCall(Exchange.pushStakerFees, ()))
                + _reenter(abi.encodeCall(Exchange.sweepExcess, (1)))
                + _reenter(abi.encodeCall(Exchange.claimDevFees, ()))
                + _reenter(abi.encodeCall(Exchange.executeWithdraw, (address(this))));
            tried += 7;
            blocked += refused;
        }
        if (m == Mode.Heavy) {
            // A transfer that works, but costs about 300k gas: think of a launchpad coin with
            // tax, anti-bot and swap-back logic in its transfer path.
            bytes32 h;
            for (uint256 i; i < 2_000; ++i) {
                h = keccak256(abi.encode(h, i));
            }
        }
        return super.transfer(to, value);
    }

    function _reenter(bytes memory data) private returns (uint128 refused) {
        (bool ok, bytes memory reason) = address(ex).call(data);
        if (!ok && bytes4(reason) == ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector) {
            return 1;
        }
    }
}

/// @dev A loss-mining hook built for this Exchange (it answers `lossMiningFor()`, so `attachCoin`
///      takes it) that can be told to misbehave.
contract SwitchHook {
    enum Mode {
        Count,
        Revert,
        BurnGas,
        ReturnBomb,
        RevertBomb
    }

    address public immutable exchange;
    Mode public mode;
    uint256 public calls;

    constructor(address exchange_) {
        exchange = exchange_;
    }

    function lossMiningFor() external view returns (address) {
        return exchange;
    }

    function set(Mode mode_) external {
        mode = mode_;
    }

    function onLoss(address, uint256) external {
        Mode m = mode;
        if (m == Mode.Revert) revert("mining down");
        if (m == Mode.BurnGas) {
            while (true) {}
        }
        // 200 kB, as a return value or as a revert reason.
        if (m == Mode.ReturnBomb) {
            assembly {
                return(0, 200000)
            }
        }
        if (m == Mode.RevertBomb) {
            assembly {
                revert(0, 200000)
            }
        }
        ++calls;
    }
}

/// @dev The code an EIP-7702 account delegates to. `exchange` is an immutable, so it is in the
///      code and the delegating account answers `lossMiningFor()` with it too.
contract DelegatedHook {
    address public immutable exchange;
    uint256 public calls;

    constructor(address exchange_) {
        exchange = exchange_;
    }

    function lossMiningFor() external view returns (address) {
        return exchange;
    }

    function onLoss(address, uint256) external {
        ++calls;
    }
}

/// @dev A caller that cannot receive ETH.
contract NoEthCaller {
    function sweep(Sweeper sweeper, bytes[] calldata updates) external payable returns (uint256) {
        return sweeper.sweep{value: msg.value}(updates);
    }
}

/// @dev A caller that sweeps again from inside the ETH refund.
contract GreedyCaller {
    Sweeper public immutable sweeper;
    uint256 public reentered;
    uint256 public sweptAgain;

    constructor(Sweeper sweeper_) {
        sweeper = sweeper_;
    }

    function sweep() external payable returns (uint256) {
        return sweeper.sweep{value: msg.value}(new bytes[](0));
    }

    receive() external payable {
        ++reentered;
        try sweeper.sweep(new bytes[](0)) returns (uint256 amount) {
            sweptAgain += amount;
        } catch {}
    }
}

// ----------------------------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------------------------

/// @dev Second review, brought up to the code with the staking stream, the marked-to-market
///      sweep and the Batcher.
///
///      `test_fixed_<n>_*`   an attack of the first pass, run again as it was, that no longer works;
///      `test_finding_<n>_*` PASSES and shows a problem that is there now (1 to 8 are the
///                           old numbers where something is left of them, 9 and up are new);
///      `test_holds_*`       attacks that were tried and did not work.
///
///      Old finding 8 ran script/AttachCoin.s.sol. The scripts are being rewritten for the
///      three-argument `attachCoin` by someone else and do not compile against this code, so that
///      test (`test_finding_8_theAttachScriptTakesItsInputsOnTrust`) is REMOVED here, not fixed
///      and not re-checked. Its three points (MINING_SCALE typed in dollars, COIN never checked
///      for code, attach before the reserve exists) are about the script and need a fresh look
///      once the new script lands.
abstract contract Review2Base is Base {
    uint64 internal P0;
    uint64 internal ETH0;

    function setUp() public virtual override {
        super.setUp();
        // These tests were written when anyone could call the sweep, and they look at what the
        // Sweeper's own mark lets through, whoever calls. The sweep is an operators' call now
        // (see Sweeper's NatSpec, and HouseTest.test_sweep_isAnOperatorsCallWithACeiling), so
        // here the Sweeper is told that every caller is one. Everything named `finding` below is
        // therefore what an operator who ignored the keeper's exact figure could do, and no
        // longer what a stranger can.
        vm.mockCall(address(ex), abi.encodeWithSelector(ex.isOperator.selector), abi.encode(true));
        P0 = _px(80_000);
        ETH0 = _px(2_500);
    }

    /// @dev A sweep hands its spare ETH back to the caller, and the caller is often this contract.
    receive() external payable {}

    // --------------------------------------------------------------------------------------
    // Staking
    // --------------------------------------------------------------------------------------

    function _stake(address user, uint256 amount) internal {
        coin.transfer(user, amount);
        _stakeOwn(user, amount);
    }

    function _stakeOwn(address user, uint256 amount) internal {
        vm.startPrank(user);
        coin.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    /// @dev Hands USDC to a staking contract the way the Exchange does.
    function _notify(Staking s, uint256 amount) internal {
        usdc.mint(address(s), amount);
        vm.prank(address(ex));
        s.notify(amount);
    }

    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
        skip(12);
    }

    // --------------------------------------------------------------------------------------
    // Trading
    // --------------------------------------------------------------------------------------

    /// @dev Busts `margin` at 1000x: the whole margin is lost.
    function _bust(uint256 pk, uint96 margin) internal {
        bytes32 id = _open(pk, btc, true, margin, 1_000, P0);
        _liquidate(id, _px(79_900));
    }

    /// @dev Busts `margin` at 10x, for margins too large for 1000x under the notional limit.
    function _bust10x(uint256 pk, uint96 margin) internal {
        bytes32 id = _open(pk, btc, true, margin, 10, P0);
        _liquidate(id, _px(72_000));
    }

    /// @dev A long and a short of the same size at the same price, held by one account.
    function _pair(uint256 pk, uint96 margin, uint16 leverage, uint64 price)
        internal
        returns (bytes32 long_, bytes32 short_)
    {
        long_ = _open(pk, btc, true, margin, leverage, price);
        short_ = _open(pk, btc, false, margin, leverage, price);
    }

    /// @dev What a BTC win is worth before the win fee.
    function _gain(uint64 entry, uint64 exit, uint256 notional, bool isLong)
        internal
        pure
        returns (uint256 gain)
    {
        (, gain) = _btcSettle(entry, exit, notional, isLong);
    }

    /// @dev `n` identical BTC opens signed in the same second, landed by the relayer in one batch.
    function _openBatch(uint256 pk, bool isLong, uint96 margin, uint16 leverage, uint64 price, uint256 n)
        internal
        returns (bytes32[] memory ids)
    {
        bytes[] memory calls = new bytes[](n);
        ids = new bytes32[](n);
        bytes[] memory update = _update(BTC_FEED, price, uint64(vm.getBlockTimestamp()) + ex.EXEC_DELAY());
        for (uint256 i; i < n; ++i) {
            Intents.OpenIntent memory it = _intent(vm.addr(pk), btc, isLong, margin, leverage);
            ids[i] = _hashOpen(it);
            calls[i] = abi.encodeCall(Exchange.open, (it, _sign(pk, ids[i]), update));
        }
        skip(12);
        vm.prank(operator);
        bool[] memory ok = batcher.multicall(calls);
        for (uint256 i; i < n; ++i) {
            assertTrue(ok[i], "batched open failed");
        }
    }

    // --------------------------------------------------------------------------------------
    // The sweep
    // --------------------------------------------------------------------------------------

    /// @dev One update per market, both published `age` seconds ago.
    function _marks(uint64 btcPrice, uint64 ethPrice, uint64 age)
        internal
        view
        returns (bytes[] memory updates)
    {
        updates = new bytes[](2);
        uint64 time = uint64(vm.getBlockTimestamp()) - age;
        updates[0] = _update(BTC_FEED, btcPrice, time)[0];
        updates[1] = _update(ETH_FEED, ethPrice, time)[0];
    }

    /// @dev `caller` sweeps, marking BTC at a print `age` seconds old.
    function _sweepBy(address caller, uint64 btcPrice, uint64 age) internal returns (uint256 amount) {
        bytes[] memory updates = _marks(btcPrice, ETH0, age);
        vm.deal(caller, 1 ether);
        vm.prank(caller);
        amount = sweeper.sweep{value: _fee(2)}(updates);
    }

    function _expectNoSweep(address caller, uint64 btcPrice, uint64 age) internal {
        bytes[] memory updates = _marks(btcPrice, ETH0, age);
        vm.deal(caller, 1 ether);
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        vm.prank(caller);
        sweeper.sweep{value: _fee(2)}(updates);
    }

    function _trySweep(uint64 btcPrice) internal returns (bool ok, uint256 amount) {
        bytes[] memory updates = _marks(btcPrice, ETH0, 0);
        try sweeper.sweep{value: _fee(2)}(updates) returns (uint256 swept) {
            return (true, swept);
        } catch {
            return (false, 0);
        }
    }

    /// @dev The Sweeper's own arithmetic for one market, redone here from the Exchange's figures.
    function _owedAt(uint16 market, uint256 price) internal view returns (uint256 owed) {
        Exchange.Market memory m = ex.getMarket(market);
        uint256 longsWorth = Math.mulDiv(m.sizeLong, price, 1e18, Math.Rounding.Ceil);
        uint256 shortsWorth = Math.mulDiv(m.sizeShort, price, 1e18);
        if (longsWorth > m.oiLong) owed += longsWorth - m.oiLong;
        if (m.oiShort > shortsWorth) owed += m.oiShort - shortsWorth;
        owed += _cushion(uint256(m.oiLong) + m.oiShort);
    }

    /// @dev What the Sweeper holds back on top of the mark: `MARGIN_BPS` (20 bps) of everything open.
    function _cushion(uint256 openInterest) internal view returns (uint256) {
        return Math.mulDiv(openInterest, sweeper.MARGIN_BPS(), 10_000, Math.Rounding.Ceil);
    }

    /// @dev The Sweeper's promise, checked: close every open position of these three traders at
    ///      `price` and the house is still at or above its floor, with nobody queued. Leaves no trace.
    function _assertFloorSurvivesClosingEveryone(uint64 price) internal {
        uint256[3] memory pks = [alicePk, bobPk, carolPk];
        uint256 snapshot = vm.snapshotState();
        for (uint256 i; i < 3; ++i) {
            bytes32[] memory ids = ex.openIdsOf(vm.addr(pks[i]));
            for (uint256 j; j < ids.length; ++j) {
                _close(pks[i], ids[j], price);
            }
        }
        assertEq(ex.totalQueued(), 0);
        assertGe(
            ex.lpCash(),
            STAKER_CAP,
            "closing everyone at the sweep's own price took the house below its floor"
        );
        vm.revertToState(snapshot);
    }

    /// @dev What a keeper round does now: push the stakers' fee share once it is worth a
    ///      transaction ($25), and try a sweep at the price of the moment.
    function _keeperPaysStakers(uint64 btcPrice) internal returns (uint256 pushed, uint256 swept) {
        if (ex.stakerFees() >= 25e6) pushed = ex.pushStakerFees();
        (, swept) = _trySweep(btcPrice);
    }

    // --------------------------------------------------------------------------------------
    // Setups
    // --------------------------------------------------------------------------------------

    /// @dev Staking, LossMining and a Sweeper for some other coin, attached.
    function _attachWith(address coin_) internal returns (Staking st, LossMining lm) {
        st = new Staking(IERC20(coin_), IERC20(address(usdc)), address(ex));
        lm = new LossMining(IERC20(coin_), address(ex), MINING_SCALE, address(0));
        sweeper = _newSweeper(ex);
        vm.prank(admin);
        ex.attachCoin(address(st), address(lm), address(sweeper));
    }

    /// @dev The plain coin and its Staking, with `hook` in LossMining's place.
    function _attachHook(address hook) internal {
        coin = new Coin("Tape", "TAPE", SUPPLY, address(this));
        staking = new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(ex));
        sweeper = _newSweeper(ex);
        vm.prank(admin);
        ex.attachCoin(address(staking), hook, address(sweeper));
    }

    /// @dev Replaces the Exchange with one that has a different staker cap. BTC only.
    function _redeployWithCap(uint256 cap) internal {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        oracle = _newOracle(predicted);
        ex = new Exchange(
            "TAPE", IERC20(address(usdc)), oracle, pricing, sessions, admin, dev, cap, MIN_MARGIN
        );
        vm.deal(address(oracle), 1 ether);
        vm.startPrank(admin);
        ex.setOperator(operator, true);
        btc = ex.listMarket(BTC_FEED, "BTC", 1_000, _btcCurve(), MAX_KEEP, 50, 10_000_000e6, 1e15, 1e15);
        vm.stopPrank();
    }

    function _assertBooks() internal view {
        _assertSolvent();
        assertEq(usdc.balanceOf(address(ex)), ex.treasury(), "treasury is every USDC the Exchange holds");
        ex.lpCash();
    }

    /// @dev Smallest gas limit, to within 100, at which an operator liquidation of `id` succeeds.
    ///      Leaves the position open.
    function _minGasToLiquidate(bytes32 id, bytes[] memory update) internal returns (uint256 hi) {
        uint256 snapshot = vm.snapshotState();
        uint256 lo = 30_000;
        hi = 3_000_000;
        while (hi - lo > 100) {
            uint256 mid = (lo + hi) / 2;
            vm.prank(operator);
            try ex.liquidate{gas: mid}(id, update) {
                hi = mid;
                vm.revertToState(snapshot);
            } catch {
                lo = mid;
            }
        }
        vm.revertToState(snapshot);
    }

    function _countMiningFailed(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        bytes32 topic = keccak256("MiningFailed(address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic) ++n;
        }
    }
}

// ==============================================================================================
// THE EIGHT FINDINGS OF THE FIRST PASS, RUN AGAIN
// ==============================================================================================

contract Review2FindingsTest is Review2Base {
    // ======================================================================================
    // FINDING 1 (was HIGH). `lpExcess` paid stakers cash the house still owed to an OPEN winner:
    // hold a long and a short, close the loser, push the loss out as "excess", close the winner
    // and be paid out of the floor.
    //
    // NOW: `pushStakerFees` carries the fee share only, and the excess can leave only through the
    // Sweeper, which first holds back what the open positions are up. A hedged pair on its own is
    // stopped in every order (the three tests below, and the fuzz test in Review2SweeperTest).
    // What is left of it is `test_finding_1_*` at the end of this block, and findings 9 to 11.
    // ======================================================================================

    /// @dev The same attack with the same capital and the same half of the stake. Result now:
    ///        house     at its $5,000,000 floor to the dollar, having kept nothing it owed
    ///        stakers   +$51,359  (the fees, and the $41,878 the pair really left behind)
    ///        attacker  -$35,161  even after collecting half of that over 24 hours
    ///      Was: house -$448,121, attacker +$186,659.
    function test_fixed_1_hedgedPairNoLongerMovesTheHouseFloorToStakers() public {
        _attachCoin();
        _seedHouse(STAKER_CAP); // stands in for $5M of past trader losses
        _stake(alice, 1_000_000e18); // an honest staker
        _stake(bob, 1_000_000e18); // the attacker holds the other half of the stake
        _fund(bob, 2_000_000e6);

        (bytes32 long_, bytes32 short_) = _pair(bobPk, 1_000_000e6, 10, P0);
        uint64 P1 = _px(84_000); // +5%: the short is down $500,000, the long is up
        uint256 gain = _gain(P0, P1, 10_000_000e6, true);
        uint256 profit = gain - (gain * 200) / 10_000;

        // --- The attack, step for step: loser, push, winner.
        _close(bobPk, short_, P1);
        assertEq(ex.lpExcess(), 490_000e6, "the realised loss still reads as cash above the cap");

        // 1. The public push carries the stakers' half of the fee and nothing else.
        vm.prank(bob);
        assertEq(ex.pushStakerFees(), 5_000e6);
        assertEq(ex.lpCash(), STAKER_CAP + 490_000e6, "the excess stayed in the house");

        // 2. Nobody but the sweeper can move the excess.
        vm.prank(bob);
        vm.expectRevert(Exchange.NotOperator.selector);
        ex.sweepExcess(490_000e6);

        // 3. The sweeper marks the open long first: it is up $500,000 (and 20 bps of the $10M open
        //    is held back on top), the excess is $490,000.
        assertEq(_owedAt(btc, P1), 500_000e6 + 20_000e6);
        _expectNoSweep(bob, P1, 0);

        _close(bobPk, long_, P1);
        assertEq(ex.totalQueued(), 0);
        assertEq(ex.lpCash(), STAKER_CAP + 490_000e6 - gain, "the win came out of the loss, not the floor");

        // Only now is anything spare, and it is exactly what the pair left behind.
        assertEq(_sweepBy(bob, P1, 0), 490_000e6 - gain);
        assertEq(ex.lpCash(), STAKER_CAP, "the house is at its floor, not below it");
        ex.pushStakerFees(); // the stakers' half of the fee on the win

        skip(1 days);
        uint256 toStakers = usdc.balanceOf(address(staking));
        assertEq(toStakers, 5_000e6 + (490_000e6 - gain) + (gain * 200) / 10_000 / 2);
        vm.prank(bob);
        uint256 claimed = staking.claim();
        assertApproxEqAbs(claimed, toStakers / 2, 5, "half the stake, half of what stakers were paid");
        assertApproxEqAbs(staking.pendingReward(alice), toStakers / 2, 5);

        uint256 bobEnds = ex.balances(bob);
        assertEq(bobEnds, 2_000_000e6 - 500_000e6 + profit + claimed);
        assertLt(bobEnds, 2_000_000e6 - 30_000e6, "the attacker is more than $30k down");
        _assertBooks();
        console2.log("fixed 1: house above its floor by (USDC)", (ex.lpCash() - STAKER_CAP) / 1e6);
        console2.log("fixed 1: attacker net LOSS (USDC)", (2_000_000e6 - bobEnds) / 1e6);
        console2.log("fixed 1: paid to stakers (USDC)", toStakers / 1e6);
    }

    /// @dev The variant that needed no standing stake: 9M coin held for one block around the
    ///      keeper's payout, between the two closes. Now the keeper's round pushes the $5,000 fee
    ///      share into a 24-hour stream and its sweep is refused, so the borrowed stake earns
    ///      twelve seconds of nine tenths of $5,000: 62 cents. Was: +$384,659.
    function test_fixed_1_aBorrowedStakeBetweenTheClosesEarnsTwelveSecondsOfTheFeeShare() public {
        _attachCoin();
        _seedHouse(STAKER_CAP);
        _stake(alice, 1_000_000e18);
        _fund(bob, 2_000_000e6);
        coin.transfer(bob, 9_000_000e18); // bought, borrowed or pulled from a pool for the occasion

        (bytes32 long_, bytes32 short_) = _pair(bobPk, 1_000_000e6, 10, P0);
        uint64 P1 = _px(84_000);
        uint256 gain = _gain(P0, P1, 10_000_000e6, true);

        _close(bobPk, short_, P1);
        _stakeOwn(bob, 9_000_000e18);
        (uint256 pushed, uint256 swept) = _keeperPaysStakers(P1);
        assertEq(pushed, 5_000e6);
        assertEq(swept, 0, "the keeper's sweep is refused while the long is open");
        _nextBlock();
        vm.startPrank(bob);
        staking.unstake(9_000_000e18);
        uint256 took = staking.claim();
        vm.stopPrank();
        assertApproxEqAbs(took, (uint256(5_000e6) * 12 * 9) / (86_400 * 10), 2, "$0.625");
        _close(bobPk, long_, P1);

        assertLt(ex.balances(bob), 2_000_000e6 - 60_000e6, "the pair cost its owner $60,840");
        assertEq(
            coin.balanceOf(bob),
            9_000_000e18 + mining.totalMined(),
            "the coin is back, plus what the loss mined"
        );
        assertEq(ex.lpCash(), STAKER_CAP + 490_000e6 - gain, "the house is $41,878 ABOVE its floor");
        _assertBooks();
    }

    /// @dev The original launch-day whale's first $10M leg is now rejected by the immutable
    ///      cash ceiling before it can create exposure, mine tokens or change anyone's balances.
    function test_fixed_1_launchDayWhaleNoLongerEmptiesTheHouse() public {
        _attachCoin();
        _fund(bob, 40_000_000e6);
        Intents.OpenIntent memory it = _intent(bob, btc, true, 1_000_000e6, 10);
        bytes memory sig = _sign(bobPk, _hashOpen(it));
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + ex.EXEC_DELAY());
        skip(12);
        vm.prank(operator);
        vm.expectRevert(Exchange.OpenInterestCap.selector);
        ex.open(it, sig, update);
        assertEq(ex.balances(bob), 40_000_000e6);
        assertEq(ex.getMarket(btc).oiLong, 0);
        assertEq(ex.getMarket(btc).oiShort, 0);
        assertEq(ex.lpCash(), 0);
        assertEq(ex.totalQueued(), 0);
        assertEq(mining.totalMined(), 0);
        _assertBooks();
    }

    /// @dev WHAT IS LEFT OF FINDING 1 (MEDIUM). The Sweeper nets each side of a market: what the
    ///      longs are up, TAKEN TOGETHER (Sweeper.sol:119-122). Another trader's long that is
    ///      under water therefore cancels the attacker's long that is in profit, and nothing is
    ///      held back for it, although the attacker can close and be paid today while the other
    ///      trader's loss is only on paper. All that is held back is the 20 bps cushion on
    ///      everything open (Sweeper.sol:123), which was not written for this.
    ///
    ///      Here, with a fresh and accurate price: Carol (an ordinary trader) is long $20M at 5x
    ///      from 88,000 and $909k under water at 84,000. Bob runs the pair of finding 1. Result:
    ///        swept to stakers   $430,000 (the realised loss less the $60,000 cushion on the $30M
    ///                           open; should have been $0)
    ///        house              -$388,121 below its floor once Bob's long is paid
    ///        attacker           +$158,899 after 24 hours of staking (was +$186,659 in a block)
    ///      If BTC then returns to 88,000 Carol closes flat and the hole is permanent; if it
    ///      falls instead, her loss fills it. The house was left holding a bet in place of cash.
    ///
    ///      Needs: a side under water in aggregate by at least the winner's gain (after any sharp
    ///      move, the side that was caught is), open interest small enough that 20 bps of it is
    ///      less than the loss to be swept, and for the profit a stake of more than about 14%
    ///      held for the day the payout streams.
    function test_finding_1_aWinnerStillHidesBehindOtherTradersLosingPositions() public {
        _attachCoin();
        _seedHouse(STAKER_CAP);
        _stake(alice, 1_000_000e18);
        _stake(bob, 1_000_000e18);
        _fund(bob, 2_000_000e6);
        _fund(carol, 4_000_000e6);

        // Carol got long higher up: 2 x $10M at 5x from 88,000.
        bytes32 c1 = _open(carolPk, btc, true, 2_000_000e6, 5, _px(88_000));
        bytes32 c2 = _open(carolPk, btc, true, 2_000_000e6, 5, _px(88_000));
        // BTC falls to 80,000 and Bob puts the pair on; it recovers to 84,000.
        (bytes32 long_, bytes32 short_) = _pair(bobPk, 1_000_000e6, 10, P0);
        uint64 P1 = _px(84_000);
        uint256 gain = _gain(P0, P1, 10_000_000e6, true);
        uint256 profit = gain - (gain * 200) / 10_000;

        _close(bobPk, short_, P1);
        assertEq(ex.lpExcess(), 490_000e6);
        assertEq(
            _owedAt(btc, P1), 60_000e6, "Bob's $500,000 gain has vanished behind Carol's $909,091 paper loss"
        );
        assertEq(_cushion(30_000_000e6), 60_000e6, "what is held back is the cushion and nothing else");
        assertEq(_sweepBy(bob, P1, 0), 430_000e6, "at a fresh and accurate price");

        _close(bobPk, long_, P1);
        assertEq(ex.totalQueued(), 0);
        assertEq(ex.lpCash(), STAKER_CAP + 60_000e6 - gain, "the win came out of the floor");

        // Carol's loss was never cash. BTC goes back up and she closes flat.
        _close(carolPk, c1, _px(88_000));
        _close(carolPk, c2, _px(88_000));
        assertEq(ex.balances(carol), 4_000_000e6);
        assertEq(
            ex.lpCash(),
            STAKER_CAP + 60_000e6 - gain,
            "nothing is open and the house is $388,121 short of its floor"
        );

        ex.pushStakerFees();
        skip(1 days);
        vm.prank(bob);
        uint256 claimed = staking.claim();
        assertApproxEqAbs(claimed, (435_000e6 + (gain * 200) / 10_000 / 2) / 2, 5);
        uint256 bobEnds = ex.balances(bob);
        assertEq(bobEnds, 2_000_000e6 - 500_000e6 + profit + claimed);
        assertGt(bobEnds, 2_000_000e6 + 158_000e6, "the attacker is $158k up");
        _assertBooks();
        console2.log("finding 1 (left): house below its floor by (USDC)", (STAKER_CAP - ex.lpCash()) / 1e6);
        console2.log("finding 1 (left): attacker net profit (USDC)", (bobEnds - 2_000_000e6) / 1e6);
    }

    // ======================================================================================
    // FINDING 2 (was MEDIUM). A distribution went to whoever was staked in that one block, and
    // only the operator could trigger it.
    //
    // NOW: Staking pays a 24-hour stream (Staking.sol:141-151, 219-226). A stake earns for the
    // seconds it is staked. There is no distribute() and no operator.
    // ======================================================================================

    /// @dev The same $990,000 payout and the same 9M coin held over one block boundary.
    ///      Was: attacker $891,000, Alice $99,000. Now: attacker $123.75, Alice the rest.
    function test_fixed_2_oneBlockStakeEarnsOneBlockOfTheStream() public {
        _attachCoin();
        _seedHouse(STAKER_CAP);
        _stake(alice, 1_000_000e18);
        vm.roll(vm.getBlockNumber() + 216_000);
        skip(30 days);

        _fund(carol, 1_000_000e6);
        _bust10x(carolPk, 1_000_000e6);
        assertEq(ex.stakerFees() + ex.lpExcess(), 990_000e6, "the size of the next payout is public");

        // Same block as the keeper's push and sweep, ahead of them.
        _stake(bob, 9_000_000e18);
        (uint256 pushed, uint256 swept) = _keeperPaysStakers(_px(72_000));
        assertEq(pushed + swept, 990_000e6);

        _nextBlock();
        vm.startPrank(bob);
        staking.unstake(9_000_000e18);
        uint256 took = staking.claim();
        vm.stopPrank();

        assertApproxEqAbs(took, (uint256(990_000e6) * 12 * 9) / (86_400 * 10), 2, "$123.75");
        assertEq(coin.balanceOf(bob), 9_000_000e18, "coin back in hand one block later");
        skip(1 days);
        assertApproxEqAbs(staking.pendingReward(alice), 990_000e6 - took, 3, "everything else is Alice's");
    }

    /// @dev The operator key decided who was paid and when. Now nobody does: Staking has no
    ///      distribute(), the push and the sweep are open to anyone (here Alice herself), and a
    ///      partner arriving with 99x her stake for the block of a payment takes $1.36 of it
    ///      instead of 99% of six months.
    function test_fixed_2_noKeyDecidesWhoIsPaidOrWhen() public {
        _attachCoin();
        _seedHouse(STAKER_CAP);
        _stake(alice, 1_000_000e18);
        _fund(carol, 100_000e6);

        (bool exists,) = address(staking).call(abi.encodeWithSignature("distribute()"));
        assertFalse(exists, "there is nothing to withhold with");

        address partner = makeAddr("partner");
        coin.transfer(partner, 99_000_000e18);
        uint256 pot;
        for (uint256 i; i < 6; ++i) {
            _bust(carolPk, 10_000e6);
            vm.prank(alice);
            pot += ex.pushStakerFees();
            pot += _sweepBy(alice, P0, 0);
            if (i < 5) skip(30 days);
        }
        assertEq(pot, 59_400e6);
        assertApproxEqAbs(staking.pendingReward(alice), 49_500e6, 10, "five months are hers already");

        _stakeOwn(partner, 99_000_000e18);
        _nextBlock();
        vm.startPrank(partner);
        staking.unstake(99_000_000e18);
        uint256 took = staking.claim();
        vm.stopPrank();
        assertApproxEqAbs(took, (uint256(9_900e6) * 12 * 99) / (86_400 * 100), 2, "$1.36");
        skip(1 days);
        assertApproxEqAbs(staking.pendingReward(alice), pot - took, 12);
    }

    // ======================================================================================
    // FINDING 3 (was MEDIUM). One wei staked took everything that accrued before the coin.
    //
    // NOW: what arrives while nobody is staked waits, and starts as a fresh 24-hour stream when
    // the first staker arrives (Staking.sol:145-148, 180-184).
    // ======================================================================================

    /// @dev The same $10,000 backlog and the same one-wei stake. Was: all $10,000. Now: $1.39 for
    ///      the one block it was alone, and nothing measurable after a real staker arrives.
    ///      Left over, and inherent: whoever stakes first earns the stream alone until somebody
    ///      else stakes ($416.67 an hour on this backlog). Stake in the same breath as attaching.
    function test_fixed_3_oneWeiStakeNoLongerTakesTheBacklog() public {
        _fund(carol, 1_000_000e6);
        for (uint256 i; i < 5; ++i) {
            _bust10x(carolPk, 200_000e6);
        }
        assertEq(ex.stakerFees(), 10_000e6);

        _attachCoin();
        uint256 attached = vm.snapshotState();
        coin.transfer(bob, 1);
        _stakeOwn(bob, 1);
        ex.pushStakerFees(); // the keeper, or anyone
        uint256 pushed = vm.snapshotState();

        _nextBlock();
        _stake(alice, 100_000_000e18);
        uint256 oneBlock = (uint256(10_000e6) * 12) / 86_400;
        assertApproxEqAbs(staking.pendingReward(bob), oneBlock, 1, "$1.39");
        skip(1 days);
        assertApproxEqAbs(staking.pendingReward(bob), oneBlock, 1, "and one part in 1e26 from there on");
        assertApproxEqAbs(staking.pendingReward(alice), 10_000e6 - oneBlock, 3);

        // Alone for an hour: an hour of it.
        vm.revertToState(pushed);
        skip(1 hours);
        assertApproxEqAbs(staking.pendingReward(bob), uint256(10_000e6) / 24, 1, "$416.67");

        // The other order, push first: it waits, and one wei arriving sets it flowing, no faster.
        vm.revertToState(attached);
        ex.pushStakerFees();
        assertEq(staking.waiting(), 10_000e6);
        assertEq(staking.rewardRate(), 0);
        coin.transfer(bob, 1);
        _stakeOwn(bob, 1);
        assertEq(staking.waiting(), 0);
        assertEq(staking.pendingReward(bob), 0);
        _nextBlock();
        assertApproxEqAbs(staking.pendingReward(bob), oneBlock, 1);
    }

    // ======================================================================================
    // FINDING 4 (was LOW). Fees were taken, and paid out, ahead of a winner the house still owed.
    //
    // NOW (first part): both fee checks also require the house to cover `debtMarginOpen`, the
    // queued payouts their owners have parked as margin (Exchange.sol:948, 981).
    // ======================================================================================

    /// @dev The same sequence. Was: $1.60 of Alice's $80 loss went to fees and Bob ended up $1.60
    ///      short. Now: no fee is taken (the house holds $80 against $86 owed), nothing can be
    ///      pushed or claimed, and all $80 goes to Bob.
    function test_fixed_4_feesAreNoLongerTakenAheadOfAWinnerParkedInMargin() public {
        _attachCoin();
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);

        // Bob wins against an empty house: his profit is queued.
        bytes32 won = _open(bobPk, btc, true, 100e6, 100, P0);
        _close(bobPk, won, _px(80_800));
        uint256 owed = ex.queuedOf(bob);
        assertGt(owed, 86e6);

        // He parks the whole claim as margin. The queue now reads empty; the debt is still there.
        bytes32 parked = _openQueued(bobPk, btc, true, uint96(owed), 1, P0);
        assertEq(ex.totalQueued(), 0);
        assertEq(ex.debtMarginOpen(), owed);

        // Alice loses $80. The house holds $80 against $86 owed: no fee.
        _bust(alicePk, 80e6);
        assertEq(ex.stakerFees(), 0);
        assertEq(ex.devFees(), 0);
        assertEq(ex.lpCash(), 80e6);
        assertEq(ex.lpExcess(), 0);
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.pushStakerFees();
        vm.expectRevert(Exchange.ZeroAmount.selector);
        ex.claimDevFees();
        assertEq(usdc.balanceOf(address(staking)), 0);

        // Bob closes flat and gets every dollar the house has.
        _close(bobPk, parked, P0);
        assertEq(ex.balances(bob), 1_000e6 + 80e6);
        assertEq(ex.queuedOf(bob), owed - 80e6);
        _assertBooks();
    }

    /// @dev NOT CHANGED (NOTE, as before). A fee accrued with nobody queued is still pushed to
    ///      stakers after a queue has formed: $1 here, with a winner waiting for $75. That dollar
    ///      was the stakers' already when the queue formed; it is the README sentence ("Nothing
    ///      reaches stakers while winners are queued") that is wrong, not the books.
    function test_finding_4_accruedFeesStillLeaveWhileWinnersWait() public {
        _attachCoin();
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        _bust(alicePk, 100e6); // fee accrues: nobody is queued
        assertEq(ex.stakerFees(), 1e6);

        bytes32 won = _open(bobPk, btc, true, 200e6, 100, P0);
        _close(bobPk, won, _px(80_800)); // the house has $98 and owes about $173
        assertGt(ex.totalQueued(), 70e6);
        assertEq(ex.lpCash(), 0);

        assertEq(ex.pushStakerFees(), 1e6, "paid to stakers with a winner waiting");
        assertEq(ex.claimDevFees(), 1e6);
        _assertBooks();
    }

    // ======================================================================================
    // FINDING 5 (was LOW). `attachCoin` accepted any two contracts, once, for ever.
    //
    // NOW: each of the three contracts is asked which Exchange it was built for under a name only
    // its own kind answers: `stakingFor()`, `lossMiningFor()`, `sweeperFor()` (Exchange.sol:772-786).
    // (When this pass began all three were asked the same `exchange()`, which every one of them
    // answers, so any ORDER of the three still went through; that was changed while this file
    // was being written.)
    // ======================================================================================

    /// @dev FIXED. The arguments in the wrong order: every permutation of the three but the right
    ///      one is refused, and since nothing was attached the right one still goes through.
    function test_fixed_5_swappedAttachIsRefused() public {
        coin = new Coin("Tape", "TAPE", SUPPLY, address(this));
        staking = new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(ex));
        mining = new LossMining(IERC20(address(coin)), address(ex), MINING_SCALE, address(0));
        sweeper = _newSweeper(ex);
        address[3] memory c = [address(staking), address(mining), address(sweeper)];

        vm.startPrank(admin);
        uint256 refused;
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                for (uint256 k; k < 3; ++k) {
                    if (i == 0 && j == 1 && k == 2) continue;
                    vm.expectRevert();
                    ex.attachCoin(c[i], c[j], c[k]);
                    ++refused;
                }
            }
        }
        assertEq(refused, 26, "every other way of handing over these three, repeats included");
        assertEq(ex.staking(), address(0));
        ex.attachCoin(c[0], c[1], c[2]);
        vm.stopPrank();

        // And attached the right way round, the money flows.
        coin.transfer(address(mining), RESERVE);
        _seedHouse(STAKER_CAP);
        _fund(alice, 10_000e6);
        _bust(alicePk, 10_000e6);
        assertGt(coin.balanceOf(alice), 0);
        assertEq(ex.pushStakerFees(), 100e6);
        assertEq(_sweep(P0, ETH0), 9_800e6);
    }

    /// @dev FIXED. Contracts built for another Exchange are refused, in either slot, and since
    ///      nothing was attached the right ones still can be.
    function test_fixed_5_contractsOfAnotherExchangeAreRefused() public {
        address other = makeAddr("some other exchange");
        coin = new Coin("Tape", "TAPE", SUPPLY, address(this));
        Staking theirStaking = new Staking(IERC20(address(coin)), IERC20(address(usdc)), other);
        LossMining theirMining = new LossMining(IERC20(address(coin)), other, MINING_SCALE, address(0));
        staking = new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(ex));
        mining = new LossMining(IERC20(address(coin)), address(ex), MINING_SCALE, address(0));
        sweeper = _newSweeper(ex);

        vm.startPrank(admin);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(theirStaking), address(theirMining), address(sweeper));
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(theirStaking), address(mining), address(sweeper));
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(staking), address(theirMining), address(sweeper));
        assertEq(ex.staking(), address(0));
        ex.attachCoin(address(staking), address(mining), address(sweeper));
        vm.stopPrank();
        assertEq(ex.staking(), address(staking));
    }

    // ======================================================================================
    // FINDING 6 (was LOW, owner only). A hook whose code went away blocked every losing
    // settlement, because `try hook.onLoss()` reverts when its target has no code.
    //
    // NOW: a plain gas-capped call (Exchange.sol:1094). A call to an account without code
    // succeeds and does nothing.
    // ======================================================================================

    /// @dev The same EIP-7702 account: delegated at attach time (it has to answer
    ///      `lossMiningFor()` now, which a delegation to code with an immutable does), then cleared. Was: no
    ///      liquidation and no losing close could settle while winners were still paid. Now the
    ///      liquidation goes through, silently: no coin, no MiningFailed.
    ///
    ///      Run on the Prague EVM (mainnet's), with a real EIP-7702 authorisation.
    /// forge-config: default.evm_version = "prague"
    function test_fixed_6_aDelegatedAccountCanNoLongerSwitchLossesOff() public {
        uint256 hookPk = 0x7702;
        address hook = vm.addr(hookPk);
        DelegatedHook implementation = new DelegatedHook(address(ex));
        coin = new Coin("Tape", "TAPE", SUPPLY, address(this));
        staking = new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(ex));
        sweeper = _newSweeper(ex);

        vm.signAndAttachDelegation(address(implementation), hookPk);
        vm.prank(admin);
        ex.attachCoin(address(staking), hook, address(sweeper));
        assertEq(hook.code.length, 23, "an EOA with a delegation counts as a contract");

        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        _seedHouse(1_000e6);
        _bust(alicePk, 100e6);
        assertEq(DelegatedHook(hook).calls(), 1, "delegated: the hook is called");

        bytes32 lost = _open(alicePk, btc, true, 100e6, 100, P0);
        bytes32 loser = _open(alicePk, btc, true, 100e6, 1_000, P0);
        bytes32 winner = _open(bobPk, btc, false, 100e6, 1_000, P0);

        // The key holder clears the delegation.
        vm.signAndAttachDelegation(address(0), hookPk);
        vm.prank(admin);
        ex.setGuardian(guardian); // any transaction carries the authorisation
        assertEq(hook.code.length, 0);

        vm.recordLogs();
        _liquidate(loser, _px(79_900));
        assertEq(ex.getPosition(loser).owner, address(0), "the busted position is liquidated all the same");
        _close(alicePk, lost, _px(79_600));
        assertEq(ex.getPosition(lost).owner, address(0), "and so is a losing close");
        assertEq(_countMiningFailed(vm.getRecordedLogs()), 0, "silently: an empty account 'succeeds'");
        assertEq(ex.balances(alice), 1_000e6 - 100e6 - 100e6 - 50e6);

        _close(bobPk, winner, _px(79_900));
        assertGt(ex.balances(bob), 1_000e6);
        _assertBooks();
    }

    /// @dev The same thing without EIP-7702: the real LossMining with its code taken away.
    function test_fixed_6_aHookWithNoCodeLeftCannotBlockALoss() public {
        _attachCoin();
        _fund(alice, 1_000e6);
        _seedHouse(1_000e6);
        bytes32 lost = _open(alicePk, btc, true, 100e6, 100, P0);
        bytes32 loser = _open(alicePk, btc, true, 100e6, 1_000, P0);

        vm.etch(address(mining), hex"");
        assertEq(address(mining).code.length, 0);

        vm.recordLogs();
        _close(alicePk, lost, _px(79_600));
        _liquidate(loser, _px(79_900));
        assertEq(_countMiningFailed(vm.getRecordedLogs()), 0);
        assertEq(ex.openIdsOf(alice).length, 0);
        assertEq(ex.balances(alice), 850e6);
        assertEq(coin.balanceOf(alice), 0, "no coin, of course");
        _assertBooks();
    }

    // ======================================================================================
    // FINDING 7 (RESOLVED). Heavy transfers defer delivery into a retryable reserved reward.
    // The Exchange hook still gets 150,000 gas; a later claim is not capped by that hook budget.
    // ======================================================================================

    /// @dev A transfer too expensive for automatic delivery still records the loss and entitlement.
    ///      A claim with enough gas delivers it once without changing the emission curve.
    function test_holds_aHeavyCoinDefersMiningDeliveryAndCanBeClaimed() public {
        TrickCoin heavy = new TrickCoin(ex);
        (, LossMining lm) = _attachWith(address(heavy));
        heavy.transfer(address(lm), RESERVE);
        heavy.set(TrickCoin.Mode.Heavy, address(0));

        // The coin itself works for anyone who brings enough gas.
        heavy.transfer(bob, 1e18);
        assertEq(heavy.balanceOf(bob), 1e18);

        _fund(alice, 1_000e6);
        uint256 reward = lm.quote(100e6);
        vm.recordLogs();
        _bust(alicePk, 100e6);
        assertEq(_countMiningFailed(vm.getRecordedLogs()), 0);

        assertEq(ex.balances(alice), 900e6, "the loss itself settled");
        assertEq(heavy.balanceOf(alice), 0);
        assertEq(lm.cumulativeLossUsd(), 100e6);
        assertEq(lm.pendingRewards(alice), reward);
        assertEq(lm.totalMined(), reward);
        assertEq(lm.reserve(), RESERVE - reward);
        lm.claim(alice);
        assertEq(heavy.balanceOf(alice), reward);
        assertEq(lm.totalPending(), 0);
        assertEq(lm.reserve(), RESERVE - reward);
    }

    // FINDING 8 (NOTE): script/AttachCoin.s.sol. Test removed, see the note on Review2Base.
}

// ==============================================================================================
// THE SWEEPER
// ==============================================================================================

contract Review2SweeperTest is Review2Base {
    function _pairAtTheFloor() internal returns (bytes32 long_, bytes32 short_) {
        _attachCoin();
        _seedHouse(STAKER_CAP);
        _stake(alice, 1_000_000e18);
        _stake(bob, 1_000_000e18);
        _fund(bob, 4_500_000e6);
        (long_, short_) = _pair(bobPk, 1_000_000e6, 10, P0);
    }

    // ======================================================================================
    // FINDING 9 (MEDIUM). The caller of `sweep` picks the price: any print of the last 60 seconds
    // (Sweeper.sol:36, 105-107). Two things follow. The 20 bps cushion added while this file was
    // being written (Sweeper.sol:39, 123) takes the first 20 bps off both; the numbers below are
    // what gets past it.
    // ======================================================================================

    /// @dev (i) An older print hides its distance from the current price, dollar for dollar:
    ///      $1,000 for every basis point, for every $10M of winning size.
    ///
    ///      BTC went from 80,080 to 80,400 inside a minute. Bob closes the losing short at 80,400
    ///      (-$50,000, so $49,000 above the cap) and sweeps with the 80,080 print: his long is
    ///      marked $10,000 up instead of $50,000, another $20,000 is held back as the cushion,
    ///      $19,000 is swept, and the long is then closed at 80,400 and paid out of the floor:
    ///      house -$13,177. (Before the cushion: $39,000 swept, house -$33,177.)
    function test_finding_9_theCallerPicksAnyPrintOfTheLastMinute() public {
        (bytes32 long_, bytes32 short_) = _pairAtTheFloor();
        uint64 P1 = _px(80_400);
        uint64 stale = _px(80_080);
        uint256 gain = _gain(P0, P1, 10_000_000e6, true);

        _close(bobPk, short_, P1);
        assertEq(ex.lpExcess(), 49_000e6);

        // At the price of the moment the sweep is refused, as it should be.
        assertEq(_owedAt(btc, P1), 50_000e6 + 20_000e6);
        _expectNoSweep(bob, P1, 0);

        // A print one second too old is refused too. Sixty seconds is fine.
        bytes[] memory tooOld = _marks(stale, ETH0, 31);
        vm.expectRevert(_noPrice());
        sweeper.sweep{value: _fee(2)}(tooOld);

        assertEq(_owedAt(btc, stale), 10_000e6 + 20_000e6);
        assertEq(_owedAt(btc, P1) - _owedAt(btc, stale), 40 * 1_000e6, "40 bps on $10M hides $40,000");
        assertEq(_sweepBy(bob, stale, 30), 19_000e6);

        _close(bobPk, long_, P1);
        assertEq(ex.lpCash(), STAKER_CAP + 30_000e6 - gain);
        assertLt(ex.lpCash(), STAKER_CAP - 13_000e6, "the floor is $13k short");
        _assertBooks();
        console2.log("finding 9(i): house below its floor by (USDC)", (STAKER_CAP - ex.lpCash()) / 1e6);
    }

    /// @dev (ii) Worse: a position opened NOW, at the current price, is marked at the older
    ///      print too, where it looks like a loser. Longs are netted (finding 1, what is left),
    ///      so fresh longs of the right size wipe out the hold-back for any long in profit, at no
    ///      cost: they are closed flat a block later. Each decoy also adds 20 bps of its size to
    ///      the cushion, so this pays only when the older print is MORE than 20 bps away; then a
    ///      winner's hold-back shrinks from its gain G to about G * 20 bps / gap.
    ///
    ///      The pair of finding 1 again (+5%, $500,000 loss on the short). BTC is at 84,000 and
    ///      printed 83,580 (50 bps lower) within the last minute. Without decoys the old print
    ///      alone frees $22,500. Bob opens 9 x $10M of fresh 100x longs ($900,000 of margin,
    ///      which he gets back) in one relayer batch. At 83,580 they "lose" $450,000 between
    ///      them, his real long is "up" $447,500, the side nets to nothing, and only the cushion
    ///      ($200,000 on the $100M now open) stays behind: $290,000 is swept. Then everything is
    ///      closed at 84,000:
    ///        house     -$248,121 below its floor
    ///        attacker  +$88,899 after a day staked
    ///      (Before the cushion a 20 bps gap was enough for the whole $490,000: house -$448,121,
    ///      attacker +$188,899, the original finding 1 in full.) The pair costs nothing to hold
    ///      while waiting for a sharp minute. Nor does it take a pair: any staker can do this to
    ///      the hold-back for OTHER traders' open winners whenever a sweep is due.
    function test_finding_9_aFreshPositionMarkedAtAnOldPrintHidesAWinner() public {
        (bytes32 long_, bytes32 short_) = _pairAtTheFloor();
        uint64 P1 = _px(84_000);
        uint64 stale = _px(83_580);
        uint256 gain = _gain(P0, P1, 10_000_000e6, true);
        uint256 profit = gain - (gain * 200) / 10_000;

        _close(bobPk, short_, P1);
        assertEq(ex.lpExcess(), 490_000e6);
        assertEq(_owedAt(btc, stale), 447_500e6 + 20_000e6, "the old print alone: $22,500 could go");
        bytes32[] memory decoys = _openBatch(bobPk, true, 100_000e6, 100, P1, 9);

        // Marked where they were opened they only add to what is held back.
        assertEq(_owedAt(btc, P1), 500_000e6 + 200_000e6);
        _expectNoSweep(bob, P1, 0);

        // Marked at a print that is older than they are, they are a $450,000 loss that never was.
        assertEq(_owedAt(btc, stale), 200_000e6, "the cushion and nothing else");
        assertEq(_sweepBy(bob, stale, 30), 290_000e6, "with the winner still open");

        for (uint256 i; i < decoys.length; ++i) {
            _close(bobPk, decoys[i], P1);
        }
        assertEq(ex.balances(bob), 4_500_000e6 - 1_000_000e6 - 500_000e6, "the decoys cost nothing");
        _close(bobPk, long_, P1);
        assertEq(ex.openIdsOf(bob).length, 0);
        assertEq(ex.lpCash(), STAKER_CAP + 200_000e6 - gain, "the win came out of the floor");

        ex.pushStakerFees();
        skip(1 days);
        vm.prank(bob);
        uint256 claimed = staking.claim();
        uint256 bobEnds = ex.balances(bob);
        assertEq(bobEnds, 4_500_000e6 - 500_000e6 + profit + claimed);
        assertGt(bobEnds, 4_500_000e6 + 88_000e6, "the attacker is $88k up");
        _assertBooks();
        console2.log("finding 9(ii): house below its floor by (USDC)", (STAKER_CAP - ex.lpCash()) / 1e6);
        console2.log("finding 9(ii): attacker net profit (USDC)", (bobEnds - 4_500_000e6) / 1e6);
    }

    // ======================================================================================
    // FINDING 10 (LOW). A position past zero equity that nobody has liquidated yet counts for
    // its whole raw loss, though the house will only ever get its margin. The 20 bps cushion
    // added while this file was being written (Sweeper.sol:22-28, 39, 123) covers the first
    // stretch of it and no more.
    // ======================================================================================

    /// @dev The Sweeper's promise is "what the house could spare if every open position closed
    ///      right now". This breaks it with a fresh, accurate price. The aggregate credits a
    ///      loser with notional * move, without limit; the cushion gives back 20 bps of
    ///      everything open. A busted 1000x long that is $98,039 under water on $10,000 of margin
    ///      hides $98,039 of the longs' gains and brings in $9,800.
    ///
    ///      Carol is long $10M at 1000x from 81,600. BTC is at 80,800, 98 bps lower, and her
    ///      liquidation has not landed. Bob's pair from 80,000: short closed (-$100,000), long up
    ///      $100,000.
    ///        sweep first       $56,039 swept; after the liquidation and Bob's close the house is
    ///                          $36,386 BELOW its floor, with nothing open
    ///        liquidate first   nothing can be swept; the house ends $19,653 ABOVE its floor
    ///      Each dollar a position is under water beyond its margin hides a dollar, less the
    ///      cushion. It takes a liquidation that is late by a move of well over 20 bps: a keeper
    ///      backlog in a crash, or a keeper that is down (for the first 60 seconds after a touch
    ///      nobody else may liquidate, Exchange.sol:601).
    function test_finding_10_aBustedPositionNotYetLiquidatedHidesAWinner() public {
        (bytes32 long_, bytes32 short_) = _pairAtTheFloor();
        _fund(carol, 10_000e6);
        bytes32 doomed = _open(carolPk, btc, true, 10_000e6, 1_000, _px(81_600));
        uint64 P1 = _px(80_800);
        assertLt(P1, _bustOf(doomed), "far through its bust price");
        uint256 gain = _gain(P0, P1, 10_000_000e6, true);

        _close(bobPk, short_, P1);
        assertEq(ex.lpExcess(), 98_000e6);
        uint256 snapshot = vm.snapshotState();

        // --- Control: the liquidation lands first. Carol's margin comes in, Bob's gain is held back.
        _liquidate(doomed, P1);
        assertEq(_owedAt(btc, P1), 100_000e6 + 20_000e6);
        _expectNoSweep(bob, P1, 0);
        _close(bobPk, long_, P1);
        assertEq(ex.lpCash(), STAKER_CAP + 98_000e6 + 9_800e6 - gain);
        assertGt(ex.lpCash(), STAKER_CAP);
        vm.revertToState(snapshot);

        // --- The sweep lands first.
        uint256 owed = _owedAt(btc, P1);
        assertLt(owed, 42_000e6, "Bob's $100,000 is marked against Carol's $98,039 that will never be paid");
        assertGt(owed, _cushion(20_000_000e6), "leaving the cushion and $1,961");
        uint256 swept = _sweepBy(bob, P1, 0);
        assertEq(swept, 98_000e6 - owed);

        _liquidate(doomed, P1);
        _close(bobPk, long_, P1);
        assertEq(
            ex.openIdsOf(bob).length + ex.openIdsOf(carol).length,
            0,
            "every position closed at the sweep's price"
        );
        assertEq(ex.lpCash(), STAKER_CAP + owed + 9_800e6 - gain);
        assertLt(ex.lpCash(), STAKER_CAP - 30_000e6, "and the house is below its floor");
        _assertBooks();
        console2.log("finding 10: swept (USDC)", swept / 1e6);
        console2.log("finding 10: house below its floor by (USDC)", (STAKER_CAP - ex.lpCash()) / 1e6);
    }

    /// @dev What the cushion does cover: the same thing with Carol 49.5 bps under water (from
    ///      80,800 to 80,400) instead of 98. Before the cushion this swept $48,504 and left the
    ///      house $32,882 short. Now $8,504 is swept and the house ends $7,117 above its floor.
    function test_holds_sweeper_theCushionCoversAPositionAFewBpsPastEmpty() public {
        (bytes32 long_, bytes32 short_) = _pairAtTheFloor();
        _fund(carol, 10_000e6);
        bytes32 doomed = _open(carolPk, btc, true, 10_000e6, 1_000, _px(80_800));
        uint64 P1 = _px(80_400);
        assertLt(P1, 80_800e8 - 80_800e8 / 1_000, "past zero equity");

        _close(bobPk, short_, P1);
        uint256 owed = _owedAt(btc, P1);
        assertEq(_sweepBy(bob, P1, 0), 49_000e6 - owed);
        _liquidate(doomed, P1);
        _close(bobPk, long_, P1);
        assertGt(ex.lpCash(), STAKER_CAP + 7_000e6);
        _assertBooks();
    }

    // ======================================================================================
    // FINDING 11 (LOW). A direct close that has already been priced is still marked at the
    // price of the moment.
    // ======================================================================================

    /// @dev `requestClose` fixes the exit at the first print 24 s later, whatever happens after.
    ///      Until someone executes it the position is still in the aggregates, and the Sweeper
    ///      values it at the current price. Bob requests the close of his winning long at 80,400;
    ///      36 seconds later BTC is back at 80,000 and the execution has not landed. A sweep at
    ///      80,000 (fresh, accurate) holds back the 20 bps cushion and nothing else; the close
    ///      then executes at 80,400, as it must: house -$23,177 (-$43,177 before the cushion). A
    ///      prompt operator leaves a window of about a block; without one it is 60 seconds before
    ///      anybody else may execute.
    function test_finding_11_aCloseAlreadyPricedIsMarkedAtTheCurrentPrice() public {
        (bytes32 long_, bytes32 short_) = _pairAtTheFloor();
        uint64 P1 = _px(80_400);
        uint256 gain = _gain(P0, P1, 10_000_000e6, true);
        _close(bobPk, short_, P1);

        vm.prank(bob);
        ex.requestClose(long_);
        uint64 pinTime = uint64(vm.getBlockTimestamp()) + ex.DIRECT_DELAY();
        skip(36);

        assertEq(_owedAt(btc, P0), 20_000e6);
        assertEq(_sweepBy(bob, P0, 0), 29_000e6);

        bytes[] memory pin = _update(BTC_FEED, P1, pinTime);
        vm.prank(operator);
        ex.executeClose(long_, pin);
        assertEq(ex.lpCash(), STAKER_CAP + 20_000e6 - gain);
        assertLt(ex.lpCash(), STAKER_CAP - 23_000e6);
        _assertBooks();
        console2.log("finding 11: house below its floor by (USDC)", (STAKER_CAP - ex.lpCash()) / 1e6);
    }

    // ======================================================================================
    // HELD
    // ======================================================================================

    /// @dev The hedged attack of finding 1 with TWO pairs opened at different prices, so that
    ///      the attacker's own longs net against each other and so do his shorts, which is the
    ///      one thing a single pair could not try. BTC at 81,000; pair 1 from 82,000 (long loses
    ///      $121,951, short wins it), pair 2 from 80,000 (long wins $125,000, short loses it).
    ///      All 24 orders of closing the four legs, with a sweep attempted at the true price
    ///      before the first close and after every one. Whenever a sweep goes through, closing
    ///      whatever is still open at that price leaves the house at its floor or above; and when
    ///      everything is closed the house holds its floor to the dollar, having swept exactly
    ///      what the two pairs cost their owner, less fees. A book that hedges itself cannot free
    ///      its own losses: what it has realised is always less than what it is still up.
    function test_fixed_1_twoPairsClosedInAnyOrderNeverFreeTheirOwnLosses() public {
        _attachCoin();
        _seedHouse(STAKER_CAP);
        _fund(bob, 4_000_000e6);
        bytes32[4] memory legs;
        (legs[0], legs[1]) = _pair(bobPk, 1_000_000e6, 10, _px(82_000));
        (legs[2], legs[3]) = _pair(bobPk, 1_000_000e6, 10, P0);
        uint64 C = _px(81_000);
        _expectNoSweep(bob, C, 0);
        uint256 start = vm.snapshotState();
        uint256 orders;
        uint256 sweeps;

        for (uint256 a; a < 4; ++a) {
            for (uint256 b; b < 4; ++b) {
                for (uint256 c; c < 4; ++c) {
                    if (a == b || a == c || b == c) continue;
                    uint256[4] memory order = [a, b, c, 6 - a - b - c];
                    uint256 swept;
                    for (uint256 k; k < 4; ++k) {
                        _close(bobPk, legs[order[k]], C);
                        (bool ok, uint256 amount) = _trySweep(C);
                        if (!ok) continue;
                        ++sweeps;
                        swept += amount;
                        _assertFloorSurvivesClosingEveryone(C);
                    }
                    assertEq(ex.openIdsOf(bob).length, 0);
                    assertEq(ex.lpCash(), STAKER_CAP, "not at the floor after the last sweep");
                    assertEq(
                        swept + ex.stakerFees() + ex.devFees(),
                        4_000_000e6 - ex.balances(bob),
                        "swept is not the pairs' cost"
                    );
                    ++orders;
                    vm.revertToState(start);
                }
            }
        }
        assertEq(orders, 24);
        console2.log("two pairs, 24 closing orders: sweeps that went through", sweeps);
    }

    /// @dev The safe side of the same aggregate: a loser that is through its bust trigger but
    ///      short of zero equity is credited with its raw loss, which is LESS than the margin the
    ///      house takes when it is liquidated. Carol's 1000x long is 7.5 bps under water: marked
    ///      as a $7,455 loss, worth $9,800 to the house. Sweep, liquidate, close: above the floor.
    function test_holds_sweeper_aLoserShortOfZeroEquityIsMarkedOnTheSafeSide() public {
        (bytes32 long_, bytes32 short_) = _pairAtTheFloor();
        _seedHouse(100_000e6);
        _fund(carol, 10_000e6);
        bytes32 doomed = _open(carolPk, btc, true, 10_000e6, 1_000, _px(80_480));
        uint64 P1 = _px(80_420);
        assertLt(P1, _bustOf(doomed), "through its trigger");
        assertGt(P1, 80_480e8 - 80_480e8 / 1_000, "short of zero equity");

        _close(bobPk, short_, P1);
        uint256 excess = ex.lpExcess();
        uint256 owed = _owedAt(btc, P1);
        assertGt(
            owed - _cushion(20_000_000e6),
            52_500e6 - 9_800e6,
            "Carol's credit against Bob's $52,500 is less than her margin"
        );
        assertEq(_sweepBy(bob, P1, 0), excess - owed);
        _liquidate(doomed, P1);
        _close(bobPk, long_, P1);
        assertGt(ex.lpCash(), STAKER_CAP);
        _assertBooks();
    }

    /// @dev The Sweeper's promise, for any book that is priced right and has nobody past zero
    ///      equity: after a sweep, close every open position at the sweep's own price and the
    ///      house is still at or above its floor. Three traders, random longs and shorts at 2x to
    ///      20x, half of them as hedged pairs, random closes, a sweep attempted every round at the
    ///      price of that round. Also:
    ///      the Sweeper sweeps exactly when this test's own arithmetic says something is spare,
    ///      exactly that much, never more than `lpExcess()`.
    function test_holds_fuzz_afterAnySweepEveryoneCanStillBePaidAtThatPrice(uint256 seed) public {
        _sweepFuzz(seed);
    }

    /// @dev The fuzz test above is not vacuous: over 40 fixed seeds it sweeps dozens of times, and
    ///      opens hedged pairs as well as single positions.
    function test_holds_theSweepFuzzDoesSweep() public {
        uint256 sweeps;
        uint256 pairs;
        for (uint256 seed = 1; seed <= 40; ++seed) {
            uint256 snapshot = vm.snapshotState();
            (uint256 swept, uint256 paired) = _sweepFuzz(seed);
            sweeps += swept;
            pairs += paired;
            vm.revertToState(snapshot);
        }
        assertGt(sweeps, 30);
        assertGt(pairs, 40);
        console2.log("sweep fuzz, 40 seeds: sweeps that went through", sweeps, "hedged pairs opened", pairs);
    }

    function _sweepFuzz(uint256 seed) internal returns (uint256 sweeps, uint256 pairs) {
        _attachCoin();
        _seedHouse(STAKER_CAP + 60_000e6);
        uint256[3] memory pks = [alicePk, bobPk, carolPk];
        for (uint256 i; i < 3; ++i) {
            _fund(vm.addr(pks[i]), 5_000_000e6);
        }

        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint64 price = uint64(bound(seed >> 128, 78_400e8, 81_600e8));
            uint256 pk = pks[(seed >> 8) % 3];
            bytes32[] memory ids = ex.openIdsOf(vm.addr(pk));
            if (seed % 3 != 0 || ids.length == 0) {
                bool isLong = (seed >> 16) & 1 == 1;
                uint96 margin = uint96(bound(seed >> 24, 1_000e6, 200_000e6));
                uint16 leverage = uint16(bound(seed >> 96, 2, 20));
                _open(pk, btc, isLong, margin, leverage, price);
                // Half the time the same trader takes the other side as well: a hedged pair, whose
                // legs are then closed in whatever order the later rounds pick.
                if ((seed >> 20) & 1 == 1) {
                    _open(pk, btc, !isLong, margin, leverage, price);
                    ++pairs;
                }
            } else {
                _close(pk, ids[(seed >> 16) % ids.length], price);
            }

            uint256 excess = ex.lpExcess();
            uint256 owed = _owedAt(btc, price);
            (bool ok, uint256 amount) = _trySweep(price);
            assertEq(ok, excess > owed, "the sweeper and this test disagree on whether anything is spare");
            if (!ok) continue;
            ++sweeps;
            assertEq(amount, excess - owed);
            assertEq(ex.lpCash(), STAKER_CAP + owed, "what the open positions are up stayed behind");
            _assertFloorSurvivesClosingEveryone(price);
        }
    }

    /// @dev Every market that is not retired and has a position needs its own print, published
    ///      inside the last 60 seconds and not in the future, and Pyth's fee has to be paid. A
    ///      caller cannot leave an inconvenient market out. (It also means a market whose feed
    ///      goes quiet, a stock after hours say, stops every sweep until it prints again or is
    ///      retired. BTC and ETH do not go quiet.)
    function test_holds_sweeper_everyLiveMarketNeedsAPrintOfTheLastMinute() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 1_000e6);
        _fund(alice, 1_000e6);
        _open(alicePk, btc, true, 100e6, 10, P0);
        _open(alicePk, eth, false, 100e6, 10, ETH0);
        uint64 nowTime = uint64(vm.getBlockTimestamp());

        // The ETH market is left out.
        bytes[] memory updates = _update(BTC_FEED, P0, nowTime);
        vm.expectRevert(_noPrice());
        sweeper.sweep{value: _fee(1)}(updates);

        // No updates at all.
        vm.expectRevert(_noPrice());
        sweeper.sweep(new bytes[](0));

        // Present, but 61 seconds old.
        updates = new bytes[](2);
        updates[0] = _update(BTC_FEED, P0, nowTime)[0];
        updates[1] = _update(ETH_FEED, ETH0, nowTime - 31)[0];
        vm.expectRevert(_noPrice());
        sweeper.sweep{value: _fee(2)}(updates);

        // From the future.
        updates[1] = _update(ETH_FEED, ETH0, nowTime + 1)[0];
        vm.expectRevert(_noPrice());
        sweeper.sweep{value: _fee(2)}(updates);

        // Exactly 30 seconds old is the edge that is accepted, but with Pyth not without its fee.
        updates[1] = _update(ETH_FEED, ETH0, nowTime - 30)[0];
        if (!signed) {
            vm.expectRevert();
            sweeper.sweep{value: 1}(updates);
        }
        // Both positions are flat: what stays behind is the cushion, 20 bps of the $2,000 open.
        uint256 held = _owedAt(btc, P0) + _owedAt(eth, ETH0);
        assertEq(held, 4e6);
        assertEq(sweeper.sweep{value: _fee(2)}(updates), 1_000e6 - held);
        assertEq(ex.lpCash(), STAKER_CAP + held);
    }

    /// @dev A retired market is marked at its frozen price, which is where its positions will
    ///      settle. It needs no update and one that is supplied is not looked at.
    function test_holds_sweeper_aRetiredMarketIsMarkedAtItsFrozenPrice() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 10_000e6);
        _fund(carol, 10_000e6);
        bytes32 id = _open(carolPk, eth, true, 1_000e6, 10, ETH0);
        uint64 frozen = _px(2_750); // +10%: Carol's $10,000 long is up $1,000
        bytes[] memory update = _update(ETH_FEED, frozen, uint64(vm.getBlockTimestamp()));
        vm.prank(guardian);
        ex.retireMarket(eth, update);

        assertEq(_owedAt(eth, frozen), 1_000e6 + 20e6, "her gain, and the cushion on $10,000");
        bytes[] memory lies = _marks(P0, _px(2_000), 0);
        assertEq(
            sweeper.sweep{value: _fee(2)}(lies),
            8_980e6,
            "held back at 2,750, whatever the caller says ETH is"
        );
        assertEq(ex.lpCash(), STAKER_CAP + 1_020e6);

        (, uint256 gain) = _ethSettle(ETH0, frozen, 10_000e6, true);
        _close(carolPk, id, _px(2_000));
        assertEq(ex.lpCash(), STAKER_CAP + 1_020e6 - gain, "she is paid at the frozen price");
        assertEq(sweeper.sweep(new bytes[](0)), 1_020e6 - gain);
        assertEq(ex.lpCash(), STAKER_CAP);
        _assertBooks();
    }

    /// @dev With nothing open there is nothing to mark: no update is needed, all the excess goes,
    ///      every wei sent comes back, and a second call finds nothing. At or below the cap there
    ///      is nothing to sweep.
    function test_holds_sweeper_withNothingOpenItSweepsAllTheExcessAndReturnsTheEth() public {
        _attachCoin();
        _seedHouse(STAKER_CAP - 1);
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        sweeper.sweep(new bytes[](0));
        _seedHouse(1);
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        sweeper.sweep(new bytes[](0));
        _seedHouse(777e6);

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        assertEq(sweeper.sweep{value: 0.5 ether}(new bytes[](0)), 777e6);
        assertEq(stranger.balance, 1 ether);
        assertEq(address(sweeper).balance, 0);
        assertEq(ex.lpCash(), STAKER_CAP);
        assertEq(usdc.balanceOf(address(staking)), 777e6);
        assertEq(usdc.balanceOf(address(sweeper)), 0);

        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        sweeper.sweep(new bytes[](0));
        _assertBooks();
    }

    /// @dev The ETH refund. A caller that cannot take ETH must send the exact fee; one wei over
    ///      and its whole sweep is undone (nothing is lost). Forcing a wei into the Sweeper blocks
    ///      such a caller once per wei and nobody else: the next ordinary caller sweeps and is
    ///      handed the stray wei.
    function test_holds_sweeper_aCallerThatRejectsEthBlocksOnlyItself() public pythOnly {
        _attachCoin();
        _seedHouse(STAKER_CAP + 300e6);
        _fund(alice, 1_000e6);
        _open(alicePk, btc, true, 100e6, 10, P0); // one live market, so Pyth's fee is due
        NoEthCaller mute = new NoEthCaller();
        bytes[] memory updates = _marks(P0, ETH0, 0);
        uint256 snapshot = vm.snapshotState();

        assertEq(mute.sweep{value: 2}(sweeper, updates), 298e6); // less the cushion on the $1,000 open
        vm.revertToState(snapshot);

        vm.expectRevert(SweeperBase.RefundFailed.selector);
        mute.sweep{value: 3}(sweeper, updates);
        assertEq(ex.lpExcess(), 300e6);

        vm.deal(address(sweeper), 1);
        vm.expectRevert(SweeperBase.RefundFailed.selector);
        mute.sweep{value: 2}(sweeper, updates);

        vm.deal(stranger, 2);
        vm.prank(stranger);
        assertEq(sweeper.sweep{value: _fee(2)}(updates), 298e6);
        assertEq(stranger.balance, 1, "the stray wei went to the caller");
        assertEq(address(sweeper).balance, 0);
    }

    /// @dev Sweeping again from inside the refund finds nothing left.
    function test_holds_sweeper_reenteringFromTheRefundSweepsNothingMore() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 300e6);
        GreedyCaller greedy = new GreedyCaller(sweeper);
        assertEq(greedy.sweep{value: 1 ether}(), 300e6);
        assertEq(greedy.reentered(), 1);
        assertEq(greedy.sweptAgain(), 0);
        assertEq(address(greedy).balance, 1 ether);
        assertEq(usdc.balanceOf(address(staking)), 300e6);
        assertEq(ex.lpCash(), STAKER_CAP);
    }

    /// @dev `sweepExcess` is for the attached sweeper alone, and even it cannot take a unit more
    ///      than `lpExcess()`.
    function test_holds_sweeper_sweepExcessIsForTheSweeperAlone() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 1_000e6);
        address[5] memory others = [stranger, operator, admin, guardian, address(staking)];
        for (uint256 i; i < 5; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(Exchange.NotOperator.selector);
            ex.sweepExcess(1);
        }
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(Exchange.sweepExcess, (1));
        vm.prank(operator);
        assertFalse(batcher.multicall(calls)[0], "not through the Batcher either");

        vm.startPrank(address(sweeper));
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.sweepExcess(0);
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.sweepExcess(1_000e6 + 1);
        ex.sweepExcess(1_000e6);
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.sweepExcess(1);
        vm.stopPrank();
        assertEq(ex.lpCash(), STAKER_CAP);
        assertEq(usdc.balanceOf(address(staking)), 1_000e6);
        _assertBooks();
    }

    /// @dev Nothing is swept while a winner waits in the queue, even with cash above the cap (a
    ///      donation pays only the first four in line). Anyone can clear the queue with
    ///      `harvest`, after which what is left over is swept.
    function test_holds_sweeper_nothingIsSweptWhileAWinnerIsQueued() public {
        _attachCoin();
        for (uint256 i; i < 6; ++i) {
            (address user, uint256 pk) = makeAddrAndKey(string.concat("winner", vm.toString(i)));
            _fund(user, 1_000e6);
            bytes32 id = _open(pk, btc, true, 100e6, 100, P0);
            _close(pk, id, _px(80_800));
        }
        uint256 queued = ex.totalQueued();
        assertEq(ex.queueTail() - ex.queueHead(), 6);

        _seedHouse(STAKER_CAP + 1_000e6);
        assertEq(ex.queueTail() - ex.queueHead(), 2, "two winners still wait");
        assertGt(ex.lpCash(), STAKER_CAP, "with cash above the cap in the house");
        assertEq(ex.lpExcess(), 0);
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        sweeper.sweep(new bytes[](0));
        vm.prank(address(sweeper));
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.sweepExcess(1);

        vm.prank(stranger);
        ex.harvest(10);
        assertEq(ex.totalQueued(), 0);
        assertEq(sweeper.sweep(new bytes[](0)), 1_000e6 - queued);
        assertEq(ex.lpCash(), STAKER_CAP);
        _assertBooks();
    }

    /// @dev NOTE, by design: an open winner holds back the sweep dollar for dollar, and every open
    ///      position 20 bps of its size, so anyone can delay a sweep by holding a hedged pair,
    ///      which costs nothing to hold (no funding) and nothing to close once the price is back
    ///      at entry. A $10M pair holds back $40,000 at rest and $140,000 after a 1% move.
    ///      Stakers are paid later, not less; the fee share is not affected.
    function test_holds_sweeper_anOpenWinnerOnlyDelaysTheSweep() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 100_000e6);
        _fund(bob, 2_000_000e6);
        (bytes32 long_, bytes32 short_) = _pair(bobPk, 1_000_000e6, 10, P0);

        assertEq(_owedAt(btc, P0), 40_000e6, "at rest: the cushion on $20M");
        assertEq(_owedAt(btc, _px(80_800)), 100_000e6 + 40_000e6, "1% on $10M on top");
        _expectNoSweep(alice, _px(80_800), 0);
        _expectNoSweep(alice, _px(79_200), 0);

        _close(bobPk, long_, P0);
        _close(bobPk, short_, P0);
        assertEq(ex.balances(bob), 2_000_000e6, "the pair cost nothing");
        assertEq(_sweepBy(alice, P0, 0), 100_000e6);
    }
}

// ==============================================================================================
// THE STAKING STREAM
// ==============================================================================================

contract Review2StakingTest is Review2Base {
    // ======================================================================================
    // FINDING 12 (LOW). "How long a payment takes to reach stakers in full" is not 24 hours: it
    // is as long as anyone likes.
    // ======================================================================================

    /// @dev Every `notify` re-spreads what is left of the stream over a fresh 24 hours
    ///      (Staking.sol:150, 219-226), whatever the size of the new payment. Anyone can cause
    ///      one for a millionth of a dollar: a push whenever a unit of fee has accrued, or a
    ///      one-unit donation swept straight back out. Nothing is lost, it is paid later, and
    ///      the stakers who stay longest gain at the expense of those who leave. Measured on a
    ///      $86,400 payment: re-based once a minute, $54,626 (63%) has been paid after 24 hours
    ///      instead of all of it, and $74,715 (86%) after 48. The keeper's own five-minute push
    ///      does the same thing: a payment is an exponential decay, not a 24-hour stream.
    function test_finding_12_anyoneCanStretchAPaymentForAsLongAsTheyLike() public {
        _attachCoin();
        _seedHouse(STAKER_CAP);
        _stake(alice, 1_000_000e18);
        _notify(staking, 86_400e6); // a dollar a second
        uint256 finish = staking.periodFinish();
        uint256 snapshot = vm.snapshotState();

        // Left alone it is all Alice's a day later.
        skip(1 days);
        assertApproxEqAbs(staking.pendingReward(alice), 86_400e6, 1);
        vm.revertToState(snapshot);

        // Half way through, a stranger donates one unit of USDC and sweeps it back out.
        skip(12 hours);
        usdc.mint(stranger, 1);
        vm.startPrank(stranger);
        usdc.approve(address(ex), 1);
        ex.donate(1);
        vm.stopPrank();
        assertEq(_sweepBy(stranger, P0, 0), 1);
        assertEq(staking.periodFinish(), finish + 12 hours, "the half that was left takes 24 hours again");
        assertApproxEqAbs(staking.rewardRate(), 0.5e18 * 1e6, 1e15, "at half the pace");

        // The other way in: a push, once a single unit of fee has accrued.
        skip(1 hours);
        _fund(carol, 10e6);
        _bust(carolPk, 1e6);
        vm.prank(stranger);
        assertEq(ex.pushStakerFees(), 10_000, "one cent");
        assertEq(staking.periodFinish(), vm.getBlockTimestamp() + 1 days);

        // Measured: one re-base a minute.
        vm.revertToState(snapshot);
        for (uint256 i; i < 1_440; ++i) {
            skip(60);
            _notify(staking, 1);
        }
        uint256 afterOneDay = staking.pendingReward(alice);
        for (uint256 i; i < 1_440; ++i) {
            skip(60);
            _notify(staking, 1);
        }
        uint256 afterTwoDays = staking.pendingReward(alice);
        assertGt(afterOneDay, 86_400e6 * 62 / 100);
        assertLt(afterOneDay, 86_400e6 * 64 / 100);
        assertGt(afterTwoDays, 86_400e6 * 85 / 100);
        assertLt(afterTwoDays, 86_400e6 * 88 / 100);
        console2.log("finding 12: of $86,400, paid after 24 h (USDC)", afterOneDay / 1e6);
        console2.log("finding 12: paid after 48 h (USDC)", afterTwoDays / 1e6);
        console2.log("finding 12: still to stream (USDC)", staking.unstreamed() / 1e6);
    }

    // ======================================================================================
    // HELD
    // ======================================================================================

    /// @dev Just-in-time staking around a $1,000,000 payment with nine times the honest stake.
    ///      Inside one block (stake, payment, unstake): nothing. In the block of the payment and
    ///      out in the next, staked before it or after it: $125. An hour: an hour's worth. What
    ///      is left to a whale is to hold the coin for the day.
    function test_holds_stream_justInTimeStakesEarnOnlyTheirSeconds() public {
        _attachCoin();
        _stake(alice, 1_000_000e18);
        coin.transfer(bob, 9_000_000e18);
        vm.prank(bob);
        coin.approve(address(staking), type(uint256).max);
        _nextBlock();
        uint256 snapshot = vm.snapshotState();

        // The sandwich inside one block.
        vm.prank(bob);
        staking.stake(9_000_000e18);
        _notify(staking, 1_000_000e6);
        vm.prank(bob);
        staking.unstake(9_000_000e18);
        assertEq(staking.pendingReward(bob), 0);
        vm.prank(bob);
        vm.expectRevert(Staking.ZeroAmount.selector);
        staking.claim();
        skip(1 days);
        assertApproxEqAbs(staking.pendingReward(alice), 1_000_000e6, 2);
        vm.revertToState(snapshot);

        // In with the payment, out a block later. The order inside the block does not matter.
        uint256 oneBlock = (uint256(1_000_000e6) * 12 * 9) / (86_400 * 10);
        for (uint256 order; order < 2; ++order) {
            if (order == 0) {
                vm.prank(bob);
                staking.stake(9_000_000e18);
                _notify(staking, 1_000_000e6);
            } else {
                _notify(staking, 1_000_000e6);
                vm.prank(bob);
                staking.stake(9_000_000e18);
            }
            _nextBlock();
            vm.startPrank(bob);
            staking.unstake(9_000_000e18);
            assertApproxEqAbs(staking.claim(), oneBlock, 2, "$125");
            vm.stopPrank();
            vm.revertToState(snapshot);
        }

        // An hour, and the whole day.
        _notify(staking, 1_000_000e6);
        vm.prank(bob);
        staking.stake(9_000_000e18);
        skip(1 hours);
        assertApproxEqAbs(staking.pendingReward(bob), (uint256(1_000_000e6) * 9) / (24 * 10), 2, "$37,500");
        skip(23 hours);
        assertApproxEqAbs(staking.pendingReward(bob), 900_000e6, 2);
        assertApproxEqAbs(staking.pendingReward(alice), 100_000e6, 2);
    }

    /// @dev There is no "cannot unstake in the block you staked" rule any more, and no need for
    ///      one: a stake that leaves in its own block has earned nothing, whether it was new or
    ///      topped up an older dust stake.
    function test_holds_aStakeThatLeavesInItsOwnBlockEarnsNothing() public {
        _attachCoin();
        _stake(alice, 1_000e18);
        _stake(bob, 1); // dust planted in an earlier block
        _nextBlock();

        _notify(staking, 1_000e6);
        _stake(bob, 1_000_000e18);
        vm.startPrank(bob);
        staking.unstake(1_000_000e18);
        assertEq(staking.pendingReward(bob), 0);
        vm.expectRevert(Staking.ZeroAmount.selector);
        staking.claim();
        vm.stopPrank();
        assertEq(coin.balanceOf(bob), 1_000_000e18);
        vm.prank(carol);
        vm.expectRevert(Staking.InsufficientStake.selector);
        staking.unstake(1);

        // What the dust earns in a day is its share and no more: one part in 1e21 of $1,000.
        skip(1 days);
        assertEq(staking.pendingReward(bob), 0);
        assertApproxEqAbs(staking.pendingReward(alice), 1_000e6, 1);
    }

    /// @dev Leaving and coming back every block, whole and in odd pieces, and poking with dust,
    ///      earns no more than standing still and costs the other staker nothing: every rounding
    ///      goes against the one who touches.
    function test_holds_stream_churnStealsNoRounding() public {
        _attachCoin();
        _stake(alice, 1_000_000e18);
        coin.transfer(bob, 1_000_000e18 + 1_000);
        vm.prank(bob);
        coin.approve(address(staking), type(uint256).max);
        _notify(staking, 1_000e6);
        vm.prank(bob);
        staking.stake(1_000_000e18);
        uint256 snapshot = vm.snapshotState();

        for (uint256 i; i < 200; ++i) {
            _nextBlock();
        }
        uint256 stillBob = staking.pendingReward(bob);
        uint256 stillAlice = staking.pendingReward(alice);
        vm.revertToState(snapshot);

        vm.startPrank(bob);
        for (uint256 i; i < 200; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            skip(12);
            staking.unstake(1_000_000e18);
            staking.stake(333_333_333_333_333_333_333_333);
            staking.stake(1_000_000e18 - 333_333_333_333_333_333_333_333);
            staking.stake(1 + (i % 7));
            staking.unstake(1 + (i % 7));
        }
        vm.stopPrank();
        assertLe(staking.pendingReward(bob), stillBob, "churning paid");
        assertGe(staking.pendingReward(bob) + 1_000, stillBob, "it costs at most a unit a touch");
        assertApproxEqAbs(staking.pendingReward(alice), stillAlice, 1, "and nothing to anyone else");
        assertApproxEqAbs(stillBob + stillAlice, (uint256(1_000e6) * 2_400) / 86_400, 2);
    }

    /// @dev The last staker out stops the stream; what is left of it waits. Nothing accrues to
    ///      anyone while nobody is staked, a payment that arrives then joins the wait, and the
    ///      next staker in (one wei here) starts a fresh 24 hours: no backlog can be taken at
    ///      once, and leaving and returning only slows the leaver's own stream down. Every dollar
    ///      ends up paid.
    function test_holds_stream_theLastStakerLeavingAndReturning() public {
        _attachCoin();
        _stake(alice, 1_000e18);
        _notify(staking, 864e6); // a cent a second
        skip(6 hours);

        vm.prank(alice);
        staking.unstake(1_000e18);
        assertEq(staking.pendingReward(alice), 216e6, "a quarter of the day, a quarter of the money");
        assertEq(staking.waiting(), 648e6, "the rest waits");
        assertEq(staking.rewardRate(), 0);
        assertEq(staking.unstreamed(), 0);
        assertEq(staking.periodFinish(), vm.getBlockTimestamp());

        skip(10 days);
        assertEq(staking.pendingReward(alice), 216e6);
        _notify(staking, 100e6);
        assertEq(staking.waiting(), 748e6);

        _stake(bob, 1);
        assertEq(staking.waiting(), 0);
        assertApproxEqAbs(staking.unstreamed(), 748e6, 1);
        assertEq(staking.periodFinish(), vm.getBlockTimestamp() + 1 days);
        assertEq(staking.pendingReward(bob), 0);
        skip(12);
        uint256 bobAlone = staking.pendingReward(bob);
        assertApproxEqAbs(bobAlone, (uint256(748e6) * 12) / 86_400, 1, "ten cents");

        // Bob steps out and back in: the remainder starts over, a full day from now.
        vm.startPrank(bob);
        staking.unstake(1);
        assertApproxEqAbs(staking.waiting(), 748e6 - bobAlone, 2);
        coin.approve(address(staking), 1);
        staking.stake(1);
        vm.stopPrank();
        assertEq(staking.periodFinish(), vm.getBlockTimestamp() + 1 days);
        assertEq(staking.pendingReward(bob), bobAlone);

        vm.startPrank(alice);
        coin.approve(address(staking), 1_000e18);
        staking.stake(1_000e18);
        vm.stopPrank();
        skip(2 days);
        uint256 paid = staking.pendingReward(alice) + staking.pendingReward(bob);
        assertLe(paid, 964e6);
        assertGe(paid + 5, 964e6, "all of it, to within dust");
        assertEq(staking.unstreamed(), 0);
    }

    /// @dev Five hundred payments in a row, some in the same second, re-basing the stream each
    ///      time: what the re-basing drops is at most one unit of USDC (a millionth of a dollar)
    ///      per payment. It stays in the contract, promised to nobody.
    function test_holds_stream_manyNotifiesStrandOnlyDust() public {
        _attachCoin();
        _stake(alice, 1_000_000e18);
        uint256 total;
        for (uint256 i; i < 500; ++i) {
            uint256 amount = 1 + ((i * 7_919_000_003) % 1_000e6);
            _notify(staking, amount);
            total += amount;
            skip((i % 5) * 3);
        }
        skip(1 days);
        uint256 due = staking.pendingReward(alice);
        assertEq(staking.unstreamed(), 0);
        assertLe(due, total);
        assertLe(total - due, 501, "more than a unit a payment was dropped");
        assertEq(staking.totalReceived(), total);
        console2.log("500 payments re-based: stranded (USDC units, 1e-6 $)", total - due);
    }

    /// @dev Four stakers, forty random stakes (a million coin or a few wei), unstakes, claims,
    ///      payments and jumps in time of a second to two days. After every step:
    ///        - Staking holds exactly what it received less what it paid out;
    ///        - everything claimable, plus everything claimed, is no more than was received;
    ///        - what it holds covers everything claimable, waiting and still to stream;
    ///        - what it holds beyond that (promised to nobody) is dust;
    ///        - nobody's claimable amount went down unless they claimed, and a claim pays it all;
    ///        - the rate, the end of the stream and the waiting amount are what a second,
    ///          straight-line model says, and each staker has earned, to within dust, their share
    ///          of every second they were staked in that model.
    ///      At the end everyone leaves with their coin and what is left is waiting or dust.
    uint256 internal constant OPS = 40;
    uint256 internal mRate;
    uint256 internal mFinish;
    uint256 internal mWaiting;
    uint256 internal mTotal;
    uint256[4] internal mStaked;
    /// @dev 1e18-scaled USDC.
    uint256[4] internal mEarned;
    uint256[4] internal mClaimed;

    function test_holds_fuzz_stakingNeverOwesMoreThanItHolds(uint256 seed) public {
        _streamFuzz(seed);
    }

    /// @dev The fuzz test above is not vacuous: over 40 fixed seeds there are dozens of claims and
    ///      hundreds of payments, the contract is emptied of stakers with a stream running, and
    ///      payments arrive while nobody is staked.
    function test_holds_theStreamFuzzReachesEveryBranch() public {
        uint256[4] memory total;
        for (uint256 seed = 1; seed <= 40; ++seed) {
            uint256 snapshot = vm.snapshotState();
            uint256[4] memory seen = _streamFuzz(seed);
            for (uint256 i; i < 4; ++i) {
                total[i] += seen[i];
            }
            vm.revertToState(snapshot);
        }
        assertGt(total[0], 50, "claims");
        assertGt(total[1], 4, "last staker out with a stream running");
        assertGt(total[2], 10, "payments with nobody staked");
        assertGt(total[3], 100, "payments re-basing a running stream");
        console2.log("stream fuzz, 40 seeds: claims", total[0], "last staker out mid-stream", total[1]);
        console2.log(
            "stream fuzz, 40 seeds: payments with nobody staked", total[2], "re-basing payments", total[3]
        );
    }

    /// @return seen [claims, times the last staker left with a stream running, payments with
    ///         nobody staked, payments that re-based a running stream]
    function _streamFuzz(uint256 seed) internal returns (uint256[4] memory seen) {
        _attachCoin();
        address[4] memory who = [alice, bob, carol, stranger];
        for (uint256 i; i < 4; ++i) {
            coin.transfer(who[i], 100_000_000e18);
            vm.prank(who[i]);
            coin.approve(address(staking), type(uint256).max);
        }
        uint256[4] memory was;

        for (uint256 i; i < OPS; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 u = seed % 4;
            uint256 op = (seed >> 8) % 9;
            uint256 r = seed >> 16;
            uint256 claimer = type(uint256).max;

            if (op <= 1) {
                uint256 amount = op == 0 ? bound(r, 1, 1_000_000e18) : bound(r, 1, 1_000);
                vm.prank(who[u]);
                staking.stake(amount);
                _mStake(u, amount);
            } else if (op <= 3) {
                uint256 has = staking.staked(who[u]);
                if (has != 0) {
                    uint256 amount = op == 2 ? bound(r, 1, has) : has;
                    if (amount == staking.totalStaked() && staking.unstreamed() != 0) ++seen[1];
                    vm.prank(who[u]);
                    staking.unstake(amount);
                    _mUnstake(u, amount);
                }
            } else if (op == 4) {
                uint256 due = staking.pendingReward(who[u]);
                if (due != 0) {
                    vm.prank(who[u]);
                    assertEq(staking.claim(), due, "a claim pays what was shown");
                    mClaimed[u] += due;
                    claimer = u;
                    ++seen[0];
                }
            } else if (op <= 6) {
                uint256 amount = bound(r, 1, 1_000_000e6);
                if (staking.totalStaked() == 0) ++seen[2];
                else if (staking.unstreamed() != 0) ++seen[3];
                _notify(staking, amount);
                _mNotify(amount);
            } else {
                _mSkip(op == 7 ? bound(r, 1, 3 hours) : bound(r, 1, 2 days));
            }

            _checkStream(who, was, claimer);
        }

        skip(2 days);
        for (uint256 j; j < 4; ++j) {
            uint256 has = staking.staked(who[j]);
            vm.startPrank(who[j]);
            if (has != 0) staking.unstake(has);
            if (staking.pendingReward(who[j]) != 0) staking.claim();
            vm.stopPrank();
            assertEq(coin.balanceOf(who[j]), 100_000_000e18);
        }
        assertEq(staking.totalStaked(), 0);
        assertLe(usdc.balanceOf(address(staking)) - staking.waiting(), 3 * OPS, "left behind and not waiting");
    }

    function _checkStream(address[4] memory who, uint256[4] memory was, uint256 claimer) internal view {
        uint256 pending;
        for (uint256 j; j < 4; ++j) {
            uint256 p = staking.pendingReward(who[j]);
            if (j == claimer) assertEq(p, 0, "a claim left something behind");
            else assertGe(p, was[j], "claimable went down without a claim");
            was[j] = p;
            pending += p;
            assertApproxEqAbs(
                p + mClaimed[j], mEarned[j] / 1e18, OPS + 2, "not the share of each second staked"
            );
        }
        uint256 held = usdc.balanceOf(address(staking));
        assertEq(
            held, staking.totalReceived() - staking.totalClaimed(), "holds what it received less what it paid"
        );
        assertLe(pending + staking.totalClaimed(), staking.totalReceived(), "promised more than it received");
        uint256 accounted = pending + staking.waiting() + staking.unstreamed();
        assertLe(accounted, held, "claimable + waiting + still to stream exceed the USDC held");
        assertLe(held - accounted, 3 * OPS, "USDC that is nobody's is more than dust");
        assertEq(coin.balanceOf(address(staking)), staking.totalStaked());

        assertEq(staking.rewardRate(), mRate, "rate");
        assertEq(staking.periodFinish(), mFinish, "end of the stream");
        assertEq(staking.waiting(), mWaiting, "waiting");
    }

    function _mLeft() internal view returns (uint256) {
        uint256 nowTime = vm.getBlockTimestamp();
        return nowTime < mFinish ? ((mFinish - nowTime) * mRate) / 1e18 : 0;
    }

    function _mStart(uint256 amount) internal {
        mRate = (amount * 1e18) / 1 days;
        mFinish = vm.getBlockTimestamp() + 1 days;
    }

    function _mStake(uint256 u, uint256 amount) internal {
        bool first = mTotal == 0;
        mStaked[u] += amount;
        mTotal += amount;
        if (first && mWaiting != 0) {
            uint256 waiting = mWaiting;
            mWaiting = 0;
            _mStart(waiting);
        }
    }

    function _mUnstake(uint256 u, uint256 amount) internal {
        mStaked[u] -= amount;
        mTotal -= amount;
        if (mTotal == 0) {
            mWaiting += _mLeft();
            mRate = 0;
            mFinish = vm.getBlockTimestamp();
        }
    }

    function _mNotify(uint256 amount) internal {
        if (mTotal == 0) mWaiting += amount;
        else _mStart(amount + _mLeft());
    }

    function _mSkip(uint256 dt) internal {
        uint256 from = vm.getBlockTimestamp();
        skip(dt);
        uint256 to = from + dt;
        if (to > mFinish) to = mFinish;
        if (mTotal == 0 || to <= from) return;
        uint256 streamed = (to - from) * mRate;
        for (uint256 j; j < 4; ++j) {
            mEarned[j] += (streamed * mStaked[j]) / mTotal;
        }
    }

    /// @dev 6-decimal USDC against an 18-decimal coin at both ends of the scale. One wei staked
    ///      against $5,000,000: paid, less one unit. A quadrillion coins (1e33 wei) against one
    ///      dollar: paid, less one unit. Nothing overflows. Only when the stake is so large that
    ///      a whole payment rounds to nothing per coin (`totalStaked > amount * 1e36`: 1e27 whole
    ///      coins for $1) is the payment stranded: a boundary, not a risk, for any real supply.
    function test_holds_extremeTotalsStrandOnlyDust() public {
        Coin big = new Coin("Big", "BIG", 1e45, address(this));
        Staking s = new Staking(IERC20(address(big)), IERC20(address(usdc)), address(ex));

        big.transfer(alice, 1);
        vm.startPrank(alice);
        big.approve(address(s), type(uint256).max);
        s.stake(1);
        vm.stopPrank();
        _notify(s, 5_000_000e6);
        skip(1 days);
        assertEq(s.pendingReward(alice), 5_000_000e6 - 1, "one unit of dust");

        big.transfer(bob, 1e33);
        vm.startPrank(bob);
        big.approve(address(s), type(uint256).max);
        s.stake(1e33);
        vm.stopPrank();
        _notify(s, 1e6);
        skip(1 days);
        assertEq(s.pendingReward(bob), 1e6 - 1, "one unit of dust");
        assertEq(s.pendingReward(alice), 5_000_000e6 - 1, "one wei's share of the dollar is nothing");
        vm.prank(alice);
        s.claim();
        vm.prank(bob);
        s.claim();
        assertEq(usdc.balanceOf(address(s)), 2);

        // The boundary: 1e45 wei staked, $1 paid, and the accumulator does not move.
        big.transfer(carol, 9e44);
        vm.startPrank(carol);
        big.approve(address(s), type(uint256).max);
        s.stake(9e44);
        vm.stopPrank();
        uint256 acc = s.rewardPerShare();
        _notify(s, 1e6);
        skip(1 days);
        vm.prank(carol);
        s.unstake(1); // brings the accounting up to date
        assertEq(s.rewardPerShare(), acc);
        assertEq(s.unstreamed(), 0);
        assertEq(s.pendingReward(carol), 0, "that dollar is stranded");
    }

    /// @dev A coin that burns 1% per transfer: stakers are credited what arrived, are paid pro
    ///      rata on that, and the last one out is still paid in full. A stake of which nothing
    ///      arrives is a stake of nothing and cannot set waiting USDC flowing.
    function test_holds_aTaxedCoinIsCreditedWhatArrives() public {
        FeeCoin fee = new FeeCoin();
        Staking s = new Staking(IERC20(address(fee)), IERC20(address(usdc)), address(ex));
        fee.transfer(alice, 1_000e18); // 990 arrive
        fee.transfer(bob, 2_000e18); // 1,980 arrive
        vm.startPrank(alice);
        fee.approve(address(s), type(uint256).max);
        s.stake(990e18);
        vm.stopPrank();
        vm.startPrank(bob);
        fee.approve(address(s), type(uint256).max);
        s.stake(1_980e18);
        vm.stopPrank();

        assertEq(s.staked(alice), 980.1e18);
        assertEq(s.totalStaked(), fee.balanceOf(address(s)));

        _notify(s, 300e6);
        skip(1 days);
        assertApproxEqAbs(s.pendingReward(alice), 100e6, 1);
        assertApproxEqAbs(s.pendingReward(bob), 200e6, 1);

        vm.prank(alice);
        s.unstake(980.1e18);
        vm.prank(bob);
        s.unstake(1_960.2e18);
        assertEq(fee.balanceOf(address(s)), 0);
        assertEq(s.totalStaked(), 0);

        _notify(s, 50e6); // nobody is staked: it waits
        fee.setFee(10_000);
        vm.prank(alice);
        s.stake(5e18);
        assertEq(s.staked(alice), 0);
        assertEq(s.totalStaked(), 0);
        assertEq(s.waiting(), 50e6);
        assertEq(s.rewardRate(), 0);
        fee.setFee(100);
        vm.prank(alice);
        s.stake(5e18);
        assertEq(s.staked(alice), 4.95e18);
        assertEq(s.waiting(), 0);
        assertApproxEqAbs(s.unstreamed(), 50e6, 1);
    }

    /// @dev An ERC-777-style coin calls the staker back in the middle of stake and unstake. Every
    ///      way back into Staking is refused. The one entry Staking does not guard is `notify`,
    ///      which only the Exchange can call: the staker has the Exchange push fees from inside
    ///      the hook, so a payment lands while the new coin is in mid-air. It streams from that
    ///      second to the stakes as they then stand, and the staker gets its share and no more.
    function test_holds_aCoinWithTransferHooksCannotReenterStaking() public {
        HookCoin hook = new HookCoin();
        (Staking s,) = _attachWith(address(hook));
        ReentrantStaker mallory = new ReentrantStaker(s, hook, ex);
        hook.transfer(address(mallory), 1_000e18);
        hook.transfer(alice, 1_000e18);
        vm.startPrank(alice);
        hook.approve(address(s), type(uint256).max);
        s.stake(1_000e18);
        vm.stopPrank();

        mallory.stake(500e18);
        _notify(s, 300e6);
        skip(1 days); // $200 to Alice, $100 to Mallory

        _fund(carol, 1_000e6);
        _bust(carolPk, 100e6);
        assertEq(ex.stakerFees(), 1e6);

        mallory.arm(true);
        mallory.stake(500e18); // the hook fires before the coin moves
        assertEq(mallory.attempts(), 3);
        assertEq(mallory.blocked(), 3, "every re-entry hit the guard");
        assertEq(mallory.pushed(), 1e6, "the push went through, mid-stake");
        assertEq(s.staked(address(mallory)), 1_000e18);
        assertEq(s.totalStaked(), 2_000e18);
        assertEq(hook.balanceOf(address(s)), 2_000e18);

        skip(1 days);
        mallory.unstake(1_000e18); // and after the coin has moved, on the way out
        assertEq(mallory.attempts(), 6);
        assertEq(mallory.blocked(), 6);
        assertEq(hook.balanceOf(address(mallory)), 1_000e18);
        assertEq(s.totalStaked(), 1_000e18);
        assertApproxEqAbs(s.pendingReward(address(mallory)), 100.5e6, 2, "a third of $300 and half of $1");
        assertApproxEqAbs(s.pendingReward(alice), 200.5e6, 2);

        mallory.arm(false);
        uint256 got = mallory.claim();
        assertApproxEqAbs(got, 100.5e6, 2);
        assertEq(ex.balances(address(mallory)), got);
        _assertBooks();
    }

    /// @dev Nothing a stranger does stops a staker unstaking or claiming, in the same block: not
    ///      dust sent to them, not coin or USDC sent to Staking, not a push, not somebody else's
    ///      stake. Coin and USDC sent straight to Staking are simply stranded there.
    function test_holds_nobodyCanFreezeAnotherStaker() public {
        _attachCoin();
        _stake(alice, 1_000e18);
        _fund(carol, 1_000e6);
        _bust(carolPk, 100e6);
        ex.pushStakerFees();
        skip(1 days);

        coin.transfer(alice, 1);
        coin.transfer(address(staking), 5e18);
        usdc.mint(address(staking), 5e6);
        _stake(bob, 1);
        _bust(carolPk, 100e6);
        vm.prank(bob);
        ex.pushStakerFees();

        vm.startPrank(alice);
        staking.unstake(1_000e18);
        uint256 got = staking.claim();
        vm.stopPrank();
        assertApproxEqAbs(got, 1e6, 1);
        assertEq(coin.balanceOf(alice), 1_000e18 + 1);
        assertEq(coin.balanceOf(address(staking)), 5e18 + 1);
        assertEq(usdc.balanceOf(address(staking)), 5e6 + 2e6 - got);
        skip(1 days);
        assertApproxEqAbs(
            staking.pendingReward(bob), 1e6, 1, "the second dollar streams to who is staked; the $5 to nobody"
        );
    }

    /// @dev `stakeWithPermit` swallows a failed permit. That cannot be turned on anyone: the
    ///      permit's owner and the transfer's source are both the caller.
    function test_holds_aPermitOnlyEverStakesTheCallersOwnCoin() public {
        _attachCoin();
        coin.transfer(bob, 70e18);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                bob,
                address(staking),
                70e18,
                coin.nonces(bob),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(bobPk, keccak256(abi.encodePacked("\x19\x01", coin.DOMAIN_SEPARATOR(), structHash)));

        // Someone else replays Bob's signature: nothing of Bob's moves.
        coin.transfer(carol, 70e18);
        vm.prank(carol);
        vm.expectRevert();
        staking.stakeWithPermit(70e18, deadline, v, r, s);
        assertEq(coin.balanceOf(bob), 70e18);
        assertEq(coin.allowance(bob, address(staking)), 0);

        // The permit is front-run straight to the coin. Bob's own call still stakes, and the
        // standing allowance is of no use to anyone else.
        vm.prank(carol);
        coin.permit(bob, address(staking), 70e18, deadline, v, r, s);
        vm.prank(carol);
        vm.expectRevert();
        staking.stakeWithPermit(70e18, deadline, v, r, s);
        vm.prank(bob);
        staking.stakeWithPermit(70e18, deadline, v, r, s);
        assertEq(staking.staked(bob), 70e18);
        assertEq(staking.staked(carol), 0);
    }

    /// @dev `claim` credits a trading balance only by having the Exchange PULL the USDC. A
    ///      Staking that thinks it has more than it holds cannot credit anyone.
    function test_holds_aClaimCreditsOnlyUsdcThatArrives() public {
        _attachCoin();
        _stake(alice, 1_000e18);
        _notify(staking, 300e6);
        skip(1 days);

        uint256 held = usdc.balanceOf(address(ex));
        uint256 treasury = ex.treasury();
        vm.prank(alice);
        uint256 got = staking.claim();
        assertApproxEqAbs(got, 300e6, 1);
        assertEq(usdc.balanceOf(address(ex)), held + got);
        assertEq(ex.treasury(), treasury + got);
        assertEq(ex.balances(alice), got);
        assertEq(usdc.allowance(address(staking), address(ex)), 0);
        assertEq(staking.totalClaimed(), got);

        // Nobody is credited without paying.
        vm.prank(stranger);
        vm.expectRevert();
        ex.depositFor(stranger, 1e6);

        // A notify with no USDC behind it (only the Exchange could send one) cannot be claimed.
        vm.prank(address(ex));
        staking.notify(100e6);
        skip(1 days);
        assertApproxEqAbs(staking.pendingReward(alice), 100e6, 1);
        vm.prank(alice);
        vm.expectRevert();
        staking.claim();
        assertEq(ex.balances(alice), got);
        _assertBooks();
    }
}

// ==============================================================================================
// THE EXCHANGE: FEES, ATTACHING, THE BATCHER, THE HOOK, THE SIZE BOOKKEEPING
// ==============================================================================================

contract Review2ExchangeTest is Review2Base {
    // ======================================================================================
    // HELD: attachCoin
    // ======================================================================================

    /// @dev The third argument. When this pass started `attachCoin` did not look at it: zero or a
    ///      Sweeper built for another Exchange was accepted (nothing above the cap could then ever
    ///      be paid to stakers), and so was a plain key (which could then call `sweepExcess` with
    ///      no mark at all: finding 1 as it was). The Exchange was changed while this file was
    ///      being written and now asks the sweeper `sweeperFor()` (Exchange.sol:777-781). All
    ///      three are refused, and nothing is attached by the attempt.
    function test_holds_attachCoin_theSweeperMustBeBuiltForThisExchangeToo() public {
        coin = new Coin("Tape", "TAPE", SUPPLY, address(this));
        staking = new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(ex));
        mining = new LossMining(IERC20(address(coin)), address(ex), MINING_SCALE, address(0));
        sweeper = _newSweeper(ex);
        Exchange other = new Exchange(
            "OTHER", IERC20(address(usdc)), oracle, pricing, sessions, admin, dev, STAKER_CAP, MIN_MARGIN
        );
        Sweeper wrong = _newSweeper(other);
        address hotKey = makeAddr("some key");

        vm.startPrank(admin);
        vm.expectRevert();
        ex.attachCoin(address(staking), address(mining), address(0));
        vm.expectRevert();
        ex.attachCoin(address(staking), address(mining), hotKey);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(staking), address(mining), address(wrong));
        assertEq(ex.staking(), address(0));
        assertEq(ex.sweeper(), address(0));
        ex.attachCoin(address(staking), address(mining), address(sweeper));
        vm.stopPrank();

        // And the one that is attached is the only address `sweepExcess` listens to.
        _seedHouse(STAKER_CAP + 1_000_000e6);
        vm.mockCall(address(other), abi.encodeWithSelector(other.isOperator.selector), abi.encode(true));
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        wrong.sweep(new bytes[](0)); // it looks at the other Exchange
        vm.prank(hotKey);
        vm.expectRevert(Exchange.NotOperator.selector);
        ex.sweepExcess(1);
        assertEq(sweeper.sweep(new bytes[](0)), 1_000_000e6);
    }

    /// @dev `attachCoin`: the owner only, once, and only with a Staking and a LossMining that
    ///      name this Exchange. An address without code in either slot (a key, zero) reverts.
    ///      (Wrong order and wrong Exchange: the two tests of finding 5.)
    function test_holds_attachCoinOnceByTheOwnerWithContracts() public {
        coin = new Coin("Tape", "TAPE", SUPPLY, address(this));
        staking = new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(ex));
        mining = new LossMining(IERC20(address(coin)), address(ex), MINING_SCALE, address(0));
        sweeper = _newSweeper(ex);
        Staking theirs = new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(0xdead));

        address[4] memory notOwner = [address(this), operator, guardian, stranger];
        for (uint256 i; i < 4; ++i) {
            vm.prank(notOwner[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, notOwner[i]));
            ex.attachCoin(address(staking), address(mining), address(sweeper));
        }

        vm.startPrank(admin);
        vm.expectRevert();
        ex.attachCoin(alice, address(mining), address(sweeper));
        vm.expectRevert();
        ex.attachCoin(address(staking), alice, address(sweeper));
        vm.expectRevert();
        ex.attachCoin(address(0), address(0), address(0));
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(theirs), address(mining), address(sweeper));
        vm.expectRevert();
        ex.attachCoin(address(staking), address(mining), alice);
        ex.attachCoin(address(staking), address(mining), address(sweeper));
        vm.expectRevert(Exchange.AlreadyAttached.selector);
        ex.attachCoin(address(staking), address(mining), address(sweeper));
        vm.stopPrank();
        assertEq(ex.staking(), address(staking));
        assertEq(ex.lossMining(), address(mining));
        assertEq(ex.sweeper(), address(sweeper));
    }

    // ======================================================================================
    // HELD: the fee plumbing
    // ======================================================================================

    /// @dev A push moves accrued fees and nothing else, a sweep moves cash above the cap and
    ///      nothing else: with a winner queued, with queue-funded margin open, and exactly at the
    ///      cap.
    function test_holds_aPushNeverMovesBalancesMarginOrQueuedMoney() public {
        _attachCoin();
        _fund(alice, 10_000e6);
        _fund(bob, 1_000e6);
        _fund(carol, 1_000e6);
        bytes32 resting = _open(carolPk, eth, false, 500e6, 20, ETH0); // margin locked throughout

        _bust(alicePk, 100e6); // $1 of staker fees; the house has $98
        bytes32 won = _open(bobPk, btc, true, 200e6, 100, P0);
        _close(bobPk, won, _px(80_800)); // owed ~$173: $98 paid, the rest queued
        uint256 queued = ex.totalQueued();
        assertGt(queued, 70e6);

        // 1. With a queue: only the fee accrued earlier. No excess, whatever the house holds.
        assertEq(ex.lpExcess(), 0);
        uint256 balances = ex.totalBalances();
        vm.prank(stranger);
        assertEq(ex.pushStakerFees(), 1e6);
        assertEq(ex.totalQueued(), queued);
        assertEq(ex.totalBalances(), balances);
        assertEq(ex.totalCashMargin(), 500e6);
        _assertBooks();
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.pushStakerFees();
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        _sweep(P0, ETH0);

        // 2. Bob spends the claim as margin. The queue reads empty, the debt is still counted.
        bytes32 parked = _openQueued(bobPk, btc, true, uint96(queued), 1, P0);
        assertEq(ex.totalQueued(), 0);
        _seedHouse(STAKER_CAP + queued + 500e6);
        assertEq(ex.lpExcess(), 500e6, "net of the parked claim");
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.pushStakerFees(); // the push no longer carries the excess
        // Both open positions are flat; the sweep keeps its cushion on them (20 bps of the
        // $10,000 short and of the parked claim) and sends the rest.
        uint256 held = _owedAt(btc, P0) + _owedAt(eth, ETH0);
        assertEq(held, _cushion(queued) + 20e6);
        assertEq(_sweep(P0, ETH0), 500e6 - held);
        assertEq(ex.lpCash(), STAKER_CAP + queued + held);
        assertEq(ex.totalBalances(), balances);
        _assertBooks();

        // 3. With only what the sweep itself held back above the cap there is nothing to sweep,
        //    and Bob's claim is paid in full.
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        _sweep(P0, ETH0);
        uint256 before = ex.balances(bob);
        _close(bobPk, parked, P0);
        assertEq(ex.balances(bob), before + queued);
        assertEq(ex.lpCash(), STAKER_CAP + held);

        _close(carolPk, resting, ETH0);
        assertEq(ex.balances(carol), 1_000e6);
        assertEq(_sweep(P0, ETH0), held, "with nothing open the cushion is released");
        assertEq(ex.lpCash(), STAKER_CAP);
        assertEq(ex.lpExcess(), 0);
        assertEq(usdc.balanceOf(address(staking)), 501e6);
        _assertBooks();
    }

    /// @dev Every fee is counted once, leaves the treasury once, and is never house cash. (There
    ///      is no flat per-position fee any more: the two fees are the 2% on a win's gain and the
    ///      2% carved from a loss.)
    function test_holds_everyFeeIsCountedOnce() public {
        _attachCoin();
        _seedHouse(10_000e6);
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);

        (bool exists,) = address(ex).call(abi.encodeWithSignature("setExecFee(uint64)", uint64(2e6)));
        assertFalse(exists, "the flat fee is gone");

        _bust(alicePk, 100e6); // loss fee $2, split
        bytes32 won = _open(bobPk, btc, true, 100e6, 100, P0);
        _close(bobPk, won, _px(80_800)); // win fee, split
        uint256 gain = _gain(P0, _px(80_800), 10_000e6, true);
        uint256 winFee = (gain * 200) / 10_000;

        assertEq(ex.stakerFees(), 1e6 + winFee / 2);
        assertEq(ex.devFees(), 1e6 + (winFee - winFee / 2));
        uint256 house = ex.lpCash();
        assertEq(house, 10_000e6 + 98e6 - gain);

        uint256 treasury = ex.treasury();
        uint256 pushed = ex.pushStakerFees();
        uint256 devPaid = ex.claimDevFees();
        assertEq(pushed, 1e6 + winFee / 2);
        assertEq(ex.treasury(), treasury - pushed - devPaid);
        assertEq(ex.lpCash(), house, "paying fees out does not touch house cash");
        assertEq(usdc.balanceOf(dev), devPaid);
        assertEq(usdc.balanceOf(address(staking)), pushed);
        // Everything that came in is somewhere.
        assertEq(
            2_000e6 + 10_000e6, ex.totalBalances() + ex.totalCashMargin() + ex.lpCash() + pushed + devPaid
        );
        _assertBooks();
    }

    /// @dev Fee precedence, to the unit. Bob has parked a queued win as margin, so the house owes
    ///      him that much and nobody is queued. (a) Alice then loses $80: the 2% fee on it is
    ///      taken if, and only if, the house's cash after her loss covers Bob's parked claim and
    ///      the fee. One unit of USDC short and no fee is taken at all. (b) Carol then wins: the
    ///      fee on her win is taken if, and only if, the cash covers her payout, the fee and
    ///      Bob's parked claim; one unit short and she is still paid in full, the fee is not.
    function test_holds_feePrecedence_theBoundaryIsExactToTheUnit() public {
        _attachCoin();
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        _fund(carol, 1_000e6);
        bytes32 won = _open(bobPk, btc, true, 100e6, 100, P0);
        _close(bobPk, won, _px(80_800));
        uint256 parkedClaim = ex.queuedOf(bob);
        _openQueued(bobPk, btc, true, uint96(parkedClaim), 1, P0);
        assertEq(ex.debtMarginOpen(), parkedClaim);
        assertEq(ex.lpCash(), 0);
        uint256 start = vm.snapshotState();

        // (a) A loss.
        for (uint256 pass; pass < 2; ++pass) {
            // After Alice's $80 the house has `parkedClaim + $1.60`, less one unit on the first pass.
            _seedHouse(parkedClaim + 1.6e6 - 80e6 - (pass == 0 ? 1 : 0));
            _bust(alicePk, 80e6);
            assertEq(ex.stakerFees() + ex.devFees(), pass == 0 ? 0 : 1.6e6);
            assertGe(ex.lpCash(), ex.debtMarginOpen(), "Bob's parked claim is covered either way");
            vm.revertToState(start);
        }

        // (b) A win.
        bytes32 hers = _open(carolPk, btc, true, 100e6, 10, P0);
        uint256 gain = _gain(P0, _px(80_800), 1_000e6, true);
        uint256 fee = (gain * 200) / 10_000;
        uint256 open = vm.snapshotState();
        for (uint256 pass; pass < 2; ++pass) {
            _seedHouse(gain + parkedClaim - (pass == 0 ? 1 : 0));
            _close(carolPk, hers, _px(80_800));
            assertEq(ex.balances(carol), 1_000e6 + gain - fee, "paid in full, now, both times");
            assertEq(ex.totalQueued(), 0);
            assertEq(ex.stakerFees() + ex.devFees(), pass == 0 ? 0 : fee);
            assertGe(ex.lpCash(), ex.debtMarginOpen());
            vm.revertToState(open);
        }
    }

    /// @dev Fee precedence under random trading with queue-funded margin. Three traders against a
    ///      house that starts empty and is given a little now and then; every open spends whatever
    ///      its owner has queued first; 5x to 40x, so the house is regularly empty and winners queue
    ///      and re-stake their claims.
    ///      Whenever a settlement accrued a fee, afterwards nobody is queued and the house's cash
    ///      still covers every dollar of queue-funded margin left open.
    function test_holds_fuzz_feesAreNeverTakenAheadOfQueueFundedMargin(uint256 seed) public {
        _feeFuzz(seed);
    }

    /// @dev The fuzz test above is not vacuous: over 40 fixed seeds fees are taken hundreds of
    ///      times, some of them with queue-funded margin open at that moment, and there are dozens
    ///      of rounds that end with a winner queued or with queue-funded margin open. (The exact
    ///      edge between "fee taken" and "fee not taken" is the test above this one.)
    function test_holds_theFeeFuzzReachesQueueFundedMargin() public {
        uint256[4] memory total;
        for (uint256 seed = 1; seed <= 40; ++seed) {
            uint256 snapshot = vm.snapshotState();
            uint256[4] memory seen = _feeFuzz(seed);
            for (uint256 i; i < 4; ++i) {
                total[i] += seen[i];
            }
            vm.revertToState(snapshot);
        }
        assertGt(total[0], 100, "fees taken");
        assertGt(total[1], 10, "fees taken with queue-funded margin open");
        assertGt(total[2], 20, "rounds with a winner queued");
        assertGt(total[3], 50, "rounds with queue-funded margin open");
        console2.log(
            "fee fuzz, 40 seeds: fees taken", total[0], "of them with queue-funded margin open", total[1]
        );
        console2.log(
            "fee fuzz, 40 seeds: rounds with a queue", total[2], "rounds with queue-funded margin", total[3]
        );
    }

    /// @return seen [fees taken, fees taken with queue-funded margin open, rounds ending with a
    ///         queue, rounds ending with queue-funded margin open]
    function _feeFuzz(uint256 seed) internal returns (uint256[4] memory seen) {
        _attachCoin();
        uint256[3] memory pks = [alicePk, bobPk, carolPk];
        for (uint256 i; i < 3; ++i) {
            _fund(vm.addr(pks[i]), 100_000e6);
        }

        for (uint256 i; i < 30; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint64 price = uint64(bound(seed >> 192, 79_000e8, 81_000e8));
            uint256 pk = pks[(seed >> 8) % 3];
            address user = vm.addr(pk);
            uint256 op = seed % 6;
            uint256 fees = ex.stakerFees() + ex.devFees();
            bytes32[] memory ids = ex.openIdsOf(user);

            if (op == 5) {
                _seedHouse(bound(seed >> 16, 1e6, 3_000e6));
            } else if (op <= 1 || ids.length == 0) {
                uint96 margin = uint96(bound(seed >> 32, 10e6, 2_000e6));
                if (ex.balances(user) + ex.queuedOf(user) < margin) continue;
                _openQueued(pk, btc, (seed >> 128) & 1 == 1, margin, uint16(bound(seed >> 16, 5, 40)), price);
            } else {
                _close(pk, ids[(seed >> 16) % ids.length], price);
            }

            if (ex.stakerFees() + ex.devFees() > fees) {
                assertEq(ex.totalQueued(), 0, "a fee was taken with a winner queued");
                assertGe(ex.lpCash(), ex.debtMarginOpen(), "a fee was taken ahead of queue-funded margin");
                ++seen[0];
                if (ex.debtMarginOpen() != 0) ++seen[1];
            }
            if (ex.totalQueued() != 0) ++seen[2];
            if (ex.debtMarginOpen() != 0) ++seen[3];
            _assertBooks();
        }
    }

    /// @dev The no-code way to have no sweep at all: deploy with a cap the house can never
    ///      reach, so stakers earn their half of the fees and nothing else. The cap must be large
    ///      but FINITE: with type(uint256).max, `debtMarginOpen + stakerCap` (Exchange.sol:802)
    ///      overflows as soon as one queue-funded position is open. That used to stop every push
    ///      until it closed; now it stops only `lpExcess()` and the sweep, which have nothing to
    ///      do at that cap anyway, and the fee share is pushed as usual.
    function test_holds_aCapOutOfReachSwitchesTheExcessOff() public {
        _redeployWithCap(type(uint128).max);
        _attachCoin();
        _seedHouse(STAKER_CAP);
        _stake(alice, 1_000_000e18);
        _fund(bob, 2_000_000e6);
        (bytes32 long_, bytes32 short_) = _pair(bobPk, 1_000_000e6, 10, P0);
        uint64 P1 = _px(84_000);
        uint256 gain = _gain(P0, P1, 10_000_000e6, true);

        _close(bobPk, short_, P1);
        assertEq(ex.lpExcess(), 0);
        assertEq(ex.pushStakerFees(), 5_000e6, "the stakers' half of the fee and no more");
        _close(bobPk, long_, P1);
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        _sweep(P1, ETH0);
        assertEq(ex.lpCash(), STAKER_CAP + 490_000e6 - gain, "the house kept what the pair paid it");
        _assertBooks();

        // The trap, what is left of it.
        _redeployWithCap(type(uint256).max);
        _attachCoin();
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        _bust(alicePk, 100e6); // $1 of staker fees
        bytes32 won = _open(bobPk, btc, true, 200e6, 100, P0);
        _close(bobPk, won, _px(80_800)); // part paid, part queued
        bytes32 parked = _openQueued(bobPk, btc, true, uint96(ex.queuedOf(bob)), 1, P0);
        vm.expectRevert();
        ex.lpExcess();
        vm.expectRevert();
        _sweep(P0, ETH0);
        assertEq(ex.pushStakerFees(), 1e6, "fees are pushed all the same");
        _close(bobPk, parked, P0);
        assertEq(ex.lpExcess(), 0);
    }

    // ======================================================================================
    // HELD: the size bookkeeping the sweep is marked from
    // ======================================================================================

    /// @dev `sizeLong` / `sizeShort` and the open interest, after random opens, closes and
    ///      liquidations on both markets, at prices to the last unit so that every size rounds
    ///      its own way, 1x to 1000x: after every step each of the four figures of each market is
    ///      exactly the sum over the positions still open, and when the last position is gone
    ///      they are exactly zero. A settlement subtracts the very number its open added (same
    ///      margin, leverage and entry price, same division), so the subtraction cannot
    ///      underflow and cannot brick a close.
    function test_holds_fuzz_sizesTrackEveryPositionAndReturnToZero(uint256 seed) public {
        _sizesFuzz(seed);
    }

    /// @dev The fuzz test above is not vacuous: over 40 fixed seeds it opens hundreds of
    ///      positions and ends them by liquidation, by a close that busts and by an ordinary close.
    function test_holds_theSizesFuzzLiquidatesAndBusts() public {
        uint256[4] memory total;
        for (uint256 seed = 1; seed <= 40; ++seed) {
            uint256 snapshot = vm.snapshotState();
            uint256[4] memory seen = _sizesFuzz(seed);
            for (uint256 i; i < 4; ++i) {
                total[i] += seen[i];
            }
            vm.revertToState(snapshot);
        }
        assertGt(total[0], 300, "opens");
        assertGt(total[1], 20, "liquidations");
        assertGt(total[2], 20, "closes that settled as busts");
        assertGt(total[3], 20, "ordinary closes");
        console2.log("sizes fuzz, 40 seeds: opens", total[0], "liquidations", total[1]);
        console2.log("sizes fuzz, 40 seeds: closes that bust", total[2], "ordinary closes", total[3]);
    }

    /// @return seen [opens, liquidations, closes past the trigger, ordinary closes]
    function _sizesFuzz(uint256 seed) internal returns (uint256[4] memory seen) {
        uint256[3] memory pks = [alicePk, bobPk, carolPk];
        for (uint256 i; i < 3; ++i) {
            _fund(vm.addr(pks[i]), 50_000_000e6);
        }
        _seedHouse(50_000_000e6);
        uint256[2] memory sizeLong;
        uint256[2] memory sizeShort;
        uint256[2] memory oiLong;
        uint256[2] memory oiShort;

        for (uint256 i; i < 24; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 pk = pks[(seed >> 8) % 3];
            address user = vm.addr(pk);
            bytes32[] memory ids = ex.openIdsOf(user);

            if ((seed >> 16) % 5 < 3 || ids.length == 0) {
                uint16 market = seed & 1 == 0 ? btc : eth;
                uint16 leverage = uint16(bound(seed >> 24, 1, 1_000));
                uint96 margin = uint96(bound(seed >> 40, 1e6, 10_000_000e6 / uint256(leverage)));
                if (ex.balances(user) < margin) continue;
                bool isLong = (seed >> 136) & 1 == 1;
                uint64 price = _anyPrice(market, seed >> 144);
                _open(pk, market, isLong, margin, leverage, price);
                ++seen[0];
                uint256 notional = uint256(margin) * leverage;
                uint256 size = Math.mulDiv(notional, 1e18, price);
                if (isLong) {
                    sizeLong[market] += size;
                    oiLong[market] += notional;
                } else {
                    sizeShort[market] += size;
                    oiShort[market] += notional;
                }
            } else {
                bytes32 id = ids[(seed >> 24) % ids.length];
                Exchange.Position memory p = ex.getPosition(id);
                uint64 price = _anyPrice(p.market, seed >> 144);
                uint256 notional = uint256(p.margin) * p.leverage;
                uint256 size = Math.mulDiv(notional, 1e18, p.entryPrice);
                // Past its trigger it goes either way: an operator liquidation, or a close that
                // settles as a bust.
                bool crossed = PerpMath.crossed(price, _bustOf(id), p.isLong);
                if (crossed && (seed >> 32) & 1 == 1) {
                    _liquidate(id, price);
                    ++seen[1];
                } else {
                    _close(pk, id, price);
                    ++seen[crossed ? 2 : 3];
                }
                if (p.isLong) {
                    sizeLong[p.market] -= size;
                    oiLong[p.market] -= notional;
                } else {
                    sizeShort[p.market] -= size;
                    oiShort[p.market] -= notional;
                }
            }
            _assertSizes(sizeLong, sizeShort, oiLong, oiShort);
        }

        for (uint256 i; i < 3; ++i) {
            bytes32[] memory ids = ex.openIdsOf(vm.addr(pks[i]));
            for (uint256 j; j < ids.length; ++j) {
                _close(pks[i], ids[j], ex.getPosition(ids[j]).entryPrice);
            }
        }
        uint256[2] memory zero;
        _assertSizes(zero, zero, zero, zero);
        _assertSolvent();
    }

    function _anyPrice(uint16 market, uint256 r) internal view returns (uint64) {
        uint256 base = market == btc ? 80_000e8 : 2_500e8;
        return uint64(bound(r, base / 2, base * 2));
    }

    function _assertSizes(
        uint256[2] memory sizeLong,
        uint256[2] memory sizeShort,
        uint256[2] memory oiLong,
        uint256[2] memory oiShort
    ) internal view {
        for (uint16 market; market < 2; ++market) {
            Exchange.Market memory m = ex.getMarket(market);
            assertEq(m.sizeLong, sizeLong[market], "sizeLong");
            assertEq(m.sizeShort, sizeShort[market], "sizeShort");
            assertEq(m.oiLong, oiLong[market], "oiLong");
            assertEq(m.oiShort, oiShort[market], "oiShort");
        }
    }

    // ======================================================================================
    // HELD: the Batcher
    // ======================================================================================

    /// @dev Only addresses the Exchange lists as operators get through, the moment one is struck
    ///      off it is out, and a call that fails (a bad signature here) is reported and leaves the
    ///      calls around it standing.
    function test_holds_batcher_refusesNonOperatorsAndAFailedCallSinksNothingElse() public {
        vm.clearMockedCalls();
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        Intents.OpenIntent memory a = _intent(alice, btc, true, 100e6, 10);
        Intents.OpenIntent memory b = _intent(bob, btc, true, 100e6, 10);
        Intents.OpenIntent memory c = _intent(bob, btc, false, 100e6, 10);
        bytes[] memory update = _update(BTC_FEED, P0, uint64(vm.getBlockTimestamp()) + 2);
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(Exchange.open, (a, _sign(alicePk, _hashOpen(a)), update));
        calls[1] = abi.encodeCall(Exchange.open, (b, _sign(alicePk, _hashOpen(b)), update)); // the wrong key
        calls[2] = abi.encodeCall(Exchange.open, (c, _sign(bobPk, _hashOpen(c)), update));
        skip(12);

        address[4] memory outsiders = [stranger, admin, guardian, alice];
        for (uint256 i; i < 4; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(Batcher.NotOperator.selector);
            batcher.multicall(calls);
        }

        vm.expectEmit(address(batcher));
        emit Batcher.CallFailed(1, abi.encodeWithSelector(Intents.BadSignature.selector));
        vm.prank(operator);
        bool[] memory ok = batcher.multicall(calls);
        assertTrue(ok[0]);
        assertFalse(ok[1]);
        assertTrue(ok[2]);
        assertEq(ex.getPosition(_hashOpen(a)).owner, alice);
        assertEq(ex.getPosition(_hashOpen(b)).owner, address(0));
        assertEq(ex.getPosition(_hashOpen(c)).owner, bob);
        assertEq(ex.balances(alice), 900e6);
        assertEq(ex.balances(bob), 900e6);

        // Struck off the Exchange, struck off the Batcher.
        vm.prank(admin);
        ex.setOperator(operator, false);
        vm.prank(operator);
        vm.expectRevert(Batcher.NotOperator.selector);
        batcher.multicall(calls);

        // And with the Batcher itself struck off, a good order through it does nothing.
        vm.startPrank(admin);
        ex.setOperator(operator, true);
        ex.setOperator(address(batcher), false);
        vm.stopPrank();
        Intents.OpenIntent memory d = _intent(alice, btc, true, 100e6, 10);
        bytes[] memory one = new bytes[](1);
        one[0] = abi.encodeCall(
            Exchange.open,
            (d, _sign(alicePk, _hashOpen(d)), _update(BTC_FEED, P0, uint64(vm.getBlockTimestamp()) + 2))
        );
        skip(12);
        vm.expectEmit(address(batcher));
        emit Batcher.CallFailed(0, abi.encodeWithSelector(Exchange.NotOperator.selector));
        vm.prank(operator);
        assertFalse(batcher.multicall(one)[0]);
        assertEq(ex.balances(alice), 900e6);
    }

    /// @dev Through the Batcher an operator is the Batcher, which is an operator and nothing
    ///      else: every owner, guardian and sweeper function fails, as does anything that needs a
    ///      trader's own call or signature.
    ///
    ///      NOTE. The Batcher's ADDRESS is an account every operator can act as. Two things
    ///      follow, neither reachable without somebody's mistake: (1) USDC deposited to the
    ///      Batcher's trading balance can be withdrawn by any operator through the 15-minute
    ///      direct exit; (2) whatever role the Batcher's address is ever given (pending owner,
    ///      guardian, sweeper), every operator key holds. Never name it for anything.
    function test_holds_batcher_givesAnOperatorNothingItDidNotHave() public {
        vm.clearMockedCalls();
        _attachCoin();
        _fund(alice, 1_000e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 10, P0);
        _seedHouse(STAKER_CAP + 1_000e6);
        bytes[] memory update = _update(BTC_FEED, P0, uint64(vm.getBlockTimestamp()));

        bytes[] memory calls = new bytes[](16);
        calls[0] = abi.encodeCall(Exchange.setOperator, (stranger, true));
        calls[1] = abi.encodeCall(Exchange.setGuardian, (stranger));
        calls[2] = abi.encodeCall(Exchange.setDevRecipient, (stranger));
        calls[3] = abi.encodeCall(Exchange.setMinimums, (0, 0));
        calls[4] = abi.encodeCall(Exchange.unpauseOpens, ());
        calls[5] = abi.encodeCall(
            Exchange.listMarket, (keccak256("X/USD"), "X", 1_000, _btcCurve(), MAX_KEEP, 50, 1e13, 1e15, 1e15)
        );
        calls[6] = abi.encodeCall(Exchange.attachCoin, (address(staking), address(mining), address(sweeper)));
        calls[7] = abi.encodeWithSignature("transferOwnership(address)", operator);
        calls[8] = abi.encodeWithSignature("renounceOwnership()");
        calls[9] = abi.encodeWithSignature("acceptOwnership()");
        calls[10] = abi.encodeCall(Exchange.pauseOpens, ());
        calls[11] = abi.encodeCall(Exchange.retireMarket, (btc, update));
        calls[12] = abi.encodeCall(Exchange.sweepExcess, (1_000e6));
        calls[13] = abi.encodeCall(Exchange.requestClose, (id));
        calls[14] = abi.encodeCall(
            Exchange.withdrawBySig,
            (alice, operator, 900e6, uint64(vm.getBlockTimestamp() + 1 hours), new bytes(65))
        );
        calls[15] = abi.encodeCall(Exchange.executeWithdraw, (operator));
        vm.prank(operator);
        bool[] memory ok = batcher.multicall(calls);
        for (uint256 i; i < ok.length; ++i) {
            assertFalse(ok[i], "a call it should not be able to make went through");
        }
        assertEq(ex.owner(), admin);
        assertEq(ex.guardian(), guardian);
        assertEq(ex.balances(alice), 900e6);
        assertEq(ex.closeRequestedAt(id), 0);
        assertEq(ex.lpExcess(), 1_000e6);
        assertFalse(ex.isOperator(stranger));
        assertFalse(ex.opensPaused());

        // (1) A deposit made out to the Batcher's address.
        usdc.mint(stranger, 50e6);
        vm.startPrank(stranger);
        usdc.approve(address(ex), 50e6);
        ex.depositFor(address(batcher), 50e6);
        vm.stopPrank();
        bytes[] memory one = new bytes[](1);
        one[0] = abi.encodeCall(Exchange.requestWithdraw, (50e6));
        vm.prank(operator);
        assertTrue(batcher.multicall(one)[0]);
        skip(15 minutes);
        one[0] = abi.encodeCall(Exchange.executeWithdraw, (operator));
        vm.prank(operator);
        assertTrue(batcher.multicall(one)[0]);
        assertEq(usdc.balanceOf(operator), 50e6, "any operator can take what was credited to the Batcher");

        // (2) Ownership offered to the Batcher's address.
        vm.prank(admin);
        ex.transferOwnership(address(batcher));
        one[0] = abi.encodeWithSignature("acceptOwnership()");
        vm.prank(operator);
        assertTrue(batcher.multicall(one)[0]);
        assertEq(ex.owner(), address(batcher));
        one[0] = abi.encodeCall(Exchange.setOperator, (stranger, true));
        vm.prank(operator);
        assertTrue(batcher.multicall(one)[0]);
        assertTrue(ex.isOperator(stranger), "and with it every operator key is the owner");
    }

    // ======================================================================================
    // HELD: loss mining and the hook
    // ======================================================================================

    /// @dev Under-supplying gas cannot make the hook fail quietly while the loss settles. At the
    ///      smallest gas limit at which a liquidation goes through, and for 30,000 gas above it,
    ///      the loser has their coin; just below it the whole transaction reverts.
    function test_holds_theHookCannotBeStarvedIntoFailingSilently() public {
        _attachCoin();
        _fund(alice, 1_000e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        skip(12);
        bytes[] memory update = _update(BTC_FEED, _px(79_900), uint64(vm.getBlockTimestamp()) - 1);
        uint256 expected = mining.quote(100e6);

        uint256 enough = _minGasToLiquidate(id, update);
        console2.log("smallest gas limit for a liquidation with the hook attached", enough);

        vm.prank(operator);
        vm.expectRevert();
        ex.liquidate{gas: enough - 200}(id, update);

        uint256 snapshot = vm.snapshotState();
        for (uint256 extra; extra <= 30_000; extra += 1_000) {
            vm.recordLogs();
            vm.prank(operator);
            ex.liquidate{gas: enough + extra}(id, update);
            assertEq(_countMiningFailed(vm.getRecordedLogs()), 0);
            assertEq(coin.balanceOf(alice), expected, "settled without paying the loser");
            vm.revertToState(snapshot);
        }
    }

    /// @dev A hostile hook cannot stop a loss settling: reverting, burning all its gas, or
    ///      answering with 200 kB as a return value or a revert reason. A losing close and a
    ///      liquidation both go through, the liquidation with no more gas than the hook's own
    ///      allowance on top. A hook that fails is reported; a return bomb is not even noticed.
    function test_holds_aHostileHookCannotBlockALossOrABust() public {
        SwitchHook hook = new SwitchHook(address(ex));
        _attachHook(address(hook));
        _fund(alice, 1_000e6);

        for (uint8 m = 1; m <= 4; ++m) {
            hook.set(SwitchHook.Mode(m));
            uint256 reported = SwitchHook.Mode(m) == SwitchHook.Mode.ReturnBomb ? 0 : 1;

            bytes32 lost = _open(alicePk, btc, true, 100e6, 100, P0);
            vm.recordLogs();
            _close(alicePk, lost, _px(79_600)); // a losing close
            assertEq(ex.getPosition(lost).owner, address(0));
            assertEq(_countMiningFailed(vm.getRecordedLogs()), reported);

            bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
            skip(12);
            bytes[] memory update = _update(BTC_FEED, _px(79_900), uint64(vm.getBlockTimestamp()) - 1);
            uint256 enough = _minGasToLiquidate(id, update);
            assertLt(enough, 600_000);
            vm.getRecordedLogs(); // drop what the measuring recorded
            vm.prank(operator);
            ex.liquidate{gas: enough}(id, update);
            assertEq(ex.getPosition(id).owner, address(0));
            assertEq(_countMiningFailed(vm.getRecordedLogs()), reported);
        }
        assertEq(ex.balances(alice), 1_000e6 - 4 * 150e6);
        assertEq(hook.calls(), 0);
        _assertBooks();
    }

    /// @dev A broken or hostile coin never blocks a losing close or a liquidation: transfers that
    ///      revert, return false, blacklist the loser, burn all the gas, or call back into the
    ///      Exchange (seven entry points, the sweep among them, all refused). A failed payout
    ///      preserves the loss and reserves the same reward for later delivery.
    function test_holds_aBrokenCoinNeverBlocksALossOrABust() public {
        TrickCoin trick = new TrickCoin(ex);
        (, LossMining lm) = _attachWith(address(trick));
        trick.transfer(address(lm), RESERVE);
        _fund(alice, 1_000e6);
        _seedHouse(1_000e6);
        uint256 snapshot = vm.snapshotState();

        for (uint8 m = 1; m <= 5; ++m) {
            trick.set(TrickCoin.Mode(m), alice);
            bytes32 lost = _open(alicePk, btc, true, 100e6, 100, P0);
            _close(alicePk, lost, _px(79_600)); // -$50
            _bust(alicePk, 100e6); // -$100

            assertEq(ex.balances(alice), 850e6);
            assertEq(ex.openIdsOf(alice).length, 0);
            if (TrickCoin.Mode(m) == TrickCoin.Mode.Reenter) {
                assertEq(trick.tried(), 14);
                assertEq(trick.blocked(), 14, "every call back into the Exchange hit the guard");
                assertGt(trick.balanceOf(alice), 0);
                assertEq(lm.cumulativeLossUsd(), 149e6);
            } else {
                assertEq(trick.balanceOf(alice), 0);
                assertEq(lm.cumulativeLossUsd(), 149e6);
                assertGt(lm.totalMined(), 0);
                assertEq(lm.pendingRewards(alice), lm.totalMined());
                assertEq(lm.totalPending(), lm.totalMined());
                assertEq(lm.reserve() + lm.totalMined(), RESERVE);
                uint256 reward = lm.pendingRewards(alice);
                trick.set(TrickCoin.Mode.Plain, address(0));
                lm.claim(alice);
                assertEq(trick.balanceOf(alice), reward);
                assertEq(lm.totalPending(), 0);
            }
            _assertBooks();
            vm.revertToState(snapshot);
        }
    }

    /// @dev The curve is path-independent through the Exchange too: one $10,000 bust, ten of
    ///      $1,000, or the same spread over two accounts all mine the same total.
    function test_holds_splittingALossMinesTheSame() public {
        _attachCoin();
        _fund(alice, 100_000e6);
        _fund(bob, 100_000e6);
        uint256 snapshot = vm.snapshotState();

        // The whole loss fits the new exposure ceiling; mining depends on loss, not leverage.
        bytes32 wholePosition = _open(alicePk, btc, true, 10_000e6, 100, P0);
        _liquidate(wholePosition, _px(79_000));
        uint256 whole = coin.balanceOf(alice);
        assertEq(whole, mining.totalMined());
        vm.revertToState(snapshot);

        for (uint256 i; i < 10; ++i) {
            _bust(alicePk, 1_000e6);
        }
        uint256 split = coin.balanceOf(alice);
        assertLe(split, whole);
        assertApproxEqAbs(split, whole, 10);
        vm.revertToState(snapshot);

        for (uint256 i; i < 5; ++i) {
            _bust(alicePk, 1_000e6);
            _bust(bobPk, 1_000e6);
        }
        assertApproxEqAbs(coin.balanceOf(alice) + coin.balanceOf(bob), whole, 10);
        assertGt(coin.balanceOf(alice), coin.balanceOf(bob), "only the order matters: first is best");
    }

    /// @dev What mining costs someone who is NOT a staker, both legs held by one account.
    ///      Measured: 12.2% of the loss at 10x on a 5% move ($60,840 for 35.7M coin, $0.0017 a
    ///      coin at the start of the curve), and about two thirds when the losing leg is a 1000x
    ///      bust, which now comes after 5.24 bps. The bust rule does not make it cheaper.
    function test_holds_washMiningCostsANonStakerTwelvePercent() public {
        _attachCoin();
        _seedHouse(1_000_000e6); // a house that can pay, far below its cap
        _fund(bob, 2_000_000e6);
        (bytes32 long_, bytes32 short_) = _pair(bobPk, 1_000_000e6, 10, P0);
        _close(bobPk, short_, _px(84_000));
        _close(bobPk, long_, _px(84_000));

        uint256 cost = 2_000_000e6 - ex.balances(bob);
        uint256 mined = coin.balanceOf(bob);
        assertEq(mining.cumulativeLossUsd(), 490_000e6, "mined on the loss less the house fee");
        assertGt(cost * 10_000, 500_000e6 * 1_180);
        assertLt(cost * 10_000, 500_000e6 * 1_230);
        console2.log("wash at 10x, 5% move: cost (USDC)", cost / 1e6, "coin mined", mined / 1e18);

        // The cheapest-looking shortcut, a 1000x pair where the loser busts at its trigger.
        _fund(carol, 20_000e6);
        (bytes32 long2, bytes32 short2) = _pair(carolPk, 10_000e6, 1_000, P0);
        uint64 trigger = uint64(_bustOf(short2));
        _liquidate(short2, trigger);
        _close(carolPk, long2, trigger);
        uint256 cost2 = 20_000e6 - ex.balances(carol);
        assertGt(cost2 * 100, 10_000e6 * 60, "more than 60 cents per dollar mined on");
        assertEq(mining.cumulativeLossUsd(), 490_000e6 + 10_000e6, "a bust mines on the whole margin");
        console2.log("wash at 1000x, bust: cost (USDC)", cost2 / 1e6, "per (USDC) mined on", 10_000);
    }

    /// @dev The first-ever payout (three fresh storage slots, everything cold) fits the hook's
    ///      150,000 gas with room to spare for the plain coin.
    function test_holds_theGasBudgetCoversThePlainCoin() public {
        _attachCoin();
        vm.cool(address(mining));
        vm.cool(address(coin));
        vm.prank(address(ex));
        uint256 before = gasleft();
        mining.onLoss{gas: 150_000}(alice, 1e6);
        uint256 used = before - gasleft();
        assertGt(coin.balanceOf(alice), 0);
        assertLt(used, 110_000);
        console2.log("gas used by the first onLoss, cold", used);
    }

    /// @dev An empty or tiny reserve: the loss settles, nothing is paid, the curve still moves
    ///      (as documented). A top-up is emitted at the rate the curve has reached, not at the
    ///      starting rate, and sending coin in buys the sender nothing.
    function test_holds_anEmptyOrToppedUpReserve() public {
        coin = new Coin("Tape", "TAPE", SUPPLY, address(this));
        staking = new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(ex));
        mining = new LossMining(IERC20(address(coin)), address(ex), MINING_SCALE, address(0));
        sweeper = _newSweeper(ex);
        vm.prank(admin);
        ex.attachCoin(address(staking), address(mining), address(sweeper));
        _fund(alice, 100_000e6);

        _bust(alicePk, 1_000e6);
        assertEq(coin.balanceOf(alice), 0);
        assertEq(mining.cumulativeLossUsd(), 1_000e6);

        coin.transfer(address(mining), 1_000); // 1,000 wei of reserve
        _bust(alicePk, 1_000e6);
        assertEq(coin.balanceOf(alice), 0, "rounds to nothing");
        assertEq(mining.cumulativeLossUsd(), 2_000e6);

        // Flash top-up: put 100M in, lose $1,000, get back 0.02% of it.
        coin.transfer(address(mining), 100_000_000e18);
        _bust(alicePk, 1_000e6);
        assertApproxEqRel(coin.balanceOf(alice), (uint256(100_000_000e18) * 1_000) / 5_003_000, 1e12);
    }
}
