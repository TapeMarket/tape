// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IOracle} from "./interfaces/IOracle.sol";
import {IPyth, PythPrice, PythPriceFeed} from "./interfaces/IPyth.sol";

/// @title PythOracle
/// @notice Adapts Pyth's pull oracle to the Exchange.
/// @dev What is enforced on-chain:
///      1. Every price is signed by Pyth's guardians. Neither this contract nor whoever submits the
///         update can invent one.
///      2. `pinned` uses `parsePriceFeedUpdatesUnique`, which returns the FIRST print at or after a
///         timestamp. A trade signed for second T therefore has exactly one possible price, and the
///         relayer that submits it has no say in which.
///
///      The contract has no owner and no settings. It keeps an ETH float to pay Pyth's update fee,
///      which Pyth sets and changes; anyone can top the float up, and nobody can take it out.
contract PythOracle is IOracle {
    int32 private constant TARGET_EXPO = -8;

    IPyth public immutable pyth;
    address public immutable exchange;

    error ZeroAddress();
    error NotExchange();
    error EmptyUpdate();
    error InsufficientFloat(uint256 fee, uint256 balance);
    error UnexpectedFeedCount(uint256 count);
    error FeedMismatch(bytes32 expected, bytes32 got);
    error NonPositivePrice();
    error ExponentOutOfRange(int32 expo);
    error PriceOutOfRange();

    constructor(IPyth _pyth, address _exchange) {
        if (address(_pyth) == address(0) || _exchange == address(0)) revert ZeroAddress();
        pyth = _pyth;
        exchange = _exchange;
    }

    receive() external payable {}

    /// @inheritdoc IOracle
    function pinned(bytes32 feedId, bytes[] calldata update, uint64 minTime, uint64 maxTime)
        external
        override
        returns (uint64 price, uint64 conf, uint64 publishTime)
    {
        return _read(feedId, update, minTime, maxTime, true);
    }

    /// @inheritdoc IOracle
    function within(bytes32 feedId, bytes[] calldata update, uint64 minTime, uint64 maxTime)
        external
        override
        returns (uint64 price, uint64 conf, uint64 publishTime)
    {
        return _read(feedId, update, minTime, maxTime, false);
    }

    function _read(bytes32 feedId, bytes[] calldata update, uint64 minTime, uint64 maxTime, bool first)
        private
        returns (uint64 price, uint64 conf, uint64 publishTime)
    {
        // Only the Exchange spends the fee float.
        if (msg.sender != exchange) revert NotExchange();
        if (update.length == 0) revert EmptyUpdate();

        uint256 fee = pyth.getUpdateFee(update);
        if (address(this).balance < fee) revert InsufficientFloat(fee, address(this).balance);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;

        PythPriceFeed[] memory feeds = first
            ? pyth.parsePriceFeedUpdatesUnique{value: fee}(update, ids, minTime, maxTime)
            : pyth.parsePriceFeedUpdates{value: fee}(update, ids, minTime, maxTime);

        if (feeds.length != 1) revert UnexpectedFeedCount(feeds.length);
        if (feeds[0].id != feedId) revert FeedMismatch(feedId, feeds[0].id);

        PythPrice memory p = feeds[0].price;
        if (p.price <= 0) revert NonPositivePrice();

        // `p.price` is strictly positive, so the cast keeps its value.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 scaled = _rescale(uint256(uint64(p.price)), p.expo);
        // Rescaling a tiny price down to 1e8 can truncate it to zero.
        if (scaled == 0) revert NonPositivePrice();
        if (scaled > type(uint64).max) revert PriceOutOfRange();

        uint256 scaledConf = _rescale(p.conf, p.expo);
        if (scaledConf > type(uint64).max) scaledConf = type(uint64).max;

        // Both values were bounds-checked against uint64 just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        price = uint64(scaled);
        // forge-lint: disable-next-line(unsafe-typecast)
        conf = uint64(scaledConf);
        publishTime = uint64(p.publishTime);
    }

    /// @dev Pyth reports `value * 10**expo`. We want `v * 10**-8`, so `v = value * 10**(expo + 8)`.
    function _rescale(uint256 value, int32 expo) private pure returns (uint256) {
        int256 shift = int256(expo) - int256(TARGET_EXPO);
        if (shift == 0) return value;
        if (shift > 18 || shift < -18) revert ExponentOutOfRange(expo);
        // The branch and the +/-18 bound keep `shift` and `-shift` inside [1, 18].
        // forge-lint: disable-next-line(unsafe-typecast)
        if (shift > 0) return value * (10 ** uint256(shift));
        // forge-lint: disable-next-line(unsafe-typecast)
        return value / (10 ** uint256(-shift));
    }
}
