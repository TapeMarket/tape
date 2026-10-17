// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {Coin} from "../src/Coin.sol";
import {Staking} from "../src/Staking.sol";
import {LossMining} from "../src/LossMining.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {Lens} from "../src/periphery/Lens.sol";
import {Batcher} from "../src/periphery/Batcher.sol";
import {Sweeper} from "../src/periphery/Sweeper.sol";
import {SweeperBase} from "../src/periphery/SweeperBase.sol";
import {MockLossMining, MockPyth} from "./mocks/Mocks.sol";

/// @dev The recording hook, standing in for any of the three contracts `attachCoin` takes: it
///      answers each of the Exchange's role probes with the Exchange it was built for.
contract AttachableMock is MockLossMining {
    address public immutable exchange;

    constructor(address exchange_) {
        exchange = exchange_;
    }

    function stakingFor() external view returns (address) {
        return exchange;
    }

    function lossMiningFor() external view returns (address) {
        return exchange;
    }

    function sweeperFor() external view returns (address) {
        return exchange;
    }
}

/// @dev The house: the payout queue, trading on queued winnings, the operator-free exit, fees, the
///      marked-to-market sweep and the hooks the coin plugs into.
contract HouseTest is Base {
    uint64 internal P0;
    /// @dev Profit of the standard winner: $100 at 100x long, +1%.
    uint256 internal WIN;
    uint256 internal WIN_FEE;

    function setUp() public override {
        super.setUp();
        P0 = _px(80_000);
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        _fund(carol, 1_000e6);
        (, uint256 gain) = _btcSettle(P0, _px(80_800), 10_000e6, true);
        WIN_FEE = (gain * 200) / 10_000;
        WIN = gain - WIN_FEE;
    }

    /// @dev The sweeper hands back the Pyth fee it did not need.
    receive() external payable {}

    /// @dev Opens the standard winner for `pk` and closes it +1%.
    function _win(uint256 pk) internal {
        bytes32 id = _open(pk, btc, true, 100e6, 100, P0);
        _close(pk, id, _px(80_800));
    }

    /// @dev Busts `margin` of `pk`'s cash at 1000x.
    function _bust(uint256 pk, uint96 margin) internal {
        bytes32 id = _open(pk, btc, true, margin, 1_000, P0);
        _liquidate(id, _px(79_900));
    }

    // --------------------------------------------------------------------------------------
    // The queue
    // --------------------------------------------------------------------------------------

    function test_queue_paysFirstInFirstOut() public {
        _win(bobPk);
        _win(carolPk);
        assertEq(ex.totalQueued(), 2 * WIN);
        assertEq(ex.queueTail() - ex.queueHead(), 2);

        _bust(alicePk, 120e6);

        assertEq(ex.queuedOf(bob), 0, "the first winner is paid in full first");
        assertEq(ex.balances(bob), 1_000e6 + WIN);
        assertEq(ex.queuedOf(carol), 2 * WIN - 120e6, "the second gets what is left");
        assertEq(ex.balances(carol), 1_000e6 + 120e6 - WIN);
        assertEq(ex.queueHead(), 1);
        assertEq(ex.lpCash(), 0);
        assertEq(ex.stakerFees() + ex.devFees(), 0);
        _assertSolvent();
    }

    function test_queue_aNewWinnerWaitsBehindEvenIfCashArrives() public {
        _win(bobPk);
        // Cash lands, but not through a loss: nothing has harvested yet.
        usdc.mint(address(this), 10e6);
        usdc.approve(address(ex), 10e6);
        _win(carolPk);
        assertEq(ex.queuedOf(carol), WIN, "queued behind bob, not paid past him");
        assertEq(ex.balances(carol), 1_000e6);
    }

    function test_queue_extendsTheTailClaimOfTheSameTrader() public {
        _win(bobPk);
        _win(bobPk);
        assertEq(ex.queueTail() - ex.queueHead(), 1);
        (address user, uint96 amount) = ex.claims(0);
        assertEq(user, bob);
        assertEq(amount, 2 * WIN);

        _win(carolPk);
        _win(bobPk);
        assertEq(ex.queueTail() - ex.queueHead(), 3, "bob's next win goes to the back");
    }

    function test_harvest_isPublicAndPaysWhatItCan() public {
        _win(bobPk);
        _win(carolPk);

        usdc.mint(address(this), 100e6);
        usdc.approve(address(ex), 100e6);
        ex.donate(100e6);

        assertEq(ex.balances(bob), 1_000e6 + WIN);
        assertEq(ex.balances(carol), 1_000e6 + 100e6 - WIN);
        assertEq(ex.lpCash(), 0);

        vm.prank(stranger);
        ex.harvest(10);
        assertEq(ex.queuedOf(carol), 2 * WIN - 100e6, "nothing more to pay with");
    }

    function test_harvest_respectsItsEntryLimit() public {
        _win(bobPk);
        _win(carolPk);
        _win(alicePk);
        // Seed directly so that no automatic harvest runs.
        usdc.mint(address(ex), 1_000e6);
        vm.store(address(ex), bytes32(uint256(_treasurySlot())), bytes32(ex.treasury() + 1_000e6));

        ex.harvest(1);
        assertEq(ex.queuedOf(bob), 0);
        assertEq(ex.queuedOf(carol), WIN);
        ex.harvest(5);
        assertEq(ex.totalQueued(), 0);
        assertEq(ex.queueHead(), ex.queueTail());
        _assertSolvent();
    }

    /// @dev Finds `treasury`'s storage slot by probing, so the test does not hard-code the layout.
    function _treasurySlot() internal returns (uint256 slot) {
        uint256 expected = ex.treasury();
        for (slot = 0; slot < 40; ++slot) {
            if (uint256(vm.load(address(ex), bytes32(slot))) != expected) continue;
            bytes32 saved = vm.load(address(ex), bytes32(slot));
            vm.store(address(ex), bytes32(slot), bytes32(expected + 1));
            bool hit = ex.treasury() == expected + 1;
            vm.store(address(ex), bytes32(slot), saved);
            if (hit) return slot;
        }
        revert("treasury slot not found");
    }

    function test_donate_isAGiftToTheHouse() public {
        _seedHouse(500e6);
        assertEq(ex.lpCash(), 500e6);
        assertEq(ex.balances(address(this)), 0);
        vm.expectRevert(Exchange.ZeroAmount.selector);
        ex.donate(0);
    }

    // --------------------------------------------------------------------------------------
    // Trading on queued winnings
    // --------------------------------------------------------------------------------------

    function test_queued_canBeSpentAsMargin() public {
        _win(bobPk);
        bytes32 id = _openQueued(bobPk, btc, true, 50e6, 100, P0);

        Exchange.Position memory p = ex.getPosition(id);
        assertEq(p.margin, 50e6);
        assertEq(p.debtMargin, 50e6);
        assertEq(ex.balances(bob), 1_000e6, "no cash was used");
        assertEq(ex.queuedOf(bob), WIN - 50e6);
        assertEq(ex.totalQueued(), WIN - 50e6);
        assertEq(ex.debtMarginOpen(), 50e6);
        assertEq(ex.totalCashMargin(), 0);
        assertEq(lens.house().equity, -int256(WIN));
        _assertSolvent();
    }

    function test_queued_winIsOwedMarginPlusProfit() public {
        _win(bobPk);
        bytes32 id = _openQueued(bobPk, btc, true, 50e6, 100, P0);
        _close(bobPk, id, _px(80_800));

        (, uint256 gain) = _btcSettle(P0, _px(80_800), 5_000e6, true);
        uint256 profit = gain - (gain * 200) / 10_000;
        assertEq(ex.queuedOf(bob), WIN + profit);
        assertEq(ex.debtMarginOpen(), 0);
        assertEq(ex.balances(bob), 1_000e6);
        _assertSolvent();
    }

    function test_queued_lossJustShrinksTheDebt() public {
        _win(bobPk);
        bytes32 id = _openQueued(bobPk, btc, true, 50e6, 100, P0);
        _close(bobPk, id, _px(79_600));

        assertEq(ex.queuedOf(bob), WIN - 25e6, "0.5% of 5,000 is no longer owed");
        assertEq(ex.totalQueued(), WIN - 25e6);
        assertEq(ex.debtMarginOpen(), 0);
        assertEq(ex.lpCash(), 0, "no cash moved");
        assertEq(ex.stakerFees() + ex.devFees(), 0);
        _assertSolvent();
    }

    function test_queued_bustWipesTheClaim() public {
        _win(bobPk);
        bytes32 id = _openQueued(bobPk, btc, true, 50e6, 1_000, P0);
        _liquidate(id, _px(79_900));

        assertEq(ex.queuedOf(bob), WIN - 50e6);
        assertEq(ex.debtMarginOpen(), 0);
        assertEq(ex.balances(bob), 1_000e6);
        assertEq(ex.lpCash(), 0);
        _assertSolvent();
    }

    /// @dev Spent payout is netted off the trader's oldest claims when the queue reaches them.
    function test_queued_spentAmountIsNettedWhenTheQueueReachesIt() public {
        _win(carolPk);
        _win(bobPk);
        bytes32 id = _openQueued(bobPk, btc, true, 50e6, 1_000, P0);
        _liquidate(id, _px(79_900));
        assertEq(ex.queueSpent(bob), 50e6, "carol is still ahead: bob's claim has not been reached");
        (, uint96 gross) = ex.claims(1);
        assertEq(gross, WIN);

        _seedHouse(1_000e6);
        assertEq(ex.balances(carol), 1_000e6 + WIN);
        assertEq(ex.balances(bob), 1_000e6 + WIN - 50e6, "paid only what he is still owed");
        assertEq(ex.queueSpent(bob), 0);
        assertEq(ex.totalQueued(), 0);
        assertEq(ex.queueHead(), ex.queueTail());
        assertEq(ex.lpCash(), 1_000e6 - WIN - (WIN - 50e6));
        _assertSolvent();
    }

    function test_queued_aSpentClaimAtTheFrontIsClearedWithoutCash() public {
        _win(bobPk);
        bytes32 id = _openQueued(bobPk, btc, true, 50e6, 1_000, P0);
        _liquidate(id, _px(79_900));
        // The bust ran a harvest. With no cash it could still net the spent part off the front.
        assertEq(ex.queueSpent(bob), 0);
        (, uint96 left) = ex.claims(0);
        assertEq(left, WIN - 50e6);
        assertEq(ex.queuedOf(bob), WIN - 50e6);
    }

    function test_queued_fullySpentClaimNoLongerBlocksNewWinners() public {
        _win(bobPk);
        bytes32 id = _openQueued(bobPk, btc, true, uint96(WIN), 1_000, P0);
        _liquidate(id, _px(79_900));
        assertEq(ex.totalQueued(), 0, "nothing is owed any more");

        // A stale claim still sits at the head, but with nothing owed the house pays directly.
        _seedHouse(500e6);
        _win(carolPk);
        assertEq(ex.balances(carol), 1_000e6 + WIN);
        assertEq(ex.queuedOf(carol), 0);
    }

    function test_queued_fallsBackToCashForTheShortfall() public {
        _win(bobPk);
        uint96 margin = uint96(WIN + 20e6);
        bytes32 id = _openQueued(bobPk, btc, true, margin, 100, P0);

        Exchange.Position memory p = ex.getPosition(id);
        assertEq(p.debtMargin, WIN);
        assertEq(ex.balances(bob), 980e6);
        assertEq(ex.totalCashMargin(), 20e6);
        assertEq(ex.debtMarginOpen(), WIN);
        assertEq(ex.totalQueued(), 0);

        // -0.5%: the loss is split pro rata between the two kinds of margin.
        _close(bobPk, id, _px(79_600));
        (, uint256 loss) = _btcSettle(P0, _px(79_600), uint256(margin) * 100, true);
        uint256 lossDebt = (loss * WIN) / margin;
        uint256 lossCash = loss - lossDebt;
        uint256 surviving = WIN - lossDebt;

        // The house only has the cash part of the loss: it pays that toward the surviving claim,
        // takes no fee, and queues the rest.
        assertEq(ex.balances(bob), 980e6 + (20e6 - lossCash) + lossCash);
        assertEq(ex.queuedOf(bob), surviving - lossCash);
        assertEq(ex.stakerFees() + ex.devFees(), 0);
        assertEq(ex.lpCash(), 0);
        _assertSolvent();
    }

    /// @dev A harvest paying the trader between signing and landing must not sink the intent.
    function test_queued_aHarvestInBetweenChangesNothing() public {
        _win(bobPk);
        Intents.OpenIntent memory it = _intent(bob, btc, true, 50e6, 100);
        it.useQueued = true;

        _seedHouse(1_000e6);
        assertEq(ex.queuedOf(bob), 0, "paid out before the intent landed");

        bytes32 id = _submitOpen(bobPk, it, P0);
        assertEq(ex.getPosition(id).debtMargin, 0, "funded from the cash he was just paid");
        assertEq(ex.balances(bob), 1_000e6 + WIN - 50e6);
    }

    function test_queued_ignoredUnlessAsked() public {
        _win(bobPk);
        bytes32 id = _open(bobPk, btc, true, 50e6, 100, P0);
        assertEq(ex.getPosition(id).debtMargin, 0);
        assertEq(ex.queuedOf(bob), WIN);
    }

    function test_queued_feeOnALosingCloseOnlyWhenTheHouseCanPayItAll() public {
        _win(bobPk);
        bytes32 id = _openQueued(bobPk, btc, true, uint96(WIN), 100, P0);
        assertEq(ex.totalQueued(), 0);
        _seedHouse(1_000e6);

        _close(bobPk, id, _px(79_600));
        // A loss rounds down, in the trader's favour: the library says what it is to the unit.
        (, uint256 loss) = _btcSettle(P0, _px(79_600), WIN * 100, true);
        assertEq(loss, (WIN * 100 * 400) / 80_000);
        assertEq(ex.stakerFees() + ex.devFees(), (loss * 200) / 10_000);
        assertEq(ex.balances(bob), 1_000e6 + WIN - loss);
        assertEq(ex.queuedOf(bob), 0);
        _assertSolvent();
    }

    /// @dev Queue-funded margin in an open position is money the house still owes its owner. A fee
    ///      is the house paying stakers and the dev, so it waits until the house can cover that
    ///      margin as well, on a loss and on a win alike.
    function test_queued_noFeeIsTakenAheadOfQueueFundedMarginOpenElsewhere() public {
        // Bob's win is queued and he puts all of it up as margin. Nobody is queued any more, but
        // the house owes him WIN (about $86) for as long as the position is open.
        _win(bobPk);
        _openQueued(bobPk, btc, true, uint96(WIN), 2, P0);
        assertEq(ex.totalQueued(), 0);
        assertEq(ex.debtMarginOpen(), WIN);

        // Alice loses $50. The house holds $50 against the $86 it owes: no fee.
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(79_600));
        assertEq(ex.lpCash(), 50e6);
        assertEq(ex.stakerFees() + ex.devFees(), 0, "the house cannot cover bob's margin and a fee");

        // She loses another $50. $100 covers the $86 and the $1 fee: now it is taken.
        id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(79_600));
        assertEq(ex.stakerFees() + ex.devFees(), 1e6);
        assertEq(ex.lpCash(), 99e6);

        // The same on a win. Carol is paid in full, but $99 does not cover her profit, her win fee
        // and bob's margin together, so the fee stays with the house.
        _win(carolPk);
        assertEq(ex.balances(carol), 1_000e6 + WIN);
        assertEq(ex.queuedOf(carol), 0);
        assertEq(ex.stakerFees() + ex.devFees(), 1e6, "no win fee was added");
        assertEq(ex.lpCash(), 99e6 - WIN);
        _assertSolvent();
    }

    // --------------------------------------------------------------------------------------
    // The exit that needs no operator
    // --------------------------------------------------------------------------------------

    function test_directClose_executesAtThePinnedPrice() public {
        _seedHouse(1_000e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 10, P0);

        vm.prank(alice);
        ex.requestClose(id);
        uint64 requested = uint64(vm.getBlockTimestamp());
        uint64 pin = requested + 24;
        assertEq(ex.closeRequestedAt(id), requested);

        // Not at a print from before the pin.
        vm.prank(operator);
        vm.expectRevert(_noPrice());
        ex.executeClose(id, _update(BTC_FEED, _px(80_400), pin - 1));

        // Anyone can execute it, once everything signed before its price has had time to land.
        vm.warp(pin + 60);
        vm.prank(stranger);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.executeClose(id, _update(BTC_FEED, _px(80_400), pin));

        vm.warp(pin + 61);
        vm.prank(stranger);
        ex.executeClose(id, _update(BTC_FEED, _px(80_400), pin));

        (, uint256 gain) = _btcSettle(P0, _px(80_400), 1_000e6, true);
        assertEq(ex.balances(alice), 1_000e6 + gain - (gain * 200) / 10_000);
        assertEq(ex.closeRequestedAt(id), 0);
    }

    function test_directClose_anOperatorExecutesItAtOnce() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 10, P0);
        vm.prank(alice);
        ex.requestClose(id);
        uint64 pin = uint64(vm.getBlockTimestamp()) + 24;
        vm.warp(pin + 1);
        vm.prank(operator);
        ex.executeClose(id, _update(BTC_FEED, P0, pin));
        assertEq(ex.balances(alice), 1_000e6);
    }

    function test_directClose_isBinding() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 10, P0);
        vm.startPrank(alice);
        ex.requestClose(id);
        vm.expectRevert(Exchange.CloseAlreadyRequested.selector);
        ex.requestClose(id);
        skip(10 minutes - 1);
        vm.expectRevert(Exchange.CloseAlreadyRequested.selector);
        ex.requestClose(id);

        // Only once it has lapsed unexecuted may it be replaced.
        skip(1);
        ex.requestClose(id);
        assertEq(ex.closeRequestedAt(id), vm.getBlockTimestamp());
        vm.stopPrank();
    }

    function test_directClose_onlyTheOwnerRequests() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 10, P0);
        vm.prank(bob);
        vm.expectRevert(Exchange.NotPositionOwner.selector);
        ex.requestClose(id);

        vm.expectRevert(Exchange.NoRequest.selector);
        ex.executeClose(id, _update(BTC_FEED, P0, uint64(vm.getBlockTimestamp())));
        vm.expectRevert(Exchange.NoPosition.selector);
        ex.executeClose(bytes32(uint256(1)), _update(BTC_FEED, P0, uint64(vm.getBlockTimestamp())));
    }

    /// @dev A touch after the close was priced comes too late; a touch before it still busts.
    function test_directClose_ordersAgainstLiquidationByTime() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        vm.prank(alice);
        ex.requestClose(id);
        uint64 pin = uint64(vm.getBlockTimestamp()) + 24;

        skip(60);
        vm.prank(operator);
        vm.expectRevert(Exchange.CloseHasPriority.selector);
        ex.liquidate(id, _update(BTC_FEED, _px(79_900), pin));
        vm.prank(operator);
        vm.expectRevert(Exchange.CloseHasPriority.selector);
        ex.liquidate(id, _update(BTC_FEED, _px(79_900), pin + 20));

        vm.prank(operator);
        ex.liquidate(id, _update(BTC_FEED, _px(79_900), pin - 1));
        assertEq(ex.balances(alice), 900e6);
    }

    /// @dev The request cannot be used to dodge a bust: the public gets its turn with the touch
    ///      before the owner is allowed to execute their own close.
    function test_directClose_cannotOutrunALiquidation() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        uint64 touchTime = uint64(vm.getBlockTimestamp()) + 1;
        bytes[] memory touch = _update(BTC_FEED, _px(79_900), touchTime);

        skip(12);
        vm.prank(alice);
        ex.requestClose(id);
        uint64 pin = uint64(vm.getBlockTimestamp()) + 24;

        // The price has recovered by the pin, and Alice tries to walk out with her margin.
        vm.warp(pin + 12);
        vm.prank(alice);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.executeClose(id, _update(BTC_FEED, P0, pin));

        vm.warp(touchTime + 61);
        vm.prank(stranger);
        ex.liquidate(id, touch);
        assertEq(ex.balances(alice), 900e6);
    }

    function test_directClose_doesNotBlockASignedCloseForAnEarlierPrice() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 10, P0);
        vm.prank(alice);
        ex.requestClose(id);
        // A close signed for a price before the request's own still lands: the request cannot be
        // used to cancel it.
        _close(alicePk, id, P0);
        assertEq(ex.getPosition(id).owner, address(0));
        assertEq(ex.closeRequestedAt(id), 0);
    }

    /// @dev Two closes for two prices would let the owner keep the better one. Once the binding
    ///      close has been priced, a signed close for a later price is refused.
    function test_directClose_refusesASignedCloseForALaterPrice() public {
        _seedHouse(100_000e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        vm.prank(alice);
        ex.requestClose(id);
        uint64 requested = uint64(vm.getBlockTimestamp());

        // Pins one second before the request's price: allowed. At it, or after: refused.
        Intents.CloseIntent memory before = Intents.CloseIntent(alice, id, requested + 21);
        Intents.CloseIntent memory at = Intents.CloseIntent(alice, id, requested + 22);
        bytes memory beforeSig = _sign(alicePk, _hashClose(before));
        bytes memory atSig = _sign(alicePk, _hashClose(at));

        vm.warp(requested + 36);
        vm.prank(operator);
        vm.expectRevert(Exchange.CloseHasPriority.selector);
        ex.close(at, atSig, _update(BTC_FEED, _px(80_480), requested + 24));

        // And Alice cannot step in front of her own earlier-priced close with the direct one.
        vm.prank(alice);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.executeClose(id, _update(BTC_FEED, _px(80_480), requested + 24));

        vm.prank(operator);
        ex.close(before, beforeSig, _update(BTC_FEED, _px(80_400), requested + 23));
        (, uint256 gain) = _btcSettle(P0, _px(80_400), 10_000e6, true);
        assertEq(ex.balances(alice), 1_000e6 + gain - (gain * 200) / 10_000);
    }

    /// @dev If Pyth printed nothing in the request's window it can never execute. It must not
    ///      shield the position for ever: after it lapses the position busts like any other.
    function test_directClose_aLapsedRequestShieldsNothing() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        vm.prank(alice);
        ex.requestClose(id);
        uint64 requested = uint64(vm.getBlockTimestamp());
        bytes[] memory crash = _update(BTC_FEED, _px(76_000), requested + 300);

        // While it is live, a touch after its price cannot bust the position.
        skip(10 minutes - 1);
        vm.prank(operator);
        vm.expectRevert(Exchange.CloseHasPriority.selector);
        ex.liquidate(id, crash);

        // Lapsed: it can no longer be executed, and the touch counts.
        skip(1);
        vm.prank(operator);
        vm.expectRevert(Exchange.NoRequest.selector);
        ex.executeClose(id, _update(BTC_FEED, P0, requested + 24));
        vm.prank(operator);
        ex.liquidate(id, crash);
        assertEq(ex.balances(alice), 900e6);
    }

    // --------------------------------------------------------------------------------------
    // Fees
    // --------------------------------------------------------------------------------------

    function test_devFees_goToTheRecipient() public {
        _bust(alicePk, 100e6);
        assertEq(ex.devFees(), 1e6);
        vm.prank(stranger);
        ex.claimDevFees();
        assertEq(usdc.balanceOf(dev), 1e6);
        assertEq(ex.devFees(), 0);
        vm.expectRevert(Exchange.ZeroAmount.selector);
        ex.claimDevFees();
        _assertSolvent();
    }

    function test_devRecipient_canBeChanged() public {
        _bust(alicePk, 100e6);
        vm.startPrank(admin);
        vm.expectRevert(Exchange.ZeroAddress.selector);
        ex.setDevRecipient(address(0));
        ex.setDevRecipient(carol);
        vm.stopPrank();
        ex.claimDevFees();
        assertEq(usdc.balanceOf(carol), 1e6);
    }

    function test_stakerFees_waitForTheCoin() public {
        _bust(alicePk, 100e6);
        assertEq(ex.stakerFees(), 1e6);
        vm.expectRevert(Exchange.NoStaking.selector);
        ex.pushStakerFees();

        // Fees earned before the coin existed are still there for its first stakers.
        _attachCoin();
        ex.pushStakerFees();
        assertEq(usdc.balanceOf(address(staking)), 1e6);
        assertEq(staking.waiting(), 1e6, "nobody is staked yet: it waits for the first staker");
        assertEq(ex.stakerFees(), 0);
        _assertSolvent();
    }

    function test_stakerFees_anyoneCanPushWhateverHasAccrued() public {
        _attachCoin();
        _bust(alicePk, 100e6);
        vm.expectEmit(address(ex));
        emit Exchange.StakerFeesPushed(1e6, 0);
        vm.prank(stranger);
        ex.pushStakerFees();
        _bust(alicePk, 100e6);
        ex.pushStakerFees();
        assertEq(usdc.balanceOf(address(staking)), 2e6);
        assertEq(staking.totalReceived(), 2e6);
        assertEq(staking.waiting(), 2e6, "waiting for the first staker");

        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.pushStakerFees();
    }

    /// @dev A push sends the accrued fee share and nothing else. Cash above the cap is the
    ///      sweeper's business, because sparing it takes prices.
    function test_stakerFees_aPushLeavesCashAboveTheCapAlone() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 500e6);
        assertEq(ex.lpExcess(), 500e6);
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.pushStakerFees();

        // A $100 bust: $1 of fee to stakers, $1 to the dev, $98 more above the cap.
        _bust(alicePk, 100e6);
        assertEq(ex.pushStakerFees(), 1e6);
        assertEq(usdc.balanceOf(address(staking)), 1e6);
        assertEq(ex.lpExcess(), 598e6, "untouched by the push");
        assertEq(ex.lpCash(), STAKER_CAP + 598e6);
        _assertSolvent();
    }

    // --------------------------------------------------------------------------------------
    // The sweep: cash above the cap, marked to market
    // --------------------------------------------------------------------------------------

    /// @dev The sweeper's margin: 0.2% of everything open in a market, rounded up.
    function _margin(uint256 open) internal pure returns (uint256) {
        return (open * 20 + 9_999) / 10_000;
    }

    function test_sweep_withNothingOpenTheWholeExcessGoes() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 500e6);
        assertEq(ex.lpExcess(), 500e6);

        uint256 ethBefore = address(this).balance;
        vm.expectEmit(address(ex));
        emit Exchange.StakerFeesPushed(0, 500e6);
        assertEq(_sweep(P0, _px(2_500)), 500e6);
        assertEq(address(this).balance, ethBefore, "no price was needed, so the Pyth fee came back");
        assertEq(usdc.balanceOf(address(staking)), 500e6);
        assertEq(ex.lpCash(), STAKER_CAP);
        assertEq(ex.lpExcess(), 0);
        _assertSolvent();

        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        _sweep(P0, _px(2_500));
    }

    /// @dev What an open position is up is money the house may have to pay. It is held back, with
    ///      a margin of 0.2% of everything open on top, and let go once the position has closed.
    function test_sweep_holdsBackWhatAnOpenPositionIsUp() public {
        _attachCoin();
        assertEq(sweeper.MARGIN_BPS(), 20);
        _seedHouse(STAKER_CAP + 500e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);

        // +1% on $10,000: the long is up $100 before any haircut. That stays, and so does the
        // margin: 0.2% of the $10,000 open is $20.
        assertEq(_sweep(_px(80_800), _px(2_500)), 380e6);
        assertEq(usdc.balanceOf(address(staking)), 380e6);
        assertEq(ex.lpExcess(), 120e6);
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        _sweep(_px(80_800), _px(2_500));

        // She closes there and is paid out of what was held back, not out of the cap.
        _close(alicePk, id, _px(80_800));
        uint256 gain = WIN + WIN_FEE;
        assertEq(ex.balances(alice), 1_000e6 + WIN);
        assertEq(ex.lpCash(), STAKER_CAP + 120e6 - gain);

        // Nothing is open, so there is no mark and no margin: what her win left of the $120 is
        // spare now, and only now.
        assertEq(_sweep(_px(80_800), _px(2_500)), 120e6 - gain);
        assertEq(ex.lpCash(), STAKER_CAP);
        _assertSolvent();
    }

    /// @dev A position that is down owes the house, not the other way round: nothing is held back
    ///      for what it is down, only the margin every open position carries. Nor is its paper
    ///      loss swept: that is not cash until it closes.
    function test_sweep_holdsBackOnlyTheMarginForAPositionInLoss() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 500e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);

        // -0.5% on $10,000: down $50. All that stays is the $20 margin.
        assertEq(_sweep(_px(79_600), _px(2_500)), 480e6);
        assertEq(ex.lpCash(), STAKER_CAP + 20e6);

        // Closed, the loss is cash above the cap, $50 less the $1 fee, and the margin has nothing
        // left to stand behind.
        _close(alicePk, id, _px(79_600));
        assertEq(ex.lpExcess(), 69e6);
        assertEq(_sweep(_px(79_600), _px(2_500)), 69e6);
        assertEq(ex.lpCash(), STAKER_CAP);
        _assertSolvent();
    }

    /// @dev Shorts are marked the other way up, and every market with open positions counts.
    function test_sweep_marksShortsAndEveryMarket() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 500e6);
        _open(bobPk, btc, false, 100e6, 100, P0);
        _open(carolPk, eth, false, 100e6, 10, _px(2_500));

        // BTC -1% on $10,000: the short is up $100. ETH -2% on $1,000: up $20. The margin is $20
        // on the one and $2 on the other.
        assertEq(_sweep(_px(79_200), _px(2_450)), 358e6);
        assertEq(ex.lpExcess(), 142e6);

        // BTC back above entry: that short is down, and its $100 is released. ETH still holds its
        // $20, and both keep their margin.
        assertEq(_sweep(_px(80_400), _px(2_450)), 100e6);
        assertEq(ex.lpExcess(), 42e6);
    }

    /// @dev The margin is on everything open in a market, longs and shorts added together, and a
    ///      fraction of a unit rounds against the sweep.
    function test_sweep_theMarginCountsBothSidesAndRoundsAgainstTheSweep() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 500e6);
        _open(bobPk, btc, false, 100e6, 100, P0);
        _open(carolPk, btc, true, 1_000_001, 3, P0);

        // Both sit at their entry, so nothing is up. Open: $10,000 short and $3.000003 long.
        // 0.2% of that is 20,006,000.006 units, held back as 20,006,001.
        assertEq(_margin(10_000e6 + 3_000_003), 20_006_001);
        assertEq(_sweep(P0, _px(2_500)), 500e6 - 20_006_001);
        assertEq(ex.lpExcess(), 20_006_001);
    }

    /// @dev The reason the sweep marks the book. A trader holds a long and a short at once and
    ///      closes the loser first: its loss is cash above the cap. Swept on the spot, the winner
    ///      would then have to be paid out of the cap itself.
    function test_sweep_aHedgedPairCannotPushTheWinnersPayoutOntoTheCap() public {
        _attachCoin();
        _seedHouse(STAKER_CAP);
        bytes32 longId = _open(alicePk, btc, true, 100e6, 100, P0);
        bytes32 shortId = _open(alicePk, btc, false, 100e6, 100, P0);

        // +0.5%. The short loses $50, $1 of it fee: $49 of new cash sits above the cap.
        uint64 up = _px(80_400);
        _close(alicePk, shortId, up);
        assertEq(ex.lpExcess(), 49e6);

        // But the long is up $50 at this price, more than there is to spare even before its $20
        // margin. Nothing can go.
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        _sweep(up, _px(2_500));
        // A push moves the stakers' half of the fee and not a cent of that cash.
        assertEq(ex.pushStakerFees(), 0.5e6);
        assertEq(ex.lpCash(), STAKER_CAP + 49e6);

        // The long closes and is paid from the short's loss. The cap is whole.
        (, uint256 gain) = _btcSettle(P0, up, 10_000e6, true);
        _close(alicePk, longId, up);
        assertEq(ex.balances(alice), 1_000e6 - 50e6 + gain - (gain * 200) / 10_000);
        assertEq(ex.lpCash(), STAKER_CAP + 49e6 - gain);
        assertGe(ex.lpCash(), STAKER_CAP, "the winner was not paid out of the cap");

        // With both legs closed, what is left of the $49 really is spare.
        assertEq(_sweep(up, _px(2_500)), 49e6 - gain);
        assertEq(ex.lpCash(), STAKER_CAP);
        _assertSolvent();
    }

    /// @dev Why the margin is there. A side is marked as a whole, so a long that is past the price
    ///      where its margin is gone, and has not been liquidated yet, hides another long's gain:
    ///      its paper loss counts in full, although the house can only ever collect its margin.
    ///      Before the margin this very book had the whole $500 swept, and busting the one and
    ///      closing the other then left the house $323.98 under its cap.
    function test_sweep_theMarginCoversAnUnliquidatedLoserHidingAWinnersGain() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 500e6);
        // A: $100,000 long at 80,000, 100x. B: $110,000 long at 80,800, 1000x, on $110 of margin.
        bytes32 a = _open(alicePk, btc, true, 1_000e6, 100, P0);
        bytes32 b = _open(bobPk, btc, true, 110e6, 1_000, _px(80_800));

        // At 80,400 A is up $500. B was due for liquidation at 80,757.60 and nobody has done it:
        // it is $544.55 down on paper, five times its margin.
        uint64 mark = _px(80_400);
        assertEq(_bustOf(b), 80_757.6e8);
        (, uint256 paperLoss) = _btcSettle(_px(80_800), mark, 110_000e6, true);
        assertEq(paperLoss, 544_554_455);

        // Taken together the longs are down, so the mark holds back nothing. The margin does:
        // 0.2% of the $210,000 open is $420, and only $80 of the $500 goes.
        assertEq(_sweep(mark, _px(2_500)), 80e6);
        assertEq(ex.lpExcess(), 420e6);

        // B busts for its $110, $2.20 of it fee. A closes for $431.78.
        _liquidate(b, mark);
        assertEq(ex.lpCash(), STAKER_CAP + 420e6 + 107.8e6);
        (, uint256 gain) = _btcSettle(P0, mark, 100_000e6, true);
        assertEq(gain, 431_776_320);
        _close(alicePk, a, mark);

        // The house is not below its cap: $96.02 of what was kept is left over.
        assertEq(ex.lpCash(), STAKER_CAP + 420e6 + 107.8e6 - gain);
        assertEq(ex.lpCash() - STAKER_CAP, 96_023_680);
        _assertSolvent();
    }

    /// @dev KNOWN RESIDUAL, NOT A GUARANTEE. The margin is a bound, not a proof. It covers a
    ///      position left unliquidated up to 0.2% of everything open past the price where its
    ///      margin is gone, and no further: exact marking would have to go position by position.
    ///      Here one is left open far beyond that, hiding a gain on its own side, and a sweep in
    ///      the meantime leaves the house short of its cap. It takes a position more than
    ///      `MARGIN_BPS` of everything open past empty that nobody has liquidated; the keeper
    ///      liquidates at the trigger, long before, and after a minute anyone can.
    ///
    ///      This pins the size of the gap in one book so that a change to it gets noticed. It does
    ///      not say the cap is safe in any other.
    function test_sweep_knownResidual_aLoserFarPastEmptyStillLeavesTheCapShort() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 1_000e6);
        // A: $100,000 long at 80,000, 100x. B: $160,000 long at 82,000, 1000x, on $160 of margin.
        bytes32 a = _open(alicePk, btc, true, 1_000e6, 100, P0);
        bytes32 b = _open(bobPk, btc, true, 160e6, 1_000, _px(82_000));

        // At 81,200 A is up $1,500. B's margin was gone at 81,918 and it is $1,560.98 down on
        // paper: $1,400.98 past empty, where the margin on the $260,000 open is $520.
        uint64 mark = _px(81_200);
        (, uint256 paperLoss) = _btcSettle(_px(82_000), mark, 160_000e6, true);
        assertEq(paperLoss, 1_560_975_609);
        assertGt(paperLoss - 160e6, _margin(260_000e6), "further past empty than the margin reaches");

        // The longs together are down, the mark is nothing, and the $520 is all that stays.
        assertEq(_sweep(mark, _px(2_500)), 480e6);
        assertEq(ex.lpExcess(), 520e6);

        // B busts for its $160, $3.20 of it fee. A closes for $1,331.36: $654.56 more than the
        // $520 and B's margin come to, and that much comes out of the cap.
        _liquidate(b, mark);
        (, uint256 gain) = _btcSettle(P0, mark, 100_000e6, true);
        assertEq(gain, 1_331_364_495);
        _close(alicePk, a, mark);
        assertEq(STAKER_CAP - ex.lpCash(), gain - 520e6 - 156.8e6);
        assertEq(STAKER_CAP - ex.lpCash(), 654_564_495, "the shortfall, to the unit");
        _assertSolvent();
    }

    /// @dev The mark is only as good as its prices: every market with open positions needs one,
    ///      and none older than a minute. Anyone can bring them.
    /// @dev The mark cannot see everything (another trader's paper loss is not cash), so the sweep
    ///      is an operator's call, and the operator states the most to send.
    function test_sweep_isAnOperatorsCallWithACeiling() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 500e6);
        bytes[] memory none = new bytes[](0);

        vm.prank(stranger);
        vm.expectRevert(SweeperBase.NotOperator.selector);
        sweeper.sweep(none);
        vm.prank(stranger);
        vm.expectRevert(SweeperBase.NotOperator.selector);
        sweeper.sweep(none, 1e6);

        // The keeper's own figure is the ceiling: here it says $120 can be spared.
        vm.startPrank(operator);
        assertEq(sweeper.sweep(none, 120e6), 120e6);
        assertEq(ex.lpExcess(), 380e6);
        vm.expectRevert(SweeperBase.NothingToSweep.selector);
        sweeper.sweep(none, 0);
        // A ceiling above what the mark allows changes nothing: the mark still bounds it.
        assertEq(sweeper.sweep(none, 1_000_000e6), 380e6);
        vm.stopPrank();
        assertEq(ex.lpCash(), STAKER_CAP);
        assertEq(usdc.balanceOf(address(staking)), 500e6);
    }

    function test_sweep_needsAFreshPriceForEveryMarketWithOpenPositions() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 500e6);
        _open(alicePk, btc, true, 100e6, 100, P0);
        uint64 nowTime = uint64(vm.getBlockTimestamp());
        vm.deal(stranger, 3);

        vm.deal(operator, 1 ether);
        // No BTC price at all.
        bytes[] memory updates = _update(ETH_FEED, _px(2_500), nowTime);
        vm.prank(operator);
        vm.expectRevert(_noPrice());
        sweeper.sweep{value: _fee(1)}(updates);

        // A BTC price from 31 seconds ago.
        updates = _update(BTC_FEED, P0, nowTime - 31);
        vm.prank(operator);
        vm.expectRevert(_noPrice());
        sweeper.sweep{value: _fee(1)}(updates);

        // Thirty seconds is still good. ETH has nothing open and needs no price. The long sits at
        // its entry, so all that stays is the $20 margin on its $10,000.
        updates = _update(BTC_FEED, P0, nowTime - 30);
        vm.prank(operator);
        uint256 swept = sweeper.sweep{value: _fee(1)}(updates);
        assertEq(swept, 480e6);
        assertEq(usdc.balanceOf(address(staking)), 480e6);
    }

    /// @dev The Exchange cannot mark its own book, so it lets exactly one contract take cash above
    ///      the cap, and never more of it than there is.
    function test_sweepExcess_isTheSweepersAloneAndBoundedByTheExcess() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 500e6);

        vm.expectRevert(Exchange.NotOperator.selector);
        ex.sweepExcess(1e6);
        vm.prank(operator);
        vm.expectRevert(Exchange.NotOperator.selector);
        ex.sweepExcess(1e6);
        vm.prank(admin);
        vm.expectRevert(Exchange.NotOperator.selector);
        ex.sweepExcess(1e6);

        vm.startPrank(address(sweeper));
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.sweepExcess(0);
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.sweepExcess(500e6 + 1);
        ex.sweepExcess(500e6);
        vm.expectRevert(Exchange.NothingToPush.selector);
        ex.sweepExcess(1);
        vm.stopPrank();
        assertEq(ex.lpCash(), STAKER_CAP);
        assertEq(usdc.balanceOf(address(staking)), 500e6);
    }

    function test_excess_isZeroWhileAnyoneIsQueuedAndNetOfSpentMargin() public {
        _win(bobPk);
        assertEq(ex.lpExcess(), 0);

        // Bob spends his whole claim as margin: the house still owes it while the position is open.
        _openQueued(bobPk, btc, true, uint96(WIN), 2, P0);
        _seedHouse(STAKER_CAP + 500e6);
        assertEq(ex.lpExcess(), 500e6 - WIN);

        // And that is all a sweep has to work with. His position sits at its entry price, so it
        // takes the lot but the margin on the 2 x WIN he has open.
        _attachCoin();
        assertEq(_sweep(P0, _px(2_500)), 500e6 - WIN - _margin(2 * WIN));
        assertEq(ex.lpCash(), STAKER_CAP + WIN + _margin(2 * WIN));
    }

    // --------------------------------------------------------------------------------------
    // The loss-mining hook
    // --------------------------------------------------------------------------------------

    function _attachMock() internal returns (MockLossMining mock) {
        mock = new AttachableMock(address(ex));
        // Staking is never called in these tests and nothing is swept: the other two only have to
        // answer for this Exchange.
        address standIn = address(new AttachableMock(address(ex)));
        vm.prank(admin);
        ex.attachCoin(standIn, address(mock), standIn);
    }

    /// @dev The real coin side, built for this Exchange and not attached.
    function _deployCoinSide() internal {
        coin = new Coin("Tape", "TAPE", SUPPLY, address(this));
        staking = new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(ex));
        mining = new LossMining(IERC20(address(coin)), address(ex), MINING_SCALE, address(0));
        sweeper = _newSweeper(ex);
    }

    /// @dev The owner tries to attach these three and is refused with no revert data: the sign of
    ///      a contract asked for a function it does not have.
    function _assertAttachRefusedWithoutData(address staking_, address lossMining_, address sweeper_)
        internal
    {
        vm.prank(admin);
        (bool ok, bytes memory data) =
            address(ex).call(abi.encodeCall(ex.attachCoin, (staking_, lossMining_, sweeper_)));
        assertFalse(ok, "attached in the wrong order");
        assertEq(data.length, 0, "refused for some other reason");
    }

    /// @dev Attaching is for good, so the three must not be able to go in the wrong way round.
    ///      Each kind answers to its own name only: asked under another's it has no such function.
    function test_attachCoin_refusesEveryWrongOrderOfTheRealContracts() public {
        _deployCoinSide();
        address s = address(staking);
        address m = address(mining);
        address w = address(sweeper);

        // The five wrong orders of the three.
        _assertAttachRefusedWithoutData(s, w, m);
        _assertAttachRefusedWithoutData(m, s, w);
        _assertAttachRefusedWithoutData(m, w, s);
        _assertAttachRefusedWithoutData(w, s, m);
        _assertAttachRefusedWithoutData(w, m, s);
        // And one contract standing in two places.
        _assertAttachRefusedWithoutData(s, s, w);
        _assertAttachRefusedWithoutData(s, m, m);
        _assertAttachRefusedWithoutData(w, m, w);

        assertEq(ex.staking(), address(0), "nothing was attached by any of those");
        assertEq(ex.lossMining(), address(0));
        assertEq(ex.sweeper(), address(0));

        // The right order still goes in, once.
        vm.startPrank(admin);
        ex.attachCoin(s, m, w);
        assertEq(ex.staking(), s);
        assertEq(ex.lossMining(), m);
        assertEq(ex.sweeper(), w);
        vm.expectRevert(Exchange.AlreadyAttached.selector);
        ex.attachCoin(s, m, w);
        vm.stopPrank();
    }

    /// @dev The right kind of contract in the right place, but built for another Exchange.
    function test_attachCoin_refusesTheRealContractsOfAnotherExchange() public {
        _deployCoinSide();
        address elsewhere = address(lens);
        address theirStaking = address(new Staking(IERC20(address(coin)), IERC20(address(usdc)), elsewhere));
        address theirMining = address(new LossMining(IERC20(address(coin)), elsewhere, MINING_SCALE, address(0)));
        address theirSweeper = address(new Sweeper(Exchange(elsewhere), IPyth(address(pyth))));

        vm.startPrank(admin);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(theirStaking, address(mining), address(sweeper));
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(staking), theirMining, address(sweeper));
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(staking), address(mining), theirSweeper);
        vm.stopPrank();
        assertEq(ex.staking(), address(0), "nothing was attached by any of those");
    }

    /// @dev The same two refusals, seen through the stand-in the hook tests attach.
    function test_attachCoin_refusesContractsBuiltForAnotherExchange() public {
        address ours = address(new AttachableMock(address(ex)));
        address theirs = address(new AttachableMock(address(lens)));
        address mute = address(new MockLossMining());

        vm.startPrank(admin);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(theirs, ours, ours);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(ours, theirs, ours);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(ours, ours, theirs);
        vm.stopPrank();
        // One that answers to none of the three names does not get in either.
        _assertAttachRefusedWithoutData(mute, ours, ours);
        _assertAttachRefusedWithoutData(ours, mute, ours);
        _assertAttachRefusedWithoutData(ours, ours, mute);
        assertEq(ex.staking(), address(0), "nothing was attached by any of those");

        vm.startPrank(admin);
        ex.attachCoin(ours, ours, ours);
        vm.expectRevert(Exchange.AlreadyAttached.selector);
        ex.attachCoin(ours, ours, ours);
        vm.stopPrank();
    }

    function test_attachCoin_takesTheRealContractsAndIsTheOwnersOnly() public {
        vm.expectRevert();
        ex.attachCoin(address(1), address(2), address(3));

        _attachCoin();
        assertEq(ex.staking(), address(staking));
        assertEq(ex.lossMining(), address(mining));
        assertEq(ex.sweeper(), address(sweeper));
        assertEq(staking.stakingFor(), address(ex));
        assertEq(mining.lossMiningFor(), address(ex));
        assertEq(sweeper.sweeperFor(), address(ex));
    }

    function test_mining_basisIsTheLossNetOfTheHouseFee() public {
        MockLossMining mock = _attachMock();
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(79_600));
        assertEq(mock.lastUser(), alice);
        assertEq(mock.lastUsd(), 49e6);
    }

    function test_mining_basisIsTheFullLossWhileWinnersWait() public {
        MockLossMining mock = _attachMock();
        _win(bobPk);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(79_600));
        assertEq(mock.lastUsd(), 50e6);
    }

    function test_mining_aBustMinesOnTheWholeMargin() public {
        MockLossMining mock = _attachMock();
        _bust(alicePk, 100e6);
        assertEq(mock.lastUsd(), 100e6, "the fee does not reduce it");

        _win(bobPk);
        bytes32 id = _openQueued(bobPk, btc, true, 50e6, 1_000, P0);
        _liquidate(id, _px(79_900));
        assertEq(mock.lastUser(), bob);
        assertEq(mock.lastUsd(), 50e6, "queue-funded margin counts too");
    }

    function test_mining_winsMineNothing() public {
        MockLossMining mock = _attachMock();
        _win(bobPk);
        assertEq(mock.calls(), 0);
    }

    /// @dev The hook must never be able to stop a trader from closing.
    function test_mining_aBrokenHookCannotBlockACloseOrABust() public {
        MockLossMining mock = _attachMock();
        mock.setRevert(true);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        vm.expectEmit(true, false, false, true);
        emit Exchange.MiningFailed(alice, 49e6);
        _close(alicePk, id, _px(79_600));
        assertEq(ex.balances(alice), 950e6);

        mock.setRevert(false);
        mock.setBurnGas(true);
        _bust(alicePk, 100e6);
        assertEq(ex.balances(alice), 850e6);
    }

    /// @dev Nor can a caller starve the hook by sending just too little gas.
    function test_mining_cannotBeStarvedOfGas() public {
        _attachMock();
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        skip(12);
        bytes[] memory update = _update(BTC_FEED, _px(79_900), uint64(vm.getBlockTimestamp()) - 1);
        vm.prank(operator);
        vm.expectRevert(Exchange.InsufficientGas.selector);
        ex.liquidate{gas: 200_000}(id, update);
    }

    // --------------------------------------------------------------------------------------
    // Batching
    // --------------------------------------------------------------------------------------

    function test_multicall_oneBadIntentDoesNotSinkTheBatch() public {
        Intents.OpenIntent memory good1 = _intent(alice, btc, true, 100e6, 100);
        Intents.OpenIntent memory bad = _intent(bob, btc, true, 100e6, 5_000);
        Intents.OpenIntent memory good2 = _intent(carol, eth, false, 100e6, 100);

        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(
            ex.open, (good1, _sign(alicePk, _hashOpen(good1)), _update(BTC_FEED, P0, good1.timestamp + 2))
        );
        calls[1] = abi.encodeCall(
            ex.open, (bad, _sign(bobPk, _hashOpen(bad)), _update(BTC_FEED, P0, bad.timestamp + 2))
        );
        calls[2] = abi.encodeCall(
            ex.open,
            (good2, _sign(carolPk, _hashOpen(good2)), _update(ETH_FEED, _px(2_500), good2.timestamp + 2))
        );

        // The one that failed is reported with the Exchange's own reason.
        vm.expectEmit(address(batcher));
        emit Batcher.CallFailed(1, abi.encodeWithSelector(Exchange.BadLeverage.selector));
        vm.prank(operator);
        bool[] memory ok = batcher.multicall(calls);
        assertTrue(ok[0]);
        assertFalse(ok[1]);
        assertTrue(ok[2]);
        assertEq(ex.openIdsOf(alice).length, 1);
        assertEq(ex.openIdsOf(bob).length, 0);
        assertEq(ex.openIdsOf(carol).length, 1);
    }

    /// @dev The Batcher passes calls on for operators only, and the Exchange sees the Batcher
    ///      itself as the caller. So a batch carries an operator's powers and nobody's account: an
    ///      account-level call made through it acts on the Batcher's own, empty one.
    function test_multicall_givesNobodyAPowerTheyDidNotHave() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(
            ex.open, (it, _sign(alicePk, _hashOpen(it)), _update(BTC_FEED, P0, it.timestamp + 2))
        );
        vm.prank(stranger);
        vm.expectRevert(Batcher.NotOperator.selector);
        batcher.multicall(calls);
        assertEq(ex.openIdsOf(alice).length, 0, "a stranger gains nothing by batching");

        // For an operator the operator-only functions work through it.
        vm.prank(operator);
        bool[] memory ok = batcher.multicall(calls);
        assertTrue(ok[0]);
        bytes32 id = ex.openIdsOf(alice)[0];

        // Alice's position is not the Batcher's to close, the withdrawal it asks for is from its
        // own account, and it has no USDC to deposit.
        calls = new bytes[](3);
        calls[0] = abi.encodeCall(ex.requestClose, (id));
        calls[1] = abi.encodeCall(ex.requestWithdraw, (50e6));
        calls[2] = abi.encodeCall(ex.deposit, (1e6));
        vm.expectEmit(address(batcher));
        emit Batcher.CallFailed(0, abi.encodeWithSelector(Exchange.NotPositionOwner.selector));
        vm.prank(operator);
        ok = batcher.multicall(calls);
        assertFalse(ok[0]);
        assertTrue(ok[1]);
        assertFalse(ok[2]);
        assertEq(ex.closeRequestedAt(id), 0);
        (uint128 amount,,) = ex.withdrawRequests(address(batcher));
        assertEq(amount, 50e6, "the request is the Batcher's");
        (amount,,) = ex.withdrawRequests(operator);
        assertEq(amount, 0);
        (amount,,) = ex.withdrawRequests(alice);
        assertEq(amount, 0);

        // Matured, that request moves nothing: the Batcher's account is empty.
        skip(15 minutes);
        calls = new bytes[](1);
        calls[0] = abi.encodeCall(ex.executeWithdraw, (operator));
        vm.expectEmit(address(batcher));
        emit Batcher.CallFailed(0, abi.encodeWithSelector(Exchange.ZeroAmount.selector));
        vm.prank(operator);
        ok = batcher.multicall(calls);
        assertFalse(ok[0]);
        assertEq(usdc.balanceOf(operator), 0);
        assertEq(ex.balances(address(batcher)), 0);
        assertEq(ex.balances(alice), 900e6);
        _assertSolvent();
    }

    // --------------------------------------------------------------------------------------
    // Lens
    // --------------------------------------------------------------------------------------

    function test_lens_account() public {
        _open(alicePk, btc, true, 100e6, 100, P0);
        _open(alicePk, eth, false, 40e6, 10, _px(2_500));
        vm.prank(alice);
        ex.requestWithdraw(5e6);

        Lens.Account memory a = lens.account(alice);
        assertEq(a.balance, 860e6);
        assertEq(a.marginInUse, 140e6);
        assertEq(a.openCount, 2);
        assertEq(a.withdrawAmount, 5e6);
        assertEq(a.withdrawRequestedAt, vm.getBlockTimestamp());
    }

    function test_lens_quoteCloseMatchesSettlement() public {
        _seedHouse(10_000e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);

        (bool busted, int256 pnl) = lens.quoteClose(id, _px(80_800));
        assertFalse(busted);
        assertEq(pnl, int256(WIN));

        (busted, pnl) = lens.quoteClose(id, _px(79_600));
        assertFalse(busted);
        assertEq(pnl, -50e6);

        (busted, pnl) = lens.quoteClose(id, _px(79_000));
        assertTrue(busted);
        assertEq(pnl, -100e6);

        _close(alicePk, id, _px(80_800));
        assertEq(ex.balances(alice), 1_000e6 + WIN);
        vm.expectRevert(Lens.NoPosition.selector);
        lens.quoteClose(id, P0);
    }

    function test_lens_queueViewsNetOffSpentPayout() public {
        _win(carolPk);
        _win(bobPk);
        _win(alicePk);
        bytes32 id = _openQueued(bobPk, btc, true, uint96(WIN), 1_000, P0);
        _liquidate(id, _px(79_900));

        Lens.ClaimView[] memory front = lens.queueFront(10, 100);
        assertEq(front.length, 2, "bob's spent claim is not shown");
        assertEq(front[0].user, carol);
        assertEq(front[0].amount, WIN);
        assertEq(front[1].user, alice);

        (uint256 ahead, bool found) = lens.queueAhead(alice, 100);
        assertTrue(found);
        assertEq(ahead, WIN);
        (ahead, found) = lens.queueAhead(carol, 100);
        assertTrue(found);
        assertEq(ahead, 0);
        (, found) = lens.queueAhead(bob, 100);
        assertFalse(found);

        Lens.House memory h = lens.house();
        assertEq(h.totalQueued, 2 * WIN);
        assertEq(h.queueLength, 3);
        assertEq(h.equity, -int256(2 * WIN));
    }
}
