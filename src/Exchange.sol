// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Intents} from "./base/Intents.sol";
import {IOracle} from "./interfaces/IOracle.sol";
import {IPricing} from "./interfaces/IPricing.sol";
import {ISessions} from "./interfaces/ISessions.sol";
import {IStaking, ILossMining, IAttached} from "./interfaces/IHooks.sol";

/// @title Exchange
/// @notice Synthetic perpetuals up to 1000x against a house that starts from zero.
///
/// @dev HOW A TRADE WORKS
///      Every trade is a swap between one trader and the house. There is no order book and no other
///      counterparty. A position is a discrete slug: margin and leverage are fixed at open, and it
///      ends by being closed in full or by busting.
///
///      PRICE. A trader signs an intent stamped with the current second T. The intent executes at
///      the first Pyth price published at or after T + EXEC_DELAY. That price is unique and
///      verifiable, so the trader knows their fill two seconds after clicking even though the
///      transaction lands a block later, and the operator that submits it cannot choose it.
///
///      COST. No fee on notional, no spread, no funding. The house takes its cut from winning closes
///      only: a 0.2 bps deadband, an impact haircut that shrinks as the move grows, and a 2% fee on
///      what is left. A loss costs the loss and nothing more.
///
///      SIZE. A position fills and closes at the oracle's price whatever its size, so a trader
///      holding enough of one side could push the real market a few basis points, close, and be
///      paid for the push on all of it. Two things stand against that. Each side of a market is
///      capped. And size costs: every market has a `depth`, and a position opened on a side that
///      already holds more than that keeps less of a win, the more so the fuller the side and the
///      smaller the move (see `PerpMath.impactNotionalFor`). The terms follow the side, not the
///      position, so splitting a position or spreading it over accounts climbs the same stack
///      and buys only a few percent. They are fixed at open, so nothing done afterwards changes
///      them, and the order itself says the most it will accept (`impactLimit`). Up to `depth`,
///      and for a single position of up to twice that on an empty side, nothing changes at all.
///
///      THE HOUSE. It holds no seed capital. Losses fund it. A win it cannot pay in full goes into a
///      first-in-first-out queue and is paid as later losses arrive. Collateral is never queued:
///      only profit is.
///
///      WHY INTENTS CANNOT BE SWITCHED. Because the price is fixed by the signed timestamp while the
///      transaction lands seconds later, a trader able to cancel an intent in between, or to bring a
///      failing one to life, would hold a free option on those seconds. So nothing a trader can call
///      directly changes the fate of an intent they have already signed:
///        - a session key change only bites on later timestamps, and an ended key never comes back;
///        - a withdrawal request freezes new opens instead of moving money, and pays out only after
///          a delay far longer than any intent lives;
///        - a signed withdrawal has its own replay counter and goes through the operator;
///        - a direct close is a binding request: until every intent signed before it has had time
///          to land, only an operator can execute it, and a signed close priced after it is refused.
///
///      TRUST. Operators (the relayer keys) are trusted to submit intents promptly, in order, and
///      only when freshly signed. They cannot forge an intent, choose a price or move funds. If they
///      stop, traders still exit through `requestClose` and `requestWithdraw`. The contract is not
///      upgradeable and has no function that touches a trader's balance.
contract Exchange is Intents, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

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

    uint256 private constant BPS = 10_000;

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
    uint256 private constant AUTO_HARVEST = 4;
    /// @dev Gas handed to the loss-mining hook, and the floor required before calling it so that a
    ///      caller cannot starve the hook by under-supplying gas.
    uint256 private constant MINING_GAS = 150_000;
    uint256 private constant MINING_GAS_FLOOR = 165_000;

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
    mapping(bytes32 id => Position) private _positions;
    mapping(address owner => bytes32[]) private _openIds;
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

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _;
    }

    // ------------------------------------------------------------------------------------------
    // Collateral
    // ------------------------------------------------------------------------------------------

    /// @notice Deposits USDC into the caller's balance.
    function deposit(uint256 amount) external nonReentrant {
        _deposit(msg.sender, msg.sender, amount);
    }

    /// @notice Deposits the caller's USDC into `user`'s balance.
    function depositFor(address user, uint256 amount) external nonReentrant {
        _deposit(msg.sender, user, amount);
    }

    /// @notice Withdraws on the wallet's signature, submitted by an operator. Instant and gasless.
    /// @dev Operator-only so that a trader cannot race their own pending intents with it.
    function withdrawBySig(
        address owner_,
        address to,
        uint256 amount,
        uint64 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        _requireWalletAuth(
            owner_, _hashWithdraw(owner_, to, amount, withdrawNonces[owner_]++, deadline), signature
        );
        _withdraw(owner_, to, amount);
    }

    /// @notice Starts the direct exit: after `WITHDRAW_DELAY` the caller can take up to `amount`.
    ///         Needs no operator. Requesting zero cancels a pending request.
    /// @dev A request moves no money. What it does is stop the account opening new positions (see
    ///      `open`) until it is executed or cancelled, so that the withdrawal, once it matures, has
    ///      no pending open to pull the margin out from under. One request at a time, and a new one
    ///      may not follow so closely that it would lift the freeze the last one still imposes.
    function requestWithdraw(uint128 amount) external {
        WithdrawRequest storage request = withdrawRequests[msg.sender];
        bool pending = request.requestedAt != 0 && request.closedAt == 0;
        if (amount == 0) {
            if (!pending) revert NoRequest();
            request.closedAt = uint64(block.timestamp);
        } else {
            if (pending || block.timestamp < uint256(request.closedAt) + GRACE + INTENT_TTL) {
                revert TooEarly();
            }
            withdrawRequests[msg.sender] = WithdrawRequest(amount, uint64(block.timestamp), 0);
        }
        emit WithdrawRequested(msg.sender, amount, block.timestamp + WITHDRAW_DELAY);
    }

    /// @notice Completes the direct exit. Pays the requested amount, or the whole balance if less.
    function executeWithdraw(address to) external nonReentrant {
        WithdrawRequest storage request = withdrawRequests[msg.sender];
        if (request.requestedAt == 0 || request.closedAt != 0) revert NoRequest();
        if (block.timestamp < uint256(request.requestedAt) + WITHDRAW_DELAY) revert TooEarly();
        request.closedAt = uint64(block.timestamp);
        _withdraw(msg.sender, to, Math.min(request.amount, balances[msg.sender]));
    }

    function _deposit(address from, address user, uint256 amount) private {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(from, address(this), amount);
        treasury += amount;
        _credit(user, amount);
        emit Deposited(user, from, amount);
    }

    function _withdraw(address user, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (balances[user] < amount) revert InsufficientBalance();
        balances[user] -= amount;
        totalBalances -= amount;
        treasury -= amount;
        usdc.safeTransfer(to, amount);
        emit Withdrawn(user, to, amount);
    }

    // ------------------------------------------------------------------------------------------
    // Trading: operator path
    // ------------------------------------------------------------------------------------------

    /// @notice Opens the position described by a signed intent. The intent's hash is the position id.
    function open(OpenIntent calldata it, bytes calldata signature, bytes[] calldata update)
        external
        onlyOperator
        nonReentrant
        returns (bytes32 id)
    {
        id = _hashOpen(it);
        if (usedIntent[id]) revert IntentUsed();
        _requireTradeAuth(it.owner, id, signature, it.timestamp);
        if (block.timestamp > uint256(it.timestamp) + INTENT_TTL) revert IntentExpired();
        usedIntent[id] = true;

        // An account that has asked to leave does not open. Like every account-level switch, the
        // freeze starts and ends one slot after the block that changed it, on the intent's clock.
        WithdrawRequest memory exit = withdrawRequests[it.owner];
        if (
            exit.requestedAt != 0 && it.timestamp >= exit.requestedAt + GRACE
                && (exit.closedAt == 0 || it.timestamp < exit.closedAt + GRACE)
        ) revert ExitPending();

        if (opensPaused) revert OpensPaused();
        if (it.market >= _markets.length) revert BadMarket();
        Market storage m = _markets[it.market];
        if (m.retired) revert MarketIsRetired();
        if (it.leverage == 0 || it.leverage > m.maxLeverage) revert BadLeverage();
        if (it.margin < minMargin || it.margin == 0) revert MarginTooSmall();
        uint256 notional = uint256(it.margin) * it.leverage;
        if (notional > m.maxNotional) revert NotionalTooLarge();
        if (notional < minNotional) revert NotionalTooSmall();

        (uint64 price, uint64 conf, uint64 publishTime) =
            _openPrice(it, id, update);
        if (uint256(conf) * BPS > uint256(price) * m.maxConfBps) revert ConfidenceTooWide();
        if (it.priceLimit != 0 && (it.isLong ? price > it.priceLimit : price < it.priceLimit)) {
            revert PriceLimitExceeded();
        }

        // `notional` is bounded by `maxNotional`, a uint80, and a size by notional * 1e18.
        // forge-lint: disable-start(unsafe-typecast)
        uint128 size = uint128(Math.mulDiv(notional, 1e18, price));
        // What is already open on this side: the position is charged for it (see `Pricing`).
        uint256 ahead;
        if (it.isLong) {
            ahead = m.oiLong;
            if (ahead + notional > m.capLong) revert OpenInterestCap();
            m.oiLong = uint96(ahead + notional);
            m.sizeLong += size;
        } else {
            ahead = m.oiShort;
            if (ahead + notional > m.capShort) revert OpenInterestCap();
            m.oiShort = uint96(ahead + notional);
            m.sizeShort += size;
        }
        // forge-lint: disable-end(unsafe-typecast)
        uint32 impactNotional =
            pricing.open(price, it.leverage, m.tick, m.bustBuffer, ahead, notional, m.depth);
        if (impactNotional == 0) revert BadLeverage();
        // The side can fill up between the signing of an order and its landing. The trader says
        // how much of that they will take, as they do for the price.
        if (it.impactLimit != 0 && impactNotional > it.impactLimit) revert ImpactLimitExceeded();

        // Margin comes from the queued payout first when asked, then from cash. Drawing on the sum
        // means a harvest that pays the owner in between changes nothing.
        uint256 debtPart;
        if (it.useQueued) {
            debtPart = Math.min(queuedOf[it.owner], it.margin);
            if (debtPart != 0) _spendQueued(it.owner, debtPart);
        }
        uint256 cashPart = it.margin - debtPart;
        if (balances[it.owner] < cashPart) revert InsufficientBalance();
        balances[it.owner] -= cashPart;
        totalBalances -= cashPart;
        totalCashMargin += cashPart;
        debtMarginOpen += debtPart;

        bytes32[] storage ids = _openIds[it.owner];
        if (ids.length >= MAX_OPEN_POSITIONS) revert TooManyPositions();
        // `ids.length` is below 200, `publishTime` fits 40 bits until the year 36812, and
        // `debtPart` is at most `it.margin`, which is at most the notional: `maxNotional`, a uint80.
        // forge-lint: disable-start(unsafe-typecast)
        _positions[id] = Position({
            owner: it.owner,
            market: it.market,
            leverage: it.leverage,
            isLong: it.isLong,
            index: uint16(ids.length),
            openTime: uint40(publishTime),
            margin: uint80(it.margin),
            debtMargin: uint80(debtPart),
            entryPrice: price,
            impactNotional: impactNotional
        });
        ids.push(id);

        emit PositionOpened(
            id,
            it.owner,
            it.market,
            it.isLong,
            it.leverage,
            it.margin,
            uint96(debtPart),
            price,
            publishTime,
            impactNotional
        );
        // forge-lint: disable-end(unsafe-typecast)
    }

    /// @notice Closes a position on a signed intent, at the price fixed by the intent's timestamp.
    function close(CloseIntent calldata it, bytes calldata signature, bytes[] calldata update)
        external
        onlyOperator
        nonReentrant
    {
        Position memory p = _positions[it.positionId];
        if (p.owner == address(0)) revert NoPosition();
        if (p.owner != it.owner) revert NotPositionOwner();
        _requireTradeAuth(it.owner, _hashClose(it), signature, it.timestamp);
        if (block.timestamp > uint256(it.timestamp) + INTENT_TTL) revert IntentExpired();
        _beforeRequest(it.positionId, it.timestamp + EXEC_DELAY());
        _settle(it.positionId, p, _intentClosePrice(it, p, update), false);
    }

    /// @notice Closes a position on its take-profit or stop-loss: a signed trigger, a print that
    ///         touched it, and the price the close is then fixed at.
    /// @dev The trader signs the trigger once and the operator holds it. When a print at or beyond
    ///      the trigger's price appears after the trigger was signed, the close is priced exactly as
    ///      if the trader had clicked at that print: the first price `EXEC_DELAY` after it. Like any
    ///      order it has to land within `INTENT_TTL` of that moment, so a touch cannot be saved up
    ///      and used later. The operator still chooses whether to land it, as with every order.
    function closeOnTrigger(
        TriggerIntent calldata it,
        bytes calldata signature,
        bytes[] calldata touch,
        bytes[] calldata update
    ) external onlyOperator nonReentrant {
        Position memory p = _positions[it.positionId];
        if (p.owner == address(0)) revert NoPosition();
        // Checked against the position's own owner: only their keys can sign for it, whatever
        // owner the trigger names.
        _requireTradeAuth(p.owner, _hashTrigger(it), signature, it.timestamp);
        // A print after the trigger was signed, and after the position opened, at or past its price.
        (uint64 price, uint64 touchedAt) = _triggerTouch(it, p, touch);
        if (it.above ? price < it.price : price > it.price) revert NotTriggered();
        if (block.timestamp > uint256(touchedAt) + INTENT_TTL) revert IntentExpired();
        _beforeRequest(it.positionId, touchedAt + EXEC_DELAY());
        _settle(it.positionId, p, _triggerPrice(p, price, touchedAt, update), false);
    }

    // ------------------------------------------------------------------------------------------
    // Trading: direct path (no operator needed)
    // ------------------------------------------------------------------------------------------

    /// @notice Requests a close straight from the owner's wallet. Binding: it cannot be cancelled,
    ///         and it is priced at the first print `DIRECT_DELAY` after this block.
    /// @dev A request lapses after `REQUEST_EXPIRY`. That covers the rare case of Pyth publishing
    ///      nothing inside the pricing window, where the close could otherwise never execute and
    ///      the position could never be liquidated.
    function requestClose(bytes32 id) external {
        if (_positions[id].owner != msg.sender) revert NotPositionOwner();
        if (_liveRequest(id) != 0) revert CloseAlreadyRequested();
        uint64 nowTs = uint64(block.timestamp);
        closeRequestedAt[id] = nowTs;
        emit CloseRequested(id, msg.sender, nowTs + DIRECT_DELAY);
    }

    /// @notice Executes a requested close at the first price `DIRECT_DELAY` after the request.
    /// @dev Anyone can execute it, but a non-operator must first let every intent and every
    ///      liquidation that predates its price have its turn. Otherwise the owner could race a
    ///      signed close of their own with it and keep the better of two prices, or slip a touched
    ///      position out before the public is allowed to liquidate it.
    function executeClose(bytes32 id, bytes[] calldata update) external nonReentrant {
        Position memory p = _positions[id];
        if (p.owner == address(0)) revert NoPosition();
        uint64 requestedAt = _liveRequest(id);
        if (requestedAt == 0) revert NoRequest();
        if (!isOperator[msg.sender] && block.timestamp <= uint256(requestedAt) + DIRECT_DELAY + INTENT_TTL) {
            revert TooEarly();
        }
        _settle(id, p, _closePrice(p, requestedAt + DIRECT_DELAY, update), false);
    }

    /// @notice Busts a position by proving its trigger price was touched after it opened.
    /// @dev Anyone can liquidate, but a non-operator must wait until the proof is older than any
    ///      close intent that could still be in flight: a close signed before the touch has to be
    ///      allowed to land first.
    function liquidate(bytes32 id, bytes[] calldata update) external nonReentrant {
        Position memory p = _positions[id];
        if (p.owner == address(0)) revert NoPosition();
        Market storage m = _markets[p.market];

        uint64 price;
        if (m.retired) {
            price = m.frozenPrice;
        } else {
            uint64 publishTime;
            (price, publishTime) = _liquidationPrice(id, p, update);
            // A touch at or after the moment a binding close is priced comes too late.
            _beforeRequest(id, publishTime);
            if (!isOperator[msg.sender] && block.timestamp <= uint256(publishTime) + INTENT_TTL) {
                revert LiquidationGrace();
            }
        }

        _settle(id, p, price, true);
    }

    // ------------------------------------------------------------------------------------------
    // The house
    // ------------------------------------------------------------------------------------------

    /// @notice Pays queued winners from the front, as far as the house's cash goes.
    function harvest(uint256 maxEntries) external nonReentrant {
        _harvest(maxEntries);
    }

    /// @notice Gives USDC to the house. Nothing is received in return.
    function donate(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        treasury += amount;
        emit Donated(msg.sender, amount);
        _harvest(AUTO_HARVEST);
    }

    /// @notice Sends accrued staker fees to staking, which streams them to stakers. Anyone can
    ///         call it. House cash above `stakerCap` goes the same way, through `sweepExcess`.
    function pushStakerFees() external nonReentrant returns (uint256 amount) {
        amount = stakerFees;
        if (amount == 0) revert NothingToPush();
        stakerFees = 0;
        _toStakers(amount);
        emit StakerFeesPushed(amount, 0);
    }

    /// @notice Sends `amount` of the house's cash above its cap to stakers. Only the sweeper may
    ///         call this: it first works out, at current prices, how much of that cash the house
    ///         would need if every open position closed now, and sweeps only the rest.
    function sweepExcess(uint256 amount) external nonReentrant {
        if (msg.sender != sweeper) revert NotOperator();
        if (amount == 0 || amount > lpExcess()) revert NothingToPush();
        _toStakers(amount);
        emit StakerFeesPushed(0, amount);
    }

    function _toStakers(uint256 amount) private {
        address staking_ = staking;
        if (staking_ == address(0)) revert NoStaking();
        treasury -= amount;
        usdc.safeTransfer(staking_, amount);
        IStaking(staking_).notify(amount);
    }

    /// @notice Sends accrued dev fees to the dev recipient.
    function claimDevFees() external nonReentrant returns (uint256 amount) {
        amount = devFees;
        if (amount == 0) revert ZeroAmount();
        devFees = 0;
        treasury -= amount;
        usdc.safeTransfer(devRecipient, amount);
        emit DevFeesClaimed(devRecipient, amount);
    }

    // ------------------------------------------------------------------------------------------
    // Administration
    // ------------------------------------------------------------------------------------------

    /// @notice Lists a market. Its pricing parameters are fixed for good: changing them means
    ///         retiring the market and listing a new one, never repricing open positions. The
    ///         one exception is the depth, which the owner can move for positions not yet open
    ///         (`setDepth`).
    function listMarket(
        bytes32 feedId,
        string calldata symbol,
        uint16 maxLeverage,
        Curve calldata curve,
        uint16 maxKeepBps,
        uint16 maxConfBps,
        uint80 maxNotional,
        uint96 capLong,
        uint96 capShort
    ) external onlyOwner returns (uint16 id) {
        if (
            feedId == bytes32(0) || maxLeverage == 0 || maxLeverage > MAX_LEVERAGE
                || curve.rateMultiplier == 0 || curve.positionMultiplier == 0 || curve.tick == 0
                || curve.depth == 0 || curve.bustBuffer > MAX_BUST_BUFFER || maxKeepBps < MIN_KEEP_BPS
                || maxKeepBps > BPS - FEE_BPS || maxConfBps == 0 || maxConfBps > MAX_CONF_BPS
                || maxNotional == 0 || _markets.length >= type(uint16).max
        ) revert BadParams();

        // Bounded by the length check above.
        // forge-lint: disable-next-line(unsafe-typecast)
        id = uint16(_markets.length);
        Market storage m = _markets.push();
        m.feedId = feedId;
        m.maxLeverage = maxLeverage;
        m.rateMultiplier = curve.rateMultiplier;
        m.positionMultiplier = curve.positionMultiplier;
        m.tick = curve.tick;
        m.bustBuffer = curve.bustBuffer;
        m.depth = curve.depth;
        m.maxKeepBps = maxKeepBps;
        m.maxConfBps = maxConfBps;
        m.maxNotional = maxNotional;
        m.capLong = capLong;
        m.capShort = capShort;
        emit MarketListed(id, feedId, symbol);
        emit CapsSet(id, capLong, capShort);
        emit DepthSet(id, curve.depth);
    }

    /// @notice Retires a market for good, freezing its price. Opens stop; closes and liquidations
    ///         settle at the frozen price from then on. A retired id never reopens.
    function retireMarket(uint16 id, bytes[] calldata update) external onlyGuardian nonReentrant {
        if (id >= _markets.length) revert BadMarket();
        Market storage m = _markets[id];
        if (m.retired) revert MarketIsRetired();
        (uint64 price,,) =
            oracle.within(m.feedId, update, uint64(block.timestamp) - RETIRE_MAX_AGE, type(uint64).max);
        m.retired = true;
        m.retiredAt = uint64(block.timestamp);
        m.frozenPrice = price;
        emit MarketRetired(id, price);
    }

    /// @notice Stops new opens everywhere. Closes, liquidations and withdrawals are unaffected.
    function pauseOpens() external onlyGuardian {
        opensPaused = true;
        emit OpensPausedSet(true);
    }

    function unpauseOpens() external onlyOwner {
        opensPaused = false;
        emit OpensPausedSet(false);
    }

    /// @notice Sets the most that may be open on each side of a market.
    /// @dev The caps and the depth are what stand between the house and a trader who moves the
    ///      market the oracle reads. A position is filled and closed at the oracle's price
    ///      whatever its size, so someone holding enough of one side can push the real price a
    ///      few basis points, close, and be paid on the whole position. The cap times the move is
    ///      the most that can ever earn, and it is the cap that bounds a large move. The depth is
    ///      what makes a small push on a full side earn a fraction of that. Both are sized under
    ///      what moving the real market costs, and only the owner sets them: an operator key must
    ///      not be able to lift them.
    function setCaps(uint16 id, uint96 capLong, uint96 capShort) external onlyOwner {
        if (id >= _markets.length) revert BadMarket();
        _markets[id].capLong = capLong;
        _markets[id].capShort = capShort;
        emit CapsSet(id, capLong, capShort);
    }

    /// @notice Sets how much may be open on one side of a market before size starts to cost, in
    ///         whole dollars.
    /// @dev It bites on positions opened from now on, orders already signed included: those are
    ///      covered by their own `impactLimit`. An open position keeps the terms it opened on, so
    ///      this never reprices anyone. In whole dollars, unlike the caps.
    function setDepth(uint16 id, uint32 depth) external onlyOwner {
        if (id >= _markets.length) revert BadMarket();
        if (depth == 0) revert BadParams();
        _markets[id].depth = depth;
        emit DepthSet(id, depth);
    }

    /// @notice Sets the smallest margin and the smallest position that can be opened. These decide
    ///         who can trade at all, so they are the owner's to set, not the operator's.
    function setMinimums(uint96 minMargin_, uint96 minNotional_) external onlyOwner {
        minMargin = minMargin_;
        minNotional = minNotional_;
        emit MinimumsSet(minMargin_, minNotional_);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setDevRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        devRecipient = recipient;
        emit DevRecipientSet(recipient);
    }

    /// @notice Attaches the coin: where staker fees go, and who pays losers. Once, forever.
    /// @dev The Exchange runs without a coin. Until one is attached, the staker share of fees
    ///      accrues here and is paid to stakers on the first push after attachment.
    function attachCoin(address staking_, address lossMining_, address sweeper_) external onlyOwner {
        if (staking != address(0)) revert AlreadyAttached();
        // Each has to be the right kind of contract, built for this Exchange. Each kind answers
        // under its own name, which catches arguments in the wrong order as well as contracts
        // deployed against another Exchange. Neither could be undone.
        if (
            IAttached(staking_).stakingFor() != address(this)
                || IAttached(lossMining_).lossMiningFor() != address(this)
                || IAttached(sweeper_).sweeperFor() != address(this)
        ) revert BadParams();
        staking = staking_;
        lossMining = lossMining_;
        sweeper = sweeper_;
        emit CoinAttached(staking_, lossMining_);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @notice The house's cash: everything held that is not a trader's balance, locked cash margin
    ///         or an accrued fee. While anything is queued, all of it is owed to the queue.
    function lpCash() public view returns (uint256) {
        return treasury - totalBalances - totalCashMargin - stakerFees - devFees;
    }

    /// @notice House equity above `stakerCap`, distributable to stakers. Zero while anyone is queued.
    function lpExcess() public view returns (uint256) {
        if (totalQueued != 0) return 0;
        uint256 cash = lpCash();
        uint256 floor = debtMarginOpen + stakerCap;
        return cash > floor ? cash - floor : 0;
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint16 id) external view returns (Market memory) {
        if (id >= _markets.length) revert BadMarket();
        return _markets[id];
    }

    function getPosition(bytes32 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// @notice Ids of every open position of `owner_`.
    function openIdsOf(address owner_) external view returns (bytes32[] memory) {
        return _openIds[owner_];
    }

    // ------------------------------------------------------------------------------------------
    // Settlement
    // ------------------------------------------------------------------------------------------

    /// @dev When the pending direct close for `id` was requested, or zero if there is none or it
    ///      has lapsed.
    function _liveRequest(bytes32 id) private view returns (uint64 requestedAt) {
        requestedAt = closeRequestedAt[id];
        if (requestedAt != 0 && block.timestamp >= uint256(requestedAt) + REQUEST_EXPIRY) requestedAt = 0;
    }

    /// @dev Once a binding direct close has been priced, that price stands: only a close or a
    ///      liquidation priced at an earlier moment than `pinTime` may still come first.
    function _beforeRequest(bytes32 id, uint64 pinTime) private view {
        uint64 requestedAt = _liveRequest(id);
        if (requestedAt != 0 && pinTime >= requestedAt + DIRECT_DELAY) revert CloseHasPriority();
    }

    function _openPrice(OpenIntent calldata it, bytes32, bytes[] calldata update)
        internal
        virtual
        returns (uint64 price, uint64 conf, uint64 publishTime)
    {
        uint64 minTime = it.timestamp + EXEC_DELAY();
        return oracle.pinned(_markets[it.market].feedId, update, minTime, minTime + PIN_WINDOW);
    }

    function _intentClosePrice(CloseIntent calldata it, Position memory p, bytes[] calldata update)
        internal
        virtual
        returns (uint64)
    {
        return _closePrice(p, it.timestamp + EXEC_DELAY(), update);
    }

    function _triggerPrice(Position memory p, uint64, uint64 touchedAt, bytes[] calldata update)
        internal
        virtual
        returns (uint64)
    {
        return _closePrice(p, touchedAt + EXEC_DELAY(), update);
    }

    function _triggerTouch(TriggerIntent calldata it, Position memory p, bytes[] calldata touch)
        internal
        virtual
        returns (uint64 price, uint64 touchedAt)
    {
        uint64 from = it.timestamp > p.openTime ? it.timestamp : uint64(p.openTime);
        (price,, touchedAt) = oracle.within(_markets[p.market].feedId, touch, from + 1, type(uint64).max);
    }

    function _liquidationPrice(bytes32, Position memory p, bytes[] calldata update)
        internal
        virtual
        returns (uint64 price, uint64 publishTime)
    {
        (price,, publishTime) =
            oracle.within(_markets[p.market].feedId, update, uint64(p.openTime) + 1, type(uint64).max);
    }

    function _closePrice(Position memory p, uint64 minTime, bytes[] calldata update)
        private
        returns (uint64 price)
    {
        Market storage m = _markets[p.market];
        if (m.retired) return m.frozenPrice;
        uint64 publishTime;
        (price,, publishTime) = oracle.pinned(m.feedId, update, minTime, minTime + PIN_WINDOW);
        if (publishTime <= p.openTime) revert CloseNotAfterOpen();
    }

    /// @param mustBust True for a liquidation: `exitPrice` has to be at or beyond the trigger.
    function _settle(bytes32 id, Position memory p, uint64 exitPrice, bool mustBust) private {
        Market storage m = _markets[p.market];
        uint256 notional = uint256(p.margin) * p.leverage;

        _removePosition(id, p);
        // The same amounts were added at open.
        // forge-lint: disable-start(unsafe-typecast)
        uint128 size = uint128(Math.mulDiv(notional, 1e18, p.entryPrice));
        if (p.isLong) {
            m.oiLong -= uint96(notional);
            m.sizeLong -= size;
        } else {
            m.oiShort -= uint96(notional);
            m.sizeShort -= size;
        }
        // forge-lint: disable-end(unsafe-typecast)

        uint256 cashMargin = p.margin - p.debtMargin;
        totalCashMargin -= cashMargin;
        debtMarginOpen -= p.debtMargin;

        // A close priced at or beyond the trigger is a bust like any other.
        (bool busted, bool win, uint256 amount) = pricing.close(
            p.entryPrice,
            exitPrice,
            notional,
            p.leverage,
            p.isLong,
            p.impactNotional,
            m.rateMultiplier,
            m.positionMultiplier,
            m.maxKeepBps,
            m.tick,
            m.bustBuffer
        );
        if (mustBust && !busted) revert NotLiquidatable();

        if (win) {
            _settleWin(id, p, exitPrice, cashMargin, amount);
        } else {
            _settleLoss(id, p, exitPrice, cashMargin, busted ? p.margin : Math.min(amount, p.margin), busted);
        }
    }

    /// @dev Cash margin goes straight back. The profit, and any queue-funded margin, is what the
    ///      house owes: paid now if it can be, queued if not.
    function _settleWin(bytes32 id, Position memory p, uint64 exitPrice, uint256 cashMargin, uint256 gain)
        private
    {
        uint256 fee = (gain * FEE_BPS) / BPS;
        uint256 profit = gain - fee;

        _credit(p.owner, cashMargin);
        (uint256 paid, uint256 queued, bool feePaid) = _payOrQueue(p.owner, p.debtMargin + profit, fee);

        emit PositionClosed(
            id,
            p.owner,
            p.market,
            CloseKind.Close,
            exitPrice,
            // A USDC amount, far below 2**255.
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(profit),
            cashMargin + paid,
            queued,
            feePaid ? fee : 0
        );
    }

    /// @dev A loss is shared pro rata between the cash and queue-funded parts of the margin. Lost
    ///      cash becomes house cash; lost queue-funded margin is debt the house simply no longer
    ///      owes. A bust takes all of both.
    function _settleLoss(
        bytes32 id,
        Position memory p,
        uint64 exitPrice,
        uint256 cashMargin,
        uint256 loss,
        bool busted
    ) private {
        uint256 lossDebt = busted ? p.debtMargin : Math.mulDiv(loss, p.debtMargin, p.margin);
        uint256 lossCash = loss - lossDebt;
        uint256 surviving = p.debtMargin - lossDebt;

        _credit(p.owner, cashMargin - lossCash);

        // The house-side fee is carved from what the house gained, never added to the loss. It is
        // paid only while nobody is queued and the house can also cover what it still owes here.
        // A bust charges nothing on queue-funded margin.
        uint256 fee;
        if (totalQueued == 0) {
            fee = ((lossCash + (busted ? 0 : lossDebt)) * FEE_BPS) / BPS;
            // Queue-funded margin in other positions is money the house still owes its owners.
            if (fee != 0 && lpCash() >= surviving + fee + debtMarginOpen) _accrueFee(fee);
            else fee = 0;
        }

        (uint256 paid, uint256 queued,) = _payOrQueue(p.owner, surviving, 0);
        if (totalQueued != 0) _harvest(AUTO_HARVEST);

        emit PositionClosed(
            id,
            p.owner,
            p.market,
            busted ? CloseKind.Liquidation : CloseKind.Close,
            exitPrice,
            // A USDC amount, far below 2**255.
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(loss),
            cashMargin - lossCash + paid,
            queued,
            fee
        );

        _mine(p.owner, busted ? p.margin : loss - fee);
    }

    /// @dev Pays `owed` from house cash if nobody is queued, and queues whatever is left. `fee` is
    ///      paid out only if the house can cover it on top of `owed`; otherwise the house keeps it.
    function _payOrQueue(address user, uint256 owed, uint256 fee)
        private
        returns (uint256 paid, uint256 queued, bool feePaid)
    {
        if (totalQueued == 0) {
            uint256 available = lpCash();
            paid = Math.min(owed, available);
            if (fee != 0 && available >= owed + fee + debtMarginOpen) {
                _accrueFee(fee);
                feePaid = true;
            }
            if (paid != 0) _credit(user, paid);
        }
        queued = owed - paid;
        if (queued != 0) _enqueue(user, queued);
    }

    function _enqueue(address user, uint256 amount) private {
        uint256 tail = queueTail;
        uint256 claimId;
        // `amount` is a USDC amount; uint96 holds 7.9e22 dollars.
        // forge-lint: disable-start(unsafe-typecast)
        if (tail != queueHead && claims[tail - 1].user == user) {
            // The back of the queue is already this trader's: extend it.
            claimId = tail - 1;
            claims[claimId].amount += uint96(amount);
        } else {
            claimId = tail;
            claims[claimId] = Claim(user, uint96(amount));
            queueTail = tail + 1;
        }
        // forge-lint: disable-end(unsafe-typecast)
        totalQueued += amount;
        queuedOf[user] += amount;
        emit Queued(user, claimId, amount);
    }

    /// @dev Spends queued payout as margin. The claims themselves are left in place and netted off
    ///      when the queue reaches them, oldest first.
    function _spendQueued(address user, uint256 amount) private {
        queuedOf[user] -= amount;
        totalQueued -= amount;
        queueSpent[user] += amount;
        emit QueueSpent(user, amount);
    }

    function _harvest(uint256 maxEntries) private {
        uint256 head = queueHead;
        uint256 tail = queueTail;
        uint256 available = lpCash();

        for (uint256 n; n < maxEntries && head < tail; ++n) {
            Claim storage claim = claims[head];
            address user = claim.user;
            uint256 amount = claim.amount;

            // Net off what this trader already spent as margin.
            uint256 spent = queueSpent[user];
            if (spent != 0) {
                uint256 netted = Math.min(spent, amount);
                queueSpent[user] = spent - netted;
                amount -= netted;
            }

            uint256 pay = Math.min(amount, available);
            if (pay != 0) {
                available -= pay;
                amount -= pay;
                totalQueued -= pay;
                queuedOf[user] -= pay;
                _credit(user, pay);
                emit QueuePaid(user, head, pay);
            }

            if (amount != 0) {
                // Out of cash with this claim still owed. It stays at the front.
                // `amount` only ever shrinks from a uint96.
                // forge-lint: disable-next-line(unsafe-typecast)
                claim.amount = uint96(amount);
                break;
            }
            delete claims[head];
            ++head;
        }
        queueHead = head;
    }

    function _removePosition(bytes32 id, Position memory p) internal virtual {
        bytes32[] storage ids = _openIds[p.owner];
        uint256 last = ids.length - 1;
        if (p.index != last) {
            bytes32 moved = ids[last];
            ids[p.index] = moved;
            _positions[moved].index = p.index;
        }
        ids.pop();
        delete _positions[id];
        delete closeRequestedAt[id];
    }

    function _credit(address user, uint256 amount) private {
        balances[user] += amount;
        totalBalances += amount;
    }

    function _accrueFee(uint256 fee) private {
        uint256 toStakers = (fee * STAKER_SHARE_BPS) / BPS;
        stakerFees += toStakers;
        devFees += fee - toStakers;
    }

    /// @dev Tells the loss-mining hook about a realised loss. The hook can never block a close or a
    ///      liquidation: it is gas-capped and its failure is swallowed.
    function _mine(address user, uint256 usd) private {
        address hook = lossMining;
        if (hook == address(0) || usd == 0) return;
        if (gasleft() < MINING_GAS_FLOOR) revert InsufficientGas();
        // A plain call, not try/catch: try/catch reverts when its target has no code, and a hook
        // whose code has gone must not be able to stop a loss from settling. The return data is
        // not copied, so a hostile hook cannot make that expensive either.
        (bool ok,) = hook.call{gas: MINING_GAS}(abi.encodeCall(ILossMining.onLoss, (user, usd)));
        if (!ok) emit MiningFailed(user, usd);
    }
}
