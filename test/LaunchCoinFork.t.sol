// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";

import {LaunchCoin, PoolKey, IPositionManager} from "../src/LaunchCoin.sol";
import {FeeHook, IPoolManagerClaims, SwapParams} from "../src/periphery/FeeHook.sol";
import {Deployable} from "../script/Deployable.sol";
import {HookMiner} from "../script/HookMiner.sol";
import {Deployer} from "./Deployer.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Allowance {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @dev UNCX's Uniswap v4 locker, as much of it as these tests look at.
interface ILocker {
    struct LockInfo {
        uint256 lockId;
        address owner;
        uint256 tokenId;
        PoolKey poolKey;
        uint256 amount;
        uint256 unlockTime;
        address collectAddress;
        bool isNFTized;
        uint256 ucf;
    }

    error NotOwner();
    error StillLocked();

    function flatFee() external view returns (uint256);
    function lpFee() external view returns (uint256);
    function collectFee() external view returns (uint256);
    function FEE_ADDR_LP() external view returns (address);
    function FEE_ADDR_COLLECT() external view returns (address);
    function getLockInfo(uint256 lockId) external view returns (LockInfo memory);
    function collect(uint256 lockId, address recipient)
        external
        returns (uint256 amount0, uint256 amount1, uint256 fee0, uint256 fee1);
    function unlockLiquidity(uint256 lockId) external;
    function relock(uint256 lockId, uint256 newUnlockTime) external;
    function transferLockOwnership(uint256 lockId, address newOwner) external;
}

/// @dev As much of Uniswap v4's PoolManager as a caller that swaps without a router uses.
interface IPoolManagerSwap {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function settle() external payable returns (uint256);
    function sync(address currency) external;
    function take(address currency, address to, uint256 amount) external;
}

interface IStateView {
    function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24, uint24);
}

/// @dev A trader that talks to the PoolManager itself, as bots do: any amount, any price limit.
contract DirectSwapper {
    IPoolManagerSwap internal immutable pm;

    constructor(address pm_) {
        pm = IPoolManagerSwap(pm_);
    }

    receive() external payable {}

    /// @return delta what the swap moved for this caller: ETH in the upper half, coin in the lower,
    ///         negative for paid.
    function swap(PoolKey memory key, SwapParams memory params) external returns (int256 delta) {
        delta = abi.decode(pm.unlock(abi.encode(key, params)), (int256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "not the pool manager");
        (PoolKey memory key, SwapParams memory params) = abi.decode(data, (PoolKey, SwapParams));
        int256 delta = pm.swap(key, params, "");
        int256 eth = delta >> 128;
        int256 coin = int256(int128(delta));
        if (eth < 0) pm.settle{value: uint256(-eth)}();
        else if (eth > 0) pm.take(address(0), address(this), uint256(eth));
        if (coin < 0) {
            pm.sync(key.currency1);
            LaunchCoin(key.currency1).transfer(address(pm), uint256(-coin));
            pm.settle();
        } else if (coin > 0) {
            pm.take(key.currency1, address(this), uint256(coin));
        }
        return abi.encode(delta);
    }
}

struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

struct ExactOutputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountOut;
    uint128 amountInMaximum;
    bytes hookData;
}

