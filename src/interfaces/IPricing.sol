// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The pricing rules of a position, as the Exchange asks for them. See `Pricing`.
interface IPricing {
    /// @notice The terms a position opens on. Reverts with OpenInterestCap if the resulting
    ///         side exceeds the immutable house-cash ceiling; the caller must expose lpCash().
    /// @return impactNotional The notional its impact will be charged on, in whole dollars. Zero
    ///         if `leverage` leaves no room for a bust trigger at `price`: such a position must
    ///         not be opened.
    function open(
        uint256 price,
        uint256 leverage,
        uint256 tick,
        uint256 bustBuffer,
        uint256 ahead,
        uint256 notional,
        uint256 depth
    ) external view returns (uint32 impactNotional);

    /// @notice What a position is worth at `exit`.
    /// @return busted True if `exit` is at or beyond the bust trigger: the whole margin is lost.
    /// @return win True if the exit is on the profitable side of entry.
    /// @return amount For a win, the gain before the win fee. For a loss, the raw loss, not capped
    ///         at the margin. Zero for a bust.
    function close(
        uint256 entry,
        uint256 exit,
        uint256 notional,
        uint256 leverage,
        bool isLong,
        uint256 impactNotional,
        uint256 rateMultiplier,
        uint256 positionMultiplier,
        uint256 maxKeepBps,
        uint256 tick,
        uint256 bustBuffer
    ) external pure returns (bool busted, bool win, uint256 amount);
}
