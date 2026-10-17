// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IStaking} from "./interfaces/IHooks.sol";

interface IExchangeForStaking {
    function depositFor(address user, uint256 amount) external;
}

/// @title Staking
/// @notice Stake the coin, earn USDC from the Exchange. No lockup, no cooldown, no tiers.
/// @dev USDC arrives from the Exchange and is paid out as a stream: whatever is waiting is spread
///      evenly over the next `PERIOD`, and each second of it goes to whoever is staked during that
///      second, in proportion to their stake.
///
///      Why a stream and not one payment: the coin trades freely. If a payout landed in a single
///      block, anyone could buy or borrow coin, stake it for that one block, take most of the
///      payout and leave. With a stream a stake earns exactly for the time it is staked, so there
///      is nothing to grab and nobody whose timing matters. Nobody runs it: there is no operator.
///
///      While nobody is staked the stream stops and what is left waits for the next staker; it
///      then starts again as a fresh stream, so the first staker cannot take a backlog in one go.
///
///      A claim is credited to the staker's trading balance on the Exchange, from where it can be
///      traded or withdrawn.
///
///      No owner and no settings.
contract Staking is IStaking, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice How long a payment from the Exchange takes to reach stakers in full.
    uint256 public constant PERIOD = 24 hours;

    /// @dev Scale of `rewardRate` and, squared, of `rewardPerShare`: 6-decimal USDC per second per
    ///      18-decimal coin needs the room.
    uint256 private constant PRECISION = 1e18;

    IERC20 public immutable coin;
    IERC20 public immutable usdc;
    address public immutable exchange;

    uint256 public totalStaked;
    mapping(address user => uint256) public staked;

    /// @notice USDC streamed per second, scaled by 1e18. Zero when no stream is running.
    uint256 public rewardRate;
    /// @notice When the current stream ends.
    uint64 public periodFinish;
    /// @notice The last moment the stream was accounted for.
    uint64 public lastUpdate;
    /// @notice Cumulative USDC streamed per staked coin, scaled by 1e36.
    uint256 public rewardPerShare;
    mapping(address user => uint256) private _paidPerShare;
    mapping(address user => uint256) private _accrued;

    /// @notice USDC received while nobody was staked (or left over when the last staker went),
    ///         waiting for the next staker.
    uint256 public waiting;
    uint256 public totalReceived;
    uint256 public totalClaimed;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);
    event Received(uint256 amount);
    event StreamStarted(uint256 amount, uint256 until);

    error ZeroAddress();
    error ZeroAmount();
    error NotExchange();
    error InsufficientStake();

    constructor(IERC20 coin_, IERC20 usdc_, address exchange_) {
        if (address(coin_) == address(0) || address(usdc_) == address(0) || exchange_ == address(0)) {
            revert ZeroAddress();
        }
        coin = coin_;
        usdc = usdc_;
        exchange = exchange_;
    }

    /// @notice The Exchange this is the staking contract of. Only a staking contract answers this.
    function stakingFor() external view returns (address) {
        return exchange;
    }

    // ------------------------------------------------------------------------------------------
    // Staking
    // ------------------------------------------------------------------------------------------

    function stake(uint256 amount) external nonReentrant {
        _stake(amount);
    }

    /// @notice Stakes with a signed permit, so no separate approval transaction is needed.
    function stakeWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        // A front-run permit leaves the allowance in place; the transfer below settles it either way.
        try IERC20Permit(address(coin)).permit(msg.sender, address(this), amount, deadline, v, r, s) {}
            catch {}
        _stake(amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (staked[msg.sender] < amount) revert InsufficientStake();
        _accrue(msg.sender);
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        // The last staker out: stop the stream and keep what is left of it for the next one in.
        if (totalStaked == 0) _pause();
        coin.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Credits what the caller has earned so far to their trading balance on the Exchange.
    function claim() external nonReentrant returns (uint256 amount) {
        _accrue(msg.sender);
        amount = _accrued[msg.sender];
        if (amount == 0) revert ZeroAmount();
        _accrued[msg.sender] = 0;
        totalClaimed += amount;
        usdc.forceApprove(exchange, amount);
        IExchangeForStaking(exchange).depositFor(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------------------------------
    // Rewards
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IStaking
    function notify(uint256 amount) external override {
        if (msg.sender != exchange) revert NotExchange();
        totalReceived += amount;
        emit Received(amount);
        if (totalStaked == 0) {
            waiting += amount;
            return;
        }
        _settle();
        _start(amount + _unstreamed());
    }

    /// @notice USDC `user` could claim right now.
    function pendingReward(address user) public view returns (uint256) {
        return _accrued[user]
            + Math.mulDiv(staked[user], _perShareNow() - _paidPerShare[user], PRECISION * PRECISION);
    }

    /// @notice USDC of the current stream that has not been paid out yet.
    function unstreamed() external view returns (uint256) {
        return _unstreamed();
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    function _stake(uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        _accrue(msg.sender);
        // Credit what arrived, not what was sent, so a coin that takes a cut on transfer cannot
        // leave the contract owing more than it holds.
        uint256 before = coin.balanceOf(address(this));
        coin.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = coin.balanceOf(address(this)) - before;
        bool first = totalStaked == 0;
        staked[msg.sender] += received;
        totalStaked += received;
        // The first staker in sets the waiting USDC flowing, from now.
        if (first && received != 0 && waiting != 0) {
            uint256 amountWaiting = waiting;
            waiting = 0;
            _start(amountWaiting);
        }
        emit Staked(msg.sender, received);
    }

    function _streamTime() private view returns (uint256) {
        return Math.min(block.timestamp, periodFinish);
    }

    function _perShareNow() private view returns (uint256) {
        if (totalStaked == 0) return rewardPerShare;
        return rewardPerShare + ((_streamTime() - lastUpdate) * rewardRate * PRECISION) / totalStaked;
    }

    /// @dev Brings the stream's accounting up to this moment.
    function _settle() private {
        rewardPerShare = _perShareNow();
        // Never moves backwards: `lastUpdate` is at most `periodFinish`.
        // forge-lint: disable-next-line(unsafe-typecast)
        lastUpdate = uint64(_streamTime());
    }

    /// @dev Books what `user` has earned so far, before their stake changes.
    function _accrue(address user) private {
        _settle();
        _accrued[user] = pendingReward(user);
        _paidPerShare[user] = rewardPerShare;
    }

    function _unstreamed() private view returns (uint256) {
        if (block.timestamp >= periodFinish) return 0;
        return ((periodFinish - block.timestamp) * rewardRate) / PRECISION;
    }

    /// @dev Starts a stream of `amount` from now. Whatever the division drops stays in the
    ///      contract as dust; it is never promised to anyone.
    function _start(uint256 amount) private {
        rewardRate = (amount * PRECISION) / PERIOD;
        // forge-lint: disable-start(unsafe-typecast)
        lastUpdate = uint64(block.timestamp);
        periodFinish = uint64(block.timestamp + PERIOD);
        // forge-lint: disable-end(unsafe-typecast)
        emit StreamStarted(amount, periodFinish);
    }

    /// @dev Stops the stream and moves its remainder to `waiting`. Called with the accounting
    ///      already settled, when the last staker leaves.
    function _pause() private {
        uint256 left = _unstreamed();
        if (left != 0) waiting += left;
        rewardRate = 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        periodFinish = uint64(block.timestamp);
    }
}
