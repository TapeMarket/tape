// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IJackpotFunding {
    function sync() external;
}

/// @title FeeSplitter
/// @notice The Exchange's dev recipient: the team's half of every fee arrives here, and `split`
///         sends `jackpotBps` of it to the Jackpot's pot and the rest to the team.
/// @dev Anyone can call `split`; it only ever moves this contract's USDC to the two fixed
///      addresses. No owner and no settings: a different split is a different splitter, set on
///      the Exchange by its owner (`setDevRecipient`).
contract FeeSplitter {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public immutable jackpot;
    address public immutable team;
    uint16 public immutable jackpotBps;

    event Split(uint256 toJackpot, uint256 toTeam);

    error ZeroAddress();
    error BadParams();

    constructor(IERC20 usdc_, address jackpot_, address team_, uint16 jackpotBps_) {
        if (address(usdc_) == address(0) || jackpot_ == address(0) || team_ == address(0)) {
            revert ZeroAddress();
        }
        if (jackpotBps_ > 10_000) revert BadParams();
        usdc = usdc_;
        jackpot = jackpot_;
        team = team_;
        jackpotBps = jackpotBps_;
    }

    /// @notice Sends what this holds on: the jackpot's share to the pot, the rest to the team.
    function split() external returns (uint256 toJackpot, uint256 toTeam) {
        uint256 amount = usdc.balanceOf(address(this));
        toJackpot = (amount * jackpotBps) / 10_000;
        toTeam = amount - toJackpot;
        if (toJackpot != 0) {
            usdc.safeTransfer(jackpot, toJackpot);
            // Credit this round atomically; a delayed draw must never take a later hour's fees.
            IJackpotFunding(jackpot).sync();
        }
        if (toTeam != 0) usdc.safeTransfer(team, toTeam);
        emit Split(toJackpot, toTeam);
    }
}
