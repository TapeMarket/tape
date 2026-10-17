// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Exchange} from "../Exchange.sol";
import {IPyth, PythPrice, PythPriceFeed} from "../interfaces/IPyth.sol";
import {SweeperBase} from "./SweeperBase.sol";

/// @title Sweeper
/// @notice The sweeper of an Exchange priced by Pyth (see SweeperBase for what a sweep is).
/// @dev Marks the book with signed Pyth updates, read from the same Pyth contract the Exchange's
///      oracle reads. Send enough ETH for Pyth's fee; the rest comes back.
contract Sweeper is SweeperBase {
    int32 private constant TARGET_EXPO = -8;

    IPyth public immutable pyth;

    error NonPositivePrice();
    error ExponentOutOfRange(int32 expo);

    constructor(Exchange exchange_, IPyth pyth_) SweeperBase(exchange_) {
        if (address(pyth_) == address(0)) revert ZeroAddress();
        pyth = pyth_;
    }

    /// @inheritdoc SweeperBase
    function _prices(Exchange.Market[] memory markets, bytes[] calldata updates)
        internal
        override
        returns (uint256[] memory prices)
    {
        uint256 count = markets.length;
        uint256 live;
        for (uint256 i; i < count; ++i) {
            if (_needsPrice(markets[i])) ++live;
        }
        bytes32[] memory ids = new bytes32[](live);
        uint256 n;
        for (uint256 i; i < count; ++i) {
            if (_needsPrice(markets[i])) ids[n++] = markets[i].feedId;
        }
        // Reverts unless every one of them has a print inside the window.
        // The window's start cannot underflow on any real chain.
        // forge-lint: disable-next-line(unsafe-typecast)
        PythPriceFeed[] memory feeds = pyth.parsePriceFeedUpdates{value: pyth.getUpdateFee(updates)}(
            updates, ids, uint64(block.timestamp) - MAX_AGE, uint64(block.timestamp)
        );
        prices = new uint256[](count);
        n = 0;
        for (uint256 i; i < count; ++i) {
            if (_needsPrice(markets[i])) prices[i] = _price(feeds[n++].price);
        }
    }

    /// @dev Pyth reports `value * 10**expo`; the Exchange's prices are `v * 10**-8`.
    function _price(PythPrice memory p) private pure returns (uint256 price) {
        if (p.price <= 0) revert NonPositivePrice();
        // Strictly positive, so the cast keeps its value.
        // forge-lint: disable-next-line(unsafe-typecast)
        price = uint256(uint64(p.price));
        int256 shift = int256(p.expo) - int256(TARGET_EXPO);
        if (shift > 18 || shift < -18) revert ExponentOutOfRange(p.expo);
        // The bound keeps `shift` and `-shift` inside [1, 18].
        // forge-lint: disable-start(unsafe-typecast)
        if (shift > 0) price *= 10 ** uint256(shift);
        else if (shift < 0) price /= 10 ** uint256(-shift);
        // forge-lint: disable-end(unsafe-typecast)
        if (price == 0) revert NonPositivePrice();
    }
}