/// @dev The launch coin against the real Uniswap v4 and the real UNCX locker on a fork of Ethereum
///      mainnet: the pool it opens, the fee hook on that pool, the lock it puts the liquidity in,
///      the wallet limit on real swaps, and what the launch bundle (fifteen wallets, each just
///      under the limit) costs.
///
///          FORK=true forge test --match-contract LaunchCoinForkTest -vv
contract LaunchCoinForkTest is Deployer {
    IUniversalRouter internal constant UR = IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    IPositionManager internal constant PM = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
    ILocker internal constant LOCKER = ILocker(0x147AECa171a79466Fe9E2c03f21b45155Ff403F8);
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    /// @dev The launch split: 20% to loss mining, 80% in the pool.
    uint256 internal constant RESERVE = 200_000_000e18;
    uint256 internal constant POOL = SUPPLY - RESERVE;
    uint256 internal constant MAX_WALLET = SUPPLY / 50;
    uint256 internal constant YEAR = 365 days;
    /// @dev The most of the liquidity the launch lets the locker take: 1%, its rate today.
    uint256 internal constant LOCKER_CUT = 100;
    /// @dev The pool's own trading fee, in hundredths of a basis point: 1% of every buy and sell,
    ///      for its liquidity. The hook takes another 1% of the ETH side.
    uint24 internal constant FEE = 10_000;

    // Opens at tick 200400: one ETH buys about 505M coin, a market cap near 2 ETH for the whole
    // supply. The pool's part sits single-sided from there down to the bottom of the curve.
    uint160 internal constant SQRT_START = 1779478419032188924193855251423147;
    int24 internal constant TICK_UPPER = 200400;
    int24 internal constant TICK_LOWER = -887200;
    /// @dev The liquidity the whole supply would be over that range; the pool gets its share of it.
    uint128 internal constant LIQUIDITY_OF_SUPPLY = 44523249996678482940644;
    uint128 internal constant LIQUIDITY = uint128(uint256(LIQUIDITY_OF_SUPPLY) * POOL / SUPPLY);

    LaunchCoin internal coin;
    FeeHook internal hook;
    address internal hookWallet = makeAddr("launch coin fork hook wallet");
    address internal deployer = makeAddr("launch coin fork deployer");
    address internal lockOwner = makeAddr("launch coin fork lock owner");
    address internal alice = makeAddr("launch coin fork alice");
    address internal bob = makeAddr("launch coin fork bob");
    /// @dev What a launch signed now is good until.
    uint256 internal soon;
    /// @dev The locker's flat fee, which the launch has to be sent exactly.
    uint256 internal flat;

    function setUp() public {
        if (!vm.envOr("FORK", false)) return;
        vm.createSelectFork(vm.envOr("ETH_ARCHIVE_RPC_URL", string("https://eth.drpc.org")));
        soon = block.timestamp + 600;
        flat = LOCKER.flatFee();
        coin = LaunchCoin(
            _deployed(
                "LaunchCoin",
                type(LaunchCoin).creationCode,
                abi.encode("Tape", "TAPE", SUPPLY, RESERVE, deployer, uint256(200), deployer)
            )
        );
        vm.deal(deployer, 10 ether);

        // The hook goes where its permissions are read from: an address ending in them.
        bytes memory initcode = abi.encodePacked(
            fromDeployable ? Deployable.code("FeeHook") : type(FeeHook).creationCode,
            abi.encode(POOL_MANAGER, hookWallet)
        );
        (bytes32 salt, address expected) = HookMiner.find(initcode, (1 << 7) | (1 << 6) | (1 << 3) | (1 << 2));
        hook = FeeHook(HookMiner.deploy(initcode, salt));
        assertEq(address(hook), expected);
    }

    modifier onFork() {
        if (!vm.envOr("FORK", false)) {
            vm.skip(true);
        }
        _;
    }

    function _launch() internal {
        vm.prank(deployer);
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT
        );
    }

    function _key() internal view returns (PoolKey memory k) {
        (address c0, address c1, uint24 fee, int24 spacing, address hooks) = coin.poolKey();
        k = PoolKey(c0, c1, fee, spacing, hooks);
    }

    /// @dev Buys with exactly `ethIn` through Uniswap's Universal Router, as a trader would.
    function _buy(address who, uint256 ethIn) internal returns (uint256 got) {
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(ExactInputSingleParams(_key(), true, uint128(ethIn), 0, ""));
        p[1] = abi.encode(address(0), ethIn);
        p[2] = abi.encode(address(coin), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), p);
        vm.deal(who, who.balance + ethIn);
        uint256 before = coin.balanceOf(who);
        vm.prank(who);
        UR.execute{value: ethIn}(hex"10", inputs, block.timestamp);
        got = coin.balanceOf(who) - before;
    }

    function buyExternal(address who, uint256 ethIn) external returns (uint256) {
        return _buy(who, ethIn);
    }

    /// @dev Buys exactly `coinOut`, paying whatever that costs; the router hands back the rest.
    function _buyExactly(address who, uint256 coinOut) internal returns (uint256 paid) {
        uint256 budget = 5 ether;
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(ExactOutputSingleParams(_key(), true, uint128(coinOut), uint128(budget), ""));
        p[1] = abi.encode(address(0), budget);
        p[2] = abi.encode(address(coin), coinOut);
        bytes[] memory inputs = new bytes[](2);
        // SWAP_EXACT_OUT_SINGLE, SETTLE_ALL, TAKE_ALL; then SWEEP the unspent ETH back
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x08), uint8(0x0c), uint8(0x0f)), p);
        inputs[1] = abi.encode(address(0), who, uint256(0));
        vm.deal(who, budget);
        vm.prank(who);
        UR.execute{value: budget}(hex"1004", inputs, block.timestamp);
        paid = budget - who.balance;
    }

    function _sell(address who, uint256 amount) internal returns (uint256 ethOut) {
        vm.startPrank(who);
        coin.approve(PERMIT2, amount);
        IPermit2Allowance(PERMIT2).approve(address(coin), address(UR), uint160(amount), uint48(block.timestamp + 600));
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(ExactInputSingleParams(_key(), false, uint128(amount), 0, ""));
        p[1] = abi.encode(address(coin), amount);
        p[2] = abi.encode(address(0), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), p);
        uint256 before = who.balance;
        UR.execute(hex"10", inputs, block.timestamp);
        vm.stopPrank();
        ethOut = who.balance - before;
    }

    /// @dev Sells whatever coin it takes to come away with exactly `ethOut`.
    function _sellFor(address who, uint256 ethOut) internal {
        uint256 most = coin.balanceOf(who);
        vm.startPrank(who);
        coin.approve(PERMIT2, most);
        IPermit2Allowance(PERMIT2).approve(address(coin), address(UR), uint160(most), uint48(block.timestamp + 600));
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(ExactOutputSingleParams(_key(), false, uint128(ethOut), uint128(most), ""));
        p[1] = abi.encode(address(coin), most);
        p[2] = abi.encode(address(0), ethOut);
        bytes[] memory inputs = new bytes[](1);
        // SWAP_EXACT_OUT_SINGLE, SETTLE_ALL, TAKE_ALL
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x08), uint8(0x0c), uint8(0x0f)), p);
        uint256 before = who.balance;
        UR.execute(hex"10", inputs, block.timestamp);
        vm.stopPrank();
        assertEq(who.balance - before, ethOut, "the trader got exactly what was asked for");
    }

    // --------------------------------------------------------------------------------------
    // Launch
    // --------------------------------------------------------------------------------------

    function test_launch_putsThePoolsPartInThePoolAndLocksItForAYear() public onFork {
        assertEq(coin.balanceOf(address(coin)), POOL);
        address lockersWallet = LOCKER.FEE_ADDR_LP();
        uint256 lockersCoin = coin.balanceOf(lockersWallet);
        uint256 lockersEth = lockersWallet.balance;
        uint256 cut = LOCKER.lpFee();
        _launch();

        // The pool, and the position in it.
        uint256 id = coin.lpTokenId();
        assertGt(id, 0);
        assertEq(coin.balanceOf(address(coin)), 0, "nothing left inside the coin");
        uint256 dust = coin.balanceOf(coin.DEAD());
        assertLt(dust, 1e12, "only rounding dust was burned");
        assertEq(coin.balanceOf(deployer), RESERVE, "the mining reserve was not touched");
        assertEq(coin.allowance(address(coin), PERMIT2), 0, "no allowance left behind");

        // The lock: the locker holds the position, in the lock owner's name, for a year.
        assertEq(PM.ownerOf(id), address(LOCKER), "the locker holds the position");
        ILocker.LockInfo memory lock = LOCKER.getLockInfo(coin.lockId());
        assertEq(lock.tokenId, id);
        assertEq(lock.owner, lockOwner, "the lock is the lock owner's");
        assertEq(lock.collectAddress, lockOwner);
        assertEq(lock.unlockTime, block.timestamp + YEAR);
        assertEq(coin.lockedUntil(), block.timestamp + YEAR);
        assertFalse(lock.isNFTized);

        // What the locker took for it: its flat fee, and its share of the liquidity, in coin.
        uint256 taken = coin.balanceOf(lockersWallet) - lockersCoin;
        assertEq(lockersWallet.balance - lockersEth, flat, "the flat fee");
        assertApproxEqRel(taken, POOL * cut / 10_000, 0.0001e18, "its share of the pool's coin");
        assertEq(coin.lockedLiquidity(), LIQUIDITY - uint128(uint256(LIQUIDITY) * cut / 10_000));
        assertEq(lock.amount, coin.lockedLiquidity());
        assertApproxEqAbs(coin.balanceOf(POOL_MANAGER) + dust + taken, POOL, 2, "the rest is in the pool");
        console2.log("burned rounding dust (wei)", dust);
        console2.log("coin the locker took, in basis points of supply", taken * 10_000 / SUPPLY);
    }

    function test_launch_isTheOwnersAndHappensOnce() public onFork {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(LaunchCoin.NotOwner.selector);
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT
        );
        _launch();
        vm.prank(deployer);
        vm.expectRevert(LaunchCoin.AlreadyLaunched.selector);
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT
        );
    }

    function test_launch_nothingCanBeExemptedOnceThePoolIsOpen() public onFork {
        vm.prank(deployer);
        coin.setExempt(bob);
        _launch();
        vm.prank(deployer);
        vm.expectRevert(LaunchCoin.AlreadyLaunched.selector);
        coin.setExempt(alice);
        assertTrue(coin.isExempt(bob), "what was exempt before stays so");
    }

    /// @dev Someone creates our exact pool first, at a dearer price, to block the launch. The
    ///      launch reverts with nothing lost, and the owner launches on another fee tier.
    function test_launch_aSquattedPoolRevertsAndAnotherTierWorks() public onFork {
        PoolKey memory squatted = PoolKey(address(0), address(coin), FEE, 200, address(hook));
        PM.initializePool(squatted, 1610146708304539256139594963901528); // 2,000 ticks dearer than our start
        uint256 ethBefore = deployer.balance;
        vm.prank(deployer);
        vm.expectRevert();
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT
        );
        assertEq(coin.lpTokenId(), 0);
        assertEq(coin.balanceOf(address(coin)), POOL, "the pool's part is still inside the coin");
        assertEq(deployer.balance, ethBefore, "and the locker's fee was not spent");

        vm.prank(deployer);
        // Same fee, another spacing: a different pool.
        coin.launch{value: flat}(FEE, 60, address(hook), SQRT_START, -887220, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT);
        assertEq(PM.ownerOf(coin.lpTokenId()), address(LOCKER));
        assertGt(_buy(alice, 0.02 ether), 0);
    }

    /// @dev Somebody creates our pool first at a CHEAPER price. Nothing is for sale between their
    ///      price and ours, so the launch goes through and the first buyer pays what they would have.
    function test_launch_aPoolSquattedCheaperChangesNothing() public onFork {
        address buyer = makeAddr("launch coin fork first buyer");
        uint256 each = SUPPLY * 195 / 10_000;

        uint256 clean = vm.snapshotState();
        _launch();
        uint256 untouched = _buyExactly(buyer, each);
        vm.revertToState(clean);

        PoolKey memory squatted = PoolKey(address(0), address(coin), FEE, 200, address(hook));
        PM.initializePool(squatted, 1966617965598688899418246449351024); // tick 202400: 2,000 ticks cheaper
        _launch();
        assertEq(_buyExactly(buyer, each), untouched, "the first 1.95% costs the same");
    }

    /// @dev The numbers given must put the pool's part in the pool. Liquidity too small for the
    ///      range would open a thin pool and burn the rest; that reverts instead.
    function test_launch_numbersThatLeaveThePoolShortAreRefused() public onFork {
        vm.startPrank(deployer);
        vm.expectRevert(LaunchCoin.PoolNotFilled.selector);
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY / 2, soon, YEAR, lockOwner, LOCKER_CUT
        );
        // Two parts in a million short is refused; half a part in a million is rounding.
        uint128 short = LIQUIDITY - LIQUIDITY / 500_000;
        vm.expectRevert(LaunchCoin.PoolNotFilled.selector);
        coin.launch{value: flat}(FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, short, soon, YEAR, lockOwner, LOCKER_CUT);
        assertEq(coin.lpTokenId(), 0);
        assertEq(coin.balanceOf(address(coin)), POOL, "nothing moved");

        uint128 rounding = LIQUIDITY - LIQUIDITY / 2_000_000;
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, rounding, soon, YEAR, lockOwner, LOCKER_CUT
        );
        vm.stopPrank();
        assertGt(coin.lpTokenId(), 0);
        assertLe(coin.balanceOf(coin.DEAD()), POOL / 1_000_000);
    }

    /// @dev Coin sent to the coin before its launch neither blocks the launch nor reaches the pool.
    function test_launch_coinSentToTheCoinFirstIsBurnedNotPooled() public onFork {
        vm.prank(deployer);
        coin.transfer(address(coin), 1_000e18);
        _launch();
        uint256 burned = coin.balanceOf(coin.DEAD());
        assertGe(burned, 1_000e18);
        assertLt(burned, 1_000e18 + 1e12);
        assertEq(coin.balanceOf(address(coin)), 0);
    }

    /// @dev A launch signed for a bundle that never landed must not open the pool on its own later.
    function test_launch_aStaleLaunchIsRefused() public onFork {
        vm.warp(soon + 1);
        vm.prank(deployer);
        vm.expectRevert(LaunchCoin.Expired.selector);
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT
        );
        vm.warp(soon);
        _launch();
        assertGt(coin.lpTokenId(), 0);
    }

    /// @dev The lock's terms are checked before anything moves.
    function test_launch_theLocksTermsAreChecked() public onFork {
        vm.startPrank(deployer);
        // The locker keeps whatever it is sent, so it is sent its fee to the wei.
        vm.expectRevert(LaunchCoin.NotTheLockersFee.selector);
        coin.launch{value: flat + 1}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT
        );
        vm.expectRevert(LaunchCoin.NotTheLockersFee.selector);
        coin.launch(FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT);
        // No lock shorter than a month, and it has to be somebody's.
        vm.expectRevert(LaunchCoin.LockTooShort.selector);
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, 30 days - 1, lockOwner, LOCKER_CUT
        );
        vm.expectRevert(LaunchCoin.ZeroAddress.selector);
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, address(0), LOCKER_CUT
        );
        // The locker may not take more of the liquidity than the launch allows it.
        uint256 asks = LOCKER.lpFee();
        vm.expectRevert(LaunchCoin.LockerTakesTooMuch.selector);
        coin.launch{value: flat}(
            FEE, 200, address(hook), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, asks - 1
        );
        vm.stopPrank();
        assertEq(coin.lpTokenId(), 0);
    }

    // --------------------------------------------------------------------------------------
    // The lock
    // --------------------------------------------------------------------------------------

    function test_lock_nobodyTakesTheLiquidityOutBeforeTheYearIsUp() public onFork {
        _launch();
        uint256 lock = coin.lockId();
        uint256 id = coin.lpTokenId();

        // Not the lock's owner, while it runs.
        vm.prank(lockOwner);
        vm.expectRevert(ILocker.StillLocked.selector);
        LOCKER.unlockLiquidity(lock);
        skip(YEAR - 1);
        vm.prank(lockOwner);
        vm.expectRevert(ILocker.StillLocked.selector);
        LOCKER.unlockLiquidity(lock);

        // Not the coin's owner, nor anyone else, ever: the lock is not theirs.
        skip(2);
        vm.prank(deployer);
        vm.expectRevert(ILocker.NotOwner.selector);
        LOCKER.unlockLiquidity(lock);
        vm.prank(alice);
        vm.expectRevert(ILocker.NotOwner.selector);
        LOCKER.transferLockOwnership(lock, alice);
        // And the position manager takes orders about it from the locker alone.
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encode(id, uint256(coin.lockedLiquidity()), uint128(0), uint128(0), bytes(""));
        p[1] = abi.encode(address(0), address(coin), deployer);
        vm.prank(deployer);
        vm.expectRevert();
        PM.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x01), uint8(0x11)), p), block.timestamp);

        // Once the year is up the lock's owner can lock it again, or take the position.
        assertEq(PM.ownerOf(id), address(LOCKER));
        uint256 state = vm.snapshotState();
        vm.prank(lockOwner);
        LOCKER.relock(lock, block.timestamp + YEAR);
        vm.prank(lockOwner);
        vm.expectRevert(ILocker.StillLocked.selector);
        LOCKER.unlockLiquidity(lock);
        vm.revertToState(state);

        vm.prank(lockOwner);
        LOCKER.unlockLiquidity(lock);
        assertEq(PM.ownerOf(id), lockOwner, "the position is the lock owner's again");
    }

    function test_lock_feesAreTheLockOwnersToCollectAndTheLiquidityStays() public onFork {
        _launch();
        _buy(alice, 0.03 ether);
        _buy(bob, 0.02 ether);
        _sell(alice, coin.balanceOf(alice));
        uint128 liquidity = coin.lockedLiquidity();
        uint256 lockersShare = LOCKER.collectFee();
        address payTo = makeAddr("launch coin fork fee wallet");
        uint256 lock = coin.lockId();

        // Only the lock's owner collects.
        vm.prank(deployer);
        vm.expectRevert(ILocker.NotOwner.selector);
        LOCKER.collect(lock, deployer);

        vm.prank(lockOwner);
        LOCKER.collect(lock, payTo);
        // The pool's 1% of the 0.05 ETH of buys (after the hook's 1%), less the locker's share of
        // what is collected.
        uint256 swapped = 0.05 ether * 99 / 100;
        assertApproxEqRel(payTo.balance, swapped * uint256(FEE) / 1e6 * (10_000 - lockersShare) / 10_000, 0.02e18);
        assertGt(coin.balanceOf(payTo), 0, "1% of the sell, in coin");
        assertEq(coin.lockedLiquidity(), liquidity, "the liquidity was not touched");
        assertEq(PM.ownerOf(coin.lpTokenId()), address(LOCKER));
        console2.log("collected (wei)", payTo.balance, "the locker keeps (bps)", lockersShare);
    }

    // --------------------------------------------------------------------------------------
    // The fee hook
    // --------------------------------------------------------------------------------------

    function test_hook_isWhereItsPermissionsSayAndHasNoSettings() public onFork {
        assertEq(uint160(address(hook)) & ((1 << 14) - 1), hook.PERMISSIONS(), "swap callbacks and nothing else");
        assertEq(hook.feeRecipient(), hookWallet);
        assertEq(address(hook.poolManager()), POOL_MANAGER);
        assertEq(hook.FEE_PIPS(), 10_000);
        // Only the PoolManager talks to it.
        SwapParams memory params = SwapParams(true, -1 ether, 0);
        PoolKey memory key = PoolKey(address(0), address(coin), FEE, 200, address(hook));
        vm.expectRevert(FeeHook.NotPoolManager.selector);
        hook.beforeSwap(alice, key, params, "");
        vm.expectRevert(FeeHook.NotPoolManager.selector);
        hook.afterSwap(alice, key, params, 0, "");
        vm.expectRevert(FeeHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(uint256(1)));
    }

    /// @dev One per cent of the ETH side, whichever way the trade goes and whichever amount the
    ///      trader fixed.
    function test_hook_takesOnePercentOfTheEthOnEveryKindOfTrade() public onFork {
        _launch();

        // A buy with the ETH fixed: 1% of what goes in.
        _buy(alice, 0.04 ether);
        assertEq(hook.pending(), 0.0004 ether, "buy, ETH in fixed");

        // A buy with the coin fixed: 1% on top of what the pool is paid.
        uint256 before = hook.pending();
        uint256 paid = _buyExactly(bob, 5_000_000e18);
        assertApproxEqAbs(hook.pending() - before, paid * 100 / 10_100, 2, "buy, coin out fixed");

        // A sell with the coin fixed: 1% of the ETH the pool pays out.
        before = hook.pending();
        uint256 got = _sell(alice, coin.balanceOf(alice) / 2);
        assertApproxEqAbs(hook.pending() - before, got * 100 / 9_900, 2, "sell, coin in fixed");

        // A sell with the ETH fixed: 1% on top of what the trader asked for.
        before = hook.pending();
        _sellFor(bob, 0.001 ether);
        assertEq(hook.pending() - before, 0.00001 ether, "sell, ETH out fixed");
    }

    function test_hook_feesGoToTheOneAddressWhoeverCollects() public onFork {
        _launch();
        _buy(alice, 0.03 ether);
        uint256 pending = hook.pending();
        assertEq(pending, 0.0003 ether);

        vm.prank(bob);
        assertEq(hook.collect(), pending);
        assertEq(hookWallet.balance, pending, "all of it, to the recipient");
        assertEq(hook.pending(), 0);
        assertEq(address(hook).balance, 0, "the hook itself holds nothing");
        assertEq(hook.collect(), 0, "nothing more to send");
    }

    function test_hook_answersToUniswapsOwnNames() public onFork {
        // The selectors the PoolManager calls, and checks the answers against.
        assertEq(FeeHook.beforeSwap.selector, bytes4(0x575e24b4));
        assertEq(FeeHook.afterSwap.selector, bytes4(0xb47b2fb1));
        assertEq(FeeHook.unlockCallback.selector, bytes4(0x91dd7346));
    }

    function _sqrtPriceNow() internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) =
            IStateView(0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227).getSlot0(keccak256(abi.encode(_key())));
    }

    /// @dev A bot swaps through the PoolManager itself and may ask for any amount, with a price
    ///      limit to stop where it likes. Asking for an impossible amount must not be a way to
    ///      trade without the fee: it is charged on all the PoolManager could ever move, which
    ///      nobody can pay, so the bot's own settlement fails.
    function test_hook_anImpossiblyLargeOrderIsNotAWayAroundTheFee() public onFork {
        _launch();
        _buy(alice, 0.03 ether);
        DirectSwapper bot = new DirectSwapper(POOL_MANAGER);
        vm.deal(address(bot), 5 ether);
        vm.prank(alice);
        coin.transfer(address(bot), 1_000_000e18);
        PoolKey memory key = _key();
        uint160 sqrtNow = _sqrtPriceNow();
        uint256 pending = hook.pending();
        int256 tooMuch = int256(uint256(type(uint128).max) + 1);

        // A buy: ETH in, fixed at more than exists, stopping half a per cent of the way down.
        vm.expectRevert();
        bot.swap(key, SwapParams(true, -tooMuch, uint160(uint256(sqrtNow) * 995 / 1000)));
        // The same with the one amount that has no positive twin.
        vm.expectRevert();
        bot.swap(key, SwapParams(true, type(int256).min, uint160(uint256(sqrtNow) * 995 / 1000)));
        // A sell: ETH out, fixed at more than exists, stopping half a per cent of the way up.
        vm.expectRevert();
        bot.swap(key, SwapParams(false, tooMuch, uint160(uint256(sqrtNow) * 1005 / 1000)));
        assertEq(hook.pending(), pending);

        // The same bot, asking for an amount that exists, trades and pays like anyone else.
        bot.swap(key, SwapParams(true, -0.01 ether, uint160(uint256(sqrtNow) * 995 / 1000)));
        assertEq(hook.pending() - pending, 0.0001 ether);
    }

    /// @dev With the ETH amount fixed, the fee is 1% of what was asked for. An order its own price
    ///      limit stops short has still paid on all of it: over-asking costs the asker.
    function test_hook_anOrderItsPriceLimitStopsShortPaysOnWhatItAskedFor() public onFork {
        _launch();
        DirectSwapper bot = new DirectSwapper(POOL_MANAGER);
        vm.deal(address(bot), 5 ether);
        uint160 sqrtNow = _sqrtPriceNow();

        // One ETH asked for, with a limit a tenth of a per cent away: only a sliver of it fills.
        int256 delta = bot.swap(_key(), SwapParams(true, -1 ether, uint160(uint256(sqrtNow) * 999 / 1000)));
        uint256 paid = 5 ether - address(bot).balance;
        assertEq(hook.pending(), 0.01 ether, "1% of the ETH asked for");
        assertEq(uint256(-(delta >> 128)), paid);
        assertLt(paid, 0.02 ether, "little of it filled");
        assertGt(paid, 0.01 ether, "and that little was paid for on top of the fee");
        assertGt(coin.balanceOf(address(bot)), 0);
    }

    /// @dev The fees are plain ETH. If the recipient could not be paid, collecting would fail, and
    ///      trading would not notice.
    function test_hook_aRecipientThatCannotBePaidStopsOnlyTheCollecting() public onFork {
        _launch();
        vm.etch(hookWallet, hex"fe");
        _buy(alice, 0.03 ether);
        assertGt(_sell(alice, coin.balanceOf(alice) / 2), 0);
        uint256 pending = hook.pending();
        assertGt(pending, 0.0003 ether);
        vm.expectRevert();
        hook.collect();
        assertEq(hook.pending(), pending, "the fees wait");

        vm.etch(hookWallet, "");
        assertEq(hook.collect(), pending);
        assertEq(hookWallet.balance, pending);
    }

    /// @dev Uniswap would open a pool with a hook address nothing lives at, and every swap in it
    ///      would then fail for good. The coin refuses to.
    function test_launch_aHookAddressWithNothingAtItIsRefused() public onFork {
        address nothing = address(uint160((uint256(0xdead) << 144) | hook.PERMISSIONS()));
        assertEq(nothing.code.length, 0);
        vm.prank(deployer);
        vm.expectRevert(LaunchCoin.BadParams.selector);
        coin.launch{value: flat}(
            FEE, 200, nothing, SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT
        );
        // No hook at all is a choice the launch allows.
        vm.prank(deployer);
        coin.launch{value: flat}(
            FEE, 200, address(0), SQRT_START, TICK_LOWER, TICK_UPPER, LIQUIDITY, soon, YEAR, lockOwner, LOCKER_CUT
        );
        assertGt(_buy(alice, 0.02 ether), 0);
    }

    /// @dev The hook has no way to stop a trade. A sell far larger than the pool has ETH for goes
    ///      as far as the pool can take it, and no further, exactly as it would with no hook.
    function test_hook_neverStopsASell() public onFork {
        _launch();
        _buy(alice, 0.03 ether);
        // The reserve holder sells five times what was ever bought: the pool runs dry at the launch
        // price and the rest of the coin stays where it was.
        uint256 coinBefore = coin.balanceOf(deployer);
        uint256 ethOut = _sell(deployer, 5 * coin.balanceOf(alice));
        assertGt(ethOut, 0, "it sold what the pool could pay for");
        assertLt(ethOut, 0.03 ether);
        assertLt(coinBefore - coin.balanceOf(deployer), 5 * coin.balanceOf(alice), "and kept the rest");

        // The pool is dry now: it has paid out every wei it held, and with nothing on the far side
        // of the launch price Uniswap itself has run the price to its end stop. Until somebody buys
        // there is nothing to sell into, and it is Uniswap's PoolManager that says so
        // (PriceLimitAlreadyExceeded), as it would for a pool with no hook at all. The hook has no
        // error of its own to give.
        uint256 alices = coin.balanceOf(alice);
        vm.expectPartialRevert(bytes4(0x7c9c6e8f));
        this.sellExternal(alice, alices);

        // The moment somebody buys again, a holder sells everything they hold, to the last unit.
        _buy(bob, 0.02 ether);
        assertGt(_sell(bob, coin.balanceOf(bob)), 0);
        assertEq(coin.balanceOf(bob), 0);
        assertGt(_sell(alice, alices / 4), 0, "and so can the holder who could not a moment ago");
    }

    function sellExternal(address who, uint256 amount) external returns (uint256) {
        return _sell(who, amount);
    }

    // --------------------------------------------------------------------------------------
    // The wallet limit on real swaps
    // --------------------------------------------------------------------------------------

    function test_limit_holdsOnBuysAndNeverOnSells() public onFork {
        _launch();
        uint256 got = _buy(alice, 0.03 ether);
        assertGt(got, 0);
        assertLe(coin.balanceOf(alice), MAX_WALLET);
        console2.log("0.03 ETH bought, in basis points of supply", got * 10_000 / SUPPLY);

        // A buy that would take her past the limit reverts as a whole.
        vm.expectRevert();
        this.buyExternal(alice, 0.08 ether);
        // The owner is not exempt.
        vm.expectRevert();
        this.buyExternal(deployer, 0.3 ether);

        // Plain transfers are held to it too.
        _buy(bob, 0.03 ether);
        uint256 bobs = coin.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(LaunchCoin.MaxWallet.selector);
        coin.transfer(alice, bobs);

        // Selling, which sends coin to the pool, always works.
        assertGt(_sell(bob, bobs / 2), 0);
    }

    function test_limit_removedForGoodThenTheOwnerCanLeave() public onFork {
        _launch();
        vm.prank(deployer);
        vm.expectRevert(LaunchCoin.LimitsStillOn.selector);
        coin.renounceOwnership();

        vm.prank(deployer);
        coin.removeLimits();
        assertGt(_buy(alice, 0.3 ether), MAX_WALLET, "a large buy works once the limit is off");

        vm.prank(deployer);
        coin.renounceOwnership();
        assertEq(coin.owner(), address(0));
        vm.prank(deployer);
        vm.expectRevert(LaunchCoin.NotOwner.selector);
        coin.removeLimits();
    }

    // --------------------------------------------------------------------------------------
    // The launch bundle
    // --------------------------------------------------------------------------------------

    /// @dev Fifteen wallets each take 1.95% of the supply straight after the launch: what that
    ///      costs and where it leaves the price. (The real bundle, with parking, is rehearsed with
    ///      the bundler: tools/launch-rehearsal.sh.)
    function test_bundle_fifteenWalletsJustUnderTheLimit() public onFork {
        _launch();
        uint256 each = SUPPLY * 195 / 10_000;
        uint256 total;
        for (uint256 i = 1; i <= 15; ++i) {
            address wallet = makeAddr(string.concat("launch coin fork bundle ", vm.toString(i)));
            uint256 paid = _buyExactly(wallet, each);
            total += paid;
            assertEq(coin.balanceOf(wallet), each);
            if (i == 1 || i == 15) console2.log("wallet", i, "paid (wei)", paid);
        }
        console2.log("15 wallets x 1.95% = 29.25% of supply cost (wei)", total);
        assertLt(total, 2 ether, "the bundle costs more than expected");

        // A sixteenth wallet can still buy, and one of the fifteen cannot take much more.
        assertGt(_buy(alice, 0.01 ether), 0);
        address first = makeAddr("launch coin fork bundle 1");
        vm.expectRevert();
        this.buyExternal(first, 0.1 ether);
    }
}
