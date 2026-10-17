// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Coin
/// @notice A plain fixed-supply ERC-20. The whole supply is minted once, to `recipient`.
/// @dev No owner, no mint function, no tax, no transfer hook, no blacklist. It trades anywhere an
///      ERC-20 trades. The protocol does not depend on this contract: `Staking` and `LossMining`
///      accept any ERC-20, so a coin created by a launchpad works just as well.
contract Coin is ERC20, ERC20Burnable, ERC20Permit {
    constructor(string memory name_, string memory symbol_, uint256 supply, address recipient)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _mint(recipient, supply);
    }
}
