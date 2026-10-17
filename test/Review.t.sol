// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {Sessions} from "../src/Sessions.sol";

/// @dev Regression tests for the adversarial review. Each one replays an exploit the review
///      proved against an earlier version, step for step, and shows where it now stops.
///
///      All of them attack the same rule: nothing a trader can call directly may change the fate
///      of an order they have already signed, because by the time they call it they know where
///      the price went. The remaining findings are covered next to the code they concern:
///        a second price through the direct close   HouseTest.test_directClose_refusesASignedCloseForALaterPrice
///        a touched position escaping               HouseTest.test_directClose_cannotOutrunALiquidation
///        a request that shields for ever           HouseTest.test_directClose_aLapsedRequestShieldsNothing
///        micro prices locking margin               ExchangeTest.test_open_refusesLeverageThePriceLeavesNoRoomFor
///        a coin address without code               ExchangeTest.test_attachCoin_onlyOnce
contract ReviewTest is Base {
    uint64 internal P0;
    uint256 internal constant SESSION_PK = 0x5E5510;

    function setUp() public override {
        super.setUp();
        P0 = _px(80_000);
        _fund(alice, 1_000e6);
        _fund(carol, 1_000e6);
    }

    /// @dev Revoke a key, sign with it anyway, watch the price, re-register only if it paid.
    function test_aDeadOrderCannotBeRevivedByReRegisteringItsKey() public {
        address key = vm.addr(SESSION_PK);
        vm.startPrank(alice);
        sessions.setSessionKey(key, uint64(vm.getBlockTimestamp() + 1 days));
        skip(12);
        sessions.revokeSessionKey(key);
        vm.stopPrank();
        (, uint64 cutoff) = sessions.sessionKeys(alice, key);
        vm.warp(cutoff + 1);

        // Signed with the revoked key: invalid, and costs nothing if left alone.
        Intents.OpenIntent memory it = _intent(alice, btc, true, 1_000e6, 1_000);
        bytes memory sig = _sign(SESSION_PK, _hashOpen(it));
        bytes[] memory entry = _update(BTC_FEED, P0, it.timestamp + 2);
        skip(12);

        // The price went her way. She cannot reopen the key...
        vm.prank(alice);
        vm.expectRevert(Sessions.KeyRetired.selector);
        sessions.setSessionKey(key, uint64(vm.getBlockTimestamp() + 1 days));

        // ...so the order stays dead.
        vm.prank(operator);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.open(it, sig, entry);
        assertEq(ex.balances(alice), 1_000e6);
    }

    /// @dev Hand the operator a full withdrawal and then a full-balance open. Left alone, the
    ///      withdrawal lands and the open dies. The exploit was to void the withdrawal afterwards
    ///      with a session registration kept in a pocket, which shared its replay counter.
    function test_aQueuedWithdrawalCannotBeVoidedToFlipAnOpen() public {
        address key = vm.addr(SESSION_PK);
        uint64 validUntil = uint64(vm.getBlockTimestamp() + 1 days);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sessionSig = _sign(alicePk, _sessionDigest(alice, key, validUntil));

        bytes memory withdrawSig = _sign(
            alicePk,
            _digest(
                keccak256(
                    abi.encode(WITHDRAW_TYPEHASH, alice, alice, 1_000e6, ex.withdrawNonces(alice), deadline)
                )
            )
        );
        Intents.OpenIntent memory it = _intent(alice, btc, true, 1_000e6, 1_000);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(ex.withdrawBySig, (alice, alice, 1_000e6, deadline, withdrawSig));
        calls[1] = abi.encodeCall(
            ex.open, (it, _sign(alicePk, _hashOpen(it)), _update(BTC_FEED, P0, it.timestamp + 2))
        );
        skip(12);

        // The price went her way, and she submits the registration herself.
        vm.prank(alice);
        sessions.setSessionKeyBySig(alice, key, validUntil, sessionSig);

        // It changes nothing: the withdrawal still lands and the open still dies.
        vm.prank(operator);
        bool[] memory ok = batcher.multicall(calls);
        assertTrue(ok[0], "the withdrawal is still valid");
        assertFalse(ok[1], "the open still has nothing to open with");
        assertEq(usdc.balanceOf(alice), 1_000e6);
    }

    /// @dev Request a token withdrawal, let it mature, then sign an open and pull the balance out
    ///      in front of the operator if the price went wrong.
    function test_aMaturedWithdrawalRequestCannotCancelAnOpen() public {
        vm.prank(alice);
        ex.requestWithdraw(1);
        skip(15 minutes);

        // With a request pending there is no open to cancel: the account cannot open at all.
        Intents.OpenIntent memory it = _intent(alice, btc, true, 1_000e6, 1_000);
        bytes memory sig = _sign(alicePk, _hashOpen(it));
        bytes[] memory entry = _update(BTC_FEED, P0, it.timestamp + 2);
        skip(12);
        vm.prank(operator);
        vm.expectRevert(Exchange.ExitPending.selector);
        ex.open(it, sig, entry);

        // And an open signed BEFORE a request is out of that request's reach: it cannot mature
        // for fifteen minutes, and the open lives for one.
        vm.prank(alice);
        ex.requestWithdraw(0);
        skip(72);
        Intents.OpenIntent memory first = _intent(alice, btc, true, 1_000e6, 1_000);
        vm.prank(alice);
        ex.requestWithdraw(1_000e6);
        vm.prank(alice);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.executeWithdraw(alice);
        _submitOpen(alicePk, first, P0);
        assertEq(ex.balances(alice), 0);
    }

    /// @dev At the position cap an open fails. The exploit was to free a slot with the direct
    ///      close only after the open's price was known.
    function test_theDirectCloseCannotFreeASlotForAnOpenAlreadyPriced() public {
        bytes32 first;
        for (uint256 i; i < 200; ++i) {
            Intents.OpenIntent memory small = _intent(carol, btc, true, 1e6, 1);
            bytes memory smallSig = _sign(carolPk, _hashOpen(small));
            vm.prank(operator);
            bytes32 opened = ex.open(small, smallSig, _update(BTC_FEED, P0, small.timestamp + 2));
            if (i == 0) first = opened;
        }
        skip(12);
        vm.prank(carol);
        ex.requestClose(first);
        uint64 requested = uint64(vm.getBlockTimestamp());

        vm.warp(requested + 21);
        Intents.OpenIntent memory it = _intent(carol, btc, true, 700e6, 1_000);
        bytes memory sig = _sign(carolPk, _hashOpen(it));
        bytes[] memory entry = _update(BTC_FEED, P0, it.timestamp + 2);

        // The open's price is out. She tries to make room for it, and may not yet.
        vm.warp(requested + 36);
        vm.prank(carol);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.executeClose(first, _update(BTC_FEED, P0, requested + 24));
        vm.prank(operator);
        vm.expectRevert(Exchange.TooManyPositions.selector);
        ex.open(it, sig, entry);

        // By the time she may, the open has expired.
        vm.warp(requested + 24 + 61);
        vm.prank(carol);
        ex.executeClose(first, _update(BTC_FEED, P0, requested + 24));
        vm.prank(operator);
        vm.expectRevert(Exchange.IntentExpired.selector);
        ex.open(it, sig, entry);
    }
}
