// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";

/// @dev Exercise the immutable risk ceiling through signed orders, including rollback and exits.
contract CashRiskTest is Base {
    uint64 private constant BTC_PRICE = 80_000e8;
    uint64 private constant ETH_PRICE = 2_500e8;

    function setUp() public override {
        super.setUp();
        _fund(alice, 100_000e6);
        _fund(bob, 100_000e6);
    }

    function _reject(uint96 margin, uint16 leverage) private {
        Intents.OpenIntent memory it = _intent(alice, btc, true, margin, leverage);
        bytes memory sig = _sign(alicePk, _hashOpen(it));
        bytes[] memory update = _update(BTC_FEED, BTC_PRICE, it.timestamp + ex.EXEC_DELAY());
        skip(12);
        vm.prank(operator);
        vm.expectRevert(Exchange.OpenInterestCap.selector);
        ex.open(it, sig, update);
        // Rejected orders cannot consume a signature or leave phantom exposure behind.
        assertFalse(ex.usedIntent(_hashOpen(it)));
        _assertSolvent();
    }

    function test_depositsDoNotRaiseTheCeilingAndRejectionRollsBack() public {
        assertEq(ex.lpCash(), 0);
        uint256 before = ex.balances(alice);
        _reject(2_001e6, 1_000);
        assertEq(ex.getMarket(btc).oiLong, 0);
        assertEq(ex.totalCashMargin(), 0);
        assertEq(ex.balances(alice), before);
        _open(alicePk, btc, true, 2_000e6, 1_000, BTC_PRICE);
        assertEq(ex.getMarket(btc).oiLong, pricing.CASH_OI_FLOOR());
        assertEq(ex.lpCash(), 0, "locked margin is not house cash");
        _reject(1e6, 1);
        assertEq(ex.getMarket(btc).oiLong, 2_000_000e6);
    }

    function test_houseCashRaisesTheCeilingButStaticCapsStillApply() public {
        _seedHouse(10_000e6);
        _open(alicePk, btc, true, 2_500e6, 1_000, BTC_PRICE);
        _reject(1e6, 1);
        vm.prank(admin);
        ex.setCaps(btc, 2_500_000e6, 2_500_000e6);
        _seedHouse(10_000e6);
        _reject(1e6, 1);
        assertEq(ex.getMarket(btc).oiLong, 2_500_000e6);
    }

    function test_sidesAndMarketsEachHaveTheirOwnCeiling() public {
        _open(alicePk, btc, true, 2_000e6, 1_000, BTC_PRICE);
        _open(bobPk, btc, false, 2_000e6, 1_000, BTC_PRICE);
        _open(alicePk, eth, true, 2_000e6, 1_000, ETH_PRICE);
        assertEq(ex.getMarket(btc).oiLong, 2_000_000e6);
        assertEq(ex.getMarket(btc).oiShort, 2_000_000e6);
        assertEq(ex.getMarket(eth).oiLong, 2_000_000e6);
        _assertSolvent();
    }

    function test_exitsRemainPossibleAfterCashAndTheCeilingFall() public {
        _seedHouse(10_000e6);
        bytes32 btcId = _open(alicePk, btc, true, 2_500e6, 1_000, BTC_PRICE);
        bytes32 ethId = _open(bobPk, eth, true, 100e6, 100, ETH_PRICE);
        _close(bobPk, ethId, 2_525e8);
        assertLt(ex.lpCash(), 10_000e6);
        assertGt(ex.getMarket(btc).oiLong, pricing.CASH_OI_FLOOR() + ex.lpCash() * 50);
        _reject(1e6, 1);
        _close(alicePk, btcId, BTC_PRICE);
        assertEq(ex.getMarket(btc).oiLong, 0);
        _assertSolvent();
    }
}
