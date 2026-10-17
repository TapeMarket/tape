// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {Exchange} from "../src/Exchange.sol";
import {Deposits} from "../src/periphery/Deposits.sol";
import {Deployable} from "./Deployable.sol";

/// @notice Deploys the Deposits contract (a deposit address for every wallet) for an Exchange
///         that is already live, and records it in the deployment file.
/// @dev It needs nothing from the Exchange's owner: `depositFor` is open to anyone, and this
///      contract has no owner of its own. Any wallet with gas can run it.
///
///        EXCHANGE   the Exchange to deposit into   required
///
///      node tools/deployable.mjs --forge
///      EXCHANGE=0x... forge script script/DeployDeposits.s.sol --rpc-url $RPC --broadcast --account <keystore>
contract DeployDeposits is Script {
    function run() external returns (Deposits deposits) {
        Exchange exchange = Exchange(vm.envAddress("EXCHANGE"));
        require(address(exchange).code.length != 0, "EXCHANGE is not a contract");

        Deployable.requireReady();
        vm.startBroadcast();
        deposits = Deposits(Deployable.create("Deposits", abi.encode(exchange.usdc(), exchange)));
        vm.stopBroadcast();
        // Constructor arguments are handed over as bytes, so nothing but this checks their order.
        require(
            address(deposits.usdc()) == address(exchange.usdc()) && address(deposits.exchange()) == address(exchange)
                && deposits.box().code.length != 0
                && exchange.usdc().allowance(address(deposits), address(exchange)) == type(uint256).max,
            "Deposits was not built with the arguments given"
        );
        console2.log("Deposits", address(deposits));

        // A dry run must not leave a record behind: the address in it would not exist.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return deposits;
        // Added to the Exchange's own record, which the relayer and the site read.
        vm.writeJson(
            string.concat('"', vm.toString(address(deposits)), '"'),
            string.concat("./deployments/", vm.toString(block.chainid), ".json"),
            ".deposits"
        );
    }
}
