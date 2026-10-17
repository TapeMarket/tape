// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The one question the Exchange asks about session keys.
interface ISessions {
    /// @notice Whether `key` may sign for `owner` an order timestamped `timestamp`.
    function isValid(address owner, address key, uint64 timestamp) external view returns (bool);
}
