// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockUSDC} from "./mocks/Mocks.sol";
import {Base} from "./Base.t.sol";
import {Deployer} from "./Deployer.sol";
import {Intents} from "../src/base/Intents.sol";
import {Exchange} from "../src/Exchange.sol";
import {Jackpot} from "../src/Jackpot.sol";
import {LaunchCoin} from "../src/LaunchCoin.sol";
import {LossMining} from "../src/LossMining.sol";
import {Staking} from "../src/Staking.sol";
import {Deposits, IExchangeDepositFor} from "../src/periphery/Deposits.sol";

contract RejectingUSDC is MockUSDC {
    address public rejected;

    function reject(address user) external {
        rejected = user;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to != rejected || to == address(0), "receiver rejected");
        super._update(from, to, value);
    }
}

/// Defensive, fully local correctness regressions. No RPC or deployment actions.
contract JackpotAllocationCorrectness is Deployer {
    RejectingUSDC private token;
    Jackpot private jackpot;
    address private alice = address(0xA11CE);
    address private bob = address(0xB0B);
    uint256 private constant START = 1_800_000_000;

    function setUp() public {
        vm.warp(START);
        vm.roll(100);
        token = new RejectingUSDC();
        jackpot = Jackpot(
            _deployed(
                "Jackpot",
                type(Jackpot).creationCode,
                abi.encode(token, uint64(START), uint64(3600), uint16(10_000))
            )
        );
        jackpot.bind(address(this));
    }

    function _ready(uint256 round) private {
        jackpot.close(round);
        (uint64 at,,,) = jackpot.rounds(round);
        vm.roll(at + 1);
        vm.setBlockhash(at, keccak256(abi.encode("bounded local fixture", round)));
    }

    function test_roundPrizeExcludesContributionsFromLaterRounds() public {
        jackpot.enter(alice, 100e6);
        token.mint(address(jackpot), 10e6);
        jackpot.sync();
        vm.warp(START + 3600);
        jackpot.enter(bob, 100e6);
        token.mint(address(jackpot), 90e6);
        jackpot.sync();
        vm.warp(START + 7200);
        _ready(0);
        (address firstWinner, uint256 firstPrize) = jackpot.draw(0);
        _ready(1);
        (address secondWinner, uint256 secondPrize) = jackpot.draw(1);
        assertEq(firstWinner, alice);
        assertEq(firstPrize, 10e6, "old round only receives its own funding");
        assertEq(secondWinner, bob);
        assertEq(secondPrize, 90e6, "later funding stays reserved for the later round");
    }

    function test_laterRoundCannotCloseAheadOfSettlement() public {
        jackpot.enter(alice, 100e6);
        token.mint(address(jackpot), 10e6);
        jackpot.sync();
        vm.warp(START + 3600);
        jackpot.enter(bob, 100e6);
        token.mint(address(jackpot), 90e6);
        jackpot.sync();
        vm.warp(START + 7200);
        _ready(0);
        vm.expectRevert(Jackpot.RoundOrder.selector);
        jackpot.close(1);
        jackpot.draw(0);
        _ready(1);
        jackpot.draw(1);
        assertEq(token.balanceOf(alice), 10e6);
        assertEq(token.balanceOf(bob), 90e6);
    }

    function test_rejectedPayoutPreservesReservedRetryableWinnerEntitlement() public {
        jackpot.enter(alice, 100e6);
        token.mint(address(jackpot), 100e6);
        jackpot.sync();
        vm.warp(START + 3600);
        _ready(0);
        token.reject(alice);
        jackpot.draw(0);
        (, bool drawn, address winner, uint128 prize) = jackpot.rounds(0);
        assertTrue(drawn);
        assertEq(winner, alice);
        assertEq(prize, 100e6);
        assertFalse(jackpot.paid(0));
        assertEq(jackpot.reservedPrizes(), 100e6);
        jackpot.enter(bob, 100e6);
        token.mint(address(jackpot), 9e6);
        jackpot.sync();
        assertEq(jackpot.pot(), 9e6, "unpaid winnings cannot enter the next pot");
        vm.warp(START + 7200);
        _ready(1);
        jackpot.draw(1);
        assertEq(token.balanceOf(bob), 9e6);
        assertEq(token.balanceOf(alice), 0);
        vm.expectRevert(bytes("receiver rejected"));
        jackpot.claim(0);
        assertEq(jackpot.reservedPrizes(), 100e6);
        token.reject(address(0));
        vm.prank(bob);
        jackpot.claim(0);
        assertEq(token.balanceOf(alice), 100e6, "permissionless retry always pays the winner");
        assertEq(jackpot.reservedPrizes(), 0);
        vm.expectRevert(Jackpot.NothingToClaim.selector);
        jackpot.claim(0);
    }
}

