// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "./mocks/Mocks.sol";
import {Deployer} from "./Deployer.sol";
import {Jackpot} from "../src/Jackpot.sol";
import {LossMining} from "../src/LossMining.sol";
import {FeeSplitter} from "../src/periphery/FeeSplitter.sol";

/// Token-side effects followed by false, exhausted transfer gas, and recipient-specific rejection.
contract DeliveryToken is MockUSDC {
    uint256 public mode;
    address public rejected;

    function configure(uint256 mode_, address rejected_) external {
        mode = mode_;
        rejected = rejected_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == 2) {
            assembly ("memory-safe") { for {} 1 {} {} }
        }
        bool result = super.transfer(to, amount);
        require(to != rejected, "recipient rejected");
        return mode == 1 ? false : result;
    }
}

contract RewardReservationsTest is Deployer {
    DeliveryToken private token;
    Jackpot private jackpot;
    LossMining private mining;
    address private alice = address(0xA11CE);
    address private bob = address(0xB0B);
    uint256 private constant START = 1_800_000_000;
    uint256 private constant SCALE = 5_000_000e6;
    uint256 private constant RESERVE = 200_000_000e18;

    function setUp() public {
        vm.warp(START);
        vm.roll(100);
        token = new DeliveryToken();
        jackpot = _jackpot(10_000);
        jackpot.bind(address(this));
        mining = _mining(address(0));
        token.mint(address(mining), RESERVE);
    }

    function _jackpot(uint16 bps) private returns (Jackpot) {
        return Jackpot(
            _deployed(
                "Jackpot", type(Jackpot).creationCode, abi.encode(token, uint64(START), uint64(3600), bps)
            )
        );
    }

    function _mining(address jp) private returns (LossMining) {
        return LossMining(
            _deployed(
                "LossMining", type(LossMining).creationCode, abi.encode(token, address(this), SCALE, jp)
            )
        );
    }

    function _fund(Jackpot jp, uint256 amount) private {
        token.mint(address(this), amount);
        token.approve(address(jp), amount);
        jp.fund(amount);
    }

    function _finish(Jackpot jp, uint256 round) private {
        jp.close(round);
        (uint64 at, bool drawn,,) = jp.rounds(round);
        if (drawn) return;
        vm.roll(at + 1);
        vm.setBlockhash(at, keccak256(abi.encode("reservation fixture", round)));
        jp.draw(round);
    }

    function test_prizeFrozenBeforeHashAndUnaffectedByLateDonationsOrExpiredHash() public {
        jackpot.enter(alice, 1e6);
        _fund(jackpot, 10e6);
        vm.warp(START + 3600);
        jackpot.close(0);
        (uint64 first,,, uint128 prize) = jackpot.rounds(0);
        assertEq(prize, 10e6);
        _fund(jackpot, 90e6);
        vm.roll(first + 257);
        jackpot.close(0);
        (uint64 second,,, uint128 again) = jackpot.rounds(0);
        assertEq(again, 10e6);
        assertGt(second, first);
        vm.roll(second + 1);
        vm.setBlockhash(second, keccak256("replacement hash"));
        jackpot.draw(0);
        assertEq(token.balanceOf(alice), 10e6);
        assertEq(jackpot.pot(), 90e6);
    }

    function test_unsyncedDirectDonationBelongsToCurrentRoundNeverAnOldRound() public {
        jackpot.enter(alice, 1e6);
        _fund(jackpot, 10e6);
        token.mint(address(jackpot), 5e6);
        vm.warp(START + 3600);
        jackpot.enter(bob, 1e6);
        _finish(jackpot, 0);
        assertEq(token.balanceOf(alice), 10e6);
        assertEq(jackpot.pot(), 5e6);
        vm.warp(START + 7200);
        _finish(jackpot, 1);
        assertEq(token.balanceOf(bob), 5e6);
    }

    function test_feeSplitterCreditsCurrentRoundAtomicallyEvenIfDrawsAreDelayed() public {
        FeeSplitter splitter = new FeeSplitter(token, address(jackpot), address(0x777), 3_000);
        jackpot.enter(alice, 1e6);
        token.mint(address(splitter), 100e6);
        splitter.split();
        assertEq(jackpot.funding(0), 30e6, "fees are attributed before this transaction ends");
        vm.warp(START + 3600);
        jackpot.enter(bob, 1e6);
        token.mint(address(splitter), 900e6);
        splitter.split();
        assertEq(jackpot.funding(0), 30e6);
        assertEq(jackpot.funding(1), 270e6);
        vm.warp(START + 7200);
        _finish(jackpot, 0);
        _finish(jackpot, 1);
        assertEq(token.balanceOf(alice), 30e6);
        assertEq(token.balanceOf(bob), 270e6);
        assertEq(token.balanceOf(address(0x777)), 700e6);
    }

    function test_partialPayoutAndEmptyRoundRollOverWithoutTouchingUnpaidPrizes() public {
        Jackpot jp = _jackpot(5_000);
        jp.bind(address(this));
        jp.enter(alice, 1e6);
        _fund(jp, 100e6);
        token.configure(0, alice);
        vm.warp(START + 3600);
        _finish(jp, 0);
        assertEq(jp.reservedPrizes(), 50e6);
        assertEq(jp.pot(), 50e6);
        _fund(jp, 10e6);
        vm.warp(START + 7200);
        _finish(jp, 1); // Empty: all 60 rolls into round 2, no hash needed.
        assertEq(jp.pot(), 60e6);
        jp.enter(bob, 1e6);
        vm.warp(START + 10800);
        _finish(jp, 2);
        assertEq(token.balanceOf(bob), 30e6);
        assertEq(jp.reservedPrizes(), 50e6);
        assertEq(jp.pot(), 30e6);
        token.configure(0, address(0));
        jp.claim(0);
        assertEq(token.balanceOf(alice), 50e6);
        assertEq(jp.reservedPrizes(), 0);
        assertEq(jp.pot(), 30e6);
    }

    function test_falseReturningPrizeTransferRollsBackOnlyDelivery() public {
        jackpot.enter(alice, 1e6);
        _fund(jackpot, 100e6);
        token.configure(1, address(0));
        vm.warp(START + 3600);
        _finish(jackpot, 0);
        (, bool drawn, address winner, uint128 prize) = jackpot.rounds(0);
        assertTrue(drawn);
        assertEq(winner, alice);
        assertEq(prize, 100e6);
        assertEq(token.balanceOf(alice), 0, "false-return side effects rolled back");
        assertEq(jackpot.reservedPrizes(), 100e6);
        token.configure(0, address(0));
        jackpot.claim(0);
        assertEq(token.balanceOf(alice), 100e6);
    }

    function test_prizeTransferConsumingAllowanceCannotEraseDraw() public {
        jackpot.enter(alice, 1e6);
        _fund(jackpot, 100e6);
        token.configure(2, address(0));
        vm.warp(START + 3600);
        _finish(jackpot, 0);
        (, bool drawn, address winner,) = jackpot.rounds(0);
        assertTrue(drawn);
        assertEq(winner, alice);
        assertEq(jackpot.reservedPrizes(), 100e6);
        token.configure(0, address(0));
        jackpot.claim(0);
        assertEq(token.balanceOf(alice), 100e6);
    }

    function test_repeatedRejectedMiningPreservesCurveAndExcludesPendingFromLaterRewards() public {
        token.configure(0, alice);
        uint256 first = mining.quote(100e6);
        mining.onLoss(alice, 100e6);
        uint256 second = mining.quote(200e6);
        mining.onLoss(alice, 200e6);
        uint256 third = mining.quote(300e6);
        mining.onLoss(bob, 300e6);
        assertEq(mining.pendingRewards(alice), first + second);
        assertEq(mining.totalPending(), first + second);
        assertEq(mining.totalMined(), first + second + third);
        assertEq(mining.reserve() + mining.totalMined(), RESERVE);
        assertEq(token.balanceOf(bob), third);
        uint256 reserveBefore = mining.reserve();
        uint256 nextQuote = mining.quote(1e6);
        token.configure(0, address(0));
        vm.prank(bob);
        mining.claim(alice);
        assertEq(token.balanceOf(alice), first + second);
        assertEq(mining.reserve(), reserveBefore);
        assertEq(mining.quote(1e6), nextQuote);
        assertEq(mining.totalMined(), first + second + third);
        vm.expectRevert(LossMining.NothingToClaim.selector);
        mining.claim(alice);
    }

    function test_falseReturningMiningTransferCannotPayAndLeaveDuplicatedLiability() public {
        uint256 reward = mining.quote(100e6);
        token.configure(1, address(0));
        mining.onLoss(alice, 100e6);
        assertEq(token.balanceOf(alice), 0);
        assertEq(mining.totalPending(), reward);
        assertEq(mining.totalMined(), reward);
        token.configure(0, address(0));
        mining.claim(alice);
        assertEq(token.balanceOf(alice), reward);
        assertEq(mining.reserve() + mining.totalMined(), RESERVE);
    }

    function test_gasConsumingCoinStillPreservesColdTicketsAndPendingWithin150k() public {
        Jackpot jp = _jackpot(10_000);
        LossMining lm = _mining(address(jp));
        jp.bind(address(lm));
        token.mint(address(lm), RESERVE);
        uint256 reward = lm.quote(100e6);
        token.configure(2, address(0));
        vm.cool(address(token));
        vm.cool(address(jp));
        vm.cool(address(lm));
        (bool ok,) = address(lm).call{gas: 150_000}(abi.encodeCall(LossMining.onLoss, (alice, 100e6)));
        assertTrue(ok, "hostile transfer cannot consume fallback accounting gas");
        assertEq(jp.tickets(0), 100e6);
        assertEq(lm.cumulativeLossUsd(), 100e6);
        assertEq(lm.pendingRewards(alice), reward);
        assertEq(lm.totalPending(), reward);
        assertEq(lm.reserve(), RESERVE - reward);
    }

    function test_deliveryHelpersCannotBeUsedToDrainEitherReserve() public {
        vm.expectRevert(Jackpot.NotSelf.selector);
        jackpot.deliver(0);
        vm.expectRevert(LossMining.NotSelf.selector);
        mining.deliver(alice, RESERVE);
        vm.expectRevert(Jackpot.NothingToClaim.selector);
        jackpot.claim(0);
    }

    function testFuzz_fundingConservationAcrossLateDrawsEmptyRoundsAndRejection(
        uint64 a,
        uint64 b,
        uint64 c,
        uint16 bps
    ) public {
        uint256 x = bound(a, 1, 1_000_000e6);
        uint256 y = bound(b, 1, 1_000_000e6);
        uint256 z = bound(c, 1, 1_000_000e6);
        uint16 share = uint16(bound(bps, 1, 10_000));
        Jackpot jp = _jackpot(share);
        jp.bind(address(this));
        jp.enter(alice, 1e6);
        _fund(jp, x);
        vm.warp(START + 3600);
        _fund(jp, y); // No tickets in round 1.
        vm.warp(START + 7200);
        jp.enter(bob, 1e6);
        _fund(jp, z);
        vm.warp(START + 10800);
        token.configure(0, alice);
        _finish(jp, 0);
        _finish(jp, 1);
        _finish(jp, 2);
        uint256 p0 = x * share / 10_000;
        uint256 p2 = (x - p0 + y + z) * share / 10_000;
        assertEq(jp.reservedPrizes(), p0);
        assertEq(token.balanceOf(bob), p2);
        assertEq(jp.pot(), x + y + z - p0 - p2);
        assertEq(token.balanceOf(address(jp)), jp.pot() + jp.reservedPrizes());
        if (p0 != 0) {
            token.configure(0, address(0));
            jp.claim(0);
        }
        assertEq(token.balanceOf(alice) + token.balanceOf(bob) + token.balanceOf(address(jp)), x + y + z);
    }

    function testFuzz_rejectedRewardsHaveSameCurveAsImmediateDelivery(uint64 a, uint64 b) public {
        uint256 x = bound(a, 1, 50_000_000e6);
        uint256 y = bound(b, 1, 50_000_000e6);
        uint256 snap = vm.snapshotState();
        mining.onLoss(alice, x);
        mining.onLoss(bob, y);
        uint256 delivered = mining.totalMined();
        uint256 left = mining.reserve();
        vm.revertToState(snap);
        token.configure(0, alice);
        mining.onLoss(alice, x);
        mining.onLoss(bob, y);
        assertEq(mining.totalMined(), delivered);
        assertEq(mining.reserve(), left);
        assertEq(mining.reserve() + mining.totalMined(), RESERVE);
    }
}
