// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Coin} from "../src/Coin.sol";
import {Jackpot} from "../src/Jackpot.sol";
import {LossMining} from "../src/LossMining.sol";
import {Staking} from "../src/Staking.sol";
import {FeeSplitter} from "../src/periphery/FeeSplitter.sol";
import {Base} from "./Base.t.sol";

/// @dev The Rekt Jackpot: losses on the Exchange become tickets, an hour's tickets are drawn
///      against a later block's hash, the pot is paid to the winner's wallet.
contract JackpotTest is Base {
    Jackpot internal jackpot;
    uint64 internal P0;
    uint64 internal constant HOUR = 3600;

    function setUp() public override {
        super.setUp();
        P0 = _px(80_000);
        jackpot = Jackpot(
            _deployed(
                "Jackpot",
                type(Jackpot).creationCode,
                abi.encode(usdc, uint64(vm.getBlockTimestamp()), HOUR, uint16(10_000))
            )
        );
        // The coin, with loss mining that enters every loss into the jackpot.
        coin = Coin(
            _deployed("Coin", type(Coin).creationCode, abi.encode("Tape", "TAPE", SUPPLY, address(this)))
        );
        staking = Staking(_deployed("Staking", type(Staking).creationCode, abi.encode(coin, usdc, ex)));
        mining = LossMining(
            _deployed(
                "LossMining",
                type(LossMining).creationCode,
                abi.encode(coin, ex, MINING_SCALE, address(jackpot))
            )
        );
        jackpot.bind(address(mining));
        sweeper = _deployedSweeper();
        coin.transfer(address(mining), RESERVE);
        vm.prank(admin);
        ex.attachCoin(address(staking), address(mining), address(sweeper));
        _fund(alice, 10_000e6);
        _fund(bob, 10_000e6);
        _fund(carol, 10_000e6);
    }

    function _fill(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.transfer(address(jackpot), amount);
        jackpot.sync();
    }

    /// @dev Closes `round` and draws it against `hash`.
    function _draw(uint256 round, bytes32 hash) internal returns (address winner, uint256 prize) {
        jackpot.close(round);
        if (jackpot.tickets(round) == 0) return (address(0), 0);
        (uint64 drawBlock,,,) = jackpot.rounds(round);
        vm.roll(drawBlock + 1);
        vm.setBlockhash(drawBlock, hash);
        return jackpot.draw(round);
    }

    function test_aLiquidationIsTicketsForItsWholeMargin() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        _liquidate(id, P0 - _px(100));
        assertEq(jackpot.tickets(0), 100e6);
        assertEq(jackpot.entryCount(0), 1);
        assertEq(jackpot.entryAt(0, 0).user, alice);
        // The same loss mined coin too: both fit in the gas the Exchange hands the hook, a new
        // round's first entry (the costliest) included.
        assertGt(coin.balanceOf(alice), 0, "mined");
    }

    function test_aLosingCloseIsTicketsForItsLossLessTheFee() public {
        _seedHouse(1_000e6);
        bytes32 id = _open(bobPk, btc, true, 100e6, 10, P0);
        _close(bobPk, id, _px(79_600));
        // Down 0.5% at 10x: $5 lost, of which the house's 2% fee is 10 cents.
        assertEq(jackpot.tickets(0), 5e6 - 0.1e6);
    }

    function test_onlyLossMiningCanEnter() public {
        vm.expectRevert(Jackpot.NotSource.selector);
        jackpot.enter(alice, 1e6);
        vm.expectRevert(Jackpot.AlreadyBound.selector);
        jackpot.bind(stranger);
        vm.prank(stranger);
        vm.expectRevert(Jackpot.NotDeployer.selector);
        jackpot.bind(stranger);
    }

    function test_theWinnerIsPaidThePot_andTheChanceFollowsTheTickets() public {
        // Alice loses $100, Bob $300: a quarter and three quarters of the tickets.
        _liquidate(_open(alicePk, btc, true, 100e6, 1_000, P0), P0 - _px(100));
        _liquidate(_open(bobPk, btc, true, 300e6, 1_000, P0), P0 - _px(100));
        assertEq(jackpot.tickets(0), 400e6);
        _fill(1_000e6);
        skip(HOUR);

        // A hash pointing into the first quarter picks Alice; one past it picks Bob.
        uint256 snap = vm.snapshotState();
        bytes32 hash = _hashLanding(0, 400e6, 50e6);
        (address winner, uint256 prize) = _draw(0, hash);
        assertEq(winner, alice);
        assertEq(prize, 1_000e6);
        assertEq(usdc.balanceOf(alice), 1_000e6, "paid to the wallet");
        assertEq(jackpot.pot(), 0);
        vm.revertToState(snap);
        (winner,) = _draw(0, _hashLanding(0, 400e6, 250e6));
        assertEq(winner, bob);
    }

    function test_aRoundIsOnlyClosedOnceItIsOver_andDrawnOnce() public {
        _liquidate(_open(alicePk, btc, true, 100e6, 1_000, P0), P0 - _px(100));
        vm.expectRevert(Jackpot.NotOver.selector);
        jackpot.close(0);
        skip(HOUR);
        jackpot.close(0);
        vm.expectRevert(Jackpot.AlreadyClosed.selector);
        jackpot.close(0);
        vm.expectRevert(Jackpot.NotYet.selector);
        jackpot.draw(0);
        (uint64 drawBlock,,,) = jackpot.rounds(0);
        vm.roll(drawBlock + 1);
        vm.setBlockhash(drawBlock, keccak256("x"));
        jackpot.draw(0);
        vm.expectRevert(Jackpot.AlreadyDrawn.selector);
        jackpot.draw(0);
    }

    function test_aLossAfterTheHourIsInTheNextRound() public {
        _liquidate(_open(alicePk, btc, true, 100e6, 1_000, P0), P0 - _px(100));
        skip(HOUR);
        _liquidate(_open(bobPk, btc, true, 100e6, 1_000, P0), P0 - _px(100));
        assertEq(jackpot.tickets(0), 100e6);
        assertEq(jackpot.tickets(1), 100e6);
    }

    function test_aRoundNobodyLostInRollsThePotOver() public {
        _fill(500e6);
        skip(HOUR);
        (address winner, uint256 prize) = _draw(0, keccak256("y"));
        assertEq(winner, address(0));
        assertEq(prize, 0);
        assertEq(jackpot.pot(), 500e6);
    }

    function test_aBlockHashThatIsGoneMeansCloseAgain() public {
        _liquidate(_open(alicePk, btc, true, 100e6, 1_000, P0), P0 - _px(100));
        skip(HOUR);
        jackpot.close(0);
        (uint64 first,,,) = jackpot.rounds(0);
        vm.roll(first + 300);
        vm.expectRevert(Jackpot.HashGone.selector);
        jackpot.draw(0);
        jackpot.close(0);
        (uint64 second,,,) = jackpot.rounds(0);
        assertGt(second, first);
    }

    function test_theSplitterSendsTheTeamsHalfOn() public {
        address team = makeAddr("team");
        FeeSplitter splitter = new FeeSplitter(IERC20(address(usdc)), address(jackpot), team, 3_000);
        usdc.mint(address(splitter), 100e6);
        splitter.split();
        assertEq(jackpot.pot(), 30e6);
        assertEq(usdc.balanceOf(team), 70e6);
    }

    function test_miningStillPaysWhenTheJackpotFails() public {
        // A jackpot whose source is someone else refuses every entry: the loss still mines.
        Jackpot broken = new Jackpot(IERC20(address(usdc)), uint64(vm.getBlockTimestamp()), HOUR, 10_000);
        broken.bind(stranger);
        LossMining lm = new LossMining(IERC20(address(coin)), address(ex), MINING_SCALE, address(broken));
        coin.transfer(address(lm), 1_000e18);
        vm.prank(address(ex));
        lm.onLoss(alice, 100e6);
        assertGt(coin.balanceOf(alice), 0);
    }

    /// @dev A block hash whose draw for `round` lands on `point` (of `total`) or past it by less
    ///      than 50e6: searched, as the draw is a hash.
    function _hashLanding(uint256 round, uint256 total, uint256 point) internal pure returns (bytes32 hash) {
        for (uint256 i;; ++i) {
            hash = keccak256(abi.encode("seed", i));
            uint256 at = uint256(keccak256(abi.encode(hash, round))) % total;
            if (at >= point && at < point + 50e6) return hash;
        }
    }
}
