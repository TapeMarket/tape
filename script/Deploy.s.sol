// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Exchange} from "../src/Exchange.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {SignedOracle} from "../src/SignedOracle.sol";
import {Pricing} from "../src/Pricing.sol";
import {Sessions} from "../src/Sessions.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {Lens} from "../src/periphery/Lens.sol";
import {Batcher} from "../src/periphery/Batcher.sol";
import {Gateway} from "../src/periphery/Gateway.sol";
import {Deployable} from "./Deployable.sol";

/// @notice Deploys the exchange: Sessions, Pricing, oracle, Exchange, Lens, Gateway and Batcher, and
///         lists BTC and ETH.
/// @dev Everything is read from the environment, with Ethereum mainnet defaults.
///
///        NAME            EIP-712 domain name                       "Tape"
///        USDC            collateral token                          mainnet USDC
///        ORACLE          where prices come from                    "hyperliquid"
///                          hyperliquid  prices signed by PRICE_SIGNER, who reads them from
///                                       Hyperliquid's order book (src/SignedOracle.sol)
///                          pyth         Pyth's pull oracle (src/PythOracle.sol)
///        PRICE_SIGNER    address of the key that signs prices      required for hyperliquid
///        PYTH            Pyth contract, for ORACLE=pyth            mainnet Pyth
///        OWNER           final owner (must accept)                 the deployer
///        DEV_RECIPIENT   receives the dev half of fees             the deployer
///        OPERATOR        relayer/keeper hot key                    none
///        GUARDIAN        can pause opens and retire markets        none
///        STAKER_CAP      house equity kept before stakers, USDC    5,000,000
///        MIN_MARGIN      smallest position margin, USDC            10
///        MIN_NOTIONAL    smallest position (margin x leverage)     10,000
///        CAP_BTC         most open on each side of BTC, USDC       25,000,000
///        CAP_ETH         most open on each side of ETH, USDC       10,000,000
///        DEPTH_BTC       open on a side before size costs, dollars 1,000,000
///        DEPTH_ETH       the same for ETH, whole dollars           1,000,000
///        ORACLE_FLOAT    wei sent to the oracle for Pyth fees      0.02 ether with pyth, else none
///
///      The bytecode comes from deployable/, which tools/deployable.mjs builds the way Etherscan
///      will compile it (see script/Deployable.sol). Build it first; the script stops if it is
///      missing or older than the sources.
///
///      node tools/deployable.mjs --forge
///      forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --account <keystore>
contract Deploy is Script {
    address internal constant MAINNET_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant MAINNET_PYTH = 0x4305FB66699C3B2702D4d05CF36551390A4c69C6;

    // Pyth's ids of its BTC/USD and ETH/USD feeds.
    bytes32 internal constant BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    // The feed ids the price signer signs under: plain text, so an explorer shows what they are.
    bytes32 internal constant HL_BTC = "hyperliquid:BTC";
    bytes32 internal constant HL_ETH = "hyperliquid:ETH";

    // The pricing parameters the reference exchange trades under, as its contract holds them (see
    // PerpMath). test/ReferenceParity.t.sol replays its real settlements through them.
    uint32 internal constant RATE_MULTIPLIER = 15_000;
    uint32 internal constant BTC_POSITION_MULTIPLIER = 814_598; // 814.598, in thousandths
    uint32 internal constant ETH_POSITION_MULTIPLIER = 483_979; // 483.979
    // One price tick in 1e8 terms: a dime for BTC, a cent for ETH.
    uint32 internal constant BTC_TICK = 1e7;
    uint32 internal constant ETH_TICK = 1e6;
    // How far before zero equity the bust trigger sits, as a 1e18 fraction of that price.
    uint64 internal constant BTC_BUST_BUFFER = 476041580087574;
    uint64 internal constant ETH_BUST_BUFFER = 481304050180130;
    uint16 internal constant MAX_KEEP_BPS = 9_000;
    uint16 internal constant MAX_CONF_BPS = 20;
    uint80 internal constant MAX_NOTIONAL = 10_000_000e6;
    // The most that may be open on each side of a market: CAP_BTC and CAP_ETH.
    //
    // A position fills and closes at the oracle's price whatever its size. Someone holding enough
    // of one side can therefore push the market the price is read from a few basis points, close,
    // and be paid on the whole position. That is how the reference exchange was drained on 2026-10-10: its
    // price came from one venue, Hyperliquid, which $20M moved by 10 to 20 bps, against
    // nine-figure positions. With ORACLE=hyperliquid the price here comes from that same one
    // venue, so the same push is possible, and what stands against it is the size of what it can
    // win: each side is capped, and a full side is paid less for a small move (the depth, below).
    // At these caps a 15 bps push is paid about $8,000 on a full ETH side and $17,000 on a full
    // BTC side (test/Depth.t.sol), against the tens of thousands that moving Hyperliquid's book
    // that far and back costs. Raise the caps only with evidence of that book's real depth, and
    // only as the owner (`setCaps`): the relayer's key cannot. (With ORACLE=pyth the price is
    // taken across many venues, and moving it means moving the market.)
    uint256 internal constant DEFAULT_CAP_BTC = 25_000_000e6;
    uint256 internal constant DEFAULT_CAP_ETH = 10_000_000e6;
    // How much may be open on one side of a market at the reference exchange's own price, in whole dollars:
    // DEPTH_BTC and DEPTH_ETH.
    //
    // The cap bounds what a push can take. The depth is what makes a push a bad trade well inside
    // the cap. The reference exchange priced a close as if every position were $100,000, so a position a
    // thousand times that size kept the same share of a ten basis point move. Here a position
    // opened on a side that already holds more than the depth is charged for the size ahead of
    // it (PerpMath.impactNotionalFor): the fuller the side, the less of a small move it keeps.
    // With $1,000,000, a side filled to the $10M ETH cap is paid about $8,000 for a 15 bps push
    // where the curve alone paid $11,200, and a $100M side about $25,000 where it paid $112,000
    // (test/Depth.t.sol): what a side can take grows as the logarithm of its size. The first
    // million on a side, and any position of up to two million on a quiet one, is priced exactly
    // as the reference exchange prices it. A smaller depth protects more and charges ordinary traders
    // sooner ($500,000 pays $6,200 and $15,800 in those two cases); a larger one the reverse.
    // The owner can move it later (`setDepth`), and that never reprices an open position.
    uint256 internal constant DEFAULT_DEPTH = 1_000_000;

    // The markets after BTC and ETH, all priced from Hyperliquid (ORACLE=hyperliquid only): SOL,
    // XRP and DOGE from its own perpetuals, gold, the S&P 500 and three stocks from trade.xyz's
    // ("xyz:"). Each curve is BTC and ETH's scaled for how far the market moves in a minute
    // against ETH, a little stricter for markets that follow a stock exchange's hours. Each cap is
    // about half of what rested on Hyperliquid's book within 0.15% of the price when they were
    // set (2026-10-16), and each depth a tenth of the cap. The owner can move caps and depths
    // later; the curve, the tick and the leverage are fixed once listed. The preview lists the
    // same markets with the same figures (web/src/lib/preview/engine.ts).
    uint64 internal constant LISTING_BUST_BUFFER = 480000000000000;

    struct Listing {
        bytes32 feed;
        string symbol;
        uint16 maxLeverage;
        uint32 rateMultiplier;
        uint32 positionMultiplier;
        uint32 tick;
        uint32 depth;
        uint80 maxNotional;
        uint96 cap;
    }

    function _listings() internal pure returns (Listing[8] memory l) {
        l[0] = Listing("hyperliquid:SOL", "SOL", 500, 15_000, 403_000, 1e5, 150_000, 1_000_000e6, 1_500_000e6);
        l[1] = Listing("hyperliquid:XRP", "XRP", 500, 15_000, 435_000, 1e3, 50_000, 250_000e6, 500_000e6);
        l[2] = Listing("hyperliquid:DOGE", "DOGE", 500, 15_000, 388_000, 1e2, 30_000, 150_000e6, 300_000e6);
        l[3] = Listing(
            "hyperliquid:xyz:GOLD", "GOLD", 500, 25_000, 1_186_000, 1e6, 150_000, 1_000_000e6, 1_500_000e6
        );
        l[4] = Listing(
            "hyperliquid:xyz:SP500", "SPX", 500, 40_000, 1_896_000, 1e6, 600_000, 2_000_000e6, 6_000_000e6
        );
        l[5] =
            Listing("hyperliquid:xyz:TSLA", "TSLA", 200, 15_000, 498_000, 1e5, 50_000, 250_000e6, 500_000e6);
        l[6] = Listing(
            "hyperliquid:xyz:NVDA", "NVDA", 200, 15_000, 611_000, 1e5, 100_000, 500_000e6, 1_000_000e6
        );
        l[7] =
            Listing("hyperliquid:xyz:AAPL", "AAPL", 200, 18_000, 853_000, 1e5, 50_000, 250_000e6, 500_000e6);
    }

    struct Deployment {
        Exchange exchange;
        /// @dev A SignedOracle or a PythOracle, as ORACLE says.
        address oracle;
        Pricing pricing;
        Sessions sessions;
        Lens lens;
        Gateway gateway;
        Batcher batcher;
    }

    /// @dev The ten accounts of the mnemonic anvil and hardhat start with.
    function _isWellKnownTestKey(address who) private pure returns (bool) {
        address[10] memory known = [
            0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
            0x90F79bf6EB2c4f870365E785982E1f101E93b906,
            0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,
            0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc,
            0x976EA74026E726554dB657fA54763abd0C3a0aa9,
            0x14dC79964da2C08b23698B3D3cc7Ca32193d9955,
            0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f,
            0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
        ];
        for (uint256 i; i < known.length; ++i) {
            if (who == known[i]) return true;
        }
        return false;
    }

    function run() external returns (Deployment memory d) {
        require(
            block.chainid == 1 || block.chainid == 31337,
            "Tape deploys on Ethereum mainnet or a local rehearsal"
        );
        address usdc = vm.envOr("USDC", MAINNET_USDC);
        address pyth = vm.envOr("PYTH", MAINNET_PYTH);
        string memory name = vm.envOr("NAME", string("Tape"));
        uint256 stakerCap = vm.envOr("STAKER_CAP", uint256(5_000_000e6));
        uint256 minMargin = vm.envOr("MIN_MARGIN", uint256(10e6));
        uint256 minNotional = vm.envOr("MIN_NOTIONAL", uint256(10_000e6));
        uint256 capBtcInput = vm.envOr("CAP_BTC", DEFAULT_CAP_BTC);
        uint256 capEthInput = vm.envOr("CAP_ETH", DEFAULT_CAP_ETH);
        require(minMargin != 0 && minMargin <= type(uint96).max, "MIN_MARGIN must fit uint96 and be nonzero");
        require(minNotional <= type(uint96).max, "MIN_NOTIONAL must fit uint96");
        require(
            capBtcInput <= type(uint96).max && capEthInput <= type(uint96).max, "market caps must fit uint96"
        );
        // forge-lint: disable-start(unsafe-typecast)
        uint96 capBtc = uint96(capBtcInput);
        uint96 capEth = uint96(capEthInput);
        // forge-lint: disable-end(unsafe-typecast)
        uint256 depthBtc = vm.envOr("DEPTH_BTC", DEFAULT_DEPTH);
        uint256 depthEth = vm.envOr("DEPTH_ETH", DEFAULT_DEPTH);
        require(depthBtc != 0 && depthBtc <= type(uint32).max, "DEPTH_BTC is whole dollars, 1 to 4294967295");
        require(depthEth != 0 && depthEth <= type(uint32).max, "DEPTH_ETH is whole dollars, 1 to 4294967295");
        bytes32 kind = keccak256(bytes(vm.envOr("ORACLE", string("hyperliquid"))));
        bool signed = kind == keccak256("hyperliquid");
        require(signed || kind == keccak256("pyth"), "ORACLE is hyperliquid or pyth");
        address priceSigner = signed ? vm.envAddress("PRICE_SIGNER") : address(0);
        uint256 float = vm.envOr("ORACLE_FLOAT", signed ? uint256(0) : uint256(0.02 ether));
        // Signed prices cost nothing to read, and the SignedOracle cannot hold ETH.
        require(!signed || float == 0, "ORACLE_FLOAT is for ORACLE=pyth only");

        Deployable.requireReady();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = vm.envOr("OWNER", deployer);
        address devRecipient = vm.envOr("DEV_RECIPIENT", deployer);
        address operator = vm.envOr("OPERATOR", address(0));
        address backupOperator = vm.envOr("BACKUP_OPERATOR", address(0));
        address guardian = vm.envOr("GUARDIAN", address(0));
        // The price signer's key sits on the relayer's server. It must not be a key that owns
        // anything: whoever holds the owner's key can replace the signer, not the other way round.
        // Nor the operator's: then the one key that sends every trade would also set its price.
        require(
            !signed
                || (priceSigner != address(0)
                    && priceSigner != deployer
                    && priceSigner != owner
                    && priceSigner != operator
                    && priceSigner != backupOperator
                    && priceSigner != guardian),
            "PRICE_SIGNER must be separate from deployer, owner, both operators and guardian"
        );
        // The keys every Foundry install ships with are in a thousand tutorials. One of them as
        // the price signer of a real deployment would hand the price to anyone who has read one.
        require(
            !signed || block.chainid == 31337 || !_isWellKnownTestKey(priceSigner),
            "PRICE_SIGNER is one of anvil's well-known test accounts"
        );

        // The oracle and the Exchange are immutable and point at each other, so the Exchange
        // address is computed before either exists.
        d.sessions = Sessions(Deployable.create("Sessions", abi.encode(name)));
        d.pricing = Pricing(Deployable.create("Pricing", ""));
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        d.oracle = signed
            ? Deployable.create("SignedOracle", abi.encode(predicted, priceSigner))
            : Deployable.create("PythOracle", abi.encode(pyth, predicted));
        // `minMargin` is an operator-sized USDC amount.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint96 smallestMargin = uint96(minMargin);
        d.exchange = Exchange(
            Deployable.create(
                "Exchange",
                abi.encode(
                    name,
                    usdc,
                    d.oracle,
                    d.pricing,
                    d.sessions,
                    deployer,
                    devRecipient,
                    stakerCap,
                    smallestMargin
                )
            )
        );
        require(address(d.exchange) == predicted, "exchange address mismatch");
        // Constructor arguments are handed over as bytes, so nothing but this checks their order.
        require(
            address(d.exchange.usdc()) == usdc && address(d.exchange.oracle()) == d.oracle
                && address(d.exchange.pricing()) == address(d.pricing)
                && address(d.exchange.sessions()) == address(d.sessions) && d.exchange.owner() == deployer
                && d.exchange.devRecipient() == devRecipient && d.exchange.stakerCap() == stakerCap
                && d.exchange.minMargin() == smallestMargin,
            "the Exchange was not built with the arguments given"
        );
        if (signed) {
            require(
                SignedOracle(d.oracle).exchange() == address(d.exchange)
                    && SignedOracle(d.oracle).signer() == priceSigner,
                "the oracle was not built with the arguments given"
            );
        } else {
            require(
                address(PythOracle(payable(d.oracle)).pyth()) == pyth
                    && PythOracle(payable(d.oracle)).exchange() == address(d.exchange),
                "the oracle was not built with the arguments given"
            );
        }

        // Both are USDC amounts far inside uint96.
        // forge-lint: disable-next-line(unsafe-typecast)
        d.exchange.setMinimums(uint96(minMargin), uint96(minNotional));

        d.lens = Lens(Deployable.create("Lens", abi.encode(d.exchange)));
        d.gateway = Gateway(Deployable.create("Gateway", abi.encode(usdc, d.exchange)));
        // The relayer sends its orders through the Batcher, which is therefore an operator. It
        // passes calls on only from addresses the Exchange itself lists as operators.
        d.batcher = Batcher(Deployable.create("Batcher", abi.encode(d.exchange)));
        require(
            d.lens.exchange() == d.exchange && d.batcher.exchange() == d.exchange
                && address(d.gateway.exchange()) == address(d.exchange) && address(d.gateway.usdc()) == usdc,
            "the Lens, Gateway or Batcher was not built with the arguments given"
        );
        d.exchange.setOperator(address(d.batcher), true);

        d.exchange
            .listMarket(
                signed ? HL_BTC : BTC_USD,
                "BTC",
                1_000,
                // Checked against uint32 above.
                // forge-lint: disable-next-line(unsafe-typecast)
                Exchange.Curve(
                    RATE_MULTIPLIER, BTC_POSITION_MULTIPLIER, BTC_TICK, BTC_BUST_BUFFER, uint32(depthBtc)
                ),
                MAX_KEEP_BPS,
                MAX_CONF_BPS,
                MAX_NOTIONAL,
                capBtc,
                capBtc
            );
        d.exchange
            .listMarket(
                signed ? HL_ETH : ETH_USD,
                "ETH",
                1_000,
                // Checked against uint32 above.
                // forge-lint: disable-next-line(unsafe-typecast)
                Exchange.Curve(
                    RATE_MULTIPLIER, ETH_POSITION_MULTIPLIER, ETH_TICK, ETH_BUST_BUFFER, uint32(depthEth)
                ),
                MAX_KEEP_BPS,
                MAX_CONF_BPS,
                MAX_NOTIONAL,
                capEth,
                capEth
            );

        // LISTINGS=false deploys BTC and ETH alone.
        if (signed && vm.envOr("LISTINGS", true)) {
            Listing[8] memory more = _listings();
            for (uint256 i; i < more.length; ++i) {
                Listing memory m = more[i];
                d.exchange
                    .listMarket(
                        m.feed,
                        m.symbol,
                        m.maxLeverage,
                        Exchange.Curve(
                            m.rateMultiplier, m.positionMultiplier, m.tick, LISTING_BUST_BUFFER, m.depth
                        ),
                        MAX_KEEP_BPS,
                        MAX_CONF_BPS,
                        m.maxNotional,
                        m.cap,
                        m.cap
                    );
            }
        }

        if (operator != address(0)) d.exchange.setOperator(operator, true);
        // A second operator wallet, funded separately: the relayer sends from it when the first one
        // runs out of gas, so trading never stops on an empty wallet.
        if (backupOperator != address(0)) d.exchange.setOperator(backupOperator, true);
        if (guardian != address(0)) d.exchange.setGuardian(guardian);
        if (float != 0) {
            (bool sent,) = d.oracle.call{value: float}("");
            require(sent, "oracle float");
        }
        // Two-step: the new owner has to call acceptOwnership().
        if (owner != deployer) d.exchange.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("Exchange  ", address(d.exchange));
        console2.log(signed ? "SignedOracle" : "PythOracle  ", d.oracle);
        if (signed) console2.log("Price signer", priceSigner);
        console2.log("Pricing   ", address(d.pricing));
        console2.log("Sessions  ", address(d.sessions));
        console2.log("Lens      ", address(d.lens));
        console2.log("Gateway   ", address(d.gateway));
        console2.log("Batcher   ", address(d.batcher));

        // A dry run must not leave a deployment file behind: the addresses in it would not exist.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return d;

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeString(json, "name", name);
        vm.serializeAddress(json, "usdc", usdc);
        // What the relayer goes by: which kind of update the oracle takes, and who signs it.
        vm.serializeString(json, "oracleKind", signed ? "signed" : "pyth");
        if (signed) vm.serializeAddress(json, "priceSigner", priceSigner);
        else vm.serializeAddress(json, "pyth", pyth);
        vm.serializeAddress(json, "exchange", address(d.exchange));
        vm.serializeAddress(json, "oracle", d.oracle);
        vm.serializeAddress(json, "pricing", address(d.pricing));
        vm.serializeAddress(json, "sessions", address(d.sessions));
        vm.serializeAddress(json, "lens", address(d.lens));
        vm.serializeAddress(json, "batcher", address(d.batcher));
        string memory out = vm.serializeAddress(json, "gateway", address(d.gateway));
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