contract RewardTransferCorrectness is Base {
    LaunchCoin private launchCoin;
    Jackpot private jackpot;

    function setUp() public override {
        super.setUp();
        launchCoin = new LaunchCoin("Tape", "TAPE", SUPPLY, RESERVE, address(this), 200, address(this));
        jackpot = Jackpot(
            _deployed(
                "Jackpot",
                type(Jackpot).creationCode,
                abi.encode(usdc, uint64(T0), uint64(3600), uint16(10_000))
            )
        );
        mining = LossMining(
            _deployed(
                "LossMining",
                type(LossMining).creationCode,
                abi.encode(launchCoin, address(ex), MINING_SCALE, address(jackpot))
            )
        );
        staking = new Staking(IERC20(address(launchCoin)), IERC20(address(usdc)), address(ex));
        sweeper = _deployedSweeper();
        jackpot.bind(address(mining));
        launchCoin.setExempt(address(mining));
        launchCoin.setExempt(address(staking));
        launchCoin.transfer(address(mining), RESERVE - launchCoin.maxWallet());
        launchCoin.transfer(alice, launchCoin.maxWallet());
        vm.prank(admin);
        ex.attachCoin(address(staking), address(mining), address(sweeper));
        _fund(alice, 100_000e6);
        _fund(bob, 100_000e6);
    }

    function test_rejectedCoinTransferPreservesJackpotTicketAndReward() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1000, _px(80_000));
        uint256 beforeReserve = mining.reserve();
        uint256 reward = mining.quote(100e6);
        vm.cool(address(mining));
        vm.cool(address(jackpot));
        vm.cool(address(launchCoin));
        _liquidate(id, _px(79_900));
        assertEq(ex.getPosition(id).owner, address(0));
        assertEq(jackpot.tickets(0), 100e6, "tickets survive rejected coin delivery");
        assertEq(mining.cumulativeLossUsd(), 100e6);
        assertEq(mining.reserve(), beforeReserve - reward);
        assertEq(mining.pendingRewards(alice), reward);
        assertEq(mining.totalPending(), reward);
        vm.expectRevert(LaunchCoin.MaxWallet.selector);
        mining.claim(alice);
        assertEq(mining.pendingRewards(alice), reward);
        launchCoin.removeLimits();
        vm.prank(stranger);
        mining.claim(alice);
        assertEq(jackpot.tickets(0), 100e6);
        assertEq(mining.totalPending(), 0);
        assertEq(launchCoin.balanceOf(alice), launchCoin.maxWallet() + reward);
        assertEq(mining.reserve(), beforeReserve - reward, "claims do not change the emission reserve");
    }

    function test_coldCombinedJackpotAndLaunchCoinHookBudget() public {
        bytes32 id = _open(bobPk, btc, true, 100e6, 1000, _px(80_000));
        vm.cool(address(mining));
        vm.cool(address(jackpot));
        vm.cool(address(launchCoin));
        _liquidate(id, _px(79_900));
        assertGt(launchCoin.balanceOf(bob), 0, "new-wallet reward fits fixed gas allowance");
        assertEq(jackpot.tickets(0), 100e6, "new-round ticket fits fixed gas allowance");
    }

    function test_permissionlessDepositCollectionPreservesEachBeneficiary() public {
        Deposits deposits = new Deposits(IERC20(address(usdc)), IExchangeDepositFor(address(ex)));
        uint256 aliceBefore = ex.balances(alice);
        uint256 bobBefore = ex.balances(bob);
        usdc.mint(deposits.addressOf(alice), 11e6);
        usdc.mint(deposits.addressOf(bob), 22e6);
        vm.prank(stranger);
        deposits.collect(alice);
        vm.prank(stranger);
        deposits.collect(bob);
        assertEq(ex.balances(alice), aliceBefore + 11e6);
        assertEq(ex.balances(bob), bobBefore + 22e6);
        assertEq(ex.balances(stranger), 0);
        assertEq(usdc.balanceOf(address(deposits)), 0);
        usdc.mint(deposits.addressOf(alice), 33e6);
        vm.prank(bob);
        vm.expectRevert(Deposits.NothingToCollect.selector);
        deposits.reclaim();
        vm.prank(alice);
        deposits.reclaim();
        assertEq(usdc.balanceOf(alice), 33e6);
        assertEq(ex.balances(alice), aliceBefore + 11e6, "reclaim only moves pending funds");
    }
}

/// Local transition proof: encumbered queue cash is not stable open-interest backing.
contract CapacityCorrectness is Base {
    function test_queuePaymentChangesAnAlreadyPricedOpenEligibility() public {
        _fund(alice, 100_000e6);
        _fund(bob, 100_000e6);
        for (uint256 i; i < 5; ++i) {
            uint256 pk = i % 2 == 0 ? alicePk : bobPk;
            bytes32 id = _open(pk, btc, true, 1_000e6, 1_000, _px(80_000));
            _close(pk, id, _px(80_080));
        }
        assertEq(ex.queueTail() - ex.queueHead(), 5);
        uint256 donation = 100e6;
        for (uint256 i; i < 4; ++i) {
            (, uint96 amount) = ex.claims(ex.queueHead() + i);
            donation += amount;
        }
        _seedHouse(donation);
        assertEq(ex.lpCash(), 100e6);
        assertGt(ex.totalQueued(), ex.lpCash());
        Intents.OpenIntent memory intent = _intent(alice, btc, true, 2_001e6, 1_000);
        bytes memory signature = _sign(alicePk, _hashOpen(intent));
        bytes[] memory update = _update(BTC_FEED, _px(80_000), intent.timestamp + ex.EXEC_DELAY());
        skip(12);
        uint256 snapshot = vm.snapshotState();
        vm.prank(operator);
        ex.open(intent, signature, update);
        assertTrue(ex.usedIntent(_hashOpen(intent)));
        vm.revertToState(snapshot);
        vm.prank(stranger);
        ex.harvest(10);
        assertEq(ex.lpCash(), 0);
        vm.prank(operator);
        vm.expectRevert(Exchange.OpenInterestCap.selector);
        ex.open(intent, signature, update);
        assertFalse(ex.usedIntent(_hashOpen(intent)));
    }
}
