// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ExchangeState} from "./base/ExchangeState.sol";
import {IOracle} from "./interfaces/IOracle.sol";
import {IPricing} from "./interfaces/IPricing.sol";
import {ISessions} from "./interfaces/ISessions.sol";

/// @notice Initializes exchange storage only while its proxy is being constructed.
/// @dev This helper is replaced atomically by the trading implementation in the proxy's
///      constructor. Keeping initialization outside FastExchange leaves its runtime below EIP-170.
contract ExchangeBootstrap is ExchangeState {
    struct InitialConfig {
        address owner;
        address guardian;
        address devRecipient;
        uint96 minMargin;
        uint96 minNotional;
    }

    constructor()
        ExchangeState("Tape", IERC20(address(1)), IOracle(address(1)), IPricing(address(1)),
            ISessions(address(1)), address(this), address(this), 0, 0)
    {}

    function initialize(InitialConfig calldata config) external {
        if (address(this).code.length != 0 || owner() != address(0)) revert BadParams();
        if (config.owner == address(0) || config.guardian == address(0) || config.devRecipient == address(0)) {
            revert ZeroAddress();
        }
        _transferOwnership(config.owner);
        guardian = config.guardian;
        devRecipient = config.devRecipient;
        minMargin = config.minMargin;
        minNotional = config.minNotional;
        opensPaused = true;
    }
}
