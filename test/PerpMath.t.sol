// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PerpMath} from "../src/libraries/PerpMath.sol";

contract PerpMathTest is Test {
    uint256 internal constant ENTRY = 80_000e8;
    // BTC as launched: the reference exchange's own parameters.
    uint256 internal constant RATE = 15_000;
    uint256 internal constant POSITION = 814_598;
    uint256 internal constant KEEP = 9_000;
    uint256 internal constant TICK = 1e7;
    uint256 internal constant BUFFER = 476041580087574;
    // ETH's, where a test needs the other market.
    uint256 internal constant ETH_POSITION = 483_979;
    uint256 internal constant ETH_TICK = 1e6;
    uint256 internal constant ETH_BUFFER = 481304050180130;
    /// @dev What the impact curve is charged on while a side is no fuller than its depth.
    uint256 internal constant REFERENCE = 100_000;

    function _settle(uint256 entry, uint256 exit, uint256 notional, bool isLong)
        internal
        pure
        returns (bool win, uint256 amount)
    {
        return PerpMath.settle(entry, exit, notional, isLong, REFERENCE, RATE, POSITION, KEEP, TICK);
    }

    function _bust(uint256 entry, uint256 leverage, bool isLong) internal pure returns (uint256) {
        return PerpMath.bustPrice(entry, leverage, isLong, TICK, BUFFER);
    }

    // --------------------------------------------------------------------------------------
    // The bust price
    // --------------------------------------------------------------------------------------

    /// @dev Positions read from the reference exchange's own contract (`getBustPrice`), in its units turned
    ///      into ours. Longs and shorts, both markets, 20x to 1000x.
    function test_bust_matchesReferenceFigures() public pure {
        assertEq(PerpMath.bustPrice(82_986.5e8, 1_000, true, TICK, BUFFER), 82_943e8);
        assertEq(PerpMath.bustPrice(83_005.5e8, 1_000, false, TICK, BUFFER), 83_049e8);
        assertEq(PerpMath.bustPrice(82_971.5e8, 500, true, TICK, BUFFER), 82_845e8);
        assertEq(PerpMath.bustPrice(82_986.5e8, 500, false, TICK, BUFFER), 83_112.9e8);
        assertEq(PerpMath.bustPrice(82_987.5e8, 50, true, TICK, BUFFER), 81_366.5e8);
        assertEq(PerpMath.bustPrice(82_987.5e8, 50, false, TICK, BUFFER), 84_607e8);
        assertEq(PerpMath.bustPrice(82_987.5e8, 20, false, TICK, BUFFER), 87_095.4e8);
        assertEq(PerpMath.bustPrice(2_503.55e8, 1_000, true, ETH_TICK, ETH_BUFFER), 2_502.25e8);
        assertEq(PerpMath.bustPrice(2_511.55e8, 1_000, false, ETH_TICK, ETH_BUFFER), 2_512.85e8);
        assertEq(PerpMath.bustPrice(2_512.15e8, 20, true, ETH_TICK, ETH_BUFFER), 2_387.69e8);
        assertEq(PerpMath.bustPrice(2_509.15e8, 22, false, ETH_TICK, ETH_BUFFER), 2_621.94e8);
    }

    function test_bust_at1000xIsALittleOverHalfTheMargin() public pure {
        // 1000x: the margin covers 0.1%. The trigger sits 5.25 bps from entry.
        uint256 bust = _bust(100_000e8, 1_000, true);
        assertEq(bust, 99_947.5e8);
        uint256 distanceBpsX100 = ((100_000e8 - bust) * 1_000_000) / 100_000e8;
        assertEq(distanceBpsX100, 525);
        // And the same distance on the other side, to within a tick.
        assertApproxEqAbs(_bust(100_000e8, 1_000, false) - 100_000e8, 100_000e8 - bust, 10 * TICK);
    }

    function test_bust_theBufferIsAboutFiveBpsWhateverTheLeverage() public pure {
        uint256[4] memory leverages = [uint256(2), 10, 100, 1_000];
        for (uint256 i; i < leverages.length; ++i) {
            uint256 zero = ENTRY - ENTRY / leverages[i];
            uint256 buffer = _bust(ENTRY, leverages[i], true) - zero;
            // 4.76 bps of the zero-equity price, never more, and at most a tick less.
            assertLe(buffer * 1e18, zero * BUFFER);
            assertGe((buffer + TICK) * 1e18, zero * BUFFER);
        }
    }

    function test_bust_at1xALongCannotBust() public pure {
        // One times leverage: zero equity is a price of zero.
        assertEq(_bust(100_000e8, 1, true), 0);
        // A short's is twice the entry, less the buffer: $200,000 less $95.20.
        assertEq(_bust(100_000e8, 1, false), 199_904.8e8);
    }

    function test_hasRoom() public pure {
        assertTrue(PerpMath.hasRoom(ENTRY, 1_000, TICK, BUFFER));
        assertTrue(PerpMath.hasRoom(ENTRY, 1, TICK, BUFFER));
        // A price below one tick has no whole tick to give away.
        assertFalse(PerpMath.hasRoom(TICK - 1, 2, TICK, BUFFER));
        // Nor does a price of a few hundred ticks at 1000x.
        assertFalse(PerpMath.hasRoom(500 * TICK, 1_000, TICK, BUFFER));
    }

    /// @dev Wherever the Exchange would let a position open, its trigger is strictly on the losing
    ///      side of entry, on both sides.
    function testFuzz_bust_isOnTheLosingSideWhereverThereIsRoom(
        uint64 rawEntry,
        uint16 rawLeverage,
        uint64 rawBuffer
    ) public pure {
        uint256 entry = bound(rawEntry, 1, 2e13);
        uint256 leverage = bound(rawLeverage, 1, 1_000);
        uint256 buffer = bound(rawBuffer, 0, 1e16);
        vm.assume(PerpMath.hasRoom(entry, leverage, ETH_TICK, buffer));
        assertLt(PerpMath.bustPrice(entry, leverage, true, ETH_TICK, buffer), entry);
        assertGt(PerpMath.bustPrice(entry, leverage, false, ETH_TICK, buffer), entry);
    }

    function test_crossed() public pure {
        assertTrue(PerpMath.crossed(99e8, 99e8, true));
        assertTrue(PerpMath.crossed(98e8, 99e8, true));
        assertFalse(PerpMath.crossed(99e8 + 1, 99e8, true));
        assertTrue(PerpMath.crossed(101e8, 101e8, false));
        assertFalse(PerpMath.crossed(101e8 - 1, 101e8, false));
    }

    // --------------------------------------------------------------------------------------
    // Settling
    // --------------------------------------------------------------------------------------

    /// @dev Three positions off the reference exchange's leaderboard. `adjusted` is what its contract recorded
    ///      before the win fee, cut to six decimals.
    function test_settle_matchesReferenceLeaderboard() public pure {
        uint256 notional = 10_000_000e6;
        (bool win, uint256 gain) = PerpMath.settle(
            2_495.65e8, 2_515.15e8, notional, true, REFERENCE, RATE, ETH_POSITION, KEEP, ETH_TICK
        );
        assertTrue(win);
        assertEq(gain, 67_801_809090);
        // After the 2% fee: the $66,445.77 the leaderboard showed.
        assertEq(gain - (gain * 200) / 10_000, 66_445_772909);
    }

    /// @dev The reference curve keeps about 88% of the raw gain on a 1% BTC move and about 74% on a
    ///      0.1% move, deadband included.
    function test_settle_matchesReferenceCurve() public pure {
        uint256 notional = 1_000_000e6;

        (bool win, uint256 gain) = _settle(ENTRY, (ENTRY * 101) / 100, notional, true);
        assertTrue(win);
        assertApproxEqRel(gain, (notional / 100) * 88 / 100, 0.005e18);

        (win, gain) = _settle(ENTRY, (ENTRY * 1001) / 1000, notional, true);
        assertTrue(win);
        assertApproxEqRel(gain, (notional / 1000) * 74 / 100, 0.005e18);
    }

    function test_settle_shortMirrorsLong() public pure {
        uint256 notional = 50_000e6;
        (, uint256 longGain) = _settle(ENTRY, ENTRY + 400e8, notional, true);
        (, uint256 shortGain) = _settle(ENTRY, ENTRY - 400e8, notional, false);
        assertEq(longGain, shortGain);

        (bool win, uint256 longLoss) = _settle(ENTRY, ENTRY - 400e8, notional, true);
        assertFalse(win);
        (, uint256 shortLoss) = _settle(ENTRY, ENTRY + 400e8, notional, false);
        assertEq(longLoss, shortLoss);
        // A loss is the plain move times the size: 0.5% of $50,000.
        assertEq(longLoss, 250e6);
    }

    /// @dev The deadband is a whole number of ticks: $80,000 is 800,000 dimes, a fifty-thousandth
    ///      of that is 16 dimes.
    function test_settle_deadbandIsWholeTicks() public pure {
        uint256 band = 16 * TICK;
        (bool win, uint256 gain) = _settle(ENTRY, ENTRY + band, 10_000_000e6, true);
        assertTrue(win);
        assertEq(gain, 0, "a move the size of the deadband pays nothing");

        (, gain) = _settle(ENTRY, ENTRY + band + 1e6, 10_000_000e6, true);
        assertGt(gain, 0, "one cent beyond it pays something");

        // Just under the next $5,000 of price the band is still 16 dimes: it steps, it does not slide.
        (, gain) = _settle(84_999e8, 84_999e8 + band, 10_000_000e6, true);
        assertEq(gain, 0);
        (, gain) = _settle(85_000e8, 85_000e8 + band, 10_000_000e6, true);
        assertEq(gain, 0);
        (, gain) = _settle(85_000e8, 85_000e8 + band + TICK, 10_000_000e6, true);
        assertEq(gain, 0, "at $85,000 the band is 17 dimes");
    }

    /// @dev ETH is quoted in cents, so its deadband is four cents below $2,500 and five from there.
    function test_settle_ethDeadbandStepsAt2500() public pure {
        (, uint256 below) = PerpMath.settle(
            2_499.99e8, 2_499.99e8 + 5e6, 10_000_000e6, true, REFERENCE, RATE, ETH_POSITION, KEEP, ETH_TICK
        );
        assertGt(below, 0, "five cents clears a four-cent band");
        (, uint256 at) = PerpMath.settle(
            2_500e8, 2_500e8 + 5e6, 10_000_000e6, true, REFERENCE, RATE, ETH_POSITION, KEEP, ETH_TICK
        );
        assertEq(at, 0, "but not a five-cent one");
    }

    function test_settle_flatIsNeitherWinNorLoss() public pure {
        (bool win, uint256 amount) = _settle(ENTRY, ENTRY, 1e12, true);
        assertFalse(win);
        assertEq(amount, 0);
    }

    function test_settle_aMoveTooSmallToMeasureKeepsNothing() public pure {
        // One hundred-millionth of a dollar past the deadband, on a huge position.
        (bool win, uint256 amount) = _settle(ENTRY, ENTRY + 16 * TICK + 1, 10_000_000e6, true);
        assertTrue(win);
        assertEq(amount, 0);
    }

    function testFuzz_settle_gainNeverExceedsKeepOfRaw(
        uint64 rawEntry,
        uint64 rawMove,
        uint64 rawNotional,
        bool isLong
    ) public pure {
        uint256 entry = bound(rawEntry, 1e8, 2e13);
        uint256 move = bound(rawMove, 1, entry - 1);
        uint256 notional = bound(rawNotional, 1e6, 10_000_000e6);
        uint256 exit = isLong ? entry + move : entry - move;

        (bool win, uint256 amount) = _settle(entry, exit, notional, isLong);
        assertTrue(win);
        uint256 raw = (notional * move) / entry;
        assertLe(amount, (raw * KEEP) / 10_000);
    }

    function testFuzz_settle_lossIsTheRawMoveRoundedDown(
        uint64 rawEntry,
        uint64 rawMove,
        uint64 rawNotional,
        bool isLong
    ) public pure {
        uint256 entry = bound(rawEntry, 1e8, 2e13);
        uint256 move = bound(rawMove, 1, entry - 1);
        uint256 notional = bound(rawNotional, 1e6, 10_000_000e6);
        uint256 exit = isLong ? entry - move : entry + move;

        (bool win, uint256 amount) = _settle(entry, exit, notional, isLong);
        assertFalse(win);
        assertEq(amount, (notional * move) / entry);
    }

    /// @dev A bigger move never pays less, and never keeps a smaller share.
    function testFuzz_settle_isMonotonicInTheMove(uint64 rawA, uint64 rawB, bool isLong) public pure {
        uint256 moveA = bound(rawA, 0, ENTRY / 2);
        uint256 moveB = bound(rawB, moveA, ENTRY / 2);
        uint256 notional = 1_000_000e6;
        (, uint256 gainA) = _settle(ENTRY, isLong ? ENTRY + moveA : ENTRY - moveA, notional, isLong);
        (, uint256 gainB) = _settle(ENTRY, isLong ? ENTRY + moveB : ENTRY - moveB, notional, isLong);
        assertLe(gainA, gainB);
    }

    // --------------------------------------------------------------------------------------
    // Size
    // --------------------------------------------------------------------------------------

    function test_impactNotional_isTheReferenceUpToTheDepth() public pure {
        // The middle of the position's stretch of the side decides. Depth: $500,000.
        assertEq(PerpMath.impactNotionalFor(0, 10_000e6, 500_000), REFERENCE);
        assertEq(PerpMath.impactNotionalFor(0, 1_000_000e6, 500_000), REFERENCE);
        assertEq(PerpMath.impactNotionalFor(400_000e6, 200_000e6, 500_000), REFERENCE);
        // A cent past it rounds up to the next dollar of charge.
        assertEq(PerpMath.impactNotionalFor(400_000e6, 200_000e6 + 1e4, 500_000), REFERENCE + 1);
        // $5M on an empty side stands at $2.5M: five depths.
        assertEq(PerpMath.impactNotionalFor(0, 5_000_000e6, 500_000), 5 * REFERENCE);
        // $100,000 on top of $10M stands at $10.05M: 20.1 depths.
        assertEq(PerpMath.impactNotionalFor(10_000_000e6, 100_000e6, 500_000), 2_010_000);
        // And it stops at what a position can store.
        assertEq(PerpMath.impactNotionalFor(60_000_000e6, 10_000_000e6, 1), type(uint32).max);
    }

    function testFuzz_impactNotional_isBoundedAndNeverFallsAsTheSideFills(
        uint64 rawAhead,
        uint64 rawMore,
        uint64 rawNotional,
        uint32 rawDepth
    ) public pure {
        uint256 ahead = bound(rawAhead, 0, 1_000_000_000e6);
        uint256 more = bound(rawMore, 0, 1_000_000_000e6);
        uint256 notional = bound(rawNotional, 1e6, 10_000_000e6);
        uint256 depth = bound(rawDepth, 1, type(uint32).max);

        uint256 charge = PerpMath.impactNotionalFor(ahead, notional, depth);
        assertGe(charge, REFERENCE);
        assertLe(charge, type(uint32).max);
        if (2 * ahead + notional <= 2 * depth * 1e6) assertEq(charge, REFERENCE);
        // A fuller side, a bigger position or a shallower market never lowers it.
        assertGe(PerpMath.impactNotionalFor(ahead + more, notional, depth), charge);
        assertGe(PerpMath.impactNotionalFor(ahead, notional + more, depth), charge);
        if (depth > 1) assertGe(PerpMath.impactNotionalFor(ahead, notional, depth - 1), charge);
    }

    /// @dev The two halves of a position stand, on average, where the whole stood: cutting a
    ///      position up does not move it down the stack.
    function testFuzz_impactNotional_halvesStandWhereTheWholeStood(uint64 rawAhead, uint64 rawNotional)
        public
        pure
    {
        uint256 depth = 500_000;
        // Past the depth, where the charge is not flat.
        uint256 ahead = bound(rawAhead, depth * 1e6, 500_000_000e6);
        uint256 half = bound(rawNotional, 1e6, 5_000_000e6);
        uint256 whole = PerpMath.impactNotionalFor(ahead, 2 * half, depth);
        uint256 first = PerpMath.impactNotionalFor(ahead, half, depth);
        uint256 second = PerpMath.impactNotionalFor(ahead + half, half, depth);
        assertLe(first, second);
        assertApproxEqAbs(first + second, 2 * whole, 2);
    }

    /// @dev Being charged on more never pays more, and changes nothing about a loss.
    function testFuzz_settle_aBiggerChargeNeverPaysMore(
        uint64 rawEntry,
        uint64 rawMove,
        uint64 rawNotional,
        uint32 rawCharge,
        uint32 rawMore,
        bool isLong
    ) public pure {
        uint256 entry = bound(rawEntry, 1e8, 2e13);
        uint256 move = bound(rawMove, 1, entry - 1);
        uint256 notional = bound(rawNotional, 1e6, 10_000_000e6);
        uint256 charge = bound(rawCharge, REFERENCE, type(uint32).max);
        uint256 bigger = bound(uint256(rawCharge) + rawMore, charge, type(uint32).max);

        uint256 exit = isLong ? entry + move : entry - move;
        (bool win, uint256 less) =
            PerpMath.settle(entry, exit, notional, isLong, bigger, RATE, POSITION, KEEP, TICK);
        (, uint256 gain) = PerpMath.settle(entry, exit, notional, isLong, charge, RATE, POSITION, KEEP, TICK);
        (, uint256 plain) = _settle(entry, exit, notional, isLong);
        assertTrue(win);
        assertLe(less, gain);
        assertLe(gain, plain);

        exit = isLong ? entry - move : entry + move;
        (win, less) = PerpMath.settle(entry, exit, notional, isLong, bigger, RATE, POSITION, KEEP, TICK);
        (, plain) = _settle(entry, exit, notional, isLong);
        assertFalse(win);
        assertEq(less, plain);
    }

    /// @dev What the size term is for. On a side charged for its size, what the whole side is paid
    ///      for a small move grows far slower than the side does: ten times the open interest
    ///      earns well under three times as much from the same 10 bps.
    function test_settle_aSidesTakeFromASmallMoveGrowsSlowerThanTheSide() public pure {
        uint256 exit = ENTRY + ENTRY / 1_000;
        uint256 small = _sideGain(10_000_000e6, exit);
        uint256 large = _sideGain(100_000_000e6, exit);
        assertLt(large, 3 * small);
        // At the reference price it would simply be ten times.
        (, uint256 plain) = _settle(ENTRY, exit, 10_000_000e6, true);
        assertLt(small * 100, plain * 60);
    }

    /// @dev What a long side of `size` is paid at `exit` when it was built from empty in $100,000
    ///      pieces on a market $500,000 deep.
    function _sideGain(uint256 size, uint256 exit) private pure returns (uint256 total) {
        uint256 piece = 100_000e6;
        for (uint256 ahead; ahead < size; ahead += piece) {
            uint256 charge = PerpMath.impactNotionalFor(ahead, piece, 500_000);
            (, uint256 gain) = PerpMath.settle(ENTRY, exit, piece, true, charge, RATE, POSITION, KEEP, TICK);
            total += gain;
        }
    }

    /// @dev Short of the bust trigger, a loss is always smaller than the margin: the buffer is the
    ///      equity a voluntary close would still return.
    function testFuzz_lossBeforeTheTriggerLeavesEquity(uint96 margin, uint16 rawLeverage, bool isLong)
        public
        pure
    {
        margin = uint96(bound(margin, 1e6, 10_000e6));
        uint256 leverage = bound(rawLeverage, 2, 1_000);
        uint256 bust = _bust(ENTRY, leverage, isLong);
        uint256 exit = isLong ? bust + 1 : bust - 1;
        assertFalse(PerpMath.crossed(exit, bust, isLong));
        (bool win, uint256 loss) = _settle(ENTRY, exit, uint256(margin) * leverage, isLong);
        assertFalse(win);
        assertLt(loss, margin);
    }
}
