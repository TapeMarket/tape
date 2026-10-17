// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PerpMath} from "../src/libraries/PerpMath.sol";

/// @dev Replays real settlements from the reference exchange through PerpMath and expects the same money,
///      to the last unit USDC can hold.
///
///      test/fixtures/reference-settlements.csv is public on-chain data: every position their
///      contract settled over a stretch of trading, in this project's units (prices 8 decimals,
///      USD 6). tools/build-reference-fixture.mjs builds it. Each row is one position and what
///      their contract did with it:
///
///        market,isLong,leverage,margin,entry,exit,kind,pnl,fee
///
///      `kind` is `bust` or `close`. `pnl` is what the trader made before the win fee (negative for
///      a loss); `fee` is the win fee they paid.
contract ReferenceParityTest is Test {
    string internal constant FILE = "test/fixtures/reference-settlements.csv";

    uint256 internal constant RATE = 15_000;
    uint256 internal constant KEEP = 9_000;
    uint256 internal constant FEE_BPS = 200;

    struct Curve {
        uint256 positionMultiplier;
        uint256 tick;
        uint256 bustBuffer;
    }

    struct Tally {
        uint256 rows;
        uint256 busts;
        uint256 wins;
        uint256 losses;
        uint256 closedPastTheTrigger;
    }

    function _curve(string memory symbol) private pure returns (Curve memory) {
        bytes32 h = keccak256(bytes(symbol));
        if (h == keccak256("BTC")) return Curve(814_598, 1e7, 476041580087574);
        if (h == keccak256("ETH")) return Curve(483_979, 1e6, 481304050180130);
        revert("unknown market in the fixture");
    }

    function test_everyRealSettlementComesOutTheSame() public view {
        // A Windows checkout may have turned the line endings; the figures are the same.
        string[] memory lines = vm.split(vm.replace(vm.readFile(FILE), "\r", ""), "\n");
        Tally memory t;
        // Line 0 is the header; the file ends with a newline.
        for (uint256 i = 1; i < lines.length; ++i) {
            if (bytes(lines[i]).length == 0) continue;
            _check(vm.split(lines[i], ","), i + 1, t);
        }
        // The fixture has to be the real thing, not a stub.
        assertGt(t.rows, 2_000, "fixture too short");
        assertGt(t.busts, 100, "too few busts");
        assertGt(t.wins, 500, "too few wins");
        assertGt(t.losses, 500, "too few losses");
        // On the reference exchange a close can land just past the trigger when it wins a race against the
        // liquidator. Here such a close is a bust. It is rare; this keeps it visible.
        assertLt(t.closedPastTheTrigger * 100, t.rows, "more than 1% of closes past the trigger");
    }

    function _check(string[] memory f, uint256 lineNo, Tally memory t) private pure {
        Curve memory c = _curve(f[0]);
        bool isLong = vm.parseUint(f[1]) == 1;
        uint256 leverage = vm.parseUint(f[2]);
        uint256 margin = vm.parseUint(f[3]);
        uint256 entry = vm.parseUint(f[4]);
        uint256 exit = vm.parseUint(f[5]);
        bool bustRow = keccak256(bytes(f[6])) == keccak256("bust");
        int256 pnl = vm.parseInt(f[7]);
        uint256 fee = vm.parseUint(f[8]);
        string memory where = string.concat("line ", vm.toString(lineNo));

        ++t.rows;
        uint256 bust = PerpMath.bustPrice(entry, leverage, isLong, c.tick, c.bustBuffer);
        assertTrue(PerpMath.hasRoom(entry, leverage, c.tick, c.bustBuffer), where);

        if (bustRow) {
            ++t.busts;
            assertTrue(
                PerpMath.crossed(exit, bust, isLong), string.concat(where, ": their bust is not one here")
            );
            assertEq(pnl, -int256(margin), where);
            return;
        }

        if (PerpMath.crossed(exit, bust, isLong)) ++t.closedPastTheTrigger;
        // Their contract charges every position on the reference notional, whatever its size.
        (bool win, uint256 amount) = PerpMath.settle(
            entry, exit, margin * leverage, isLong, 100_000, RATE, c.positionMultiplier, KEEP, c.tick
        );
        if (win) {
            if (amount != 0) ++t.wins;
            assertEq(int256(amount), pnl, string.concat(where, ": gain"));
            // Their fee is cut from an 18-decimal figure, ours from the 6-decimal one.
            assertApproxEqAbs((amount * FEE_BPS) / 10_000, fee, 1, string.concat(where, ": fee"));
        } else {
            if (amount != 0) ++t.losses;
            uint256 loss = amount < margin ? amount : margin;
            assertEq(-int256(loss), pnl, string.concat(where, ": loss"));
            assertEq(fee, 0, where);
        }
    }
}
