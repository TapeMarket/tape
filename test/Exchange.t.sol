// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {Pricing} from "../src/Pricing.sol";
import {Sessions} from "../src/Sessions.sol";
import {Gateway} from "../src/periphery/Gateway.sol";
import {Lens} from "../src/periphery/Lens.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {Coin} from "../src/Coin.sol";
import {Staking} from "../src/Staking.sol";
import {LossMining} from "../src/LossMining.sol";
import {Sweeper} from "../src/periphery/Sweeper.sol";
import {MockPyth} from "./mocks/Mocks.sol";

contract ExchangeTest is Base {
    uint64 internal P0;

    function setUp() public override {
        super.setUp();
        P0 = _px(80_000);
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
    }

    function _winOf(uint64 entry, uint64 exit, uint256 notional, bool isLong)
        internal
        pure
        returns (uint256 gain, uint256 fee, uint256 profit)
    {
        (, gain) = _btcSettle(entry, exit, notional, isLong);
        fee = (gain * 200) / 10_000;
        profit = gain - fee;
    }

    // --------------------------------------------------------------------------------------
    // Collateral
    // --------------------------------------------------------------------------------------

    function test_deposit_creditsBalance() public view {
        assertEq(ex.balances(alice), 1_000e6);
        assertEq(ex.totalBalances(), 2_000e6);
        assertEq(ex.treasury(), 2_000e6);
        assertEq(ex.lpCash(), 0);
        _assertSolvent();
    }

    function test_deposit_rejectsZero() public {
        vm.prank(alice);
        vm.expectRevert(Exchange.ZeroAmount.selector);
        ex.deposit(0);
    }

    function test_depositFor_creditsSomeoneElse() public {
        usdc.mint(stranger, 50e6);
        vm.startPrank(stranger);
        usdc.approve(address(ex), 50e6);
        ex.depositFor(carol, 50e6);
        vm.stopPrank();
        assertEq(ex.balances(carol), 50e6);
        assertEq(ex.balances(stranger), 0);
    }

    function _permit(uint256 pk, uint256 amount, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address owner = vm.addr(pk);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                address(gateway),
                amount,
                usdc.nonces(owner),
                deadline
            )
        );
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_gateway_depositWithPermit_needsNoEthFromTheTrader() public {
        usdc.mint(carol, 200e6);
        (uint8 v, bytes32 r, bytes32 s) = _permit(carolPk, 200e6, vm.getBlockTimestamp() + 1 hours);
        assertEq(carol.balance, 0);

        vm.prank(operator);
        gateway.depositWithPermit(carol, 200e6, vm.getBlockTimestamp() + 1 hours, v, r, s);

        assertEq(ex.balances(carol), 200e6);
        assertEq(usdc.balanceOf(carol), 0);
        assertEq(usdc.balanceOf(address(gateway)), 0);
    }

    function test_gateway_frontRunPermitStillDeposits() public {
        usdc.mint(carol, 200e6);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(carolPk, 200e6, deadline);

        // Someone submits the permit straight to the token first.
        vm.prank(stranger);
        usdc.permit(carol, address(gateway), 200e6, deadline, v, r, s);

        vm.prank(operator);
        gateway.depositWithPermit(carol, 200e6, deadline, v, r, s);
        assertEq(ex.balances(carol), 200e6);
    }

    function test_gateway_strangerCannotSpendStandingAllowance() public {
        usdc.mint(carol, 200e6);
        vm.prank(carol);
        usdc.approve(address(gateway), type(uint256).max);

        vm.prank(stranger);
        vm.expectRevert(Gateway.PermitFailed.selector);
        gateway.depositWithPermit(carol, 200e6, vm.getBlockTimestamp(), 27, bytes32(0), bytes32(0));
    }

    function _withdrawSig(uint256 pk, address to, uint256 amount, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        address owner = vm.addr(pk);
        return _sign(
            pk,
            _digest(
                keccak256(
                    abi.encode(WITHDRAW_TYPEHASH, owner, to, amount, ex.withdrawNonces(owner), deadline)
                )
            )
        );
    }

    function test_withdrawBySig_paysOut() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _withdrawSig(alicePk, alice, 400e6, deadline);

        vm.prank(operator);
        ex.withdrawBySig(alice, alice, 400e6, deadline, sig);

        assertEq(usdc.balanceOf(alice), 400e6);
        assertEq(ex.balances(alice), 600e6);
        assertEq(ex.treasury(), 1_600e6);
        _assertSolvent();
    }

    function test_withdrawBySig_cannotBeReplayed() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _withdrawSig(alicePk, alice, 400e6, deadline);
        vm.startPrank(operator);
        ex.withdrawBySig(alice, alice, 400e6, deadline, sig);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.withdrawBySig(alice, alice, 400e6, deadline, sig);
        vm.stopPrank();
    }

    function test_withdrawBySig_rejectsOtherSignersAndSessionKeys() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 5 minutes);
        uint256 sessionPk = 0x5E55;
        vm.prank(alice);
        sessions.setSessionKey(vm.addr(sessionPk), uint64(vm.getBlockTimestamp() + 1 days));
        skip(12);

        // A session key can trade for Alice, but it cannot take her money out.
        bytes32 digest =
            _digest(keccak256(abi.encode(WITHDRAW_TYPEHASH, alice, stranger, 400e6, 0, deadline)));
        vm.startPrank(operator);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.withdrawBySig(alice, stranger, 400e6, deadline, _sign(sessionPk, digest));
        vm.expectRevert(Intents.BadSignature.selector);
        ex.withdrawBySig(alice, stranger, 400e6, deadline, _sign(bobPk, digest));
        vm.stopPrank();
    }

    function test_withdrawBySig_onlyOperatorAndNotExpired() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _withdrawSig(alicePk, alice, 400e6, deadline);

        vm.prank(alice);
        vm.expectRevert(Exchange.NotOperator.selector);
        ex.withdrawBySig(alice, alice, 400e6, deadline, sig);

        skip(6 minutes);
        vm.prank(operator);
        vm.expectRevert(Exchange.Expired.selector);
        ex.withdrawBySig(alice, alice, 400e6, deadline, sig);
    }

    function test_withdraw_cannotExceedBalance() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _withdrawSig(alicePk, alice, 1_001e6, deadline);
        vm.prank(operator);
        vm.expectRevert(Exchange.InsufficientBalance.selector);
        ex.withdrawBySig(alice, alice, 1_001e6, deadline, sig);
    }

    function test_directWithdraw_needsNoOperatorButWaits() public {
        vm.startPrank(alice);
        vm.expectRevert(Exchange.NoRequest.selector);
        ex.executeWithdraw(alice);

        ex.requestWithdraw(700e6);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.executeWithdraw(alice);

        skip(15 minutes);
        ex.executeWithdraw(alice);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), 700e6);
        assertEq(ex.balances(alice), 300e6);
        _assertSolvent();
    }

    function test_directWithdraw_paysWhatIsLeftIfLess() public {
        vm.prank(alice);
        ex.requestWithdraw(type(uint128).max);
        _open(alicePk, btc, true, 400e6, 10, P0);
        skip(15 minutes);
        vm.prank(alice);
        ex.executeWithdraw(alice);
        assertEq(usdc.balanceOf(alice), 600e6);
        assertEq(ex.balances(alice), 0);
    }

    function test_directWithdraw_requestingZeroCancels() public {
        vm.startPrank(alice);
        vm.expectRevert(Exchange.NoRequest.selector);
        ex.requestWithdraw(0);

        ex.requestWithdraw(700e6);
        ex.requestWithdraw(0);
        skip(15 minutes);
        vm.expectRevert(Exchange.NoRequest.selector);
        ex.executeWithdraw(alice);
        vm.stopPrank();
    }

    function test_directWithdraw_oneRequestAtATime() public {
        vm.startPrank(alice);
        ex.requestWithdraw(700e6);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.requestWithdraw(900e6);

        // After cancelling, a new request has to wait out the freeze the old one still imposes.
        ex.requestWithdraw(0);
        skip(71);
        vm.expectRevert(Exchange.TooEarly.selector);
        ex.requestWithdraw(900e6);
        skip(1);
        ex.requestWithdraw(900e6);
        vm.stopPrank();
    }

    /// @dev An account that has asked to leave cannot open. That is what stops a matured request
    ///      from being used to pull the margin out from under an open already signed.
    function test_directWithdraw_freezesNewOpens() public {
        vm.prank(alice);
        ex.requestWithdraw(1);

        // Fifteen minutes later the request has matured, and still nothing can be opened.
        skip(15 minutes);
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        _expectOpenRevert(alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.ExitPending.selector);

        // Cancelling does not bring that order back to life: it was stamped before the cancel.
        vm.prank(alice);
        ex.requestWithdraw(0);
        _expectOpenRevert(alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.ExitPending.selector);
        Intents.OpenIntent memory soon = _intent(alice, btc, true, 100e6, 100);
        _expectOpenRevert(
            alicePk, soon, _update(BTC_FEED, P0, soon.timestamp + 2), Exchange.ExitPending.selector
        );

        // One slot after the cancel, trading resumes.
        skip(12);
        _open(alicePk, btc, true, 100e6, 100, P0);
    }

    function test_directWithdraw_executingLiftsTheFreeze() public {
        vm.startPrank(alice);
        ex.requestWithdraw(400e6);
        skip(15 minutes);
        ex.executeWithdraw(alice);
        vm.stopPrank();
        skip(12);
        _open(alicePk, btc, true, 100e6, 100, P0);
        assertEq(ex.balances(alice), 500e6);
    }

    /// @dev A pending exit must not be usable to cancel an intent already sent.
    function test_requestWithdraw_doesNotBlockAPendingIntent() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 1_000e6, 10);
        vm.prank(alice);
        ex.requestWithdraw(1_000e6);
        _submitOpen(alicePk, it, P0);
        assertEq(ex.balances(alice), 0);
    }

    // --------------------------------------------------------------------------------------
    // Session keys
    // --------------------------------------------------------------------------------------

    uint256 internal constant SESSION_PK = 0x5E5510;

    /// @dev Registers the test session key by signature and waits the slot until it can sign.
    function _registerSession(uint256 ownerPk, uint64 validUntil) internal {
        address owner = vm.addr(ownerPk);
        address key = vm.addr(SESSION_PK);
        bytes memory sig = _sign(ownerPk, _sessionDigest(owner, key, validUntil));
        vm.prank(stranger);
        sessions.setSessionKeyBySig(owner, key, validUntil, sig);
        skip(12);
    }

    function _expectSessionRejected(Intents.OpenIntent memory it) internal {
        bytes memory sig = _sign(SESSION_PK, _hashOpen(it));
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);
        vm.prank(operator);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.open(it, sig, update);
    }

    function test_sessionKey_registeredBySigCanTrade() public {
        _registerSession(alicePk, uint64(vm.getBlockTimestamp() + 30 days));
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes32 id = _submitOpen(SESSION_PK, it, P0);
        assertEq(ex.getPosition(id).owner, alice);

        _close(SESSION_PK, id, P0);
        assertEq(ex.getPosition(id).owner, address(0));
    }

    function test_sessionKey_registrationCannotBeReplayedOrForged() public {
        uint64 validUntil = uint64(vm.getBlockTimestamp() + 30 days);
        address key = vm.addr(SESSION_PK);
        bytes memory sig = _sign(alicePk, _sessionDigest(alice, key, validUntil));
        sessions.setSessionKeyBySig(alice, key, validUntil, sig);

        vm.expectRevert(Sessions.BadSignature.selector);
        sessions.setSessionKeyBySig(alice, key, validUntil, sig);

        bytes memory forged = _sign(bobPk, _sessionDigest(alice, key, validUntil));
        vm.expectRevert(Sessions.BadSignature.selector);
        sessions.setSessionKeyBySig(alice, key, validUntil, forged);
    }

    function test_sessionKey_expiryIsBounded() public {
        vm.startPrank(alice);
        // Shorter than one slot would be a way to cancel orders already in flight.
        vm.expectRevert(Sessions.BadExpiry.selector);
        sessions.setSessionKey(vm.addr(SESSION_PK), uint64(vm.getBlockTimestamp() + 12));
        vm.expectRevert(Sessions.BadExpiry.selector);
        sessions.setSessionKey(vm.addr(SESSION_PK), uint64(vm.getBlockTimestamp() + 90 days + 1));
        vm.expectRevert(Sessions.ZeroKey.selector);
        sessions.setSessionKey(address(0), uint64(vm.getBlockTimestamp() + 1 days));
        sessions.setSessionKey(vm.addr(SESSION_PK), uint64(vm.getBlockTimestamp() + 90 days));
        vm.stopPrank();
    }

    function test_sessionKey_onlyWorksForItsOwner() public {
        _registerSession(alicePk, uint64(vm.getBlockTimestamp() + 30 days));
        _expectSessionRejected(_intent(bob, btc, true, 100e6, 100));
    }

    function test_sessionKey_expiredKeyCannotSign() public {
        _registerSession(alicePk, uint64(vm.getBlockTimestamp() + 1 days));
        skip(1 days);
        _expectSessionRejected(_intent(alice, btc, true, 100e6, 100));
    }

    /// @dev Registering a key must not bring to life an order it signed earlier: by then the
    ///      order's price is known, and the trader would register only if it went their way.
    function test_sessionKey_cannotSignForATimeBeforeItWasRegistered() public {
        // Signed with a key nobody has registered. Dead on arrival.
        Intents.OpenIntent memory early = _intent(alice, btc, true, 100e6, 1_000);
        _expectSessionRejected(early);

        // Twelve seconds on, the price is public. Registering the key now does not revive it...
        skip(12);
        vm.prank(alice);
        sessions.setSessionKey(vm.addr(SESSION_PK), uint64(vm.getBlockTimestamp() + 1 days));
        _expectSessionRejected(early);

        // ...nor does it validate anything stamped in the slot the registration landed in.
        _expectSessionRejected(_intent(alice, btc, true, 100e6, 1_000));
        skip(11);
        _expectSessionRejected(_intent(alice, btc, true, 100e6, 1_000));

        skip(1);
        _submitOpen(SESSION_PK, _intent(alice, btc, true, 100e6, 1_000), P0);
    }

    /// @dev Revoking must not cancel an order that was already signed: that would be a free option.
    function test_revoke_doesNotCancelIntentsAlreadySigned() public {
        _registerSession(alicePk, uint64(vm.getBlockTimestamp() + 30 days));
        Intents.OpenIntent memory inFlight = _intent(alice, btc, true, 100e6, 100);

        vm.prank(alice);
        sessions.revokeSessionKey(vm.addr(SESSION_PK));
        (, uint64 validUntil) = sessions.sessionKeys(alice, vm.addr(SESSION_PK));
        assertEq(validUntil, vm.getBlockTimestamp() + 12);

        bytes32 id = _submitOpen(SESSION_PK, inFlight, P0);
        assertEq(ex.getPosition(id).owner, alice);
    }

    function test_revoke_stopsEverythingSignedAfterTheCutoff() public {
        _registerSession(alicePk, uint64(vm.getBlockTimestamp() + 30 days));
        vm.prank(alice);
        sessions.revokeSessionKey(vm.addr(SESSION_PK));
        skip(12);
        _expectSessionRejected(_intent(alice, btc, true, 100e6, 100));
    }

    function test_revoke_neverExtendsAKey() public {
        uint64 validUntil = uint64(vm.getBlockTimestamp() + 30);
        _registerSession(alicePk, validUntil);
        skip(10);
        vm.prank(alice);
        sessions.revokeSessionKey(vm.addr(SESSION_PK));
        (, uint64 stored) = sessions.sessionKeys(alice, vm.addr(SESSION_PK));
        assertEq(stored, validUntil);
    }

    /// @dev A key that has ended stays ended. Reopening it would have to either revive the orders
    ///      it signed after its cut-off, or cancel the ones it signed before.
    function test_sessionKey_onceEndedIsNeverReopened() public {
        _registerSession(alicePk, uint64(vm.getBlockTimestamp() + 30 days));
        vm.startPrank(alice);
        sessions.revokeSessionKey(vm.addr(SESSION_PK));
        vm.expectRevert(Sessions.KeyRetired.selector);
        sessions.setSessionKey(vm.addr(SESSION_PK), uint64(vm.getBlockTimestamp() + 1 days));
        skip(1 hours);
        vm.expectRevert(Sessions.KeyRetired.selector);
        sessions.setSessionKey(vm.addr(SESSION_PK), uint64(vm.getBlockTimestamp() + 1 days));
        vm.stopPrank();
    }

    function test_sessionKey_aLiveKeyCanBeExtendedWithoutAGap() public {
        _registerSession(alicePk, uint64(vm.getBlockTimestamp() + 1 days));
        (uint64 validFrom,) = sessions.sessionKeys(alice, vm.addr(SESSION_PK));
        Intents.OpenIntent memory inFlight = _intent(alice, btc, true, 100e6, 100);

        vm.prank(alice);
        sessions.setSessionKey(vm.addr(SESSION_PK), uint64(vm.getBlockTimestamp() + 60 days));
        (uint64 stillFrom, uint64 validUntil) = sessions.sessionKeys(alice, vm.addr(SESSION_PK));
        assertEq(stillFrom, validFrom, "extending does not move the start");
        assertEq(validUntil, vm.getBlockTimestamp() + 60 days);

        _submitOpen(SESSION_PK, inFlight, P0);
    }

    function test_sessions_answerOnlyForTheirOwnOwner() public view {
        assertFalse(sessions.isValid(alice, vm.addr(SESSION_PK), uint64(vm.getBlockTimestamp())));
        assertFalse(sessions.isValid(alice, alice, uint64(vm.getBlockTimestamp())));
    }

    // --------------------------------------------------------------------------------------
    // Open
    // --------------------------------------------------------------------------------------

    function test_open_storesThePosition() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);

        Exchange.Position memory p = ex.getPosition(id);
        assertEq(p.owner, alice);
        assertEq(p.market, btc);
        assertEq(p.leverage, 100);
        assertTrue(p.isLong);
        assertEq(p.margin, 100e6);
        assertEq(p.debtMargin, 0);
        assertEq(p.entryPrice, P0);
        assertEq(p.openTime, T0 + 2);

        assertEq(ex.balances(alice), 900e6);
        assertEq(ex.totalCashMargin(), 100e6);
        assertEq(ex.getMarket(btc).oiLong, 10_000e6);
        assertEq(ex.lpCash(), 0);

        Lens.PositionView[] memory open = lens.positionsOf(alice);
        assertEq(open.length, 1);
        assertEq(open[0].id, id);
        assertEq(open[0].bustPrice, 79_237.7e8);
        _assertSolvent();
    }

    function test_open_idIsTheIntentHash() public {
        Intents.OpenIntent memory it = _intent(alice, btc, false, 100e6, 50);
        bytes32 expected = _hashOpen(it);
        assertEq(_submitOpen(alicePk, it, P0), expected);
    }

    function _expectOpenRevert(
        uint256 pk,
        Intents.OpenIntent memory it,
        bytes[] memory update,
        bytes4 selector
    ) internal {
        bytes memory sig = _sign(pk, _hashOpen(it));
        vm.prank(operator);
        vm.expectRevert(selector);
        ex.open(it, sig, update);
    }

    function test_open_onlyOperator() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes memory sig = _sign(alicePk, _hashOpen(it));
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);
        vm.prank(alice);
        vm.expectRevert(Exchange.NotOperator.selector);
        ex.open(it, sig, update);
    }

    function test_open_cannotBeReplayed() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes32 id = _submitOpen(alicePk, it, P0);
        _close(alicePk, id, P0);
        _expectOpenRevert(alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.IntentUsed.selector);
    }

    function test_open_expiresAfterTtl() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);
        skip(61);
        _expectOpenRevert(alicePk, it, update, Exchange.IntentExpired.selector);
    }

    function test_open_rejectsASignatureFromSomeoneElse() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        _expectOpenRevert(bobPk, it, _update(BTC_FEED, P0, it.timestamp + 2), Intents.BadSignature.selector);
    }

    function test_open_validatesTheOrder() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 0);
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);
        _expectOpenRevert(alicePk, it, update, Exchange.BadLeverage.selector);

        it = _intent(alice, btc, true, 100e6, 1_001);
        _expectOpenRevert(alicePk, it, update, Exchange.BadLeverage.selector);

        it = _intent(alice, btc, true, 1e6 - 1, 10);
        _expectOpenRevert(alicePk, it, update, Exchange.MarginTooSmall.selector);

        it = _intent(alice, 7, true, 100e6, 10);
        _expectOpenRevert(alicePk, it, update, Exchange.BadMarket.selector);

        it = _intent(alice, btc, true, 1_001e6, 10);
        _expectOpenRevert(alicePk, it, update, Exchange.InsufficientBalance.selector);
    }

    function test_open_capsNotionalAndOpenInterest() public {
        _fund(carol, 20_000e6);
        Intents.OpenIntent memory it = _intent(carol, btc, true, 10_001e6, 1_000);
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);
        _expectOpenRevert(carolPk, it, update, Exchange.NotionalTooLarge.selector);

        vm.prank(admin);
        ex.setCaps(btc, 5_000e6, 1e15);
        it = _intent(carol, btc, true, 100e6, 51);
        _expectOpenRevert(carolPk, it, update, Exchange.OpenInterestCap.selector);

        // The short side has its own cap.
        _open(carolPk, btc, false, 100e6, 51, P0);
    }

    function test_open_respectsThePriceLimit() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        it.priceLimit = P0 - 1;
        _expectOpenRevert(
            alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.PriceLimitExceeded.selector
        );

        it = _intent(alice, btc, false, 100e6, 100);
        it.priceLimit = P0 + 1;
        _expectOpenRevert(
            alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.PriceLimitExceeded.selector
        );

        it = _intent(alice, btc, true, 100e6, 100);
        it.priceLimit = P0;
        _submitOpen(alicePk, it, P0);
    }

    function test_open_refusesAWideConfidenceInterval() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        // 51 bps of confidence against a 50 bps limit.
        bytes[] memory update =
            _updateFull(BTC_FEED, P0, (P0 * 51) / 10_000, it.timestamp + 2, it.timestamp + 1);
        _expectOpenRevert(alicePk, it, update, Exchange.ConfidenceTooWide.selector);
    }

    /// @dev The fill is the FIRST price at or after timestamp + 2s. Nothing else is accepted.
    function test_open_priceIsPinnedToOneUpdate() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        uint64 pin = it.timestamp + 2;

        // Too early.
        _expectOpenRevert(
            alicePk, it, _update(BTC_FEED, P0, pin - 1), _noPrice()
        );
        // A later print in the window, when an earlier one existed.
        _expectOpenRevert(
            alicePk,
            it,
            _updateFull(BTC_FEED, P0, 0, pin + 3, pin),
            _noPrice()
        );
        // Past the window.
        _expectOpenRevert(
            alicePk, it, _update(BTC_FEED, P0, pin + 11), _noPrice()
        );
        // Another feed.
        _expectOpenRevert(
            alicePk, it, _update(ETH_FEED, P0, pin), _noPrice()
        );

        // Pyth skipped a few seconds: the first print after the pin is still the one.
        _submitOpenWith(alicePk, it, _updateFull(BTC_FEED, P0, 0, pin + 4, pin - 1));
    }

    function _submitOpenWith(uint256 pk, Intents.OpenIntent memory it, bytes[] memory update)
        internal
        returns (bytes32)
    {
        bytes memory sig = _sign(pk, _hashOpen(it));
        vm.prank(operator);
        return ex.open(it, sig, update);
    }

    /// @dev A price so small that the bust trigger would round onto the entry cannot be opened at
    ///      that leverage. Opened, such a position could never be closed.
    function test_open_refusesLeverageThePriceLeavesNoRoomFor() public {
        bytes32 feed = keccak256("PEPE/USD");
        vm.prank(admin);
        // Quoted to the last of its eight decimals: a tick of one.
        uint16 pepe = ex.listMarket(
            feed,
            "PEPE",
            1_000,
            Exchange.Curve(RATE, BTC_POSITION, 1, BTC_BUFFER, BOTTOMLESS),
            MAX_KEEP,
            50,
            10_000_000e6,
            1e15,
            1e15
        );

        // $0.0000085 with ten decimals is 850 at eight.
        Intents.OpenIntent memory it = _intent(alice, pepe, true, 100e6, 1_000);
        bytes[] memory update = _updateFull(feed, 850, 0, it.timestamp + 2, it.timestamp + 1);
        _expectOpenRevert(alicePk, it, update, Exchange.BadLeverage.selector);

        // At 100x there is room, and the position opens, closes and busts like any other.
        it = _intent(alice, pepe, true, 100e6, 100);
        update = _updateFull(feed, 850, 0, it.timestamp + 2, it.timestamp + 1);
        bytes32 id = _submitOpenWith(alicePk, it, update);
        assertEq(ex.getPosition(id).entryPrice, 850);
        skip(12);
        bytes[] memory touch = _updateFull(
            feed, 1, 0, uint64(vm.getBlockTimestamp()) - 1, uint64(vm.getBlockTimestamp()) - 2
        );
        vm.prank(operator);
        ex.liquidate(id, touch);
        assertEq(ex.totalCashMargin(), 0);
    }

    /// @dev As on the reference exchange: $10 of margin at least, and a position of $10,000 at least.
    function test_open_enforcesTheSmallestMarginAndPosition() public {
        vm.prank(admin);
        ex.setMinimums(10e6, 10_000e6);

        Intents.OpenIntent memory it = _intent(alice, btc, true, 10e6 - 1, 1_000);
        _expectOpenRevert(
            alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.MarginTooSmall.selector
        );
        // $10 at 999x is a $9,990 position.
        it = _intent(alice, btc, true, 10e6, 999);
        _expectOpenRevert(
            alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.NotionalTooSmall.selector
        );
        // $499.99 at 20x is $9,999.80.
        it = _intent(alice, btc, true, 499.99e6, 20);
        _expectOpenRevert(
            alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.NotionalTooSmall.selector
        );

        _open(alicePk, btc, true, 10e6, 1_000, P0);
        _open(alicePk, btc, false, 500e6, 20, P0);
        assertEq(ex.openIdsOf(alice).length, 2);
    }

    /// @dev What drained the reference exchange: hold far more of one side than the real market could absorb,
    ///      push the price the oracle reads a few basis points, and close at it. A fill and a
    ///      close cost the same whatever the size, so the win is paid on the whole position while
    ///      the push was paid for once. The cap on each side is what bounds it here: however many
    ///      wallets come, only so much can be open, and a move can only take the cap times itself.
    function test_caps_boundWhatMovingThePriceCanTake() public {
        uint96 cap = 2_000_000e6;
        vm.prank(admin);
        ex.setCaps(btc, cap, cap);
        _seedHouse(1_000_000e6);
        _fund(carol, 10_000e6);

        // Two wallets fill the long side with $1,000 of margin apiece...
        bytes32 a = _open(alicePk, btc, true, 1_000e6, 1_000, P0);
        bytes32 b = _open(carolPk, btc, true, 1_000e6, 1_000, P0);
        assertEq(ex.getMarket(btc).oiLong, cap);
        // ...and nobody adds to it: not a third wallet, not for a dollar.
        Intents.OpenIntent memory more = _intent(bob, btc, true, 1e6, 2);
        _expectOpenRevert(
            bobPk, more, _update(BTC_FEED, P0, more.timestamp + 2), Exchange.OpenInterestCap.selector
        );
        // The relayer's key cannot make room either.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        ex.setCaps(btc, type(uint96).max, type(uint96).max);

        // The price is pushed up 20 basis points and both are closed at it.
        uint64 pumped = uint64((uint256(P0) * 10_020) / 10_000);
        uint256 houseBefore = ex.lpCash();
        _close(alicePk, a, pumped);
        _close(carolPk, b, pumped);
        (, uint256 fee, uint256 profit) = _winOf(P0, pumped, 1_000_000e6, true);

        // All of it came out of the house, and all of it is the capped size times the move, less
        // the haircut: $4,000 here before any cut, whatever the attacker had ready to open.
        uint256 taken = houseBefore - ex.lpCash();
        assertEq(taken, 2 * (profit + fee));
        assertLt(taken, (uint256(cap) * 20) / 10_000);
        assertEq(ex.balances(alice) + ex.balances(carol), 1_000e6 + 10_000e6 + 2 * profit);
        _assertSolvent();
    }

    function test_open_limitsPositionsPerTrader() public {
        _fund(carol, 1_000e6);
        for (uint256 i; i < 200; ++i) {
            Intents.OpenIntent memory it = _intent(carol, btc, true, 1e6, 2);
            _submitOpenWith(carolPk, it, _update(BTC_FEED, P0, it.timestamp + 2));
        }
        Intents.OpenIntent memory extra = _intent(carol, btc, true, 1e6, 2);
        _expectOpenRevert(
            carolPk, extra, _update(BTC_FEED, P0, extra.timestamp + 2), Exchange.TooManyPositions.selector
        );
    }

    // --------------------------------------------------------------------------------------
    // Close
    // --------------------------------------------------------------------------------------

    function test_closeWin_paidInFullWhenTheHouseHasCash() public {
        _seedHouse(10_000e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(80_800));

        (, uint256 fee, uint256 profit) = _winOf(P0, _px(80_800), 10_000e6, true);
        assertGt(profit, 85e6);
        assertEq(ex.balances(alice), 1_000e6 + profit);
        assertEq(ex.stakerFees(), fee / 2);
        assertEq(ex.devFees(), fee - fee / 2);
        assertEq(ex.lpCash(), 10_000e6 - profit - fee);
        assertEq(ex.totalQueued(), 0);
        assertEq(ex.totalCashMargin(), 0);
        assertEq(ex.getMarket(btc).oiLong, 0);
        assertEq(ex.openIdsOf(alice).length, 0);
        _assertSolvent();
    }

    /// @dev The house starts from nothing. A win it cannot pay is queued, but margin never is.
    function test_closeWin_queuesProfitButReturnsMarginWhenTheHouseIsEmpty() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(80_800));

        (,, uint256 profit) = _winOf(P0, _px(80_800), 10_000e6, true);
        assertEq(ex.balances(alice), 1_000e6, "margin returned at once");
        assertEq(ex.queuedOf(alice), profit);
        assertEq(ex.totalQueued(), profit);
        assertEq(ex.stakerFees() + ex.devFees(), 0, "no fee is paid ahead of a queued winner");
        assertEq(ex.lpCash(), 0);
        assertEq(lens.house().equity, -int256(profit));
        _assertSolvent();
    }

    function test_closeWin_paysWhatItCanAndQueuesTheRest() public {
        _seedHouse(50e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(80_800));

        (,, uint256 profit) = _winOf(P0, _px(80_800), 10_000e6, true);
        assertEq(ex.balances(alice), 1_050e6);
        assertEq(ex.queuedOf(alice), profit - 50e6);
        assertEq(ex.stakerFees() + ex.devFees(), 0);
        assertEq(ex.lpCash(), 0);
    }

    function test_closeWin_feeIsPaidOnlyIfTheHouseCoversItToo() public {
        (, uint256 fee, uint256 profit) = _winOf(P0, _px(80_800), 10_000e6, true);

        _seedHouse(profit + fee - 1);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(80_800));
        assertEq(ex.balances(alice), 1_000e6 + profit);
        assertEq(ex.stakerFees() + ex.devFees(), 0);
        assertEq(ex.lpCash(), fee - 1, "an unpaid fee stays with the house");

        _seedHouse(profit + 1);
        id = _open(bobPk, btc, true, 100e6, 100, P0);
        _close(bobPk, id, _px(80_800));
        assertEq(ex.stakerFees() + ex.devFees(), fee);
        assertEq(ex.lpCash(), 0);
    }

    function test_closeWin_short() public {
        _seedHouse(10_000e6);
        bytes32 id = _open(alicePk, btc, false, 100e6, 100, P0);
        _close(alicePk, id, _px(79_200));
        (,, uint256 profit) = _winOf(P0, _px(79_200), 10_000e6, false);
        assertEq(ex.balances(alice), 1_000e6 + profit);
        assertEq(ex.getMarket(btc).oiShort, 0);
    }

    /// @dev A loss costs the loss. The house-side fee comes out of what the house gained.
    function test_closeLoss_feeIsCarvedFromTheHouseNotTheTrader() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(79_600));

        assertEq(ex.balances(alice), 950e6, "0.5% of 10,000 and not a cent more");
        assertEq(ex.stakerFees(), 0.5e6);
        assertEq(ex.devFees(), 0.5e6);
        assertEq(ex.lpCash(), 49e6);
        _assertSolvent();
    }

    function test_closeLoss_goesToQueuedWinnersWithNoFee() public {
        bytes32 bobId = _open(bobPk, btc, true, 100e6, 100, P0);
        _close(bobPk, bobId, _px(80_800));
        (,, uint256 profit) = _winOf(P0, _px(80_800), 10_000e6, true);
        assertEq(ex.queuedOf(bob), profit);

        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, _px(79_600));

        assertEq(ex.balances(alice), 950e6);
        assertEq(ex.stakerFees() + ex.devFees(), 0, "queued winners come before fees");
        assertEq(ex.balances(bob), 1_050e6, "paid the moment the loss landed");
        assertEq(ex.queuedOf(bob), profit - 50e6);
        assertEq(ex.lpCash(), 0);
        _assertSolvent();
    }

    function test_close_atFlatPriceReturnsTheMargin() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, P0);
        assertEq(ex.balances(alice), 1_000e6);
        assertEq(ex.lpCash(), 0);
    }

    function test_close_insideTheDeadbandPaysNothing() public {
        _seedHouse(1_000e6);
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        _close(alicePk, id, P0 + P0 / 50_000);
        assertEq(ex.balances(alice), 1_000e6);
        assertEq(ex.lpCash(), 1_000e6);
    }

    /// @dev A close that prices at or beyond the trigger is a bust like any other.
    function test_close_pricedBeyondBustForfeitsTheMargin() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        vm.expectEmit(true, true, true, true);
        emit Exchange.PositionClosed(
            id, alice, btc, Exchange.CloseKind.Liquidation, 79_237.7e8, -100e6, 0, 0, 2e6
        );
        _close(alicePk, id, 79_237.7e8);
        assertEq(ex.balances(alice), 900e6);
        assertEq(ex.lpCash(), 98e6);
    }

    function test_close_justInsideBustKeepsTheRemainder() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        _close(alicePk, id, 79_237.7e8 + 1);
        // Loss is 762.29999999 / 80,000 of 10,000, a hair under $95.2875. The buffer is what is left.
        assertApproxEqAbs(ex.balances(alice), 904.7125e6, 1);
    }

    function test_close_mustPriceAfterTheOpen() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        // Pyth skipped ahead: the entry printed five seconds after the pin.
        bytes32 id =
            _submitOpenWith(alicePk, it, _updateFull(BTC_FEED, P0, 0, it.timestamp + 7, it.timestamp + 1));

        Intents.CloseIntent memory c = Intents.CloseIntent(alice, id, it.timestamp);
        bytes memory sig = _sign(alicePk, _hashClose(c));
        // First print at or after the close pin is the entry print itself.
        bytes[] memory update = _updateFull(BTC_FEED, _px(81_000), 0, it.timestamp + 7, it.timestamp + 1);
        vm.prank(operator);
        vm.expectRevert(Exchange.CloseNotAfterOpen.selector);
        ex.close(c, sig, update);
    }

    function test_close_checksOwnerSignatureAndExpiry() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        uint64 ts = uint64(vm.getBlockTimestamp());
        bytes[] memory update = _update(BTC_FEED, P0, ts + 2);

        Intents.CloseIntent memory c = Intents.CloseIntent(bob, id, ts);
        bytes memory sig = _sign(bobPk, _hashClose(c));
        vm.prank(operator);
        vm.expectRevert(Exchange.NotPositionOwner.selector);
        ex.close(c, sig, update);

        c = Intents.CloseIntent(alice, id, ts);
        sig = _sign(bobPk, _hashClose(c));
        vm.prank(operator);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.close(c, sig, update);

        sig = _sign(alicePk, _hashClose(c));
        vm.prank(alice);
        vm.expectRevert(Exchange.NotOperator.selector);
        ex.close(c, sig, update);

        skip(61);
        vm.prank(operator);
        vm.expectRevert(Exchange.IntentExpired.selector);
        ex.close(c, sig, update);

        c = Intents.CloseIntent(alice, bytes32(uint256(1)), ts);
        sig = _sign(alicePk, _hashClose(c));
        vm.prank(operator);
        vm.expectRevert(Exchange.NoPosition.selector);
        ex.close(c, sig, update);
    }

    function test_close_keepsTheOwnersListConsistent() public {
        bytes32 a = _open(alicePk, btc, true, 10e6, 10, P0);
        bytes32 b = _open(alicePk, btc, false, 10e6, 10, P0);
        bytes32 c = _open(alicePk, eth, true, 10e6, 10, _px(2_500));

        _close(alicePk, a, P0);
        bytes32[] memory ids = ex.openIdsOf(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], c);
        assertEq(ids[1], b);
        assertEq(ex.getPosition(c).index, 0);

        _close(alicePk, c, _px(2_500));
        _close(alicePk, b, P0);
        assertEq(ex.openIdsOf(alice).length, 0);
        assertEq(ex.balances(alice), 1_000e6);
    }

    // --------------------------------------------------------------------------------------
    // Liquidation
    // --------------------------------------------------------------------------------------

    function test_liquidate_operatorBustsAtOnce() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        // $80 of room, less 4.76 bps of the $79,920 where the margin is gone.
        assertEq(lens.positionsOf(alice)[0].bustPrice, 79_958e8);
        _liquidate(id, 79_958e8);

        assertEq(ex.balances(alice), 900e6);
        assertEq(ex.getPosition(id).owner, address(0));
        assertEq(ex.stakerFees() + ex.devFees(), 2e6);
        assertEq(ex.lpCash(), 98e6);
        _assertSolvent();
    }

    function test_liquidate_shortSide() public {
        bytes32 id = _open(alicePk, btc, false, 100e6, 1_000, P0);
        assertEq(lens.positionsOf(alice)[0].bustPrice, 80_041.9e8);
        _liquidate(id, 80_041.9e8);
        assertEq(ex.balances(alice), 900e6);
    }

    function test_liquidate_needsTheTriggerTouched() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        skip(12);
        bytes[] memory update = _update(BTC_FEED, _px(79_960) + 1, uint64(vm.getBlockTimestamp()) - 1);
        vm.prank(operator);
        vm.expectRevert(Exchange.NotLiquidatable.selector);
        ex.liquidate(id, update);
    }

    /// @dev A touch counts even if price has since recovered: the proof is the print itself.
    function test_liquidate_aTouchIsEnoughEvenIfPriceRecovered() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        uint64 touchTime = uint64(vm.getBlockTimestamp()) + 3;
        skip(40);
        vm.prank(operator);
        ex.liquidate(id, _update(BTC_FEED, _px(79_900), touchTime));
        assertEq(ex.balances(alice), 900e6);
    }

    function test_liquidate_proofMustPostdateTheEntry() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        uint64 openTime = ex.getPosition(id).openTime;
        vm.prank(operator);
        vm.expectRevert(_noPrice());
        ex.liquidate(id, _update(BTC_FEED, _px(70_000), openTime));
    }

    /// @dev Anyone may liquidate, but only once no close signed before the touch can still land.
    function test_liquidate_publicWaitsOutInFlightCloses() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        uint64 touchTime = uint64(vm.getBlockTimestamp()) + 1;
        bytes[] memory proof = _update(BTC_FEED, _px(79_900), touchTime);

        skip(12);
        vm.prank(stranger);
        vm.expectRevert(Exchange.LiquidationGrace.selector);
        ex.liquidate(id, proof);

        vm.warp(touchTime + 60);
        vm.prank(stranger);
        vm.expectRevert(Exchange.LiquidationGrace.selector);
        ex.liquidate(id, proof);

        vm.warp(touchTime + 61);
        vm.prank(stranger);
        ex.liquidate(id, proof);
        assertEq(ex.getPosition(id).owner, address(0));
    }

    function test_liquidate_unknownPosition() public {
        vm.prank(operator);
        vm.expectRevert(Exchange.NoPosition.selector);
        ex.liquidate(bytes32(uint256(1)), _update(BTC_FEED, P0, T0));
    }

    // --------------------------------------------------------------------------------------
    // Oracle
    // --------------------------------------------------------------------------------------

    function test_oracle_onlyTheExchange() public pythOnly {
        vm.expectRevert(PythOracle.NotExchange.selector);
        oracle.pinned(BTC_FEED, _update(BTC_FEED, P0, T0), T0, T0 + 10);
        vm.expectRevert(PythOracle.NotExchange.selector);
        oracle.within(BTC_FEED, _update(BTC_FEED, P0, T0), T0, T0 + 10);
    }

    function test_oracle_rescalesOtherExponents() public pythOnly {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes[] memory update = new bytes[](1);
        // 80,000 quoted with five decimals.
        update[0] =
            abi.encode(BTC_FEED, int64(80_000e5), uint64(0), int32(-5), it.timestamp + 2, it.timestamp + 1);
        bytes32 id = _submitOpenWith(alicePk, it, update);
        assertEq(ex.getPosition(id).entryPrice, P0);
    }

    function test_oracle_rejectsNonPositivePrices() public pythOnly {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes[] memory update = new bytes[](1);
        update[0] = abi.encode(BTC_FEED, int64(-1), uint64(0), int32(-8), it.timestamp + 2, it.timestamp + 1);
        _expectOpenRevert(alicePk, it, update, PythOracle.NonPositivePrice.selector);
    }

    function test_oracle_paysThePythFeeFromItsFloat() public pythOnly {
        pyth.setFee(1 gwei);
        uint256 before = address(oracle).balance;
        _open(alicePk, btc, true, 100e6, 100, P0);
        assertEq(address(oracle).balance, before - 1 gwei);
    }

    function test_oracle_revertsWhenTheFloatIsEmpty() public pythOnly {
        pyth.setFee(2 ether);
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes memory sig = _sign(alicePk, _hashOpen(it));
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PythOracle.InsufficientFloat.selector, 2 ether, 1 ether));
        ex.open(it, sig, update);
    }

    // --------------------------------------------------------------------------------------
    // Administration
    // --------------------------------------------------------------------------------------

    function test_listMarket_boundsItsParameters() public {
        Exchange.Curve memory c = _btcCurve();
        vm.startPrank(admin);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(bytes32(0), "X", 1_000, c, MAX_KEEP, 50, 1e12, 1e15, 1e15);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(BTC_FEED, "X", 1_001, c, MAX_KEEP, 50, 1e12, 1e15, 1e15);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(BTC_FEED, "X", 0, c, MAX_KEEP, 50, 1e12, 1e15, 1e15);
        // The haircut can never be set to take more than half of a large win.
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(BTC_FEED, "X", 1_000, c, 4_999, 50, 1e12, 1e15, 1e15);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(BTC_FEED, "X", 1_000, c, 10_001, 50, 1e12, 1e15, 1e15);
        // The curve needs both its parameters and a tick to divide by...
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(
            BTC_FEED,
            "X",
            1_000,
            Exchange.Curve(0, BTC_POSITION, BTC_TICK, BTC_BUFFER, BOTTOMLESS),
            MAX_KEEP,
            50,
            1e12,
            1e15,
            1e15
        );
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(
            BTC_FEED,
            "X",
            1_000,
            Exchange.Curve(RATE, 0, BTC_TICK, BTC_BUFFER, BOTTOMLESS),
            MAX_KEEP,
            50,
            1e12,
            1e15,
            1e15
        );
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(
            BTC_FEED,
            "X",
            1_000,
            Exchange.Curve(RATE, BTC_POSITION, 0, BTC_BUFFER, BOTTOMLESS),
            MAX_KEEP,
            50,
            1e12,
            1e15,
            1e15
        );
        // ...and the bust trigger can sit at most 1% before the price where the margin is gone.
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(
            BTC_FEED,
            "X",
            1_000,
            Exchange.Curve(RATE, BTC_POSITION, BTC_TICK, 1e16 + 1, BOTTOMLESS),
            MAX_KEEP,
            50,
            1e12,
            1e15,
            1e15
        );
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(BTC_FEED, "X", 1_000, c, MAX_KEEP, 0, 1e12, 1e15, 1e15);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(BTC_FEED, "X", 1_000, c, MAX_KEEP, 1_001, 1e12, 1e15, 1e15);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(BTC_FEED, "X", 1_000, c, MAX_KEEP, 50, 0, 1e15, 1e15);
        assertEq(
            ex.listMarket(
                BTC_FEED, "X", 1_000, Exchange.Curve(1, 1, 1, 1e16, 1), MAX_KEEP, 50, 1e12, 1e15, 1e15
            ),
            2
        );
        vm.stopPrank();
        assertEq(ex.marketCount(), 3);
        assertEq(lens.markets().length, 3);

        Exchange.Market memory m = ex.getMarket(btc);
        assertEq(m.rateMultiplier, RATE);
        assertEq(m.positionMultiplier, BTC_POSITION);
        assertEq(m.tick, BTC_TICK);
        assertEq(m.bustBuffer, BTC_BUFFER);
    }

    function test_admin_rolesAreEnforced() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.listMarket(BTC_FEED, "X", 1_000, _btcCurve(), MAX_KEEP, 50, 1e12, 1e15, 1e15);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setOperator(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setGuardian(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setDevRecipient(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.attachCoin(address(usdc), address(pyth), address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setMinimums(0, 0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.unpauseOpens();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setCaps(btc, 0, 0);
        vm.expectRevert(Exchange.NotGuardian.selector);
        ex.pauseOpens();
        vm.expectRevert(Exchange.NotGuardian.selector);
        ex.retireMarket(btc, _update(BTC_FEED, P0, T0));
        vm.stopPrank();
    }

    function test_admin_operatorSettingsAreBounded() public {
        vm.startPrank(operator);
        // The smallest margin decides who can trade at all, and the caps decide how much the
        // house can be made to lose on one move. Both are the owner's call, not the operator's.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        ex.setMinimums(5e6, 0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        ex.setCaps(btc, type(uint96).max, type(uint96).max);
        vm.stopPrank();

        vm.startPrank(admin);
        vm.expectRevert(Exchange.BadMarket.selector);
        ex.setCaps(9, 0, 0);
        ex.setMinimums(5e6, 1_000e6);
        vm.stopPrank();
        assertEq(ex.minMargin(), 5e6);
        assertEq(ex.minNotional(), 1_000e6);
        assertEq(lens.house().minMargin, 5e6);
        assertEq(lens.house().minNotional, 1_000e6);
    }

    function test_admin_ownershipIsTwoStep() public {
        vm.prank(admin);
        ex.transferOwnership(stranger);
        assertEq(ex.owner(), admin);
        vm.prank(stranger);
        ex.acceptOwnership();
        assertEq(ex.owner(), stranger);
    }

    function test_pause_stopsOpensOnly() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        vm.prank(guardian);
        ex.pauseOpens();

        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        _expectOpenRevert(alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.OpensPaused.selector);

        _close(alicePk, id, P0);
        assertEq(ex.balances(alice), 1_000e6);

        // The guardian can stop the exchange; only the owner can start it again.
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        ex.unpauseOpens();
        vm.prank(admin);
        ex.unpauseOpens();
        _open(alicePk, btc, true, 100e6, 100, P0);
    }

    function test_retire_freezesThePriceForGood() public {
        _seedHouse(10_000e6);
        bytes32 longId = _open(alicePk, btc, true, 100e6, 100, P0);
        bytes32 shortId = _open(bobPk, btc, false, 100e6, 1_000, P0);

        vm.prank(guardian);
        ex.retireMarket(btc, _update(BTC_FEED, _px(80_800), uint64(vm.getBlockTimestamp()) - 10));
        assertTrue(ex.getMarket(btc).retired);
        assertEq(ex.getMarket(btc).frozenPrice, _px(80_800));

        // No new opens, ever.
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        _expectOpenRevert(
            alicePk, it, _update(BTC_FEED, P0, it.timestamp + 2), Exchange.MarketIsRetired.selector
        );
        vm.prank(guardian);
        vm.expectRevert(Exchange.MarketIsRetired.selector);
        ex.retireMarket(btc, _update(BTC_FEED, P0, uint64(vm.getBlockTimestamp())));

        // The long closes at the frozen price whatever the market does afterwards.
        _close(alicePk, longId, _px(60_000));
        (,, uint256 profit) = _winOf(P0, _px(80_800), 10_000e6, true);
        assertEq(ex.balances(alice), 1_000e6 + profit);

        // The short is past its trigger at the frozen price: anyone busts it, no proof needed.
        vm.prank(stranger);
        ex.liquidate(shortId, new bytes[](0));
        assertEq(ex.balances(bob), 900e6);

        // The other market is untouched.
        _open(alicePk, eth, true, 100e6, 100, _px(2_500));
        _assertSolvent();
    }

    function test_retire_needsAFreshPrice() public {
        skip(100);
        vm.prank(guardian);
        vm.expectRevert(_noPrice());
        ex.retireMarket(btc, _update(BTC_FEED, P0, uint64(vm.getBlockTimestamp()) - 61));
    }

    function test_attachCoin_onlyOnce() public {
        Coin c = new Coin("Tape", "TAPE", SUPPLY, address(this));
        Staking st = new Staking(IERC20(address(c)), IERC20(address(usdc)), address(ex));
        LossMining lm = new LossMining(IERC20(address(c)), address(ex), MINING_SCALE, address(0));
        Sweeper sw = _newSweeper(ex);

        vm.startPrank(admin);
        // Nothing that is not a contract of the right kind...
        vm.expectRevert();
        ex.attachCoin(address(0), address(lm), address(sw));
        vm.expectRevert();
        ex.attachCoin(address(st), stranger, address(sw));
        vm.expectRevert();
        ex.attachCoin(address(st), address(usdc), address(sw));
        vm.expectRevert();
        ex.attachCoin(address(st), address(lm), stranger);
        // ...and nothing of the right kind built for a different Exchange.
        Staking otherSt = new Staking(IERC20(address(c)), IERC20(address(usdc)), stranger);
        LossMining otherLm = new LossMining(IERC20(address(c)), stranger, MINING_SCALE, address(0));
        Sweeper otherSw = new Sweeper(Exchange(stranger), IPyth(address(pyth)));
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(otherSt), address(lm), address(sw));
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(st), address(otherLm), address(sw));
        vm.expectRevert(Exchange.BadParams.selector);
        ex.attachCoin(address(st), address(lm), address(otherSw));
        assertEq(ex.staking(), address(0));

        ex.attachCoin(address(st), address(lm), address(sw));
        assertEq(ex.staking(), address(st));
        assertEq(ex.lossMining(), address(lm));
        assertEq(ex.sweeper(), address(sw));
        vm.expectRevert(Exchange.AlreadyAttached.selector);
        ex.attachCoin(address(st), address(lm), address(sw));
        vm.stopPrank();
    }

    /// @dev Attaching is for good. The three contracts each built for this Exchange, handed over in
    ///      any wrong order, are refused: each kind answers only under its own name.
    function test_attachCoin_refusesTheRightContractsInTheWrongOrder() public {
        Coin c = new Coin("Tape", "TAPE", SUPPLY, address(this));
        address st = address(new Staking(IERC20(address(c)), IERC20(address(usdc)), address(ex)));
        address lm = address(new LossMining(IERC20(address(c)), address(ex), MINING_SCALE, address(0)));
        address sw = address(_newSweeper(ex));

        address[3][5] memory wrong = [[st, sw, lm], [lm, st, sw], [lm, sw, st], [sw, st, lm], [sw, lm, st]];
        vm.startPrank(admin);
        for (uint256 i; i < wrong.length; ++i) {
            vm.expectRevert();
            ex.attachCoin(wrong[i][0], wrong[i][1], wrong[i][2]);
        }
        // The same contract cannot fill two roles either.
        vm.expectRevert();
        ex.attachCoin(st, st, sw);
        vm.expectRevert();
        ex.attachCoin(st, lm, lm);
        assertEq(ex.staking(), address(0));
        assertEq(ex.lossMining(), address(0));
        assertEq(ex.sweeper(), address(0));

        ex.attachCoin(st, lm, sw);
        vm.stopPrank();
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(Exchange.ZeroAddress.selector);
        new Exchange("TAPE", usdc, oracle, pricing, sessions, admin, address(0), STAKER_CAP, MIN_MARGIN);
        vm.expectRevert(Exchange.ZeroAddress.selector);
        new Exchange("TAPE", usdc, oracle, pricing, Sessions(address(0)), admin, dev, STAKER_CAP, MIN_MARGIN);
        vm.expectRevert(Exchange.ZeroAddress.selector);
        new Exchange("TAPE", usdc, oracle, Pricing(address(0)), sessions, admin, dev, STAKER_CAP, MIN_MARGIN);
    }
}
