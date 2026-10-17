// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FastExchange} from "../src/FastExchange.sol";
import {Exchange} from "../src/Exchange.sol";
import {ExecutionOracle} from "../src/ExecutionOracle.sol";
import {SignedOracle} from "../src/SignedOracle.sol";
import {Intents} from "../src/base/Intents.sol";
import {Pricing} from "../src/Pricing.sol";
import {Sessions} from "../src/Sessions.sol";
import {MockUSDC} from "./mocks/Mocks.sol";

contract FastExchangeTest is Test {
    uint64 constant T = 1_800_000_000;
    uint64 constant P = 80_000e8;
    bytes32 constant FEED = bytes32("hyperliquid:BTC");
    bytes32 constant OPEN = keccak256("Open(address owner,uint16 market,bool isLong,bool useQueued,uint16 leverage,uint96 margin,uint64 priceLimit,uint32 impactLimit,uint64 timestamp,uint64 salt)");
    bytes32 constant CLOSE = keccak256("Close(address owner,bytes32 positionId,uint64 timestamp)");
    bytes32 constant TRIGGER = keccak256("Trigger(address owner,bytes32 positionId,uint64 price,bool above,uint64 timestamp)");
    uint256 constant USER_KEY = 0xA11CE;
    uint256 constant SIGNER_KEY = 0x51C4ED;
    MockUSDC usdc;
    FastExchange ex;
    ExecutionOracle oracle;
    address user;
    uint64 salt;

    function setUp() public {
        vm.warp(T);
        user = vm.addr(USER_KEY);
        usdc = new MockUSDC();
        Pricing pricing = new Pricing();
        Sessions sessions = new Sessions("Tape");
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        oracle = new ExecutionOracle(predicted, vm.addr(SIGNER_KEY));
        bytes memory code = abi.encodePacked(vm.getCode("deployable/fast/FastExchange.json"), abi.encode("Tape", usdc, oracle, pricing, sessions, address(this), address(this), uint256(5_000_000e6), uint96(1e6)));
        address created;
        assembly ("memory-safe") { created := create(0, add(code, 32), mload(code)) }
        require(created != address(0), "FastExchange deployment failed");
        ex = FastExchange(created);
        assertEq(address(ex), predicted);
        ex.setOperator(address(this), true);
        ex.listMarket(FEED, "BTC", 1000, Exchange.Curve(15_000, 814_598, 1e7, 476041580087574, type(uint32).max), 9_000, 50, 10_000_000e6, 1e15, 1e15);
        usdc.mint(user, 10_000e6);
        vm.startPrank(user);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(10_000e6);
        vm.stopPrank();
        usdc.mint(address(this), 50_000e6);
        usdc.approve(address(ex), type(uint256).max);
        ex.donate(50_000e6);
    }

    function sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
    function digest(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
    function intent() internal returns (Intents.OpenIntent memory it) {
        it = Intents.OpenIntent(user, 0, true, false, 100, 100e6, 0, 0, T, ++salt);
    }
    function openHash(Intents.OpenIntent memory it) internal view returns (bytes32) {
        return digest(ex.domainSeparator(), keccak256(abi.encode(OPEN, it.owner, it.market, it.isLong, it.useQueued, it.leverage, it.margin, it.priceLimit, it.impactLimit, it.timestamp, it.salt)));
    }
    function fill(bytes32 id, uint64 price, uint64 ms) internal view returns (bytes[] memory update) {
        bytes32 h = digest(oracle.domainSeparator(), keccak256(abi.encode(oracle.FILL_TYPEHASH(), FEED, id, price, uint64(0), ms / 1000, ms)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, h);
        update = new bytes[](1);
        update[0] = abi.encode(FEED, id, price, uint64(0), ms / 1000, ms, v, r, s);
    }
    function tick(uint64 price, uint64 ms) internal view returns (bytes[] memory update) {
        uint64 prev = ms - 1;
        bytes32 h = digest(oracle.domainSeparator(), keccak256(abi.encode(oracle.TICK_TYPEHASH(), FEED, price, uint64(0), ms / 1000, prev / 1000, ms, prev)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, h);
        update = new bytes[](1);
        update[0] = abi.encode(FEED, price, uint64(0), ms / 1000, prev / 1000, ms, prev, v, r, s);
    }
    function opened(uint64 ms) internal returns (bytes32 id) {
        Intents.OpenIntent memory it = intent();
        id = openHash(it);
        ex.open(it, sig(USER_KEY, id), fill(id, P, ms));
    }
    function closeOrder(bytes32 id) internal view returns (Intents.CloseIntent memory it, bytes32 h) {
        it = Intents.CloseIntent(user, id, T);
        h = digest(ex.domainSeparator(), keccak256(abi.encode(CLOSE, user, id, T)));
    }

    function test_noFixedWait_openExecutesAtTheOrderSecond() public {
        assertEq(ex.EXEC_DELAY(), 0);
        bytes32 id = opened(T * 1000 + 100);
        Exchange.Position memory p = ex.getPosition(id);
        assertEq(p.openTime, T);
        assertEq(p.entryPrice, P);
        assertEq(ex.balances(user), 9_900e6);
    }
    function test_closeCanFollowOpenWithinTheSameSecond() public {
        bytes32 id = opened(T * 1000 + 100);
        (Intents.CloseIntent memory it, bytes32 h) = closeOrder(id);
        ex.close(it, sig(USER_KEY, h), fill(h, 80_100e8, T * 1000 + 200));
        assertEq(ex.getPosition(id).owner, address(0));
        assertGt(ex.balances(user), 10_000e6);
    }
    function test_closeCannotUseAQuoteAtOrBeforeItsEntryMillisecond() public {
        bytes32 id = opened(T * 1000 + 500);
        (Intents.CloseIntent memory it, bytes32 h) = closeOrder(id);
        bytes[] memory update = fill(h, P, T * 1000 + 400);
        vm.expectRevert(Exchange.CloseNotAfterOpen.selector);
        ex.close(it, sig(USER_KEY, h), update);
    }
    function test_liquidationCanFollowOpenWithinTheSameSecond() public {
        bytes32 id = opened(T * 1000 + 100);
        ex.liquidate(id, tick(78_000e8, T * 1000 + 200));
        assertEq(ex.getPosition(id).owner, address(0));
        assertEq(ex.balances(user), 9_900e6);
    }
    function test_liquidationRejectsATickFromBeforeEntry() public {
        bytes32 id = opened(T * 1000 + 500);
        bytes[] memory update = tick(78_000e8, T * 1000 + 100);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        ex.liquidate(id, update);
    }
    function test_publicMarketPrintCannotFillAManualOrder() public {
        Intents.OpenIntent memory it = intent();
        bytes32 id = openHash(it);
        bytes[] memory update = tick(P, T * 1000 + 100);
        vm.expectRevert(SignedOracle.BadUpdate.selector);
        ex.open(it, sig(USER_KEY, id), update);
    }
    function test_anExecutionQuoteCannotBeUsedAsAPublicLiquidationTick() public {
        bytes32 id = opened(T * 1000 + 100);
        bytes[] memory update = fill(id, 78_000e8, T * 1000 + 200);
        vm.expectRevert(SignedOracle.BadUpdate.selector);
        ex.liquidate(id, update);
    }
    function test_quoteCannotBeMovedToAnotherOrderOrDirection() public {
        Intents.OpenIntent memory first = intent();
        bytes[] memory update = fill(openHash(first), P, T * 1000 + 100);
        Intents.OpenIntent memory second = first;
        second.isLong = false;
        bytes32 id = openHash(second);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        ex.open(second, sig(USER_KEY, id), update);
    }
    function test_quoteCannotBeMovedBetweenOracleDeployments() public {
        Intents.OpenIntent memory it = intent();
        bytes32 id = openHash(it);
        bytes[] memory update = fill(id, P, T * 1000 + 100);
        ExecutionOracle other = new ExecutionOracle(address(ex), vm.addr(SIGNER_KEY));
        vm.expectRevert(SignedOracle.BadSignature.selector);
        other.fill(FEED, id, update, T, T + 10);
    }
    function test_quoteCannotBeMovedBetweenChains() public {
        Intents.OpenIntent memory it = intent();
        bytes32 id = openHash(it);
        bytes[] memory update = fill(id, P, T * 1000 + 100);
        bytes memory signature = sig(USER_KEY, id);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(SignedOracle.BadSignature.selector);
        oracle.fill(FEED, id, update, T, T + 10);
        signature;
    }
    function test_usedOrderCannotExecuteTwice() public {
        Intents.OpenIntent memory it = intent();
        bytes32 id = openHash(it);
        bytes memory signature = sig(USER_KEY, id);
        bytes[] memory update = fill(id, P, T * 1000 + 100);
        ex.open(it, signature, update);
        vm.expectRevert(Exchange.IntentUsed.selector);
        ex.open(it, signature, update);
    }
    function test_replacedSignerInvalidatesOldQuotes() public {
        Intents.OpenIntent memory it = intent();
        bytes32 id = openHash(it);
        bytes[] memory update = fill(id, P, T * 1000 + 100);
        oracle.setSigner(vm.addr(0xBAD));
        vm.expectRevert(SignedOracle.BadSignature.selector);
        ex.open(it, sig(USER_KEY, id), update);
    }
    function test_triggerFillsAtItsActualTouchWithoutAnExtraWait() public {
        bytes32 id = opened(T * 1000 + 100);
        Intents.TriggerIntent memory it = Intents.TriggerIntent(user, id, 80_100e8, true, T);
        bytes32 h = digest(ex.domainSeparator(), keccak256(abi.encode(TRIGGER, user, id, it.price, true, T)));
        bytes[] memory touch = tick(80_200e8, (T + 1) * 1000 + 50);
        vm.warp(T + 1);
        ex.closeOnTrigger(it, sig(USER_KEY, h), touch, new bytes[](0));
        assertEq(ex.getPosition(id).owner, address(0));
    }
    function test_newTriggerCannotSelectAnAlreadyKnownTickInItsSigningSecond() public {
        bytes32 id = opened(T * 1000 + 100);
        Intents.TriggerIntent memory it = Intents.TriggerIntent(user, id, 80_100e8, true, T);
        bytes32 h = digest(ex.domainSeparator(), keccak256(abi.encode(TRIGGER, user, id, it.price, true, T)));
        bytes[] memory touch = tick(80_200e8, T * 1000 + 500);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        ex.closeOnTrigger(it, sig(USER_KEY, h), touch, new bytes[](0));
    }
    function test_walletWithdrawalStillNeedsTheOwnersSignature() public {
        uint64 deadline = T + 600;
        bytes32 h = digest(ex.domainSeparator(), keccak256(abi.encode(keccak256("Withdraw(address owner,address to,uint256 amount,uint256 nonce,uint64 deadline)"), user, user, uint256(100e6), uint256(0), deadline)));
        ex.withdrawBySig(user, user, 100e6, deadline, sig(USER_KEY, h));
        assertEq(usdc.balanceOf(user), 100e6);
        assertEq(ex.withdrawNonces(user), 1);
        vm.expectRevert(Intents.BadSignature.selector);
        ex.withdrawBySig(user, address(this), 100e6, deadline, sig(USER_KEY, h));
    }
    function test_permissionlessExitStillWorksWithoutThePriceOperator() public {
        vm.prank(user);
        ex.requestWithdraw(100e6);
        vm.warp(T + ex.WITHDRAW_DELAY());
        vm.prank(user);
        ex.executeWithdraw(user);
        assertEq(usdc.balanceOf(user), 100e6);
    }
}
