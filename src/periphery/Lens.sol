// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Exchange} from "../Exchange.sol";
import {Sessions} from "../Sessions.sol";
import {PerpMath} from "../libraries/PerpMath.sol";

/// @title Lens
/// @notice Read-only views over the Exchange, shaped for a frontend. Holds no state and no funds.
contract Lens {
    Exchange public immutable exchange;

    struct PositionView {
        bytes32 id;
        Exchange.Position position;
        uint256 bustPrice;
        /// @dev Non-zero if a binding direct close is pending.
        uint64 closeRequestedAt;
    }

    struct Account {
        uint256 balance;
        uint256 queued;
        uint256 marginInUse;
        uint256 openCount;
        /// @dev Non-zero only while a direct withdrawal request is pending.
        uint256 withdrawAmount;
        uint256 withdrawRequestedAt;
        uint256 sessionNonce;
        uint256 withdrawNonce;
    }

    struct House {
        uint256 lpCash;
        uint256 totalQueued;
        uint256 debtMarginOpen;
        /// @dev Cash minus everything owed. Negative while winners are waiting.
        int256 equity;
        uint256 excess;
        uint256 stakerCap;
        uint256 stakerFees;
        uint256 devFees;
        uint256 queueLength;
        uint256 treasury;
        uint256 totalBalances;
        uint256 totalCashMargin;
        uint256 minMargin;
        uint256 minNotional;
        bool opensPaused;
    }

    struct ClaimView {
        uint256 id;
        address user;
        /// @dev What is still owed on this claim, after netting off queued payout already spent.
        uint256 amount;
    }

    error NoPosition();

    constructor(Exchange exchange_) {
        exchange = exchange_;
    }

    function markets() external view returns (Exchange.Market[] memory list) {
        uint256 count = exchange.marketCount();
        list = new Exchange.Market[](count);
        for (uint256 i; i < count; ++i) {
            // `count` is capped at uint16 by the Exchange.
            // forge-lint: disable-next-line(unsafe-typecast)
            list[i] = exchange.getMarket(uint16(i));
        }
    }

    function _bustPrice(Exchange.Position memory p) private view returns (uint256) {
        Exchange.Market memory m = exchange.getMarket(p.market);
        return PerpMath.bustPrice(p.entryPrice, p.leverage, p.isLong, m.tick, m.bustBuffer);
    }

    function positionsOf(address owner) public view returns (PositionView[] memory list) {
        bytes32[] memory ids = exchange.openIdsOf(owner);
        list = new PositionView[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            Exchange.Position memory p = exchange.getPosition(ids[i]);
            list[i] = PositionView({
                id: ids[i],
                position: p,
                bustPrice: _bustPrice(p),
                closeRequestedAt: exchange.closeRequestedAt(ids[i])
            });
        }
    }

    function account(address owner) external view returns (Account memory a) {
        PositionView[] memory open = positionsOf(owner);
        for (uint256 i; i < open.length; ++i) {
            a.marginInUse += open[i].position.margin;
        }
        a.openCount = open.length;
        a.balance = exchange.balances(owner);
        a.queued = exchange.queuedOf(owner);
        (uint128 amount, uint64 requestedAt, uint64 closedAt) = exchange.withdrawRequests(owner);
        if (requestedAt != 0 && closedAt == 0) {
            a.withdrawAmount = amount;
            a.withdrawRequestedAt = requestedAt;
        }
        a.sessionNonce = Sessions(address(exchange.sessions())).nonces(owner);
        a.withdrawNonce = exchange.withdrawNonces(owner);
    }

    function house() external view returns (House memory h) {
        h.lpCash = exchange.lpCash();
        h.totalQueued = exchange.totalQueued();
        h.debtMarginOpen = exchange.debtMarginOpen();
        // USDC amounts, far below 2**255.
        // forge-lint: disable-next-line(unsafe-typecast)
        h.equity = int256(h.lpCash) - int256(h.totalQueued) - int256(h.debtMarginOpen);
        h.excess = exchange.lpExcess();
        h.stakerCap = exchange.stakerCap();
        h.stakerFees = exchange.stakerFees();
        h.devFees = exchange.devFees();
        h.queueLength = exchange.queueTail() - exchange.queueHead();
        h.treasury = exchange.treasury();
        h.totalBalances = exchange.totalBalances();
        h.totalCashMargin = exchange.totalCashMargin();
        h.minMargin = exchange.minMargin();
        h.minNotional = exchange.minNotional();
        h.opensPaused = exchange.opensPaused();
    }

    /// @notice What a close at `exitPrice` would be worth, before the queue decides how it is paid.
    /// @return busted True if `exitPrice` is at or beyond the bust trigger.
    /// @return pnl Profit after the deadband, impact and win fee; or minus the loss.
    function quoteClose(bytes32 id, uint64 exitPrice) external view returns (bool busted, int256 pnl) {
        Exchange.Position memory p = exchange.getPosition(id);
        if (p.owner == address(0)) revert NoPosition();
        Exchange.Market memory m = exchange.getMarket(p.market);

        // Every branch is a bounded USDC amount.
        // forge-lint: disable-start(unsafe-typecast)
        if (PerpMath.crossed(
                exitPrice,
                PerpMath.bustPrice(p.entryPrice, p.leverage, p.isLong, m.tick, m.bustBuffer),
                p.isLong
            )) {
            return (true, -int256(uint256(p.margin)));
        }
        (bool win, uint256 amount) = PerpMath.settle(
            p.entryPrice,
            exitPrice,
            uint256(p.margin) * p.leverage,
            p.isLong,
            p.impactNotional,
            m.rateMultiplier,
            m.positionMultiplier,
            m.maxKeepBps,
            m.tick
        );
        if (win) return (false, int256(amount - (amount * exchange.FEE_BPS()) / 10_000));
        return (false, -int256(Math.min(amount, p.margin)));
        // forge-lint: disable-end(unsafe-typecast)
    }

    /// @notice The front of the payout queue: up to `count` claims that are still owed something.
    /// @param maxScan Upper bound on raw queue entries walked, spent ones included.
    function queueFront(uint256 count, uint256 maxScan) external view returns (ClaimView[] memory page) {
        (ClaimView[] memory live, uint256 found) = _walk(count, maxScan, address(0));
        page = new ClaimView[](found);
        for (uint256 i; i < found; ++i) {
            page[i] = live[i];
        }
    }

    /// @notice How much is owed to others before `user`'s first unpaid claim.
    /// @return ahead USDC queued in front of `user`.
    /// @return found False if `user` has no unpaid claim inside the first `maxScan` entries.
    function queueAhead(address user, uint256 maxScan) external view returns (uint256 ahead, bool found) {
        (ClaimView[] memory live, uint256 count) = _walk(maxScan, maxScan, user);
        for (uint256 i; i < count; ++i) {
            if (live[i].user == user) return (ahead, true);
            ahead += live[i].amount;
        }
    }

    /// @dev Walks the queue from the head the way a harvest would, netting each trader's spent
    ///      payout off their oldest claims. Stops after `count` live claims, `maxScan` entries, or
    ///      the first live claim of `stopAt`.
    function _walk(uint256 count, uint256 maxScan, address stopAt)
        private
        view
        returns (ClaimView[] memory live, uint256 found)
    {
        uint256 head = exchange.queueHead();
        uint256 end = Math.min(exchange.queueTail(), head + maxScan);
        live = new ClaimView[](Math.min(count, end - head));

        address[] memory users = new address[](end - head);
        uint256[] memory spentLeft = new uint256[](end - head);
        uint256 known;

        for (uint256 id = head; id < end && found < live.length; ++id) {
            (address user, uint96 amount) = exchange.claims(id);

            uint256 slot;
            for (; slot < known; ++slot) {
                if (users[slot] == user) break;
            }
            if (slot == known) {
                users[known] = user;
                spentLeft[known] = exchange.queueSpent(user);
                ++known;
            }

            uint256 netted = Math.min(spentLeft[slot], amount);
            spentLeft[slot] -= netted;
            uint256 owed = amount - netted;
            if (owed == 0) continue;

            live[found++] = ClaimView(id, user, owed);
            if (user == stopAt) break;
        }
    }
}
