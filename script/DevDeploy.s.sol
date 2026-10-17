// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Exchange} from "../src/Exchange.sol";
import {SignedOracle} from "../src/SignedOracle.sol";
import {Pricing} from "../src/Pricing.sol";
import {Sessions} from "../src/Sessions.sol";
import {Coin} from "../src/Coin.sol";
import {Staking} from "../src/Staking.sol";
import {Jackpot} from "../src/Jackpot.sol";
import {LossMining} from "../src/LossMining.sol";
import {Lens} from "../src/periphery/Lens.sol";
import {Batcher} from "../src/periphery/Batcher.sol";
import {SignedSweeper} from "../src/periphery/SignedSweeper.sol";
import {Gateway} from "../src/periphery/Gateway.sol";
import {Deposits} from "../src/periphery/Deposits.sol";
import {MockUSDC} from "../test/mocks/Mocks.sol";
import {Deployable} from "./Deployable.sol";

/// @notice Stands the whole protocol up on a local anvil chain, with a mock USDC, prices signed
///         by one of anvil's own keys, the coin attached and a few funded accounts. For
///         development only.
/// @dev The protocol's own contracts are created from deployable/, as on mainnet, so what the
///      local test suites run against is the bytecode that ships (see script/Deployable.sol).
///
///      anvil
///      node tools/deployable.mjs --forge
///      forge script script/DevDeploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///        --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract DevDeploy is Script {
    // The same feed ids as script/Deploy.s.sol.
    bytes32 internal constant HL_BTC = "hyperliquid:BTC";
    bytes32 internal constant HL_ETH = "hyperliquid:ETH";

    // anvil's well-known accounts 1..5, and 9 for the price signer (the relayer's dev default).
    address internal constant OPERATOR = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant PRICE_SIGNER = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
    address[4] internal TRADERS = [
        0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
        0x90F79bf6EB2c4f870365E785982E1f101E93b906,
        0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,
        0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
    ];

    function run() external {
        require(block.chainid == 31337, "DevDeploy is for a local anvil chain only");

        Deployable.requireReady();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        MockUSDC usdc = new MockUSDC();

        Sessions sessions = Sessions(Deployable.create("Sessions", abi.encode("Tape")));
        Pricing pricing = Pricing(Deployable.create("Pricing", ""));
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        SignedOracle oracle = SignedOracle(Deployable.create("SignedOracle", abi.encode(predicted, PRICE_SIGNER)));
        Exchange exchange = Exchange(
            Deployable.create(
                "Exchange",
                abi.encode(
                    "Tape",
                    usdc,
                    oracle,
                    pricing,
                    sessions,
                    deployer,
                    deployer,
                    uint256(1_000_000e6),
                    uint96(1e6)
                )
            )
        );
        require(address(exchange) == predicted, "exchange address mismatch");
        require(
            address(exchange.usdc()) == address(usdc) && address(exchange.oracle()) == address(oracle)
                && oracle.exchange() == address(exchange) && oracle.signer() == PRICE_SIGNER
                && address(exchange.pricing()) == address(pricing) && exchange.owner() == deployer
                && exchange.stakerCap() == 1_000_000e6 && exchange.minMargin() == 1e6,
            "the Exchange was not built with the arguments given"
        );
        // The real deployment starts at $10 of margin and a $10,000 position (script/Deploy.s.sol).
        // Here a dollar and no smallest position, so the test suites can trade small; set
        // DEV_MIN_NOTIONAL to try the real limit locally.
        exchange.setMinimums(1e6, uint96(vm.envOr("DEV_MIN_NOTIONAL", uint256(0))));
        Lens lens = Lens(Deployable.create("Lens", abi.encode(exchange)));
        Gateway gateway = Gateway(Deployable.create("Gateway", abi.encode(usdc, exchange)));
        Batcher batcher = Batcher(Deployable.create("Batcher", abi.encode(exchange)));
        Deposits deposits = Deposits(Deployable.create("Deposits", abi.encode(usdc, exchange)));
        require(address(deposits.exchange()) == address(exchange), "Deposits was not built with the arguments given");

        // The same pricing parameters as script/Deploy.s.sol, depth included unless DEV_DEPTH says
        // otherwise (whole dollars a side).
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 depth = uint32(vm.envOr("DEV_DEPTH", uint256(1_000_000)));
        exchange.listMarket(
            HL_BTC,
            "BTC",
            1_000,
            Exchange.Curve(15_000, 814_598, 1e7, 476041580087574, depth),
            9_000,
            20,
            10_000_000e6,
            100_000_000e6,
            100_000_000e6
        );
        exchange.listMarket(
            HL_ETH,
            "ETH",
            1_000,
            Exchange.Curve(15_000, 483_979, 1e6, 481304050180130, depth),
            9_000,
            20,
            10_000_000e6,
            100_000_000e6,
            100_000_000e6
        );
        exchange.setOperator(OPERATOR, true);
        // anvil's account 8: the relayer's backup gas wallet on a local chain.
        exchange.setOperator(0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f, true);
        exchange.setOperator(address(batcher), true);
        exchange.setGuardian(deployer);

        Coin coin = Coin(
            Deployable.create("Coin", abi.encode("Tape", "TAPE", uint256(1_000_000_000e18), deployer))
        );
        Staking staking = Staking(Deployable.create("Staking", abi.encode(coin, usdc, exchange)));
        Jackpot jackpot = Jackpot(
            Deployable.create("Jackpot", abi.encode(usdc, uint64(block.timestamp - (block.timestamp % 3600)), uint64(3600), uint16(10_000)))
        );
        LossMining mining = LossMining(
            Deployable.create("LossMining", abi.encode(coin, exchange, uint256(5_000_000e6), address(jackpot)))
        );
        jackpot.bind(address(mining));
        exchange.setDevRecipient(
            Deployable.create("FeeSplitter", abi.encode(usdc, address(jackpot), exchange.devRecipient(), uint16(3_000)))
        );
        SignedSweeper sweeper = SignedSweeper(Deployable.create("SignedSweeper", abi.encode(exchange)));
        require(address(sweeper.oracle()) == address(oracle), "the sweeper reads another oracle");
        require(coin.transfer(address(mining), 200_000_000e18), "reserve");
        exchange.attachCoin(address(staking), address(mining), address(sweeper));

        usdc.mint(deployer, 1_000_000e6);
        for (uint256 i; i < TRADERS.length; ++i) {
            usdc.mint(TRADERS[i], 100_000e6);
            require(coin.transfer(TRADERS[i], 1_000_000e18), "coin");
        }
        vm.stopBroadcast();

        console2.log("Exchange", address(exchange));

        string memory json = "dev";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeString(json, "name", "Tape");
        vm.serializeString(json, "usdcPermitName", "USD Coin");
        vm.serializeString(json, "usdcPermitVersion", "1");
        vm.serializeAddress(json, "usdc", address(usdc));
        vm.serializeString(json, "oracleKind", "signed");
        vm.serializeAddress(json, "priceSigner", PRICE_SIGNER);
        vm.serializeAddress(json, "exchange", address(exchange));
        vm.serializeAddress(json, "oracle", address(oracle));
        vm.serializeAddress(json, "pricing", address(pricing));
        vm.serializeAddress(json, "sessions", address(sessions));
        vm.serializeAddress(json, "lens", address(lens));
        vm.serializeAddress(json, "gateway", address(gateway));
        vm.serializeAddress(json, "batcher", address(batcher));
        vm.serializeAddress(json, "deposits", address(deposits));
        vm.serializeAddress(json, "sweeper", address(sweeper));
        vm.serializeAddress(json, "coin", address(coin));
        vm.serializeAddress(json, "staking", address(staking));
        vm.serializeAddress(json, "jackpot", address(jackpot));
        string memory out = vm.serializeAddress(json, "lossMining", address(mining));
        vm.writeJson(out, "./deployments/31337.json");
    }
}
