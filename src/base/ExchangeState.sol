// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Intents} from "./Intents.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {IPricing} from "../interfaces/IPricing.sol";
import {ISessions} from "../interfaces/ISessions.sol";

/// @notice Recovery/initialization mirror of Exchange's storage and constructor-bound dependencies.
/// @dev Trading retains its original inheritance and bytecode-size profile. The build checks
///      this mirror against the original trading layout, including every nested struct. Do not
///      reorder fields or change existing structs. Recovery state belongs in a separate namespace.
abstract contract ExchangeState is Intents, Ownable2Step, ReentrancyGuardTransient {
    // ------------------------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------------------------

    struct Market {
        bytes32 feedId;
        uint16 maxLeverage;
        /// @dev The most of a raw gain a win keeps, in bps.
        uint16 maxKeepBps;
        /// @dev Opens are refused while Pyth's confidence interval is wider than this, in bps.
        uint16 maxConfBps;
        /// @dev The impact curve's two parameters (see `PerpMath.settle`). The second is in thousandths.
        uint32 rateMultiplier;
        uint32 positionMultiplier;
        /// @dev One price tick in 1e8 terms: the unit the deadband and the bust price round to.
        uint32 tick;
        /// @dev How far the bust trigger sits before zero equity, as a 1e18 fraction of that price.
        uint64 bustBuffer;
        bool retired;
        uint64 retiredAt;
        uint64 frozenPrice;
        uint80 maxNotional;
        /// @dev How much may be open on one side at the curve's own price, in whole dollars. A
        ///      position opened past it is charged for the size already there.
        uint32 depth;
        uint96 oiLong;
        uint96 oiShort;
        uint96 capLong;
        uint96 capShort;
        /// @dev Open positions per side in units of the asset, scaled by 1e18. With the open
        ///      interest (what was paid for them) this is all that is needed to mark the house's
        ///      exposure at any price.
        uint128 sizeLong;
        uint128 sizeShort;
    }

    /// @dev The pricing parameters of a market, as `listMarket` takes them.
    struct Curve {
        uint32 rateMultiplier;
        uint32 positionMultiplier;
        uint32 tick;
        uint64 bustBuffer;
        uint32 depth;
    }

    struct Position {
        address owner;
        uint16 market;
        uint16 leverage;
        bool isLong;
        /// @dev Slot in the owner's list of open positions.
        uint16 index;
        /// @dev Publish time of the entry price.
        uint40 openTime;
        uint80 margin;
        /// @dev The part of `margin` that was funded from the owner's queued payout, not cash.
        uint80 debtMargin;
        uint64 entryPrice;
        /// @dev The notional the impact of a win is charged on, in whole dollars. Set at open
        ///      from how full the side was, and never changed.
        uint32 impactNotional;
    }

    struct Claim {
        address user;
        uint96 amount;
    }

    struct WithdrawRequest {
        uint128 amount;
        uint64 requestedAt;
        /// @dev When the request was executed or cancelled. Zero while it is pending.
        uint64 closedAt;
    }

    enum CloseKind {
        Close,
        Liquidation
    }

    // ------------------------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------------------------

    uint256 internal constant BPS = 10_000;

    /// @notice Fee on a win's gain, and the house-side fee carved from a loss.
    uint256 public constant FEE_BPS = 200;
    /// @notice Share of every fee that goes to stakers. The rest goes to the dev recipient.
    uint256 public constant STAKER_SHARE_BPS = 5_000;
    uint16 internal constant MAX_LEVERAGE = 1_000;
    uint256 public constant MAX_OPEN_POSITIONS = 200;

    /// @notice An intent stamped T executes at the first price published at or after T + this.
    function EXEC_DELAY() public pure virtual returns (uint64) {
        return 2;
    }
    /// @notice ...and no later than this many seconds after that.
    uint64 public constant PIN_WINDOW = 10;
    /// @notice An intent must land within this many seconds of its timestamp.
    uint64 public constant INTENT_TTL = 60;
    /// @notice A direct close executes at the first price this long after the request. Two slots,
    ///         so the price cannot be known when the request is sent.
    uint64 public constant DIRECT_DELAY = 24;
    /// @notice A direct close request lapses if nobody executed it within this long. After that
    ///         it shields the position from nothing and a new one can be made.
    uint64 public constant REQUEST_EXPIRY = 10 minutes;
    /// @notice Delay on the direct withdrawal exit. Must exceed `INTENT_TTL`.
    uint64 public constant WITHDRAW_DELAY = 15 minutes;
    /// @dev Oldest price a guardian may freeze a retired market at.
    uint64 internal constant RETIRE_MAX_AGE = 60;

    /// @dev The widest a bust buffer may be: 1% of the zero-equity price.
    uint64 internal constant MAX_BUST_BUFFER = 1e16;
    uint16 internal constant MIN_KEEP_BPS = 5_000;
    uint16 internal constant MAX_CONF_BPS = 1_000;

    /// @dev Queue entries paid automatically whenever a loss lands.
    uint256 internal constant AUTO_HARVEST = 4;
    /// @dev Gas handed to the loss-mining hook, and the floor required before calling it so that a
    ///      caller cannot starve the hook by under-supplying gas.
    uint256 internal constant MINING_GAS = 150_000;
    uint256 internal constant MINING_GAS_FLOOR = 165_000;

    // ------------------------------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------------------------------

    IERC20 public immutable usdc;
    IOracle public immutable oracle;
    /// @notice The arithmetic of a position. Stateless, and fixed for good.
    IPricing public immutable pricing;
    /// @notice House equity above this is distributable to stakers.
    uint256 public immutable stakerCap;

    // ------------------------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------------------------

    Market[] internal _markets;
    mapping(bytes32 id => Position) internal _positions;
    mapping(address owner => bytes32[]) internal _openIds;
    /// @notice When a binding direct close was requested for a position, or zero.
    mapping(bytes32 id => uint64) public closeRequestedAt;
    mapping(bytes32 intentHash => bool) public usedIntent;

    /// @notice A trader's free collateral. Always fully backed and always theirs to withdraw.
    mapping(address user => uint256) public balances;
    mapping(address user => WithdrawRequest) public withdrawRequests;

    /// @notice All USDC the Exchange accounts for.
    uint256 public treasury;
    uint256 public totalBalances;
    /// @notice Cash margin locked in open positions.
    uint256 public totalCashMargin;
    /// @notice Queue-funded margin locked in open positions. A liability, not cash.
    uint256 public debtMarginOpen;
    uint256 public stakerFees;
    uint256 public devFees;

    /// @notice The payout queue. Live claims are `queueHead` up to, not including, `queueTail`.
    mapping(uint256 claimId => Claim) public claims;
    uint256 public queueHead;
    uint256 public queueTail;
    /// @notice Everything the house owes and has not paid.
    uint256 public totalQueued;
    /// @notice What the house owes one trader.
    mapping(address user => uint256) public queuedOf;
    /// @dev Queued payout a trader has already spent as margin, netted off their oldest claims when
    ///      the queue reaches them.
    mapping(address user => uint256) public queueSpent;

    mapping(address => bool) public isOperator;
    address public guardian;
    address public devRecipient;
    address public staking;
    address public lossMining;
    /// @notice The only contract that may send house cash above the cap to stakers.
    address public sweeper;
    bool public opensPaused;
    uint96 public minMargin;
    /// @notice The smallest position, margin times leverage, that can be opened.
    uint96 public minNotional;

    // ------------------------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------------------------

    event Deposited(address indexed user, address indexed from, uint256 amount);
    event Withdrawn(address indexed user, address indexed to, uint256 amount);
    event WithdrawRequested(address indexed user, uint256 amount, uint256 executableAt);
    event PositionOpened(
        bytes32 indexed id,
        address indexed owner,
        uint16 indexed market,
        bool isLong,
        uint16 leverage,
        uint96 margin,
        uint96 debtMargin,
        uint64 entryPrice,
        uint64 entryTime,
        uint32 impactNotional
    );
    /// @param pnl Profit after every deduction, or minus the loss.
    /// @param credited USDC credited to the owner's balance by this close.
    /// @param queued USDC added to the owner's queued payout by this close.
    /// @param fee Fee actually paid out to stakers and the dev recipient.
    event PositionClosed(
        bytes32 indexed id,
        address indexed owner,
        uint16 indexed market,
        CloseKind kind,
        uint64 exitPrice,
        int256 pnl,
        uint256 credited,
        uint256 queued,
        uint256 fee
    );
    event CloseRequested(bytes32 indexed id, address indexed owner, uint64 pinTime);
    event Queued(address indexed user, uint256 indexed claimId, uint256 amount);
    event QueuePaid(address indexed user, uint256 indexed claimId, uint256 amount);
    event QueueSpent(address indexed user, uint256 amount);
    event StakerFeesPushed(uint256 fees, uint256 excess);
    event DevFeesClaimed(address indexed to, uint256 amount);
    event Donated(address indexed from, uint256 amount);
    event MarketListed(uint16 indexed id, bytes32 feedId, string symbol);
    event MarketRetired(uint16 indexed id, uint64 frozenPrice);
    event CapsSet(uint16 indexed id, uint96 capLong, uint96 capShort);
    event DepthSet(uint16 indexed id, uint32 depth);
    event MinimumsSet(uint96 minMargin, uint96 minNotional);
    event OperatorSet(address indexed operator, bool allowed);
    event GuardianSet(address indexed guardian);
    event DevRecipientSet(address indexed recipient);
    event CoinAttached(address indexed staking, address indexed lossMining);
    event OpensPausedSet(bool paused);
    event MiningFailed(address indexed user, uint256 usd);

    // ------------------------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error NotOperator();
    error NotGuardian();
    error BadMarket();
    error BadParams();
    error MarketIsRetired();
    error OpensPaused();
    error IntentUsed();
    error IntentExpired();
    error BadLeverage();
    error MarginTooSmall();
    error NotionalTooLarge();
    error NotionalTooSmall();
    error ConfidenceTooWide();
    error PriceLimitExceeded();
    error ImpactLimitExceeded();
    error OpenInterestCap();
    error InsufficientBalance();
    error TooManyPositions();
    error NoPosition();
    error NotPositionOwner();
    error CloseNotAfterOpen();
    error CloseAlreadyRequested();
    error NoRequest();
    error TooEarly();
    error Expired();
    error NotLiquidatable();
    error NotTriggered();
    error CloseHasPriority();
    error ExitPending();
    error LiquidationGrace();
    error AlreadyAttached();
    error NoStaking();
    error NothingToPush();
    error InsufficientGas();

    // ------------------------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------------------------

    constructor(
        string memory name_,
        IERC20 usdc_,
        IOracle oracle_,
        IPricing pricing_,
        ISessions sessions_,
        address owner_,
        address devRecipient_,
        uint256 stakerCap_,
        uint96 minMargin_
    ) Intents(name_, sessions_) Ownable(owner_) {
        if (
            address(usdc_) == address(0) || address(oracle_) == address(0) || address(pricing_) == address(0)
                || address(sessions_) == address(0) || devRecipient_ == address(0)
        ) revert ZeroAddress();
        usdc = usdc_;
        oracle = oracle_;
        pricing = pricing_;
        devRecipient = devRecipient_;
        stakerCap = stakerCap_;
        minMargin = minMargin_;
    }

}
