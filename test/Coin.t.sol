// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Base} from "./Base.t.sol";
import {Coin} from "../src/Coin.sol";
import {Staking} from "../src/Staking.sol";
import {LossMining} from "../src/LossMining.sol";

/// @dev The coin side: the token itself, loss mining and staking, wired to a real Exchange.
contract CoinTest is Base {
    uint64 internal P0;
    /// @dev How long a payment takes to reach stakers in full.
    uint256 internal PERIOD;

    function setUp() public override {
        super.setUp();
        P0 = _px(80_000);
        _attachCoin();
        PERIOD = staking.PERIOD();
        _fund(alice, 100_000e6);
        _fund(bob, 100_000e6);
    }

    /// @dev The sweeper hands back the Pyth fee it did not need.
    receive() external payable {}

    function _bust(uint256 pk, uint96 margin) internal {
        bytes32 id = _open(pk, btc, true, margin, 1_000, P0);
        _liquidate(id, _px(79_900));
    }

    function _stake(address user, uint256 amount) internal {
        coin.transfer(user, amount);
        vm.startPrank(user);
        coin.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    /// @dev Sends `amount` of USDC to staking the way the Exchange does. It starts streaming to
    ///      whoever is staked, or waits if nobody is.
    function _notify(uint256 amount) internal {
        usdc.mint(address(staking), amount);
        vm.prank(address(ex));
        staking.notify(amount);
    }

    /// @dev Sends `amount` and lets the whole day pass, so that all of it has been streamed.
    function _pay(uint256 amount) internal {
        _notify(amount);
        skip(PERIOD);
    }

    /// @dev Staking rounds everything it books down, each time by less than one unit of USDC. So
    ///      an amount that went through `floors` roundings may be that many units short of the
    ///      exact figure. It is never over.
    function _assertStreamed(uint256 actual, uint256 exact, uint256 floors, string memory what)
        internal
        pure
    {
        assertLe(actual, exact, what);
        assertGe(actual + floors, exact, what);
    }

    // --------------------------------------------------------------------------------------
    // Coin
    // --------------------------------------------------------------------------------------

    function test_coin_isAPlainFixedSupplyToken() public view {
        assertEq(coin.totalSupply(), SUPPLY);
        assertEq(coin.decimals(), 18);
        assertEq(coin.balanceOf(address(mining)), RESERVE);
        assertEq(coin.balanceOf(address(this)), SUPPLY - RESERVE);
    }

    function test_coin_transfersFreelyAndBurns() public {
        coin.transfer(alice, 10e18);
        vm.prank(alice);
        coin.transfer(bob, 4e18);
        vm.prank(bob);
        coin.burn(1e18);
        assertEq(coin.balanceOf(alice), 6e18);
        assertEq(coin.balanceOf(bob), 3e18);
        assertEq(coin.totalSupply(), SUPPLY - 1e18);
    }

    // --------------------------------------------------------------------------------------
    // Loss mining
    // --------------------------------------------------------------------------------------

    function test_mining_paysTheLoserInCoinStraightToTheirWallet() public {
        uint256 expected = mining.quote(100e6);
        // The 20% reserve and $5M scale begin near 40 coin per dollar lost.
        assertApproxEqRel(expected, 100 * 40e18, 0.0001e18);

        _bust(alicePk, 100e6);
        assertEq(coin.balanceOf(alice), expected, "in her wallet as the loss settled");
        assertEq(mining.cumulativeLossUsd(), 100e6);
        assertEq(mining.totalMined(), expected);
        assertEq(mining.reserve(), RESERVE - expected);
    }

    function test_mining_halfTheReserveIsGoneAtTheScale() public {
        vm.prank(address(ex));
        mining.onLoss(alice, MINING_SCALE);
        assertEq(coin.balanceOf(alice), RESERVE / 2);

        // Three quarters at three times the scale.
        vm.prank(address(ex));
        mining.onLoss(bob, 2 * MINING_SCALE);
        assertEq(mining.reserve(), RESERVE / 4);
    }

    function test_mining_theRateOnlyFalls() public {
        vm.startPrank(address(ex));
        uint256 last = type(uint256).max;
        for (uint256 i; i < 20; ++i) {
            uint256 quoted = mining.quote(1_000e6);
            assertLt(quoted, last);
            last = quoted;
            mining.onLoss(alice, 1_000_000e6);
        }
        vm.stopPrank();
    }

    /// @dev Splitting a loss into pieces must not change what it mines.
    function testFuzz_mining_isPathIndependent(uint64 a, uint64 b, uint64 c) public {
        uint256 x = bound(a, 1e6, 50_000_000e6);
        uint256 y = bound(b, 1e6, 50_000_000e6);
        uint256 z = bound(c, 1e6, 50_000_000e6);

        uint256 snapshot = vm.snapshotState();
        vm.startPrank(address(ex));
        mining.onLoss(alice, x);
        mining.onLoss(alice, y);
        mining.onLoss(alice, z);
        vm.stopPrank();
        uint256 split = coin.balanceOf(alice);

        vm.revertToState(snapshot);
        vm.prank(address(ex));
        mining.onLoss(alice, x + y + z);
        // Three roundings against one: at most a few wei apart, and never more when split.
        assertApproxEqAbs(split, coin.balanceOf(alice), 3);
        assertLe(split, coin.balanceOf(alice));
    }

    function testFuzz_mining_neverEmitsMoreThanItHolds(uint64[8] memory losses) public {
        vm.startPrank(address(ex));
        for (uint256 i; i < losses.length; ++i) {
            mining.onLoss(alice, bound(losses[i], 0, 1e15));
        }
        vm.stopPrank();
        assertEq(mining.totalMined(), coin.balanceOf(alice));
        assertEq(mining.reserve() + mining.totalMined(), RESERVE);
    }

    function test_mining_canBeToppedUpByAnyone() public {
        vm.prank(address(ex));
        mining.onLoss(alice, MINING_SCALE);
        uint256 before = mining.quote(1_000e6);
        coin.transfer(address(mining), 200_000_000e18);
        assertEq(mining.reserve(), RESERVE / 2 + 200_000_000e18);
        assertGt(mining.quote(1_000e6), before);
    }

    function test_mining_onlyTheExchangeReportsLosses() public {
        vm.expectRevert(LossMining.NotExchange.selector);
        mining.onLoss(alice, 1e6);
    }

    function test_constructorChecks() public {
        vm.expectRevert(LossMining.ZeroScale.selector);
        new LossMining(IERC20(address(coin)), address(ex), 0, address(0));
        vm.expectRevert(LossMining.ZeroAddress.selector);
        new LossMining(IERC20(address(0)), address(ex), 1, address(0));
        vm.expectRevert(Staking.ZeroAddress.selector);
        new Staking(IERC20(address(coin)), IERC20(address(usdc)), address(0));
    }

    // --------------------------------------------------------------------------------------
    // Staking: stakes and claims
    // --------------------------------------------------------------------------------------

    /// @dev No lockup and no cooldown, not even for the block the stake was made in.
    function test_staking_stakeAndUnstakeAreInstant() public {
        _stake(alice, 1_000e18);
        assertEq(staking.totalStaked(), 1_000e18);
        vm.startPrank(alice);
        staking.unstake(400e18);
        assertEq(coin.balanceOf(alice), 400e18);
        assertEq(staking.staked(alice), 600e18);
        vm.expectRevert(Staking.InsufficientStake.selector);
        staking.unstake(601e18);
        vm.expectRevert(Staking.ZeroAmount.selector);
        staking.unstake(0);
        vm.expectRevert(Staking.ZeroAmount.selector);
        staking.stake(0);
        vm.stopPrank();
    }

    function test_staking_stakeWithPermit() public {
        coin.transfer(bob, 70e18);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                bob,
                address(staking),
                70e18,
                coin.nonces(bob),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(bobPk, keccak256(abi.encodePacked("\x19\x01", coin.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(bob);
        staking.stakeWithPermit(70e18, deadline, v, r, s);
        assertEq(staking.staked(bob), 70e18);
    }

    function test_staking_aClaimLandsInTheTradingBalance() public {
        _stake(alice, 1_000e18);
        _pay(240e6);
        // $240 over 86,400 seconds is not a whole number of units per second: one unit of dust.
        uint256 owed = staking.pendingReward(alice);
        _assertStreamed(owed, 240e6, 1, "a day later all of it is hers");
        uint256 before = ex.balances(alice);
        uint256 treasury = ex.treasury();

        vm.expectEmit(address(staking));
        emit Staking.Claimed(alice, owed);
        vm.prank(alice);
        uint256 paid = staking.claim();
        assertEq(paid, owed);
        assertEq(ex.balances(alice), before + paid);
        assertEq(ex.treasury(), treasury + paid);
        assertEq(usdc.balanceOf(address(staking)), 240e6 - paid, "only the dust stays behind");
        assertEq(staking.totalClaimed(), paid);
        assertEq(staking.pendingReward(alice), 0);
        _assertSolvent();

        vm.prank(alice);
        vm.expectRevert(Staking.ZeroAmount.selector);
        staking.claim();
    }

    /// @dev A claim takes what has been streamed so far and leaves the rest of the stream running.
    function test_staking_aClaimMidStreamTakesWhatHasBeenStreamedSoFar() public {
        _stake(alice, 1_000e18);
        _notify(86_400e6);
        skip(6 hours);
        vm.prank(alice);
        assertEq(staking.claim(), 21_600e6);
        assertEq(staking.pendingReward(alice), 0);
        assertEq(staking.unstreamed(), 64_800e6);

        skip(18 hours);
        assertEq(staking.pendingReward(alice), 64_800e6);
        vm.prank(alice);
        assertEq(staking.claim(), 64_800e6);
        assertEq(staking.totalClaimed(), 86_400e6);
        assertEq(usdc.balanceOf(address(staking)), 0);
    }

    // --------------------------------------------------------------------------------------
    // Staking: the stream
    // --------------------------------------------------------------------------------------

    /// @dev A payment is not handed over. It is spread evenly over the next day, second by second.
    function test_staking_aPaymentStreamsEvenlyOverADay() public {
        _stake(alice, 1_000e18);
        uint256 start = vm.getBlockTimestamp();

        // $86,400 over 86,400 seconds is a dollar a second, so every figure below is exact.
        usdc.mint(address(staking), 86_400e6);
        vm.expectEmit(address(staking));
        emit Staking.Received(86_400e6);
        vm.expectEmit(address(staking));
        emit Staking.StreamStarted(86_400e6, start + PERIOD);
        vm.prank(address(ex));
        staking.notify(86_400e6);

        assertEq(PERIOD, 24 hours);
        assertEq(staking.rewardRate(), 1e6 * 1e18);
        assertEq(staking.periodFinish(), start + PERIOD);
        assertEq(staking.lastUpdate(), start);
        assertEq(staking.totalReceived(), 86_400e6);
        assertEq(staking.pendingReward(alice), 0, "nothing at once");
        assertEq(staking.unstreamed(), 86_400e6);

        skip(1);
        assertEq(staking.pendingReward(alice), 1e6);
        skip(59);
        assertEq(staking.pendingReward(alice), 60e6);
        skip(6 hours - 60);
        assertEq(staking.pendingReward(alice), 21_600e6);
        assertEq(staking.unstreamed(), 64_800e6);
        skip(18 hours);
        assertEq(staking.pendingReward(alice), 86_400e6);
        assertEq(staking.unstreamed(), 0);

        // The stream has run out: more time adds nothing.
        skip(7 days);
        assertEq(staking.pendingReward(alice), 86_400e6);
    }

    /// @dev The same for an amount that does not divide evenly: a quarter of the day pays a quarter
    ///      and the whole day pays the lot, to within the one unit a rounding can drop.
    function test_staking_whatArrivesIsStreamedNotPaidAtOnce() public {
        _stake(alice, 1_000e18);
        _notify(240e6);
        assertEq(staking.pendingReward(alice), 0, "a payment is never hers the moment it lands");
        _assertStreamed(staking.unstreamed(), 240e6, 1, "all of it is still to come");

        skip(PERIOD / 4);
        _assertStreamed(staking.pendingReward(alice), 60e6, 1, "a quarter of the day");
        _assertStreamed(staking.unstreamed(), 180e6, 1, "three quarters to come");

        skip(PERIOD - PERIOD / 4);
        _assertStreamed(staking.pendingReward(alice), 240e6, 1, "the whole day");
        assertEq(staking.unstreamed(), 0);
    }

    /// @dev A whole day's stream is split across the stakers by stake.
    function test_staking_theStreamIsSplitProRata() public {
        _stake(alice, 3_000e18);
        _stake(bob, 1_000e18);
        uint256 start = vm.getBlockTimestamp();
        _pay(400e6);
        // One rounding each: $400 a day is not a whole number of units per second.
        _assertStreamed(staking.pendingReward(alice), 300e6, 1, "three quarters of the stake");
        _assertStreamed(staking.pendingReward(bob), 100e6, 1, "one quarter");
        assertEq(staking.totalReceived(), 400e6);
        assertEq(staking.rewardRate(), (400e6 * 1e18) / PERIOD);
        assertEq(staking.periodFinish(), start + PERIOD);
        assertEq(staking.unstreamed(), 0);
    }

    /// @dev Each second of the stream goes to whoever is staked during that second, by stake. At a
    ///      dollar a second every share below is exact.
    function test_staking_twoStakersShareByStakeAndByTime() public {
        _stake(alice, 3_000e18);
        _stake(bob, 1_000e18);
        _notify(86_400e6);

        // The first six hours, $21,600, split three to one.
        skip(6 hours);
        assertEq(staking.pendingReward(alice), 16_200e6);
        assertEq(staking.pendingReward(bob), 5_400e6);

        // Bob trebles his stake. The next six hours are split evenly.
        _stake(bob, 2_000e18);
        skip(6 hours);
        assertEq(staking.pendingReward(alice), 16_200e6 + 10_800e6);
        assertEq(staking.pendingReward(bob), 5_400e6 + 10_800e6);

        // Alice leaves at midday. The second half of the day is all Bob's.
        vm.prank(alice);
        staking.unstake(3_000e18);
        skip(12 hours);
        assertEq(staking.pendingReward(alice), 27_000e6, "she keeps what she earned while staked");
        assertEq(staking.pendingReward(bob), 16_200e6 + 43_200e6);
        assertEq(staking.pendingReward(alice) + staking.pendingReward(bob), 86_400e6);
    }

    /// @dev Joining late earns from the moment of joining and nothing of what went before.
    function test_staking_aLateJoinerEarnsOnlyFromWhenTheyJoined() public {
        _stake(alice, 1_000e18);
        _notify(86_400e6);
        skip(18 hours);

        _stake(bob, 1_000e18);
        assertEq(staking.pendingReward(bob), 0, "none of the eighteen hours he missed");

        // Half of the last six hours, not half of the day.
        skip(6 hours);
        assertEq(staking.pendingReward(bob), 10_800e6);
        assertEq(staking.pendingReward(alice), 64_800e6 + 10_800e6);
    }

    function test_staking_aStakeEarnsNothingFromEarlierPayments() public {
        _stake(alice, 1_000e18);
        _pay(100e6);
        _stake(bob, 1_000e18);
        assertEq(staking.pendingReward(bob), 0);
        _pay(100e6);
        // Alice's two days are booked in one go, so she too is one rounding short at most.
        _assertStreamed(staking.pendingReward(alice), 150e6, 1, "all of the first, half of the second");
        _assertStreamed(staking.pendingReward(bob), 50e6, 1, "half of the second");
    }

    function test_staking_unstakingKeepsWhatWasEarned() public {
        _stake(alice, 1_000e18);
        _pay(80e6);
        vm.prank(alice);
        staking.unstake(1_000e18);
        _stake(bob, 5e18);
        _pay(20e6);
        _assertStreamed(staking.pendingReward(alice), 80e6, 1, "hers, staked or not");
        _assertStreamed(staking.pendingReward(bob), 20e6, 1, "the second payment");
    }

    /// @dev A second payment does not queue up behind the first. What is left of the first and the
    ///      new one are spread together over a fresh day.
    function test_staking_aSecondPaymentMidStreamRebasesTheRemainder() public {
        _stake(alice, 1_000e18);
        _notify(86_400e6);
        skip(12 hours);

        // Half is paid and $43,200 is left. With $129,600 more that is $172,800 over a new day:
        // two dollars a second, until twelve hours later than the first stream would have ended.
        uint256 rebased = vm.getBlockTimestamp();
        usdc.mint(address(staking), 129_600e6);
        vm.expectEmit(address(staking));
        emit Staking.StreamStarted(172_800e6, rebased + PERIOD);
        vm.prank(address(ex));
        staking.notify(129_600e6);

        assertEq(staking.rewardRate(), 2e6 * 1e18);
        assertEq(staking.periodFinish(), rebased + PERIOD);
        assertEq(staking.unstreamed(), 172_800e6);
        assertEq(staking.pendingReward(alice), 43_200e6, "what was already streamed is untouched");

        skip(12 hours);
        assertEq(staking.pendingReward(alice), 43_200e6 + 86_400e6);
        assertEq(staking.unstreamed(), 86_400e6);
        skip(12 hours);
        assertEq(staking.pendingReward(alice), 216_000e6);
        assertEq(staking.totalReceived(), 216_000e6, "every dollar of both payments");
        assertEq(staking.unstreamed(), 0);
    }

    /// @dev The stream only runs while somebody is staked. When the last staker leaves it stops,
    ///      and what is left of it starts again, as a fresh day's stream, for the next one in.
    function test_staking_theStreamPausesWhenTheLastStakerLeavesAndResumesForTheNext() public {
        _stake(alice, 1_000e18);
        _notify(86_400e6);
        skip(6 hours);
        vm.prank(alice);
        staking.unstake(1_000e18);

        assertEq(staking.pendingReward(alice), 21_600e6);
        assertEq(staking.waiting(), 64_800e6, "the rest of the stream is put aside");
        assertEq(staking.rewardRate(), 0);
        assertEq(staking.unstreamed(), 0);
        assertEq(staking.periodFinish(), vm.getBlockTimestamp());

        // A week with nobody staked: nothing is streamed to no one.
        skip(7 days);
        assertEq(staking.waiting(), 64_800e6);
        assertEq(staking.pendingReward(alice), 21_600e6);

        // Bob arrives, and it flows again from now: three quarters of a dollar a second.
        coin.transfer(bob, 5e18);
        vm.prank(bob);
        coin.approve(address(staking), 5e18);
        uint256 resumed = vm.getBlockTimestamp();
        vm.expectEmit(address(staking));
        emit Staking.StreamStarted(64_800e6, resumed + PERIOD);
        vm.prank(bob);
        staking.stake(5e18);

        assertEq(staking.waiting(), 0);
        assertEq(staking.rewardRate(), 0.75e6 * 1e18);
        assertEq(staking.unstreamed(), 64_800e6);
        assertEq(staking.pendingReward(bob), 0, "not his for having turned up");

        skip(12 hours);
        assertEq(staking.pendingReward(bob), 32_400e6);
        skip(12 hours);
        assertEq(staking.pendingReward(bob), 64_800e6);
        assertEq(staking.pendingReward(alice), 21_600e6);
    }

    /// @dev With nobody staked there is no one to pay, so the money waits. The first staker does
    ///      not collect the backlog for turning up: it starts streaming to them, over a day.
    function test_staking_withNobodyStakedTheMoneyWaitsThenStreamsToTheFirstStaker() public {
        _notify(240e6);
        assertEq(staking.waiting(), 240e6);
        assertEq(staking.rewardRate(), 0);
        assertEq(staking.unstreamed(), 0);

        // However long it waits, it does not shrink and nobody is owed it.
        skip(30 days);
        assertEq(staking.waiting(), 240e6);

        _stake(alice, 1e18);
        assertEq(staking.pendingReward(alice), 0, "the backlog is not hers at once");
        assertEq(staking.waiting(), 0);
        assertEq(staking.periodFinish(), vm.getBlockTimestamp() + PERIOD);

        // An hour in she has an hour's worth, a twenty-fourth. $240 a day does not divide into
        // whole units per second, so one unit can be missing.
        skip(1 hours);
        _assertStreamed(staking.pendingReward(alice), 10e6, 1, "one hour of twenty-four");
        skip(23 hours);
        _assertStreamed(staking.pendingReward(alice), 240e6, 1, "all of it after the day");
    }

    /// @dev Nobody runs the stream: there is no operator and nothing to call. Only the Exchange
    ///      can announce a payment, and time does the rest.
    function test_staking_onlyTheExchangeNotifiesAndNobodyRunsTheStream() public {
        _stake(alice, 1_000e18);
        vm.expectRevert(Staking.NotExchange.selector);
        staking.notify(1e6);
        vm.prank(operator);
        vm.expectRevert(Staking.NotExchange.selector);
        staking.notify(1e6);
        vm.prank(admin);
        vm.expectRevert(Staking.NotExchange.selector);
        staking.notify(1e6);

        // The operator-run distribution is gone: there is no such function to call.
        vm.prank(operator);
        (bool ok,) = address(staking).call(abi.encodeWithSignature("distribute()"));
        assertFalse(ok);

        // A payment reaches the staker with no transaction from anyone.
        _notify(86_400e6);
        skip(1 hours);
        assertEq(staking.pendingReward(alice), 3_600e6);
    }

    /// @dev Borrow coin, stake it around a payment, leave: all in one block. The old design had to
    ///      forbid leaving in the block of the stake. A stream needs no such rule, because a stake
    ///      earns only for the time it is staked, and no time earns nothing.
    function test_staking_cannotBeFlashedAroundAPayment() public {
        _stake(alice, 1_000e18);

        // Bob comes in with a thousand times her stake just before $1,000 lands...
        _stake(bob, 1_000_000e18);
        _notify(1_000e6);
        // ...and is free to go again at once, with nothing.
        vm.prank(bob);
        staking.unstake(1_000_000e18);
        assertEq(coin.balanceOf(bob), 1_000_000e18);
        assertEq(staking.pendingReward(bob), 0);

        skip(PERIOD);
        assertEq(staking.pendingReward(bob), 0);
        _assertStreamed(staking.pendingReward(alice), 1_000e6, 1, "all of it went to who stayed");
    }

    /// @dev And one block earns one block's worth: twelve seconds of a day's stream.
    function test_staking_aOneBlockStakeEarnsOneBlocksWorth() public {
        _stake(alice, 1_000e18);
        _notify(1_000e6);
        _stake(bob, 1_000_000e18);
        skip(12);
        vm.prank(bob);
        staking.unstake(1_000_000e18);

        // Twelve seconds out of 86,400 is under fourteen cents of the $1,000, and Bob's
        // thousand-to-one stake gets all of it but Alice's thousand-and-first.
        uint256 oneBlock = (1_000e6 * 12) / PERIOD;
        uint256 bobs = (1_000e6 * 12 * 1_000) / (PERIOD * 1_001);
        assertEq(oneBlock, 138_888);
        assertEq(bobs, 138_750);
        _assertStreamed(staking.pendingReward(bob), bobs, 1, "one block's worth, by stake");

        // Gone, he earns nothing more. The other $999.86 is Alice's.
        skip(PERIOD);
        _assertStreamed(staking.pendingReward(bob), bobs, 1, "and not a unit more later");
        _assertStreamed(
            staking.pendingReward(alice) + staking.pendingReward(bob),
            1_000e6,
            2,
            "the rest went to who stayed"
        );
    }

    /// @dev Whatever happens, staking never owes more USDC than it was sent.
    function testFuzz_staking_neverPaysMoreThanItReceived(
        uint64[6] memory amounts,
        uint64[6] memory stakes,
        uint32[6] memory waits
    ) public {
        _stake(alice, 1_000e18);
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            _stake(bob, bound(stakes[i], 1, 1_000_000e18));
            uint256 amount = bound(amounts[i], 1, 1_000_000e6);
            _notify(amount);
            total += amount;
            // Anything from the same second to well past the end of the stream.
            skip(bound(waits[i], 0, 2 days));
            if (i == 2) {
                uint256 all = staking.staked(bob);
                vm.prank(bob);
                staking.unstake(all);
            }
            // Mid-stream too: what is owed and what is still to come never exceed what came in.
            uint256 promised =
                staking.pendingReward(alice) + staking.pendingReward(bob) + staking.unstreamed();
            assertLe(promised, total);
            assertLe(promised, usdc.balanceOf(address(staking)));
        }

        skip(PERIOD);
        uint256 owed = staking.pendingReward(alice) + staking.pendingReward(bob);
        assertEq(staking.unstreamed(), 0);
        assertLe(owed, total);
        assertLe(owed, usdc.balanceOf(address(staking)));
        // And all but rounding dust is owed to someone. Each rounding drops less than one unit:
        // one per payment (re-basing what is left of the stream), one each time Bob's earnings are
        // booked (six stakes and an unstake), and one each for the two figures read here.
        assertGe(owed + amounts.length + 7 + 2, total);
    }

    // --------------------------------------------------------------------------------------
    // End to end: lose, mine, stake, earn
    // --------------------------------------------------------------------------------------

    function test_endToEnd_losersMineTheCoinAndStakersEarnTheFees() public {
        // Alice busts $1,000. Half of the 2% house fee is the stakers'.
        _bust(alicePk, 1_000e6);
        assertEq(ex.stakerFees(), 10e6);

        // What she mined is in her wallet. She stakes it and is the only staker.
        uint256 mined = coin.balanceOf(alice);
        assertGt(mined, 0);
        vm.startPrank(alice);
        coin.approve(address(staking), mined);
        staking.stake(mined);
        vm.stopPrank();

        // Bob busts too. The fees are pushed and stream to Alice over the next day.
        _bust(bobPk, 1_000e6);
        ex.pushStakerFees();
        assertEq(usdc.balanceOf(address(staking)), 20e6);
        assertEq(staking.pendingReward(alice), 0, "streamed, not handed over");
        skip(PERIOD / 2);
        // $20 a day is not a whole number of units per second: one unit of rounding at most stays
        // behind, and it is never paid out twice.
        _assertStreamed(staking.pendingReward(alice), 10e6, 1, "half a day, half the fees");
        skip(PERIOD / 2);
        _assertStreamed(staking.pendingReward(alice), 20e6, 1, "a day, all of them");

        uint256 before = ex.balances(alice);
        vm.prank(alice);
        uint256 claimed = staking.claim();
        _assertStreamed(claimed, 20e6, 1, "claimed");
        assertEq(ex.balances(alice), before + claimed);
        _assertSolvent();
    }

    /// @dev Cash above the cap reaches stakers the same way: swept in, then streamed. It joins
    ///      whatever stream is already running.
    function test_endToEnd_cashAboveTheCapIsSweptIntoTheSameStream() public {
        _stake(alice, 1_000e18);
        // Keep each launch-day position inside the immutable $2M cash-based ceiling.
        for (uint256 i; i < 3; ++i) {
            _bust(bobPk, 1_440e6);
        }
        // $43.20 of fees: half a tenth of a cent a second.
        assertEq(ex.pushStakerFees(), 43.2e6);
        assertEq(staking.rewardRate(), 500 * 1e18);

        // Half a day on, $21.60 of it is left. The house is given its cap and $64.80 over, which
        // nothing open has a claim on: swept, the stream is $86.40 over a new day.
        skip(12 hours);
        _seedHouse(STAKER_CAP + 64.8e6 - ex.lpCash());
        assertEq(_sweep(P0, _px(2_500)), 64.8e6);
        assertEq(ex.lpCash(), STAKER_CAP);
        assertEq(staking.rewardRate(), 1_000 * 1e18);
        assertEq(staking.unstreamed(), 86.4e6);

        skip(PERIOD);
        assertEq(staking.pendingReward(alice), 43.2e6 + 64.8e6);
        assertEq(staking.totalReceived(), 43.2e6 + 64.8e6);
        _assertSolvent();
    }
}
