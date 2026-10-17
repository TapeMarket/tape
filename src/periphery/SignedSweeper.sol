// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Exchange} from "../Exchange.sol";
import {SignedOracle} from "../SignedOracle.sol";
import {SweeperBase} from "./SweeperBase.sol";

/// @title SignedSweeper
/// @notice The sweeper of an Exchange priced by a SignedOracle (see SweeperBase for what a sweep is).
/// @dev Marks the book with the price signer's own prints, checked by the very oracle the Exchange
///      fills and closes at. `updates` holds one print for each market that is not retired and has
///      something open, in any order; prints for other markets are ignored. No ETH is needed.
contract SignedSweeper is SweeperBase {
    /// @notice The Exchange's oracle, fixed in both.
    SignedOracle public immutable oracle;

    /// @dev The oracle's own error, for the same reason: no print of the last `MAX_AGE` seconds.
    error NoPriceInWindow();

    constructor(Exchange exchange_) SweeperBase(exchange_) {
        oracle = SignedOracle(address(exchange_.oracle()));
    }

    /// @inheritdoc SweeperBase
    function _prices(Exchange.Market[] memory markets, bytes[] calldata updates)
        internal
        view
        override
        returns (uint256[] memory prices)
    {
        uint256 count = markets.length;
        prices = new uint256[](count);
        uint256 nowTime = block.timestamp;
        // The oracle takes one print at a time.
        bytes[] memory one = new bytes[](1);
        for (uint256 i; i < count; ++i) {
            if (!_needsPrice(markets[i])) continue;
            bytes32 feedId = markets[i].feedId;
            for (uint256 j; j < updates.length; ++j) {
                // A print starts with the feed it is for.
                if (updates[j].length < 32 || bytes32(updates[j][:32]) != feedId) continue;
                one[0] = updates[j];
                // Reverts unless the signer signed it.
                (uint64 price,, uint64 publishTime,) = oracle.read(feedId, one);
                if (publishTime + MAX_AGE < nowTime || publishTime > nowTime) continue;
                prices[i] = price;
                break;
            }
            // The oracle refuses a price of zero, so zero here is no print at all.
            if (prices[i] == 0) revert NoPriceInWindow();
        }
    }
}
