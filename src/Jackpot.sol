// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title Jackpot
/// @notice Every dollar a trader loses on the Exchange is a ticket. Every round (an hour), one
///         ticket wins the pot, in USDC, straight to the winner's wallet.
/// @dev Tickets come from one place only: the loss-mining contract, which the Exchange tells about
///      every realised loss (a liquidation counts its whole margin). Nobody else can enter anyone.
///
///      Funding is credited to the current round through `fund` or `sync` (the FeeSplitter calls
///      sync in the same transaction as its transfer). A plain transfer is credited to the round
///      in which it is first synced, never retrospectively. Close and draw settle rounds in order.
///      Close reserves `payoutBps` of that round's funding before the draw hash exists; any remainder,
///      or all funding of an empty round, rolls to the next round. Later funding cannot enlarge an
///      old prize. An unpaid winner's reserved USDC is never part of another round's pot.
///
///      The draw. Once a round is over, anyone `close`s it, which names a block a few blocks ahead.
///      Once that block exists, anyone `draw`s: its hash picks a point along the round's tickets,
///      and the ticket holding that point wins. Nobody knows that hash when the round closes, and
///      nothing done after it changes who held which tickets. The one party with any say is the
///      validator of that block, who could withhold it and lose its reward: a bias worth trying
///      only for a pot far larger than a block's reward. A hash older than 256 blocks can no longer
///      be read; a round whose block has gone past that is simply closed again.
///
///      No owner. The loss source is bound once, by the deployer, and never changes.
contract Jackpot is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Entry {
        address user;
        /// @dev The round's tickets up to and including this entry, in 6-decimal USD.
        uint96 cumulative;
    }

    struct Round {
        uint64 drawBlock;
        bool drawn;
        address winner;
        uint128 prize;
    }

    IERC20 public immutable usdc;
    /// @notice The start of round 0, and how long a round lasts, in seconds.
    uint64 public immutable start;
    uint64 public immutable roundLength;
    /// @notice The share of the pot one draw pays, in basis points.
    uint16 public immutable payoutBps;
    address private immutable _deployer;

    /// @notice Blocks between a round's close and the block whose hash draws it.
    uint256 public constant DRAW_DELAY = 5;

    /// @notice The only contract that may enter tickets: the loss-mining contract.
    address public source;
    mapping(uint256 round => Entry[]) private _entries;
    mapping(uint256 round => Round) public rounds;
    /// @notice The oldest round not yet drawn. Later rounds cannot close ahead of it.
    uint256 public nextRound;
    /// @notice Funding not yet reserved, including deterministic rollovers from the previous round.
    mapping(uint256 round => uint256) public funding;
    /// @notice Closed prizes, including drawn prizes whose transfer has not succeeded.
    uint256 public reservedPrizes;
    mapping(uint256 round => bool) public paid;
    uint256 private _accountedBalance;
    uint256 private constant PAYOUT_GAS = 100_000;

    event SourceBound(address indexed source);
    event Entered(uint256 indexed round, address indexed user, uint256 usd);
    event Closed(uint256 indexed round, uint256 drawBlock);
    event Drawn(uint256 indexed round, address indexed winner, uint256 prize, uint256 tickets);
    event Funded(uint256 indexed round, uint256 amount);
    event PrizePaid(uint256 indexed round, address indexed winner, uint256 amount);
    event PrizePending(uint256 indexed round, address indexed winner, uint256 amount);

    error NotDeployer();
    error AlreadyBound();
    error ZeroAddress();
    error BadParams();
    error NotSource();
    error NotOver();
    error AlreadyClosed();
    error NotClosed();
    error NotYet();
    error HashGone();
    error AlreadyDrawn();
    error RoundOrder();
    error NotSelf();
    error NothingToClaim();

    constructor(IERC20 usdc_, uint64 start_, uint64 roundLength_, uint16 payoutBps_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (roundLength_ == 0 || payoutBps_ == 0 || payoutBps_ > 10_000) revert BadParams();
        usdc = usdc_;
        start = start_;
        roundLength = roundLength_;
        payoutBps = payoutBps_;
        _deployer = msg.sender;
    }

    /// @notice Names the loss-mining contract as the source of tickets. Once.
    function bind(address source_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (source != address(0)) revert AlreadyBound();
        if (source_ == address(0)) revert ZeroAddress();
        source = source_;
        emit SourceBound(source_);
    }

    /// @notice The round a moment falls in.
    function roundAt(uint256 time) public view returns (uint256) {
        return time < start ? 0 : (time - start) / roundLength;
    }

    /// @notice The current round's funding, excluding every reserved prize and older round's funds.
    function pot() public view returns (uint256) {
        return funding[roundAt(block.timestamp)] + usdc.balanceOf(address(this)) - _accountedBalance;
    }

    /// @notice Funds the current round. Approve this contract for `amount` USDC first.
    function fund(uint256 amount) external nonReentrant {
        _sync();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _sync();
    }

    /// @notice Credits unsynced transfers to the current round. Call with the transfer, before its end.
    function sync() external nonReentrant {
        _sync();
    }

    function _sync() private {
        uint256 balance = usdc.balanceOf(address(this));
        uint256 amount = balance - _accountedBalance;
        if (amount == 0) return;
        uint256 round = roundAt(block.timestamp);
        funding[round] += amount;
        _accountedBalance = balance;
        emit Funded(round, amount);
    }

    /// @notice All the tickets of a round, in 6-decimal USD.
    function tickets(uint256 round) public view returns (uint256) {
        Entry[] storage list = _entries[round];
        return list.length == 0 ? 0 : list[list.length - 1].cumulative;
    }

    /// @notice How many entries a round has, and one of them.
    function entryCount(uint256 round) external view returns (uint256) {
        return _entries[round].length;
    }

    function entryAt(uint256 round, uint256 i) external view returns (Entry memory) {
        return _entries[round][i];
    }

    /// @notice A loss of `usd`, realised by `user`: that many tickets in the current round.
    function enter(address user, uint256 usd) external {
        if (msg.sender != source) revert NotSource();
        if (usd == 0) return;
        uint256 round = roundAt(block.timestamp);
        Entry[] storage list = _entries[round];
        uint256 n = list.length;
        // A uint96 of 6-decimal dollars holds 79 billion billion dollars.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint96 cumulative = uint96((n == 0 ? 0 : list[n - 1].cumulative) + usd);
        // The same trader losing again straight after: one entry, larger.
        if (n != 0 && list[n - 1].user == user) list[n - 1].cumulative = cumulative;
        else list.push(Entry(user, cumulative));
        emit Entered(round, user, usd);
    }

    /// @notice Ends a round that is over: names the block whose hash will draw it.
    function close(uint256 round) external nonReentrant {
        if (block.timestamp < uint256(start) + (round + 1) * roundLength) revert NotOver();
        Round storage r = rounds[round];
        if (r.drawn) revert AlreadyDrawn();
        if (round != nextRound) revert RoundOrder();
        // Closed and its block still readable (or not yet mined): it stands.
        if (r.drawBlock != 0 && block.number <= uint256(r.drawBlock) + 256) revert AlreadyClosed();
        // Only the first close allocates funds. Re-closing an expired hash cannot change a prize.
        if (r.drawBlock == 0) {
            _sync();
            uint256 budget = funding[round];
            uint256 prize = tickets(round) == 0 ? 0 : Math.mulDiv(budget, payoutBps, 10_000);
            if (prize > type(uint128).max) revert BadParams();
            r.prize = uint128(prize);
            reservedPrizes += prize;
            delete funding[round];
            funding[round + 1] += budget - prize;
            // Empty rounds need no randomness; settle them immediately so downtime can be caught up.
            if (tickets(round) == 0) {
                r.drawn = true;
                nextRound = round + 1;
                emit Drawn(round, address(0), 0, 0);
                return;
            }
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        r.drawBlock = uint64(block.number + DRAW_DELAY);
        emit Closed(round, r.drawBlock);
    }

    /// @notice Finalizes a closed round and attempts payment. Rejected delivery leaves a claim.
    function draw(uint256 round) external nonReentrant returns (address winner, uint256 prize) {
        Round storage r = rounds[round];
        if (r.drawn) revert AlreadyDrawn();
        if (r.drawBlock == 0) revert NotClosed();
        if (block.number <= r.drawBlock) revert NotYet();
        bytes32 hash = blockhash(r.drawBlock);
        if (hash == bytes32(0)) revert HashGone();
        r.drawn = true;
        nextRound = round + 1;

        uint256 total = tickets(round);
        if (total == 0) {
            emit Drawn(round, address(0), 0, 0);
            return (address(0), 0);
        }
        uint256 point = uint256(keccak256(abi.encode(hash, round))) % total;
        winner = _holder(_entries[round], point);
        prize = r.prize;
        r.winner = winner;
        emit Drawn(round, winner, prize, total);
        if (prize != 0) {
            // An isolated, bounded subcall rolls back delivery only, never the draw or reservation.
            try this.deliver{gas: PAYOUT_GAS}(round) {}
            catch {
                emit PrizePending(round, winner, prize);
            }
        }
    }

    /// @notice Retries an unpaid prize. Anyone may pay it, always to the recorded winner.
    function claim(uint256 round) external nonReentrant {
        _pay(round);
    }

    /// @dev Isolates the automatic transfer so even a false-returning token rolls back its effects.
    function deliver(uint256 round) external {
        if (msg.sender != address(this)) revert NotSelf();
        _pay(round);
    }

    function _pay(uint256 round) private {
        Round storage r = rounds[round];
        uint256 amount = r.prize;
        if (!r.drawn || amount == 0 || paid[round]) revert NothingToClaim();
        paid[round] = true;
        reservedPrizes -= amount;
        _accountedBalance -= amount;
        usdc.safeTransfer(r.winner, amount);
        emit PrizePaid(round, r.winner, amount);
    }

    /// @dev The entry whose tickets hold `point`: the first whose running total passes it.
    function _holder(Entry[] storage list, uint256 point) private view returns (address) {
        uint256 lo;
        uint256 hi = list.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (list[mid].cumulative > point) hi = mid;
            else lo = mid + 1;
        }
        return list[lo].user;
    }
}
