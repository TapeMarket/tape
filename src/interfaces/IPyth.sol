// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Mirrors `PythStructs.Price` from the Pyth SDK.
struct PythPrice {
    int64 price;
    uint64 conf;
    int32 expo;
    uint256 publishTime;
}

/// @dev Mirrors `PythStructs.PriceFeed` from the Pyth SDK.
struct PythPriceFeed {
    bytes32 id;
    PythPrice price;
    PythPrice emaPrice;
}

/// @notice The slice of Pyth we actually use. Hand-written so the protocol carries no Pyth dependency.
interface IPyth {
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);

    /// @notice Verifies guardian signatures and returns a price published inside the window,
    ///         reverting if none is.
    function parsePriceFeedUpdates(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythPriceFeed[] memory);

    /// @notice Same, but additionally requires the preceding publish to be strictly before
    ///         `minPublishTime`: the returned price is the FIRST one at or after it, so whoever
    ///         submits the update cannot choose between prints.
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythPriceFeed[] memory);
}
