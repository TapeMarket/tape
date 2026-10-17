// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {LaunchCoin} from "../src/LaunchCoin.sol";
import {Staking} from "../src/Staking.sol";
import {LossMining} from "../src/LossMining.sol";
import {Sweeper} from "../src/periphery/Sweeper.sol";
import {ILossMining} from "../src/interfaces/IHooks.sol";

/// @dev The launch coin away from Uniswap: its supply, its wallet limit, and the exchange's loss
///      mining and staking working through that limit. The pool itself needs the real Uniswap v4
///      and is in test/LaunchCoinFork.t.sol.
contract LaunchCoinTest is Base {
    uint256 internal constant MAX_WALLET_BPS = 200;
    uint256 internal constant MAX_WALLET = SUPPLY * MAX_WALLET_BPS / 10_000;
    /// @dev Exchange.MINING_GAS, which is private: the gas the Exchange gives the mining hook.
    uint256 internal constant MINING_GAS = 150_000;

    LaunchCoin internal lc;
    address internal coinOwner = makeAddr("coin owner");
    address internal holder = makeAddr("reserve holder");
    uint64 internal P0;

    function setUp() public override {
        super.setUp();
        P0 = _px(80_000);
        lc = _coin(SUPPLY, RESERVE, holder, MAX_WALLET_BPS);
    }

    function _coin(uint256 supply, uint256 reserve, address reserveTo, uint256 bps)
        internal
        returns (LaunchCoin)
    {
        return LaunchCoin(
            _deployed(
                "LaunchCoin",
                type(LaunchCoin).creationCode,
                abi.encode("Tape", "TAPE", supply, reserve, reserveTo, bps, coinOwner)
            )
        );
    }

    function _refused(uint256 supply, uint256 reserve, address reserveTo, uint256 bps, address owner_)
        internal
        returns (bool)
    {
        bytes memory initcode = abi.encodePacked(
            type(LaunchCoin).creationCode, abi.encode("Tape", "TAPE", supply, reserve, reserveTo, bps, owner_)
        );
        address made;
        assembly ("memory-safe") {
            made := create(0, add(initcode, 0x20), mload(initcode))
        }
        return made == address(0);
    }

    /// @dev Wires the coin to the Exchange the way script/AttachCoin.s.sol does: loss mining and
    ///      staking are put outside the wallet limit, then the reserve moves to loss mining.
    function _attach(uint256 toMining) internal {
        staking = Staking(_deployed("Staking", type(Staking).creationCode, abi.encode(lc, usdc, ex)));
        mining = LossMining(
            _deployed(
                "LossMining", type(LossMining).creationCode, abi.encode(lc, ex, MINING_SCALE, address(0))
            )
        );
        sweeper = _deployedSweeper();
        vm.startPrank(coinOwner);
        lc.setExempt(address(mining));
        lc.setExempt(address(staking));
        vm.stopPrank();
        vm.prank(holder);
        lc.transfer(address(mining), toMining);
        vm.prank(admin);
        ex.attachCoin(address(staking), address(mining), address(sweeper));
    }

    function _bust(uint256 pk, uint96 margin) internal {
        bytes32 id = _open(pk, btc, true, margin, 1_000, P0);
        _liquidate(id, _px(79_900));
    }

    // --------------------------------------------------------------------------------------
    // Supply
    // --------------------------------------------------------------------------------------

    function test_supply_isSplitBetweenTheReserveAndThePool() public view {
        assertEq(lc.totalSupply(), SUPPLY);
        assertEq(lc.decimals(), 18);
        assertEq(lc.name(), "Tape");
        assertEq(lc.symbol(), "TAPE");
        assertEq(lc.balanceOf(holder), RESERVE, "the mining reserve");
        assertEq(lc.balanceOf(address(lc)), SUPPLY - RESERVE, "the pool's part waits inside the coin");
        assertEq(lc.poolSupply(), SUPPLY - RESERVE);
        assertEq(lc.maxWallet(), MAX_WALLET);
        assertTrue(lc.limitsInEffect());
        assertEq(lc.owner(), coinOwner);
        assertEq(lc.lpTokenId(), 0);
        assertEq(lc.lockId(), 0);
        assertEq(lc.lockedUntil(), 0);
        assertEq(lc.lockedLiquidity(), 0);
    }

    function test_supply_badParametersAreRefused() public {
        assertTrue(_refused(SUPPLY, SUPPLY, holder, 200, coinOwner), "nothing left for the pool");
        assertTrue(_refused(SUPPLY, SUPPLY + 1, holder, 200, coinOwner), "reserve above the supply");
        assertTrue(_refused(SUPPLY, RESERVE, address(0), 200, coinOwner), "a reserve with nowhere to go");
        assertTrue(_refused(SUPPLY, RESERVE, holder, 10_001, coinOwner), "a limit above the supply");
        assertTrue(_refused(SUPPLY, RESERVE, holder, 200, address(0)), "no owner");
        assertTrue(
            _refused(uint256(uint128(type(int128).max)) + 1, RESERVE, holder, 200, coinOwner),
            "a supply the pool cannot take"
        );
        assertFalse(_refused(SUPPLY, 0, address(0), 200, coinOwner), "no reserve at all is fine");
    }

    function test_supply_burnsAndPermits() public {
        vm.prank(holder);
        lc.transfer(alice, 10e18);
        vm.prank(alice);
        lc.burn(4e18);
        assertEq(lc.balanceOf(alice), 6e18);
        assertEq(lc.totalSupply(), SUPPLY - 4e18);

        // EIP-2612: what Staking.stakeWithPermit relies on.
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                alice,
                bob,
                uint256(5e18),
                lc.nonces(alice),
                block.timestamp + 1
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", lc.DOMAIN_SEPARATOR(), structHash)));
        lc.permit(alice, bob, 5e18, block.timestamp + 1, v, r, s);
        assertEq(lc.allowance(alice, bob), 5e18);
    }

    // --------------------------------------------------------------------------------------
    // The wallet limit
    // --------------------------------------------------------------------------------------

    function test_limit_noWalletEndsATransferAboveIt() public {
        vm.startPrank(holder);
        lc.transfer(alice, MAX_WALLET);
        assertEq(lc.balanceOf(alice), MAX_WALLET, "exactly the limit is allowed");
        vm.expectRevert(LaunchCoin.MaxWallet.selector);
        lc.transfer(alice, 1);
        lc.transfer(bob, MAX_WALLET / 2);
        vm.stopPrank();

        // Between two ordinary wallets, and through an allowance, the same.
        vm.prank(bob);
        vm.expectRevert(LaunchCoin.MaxWallet.selector);
        lc.transfer(alice, 1);
        vm.prank(bob);
        lc.approve(carol, type(uint256).max);
        vm.prank(carol);
        vm.expectRevert(LaunchCoin.MaxWallet.selector);
        lc.transferFrom(bob, alice, 1);

        // Room made by sending coin away, or burning it, can be filled again.
        vm.prank(alice);
        lc.burn(10e18);
        vm.prank(bob);
        lc.transfer(alice, 10e18);
        assertEq(lc.balanceOf(alice), MAX_WALLET);
    }

    function test_limit_theReserveHolderAndTheOwnerAreNotExempt() public {
        vm.prank(holder);
        lc.transfer(alice, 1e18);
        // The holder was minted the reserve, far above the limit. It can send it on; it cannot be sent more.
        vm.prank(alice);
        vm.expectRevert(LaunchCoin.MaxWallet.selector);
        lc.transfer(holder, 1);

        vm.startPrank(holder);
        lc.transfer(coinOwner, MAX_WALLET);
        vm.expectRevert(LaunchCoin.MaxWallet.selector);
        lc.transfer(coinOwner, 1);
        vm.stopPrank();
        assertFalse(lc.isExempt(coinOwner));
        assertFalse(lc.isExempt(holder));
    }

    function test_limit_thePoolTheCoinAndTheBurnAddressAreOutsideIt() public {
        vm.startPrank(holder);
        lc.transfer(lc.POOL_MANAGER(), MAX_WALLET + 1);
        lc.transfer(lc.DEAD(), MAX_WALLET + 1);
        lc.transfer(address(lc), MAX_WALLET + 1);
        vm.stopPrank();
        assertEq(lc.balanceOf(lc.POOL_MANAGER()), MAX_WALLET + 1);
    }

    function test_limit_exemptingIsTheOwnersAndPutsAnAccountOutsideIt() public {
        vm.prank(stranger);
        vm.expectRevert(LaunchCoin.NotOwner.selector);
        lc.setExempt(stranger);
        vm.prank(holder);
        vm.expectRevert(LaunchCoin.NotOwner.selector);
        lc.setExempt(holder);
        vm.prank(coinOwner);
        vm.expectRevert(LaunchCoin.ZeroAddress.selector);
        lc.setExempt(address(0));

        vm.prank(coinOwner);
        lc.setExempt(carol);
        assertTrue(lc.isExempt(carol));
        vm.prank(holder);
        lc.transfer(carol, RESERVE);
        assertEq(lc.balanceOf(carol), RESERVE);
    }

    function test_limit_removingItIsTheOwnersAndForGood() public {
        vm.prank(stranger);
        vm.expectRevert(LaunchCoin.NotOwner.selector);
        lc.removeLimits();

        vm.prank(coinOwner);
        lc.removeLimits();
        assertFalse(lc.limitsInEffect());
        vm.prank(holder);
        lc.transfer(alice, RESERVE);
        assertEq(lc.balanceOf(alice), RESERVE);
        // There is no function that turns it back on: the ABI has removeLimits and nothing else.
    }

    function test_limit_aCoinMadeWithoutOneHasNone() public {
        LaunchCoin free = _coin(SUPPLY, RESERVE, holder, 0);
        assertFalse(free.limitsInEffect());
        assertEq(free.maxWallet(), 0);
        vm.prank(holder);
        free.transfer(alice, RESERVE);
        assertEq(free.balanceOf(alice), RESERVE);
    }

    // --------------------------------------------------------------------------------------
    // The owner
    // --------------------------------------------------------------------------------------

    function test_owner_cannotWalkAwayBeforeThePoolIsOpen() public {
        vm.prank(stranger);
        vm.expectRevert(LaunchCoin.NotOwner.selector);
        lc.renounceOwnership();
        // Renouncing now would leave the pool's coin inside the contract with nobody able to launch.
        vm.prank(coinOwner);
        vm.expectRevert(LaunchCoin.NotLaunched.selector);
        lc.renounceOwnership();
        assertEq(lc.owner(), coinOwner);
    }

    function test_owner_launchIsTheOwnersAlone() public {
        vm.prank(stranger);
        vm.expectRevert(LaunchCoin.NotOwner.selector);
        lc.launch(10_000, 200, address(0), 1, -887200, 200400, 1, block.timestamp, 365 days, coinOwner, 100);
    }

    // --------------------------------------------------------------------------------------
    // With the exchange: loss mining and staking through the limit
    // --------------------------------------------------------------------------------------

    function test_exchange_theReserveCannotReachLossMiningUnlessItIsExempt() public {
        mining = LossMining(
            _deployed(
                "LossMining", type(LossMining).creationCode, abi.encode(lc, ex, MINING_SCALE, address(0))
            )
        );
        vm.prank(holder);
        vm.expectRevert(LaunchCoin.MaxWallet.selector);
        lc.transfer(address(mining), RESERVE);
    }

    function test_exchange_aLossIsPaidInCoinWithTheLimitOn() public {
        _attach(RESERVE);
        assertEq(lc.balanceOf(address(mining)), RESERVE);
        _fund(alice, 100_000e6);

        uint256 expected = mining.quote(100e6);
        assertApproxEqRel(expected, 100 * 40e18, 0.0001e18);
        _bust(alicePk, 100e6);
        assertEq(lc.balanceOf(alice), expected, "in her wallet as the loss settled");
        assertEq(mining.totalMined(), expected);
    }

    function test_exchange_payingALoserFitsInTheGasTheExchangeGives() public {
        _attach(RESERVE);
        address fresh = makeAddr("never held the coin");
        vm.prank(address(ex));
        (bool ok,) =
            address(mining).call{gas: MINING_GAS}(abi.encodeCall(ILossMining.onLoss, (fresh, 1_000e6)));
        assertTrue(ok, "the limit check must fit in the mining gas");
        assertGt(lc.balanceOf(fresh), 0);
    }

    function test_exchange_aLoserAlreadyAtTheLimitStillSettles_withoutTheCoin() public {
        // Alice holds the limit to the last unit, so nothing more can be sent to her.
        _attach(RESERVE - MAX_WALLET);
        vm.prank(holder);
        lc.transfer(alice, MAX_WALLET);
        _fund(alice, 100_000e6);

        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        uint256 reserveBefore = mining.reserve();
        uint256 reservedReward = mining.quote(100e6);
        _liquidate(id, _px(79_900));

        assertEq(ex.getPosition(id).owner, address(0), "the loss settled all the same");
        assertEq(lc.balanceOf(alice), MAX_WALLET, "she was sent nothing");
        assertEq(mining.reserve(), reserveBefore - reservedReward, "her entitlement is reserved");
        assertEq(mining.pendingRewards(alice), reservedReward);
        assertEq(
            mining.cumulativeLossUsd(), 100e6, "realized losses advance the curve even if delivery fails"
        );

        // With the limit gone the next loss pays as usual.
        vm.prank(coinOwner);
        lc.removeLimits();
        uint256 expected = mining.quote(100e6);
        _bust(alicePk, 100e6);
        assertEq(lc.balanceOf(alice), MAX_WALLET + expected);
    }

    function test_exchange_stakingHoldsManyWalletsWorthAndPaysBack() public {
        _attach(RESERVE - 3 * MAX_WALLET);
        address[3] memory stakers = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.prank(holder);
            lc.transfer(stakers[i], MAX_WALLET);
            vm.startPrank(stakers[i]);
            lc.approve(address(staking), MAX_WALLET);
            staking.stake(MAX_WALLET);
            vm.stopPrank();
        }
        assertEq(
            lc.balanceOf(address(staking)), 3 * MAX_WALLET, "three times the wallet limit, in one contract"
        );

        vm.prank(alice);
        staking.unstake(MAX_WALLET);
        assertEq(lc.balanceOf(alice), MAX_WALLET);
    }
}
