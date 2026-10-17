// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {PerpMath} from "../src/libraries/PerpMath.sol";

/// @notice Size costs. A market has a depth; a position opened on a side that already holds more
///         than that keeps less of a win. These tests hold the Exchange to what that is for: a
///         trader who fills a side and pushes the price is paid a fraction of what the curve alone
///         paid, however the size is cut up, while nobody inside the depth notices anything.
contract DepthTest is Base {
    uint32 internal constant DEPTH = 500_000;
    uint256 internal constant FEE_BPS = 200;

    uint64 internal P0;
    uint64 internal E0;

    event DepthSet(uint16 indexed id, uint32 depth);
    event PositionOpened(
        bytes32 indexed id,
        address indexed owner,
        uint16 indexed market,
        bool isLong,
        uint16 leverage,
        uint96 margin,
        uint96 debtMargin,
        uint64 entryPrice,
        uint64 entryTime,
        uint32 impactNotional
    );

    function setUp() public override {
        super.setUp();
        P0 = _px(80_000);
        E0 = _px(2_500);
        vm.startPrank(admin);
        ex.setDepth(btc, DEPTH);
        ex.setDepth(eth, DEPTH);
        vm.stopPrank();
        _fund(alice, 100_000e6);
        _fund(bob, 100_000e6);
        _fund(carol, 100_000e6);
        // Enough that every win in here is paid on the spot.
        _seedHouse(50_000_000e6);
    }

    // --------------------------------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------------------------------

    /// @dev A funded wallet nobody else in the test uses.
    function _wallet(uint256 i) internal returns (uint256 pk) {
        pk = 0xD0000 + i;
        _fund(vm.addr(pk), 200_000e6);
    }

    function _charge(bytes32 id) internal view returns (uint256) {
        return ex.getPosition(id).impactNotional;
    }

    function _up(uint64 price, uint256 bps) internal pure returns (uint64) {
        return uint64((uint256(price) * (10_000 + bps)) / 10_000);
    }

    /// @dev What a position closed at `exit` takes out of the house: its gain before the win fee.
    function _gain(Exchange.Position memory p, uint64 exit) internal view returns (uint256 amount) {
        bool win;
        (win, amount) = _settleOf(p, exit);
        assertTrue(win, "not a win");
    }

    /// @dev Fills the long side of `market` with `count` positions of `notional` dollars each, from
    ///      as many wallets, at `price`.
    function _fillLongs(uint16 market, uint256 count, uint256 notional, uint64 price, uint256 firstWallet)
        internal
        returns (uint256[] memory pks, bytes32[] memory ids)
    {
        pks = new uint256[](count);
        ids = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            pks[i] = _wallet(firstWallet + i);
            // A thousandth of the notional as margin, at 1000x. Bounded by the test's own sizes.
            // forge-lint: disable-next-line(unsafe-typecast)
            ids[i] = _open(pks[i], market, true, uint96(notional * 1e6 / 1_000), 1_000, price);
        }
    }

    /// @dev Closes them all at `exit` and returns what left the house.
    function _closeAll(uint256[] memory pks, bytes32[] memory ids, uint64 exit) internal returns (uint256) {
        uint256 before = ex.lpCash();
        for (uint256 i; i < ids.length; ++i) {
            _close(pks[i], ids[i], exit);
        }
        return before - ex.lpCash();
    }

    // --------------------------------------------------------------------------------------
    // Inside the depth nothing changes
    // --------------------------------------------------------------------------------------

    function test_upToTheDepthAPositionIsPricedAsTheReferencePricesIt() public {
        // $400,000 on an empty side stands at $200,000: well inside.
        bytes32 a = _open(alicePk, btc, true, 400e6, 1_000, P0);
        assertEq(_charge(a), REFERENCE);
        // $200,000 on top of it stands at $500,000, the depth itself: still the reference.
        bytes32 b = _open(bobPk, btc, true, 200e6, 1_000, P0);
        assertEq(_charge(b), REFERENCE);
        // Twenty dollars more on a side holding $600,000 stands at $600,010: 1.20002 depths.
        bytes32 c = _open(carolPk, btc, true, 10e6, 2, P0);
        assertEq(_charge(c), 120_002);

        // The first two win exactly what the reference exchange's curve pays, to the last unit.
        uint64 exit = _up(P0, 10);
        (, uint256 expected) = _btcSettle(P0, exit, 400_000e6, true);
        uint256 before = ex.balances(alice);
        _close(alicePk, a, exit);
        assertEq(ex.balances(alice) - before, 400e6 + expected - (expected * FEE_BPS) / 10_000);

        (, expected) = _btcSettle(P0, exit, 200_000e6, true);
        before = ex.balances(bob);
        _close(bobPk, b, exit);
        assertEq(ex.balances(bob) - before, 200e6 + expected - (expected * FEE_BPS) / 10_000);
        _assertSolvent();
    }

    function test_theOpeningSaysWhatThePositionIsChargedOn() public {
        _open(alicePk, btc, true, 5_000e6, 1_000, P0);
        Intents.OpenIntent memory it = _intent(bob, btc, true, 100e6, 1_000);
        bytes memory sig = _sign(bobPk, _hashOpen(it));
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);
        skip(12);
        // $100,000 on top of $5,000,000 stands at $5,050,000: 10.1 depths.
        vm.expectEmit(true, true, true, true, address(ex));
        emit PositionOpened(_hashOpen(it), bob, btc, true, 1_000, 100e6, 0, P0, it.timestamp + 2, 1_010_000);
        vm.prank(operator);
        ex.open(it, sig, update);
    }

    // --------------------------------------------------------------------------------------
    // Past it, a win keeps less. Nothing else moves.
    // --------------------------------------------------------------------------------------

    function test_pastTheDepthAWinKeepsLess() public {
        // $5,000,000 on an empty side stands at $2,500,000: five depths.
        bytes32 id = _open(alicePk, btc, true, 5_000e6, 1_000, P0);
        assertEq(_charge(id), 500_000);

        uint64 exit = _up(P0, 10);
        (, uint256 plain) = _btcSettle(P0, exit, 5_000_000e6, true);
        uint256 gain = _gain(ex.getPosition(id), exit);
        // Ten basis points: the plain keeps about three quarters, this about half.
        assertApproxEqRel(plain, (5_000_000e6 / 1_000) * 74 / 100, 0.03e18);
        assertApproxEqRel(gain, (5_000_000e6 / 1_000) * 51 / 100, 0.03e18);

        (bool busted, int256 quoted) = lens.quoteClose(id, exit);
        assertFalse(busted);
        assertEq(
            uint256(quoted), gain - (gain * FEE_BPS) / 10_000, "the lens quotes the position's own terms"
        );

        uint256 before = ex.balances(alice);
        uint256 house = ex.lpCash();
        _close(alicePk, id, exit);
        assertEq(ex.balances(alice) - before, 5_000e6 + gain - (gain * FEE_BPS) / 10_000);
        assertEq(house - ex.lpCash(), gain, "the house paid the gain and its fee out of it");
        _assertSolvent();
    }

    function test_aBigMoveStillKeepsNearlyAllOfIt() public {
        bytes32 id = _open(alicePk, btc, true, 5_000e6, 100, P0);
        // $500,000 at 100x stands inside the depth; make it a crowded side instead.
        assertEq(_charge(id), REFERENCE);
        _open(bobPk, btc, true, 9_500e6, 1_000, P0);
        bytes32 late = _open(carolPk, btc, true, 5_000e6, 100, P0);
        // $500,000 on top of $10,000,000: 20.5 depths.
        assertEq(_charge(late), 2_050_000);

        // Five percent: the size term is small against a move like that.
        uint64 exit = _up(P0, 500);
        (, uint256 plain) = _btcSettle(P0, exit, 500_000e6, true);
        uint256 gain = _gain(ex.getPosition(late), exit);
        assertGt(gain, (plain * 95) / 100);
        assertLt(gain, plain);
    }

    function test_aLossCostsTheSameWhateverTheSize() public {
        bytes32 id = _open(alicePk, btc, true, 5_000e6, 100, P0);
        bytes32 crowded = _open(bobPk, btc, true, 5_000e6, 100, P0);
        assertEq(_charge(id), REFERENCE);
        assertGt(_charge(crowded), REFERENCE);

        uint64 exit = uint64((uint256(P0) * 9_990) / 10_000);
        (bool win, uint256 loss) = _btcSettle(P0, exit, 500_000e6, true);
        assertFalse(win);
        uint256 aliceBefore = ex.balances(alice);
        uint256 bobBefore = ex.balances(bob);
        _close(alicePk, id, exit);
        _close(bobPk, crowded, exit);
        assertEq(ex.balances(alice) - aliceBefore, 5_000e6 - loss);
        assertEq(ex.balances(bob) - bobBefore, 5_000e6 - loss);
    }

    function test_theBustPriceDoesNotMoveWithSize() public {
        _open(alicePk, btc, true, 9_000e6, 1_000, P0);
        bytes32 id = _open(bobPk, btc, true, 1_000e6, 1_000, P0);
        assertGt(_charge(id), REFERENCE);
        uint256 bust = _btcBust(P0, 1_000, true);
        assertEq(_bustOf(id), bust);
        assertEq(lens.positionsOf(bob)[0].bustPrice, bust);

        // One tick short of it is not a bust; the trigger itself is.
        skip(12);
        bytes[] memory near = _update(BTC_FEED, uint64(bust) + BTC_TICK, uint64(vm.getBlockTimestamp()) - 1);
        vm.prank(operator);
        vm.expectRevert(Exchange.NotLiquidatable.selector);
        ex.liquidate(id, near);

        uint256 before = ex.balances(bob);
        _liquidate(id, uint64(bust));
        assertEq(ex.balances(bob), before, "a bust returns nothing");
        assertEq(ex.getPosition(id).owner, address(0));
    }

    // --------------------------------------------------------------------------------------
    // The charge follows the side, not the position
    // --------------------------------------------------------------------------------------

    /// @dev Cutting a position up, or spreading it over wallets, climbs the same stack.
    function test_splittingAPositionOverWalletsClimbsTheSameStack() public {
        (uint256[] memory pks, bytes32[] memory ids) = _fillLongs(btc, 10, 500_000, P0, 0);
        // Pieces of one depth each stand at 0.5, 1.5, 2.5 ... 9.5 depths.
        assertEq(_charge(ids[0]), REFERENCE);
        for (uint256 i = 1; i < 10; ++i) {
            assertEq(_charge(ids[i]), i * REFERENCE + REFERENCE / 2);
        }

        uint64 exit = _up(P0, 15);
        uint256 inPieces = _closeAll(pks, ids, exit);

        // The same $5,000,000 as one position on an empty side stands at five depths.
        assertEq(ex.getMarket(btc).oiLong, 0);
        bytes32 whole = _open(alicePk, btc, true, 5_000e6, 1_000, P0);
        assertEq(_charge(whole), 5 * REFERENCE);
        uint256 asOne = _gain(ex.getPosition(whole), exit);

        (, uint256 plain) = _btcSettle(P0, exit, 5_000_000e6, true);
        // Either way it is short of what the curve alone would pay...
        assertLt(inPieces, (plain * 85) / 100);
        assertLt(asOne, (plain * 85) / 100);
        // ...and the pieces buy little. They are charged on the same notional on average (the early
        // ones less, the late ones more), but what a win keeps is not a straight line in the
        // charge, so the pieces come out a few percent ahead. That does not grow with size.
        assertGt(inPieces, asOne);
        assertLt(inPieces, (asOne * 107) / 100);
    }

    function test_theTermsAreFixedAtOpen() public {
        bytes32 early = _open(alicePk, btc, true, 300e6, 1_000, P0);
        assertEq(_charge(early), REFERENCE);

        // A whale arrives on the same side. It is charged for what was there; nobody already in
        // is charged for it.
        bytes32 whale = _open(bobPk, btc, true, 10_000e6, 1_000, P0);
        assertEq(_charge(whale), 1_060_000);
        assertEq(_charge(early), REFERENCE);

        // Nor does a change of the depth reprice anyone...
        vm.expectEmit(true, true, true, true, address(ex));
        emit DepthSet(btc, 50_000);
        vm.prank(admin);
        ex.setDepth(btc, 50_000);
        assertEq(ex.getMarket(btc).depth, 50_000);
        assertEq(_charge(early), REFERENCE);
        assertEq(_charge(whale), 1_060_000);
        // ...it bites on whoever opens next: $10,000 on top of $10,300,000 at a depth of $50,000.
        bytes32 next = _open(carolPk, btc, true, 10e6, 1_000, P0);
        assertEq(_charge(next), 20_610_000);

        uint64 exit = _up(P0, 10);
        (, uint256 plain) = _btcSettle(P0, exit, 300_000e6, true);
        uint256 before = ex.balances(alice);
        _close(alicePk, early, exit);
        assertEq(ex.balances(alice) - before, 300e6 + plain - (plain * FEE_BPS) / 10_000);
    }

    function test_whoeverOpenedAboveAWhaleKeepsThoseTermsAfterItLeaves() public {
        bytes32 whale = _open(alicePk, btc, true, 10_000e6, 1_000, P0);
        bytes32 above = _open(bobPk, btc, true, 100e6, 1_000, P0);
        assertEq(_charge(above), 2_010_000);
        _close(alicePk, whale, P0);
        // The side is nearly empty again, and this position is still charged as it was. Closing
        // and opening again is how it gets today's terms.
        assertEq(ex.getMarket(btc).oiLong, 100_000e6);
        assertEq(_charge(above), 2_010_000);
        _close(bobPk, above, P0);
        bytes32 again = _open(bobPk, btc, true, 100e6, 1_000, P0);
        assertEq(_charge(again), REFERENCE);
    }

    function test_eachSideOfEachMarketIsItsOwnStack() public {
        _open(alicePk, btc, true, 10_000e6, 1_000, P0);
        // BTC longs are full of it. BTC shorts and both sides of ETH are not.
        bytes32 short = _open(bobPk, btc, false, 100e6, 1_000, P0);
        bytes32 ethLong = _open(bobPk, eth, true, 100e6, 1_000, E0);
        bytes32 ethShort = _open(carolPk, eth, false, 100e6, 1_000, E0);
        assertEq(_charge(short), REFERENCE);
        assertEq(_charge(ethLong), REFERENCE);
        assertEq(_charge(ethShort), REFERENCE);
        bytes32 long = _open(carolPk, btc, true, 100e6, 1_000, P0);
        assertEq(_charge(long), 2_010_000);
    }

    function test_shortsAreChargedAsLongsAre_andADirectCloseSettlesOnThePositionsOwnTerms() public {
        _open(alicePk, eth, false, 5_000e6, 1_000, E0);
        // $100,000 of shorts on top of $5,000,000: 10.1 depths.
        bytes32 id = _open(bobPk, eth, false, 100e6, 1_000, E0);
        assertEq(_charge(id), 1_010_000);
        assertEq(_bustOf(id), _ethBust(E0, 1_000, false));

        // Bob closes straight on the contract, with no relayer. The price is the one 24 seconds on.
        uint64 down = uint64((uint256(E0) * 9_990) / 10_000);
        vm.prank(bob);
        ex.requestClose(id);
        uint64 pin = uint64(vm.getBlockTimestamp()) + ex.DIRECT_DELAY();
        skip(36);
        uint256 gain = _gain(ex.getPosition(id), down);
        (, uint256 plain) = _ethSettle(E0, down, 100_000e6, false);
        assertLt(gain, (plain * 60) / 100, "ten depths deep, a 10 bps win keeps far less than the reference");
        uint256 before = ex.balances(bob);
        vm.prank(operator);
        ex.executeClose(id, _update(ETH_FEED, down, pin));
        assertEq(ex.balances(bob) - before, 100e6 + gain - (gain * FEE_BPS) / 10_000);
        _assertSolvent();
    }

    function test_aRetiredMarketSettlesEachPositionOnItsOwnTerms() public {
        bytes32 whale = _open(alicePk, btc, true, 9_000e6, 100, P0);
        bytes32 late = _open(bobPk, btc, true, 1_000e6, 100, P0);
        bytes32 loser = _open(carolPk, btc, false, 100e6, 1_000, P0);
        // $900,000 on an empty side stands inside the depth; $100,000 on top of it at 1.9 depths.
        assertEq(_charge(whale), REFERENCE);
        assertEq(_charge(late), 190_000);

        // Frozen half a percent up: both longs win, each on its own charge; the 1000x short is past
        // its trigger and can only be busted.
        uint64 frozen = _up(P0, 50);
        vm.prank(guardian);
        ex.retireMarket(btc, _update(BTC_FEED, frozen, uint64(vm.getBlockTimestamp()) - 10));

        uint256 whaleGain = _gain(ex.getPosition(whale), frozen);
        uint256 lateGain = _gain(ex.getPosition(late), frozen);
        // Per dollar of position, the one that opened on the crowded side keeps less.
        assertLt(lateGain * 9, whaleGain);
        uint256 before = ex.balances(bob);
        _close(bobPk, late, _px(1));
        assertEq(ex.balances(bob) - before, 1_000e6 + lateGain - (lateGain * FEE_BPS) / 10_000);
        before = ex.balances(alice);
        _close(alicePk, whale, _px(1));
        assertEq(ex.balances(alice) - before, 9_000e6 + whaleGain - (whaleGain * FEE_BPS) / 10_000);

        // A position short of its trigger at the frozen price cannot be liquidated; one past it can.
        bytes32 safe = _open(alicePk, eth, true, 100e6, 2, E0);
        vm.prank(guardian);
        ex.retireMarket(eth, _update(ETH_FEED, E0, uint64(vm.getBlockTimestamp()) - 10));
        vm.prank(stranger);
        vm.expectRevert(Exchange.NotLiquidatable.selector);
        ex.liquidate(safe, new bytes[](0));
        uint256 carolBefore = ex.balances(carol);
        vm.prank(stranger);
        ex.liquidate(loser, new bytes[](0));
        assertEq(ex.balances(carol), carolBefore, "a bust returns nothing");
        _assertSolvent();
    }

    // --------------------------------------------------------------------------------------
    // The order's own limit
    // --------------------------------------------------------------------------------------

    /// @dev What a position is charged on is decided when its order lands, and other orders can
    ///      fill the side between the signing and the landing. The order says how much of that
    ///      it will take, as it does for the price.
    function test_anOrderSaysTheMostItWillBeChargedOn() public {
        // Alice signs $100,000 of longs on an empty side: the reference charge, and no more.
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 1_000);
        it.impactLimit = uint32(REFERENCE);
        bytes memory sig = _sign(alicePk, _hashOpen(it));
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);

        // Ten million lands first. Her order would now be charged on 20.1 depths.
        _open(bobPk, btc, true, 10_000e6, 1_000, P0);
        vm.prank(operator);
        vm.expectRevert(Exchange.ImpactLimitExceeded.selector);
        ex.open(it, sig, update);
        assertEq(ex.balances(alice), 100_000e6, "nothing of hers moved");
        assertEq(ex.openIdsOf(alice).length, 0);

        // A limit of exactly what the side charges opens; a dollar under it does not; none at all
        // takes whatever the side charges.
        Intents.OpenIntent memory exact = _intent(alice, btc, true, 100e6, 1_000);
        exact.impactLimit = 2_010_000;
        assertEq(_charge(_submitOpen(alicePk, exact, P0)), 2_010_000);

        Intents.OpenIntent memory tight = _intent(carol, btc, true, 100e6, 1_000);
        tight.impactLimit = 2_029_999;
        sig = _sign(carolPk, _hashOpen(tight));
        update = _update(BTC_FEED, P0, tight.timestamp + 2);
        vm.prank(operator);
        vm.expectRevert(Exchange.ImpactLimitExceeded.selector);
        ex.open(tight, sig, update);

        Intents.OpenIntent memory open_ = _intent(carol, btc, true, 100e6, 1_000);
        assertEq(open_.impactLimit, 0);
        assertEq(_charge(_submitOpen(carolPk, open_, P0)), 2_030_000);
    }

    function test_theLimitIsPartOfWhatIsSigned() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 1_000);
        it.impactLimit = uint32(REFERENCE);
        bytes memory sig = _sign(alicePk, _hashOpen(it));
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);
        // Whoever submits it cannot lift the limit, or take it off.
        it.impactLimit = 0;
        vm.prank(operator);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.open(it, sig, update);
        it.impactLimit = type(uint32).max;
        vm.prank(operator);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.open(it, sig, update);
    }

    /// @dev The owner can move the depth, and that bites on the next order to land. An order
    ///      signed before the change is held to its own limit, not to the new depth.
    function test_aDepthChangedAfterSigningCannotTakeAnOrderPastItsLimit() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 1_000);
        it.impactLimit = uint32((REFERENCE * 5) / 4);
        bytes memory sig = _sign(alicePk, _hashOpen(it));
        bytes[] memory update = _update(BTC_FEED, P0, it.timestamp + 2);

        vm.prank(admin);
        ex.setDepth(btc, 1);
        vm.prank(operator);
        vm.expectRevert(Exchange.ImpactLimitExceeded.selector);
        ex.open(it, sig, update);

        // Back at a depth that charges her the reference, the very same order opens.
        vm.prank(admin);
        ex.setDepth(btc, DEPTH);
        vm.prank(operator);
        bytes32 id = ex.open(it, sig, update);
        assertEq(_charge(id), REFERENCE);
    }

    // --------------------------------------------------------------------------------------
    // What it is for
    // --------------------------------------------------------------------------------------

    /// @dev What drained the reference exchange, replayed: fill a side from as many wallets as it takes, push
    ///      the price the oracle reads 15 basis points, close everything at it.
    function test_aPushOnAFullSidePaysAFractionOfWhatTheCurveAlonePaid() public {
        uint96 cap = 10_000_000e6;
        vm.prank(admin);
        ex.setCaps(eth, cap, cap);
        uint64 pumped = _up(E0, 15);

        // First with no depth to speak of: every position at the reference price, as the reference exchange
        // priced them.
        uint256 snapshot = vm.snapshotState();
        vm.prank(admin);
        ex.setDepth(eth, BOTTOMLESS);
        (uint256[] memory pks, bytes32[] memory ids) = _fillLongs(eth, 20, 500_000, E0, 0);
        assertEq(ex.getMarket(eth).oiLong, cap);
        uint256 unpriced = _closeAll(pks, ids, pumped);
        vm.revertToState(snapshot);

        // Then as deployed.
        (pks, ids) = _fillLongs(eth, 20, 500_000, E0, 0);
        assertEq(ex.getMarket(eth).oiLong, cap);
        // Nobody adds to a full side, at any price.
        Intents.OpenIntent memory more = _intent(alice, eth, true, 10e6, 1_000);
        bytes memory sig = _sign(alicePk, _hashOpen(more));
        bytes[] memory update = _update(ETH_FEED, E0, more.timestamp + 2);
        vm.prank(operator);
        vm.expectRevert(Exchange.OpenInterestCap.selector);
        ex.open(more, sig, update);

        uint256 expected;
        for (uint256 i; i < ids.length; ++i) {
            expected += _gain(ex.getPosition(ids[i]), pumped);
        }
        uint256 priced = _closeAll(pks, ids, pumped);
        assertEq(priced, expected);

        // $10M of longs and 15 bps: $15,000 before any cut. The curve alone paid about $11,200 of
        // it; with size charged, about $6,200.
        emit log_named_decimal_uint("paid at the reference price", unpriced, 6);
        emit log_named_decimal_uint("paid with size charged     ", priced, 6);
        assertApproxEqRel(unpriced, 11_240e6, 0.02e18);
        assertApproxEqRel(priced, 6_170e6, 0.02e18);
        assertLt(priced * 100, unpriced * 56);
        _assertSolvent();
    }

    /// @dev The cap is what bounds a push today. The depth is what keeps it bounded if the caps
    ///      are ever raised: a side ten times the size is paid about two and a half times as much
    ///      for the same push, not ten.
    function test_aSideTenTimesTheSizeIsNotPaidTenTimesAsMuch() public {
        uint96 cap = 100_000_000e6;
        vm.prank(admin);
        ex.setCaps(eth, cap, cap);
        uint64 pumped = _up(E0, 15);

        (uint256[] memory pks, bytes32[] memory ids) = _fillLongs(eth, 40, 2_500_000, E0, 0);
        assertEq(ex.getMarket(eth).oiLong, cap);
        uint256 paid = _closeAll(pks, ids, pumped);

        (, uint256 perPosition) = _ethSettle(E0, pumped, 2_500_000e6, true);
        uint256 unpriced = perPosition * 40;
        emit log_named_decimal_uint("$100M side, reference price", unpriced, 6);
        emit log_named_decimal_uint("$100M side, size charged   ", paid, 6);
        // About $112,000 at the reference price. Charged for size: under $16,000.
        assertApproxEqRel(unpriced, 112_400e6, 0.02e18);
        assertLt(paid, 16_000e6);
        assertLt(paid * 7, unpriced);
    }

    /// @dev The same two replays at the depth the markets launch with, a million dollars a side:
    ///      about $8,000 for the push on a full $10M side, about $25,000 on a $100M one.
    function test_theSamePushesAtTheLaunchDepth() public {
        vm.startPrank(admin);
        ex.setDepth(eth, 1_000_000);
        ex.setCaps(eth, 100_000_000e6, 100_000_000e6);
        vm.stopPrank();
        uint64 pumped = _up(E0, 15);

        (uint256[] memory pks, bytes32[] memory ids) = _fillLongs(eth, 20, 500_000, E0, 0);
        // The first two stand inside the depth and are priced as the reference exchange prices them.
        assertEq(_charge(ids[0]), REFERENCE);
        assertEq(_charge(ids[1]), REFERENCE);
        assertEq(_charge(ids[2]), 125_000);
        uint256 snapshot = vm.snapshotState();
        uint256 tenMillion = _closeAll(pks, ids, pumped);
        vm.revertToState(snapshot);

        // Ninety million more on top of the ten.
        (uint256[] memory morePks, bytes32[] memory moreIds) = _fillLongs(eth, 36, 2_500_000, E0, 100);
        assertEq(ex.getMarket(eth).oiLong, 100_000_000e6);
        uint256 hundredMillion = _closeAll(pks, ids, pumped) + _closeAll(morePks, moreIds, pumped);

        emit log_named_decimal_uint("$10M side at the launch depth ", tenMillion, 6);
        emit log_named_decimal_uint("$100M side at the launch depth", hundredMillion, 6);
        assertApproxEqRel(tenMillion, 8_020e6, 0.02e18);
        assertApproxEqRel(hundredMillion, 25_300e6, 0.03e18);
        _assertSolvent();
    }

    function testFuzz_noSplitOfASideIsPaidMoreThanTheReference(uint256 seed, uint16 moveBps) public view {
        uint256 move = bound(moveBps, 1, 300);
        uint64 pumped = _up(P0, move);
        uint256 rng = seed;
        uint256 total;
        uint256 plainTotal;
        uint256 ahead;
        // Up to twelve pieces of anything from $10,000 to $3,000,000, opened one after another.
        for (uint256 i; i < 12; ++i) {
            rng = uint256(keccak256(abi.encode(rng)));
            uint256 notional = bound(rng, 10_000e6, 3_000_000e6);
            uint256 charge = PerpMath.impactNotionalFor(ahead, notional, DEPTH);
            (, uint256 gain) =
                PerpMath.settle(P0, pumped, notional, true, charge, RATE, BTC_POSITION, MAX_KEEP, BTC_TICK);
            (, uint256 plain) = _btcSettle(P0, pumped, notional, true);
            assertLe(gain, plain);
            // Whatever stands wholly inside the depth is paid exactly the reference.
            if (2 * ahead + notional <= 2 * uint256(DEPTH) * 1e6) assertEq(gain, plain);
            total += gain;
            plainTotal += plain;
            ahead += notional;
        }
        assertLe(total, plainTotal);
    }

    // --------------------------------------------------------------------------------------
    // Setting it
    // --------------------------------------------------------------------------------------

    function test_setDepth_isTheOwnersAlone() public {
        address[3] memory others = [operator, guardian, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            ex.setDepth(btc, 1);
        }
        vm.startPrank(admin);
        vm.expectRevert(Exchange.BadMarket.selector);
        ex.setDepth(9, DEPTH);
        // A depth of nothing would charge everything without limit; there is no such market.
        vm.expectRevert(Exchange.BadParams.selector);
        ex.setDepth(btc, 0);
        vm.expectRevert(Exchange.BadParams.selector);
        ex.listMarket(
            keccak256("X/USD"),
            "X",
            1_000,
            Exchange.Curve(RATE, BTC_POSITION, BTC_TICK, BTC_BUFFER, 0),
            MAX_KEEP,
            50,
            1e12,
            1e15,
            1e15
        );
        ex.setDepth(btc, 1_000_000);
        vm.stopPrank();
        assertEq(ex.getMarket(btc).depth, 1_000_000);
        assertEq(ex.getMarket(eth).depth, DEPTH);
    }

    function test_listMarket_setsTheDepth() public {
        vm.expectEmit(true, true, true, true, address(ex));
        emit DepthSet(2, 250_000);
        vm.prank(admin);
        uint16 id = ex.listMarket(
            keccak256("X/USD"),
            "X",
            1_000,
            Exchange.Curve(RATE, BTC_POSITION, BTC_TICK, BTC_BUFFER, 250_000),
            MAX_KEEP,
            50,
            1e12,
            1e15,
            1e15
        );
        assertEq(ex.getMarket(id).depth, 250_000);
    }

    /// @dev A depth of a dollar on a full side: the charge stops at what a position can store, and
    ///      a win under it simply keeps next to nothing. Nothing overflows and nothing reverts.
    function test_theChargeHasACeiling() public {
        vm.prank(admin);
        ex.setDepth(btc, 1);
        _open(alicePk, btc, true, 10_000e6, 1_000, P0);
        _open(bobPk, btc, true, 10_000e6, 1_000, P0);
        _open(carolPk, btc, true, 10_000e6, 1_000, P0);
        uint256 pk = _wallet(0);
        bytes32 id = _open(pk, btc, true, 10_000e6, 1_000, P0);
        assertEq(_charge(id), type(uint32).max);

        uint64 exit = _up(P0, 100);
        uint256 gain = _gain(ex.getPosition(id), exit);
        assertLt(gain, 10_000_000e6 / 100 / 500);
        uint256 before = ex.balances(vm.addr(pk));
        _close(pk, id, exit);
        assertEq(ex.balances(vm.addr(pk)) - before, 10_000e6 + gain - (gain * FEE_BPS) / 10_000);
        _assertSolvent();
    }

    /// @dev A position stores its margin in 80 bits. Nothing larger than a market's largest
    ///      position, itself 80 bits, can be opened, so the margin always fits: on a market that
    ///      allows the most there is, the largest margin is stored whole, and one unit more is
    ///      refused as too large rather than cut short.
    function test_theLargestMarginThereCanBeIsStoredWhole() public {
        uint80 most = type(uint80).max;
        vm.prank(admin);
        uint16 huge = ex.listMarket(
            keccak256("HUGE/USD"),
            "HUGE",
            1_000,
            Exchange.Curve(RATE, BTC_POSITION, BTC_TICK, BTC_BUFFER, DEPTH),
            MAX_KEEP,
            50,
            most,
            type(uint96).max,
            type(uint96).max
        );
        _fund(alice, uint256(most) + 1);
        // This test isolates storage width, with enough genuine house cash for the risk ceiling.
        _seedHouse(uint256(most) / pricing.CASH_OI_MULTIPLE() + 1);

        Intents.OpenIntent memory over = _intent(alice, huge, true, uint96(most) + 1, 1);
        bytes memory sig = _sign(alicePk, _hashOpen(over));
        bytes[] memory update = _update(keccak256("HUGE/USD"), P0, over.timestamp + 2);
        vm.prank(operator);
        vm.expectRevert(Exchange.NotionalTooLarge.selector);
        ex.open(over, sig, update);

        Intents.OpenIntent memory it = _intent(alice, huge, true, most, 1);
        sig = _sign(alicePk, _hashOpen(it));
        update = _update(keccak256("HUGE/USD"), P0, it.timestamp + 2);
        skip(12);
        vm.prank(operator);
        bytes32 id = ex.open(it, sig, update);
        assertEq(ex.getPosition(id).margin, most);
        assertEq(ex.getMarket(huge).oiLong, most);
        // The charge is at its ceiling, and the position still closes at a loss for what it lost.
        assertEq(_charge(id), type(uint32).max);
        Intents.CloseIntent memory close =
            Intents.CloseIntent({owner: alice, positionId: id, timestamp: uint64(vm.getBlockTimestamp())});
        sig = _sign(alicePk, _hashClose(close));
        update = _update(keccak256("HUGE/USD"), uint64((uint256(P0) * 99) / 100), close.timestamp + 2);
        skip(12);
        vm.prank(operator);
        ex.close(close, sig, update);
        assertEq(ex.getPosition(id).owner, address(0));
        _assertSolvent();
    }
}
