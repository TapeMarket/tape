// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {Sweeper} from "../src/periphery/Sweeper.sol";
import {SweeperBase} from "../src/periphery/SweeperBase.sol";
import {PerpMath} from "../src/libraries/PerpMath.sol";

/// @dev Throws random sequences of everything a trader, a staker, an operator and a stranger can do
///      at the Exchange and the coin side, then checks that the books still balance. The test
///      contract is its own handler: only the `act_*` functions are fuzzed.
contract InvariantTest is Base {
    uint256 internal constant ACTORS = 5;
    /// @dev Coin handed to every actor at the start. They mine more by losing.
    uint256 internal constant COIN_EACH = 1_000e18;
    /// @dev How many actions into a run the house is left to be as thin as trading makes it.
    uint256 internal constant THIN_ACTIONS = 24;

    uint256[ACTORS] internal pks;
    address[ACTORS] internal actors;
    uint64[2] internal price;

    uint256 internal gDeposited;
    uint256 internal gWithdrawn;
    uint256 internal gDonated;
    uint256 internal gDevClaimed;
    uint256 internal gPushed;
    uint256 internal gSwept;
    uint256 internal gClaimed;
    /// @dev How many times Staking has rounded an amount down so far. Each one drops less than one
    ///      unit of USDC, so this bounds the dust it can be holding.
    uint256 internal gFloors;
    /// @dev Set by an action that saw something it must never see. A handler's own failed
    ///      assertion would only look like one more tolerated revert, so it is recorded instead.
    bool internal gSweepMisjudged;
    bool internal gSweepFailedOddly;
    bool internal gSweepLeftTheCapShort;
    bool internal gPushMovedTheExcess;

    uint256 public nActions;
    uint256 public nOpen;
    uint256 public nClose;
    uint256 public nBust;
    uint256 public nDirect;
    uint256 public nWin;
    uint256 public nQueueFunded;
    uint256 public peakQueued;
    uint256 public nPush;
    uint256 public nSweep;
    uint256 public nSweepWithOpen;
    uint256 public nSweepWithBill;
    uint256 public nSweepRefused;
    uint256 public nKeeperBust;
    uint256 public nFatten;
    uint256 public nStake;
    uint256 public nUnstake;
    uint256 public nStreamPaused;
    uint256 public nRewardClaim;

    function setUp() public override {
        super.setUp();
        _attachCoin();
        price[0] = _px(80_000);
        price[1] = _px(2_500);
        // A depth the actors' positions run past all the time, so the books are held to their
        // identities with size charged, not only at the reference price.
        vm.startPrank(admin);
        // The constant is a few hundred thousand.
        // forge-lint: disable-start(unsafe-typecast)
        ex.setDepth(btc, uint32(DEPTH));
        ex.setDepth(eth, uint32(DEPTH));
        // forge-lint: disable-end(unsafe-typecast)
        vm.stopPrank();

        for (uint256 i; i < ACTORS; ++i) {
            pks[i] = 0x1000 + i;
            actors[i] = vm.addr(pks[i]);
            coin.transfer(actors[i], COIN_EACH);
        }

        // One staker from the start, so pushed fees have somewhere to stream.
        vm.startPrank(actors[0]);
        coin.approve(address(staking), COIN_EACH);
        staking.stake(COIN_EACH);
        vm.stopPrank();

        bytes4[] memory selectors = new bytes4[](19);
        selectors[0] = this.act_deposit.selector;
        selectors[1] = this.act_withdraw.selector;
        selectors[2] = this.act_open.selector;
        selectors[3] = this.act_move.selector;
        selectors[4] = this.act_close.selector;
        selectors[5] = this.act_bust.selector;
        selectors[6] = this.act_harvest.selector;
        selectors[7] = this.act_donate.selector;
        selectors[8] = this.act_pushFees.selector;
        selectors[9] = this.act_claimDev.selector;
        selectors[10] = this.act_directClose.selector;
        selectors[11] = this.act_win.selector;
        selectors[12] = this.act_claimRewards.selector;
        selectors[13] = this.act_sweep.selector;
        selectors[14] = this.act_fatten.selector;
        selectors[15] = this.act_stake.selector;
        selectors[16] = this.act_unstake.selector;
        selectors[17] = this.act_wait.selector;
        selectors[18] = this.act_hedge.selector;
        targetContract(address(this));
        targetSelector(FuzzSelector({addr: address(this), selectors: selectors}));
    }

    /// @dev The sweeper hands back the Pyth fee it did not need.
    receive() external payable {}

    /// @dev The depth every market in this suite trades at, in whole dollars.
    uint256 internal constant DEPTH = 200_000;

    /// @dev A block passes before every action, so the staking stream accrues between them.
    modifier tick() {
        skip(12);
        ++nActions;
        _;
    }

    // --------------------------------------------------------------------------------------
    // Actions: trading and the house
    // --------------------------------------------------------------------------------------

    function act_deposit(uint8 who, uint64 amount) external tick {
        address actor = actors[who % ACTORS];
        uint256 value = bound(amount, 1e6, 50_000e6);
        _fund(actor, value);
        gDeposited += value;
    }

    function act_withdraw(uint8 who, uint64 amount) external tick {
        uint256 pk = pks[who % ACTORS];
        address actor = vm.addr(pk);
        uint256 balance = ex.balances(actor);
        if (balance == 0) return;
        uint256 value = bound(amount, 1, balance);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 60);
        bytes memory sig = _sign(
            pk,
            _digest(
                keccak256(
                    abi.encode(WITHDRAW_TYPEHASH, actor, actor, value, ex.withdrawNonces(actor), deadline)
                )
            )
        );
        vm.prank(operator);
        ex.withdrawBySig(actor, actor, value, deadline, sig);
        gWithdrawn += value;
    }

    function act_open(uint8 who, bool onEth, bool isLong, uint64 margin, uint16 leverage, bool useQueued)
        external
        tick
    {
        // Asked to spend queued winnings, pick somebody who has some, if anybody does.
        uint256 pk = useQueued ? _pickQueued(who) : pks[who % ACTORS];
        address actor = vm.addr(pk);
        if (ex.openIdsOf(actor).length >= 20) return;

        uint256 funds = ex.balances(actor) + (useQueued ? ex.queuedOf(actor) : 0);
        if (funds < MIN_MARGIN) {
            _fund(actor, 1_000e6);
            gDeposited += 1_000e6;
            funds += 1_000e6;
        }
        uint256 size = bound(margin, MIN_MARGIN, funds > 20_000e6 ? 20_000e6 : funds);
        uint256 maxLeverage = 10_000_000e6 / size;
        uint256 lev = bound(leverage, 1, maxLeverage > 1_000 ? 1_000 : maxLeverage);

        uint16 market = onEth ? eth : btc;
        // Bounded just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        Intents.OpenIntent memory it = _intent(actor, market, isLong, uint96(size), uint16(lev));
        it.useQueued = useQueued;
        bytes32 id = _submitOpen(pk, it, price[market]);
        ++nOpen;
        if (ex.getPosition(id).debtMargin != 0) ++nQueueFunded;
    }

    /// @dev A long and a short of the same size at the same price: the pair the sweep must not be
    ///      fooled by when one leg closes before the other.
    function act_hedge(uint8 who, bool onEth, uint64 margin, uint16 leverage) external tick {
        uint256 pk = pks[who % ACTORS];
        address actor = vm.addr(pk);
        if (ex.openIdsOf(actor).length >= 20) return;

        uint256 size = bound(margin, MIN_MARGIN, 5_000e6);
        if (ex.balances(actor) < 2 * size) {
            _fund(actor, 2 * size);
            gDeposited += 2 * size;
        }
        uint256 lev = bound(leverage, 1, 1_000);
        uint16 market = onEth ? eth : btc;
        // Bounded just above.
        // forge-lint: disable-start(unsafe-typecast)
        _open(pk, market, true, uint96(size), uint16(lev), price[market]);
        _open(pk, market, false, uint96(size), uint16(lev), price[market]);
        // forge-lint: disable-end(unsafe-typecast)
        nOpen += 2;
    }

    function act_move(bool onEth, int16 bps) external tick {
        _move(onEth, bps);
    }

    function act_close(uint8 who, uint8 which, int16 bps) external tick {
        (uint256 pk, bytes32 id) = _pick(who, which);
        if (id == bytes32(0)) return;
        _move(ex.getPosition(id).market == eth, bps);
        _close(pk, id, price[ex.getPosition(id).market]);
        ++nClose;
    }

    /// @dev Moves the market in a position's favour and closes it: this is what makes winners queue.
    function act_win(uint8 who, uint8 which, uint16 bps) external tick {
        (uint256 pk, bytes32 id) = _pick(who, which);
        if (id == bytes32(0)) return;
        Exchange.Position memory p = ex.getPosition(id);
        uint256 move = bound(bps, 1, 500);
        uint256 exit = p.isLong
            ? (uint256(p.entryPrice) * (10_000 + move)) / 10_000
            : (uint256(p.entryPrice) * (10_000 - move)) / 10_000;
        // A few percent either side of a bounded price.
        // forge-lint: disable-next-line(unsafe-typecast)
        _close(pk, id, uint64(exit));
        ++nWin;
        if (ex.totalQueued() > peakQueued) peakQueued = ex.totalQueued();
    }

    function act_bust(uint8 who, uint8 which) external tick {
        (, bytes32 id) = _pick(who, which);
        if (id == bytes32(0)) return;
        // A price, so it fits.
        // forge-lint: disable-next-line(unsafe-typecast)
        _liquidate(id, uint64(_bustOf(id)));
        ++nBust;
    }

    function act_directClose(uint8 who, uint8 which) external tick {
        (uint256 pk, bytes32 id) = _pick(who, which);
        if (id == bytes32(0)) return;
        Exchange.Position memory p = ex.getPosition(id);
        vm.prank(vm.addr(pk));
        ex.requestClose(id);
        uint64 pin = uint64(vm.getBlockTimestamp()) + ex.DIRECT_DELAY();
        // Sometimes the operator executes it at once, sometimes a stranger does after the wait.
        if (which % 2 == 0) {
            skip(36);
            vm.prank(operator);
        } else {
            skip(90);
        }
        ex.executeClose(id, _update(_feed(p.market), price[p.market], pin));
        ++nDirect;
    }

    function act_harvest(uint8 entries) external tick {
        ex.harvest(entries % 12);
    }

    function act_donate(uint64 amount) external tick {
        // Small, so the house stays thin and winners really do queue.
        uint256 value = bound(amount, 1, 20e6);
        _seedHouse(value);
        gDonated += value;
    }

    /// @dev Brings the house up to its cap and a little over, so that sweeps have something to work
    ///      on. Never early in a run: a thin house is what makes winners queue, and every run
    ///      should see that first.
    function act_fatten(uint64 extra) external tick {
        if (nActions <= THIN_ACTIONS) return;
        uint256 target = STAKER_CAP + ex.debtMarginOpen() + ex.totalQueued() + bound(extra, 1, 100_000e6);
        uint256 cash = ex.lpCash();
        if (cash >= target) return;
        _seedHouse(target - cash);
        gDonated += target - cash;
        ex.harvest(64);
        ++nFatten;
    }

    function act_claimDev() external tick {
        if (ex.devFees() == 0) return;
        gDevClaimed += ex.claimDevFees();
    }

    // --------------------------------------------------------------------------------------
    // Actions: what reaches stakers, and the stakers
    // --------------------------------------------------------------------------------------

    /// @dev A push sends the accrued fee share to staking and must leave cash above the cap alone.
    function act_pushFees() external tick {
        if (ex.stakerFees() == 0) return;
        uint256 excess = ex.lpExcess();
        // Landing on a running stream, it re-bases what is left of it: one rounding.
        if (staking.totalStaked() != 0) ++gFloors;
        gPushed += ex.pushStakerFees();
        if (ex.lpExcess() != excess) gPushMovedTheExcess = true;
        ++nPush;
    }

    /// @dev Anyone sweeps, at the current prices, which have usually moved since the book was
    ///      built. The keeper goes first, as it does in life: every position at or past its trigger
    ///      at those prices is liquidated before the book is marked. The sweep then either takes
    ///      everything above the cap except what it has to hold back, or refuses because that
    ///      leaves nothing.
    function act_sweep(bool onEth, int16 bps) external tick {
        _move(onEth, bps);
        _keeperLiquidates();
        uint256 heldBack = _heldBackAt(price[0], price[1]);
        bool staked = staking.totalStaked() != 0;
        try this.sweepNow() returns (uint256 amount) {
            gSwept += amount;
            if (staked) ++gFloors;
            ++nSweep;
            if (heldBack != 0) ++nSweepWithOpen;
            if (amount == 0 || ex.lpExcess() != heldBack || ex.totalQueued() != 0) gSweepMisjudged = true;
            // With nothing left past its trigger, what stays above the cap covers the bill
            // position by position.
            uint256 bill = _billAt(price[0], price[1]);
            if (bill != 0) ++nSweepWithBill;
            if (ex.lpExcess() < bill) gSweepLeftTheCapShort = true;
        } catch (bytes memory reason) {
            ++nSweepRefused;
            // Exactly four bytes long, or the first test has already failed.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (reason.length != 4 || bytes4(reason) != SweeperBase.NothingToSweep.selector) {
                gSweepFailedOddly = true;
            } else if (ex.lpExcess() > heldBack) {
                gSweepMisjudged = true;
            }
        }
    }

    /// @dev External only so that `act_sweep` can catch a refusal. Not a fuzzed action.
    function sweepNow() external returns (uint256) {
        require(msg.sender == address(this), "handler only");
        return _sweep(price[0], price[1]);
    }

    function act_stake(uint8 who, uint256 amount) external tick {
        address actor = actors[who % ACTORS];
        uint256 wallet = coin.balanceOf(actor);
        if (wallet == 0) return;
        uint256 value = bound(amount, 1, wallet);
        vm.startPrank(actor);
        coin.approve(address(staking), value);
        staking.stake(value);
        vm.stopPrank();
        // Books what the staker has earned so far: one rounding.
        ++gFloors;
        ++nStake;
    }

    function act_unstake(uint8 who, uint256 amount, bool all) external tick {
        address actor = _pickStaker(who);
        if (actor == address(0)) return;
        uint256 held = staking.staked(actor);
        uint256 value = all ? held : bound(amount, 1, held);
        vm.prank(actor);
        staking.unstake(value);
        // Books what they earned, and if they were the last one out, puts the rest of the stream
        // aside: two roundings at most.
        gFloors += 2;
        ++nUnstake;
        if (staking.totalStaked() == 0) ++nStreamPaused;
    }

    /// @dev A staker's claim comes back into the Exchange as their trading balance.
    function act_claimRewards(uint8 who) external tick {
        address actor = _pickEarner(who);
        if (actor == address(0)) return;
        vm.prank(actor);
        uint256 claimed = staking.claim();
        gClaimed += claimed;
        gDeposited += claimed;
        // Books what they earned up to now: one rounding.
        ++gFloors;
        ++nRewardClaim;
    }

    /// @dev Lets anything from a minute to a day and a half go by: streams run on, run out, and
    ///      sit waiting.
    function act_wait(uint32 time) external {
        skip(bound(time, 60, 36 hours));
    }

    // --------------------------------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------------------------------

    function _move(bool onEth, int16 bps) internal {
        uint256 i = onEth ? 1 : 0;
        int256 move = bound(int256(bps), -300, 300);
        int256 next = int256(uint256(price[i])) * (10_000 + move) / 10_000;
        if (next < int256(uint256(_px(100))) || next > int256(uint256(_px(1_000_000)))) return;
        // Bounded just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        price[i] = uint64(uint256(next));
    }

    function _pick(uint8 who, uint8 which) internal view returns (uint256 pk, bytes32 id) {
        for (uint256 i; i < ACTORS; ++i) {
            pk = pks[(uint256(who) + i) % ACTORS];
            bytes32[] memory ids = ex.openIdsOf(vm.addr(pk));
            if (ids.length != 0) return (pk, ids[which % ids.length]);
        }
        return (0, bytes32(0));
    }

    function _pickQueued(uint8 who) internal view returns (uint256 pk) {
        for (uint256 i; i < ACTORS; ++i) {
            pk = pks[(uint256(who) + i) % ACTORS];
            if (ex.queuedOf(vm.addr(pk)) != 0) return pk;
        }
        return pks[who % ACTORS];
    }

    function _pickEarner(uint8 who) internal view returns (address) {
        for (uint256 i; i < ACTORS; ++i) {
            address actor = actors[(uint256(who) + i) % ACTORS];
            if (staking.pendingReward(actor) != 0) return actor;
        }
        return address(0);
    }

    function _pickStaker(uint8 who) internal view returns (address) {
        for (uint256 i; i < ACTORS; ++i) {
            address actor = actors[(uint256(who) + i) % ACTORS];
            if (staking.staked(actor) != 0) return actor;
        }
        return address(0);
    }

    /// @dev Each side's size (in units of the asset, 1e18) and open interest, market by market,
    ///      added up from the open positions themselves and not from the Exchange's running totals.
    function _book()
        internal
        view
        returns (
            uint256[2] memory sizeLong,
            uint256[2] memory sizeShort,
            uint256[2] memory oiLong,
            uint256[2] memory oiShort
        )
    {
        for (uint256 i; i < ACTORS; ++i) {
            bytes32[] memory ids = ex.openIdsOf(actors[i]);
            for (uint256 j; j < ids.length; ++j) {
                Exchange.Position memory p = ex.getPosition(ids[j]);
                uint256 notional = uint256(p.margin) * p.leverage;
                uint256 size = Math.mulDiv(notional, 1e18, p.entryPrice);
                if (p.isLong) {
                    sizeLong[p.market] += size;
                    oiLong[p.market] += notional;
                } else {
                    sizeShort[p.market] += size;
                    oiShort[p.market] += notional;
                }
            }
        }
    }

    /// @dev What a sweep has to leave above the cap at these prices: what the open positions, side
    ///      by side and market by market, are up, and the sweeper's margin on everything open.
    function _heldBackAt(uint64 btcPrice, uint64 ethPrice) internal view returns (uint256 held) {
        (
            uint256[2] memory sizeLong,
            uint256[2] memory sizeShort,
            uint256[2] memory oiLong,
            uint256[2] memory oiShort
        ) = _book();
        uint256 marginBps = sweeper.MARGIN_BPS();
        for (uint256 m; m < 2; ++m) {
            uint256 at = m == btc ? btcPrice : ethPrice;
            // Rounded against the sweep on both sides.
            uint256 longsWorth = Math.mulDiv(sizeLong[m], at, 1e18, Math.Rounding.Ceil);
            uint256 shortsWorth = Math.mulDiv(sizeShort[m], at, 1e18);
            if (longsWorth > oiLong[m]) held += longsWorth - oiLong[m];
            if (oiShort[m] > shortsWorth) held += oiShort[m] - shortsWorth;
            // The margin, rounded against the sweep too. It is nothing where nothing is open.
            held += Math.mulDiv(oiLong[m] + oiShort[m], marginBps, 10_000, Math.Rounding.Ceil);
        }
    }

    /// @dev The house's bill if every open position closed at these prices, worked out position
    ///      by position: what the winners would be paid, their win fee with it, less what the
    ///      losers would bring in after the fee carved from a loss. Zero if the losers bring in
    ///      more. Unlike the sweeper's mark, a loser counts for no more than its margin.
    function _billAt(uint64 btcPrice, uint64 ethPrice) internal view returns (uint256) {
        uint256 pays;
        uint256 collects;
        for (uint256 i; i < ACTORS; ++i) {
            bytes32[] memory ids = ex.openIdsOf(actors[i]);
            for (uint256 j; j < ids.length; ++j) {
                Exchange.Position memory p = ex.getPosition(ids[j]);
                (bool win, uint256 amount) = _settleOf(p, p.market == btc ? btcPrice : ethPrice);
                if (win) {
                    pays += amount;
                } else {
                    uint256 loss = amount < p.margin ? amount : p.margin;
                    collects += loss - (loss * 200) / 10_000;
                }
            }
        }
        return pays > collects ? pays - collects : 0;
    }

    /// @dev What the keeper does: liquidates every open position that is at or past its trigger
    ///      at the current prices.
    function _keeperLiquidates() internal {
        for (uint256 i; i < ACTORS; ++i) {
            // A copy: liquidating reorders the list it was read from.
            bytes32[] memory ids = ex.openIdsOf(actors[i]);
            for (uint256 j; j < ids.length; ++j) {
                Exchange.Position memory p = ex.getPosition(ids[j]);
                uint64 at = price[p.market];
                uint256 trigger = _bustOf(ids[j]);
                if (p.isLong ? at <= trigger : at >= trigger) {
                    _liquidate(ids[j], at);
                    ++nKeeperBust;
                }
            }
        }
    }

    // --------------------------------------------------------------------------------------
    // Invariants: the Exchange
    // --------------------------------------------------------------------------------------

    /// @dev The Exchange always holds the USDC it accounts for, and its books never go negative.
    function invariant_solvent() public view {
        _assertSolvent();
        // Would revert on underflow if liabilities ever exceeded the treasury.
        ex.lpCash();
    }

    /// @dev Every dollar in or out is accounted for.
    function invariant_treasuryMatchesFlows() public view {
        assertEq(ex.treasury(), gDeposited + gDonated - gWithdrawn - gDevClaimed - gPushed - gSwept);
    }

    function invariant_balancesSum() public view {
        uint256 sum;
        for (uint256 i; i < ACTORS; ++i) {
            sum += ex.balances(actors[i]);
        }
        assertEq(sum, ex.totalBalances());
    }

    /// @dev Open positions account for all locked margin, all open interest and all open size.
    function invariant_positionsMatchTotals() public view {
        uint256 cash;
        uint256 debt;
        for (uint256 i; i < ACTORS; ++i) {
            bytes32[] memory ids = ex.openIdsOf(actors[i]);
            for (uint256 j; j < ids.length; ++j) {
                Exchange.Position memory p = ex.getPosition(ids[j]);
                assertEq(p.owner, actors[i]);
                assertEq(p.index, j);
                assertLe(p.debtMargin, p.margin);
                cash += p.margin - p.debtMargin;
                debt += p.debtMargin;
            }
        }
        assertEq(cash, ex.totalCashMargin());
        assertEq(debt, ex.debtMarginOpen());

        (
            uint256[2] memory sizeLong,
            uint256[2] memory sizeShort,
            uint256[2] memory oiLong,
            uint256[2] memory oiShort
        ) = _book();
        for (uint16 m; m < 2; ++m) {
            Exchange.Market memory market = ex.getMarket(m);
            assertEq(market.oiLong, oiLong[m]);
            assertEq(market.oiShort, oiShort[m]);
            assertEq(market.sizeLong, sizeLong[m]);
            assertEq(market.sizeShort, sizeShort[m]);
        }
    }

    /// @dev The size charge follows the side. Whatever the actors did (opens, closes, busts and
    ///      direct closes, on either side of either market), a position that is still open is
    ///      charged on at least what it would be if the positions still open on its side had
    ///      opened, in the same order, on an empty side. So no sequence of trades leaves size on
    ///      a side that is charged as if less were there.
    function invariant_noOpenPositionIsChargedLessThanItsPlaceInTheStack() public view {
        for (uint16 m; m < 2; ++m) {
            _checkStack(m, true);
            _checkStack(m, false);
        }
    }

    function _checkStack(uint16 market, bool isLong) private view {
        uint256 total;
        for (uint256 i; i < ACTORS; ++i) {
            total += ex.openIdsOf(actors[i]).length;
        }
        Exchange.Position[] memory side = new Exchange.Position[](total);
        uint256 n;
        for (uint256 i; i < ACTORS; ++i) {
            bytes32[] memory ids = ex.openIdsOf(actors[i]);
            for (uint256 j; j < ids.length; ++j) {
                Exchange.Position memory p = ex.getPosition(ids[j]);
                if (p.market != market || p.isLong != isLong) continue;
                // Kept in the order they opened: every open here is a block apart from the last.
                uint256 at = n++;
                while (at != 0 && side[at - 1].openTime > p.openTime) {
                    side[at] = side[at - 1];
                    --at;
                }
                side[at] = p;
            }
        }

        uint256 ahead;
        for (uint256 k; k < n; ++k) {
            uint256 notional = uint256(side[k].margin) * side[k].leverage;
            assertGe(
                side[k].impactNotional,
                PerpMath.impactNotionalFor(ahead, notional, DEPTH),
                "a position is charged on less than its place among the survivors"
            );
            ahead += notional;
        }
        Exchange.Market memory m = ex.getMarket(market);
        assertEq(ahead, isLong ? m.oiLong : m.oiShort, "open interest is not the survivors' notional");
    }

    /// @dev A side with nothing open has no size left on it: opening and closing the same position
    ///      add and remove exactly the same amount, so no rounding residue can build up and be
    ///      marked as if it were a position.
    function invariant_anEmptySideHasNoSize() public view {
        for (uint16 m; m < 2; ++m) {
            Exchange.Market memory market = ex.getMarket(m);
            if (market.oiLong == 0) assertEq(market.sizeLong, 0, "long size without open interest");
            if (market.oiShort == 0) assertEq(market.sizeShort, 0, "short size without open interest");
        }
    }

    /// @dev The queue adds up: per trader and in total, claims minus spent payout is what is owed.
    function invariant_queueAddsUp() public view {
        uint256[ACTORS] memory gross;
        uint256 grossTotal;
        for (uint256 id = ex.queueHead(); id < ex.queueTail(); ++id) {
            (address user, uint96 amount) = ex.claims(id);
            grossTotal += amount;
            for (uint256 i; i < ACTORS; ++i) {
                if (actors[i] == user) gross[i] += amount;
            }
        }
        uint256 owedTotal;
        uint256 spentTotal;
        for (uint256 i; i < ACTORS; ++i) {
            uint256 spent = ex.queueSpent(actors[i]);
            assertEq(gross[i] - spent, ex.queuedOf(actors[i]));
            owedTotal += ex.queuedOf(actors[i]);
            spentTotal += spent;
        }
        assertEq(owedTotal, ex.totalQueued());
        assertEq(grossTotal - spentTotal, ex.totalQueued());
    }

    /// @dev Staker excess never dips into what the house owes.
    function invariant_excessLeavesTheCap() public view {
        uint256 excess = ex.lpExcess();
        if (excess != 0) {
            assertEq(ex.totalQueued(), 0);
            assertEq(ex.lpCash() - excess, ex.debtMarginOpen() + STAKER_CAP);
        }
    }

    /// @dev A push never touches cash above the cap. A sweep leaves above it exactly what it is
    ///      meant to hold back at the prices it was given: what each side of each market is up, and
    ///      the margin on everything open. It refuses only when that is everything.
    function invariant_pushesAndSweepsKeepToTheirOwn() public view {
        assertFalse(gPushMovedTheExcess, "a fee push moved cash above the cap");
        assertFalse(gSweepMisjudged, "a sweep took, or refused, the wrong amount");
        assertFalse(gSweepFailedOddly, "a sweep failed for a reason other than having nothing to sweep");
    }

    /// @dev After a sweep the house could pay every open position, closed at the prices the sweep
    ///      was given, without going below its cap.
    ///
    ///      This holds only because the handler, like the keeper, liquidates whatever is at or past
    ///      its trigger before it sweeps. It is not a property of the Sweeper alone: a side is
    ///      marked as a whole, so a position left open past the price where its margin is gone
    ///      hides another's gain, and the margin covers that only up to `MARGIN_BPS` of everything
    ///      open. `test_sweep_knownResidual_aLoserFarPastEmptyStillLeavesTheCapShort` in
    ///      House.t.sol is the book where it does not.
    function invariant_aSweepLeavesEnoughForEveryOpenPosition() public view {
        assertFalse(
            gSweepLeftTheCapShort, "a sweep left less above the cap than open positions would be paid"
        );
    }

    // --------------------------------------------------------------------------------------
    // Invariants: the coin side
    // --------------------------------------------------------------------------------------

    /// @dev Mining only ever pays out of its reserve, and every staked coin is in the staking
    ///      contract.
    function invariant_coinSideIsBacked() public view {
        assertEq(mining.reserve() + mining.totalMined(), RESERVE);

        uint256 stakes;
        uint256 wallets;
        for (uint256 i; i < ACTORS; ++i) {
            stakes += staking.staked(actors[i]);
            wallets += coin.balanceOf(actors[i]);
        }
        assertEq(stakes, staking.totalStaked());
        assertEq(coin.balanceOf(address(staking)), staking.totalStaked());
        assertEq(wallets + stakes, ACTORS * COIN_EACH + mining.totalMined());
    }

    /// @dev Staking can always pay what it has promised: what each staker could claim now, what is
    ///      waiting for a first staker, and what the running stream has still to pay out.
    function invariant_stakingCoversWhatItOwes() public view {
        uint256 promised = staking.waiting() + staking.unstreamed();
        for (uint256 i; i < ACTORS; ++i) {
            promised += staking.pendingReward(actors[i]);
        }
        uint256 held = usdc.balanceOf(address(staking));

        // Every dollar it was sent and every dollar it paid went through the Exchange.
        assertEq(staking.totalReceived(), gPushed + gSwept);
        assertEq(staking.totalClaimed(), gClaimed);
        assertEq(held, gPushed + gSwept - gClaimed);

        assertLe(promised, held, "staking has promised more USDC than it holds");
        assertLe(staking.totalClaimed() + promised, staking.totalReceived(), "promised more than it received");

        // What is neither paid nor promised is rounding dust and nothing else. Staking rounds
        // down every amount it books, each time by less than one unit: `gFloors` counts those
        // so far, and reading the figures above rounds once per staker and once for the stream.
        // (The rate's own truncation is under 1e-13 of a unit per stream: it cannot add one.)
        assertLe(
            staking.totalReceived() - staking.totalClaimed() - promised,
            gFloors + ACTORS + 1,
            "more than rounding dust is unaccounted for"
        );
    }

    /// @dev The stream runs only while somebody is staked, and never for longer than a day ahead.
    function invariant_theStreamRunsOnlyForStakers() public view {
        assertLe(staking.lastUpdate(), staking.periodFinish());
        assertLe(staking.periodFinish(), vm.getBlockTimestamp() + staking.PERIOD());
        if (staking.totalStaked() == 0) {
            assertEq(staking.rewardRate(), 0, "a stream is running with nobody staked");
            assertEq(staking.unstreamed(), 0);
        } else {
            assertEq(staking.waiting(), 0, "USDC is waiting although somebody is staked");
        }
    }

    // --------------------------------------------------------------------------------------
    // The keeper's step, shown once by hand
    // --------------------------------------------------------------------------------------

    /// @dev Not an invariant. Shows that the check behind
    ///      `invariant_aSweepLeavesEnoughForEveryOpenPosition` can fail, and that it is the keeper's
    ///      step that makes it hold. The book is the known residual of House.t.sol: a $100,000 long
    ///      from 80,000 that is up, and a $160,000 long at 1000x from 82,000 that is far past the
    ///      price where its $160 of margin was gone, marked at 81,200.
    function test_theBillCheckFailsOnTheKnownResidualUnlessTheKeeperGoesFirst() public {
        _fund(actors[1], 1_000e6);
        _fund(actors[2], 160e6);
        _seedHouse(STAKER_CAP + 2_000e6);
        _open(pks[1], btc, true, 1_000e6, 100, _px(80_000));
        bytes32 loser = _open(pks[2], btc, true, 160e6, 1_000, _px(82_000));
        price[0] = _px(81_200);
        uint256 before = vm.snapshotState();

        // Swept with the loser still open: the longs together are down, so only the $520 margin
        // stays, against a bill of $1,331.36 for the winner less the $156.80 the loser can bring.
        assertEq(this.sweepNow(), 1_480e6);
        assertEq(ex.lpExcess(), 520e6);
        assertEq(_billAt(price[0], price[1]), 1_174_564_495);

        // The keeper first: the loser is gone and its margin is the house's. Now the winner is
        // marked on its own, $1,500 up with $200 of margin, and that covers its $1,331.36.
        vm.revertToState(before);
        _keeperLiquidates();
        assertEq(ex.getPosition(loser).owner, address(0));
        assertEq(this.sweepNow(), 456.8e6);
        assertEq(ex.lpExcess(), 1_700e6);
        assertEq(_billAt(price[0], price[1]), 1_331_364_495);
    }

    /// @dev Not an invariant: shows (with -vv) that the run above actually traded.
    function afterInvariant() public view {
        console2.log("opens", nOpen, "closes", nClose);
        console2.log("forced wins", nWin, "opens funded from the queue", nQueueFunded);
        console2.log("peak queued", peakQueued);
        console2.log("busts", nBust, "direct closes", nDirect);
        console2.log("queued", ex.totalQueued(), "house cash", ex.lpCash());
        console2.log(
            "queue entries", ex.queueTail() - ex.queueHead(), "spent margin open", ex.debtMarginOpen()
        );
        console2.log("house brought to its cap", nFatten, "fee pushes", nPush);
        console2.log("sweeps", nSweep, "of which with positions open", nSweepWithOpen);
        console2.log("of which with a bill to cover", nSweepWithBill, "keeper liquidations", nKeeperBust);
        console2.log("sweeps refused", nSweepRefused, "swept in total", gSwept);
        console2.log("stakes", nStake, "unstakes", nUnstake);
        console2.log("stream paused", nStreamPaused, "reward claims", nRewardClaim);
        console2.log("staking received", staking.totalReceived(), "claimed", staking.totalClaimed());
        console2.log("staking roundings", gFloors, "dust held", _stakingDust());
    }

    function _stakingDust() internal view returns (uint256) {
        uint256 promised = staking.waiting() + staking.unstreamed();
        for (uint256 i; i < ACTORS; ++i) {
            promised += staking.pendingReward(actors[i]);
        }
        return staking.totalReceived() - staking.totalClaimed() - promised;
    }
}
