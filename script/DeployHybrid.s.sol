// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {FastExchange} from "../src/FastExchange.sol";
import {ExchangeBootstrap} from "../src/ExchangeBootstrap.sol";
import {HybridExchangeProxy} from "../src/HybridExchangeProxy.sol";
import {HybridUpgradeController} from "../src/HybridUpgradeController.sol";
import {EmergencyExchange} from "../src/EmergencyExchange.sol";

/// @notice Prepares a new, paused hybrid exchange; never changes the current deployment record.
/// @dev Without --broadcast forge only simulates. This script neither moves user balances nor
///      pauses the existing exchange. Market configuration, operators and a service cutover are
///      separate steps. Rebuild/review the held coin-launch nonce prediction before broadcasting.
contract DeployHybrid is Script {
    string private constant DIR = "deployable/hybrid/";

    function artifact(string memory name, bytes memory args) private returns (address deployed) {
        bytes32 h = keccak256(bytes(name));
        bool periphery = h == keccak256("Lens") || h == keccak256("Gateway")
            || h == keccak256("Batcher") || h == keccak256("Deposits");
        bytes memory code = abi.encodePacked(vm.getCode(string.concat(periphery ? "deployable/" : DIR, name, ".json")), args);
        assembly ("memory-safe") { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), string.concat("Deployment failed: ", name));
    }

    function requireFresh() private view {
        requireFreshAt("deployable/", false);
        requireFreshAt(DIR, true);
    }

    function requireFreshAt(string memory dir, bool checkForge) private view {
        string memory manifest = vm.readFile(string.concat(dir, "manifest.json"));
        string[] memory paths = vm.parseJsonKeys(manifest, ".sources");
        require(paths.length != 0, "Empty hybrid manifest");
        for (uint256 i; i < paths.length; ++i) {
            require(sha256(bytes(vm.readFile(paths[i])))
                == vm.parseJsonBytes32(manifest, string.concat('.sources["', paths[i], '"]')),
                string.concat("Stale hybrid artifact: ", paths[i]));
        }
        if (!checkForge) return;
        string[] memory names = vm.parseJsonKeys(manifest, ".contracts");
        for (uint256 i; i < names.length; ++i) {
            string memory own = vm.parseJsonString(manifest, string.concat(".contracts.", names[i]));
            require(keccak256(vm.getCode(own)) == keccak256(vm.getCode(string.concat(dir, names[i], ".json"))),
                string.concat("Use fast profile and isolated hybrid build: ", names[i]));
        }
    }

    function run() external {
        requireFresh();
        require(block.chainid == vm.envOr("HYBRID_CHAIN_ID", uint256(1)), "Wrong chain");
        string memory current = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address collateral = vm.parseJsonAddress(current, ".usdc");
        address pricing = vm.parseJsonAddress(current, ".pricing");
        address sessions = vm.parseJsonAddress(current, ".sessions");
        address signer = vm.parseJsonAddress(current, ".priceSigner");
        address deployer = vm.envAddress("HYBRID_DEPLOYER");
        address owner = vm.envAddress("HYBRID_OWNER");
        address upgradeOwner = vm.envAddress("HYBRID_UPGRADE_OWNER");
        address guardian = vm.envAddress("HYBRID_GUARDIAN");
        address recipient = vm.envAddress("HYBRID_FEE_RECIPIENT");
        FastExchange old = FastExchange(vm.parseJsonAddress(current, ".exchange"));
        uint256 cap = old.stakerCap();
        uint96 minimum = old.minMargin();
        uint96 notional = old.minNotional();
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 5);

        vm.startBroadcast(deployer);
        address oracle = artifact("ExecutionOracle", abi.encode(predicted, signer));
        address logic = artifact("FastExchange", abi.encode("Tape", collateral, oracle, pricing, sessions,
            address(this), recipient, cap, minimum));
        address bootstrap = artifact("ExchangeBootstrap", "");
        address recovery = artifact("EmergencyExchange", abi.encode(collateral, oracle, pricing, sessions, cap));
        address controller = artifact("HybridUpgradeController", abi.encode(upgradeOwner, guardian, predicted, recovery));
        address exchange = artifact("HybridExchangeProxy", abi.encode(logic, bootstrap, controller,
            ExchangeBootstrap.InitialConfig(owner, guardian, recipient, minimum, notional)));
        require(exchange == predicted, "Unexpected proxy address");
        address lens = artifact("Lens", abi.encode(exchange));
        address gateway = artifact("Gateway", abi.encode(collateral, exchange));
        address batcher = artifact("Batcher", abi.encode(exchange));
        address deposits = artifact("Deposits", abi.encode(collateral, exchange));
        vm.stopBroadcast();

        require(FastExchange(exchange).owner() == owner && FastExchange(exchange).opensPaused(), "Bootstrap failed");
        require(HybridUpgradeController(controller).proxyAdmin().owner() == controller, "Wrong upgrade administration");
        string memory key = "hybrid";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeString(key, "name", "Tape");
        vm.serializeString(key, "executionMode", "order-bound");
        vm.serializeString(key, "oracleKind", "signed");
        vm.serializeString(key, "exchangeContract", "FastExchange");
        vm.serializeAddress(key, "usdc", collateral);
        vm.serializeAddress(key, "pricing", pricing);
        vm.serializeAddress(key, "sessions", sessions);
        vm.serializeAddress(key, "priceSigner", signer);
        vm.serializeAddress(key, "oracle", oracle);
        vm.serializeAddress(key, "exchange", exchange);
        vm.serializeAddress(key, "implementation", logic);
        vm.serializeAddress(key, "bootstrap", bootstrap);
        vm.serializeAddress(key, "emergencyImplementation", recovery);
        vm.serializeAddress(key, "upgradeController", controller);
        vm.serializeAddress(key, "upgradeOwner", upgradeOwner);
        vm.serializeAddress(key, "guardian", guardian);
        vm.serializeAddress(key, "lens", lens);
        vm.serializeAddress(key, "gateway", gateway);
        vm.serializeAddress(key, "batcher", batcher);
        vm.serializeAddress(key, "deposits", deposits);
        string memory record = vm.serializeUint(key, "block", block.number);
        vm.writeJson(record, string.concat("deployments/", vm.toString(block.chainid), "-hybrid-candidate.json"));
    }
}
