// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/console2.sol";
import {Deployer} from "./Deployer.sol";
import {Jackpot} from "../src/Jackpot.sol";

interface IRewardForkUSDC is IERC20 {
    function blacklister() external view returns (address);
    function blacklist(address user) external;
    function unBlacklist(address user) external;
}

/// Opt-in local fork only. All funding and admin impersonation modify the fork's state;
/// these tests never sign or broadcast a transaction to Ethereum.
contract RewardReservationsForkTest is Deployer {
    IRewardForkUSDC private usdc;
    Jackpot private jackpot;
    address private winner;
    uint256 private begins;

    function setUp() public {
        if (!vm.envOr("REWARD_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        console2.log("Local reward fork block", block.number);
        usdc = IRewardForkUSDC(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
        begins = block.timestamp;
        winner = makeAddr("Tape reward fork winner");
        jackpot = Jackpot(
            _deployed(
                "Jackpot",
                type(Jackpot).creationCode,
                abi.encode(usdc, uint64(begins), uint64(3600), uint16(10_000))
            )
        );
        jackpot.bind(address(this));
        deal(address(usdc), address(this), 100e6);
        usdc.approve(address(jackpot), 100e6);
        jackpot.fund(100e6);
        jackpot.enter(winner, 1e6);
    }

    function _draw() private {
        vm.warp(begins + 3600);
        jackpot.close(0);
        (uint64 at,,,) = jackpot.rounds(0);
        vm.roll(at + 1);
        vm.setBlockhash(at, keccak256("local real-USDC delivery regression"));
        vm.cool(address(usdc));
        vm.cool(address(jackpot));
        jackpot.draw(0);
    }

    function test_realUsdcAutomaticPayoutFitsBoundedDelivery() public {
        uint256 beforeBalance = usdc.balanceOf(winner);
        _draw();
        assertTrue(jackpot.paid(0), "real USDC proxy transfer fits the automatic allowance");
        assertEq(usdc.balanceOf(winner), beforeBalance + 100e6);
        assertEq(jackpot.reservedPrizes(), 0);
    }

    function test_realUsdcRejectionPreservesWinnerAndCanBeRetried() public {
        address authority = usdc.blacklister();
        vm.prank(authority);
        usdc.blacklist(winner);
        _draw();
        (, bool drawn, address recorded, uint128 prize) = jackpot.rounds(0);
        assertTrue(drawn);
        assertEq(recorded, winner);
        assertEq(prize, 100e6);
        assertFalse(jackpot.paid(0));
        assertEq(jackpot.reservedPrizes(), 100e6);
        assertEq(jackpot.pot(), 0);
        vm.prank(authority);
        usdc.unBlacklist(winner);
        jackpot.claim(0);
        assertEq(usdc.balanceOf(winner), 100e6);
        assertTrue(jackpot.paid(0));
        assertEq(jackpot.reservedPrizes(), 0);
    }
}
