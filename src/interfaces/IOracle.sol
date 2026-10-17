// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Price source for the Exchange. Every price is scaled to 1e8.
interface IOracle {
    /// @notice The FIRST price published at or after `minTime` (and no later than `maxTime`).
    ///         Deterministic: for a given feed and `minTime` there is exactly one answer.
    function pinned(bytes32 feedId, bytes[] calldata update, uint64 minTime, uint64 maxTime)
        external
        returns (uint64 price, uint64 conf, uint64 publishTime);

    /// @notice Any price published inside `[minTime, maxTime]`. Used to prove a price was touched.
    function within(bytes32 feedId, bytes[] calldata update, uint64 minTime, uint64 maxTime)
        external
        returns (uint64 price, uint64 conf, uint64 publishTime);
}
