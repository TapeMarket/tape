// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {Base} from "./Base.t.sol";

/// @dev Take-profits and stop-losses: a trigger the trader signs once, closed by the operator when
///      a print touches it, at the first price two seconds after that print.
contract TriggerTest is Base {
    bytes32 internal constant TRIGGER_TYPEHASH =
        keccak256("Trigger(address owner,bytes32 positionId,uint64 price,bool above,uint64 timestamp)");
    uint256 internal constant SESSION_PK = 0x5E5510;
    uint64 internal P0;

    function setUp() public override {
        super.setUp();
        P0 = _px(80_000);
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        _seedHouse(50_000e6);
    }

    function _trigger(address owner, bytes32 id, uint64 price, bool above)
        internal
        view
        returns (Intents.TriggerIntent memory)
    {
        return Intents.TriggerIntent({
            owner: owner, positionId: id, price: price, above: above, timestamp: uint64(vm.getBlockTimestamp())
        });
    }

    function _hashTrigger(Intents.TriggerIntent memory it) internal view returns (bytes32) {
        return _digest(keccak256(abi.encode(TRIGGER_TYPEHASH, it.owner, it.positionId, it.price, it.above, it.timestamp)));
    }

    /// @dev A touch at `touchedAt` and the first print two seconds after it, landed a block later.
    function _fire(Intents.TriggerIntent memory it, bytes memory sig, uint64 touch, uint64 touchedAt, uint64 fill)
        internal
    {
        Exchange.Position memory p = ex.getPosition(it.positionId);
        bytes[] memory touchUpdate = _update(_feed(p.market), touch, touchedAt);
        bytes[] memory fillUpdate = _update(_feed(p.market), fill, touchedAt + ex.EXEC_DELAY());
        vm.prank(operator);
        ex.closeOnTrigger(it, sig, touchUpdate, fillUpdate);
    }

    function test_takeProfit_closesAtTheFirstPriceTwoSecondsAfterTheTouch() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(80_400), true);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        skip(30);
        uint64 touchedAt = uint64(vm.getBlockTimestamp()) - 5;
        _fire(it, sig, _px(80_450), touchedAt, _px(80_420));

        (, uint256 gain) = _btcSettle(P0, _px(80_420), 10_000e6, true);
        uint256 profit = gain - (gain * 200) / 10_000;
        assertEq(ex.balances(alice), 1_000e6 + profit, "paid as a close at the fill, not at the touch");
        assertEq(ex.openIdsOf(alice).length, 0);
        _assertSolvent();
    }

    function test_stopLoss_onAShort_closesAtTheFill() public {
        bytes32 id = _open(alicePk, btc, false, 100e6, 100, P0);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(80_300), true);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        skip(30);
        _fire(it, sig, _px(80_310), uint64(vm.getBlockTimestamp()) - 5, _px(80_320));

        // Down 0.4% at 100x: 40% of the margin.
        assertEq(ex.balances(alice), 1_000e6 - 40e6);
        assertEq(ex.openIdsOf(alice).length, 0);
        _assertSolvent();
    }

    function test_aTouchShortOfThePriceDoesNotFire() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(79_700), false);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        skip(30);
        uint64 touchedAt = uint64(vm.getBlockTimestamp()) - 5;
        bytes[] memory touch = _update(BTC_FEED, _px(79_701), touchedAt);
        bytes[] memory fill = _update(BTC_FEED, _px(79_690), touchedAt + 2);
        vm.prank(operator);
        vm.expectRevert(Exchange.NotTriggered.selector);
        ex.closeOnTrigger(it, sig, touch, fill);
    }

    function test_aTouchBeforeTheTriggerWasSignedDoesNotCount() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        skip(20);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(80_400), true);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        // Printed the second it was signed: not after it.
        bytes[] memory touch = _update(BTC_FEED, _px(80_500), it.timestamp);
        bytes[] memory fill = _update(BTC_FEED, _px(80_500), it.timestamp + 2);
        skip(12);
        vm.prank(operator);
        vm.expectRevert(_noPrice());
        ex.closeOnTrigger(it, sig, touch, fill);
    }

    function test_aTouchCannotBeSavedUp() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(80_400), true);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        skip(30);
        uint64 touchedAt = uint64(vm.getBlockTimestamp()) - 5;
        bytes[] memory touch = _update(BTC_FEED, _px(80_450), touchedAt);
        bytes[] memory fill = _update(BTC_FEED, _px(80_420), touchedAt + 2);
        skip(ex.INTENT_TTL());
        vm.prank(operator);
        vm.expectRevert(Exchange.IntentExpired.selector);
        ex.closeOnTrigger(it, sig, touch, fill);
    }

    function test_theFillIsPinned_notPicked() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(80_400), true);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        skip(30);
        uint64 touchedAt = uint64(vm.getBlockTimestamp()) - 5;
        bytes[] memory touch = _update(BTC_FEED, _px(80_450), touchedAt);
        // A later print of the same second, or one from after it: not the first print of it.
        bytes[] memory late = _updateFull(BTC_FEED, _px(80_900), 0, touchedAt + 2, touchedAt + 2);
        vm.prank(operator);
        vm.expectRevert(_noPrice());
        ex.closeOnTrigger(it, sig, touch, late);
    }

    function test_onlyTheOwnersKeysCanSignIt_whateverOwnerItNames() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        // Bob signs a trigger for Alice's position, naming himself and then naming her.
        Intents.TriggerIntent memory his = _trigger(bob, id, _px(79_000), false);
        Intents.TriggerIntent memory hers = _trigger(alice, id, _px(79_000), false);
        skip(30);
        uint64 touchedAt = uint64(vm.getBlockTimestamp()) - 5;
        bytes[] memory touch = _update(BTC_FEED, _px(78_900), touchedAt);
        bytes[] memory fill = _update(BTC_FEED, _px(78_900), touchedAt + 2);
        bytes memory hisSig = _sign(bobPk, _hashTrigger(his));
        bytes memory hersSig = _sign(bobPk, _hashTrigger(hers));
        vm.startPrank(operator);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.closeOnTrigger(his, hisSig, touch, fill);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.closeOnTrigger(hers, hersSig, touch, fill);
        vm.stopPrank();
        assertEq(ex.openIdsOf(alice).length, 1);
    }

    function test_aSessionKeyCanSetIt() public {
        address key = vm.addr(SESSION_PK);
        uint64 validUntil = uint64(vm.getBlockTimestamp() + 1 days);
        bytes memory reg = _sign(alicePk, _sessionDigest(alice, key, validUntil));
        vm.prank(stranger);
        sessions.setSessionKeyBySig(alice, key, validUntil, reg);
        skip(12);

        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(80_400), true);
        bytes memory sig = _sign(SESSION_PK, _hashTrigger(it));
        skip(30);
        _fire(it, sig, _px(80_450), uint64(vm.getBlockTimestamp()) - 5, _px(80_420));
        assertEq(ex.openIdsOf(alice).length, 0);
    }

    function test_onlyAnOperatorLandsIt() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(80_400), true);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        skip(30);
        uint64 touchedAt = uint64(vm.getBlockTimestamp()) - 5;
        bytes[] memory touch = _update(BTC_FEED, _px(80_450), touchedAt);
        bytes[] memory fill = _update(BTC_FEED, _px(80_420), touchedAt + 2);
        vm.prank(stranger);
        vm.expectRevert(Exchange.NotOperator.selector);
        ex.closeOnTrigger(it, sig, touch, fill);
    }

    function test_itFiresOnce() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(80_400), true);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        skip(30);
        uint64 touchedAt = uint64(vm.getBlockTimestamp()) - 5;
        _fire(it, sig, _px(80_450), touchedAt, _px(80_420));
        bytes[] memory touch = _update(BTC_FEED, _px(80_450), touchedAt + 1);
        bytes[] memory fill = _update(BTC_FEED, _px(80_420), touchedAt + 3);
        vm.prank(operator);
        vm.expectRevert(Exchange.NoPosition.selector);
        ex.closeOnTrigger(it, sig, touch, fill);
    }

    function test_aDirectCloseAlreadyPricedComesFirst() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        Intents.TriggerIntent memory it = _trigger(alice, id, _px(80_400), true);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        vm.prank(alice);
        ex.requestClose(id);
        uint64 requestedAt = uint64(vm.getBlockTimestamp());
        skip(40);
        // Touched after the direct close was priced.
        uint64 touchedAt = requestedAt + ex.DIRECT_DELAY();
        bytes[] memory touch = _update(BTC_FEED, _px(80_450), touchedAt);
        bytes[] memory fill = _update(BTC_FEED, _px(80_420), touchedAt + 2);
        vm.prank(operator);
        vm.expectRevert(Exchange.CloseHasPriority.selector);
        ex.closeOnTrigger(it, sig, touch, fill);
    }

    function test_aStopFilledPastTheLiquidationPriceIsALiquidation() public {
        bytes32 id = _open(alicePk, btc, true, 10e6, 1_000, P0);
        uint256 bust = _bustOf(id);
        Intents.TriggerIntent memory it = _trigger(alice, id, P0 - _px(20), false);
        bytes memory sig = _sign(alicePk, _hashTrigger(it));
        skip(30);
        // The stop is touched, and two seconds later the price is through the liquidation price.
        _fire(it, sig, P0 - _px(25), uint64(vm.getBlockTimestamp()) - 5, uint64(bust) - _px(5));
        assertEq(ex.balances(alice), 1_000e6 - 10e6, "the whole margin");
        assertEq(ex.openIdsOf(alice).length, 0);
        _assertSolvent();
    }
}
