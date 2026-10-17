// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

import {IPyth, PythPrice, PythPriceFeed} from "../../src/interfaces/IPyth.sol";

contract MockUSDC is ERC20, ERC20Permit {
    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mirrors the two Pyth entry points the protocol uses, including the uniqueness rule. An
///      update is `abi.encode(id, price, conf, expo, publishTime, prevPublishTime)`. Nothing is
///      signed: tests decide what Pyth "published".
contract MockPyth is IPyth {
    uint256 public fee = 1;

    error PriceFeedNotFoundWithinRange();
    error InsufficientFee();

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return fee * updateData.length;
    }

    function parsePriceFeedUpdates(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythPriceFeed[] memory) {
        return _parse(updateData, priceIds, minPublishTime, maxPublishTime, false);
    }

    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythPriceFeed[] memory) {
        return _parse(updateData, priceIds, minPublishTime, maxPublishTime, true);
    }

    function _parse(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime,
        bool unique
    ) private view returns (PythPriceFeed[] memory feeds) {
        if (msg.value < fee * updateData.length) revert InsufficientFee();
        feeds = new PythPriceFeed[](priceIds.length);
        for (uint256 i; i < priceIds.length; ++i) {
            bool found;
            for (uint256 j; j < updateData.length && !found; ++j) {
                (
                    bytes32 id,
                    int64 price,
                    uint64 conf,
                    int32 expo,
                    uint64 publishTime,
                    uint64 prevPublishTime
                ) = abi.decode(updateData[j], (bytes32, int64, uint64, int32, uint64, uint64));
                if (id != priceIds[i]) continue;
                if (publishTime < minPublishTime || publishTime > maxPublishTime) continue;
                if (unique && prevPublishTime >= minPublishTime) continue;
                feeds[i].id = id;
                feeds[i].price = PythPrice(price, conf, expo, publishTime);
                feeds[i].emaPrice = PythPrice(price, conf, expo, publishTime);
                found = true;
            }
            if (!found) revert PriceFeedNotFoundWithinRange();
        }
    }
}

/// @dev Records what the Exchange reports, for tests that check the mining basis.
contract MockLossMining {
    address public lastUser;
    uint256 public lastUsd;
    uint256 public totalUsd;
    uint256 public calls;
    bool public shouldRevert;
    bool public burnGas;

    function setRevert(bool on) external {
        shouldRevert = on;
    }

    function setBurnGas(bool on) external {
        burnGas = on;
    }

    function onLoss(address user, uint256 usd) external {
        require(!shouldRevert, "mining down");
        if (burnGas) {
            while (true) {}
        }
        lastUser = user;
        lastUsd = usd;
        totalUsd += usd;
        ++calls;
    }
}
