// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IExchangeDeposit {
    function depositFor(address user, uint256 amount) external;
    function isOperator(address account) external view returns (bool);
}

/// @title Gateway
/// @notice Deposits into the Exchange from a signed USDC permit, so a trader needs no ETH: they
///         sign once and an operator pays the gas.
/// @dev Holds nothing between calls. It can only ever move an owner's USDC into that same owner's
///      Exchange balance.
contract Gateway {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IExchangeDeposit public immutable exchange;

    error PermitFailed();

    constructor(IERC20 usdc_, IExchangeDeposit exchange_) {
        usdc = usdc_;
        exchange = exchange_;
        usdc_.forceApprove(address(exchange_), type(uint256).max);
    }

    /// @notice Pulls `amount` of `owner`'s USDC with their permit and credits their Exchange balance.
    /// @dev A permit can be front-run by submitting it straight to the token, which makes the call
    ///      here fail while leaving the allowance in place. Only the owner or an operator may carry
    ///      on past a failed permit; otherwise anyone could spend a standing allowance.
    function depositWithPermit(address owner, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        try IERC20Permit(address(usdc)).permit(owner, address(this), amount, deadline, v, r, s) {}
        catch {
            if (msg.sender != owner && !exchange.isOperator(msg.sender)) revert PermitFailed();
        }
        usdc.safeTransferFrom(owner, address(this), amount);
        exchange.depositFor(owner, amount);
    }
}
