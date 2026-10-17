// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PerpMath} from "../src/libraries/PerpMath.sol";

/// @dev Writes a table of inputs and PerpMath's answers to test/fixtures/math-vectors.csv. The
///      relayer's test suite checks shared/math.mjs against every row, so the JavaScript that
///      previews trades and decides liquidations cannot drift from the contract unnoticed.
///
///      The table is deterministic: running this again rewrites the same file.
contract ParityTest is Test {
    string internal constant FILE = "test/fixtures/math-vectors.csv";
    uint256 internal constant ROWS = 600;

    struct Row {
        uint256 entry;
        uint256 exit;
        uint256 margin;
        uint256 leverage;
        bool isLong;
        uint256 rateMultiplier;
        uint256 positionMultiplier;
        uint256 tick;
        uint256 bustBuffer;
        uint256 maxKeepBps;
        /// @dev What is open on the position's side before it, in USDC, and the market's depth in
        ///      dollars: what its impact notional is worked out from.
        uint256 ahead;
        uint256 depth;
    }

    function test_writeVectors() public {
        vm.writeFile(
            FILE,
            "entry,exit,margin,leverage,isLong,rateMultiplier,positionMultiplier,tick,bustBuffer,maxKeepBps,ahead,depth,bust,room,crossed,impactNotional,win,amount\n"
        );

        uint256 seed = uint256(keccak256("Tape math vectors"));
        uint256 wins;
        uint256 busts;
        uint256 cramped;
        uint256 charged;
        uint256 capped;
        for (uint256 i; i < ROWS; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            Row memory r = _row(seed, i);

            uint256 bust = PerpMath.bustPrice(r.entry, r.leverage, r.isLong, r.tick, r.bustBuffer);
            bool room = PerpMath.hasRoom(r.entry, r.leverage, r.tick, r.bustBuffer);
            bool crossed = PerpMath.crossed(r.exit, bust, r.isLong);
            uint256 impactNotional = PerpMath.impactNotionalFor(r.ahead, r.margin * r.leverage, r.depth);
            (bool win, uint256 amount) = PerpMath.settle(
                r.entry,
                r.exit,
                r.margin * r.leverage,
                r.isLong,
                impactNotional,
                r.rateMultiplier,
                r.positionMultiplier,
                r.maxKeepBps,
                r.tick
            );
            if (win && amount != 0) ++wins;
            if (crossed) ++busts;
            if (!room) ++cramped;
            if (impactNotional > 100_000) ++charged;
            if (impactNotional == type(uint32).max) ++capped;

            vm.writeLine(
                FILE,
                string.concat(
                    _inputs(r),
                    ",",
                    vm.toString(bust),
                    ",",
                    room ? "1" : "0",
                    ",",
                    crossed ? "1" : "0",
                    ",",
                    vm.toString(impactNotional),
                    ",",
                    win ? "1" : "0",
                    ",",
                    vm.toString(amount)
                )
            );
        }

        // The table has to exercise every branch to be worth checking against.
        assertGt(wins, ROWS / 5, "too few winning rows");
        assertGt(busts, ROWS / 20, "too few busted rows");
        assertGt(cramped, 0, "no row without room for a trigger");
        assertGt(charged, ROWS / 4, "too few rows charged for size");
        assertLt(charged, (ROWS * 3) / 4, "too few rows at the reference price");
        assertGt(capped, 0, "no row at the most a position can be charged on");
    }

    function _row(uint256 seed, uint256 i) private pure returns (Row memory r) {
        r.leverage = bound(seed >> 40, 1, 1_000);
        r.margin = bound(seed >> 60, 1e6, 10_000e6);
        r.isLong = (seed >> 90) & 1 == 1;
        r.maxKeepBps = i % 4 == 0 ? bound(seed >> 130, 5_000, 10_000) : 9_000;

        // A quiet side on a deep market, a crowded one, and now and then a depth so small that
        // the charge runs into its ceiling.
        uint256 crowd = (seed >> 210) % 8;
        if (crowd < 3) {
            (r.ahead, r.depth) = (bound(seed >> 220, 0, 400_000e6), 500_000);
        } else if (crowd < 7) {
            (r.ahead, r.depth) = (bound(seed >> 220, 0, 60_000_000e6), bound(seed >> 190, 50_000, 5_000_000));
        } else {
            (r.ahead, r.depth) = (bound(seed >> 220, 0, 60_000_000e6), bound(seed >> 190, 1, 40));
        }

        // The two launch markets, and anything else the Exchange would accept.
        if (i % 3 == 0) {
            (r.rateMultiplier, r.positionMultiplier, r.tick, r.bustBuffer) =
            (15_000, 814_598, 1e7, 476041580087574);
            r.entry = bound(seed, 1_000e8, 200_000e8);
        } else if (i % 3 == 1) {
            (r.rateMultiplier, r.positionMultiplier, r.tick, r.bustBuffer) =
            (15_000, 483_979, 1e6, 481304050180130);
            r.entry = bound(seed, 100e8, 20_000e8);
        } else {
            uint256[5] memory ticks = [uint256(1), 100, 1e4, 1e6, 1e7];
            r.rateMultiplier = bound(seed >> 100, 1, 1_000_000);
            r.positionMultiplier = bound(seed >> 110, 1, 10_000_000);
            r.tick = ticks[(seed >> 120) % 5];
            r.bustBuffer = bound(seed >> 170, 0, 1e16);
            // From a millionth of a dollar up, so some prices are smaller than their own tick.
            r.entry = bound(seed, 100, 2e13);
        }

        // Moves from a fraction of a basis point to tens of percent, in parts per billion.
        uint256 kind = (seed >> 150) % 5;
        uint256 reach = kind == 0 ? 3e3 : kind == 1 ? 1e5 : kind == 2 ? 1e6 : kind == 3 ? 2e7 : 4e8;
        uint256 delta = (r.entry * bound(seed >> 160, 0, reach)) / 1e9;
        r.exit = (seed >> 200) & 1 == 1 ? r.entry + delta : (delta >= r.entry ? 1 : r.entry - delta);
    }

    function _inputs(Row memory r) private pure returns (string memory) {
        return string.concat(
            string.concat(
                vm.toString(r.entry),
                ",",
                vm.toString(r.exit),
                ",",
                vm.toString(r.margin),
                ",",
                vm.toString(r.leverage),
                ",",
                r.isLong ? "1" : "0"
            ),
            ",",
            string.concat(
                vm.toString(r.rateMultiplier),
                ",",
                vm.toString(r.positionMultiplier),
                ",",
                vm.toString(r.tick),
                ",",
                vm.toString(r.bustBuffer),
                ",",
                vm.toString(r.maxKeepBps),
                ",",
                vm.toString(r.ahead),
                ",",
                vm.toString(r.depth)
            )
        );
    }
}
