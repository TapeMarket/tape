// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Exchange} from "../Exchange.sol";

/// @title SweeperBase
/// @notice Sends house cash above the cap to stakers, but only the part the house could spare if
///         every open position closed right now.
/// @dev The Exchange knows how much cash it holds above its cap, but not what its open positions
///      are worth: that needs prices. Without this check a trader could hold a long and a short at
///      once, close the losing one, have that loss swept to stakers as "cash above the cap", then
///      close the winner and be paid out of the cap itself.
///
///      So the sweep first marks the book. For each market it knows the open positions' total size
///      in units of the asset and what was paid for them; at the current price that gives what the
///      longs, taken together, and the shorts, taken together, are up. Whatever they are up is held
///      back. The impact haircut and the fee, which would both shrink the bill, are ignored.
///
///      A side is marked as a whole, so one position's paper loss offsets another's gain. That is
///      right while the loser still has margin to lose, and wrong once it is past the price where
///      its margin is gone and has not been liquidated yet: the house can only ever collect the
///      margin, not the paper loss. Position by position is the only exact answer and costs gas
///      without bound, so instead a further `MARGIN_BPS` of everything open is held back. That
///      covers positions up to that far past empty; the keeper liquidates long before, and after
///      a minute anyone can.
///
///      The caller picks the price, from any print of the last `MAX_AGE` seconds, and will pick the
///      one that holds back least. The same margin is what stands against that: the mark is wrong
///      by at most what the price moved inside the window, on what is open.
///
///      Marking a side as a whole also counts a loser's whole paper loss against a winner's gain,
///      though the house keeps only the loss less its 2% fee. That is safe because no win keeps
///      more than 98% of its gain: the Exchange refuses to list a market that would.
///
///      That makes the mark a ceiling, not the answer. It cannot see that another trader's paper
///      loss is not cash, that a position opened a moment ago is being marked at an older price,
///      or that a close already priced has yet to land. Left open to everyone, each of those is a
///      way to have the house pay stakers money it is about to owe a winner. So the sweep is the
///      operators' to call, like every other order of events on the Exchange, and the caller
///      states the most to send: the keeper works that out position by position, counting every
///      winner's gain and no loser's loss, at the latest price, once nothing is left to
///      liquidate. The check here is what bounds an operator who gets that wrong.
///
///      It has no owner, no settings and holds no funds. The Exchange lets it move at most
///      `lpExcess()`, the realised cash above the cap, and only to the staking contract.
///
///      Where the prices come from is the one thing left to the contract that inherits this:
///      `Sweeper` reads Pyth, `SignedSweeper` the Exchange's own signed oracle.
abstract contract SweeperBase {
    /// @notice How old a price may be and still be used to mark the book.
    uint64 public constant MAX_AGE = 30;
    /// @notice Held back on top of what the open positions are up, in basis points of everything
    ///         open: a margin for positions past the price where their margin is gone.
    uint256 public constant MARGIN_BPS = 20;
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    Exchange public immutable exchange;

    error ZeroAddress();
    error NotOperator();
    error NothingToSweep();
    error RefundFailed();

    constructor(Exchange exchange_) {
        if (address(exchange_) == address(0)) revert ZeroAddress();
        exchange = exchange_;
    }

    /// @notice Sweeps to stakers everything the mark allows.
    function sweep(bytes[] calldata updates) external payable returns (uint256) {
        return _sweep(updates, type(uint256).max);
    }

    /// @notice Sweeps to stakers what can be spared, and never more than `maxAmount`.
    /// @param updates Signed price updates, no older than `MAX_AGE`, covering every market that is
    ///        not retired and has open positions. Any ETH sent and not spent on them comes back.
    /// @param maxAmount The most to send: the caller's own, exact figure of what the house can spare.
    /// @return amount USDC sent to the staking contract.
    function sweep(bytes[] calldata updates, uint256 maxAmount) external payable returns (uint256) {
        return _sweep(updates, maxAmount);
    }

    function _sweep(bytes[] calldata updates, uint256 maxAmount) private returns (uint256 amount) {
        if (!exchange.isOperator(msg.sender)) revert NotOperator();
        uint256 owed = _owed(updates);
        uint256 excess = exchange.lpExcess();
        if (excess <= owed) revert NothingToSweep();
        amount = Math.min(excess - owed, maxAmount);
        if (amount == 0) revert NothingToSweep();
        exchange.sweepExcess(amount);

        uint256 change = address(this).balance;
        if (change != 0) {
            (bool ok,) = msg.sender.call{value: change}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice The Exchange this is the sweeper of. Only a sweeper answers this.
    function sweeperFor() external view returns (address) {
        return address(exchange);
    }

    /// @dev What the open positions, side by side and market by market, are up at these prices,
    ///      plus the margin on everything open.
    function _owed(bytes[] calldata updates) private returns (uint256 owed) {
        uint256 count = exchange.marketCount();
        Exchange.Market[] memory markets = new Exchange.Market[](count);
        bool live;
        for (uint256 i; i < count; ++i) {
            // `count` is capped at uint16 by the Exchange.
            // forge-lint: disable-next-line(unsafe-typecast)
            markets[i] = exchange.getMarket(uint16(i));
            if (_needsPrice(markets[i])) live = true;
        }

        uint256[] memory prices = live ? _prices(markets, updates) : new uint256[](count);

        for (uint256 i; i < count; ++i) {
            Exchange.Market memory m = markets[i];
            if (m.sizeLong == 0 && m.sizeShort == 0) continue;
            uint256 price = m.retired ? m.frozenPrice : prices[i];
            // Rounded against the sweep on both sides.
            uint256 longsWorth = Math.mulDiv(m.sizeLong, price, WAD, Math.Rounding.Ceil);
            uint256 shortsWorth = Math.mulDiv(m.sizeShort, price, WAD);
            if (longsWorth > m.oiLong) owed += longsWorth - m.oiLong;
            if (m.oiShort > shortsWorth) owed += m.oiShort - shortsWorth;
            owed += Math.mulDiv(uint256(m.oiLong) + m.oiShort, MARGIN_BPS, BPS, Math.Rounding.Ceil);
        }
    }

    /// @dev A market is marked at a live price while it is not retired and has something open.
    function _needsPrice(Exchange.Market memory m) internal pure returns (bool) {
        return !m.retired && (m.sizeLong != 0 || m.sizeShort != 0);
    }

    /// @dev The price, scaled to 1e8, of every market in `markets` that `_needsPrice`, at its own
    ///      index in the answer, each from a print published in the last `MAX_AGE` seconds. Has to
    ///      revert unless every one of them has such a print in `updates`. Called only when at
    ///      least one market needs a price.
    function _prices(Exchange.Market[] memory markets, bytes[] calldata updates)
        internal
        virtual
        returns (uint256[] memory prices);
}
