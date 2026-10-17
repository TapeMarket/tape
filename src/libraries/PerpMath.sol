// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PerpMath
/// @notice The pricing rules of a position: where it busts, and what a close is worth.
/// @dev Prices are 1e8, USD amounts are 6-decimal USDC.
///
///      The arithmetic follows the reference exchange's settlement step for step, including where each
///      division rounds, so that the same entry, exit, margin and leverage pay the same here as
///      there. test/fixtures/reference-settlements.csv holds a few thousand of their real
///      settlements; test/ReferenceParity.t.sol requires this library to reproduce every one.
///
///      Two of their rules work in whole price ticks (their oracle quotes BTC in dimes and ETH in
///      cents): the deadband and the two steps of the bust price. A market's `tick` says how big
///      that unit is in 1e8 terms, so those steps round the way theirs do.
library PerpMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    /// @dev Jitter deadband: a win is measured as if the exit were `entry / 50_000` (0.2 bps) less
    ///      favourable, in whole ticks, rounded down. A win no bigger than that pays nothing.
    uint256 internal constant DEADBAND_DIVISOR = 50_000;

    /// @dev The notional the impact curve is charged on while a side of a market is no fuller than
    ///      its `depth`, in dollars. The reference charges every position on this, whatever its
    ///      size; here it is the floor (see `impactNotionalFor`).
    uint256 internal constant REFERENCE_NOTIONAL = 100_000;
    /// @dev The most a position's impact notional can be: what the Exchange has room to store.
    uint256 internal constant MAX_IMPACT_NOTIONAL = type(uint32).max;

    /// @notice The hard-liquidation trigger. Crossing it forfeits the whole margin.
    /// @dev Zero equity is `entry / leverage` away from entry. The trigger sits `bustBuffer` (a
    ///      fraction of the zero-equity price, scaled by 1e18) closer to entry than that. Requires
    ///      `hasRoom`, which the Exchange checks at open.
    function bustPrice(uint256 entry, uint256 leverage, bool isLong, uint256 tick, uint256 bustBuffer)
        internal
        pure
        returns (uint256)
    {
        uint256 distance = (entry / tick / leverage) * tick;
        uint256 zero = isLong ? entry - distance : entry + distance;
        uint256 buffer = Math.mulDiv(zero / tick, bustBuffer, WAD) * tick;
        return isLong ? zero + buffer : zero - buffer;
    }

    /// @notice Whether a position entered at `entry` with `leverage` has a bust trigger strictly
    ///         on the losing side of entry. False for very small prices at very high leverage,
    ///         where whole-tick rounding leaves no room; such a position must not be opened.
    function hasRoom(uint256 entry, uint256 leverage, uint256 tick, uint256 bustBuffer)
        internal
        pure
        returns (bool)
    {
        uint256 distance = (entry / tick / leverage) * tick;
        // The buffer is worked out on the long side's zero-equity price, which is the smaller of
        // the two: if a short has room, so does a long at the same entry, and the Exchange would
        // rather refuse both than keep two rules.
        uint256 buffer = Math.mulDiv((entry + distance) / tick, bustBuffer, WAD) * tick;
        return distance > buffer;
    }

    /// @notice Whether `price` is at or beyond a position's bust trigger.
    function crossed(uint256 price, uint256 bust, bool isLong) internal pure returns (bool) {
        return isLong ? price <= bust : price >= bust;
    }

    /// @notice The notional a new position's impact is charged on, in whole dollars. It is fixed
    ///         when the position opens and decides how much of a win the position keeps.
    /// @param ahead What is already open on the position's side of the market, in USDC.
    /// @param notional The position's own margin times leverage, in USDC.
    /// @param depth How much may be open on one side at the reference's own price, in whole
    ///        dollars. Not zero.
    /// @dev The reference prices a close as if every position were $100,000, so a position a
    ///      thousand times that size keeps the same share of a small move, and whoever can nudge
    ///      the market the oracle reads is paid for the nudge on the whole of it. Here size costs.
    ///      A side's open interest is a stack: this position sits on top of `ahead` and takes up
    ///      the next `notional` of it. It is charged on where the middle of that stretch stands
    ///      against `depth`:
    ///
    ///          level  = (ahead + notional / 2) / depth
    ///          charge = REFERENCE_NOTIONAL * max(1, level)
    ///
    ///      So everything up to `depth` on a side is priced exactly as the reference prices it,
    ///      and past it the size term of the curve (see `settle`) grows in step with how full the
    ///      side is. Because the charge follows the side and not the position, cutting one
    ///      position into many, or spreading it over many accounts, climbs the same stack: the
    ///      pieces are charged on the same notional on average. What a win keeps is not a straight
    ///      line in the charge, so the pieces are paid a little more than the whole (about 6% at
    ///      most where it matters), and one position that straddles the depth on an empty side
    ///      is charged a little less than its top half alone would be. Neither grows with size.
    ///      Rounded up.
    function impactNotionalFor(uint256 ahead, uint256 notional, uint256 depth)
        internal
        pure
        returns (uint256)
    {
        uint256 charge = Math.mulDiv(
            2 * ahead + notional, REFERENCE_NOTIONAL, 2e6 * depth, Math.Rounding.Ceil
        );
        if (charge < REFERENCE_NOTIONAL) return REFERENCE_NOTIONAL;
        return charge > MAX_IMPACT_NOTIONAL ? MAX_IMPACT_NOTIONAL : charge;
    }

    /// @notice Values a close.
    /// @param entry Entry price.
    /// @param exit Exit price.
    /// @param notional Margin times leverage, in USDC.
    /// @param isLong Direction.
    /// @param impactNotional The notional the impact is charged on, in whole dollars: what
    ///        `impactNotionalFor` gave the position when it opened. `REFERENCE_NOTIONAL` prices it
    ///        exactly as the reference does.
    /// @param rateMultiplier The curve's first parameter (15,000 at launch).
    /// @param positionMultiplier The curve's second parameter, in thousandths (814,598 for 814.598).
    /// @param maxKeepBps The most of a raw gain a win can ever keep: one minus the base rate.
    /// @param tick One price tick, in 1e8 terms.
    /// @return win True if the exit is on the profitable side of entry.
    /// @return amount For a win: the gain after the deadband and the impact haircut, before the
    ///         win fee. For a loss: the raw loss, NOT capped at margin.
    /// @dev Impact, with `move` the price move as a fraction of entry after the deadband:
    ///
    ///          scale = (1 - baseRate) / (1 + 1/(move * rateMultiplier) + N/(1e6 * move * positionMultiplier))
    ///
    ///      with N the impact notional. Both extra terms shrink as the move grows, so a bigger
    ///      move keeps more of its gain, up to `maxKeepBps`; and the second grows with N, so a
    ///      position opened on a crowded side keeps less of a small move than one opened on a
    ///      quiet one. For a small move the gain goes as the square of the move, and what a whole
    ///      side can be paid for it grows only as the logarithm of the side's size: that is what
    ///      makes pushing the price to cash in a large position a losing trade. Every division
    ///      rounds down, as in the reference.
    function settle(
        uint256 entry,
        uint256 exit,
        uint256 notional,
        bool isLong,
        uint256 impactNotional,
        uint256 rateMultiplier,
        uint256 positionMultiplier,
        uint256 maxKeepBps,
        uint256 tick
    ) internal pure returns (bool win, uint256 amount) {
        if (exit == entry) return (false, 0);

        win = isLong ? exit > entry : exit < entry;
        uint256 delta = exit > entry ? exit - entry : entry - exit;

        if (!win) return (false, Math.mulDiv(notional, delta, entry));

        uint256 deadband = (entry / tick / DEADBAND_DIVISOR) * tick;
        if (delta <= deadband) return (true, 0);
        delta -= deadband;

        uint256 move = Math.mulDiv(delta, WAD, entry);
        uint256 byRate = move * rateMultiplier;
        // The position multiplier is in thousandths, and the reference divides by 1e6: 1e6 / 1e3.
        uint256 byPosition = move * positionMultiplier * 1_000;
        if (byRate == 0 || byPosition == 0) return (true, 0);

        uint256 term1 = (WAD * WAD) / byRate;
        uint256 term2 = (impactNotional * WAD * WAD) / byPosition;
        // A move this small keeps nothing.
        if (term1 > WAD * WAD || term2 > WAD * WAD) return (true, 0);

        uint256 scale = (maxKeepBps * 1e14 * WAD) / (WAD + term1 + term2);
        // The raw gain is carried at 18 decimals through the scaling and only then cut to USDC's
        // six, which is where the reference's own figure lands when written in USDC.
        uint256 raw = Math.mulDiv(notional * 1e12, delta, entry);
        amount = Math.mulDiv(raw, scale, WAD) / 1e12;
    }
}
