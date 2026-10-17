// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Receives the staker share of fees. USDC is transferred in before `notify` is called.
interface IStaking {
    function notify(uint256 amount) external;
}

/// @notice Told about every realised loss so it can pay the loser in coin.
interface ILossMining {
    function onLoss(address user, uint256 usd) external;
}

/// @notice What the Exchange asks of a contract before it accepts it: which Exchange it was built
///         for, under a name only that kind of contract answers to.
/// @dev The three names differ on purpose. Attaching is for good, so handing the contracts over in
///      the wrong order has to fail rather than attach: a staking contract does not answer
///      `lossMiningFor`, and so on.
interface IAttached {
    function stakingFor() external view returns (address);
    function lossMiningFor() external view returns (address);
    function sweeperFor() external view returns (address);
}
