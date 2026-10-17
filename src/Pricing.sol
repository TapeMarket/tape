// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPricing} from "./interfaces/IPricing.sol";
import {PerpMath} from "./libraries/PerpMath.sol";

interface IVaultCash {
    function lpCash() external view returns (uint256);
}

/// @title Pricing
/// @notice `PerpMath` behind an address, for the Exchange to call.
/// @dev The Exchange is at the limit of what one contract may hold, so the arithmetic of a
///      position lives here, together with an immutable cash-based exposure ceiling. There is no
///      owner or configurable state. The Exchange can never be pointed at another Pricing.
contract Pricing is IPricing {
    /// @notice Maximum open notional on one side of each market starts at $2M, then grows by
    ///         $50 per dollar of house cash. Deposits and locked trader margin are not house cash.
    uint256 public constant CASH_OI_FLOOR = 2_000_000e6;
    uint256 public constant CASH_OI_MULTIPLE = 50;

    // Same selector as Exchange.OpenInterestCap, so clients handle either ceiling identically.
    error OpenInterestCap();

    /// @inheritdoc IPricing
    function open(
        uint256 price,
        uint256 leverage,
        uint256 tick,
        uint256 bustBuffer,
        uint256 ahead,
        uint256 notional,
        uint256 depth
    ) external view returns (uint32) {
        // Read the calling Exchange, not an address supplied by its operator. This static
        // callback cannot change its accounting. A rejection rolls back the whole open.
        if (ahead + notional > CASH_OI_FLOOR + IVaultCash(msg.sender).lpCash() * CASH_OI_MULTIPLE) {
            revert OpenInterestCap();
        }
        if (!PerpMath.hasRoom(price, leverage, tick, bustBuffer)) return 0;
        // At most `PerpMath.MAX_IMPACT_NOTIONAL`, which is the largest uint32.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(PerpMath.impactNotionalFor(ahead, notional, depth));
    }

    /// @inheritdoc IPricing
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
    ) external pure returns (bool busted, bool win, uint256 amount) {
        // A close priced at or beyond the trigger is a bust like any other.
        if (PerpMath.crossed(exit, PerpMath.bustPrice(entry, leverage, isLong, tick, bustBuffer), isLong)) {
            return (true, false, 0);
        }
        (win, amount) = PerpMath.settle(
            entry,
            exit,
            notional,
            isLong,
            impactNotional,
            rateMultiplier,
            positionMultiplier,
            maxKeepBps,
            tick
        );
    }
}
