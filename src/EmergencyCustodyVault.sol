// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Emergency USDC custody, tied to one exchange proxy for its entire lifetime.
/// @dev It has no administrator or trading code. Only the source exchange can recall funds,
///      and every recall goes to that same source, never an administrator-selected wallet.
contract EmergencyCustodyVault {
    using SafeERC20 for IERC20;
    IERC20 public immutable usdc;
    address public immutable source;
    error NotSource();

    constructor(IERC20 usdc_, address source_) { usdc = usdc_; source = source_; }

    function release(uint256 amount) external {
        if (msg.sender != source) revert NotSource();
        usdc.safeTransfer(source, amount);
    }
}
