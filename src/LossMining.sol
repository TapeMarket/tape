// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ILossMining} from "./interfaces/IHooks.sol";

/// @title LossMining
/// @notice Pays traders in coin for the losses they realise on the Exchange. The coin goes straight
///         to the trader's wallet as the loss settles, or stays reserved for retry if rejected.
/// @dev The contract holds a reserve of coin and emits it along one curve:
///
///          emitted = reserve * loss / (scale + cumulativeLoss + loss)
///
///      so that after `L` dollars of cumulative losses the share of the reserve still unpaid is
///      `scale / (scale + L)`. Half is gone once losses reach `scale`, three quarters at 3x, and it
///      never runs out. The first dollars lost earn the most; the rate only ever falls.
///
///      The formula depends only on the current reserve and the running total, so it is exact for
///      any sequence of losses (splitting a loss in two emits the same as one), and the reserve can
///      be topped up at any time by simply transferring coin in.
///
///      No owner and no settings. Coin is never minted here: what is not in the reserve cannot be
///      emitted.
///
///      Every loss is also handed on to the Jackpot, when there is one, as that many tickets. That
///      call is capped and its failure ignored: a jackpot can never stop a loss from mining.
contract LossMining is ILossMining, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IERC20 public immutable coin;
    address public immutable exchange;
    /// @notice Cumulative loss, in 6-decimal USD, at which half the reserve has been emitted.
    uint256 public immutable scaleUsd;
    /// @notice Where each loss is entered as jackpot tickets, or zero for none.
    address public immutable jackpot;
    /// @dev Gas handed to the jackpot's entry: a new round's first entry writes two fresh slots.
    uint256 private constant JACKPOT_GAS = 70_000;

    // Share a slot: recording a failed delivery must fit the deployed Exchange's 150k hook gas.
    // uint128 holds over 10^32 USDC dollars / 10^20 whole 18-decimal coins; casts are checked.
    uint128 private _cumulativeLossUsd;
    uint128 private _totalPending;
    uint256 private _totalDelivered;
    mapping(address user => uint256) public pendingRewards;

    event Mined(address indexed user, uint256 usd, uint256 amount);
    event RewardPending(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 amount);

    error ZeroAddress();
    error ZeroScale();
    error NotExchange();
    error NotSelf();
    error NothingToClaim();

    constructor(IERC20 coin_, address exchange_, uint256 scaleUsd_, address jackpot_) {
        if (address(coin_) == address(0) || exchange_ == address(0)) revert ZeroAddress();
        if (scaleUsd_ == 0) revert ZeroScale();
        coin = coin_;
        exchange = exchange_;
        scaleUsd = scaleUsd_;
        jackpot = jackpot_;
    }

    /// @notice Coin still to be mined.
    function reserve() public view returns (uint256) {
        return coin.balanceOf(address(this)) - _totalPending;
    }

    /// @notice Every dollar of loss ever reported, in 6-decimal USD.
    function cumulativeLossUsd() external view returns (uint256) {
        return _cumulativeLossUsd;
    }

    /// @notice Coin reserved for rejected deliveries, excluded from the emission curve.
    function totalPending() external view returns (uint256) {
        return _totalPending;
    }

    /// @notice All coin mined for traders, including reserved rewards pending delivery.
    function totalMined() external view returns (uint256) {
        return _totalDelivered + _totalPending;
    }

    /// @notice What a loss of `usd` would emit right now.
    function quote(uint256 usd) public view returns (uint256) {
        return Math.mulDiv(reserve(), usd, scaleUsd + _cumulativeLossUsd + usd);
    }

    /// @notice The Exchange this is the loss-mining contract of. Only a loss-mining contract answers this.
    function lossMiningFor() external view returns (address) {
        return exchange;
    }

    /// @inheritdoc ILossMining
    function onLoss(address user, uint256 usd) external override nonReentrant {
        if (msg.sender != exchange) revert NotExchange();
        if (jackpot != address(0)) {
            // A plain call, its result and its failure ignored, like the Exchange's call to this.
            (bool entered,) =
                jackpot.call{gas: JACKPOT_GAS}(abi.encodeWithSignature("enter(address,uint256)", user, usd));
            entered;
        }
        uint256 amount = quote(usd);
        _cumulativeLossUsd = SafeCast.toUint128(uint256(_cumulativeLossUsd) + usd);
        if (amount == 0) return;
        emit Mined(user, usd, amount);
        // Keep independent tickets and loss accounting even if coin delivery is rejected.
        // Leave enough gas for a fresh pending entry even if the token consumes its full allowance.
        uint256 available = gasleft();
        uint256 deliveryGas = available > 30_000 ? available - 30_000 : 0;
        try this.deliver{gas: deliveryGas}(user, amount) {
            _totalDelivered += amount;
        } catch {
            pendingRewards[user] += amount;
            _totalPending = SafeCast.toUint128(uint256(_totalPending) + amount);
            emit RewardPending(user, amount);
        }
    }

    /// @dev Isolates a transfer and its token-side effects from the loss/ticket accounting.
    function deliver(address user, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        coin.safeTransfer(user, amount);
    }

    /// @notice Retries a reserved reward, always to its original trader. Failed attempts preserve it.
    function claim(address user) external nonReentrant {
        uint256 amount = pendingRewards[user];
        if (amount == 0) revert NothingToClaim();
        delete pendingRewards[user];
        _totalPending = uint128(uint256(_totalPending) - amount);
        _totalDelivered += amount;
        coin.safeTransfer(user, amount);
        emit RewardClaimed(user, amount);
    }
}
