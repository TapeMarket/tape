// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {FastExchange} from "./FastExchange.sol";
import {ExecutionOracle} from "./ExecutionOracle.sol";
import {ExchangeBootstrap} from "./ExchangeBootstrap.sol";

/// @notice A stable exchange address with separately controlled implementation upgrades.
/// @dev The runtime is OpenZeppelin's transparent proxy. No extra external selectors are added.
///      Construction initializes storage and installs trading logic in one transaction.
contract HybridExchangeProxy is TransparentUpgradeableProxy {
    constructor(
        FastExchange implementation,
        ExchangeBootstrap bootstrap,
        address upgradeController,
        ExchangeBootstrap.InitialConfig memory config
    ) TransparentUpgradeableProxy(address(bootstrap), upgradeController,
        abi.encodeCall(ExchangeBootstrap.initialize, (config)))
    {
        require(implementation.EXEC_DELAY() == 0, "Expected order-bound execution");
        require(ExecutionOracle(address(implementation.oracle())).exchange() == address(this), "Wrong oracle exchange");
        ERC1967Utils.upgradeToAndCall(address(implementation), "");
    }
}
