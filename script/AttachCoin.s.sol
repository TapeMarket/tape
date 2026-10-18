// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Exchange} from "../src/Exchange.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {Coin} from "../src/Coin.sol";
import {LaunchCoin} from "../src/LaunchCoin.sol";
import {FeeHook} from "../src/periphery/FeeHook.sol";
import {HookMiner} from "./HookMiner.sol";
import {Staking} from "../src/Staking.sol";
import {Jackpot} from "../src/Jackpot.sol";
import {LossMining} from "../src/LossMining.sol";
import {Sweeper} from "../src/periphery/Sweeper.sol";
import {SignedSweeper} from "../src/periphery/SignedSweeper.sol";
import {SignedOracle} from "../src/SignedOracle.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {ILossMining} from "../src/interfaces/IHooks.sol";
import {Deployable} from "./Deployable.sol";

/// @notice Gives the exchange its coin. Run by the Exchange owner, once. It cannot be undone.
/// @dev Three ways to get the coin:
///
///      A. Launch it somewhere first (a launchpad, a pool of your own), then pass its address as
///         COIN. Nothing is minted here. RESERVE of it is taken from the deployer and sent to loss
///         mining before the coin is attached, so the deployer has to hold that much.
///
///      B. Leave COIN unset and this script deploys a plain fixed-supply ERC-20. RESERVE of it goes
///         to loss mining and the rest to COIN_RECIPIENT, ready to be paired into a pool.
///
///      C. Leave COIN unset and set LAUNCH_COIN=true: this script deploys a LaunchCoin, the coin
///         that opens its own Uniswap v4 pool and locks the liquidity in UNCX's locker as it does.
///         RESERVE of it (20% of the supply unless set) goes to loss mining; the rest stays
///         inside the coin until its owner (the deployer) calls `launch`, which is the launch
///         transaction and not part of this script.
///         While its wallet limit is on, loss mining and staking are outside it: they hold coin
///         for many people. The deployer is not.
///
///        EXCHANGE         the deployed Exchange                              required
///        COIN             existing coin (route A)                            unset = route B
///        COIN_NAME        route B: token name                                "Tape"
///        COIN_SYMBOL      route B: ticker                                    "TAPE"
///        EXPECTED_COIN    optional predicted route C address; a mismatch stops simulation
///        COIN_SUPPLY      route B: whole supply, 18 decimals                 1,000,000,000
///        RESERVE          coin sent to loss mining, in the coin's units      B/C: 20% of COIN_SUPPLY
///                                                                            A: required
///        COIN_RECIPIENT   route B: receives the rest                         the deployer
///        LAUNCH_COIN      route C: deploy a LaunchCoin                       false
///        MAX_WALLET_BPS   route C: wallet limit, basis points of supply      200 (2%), 0 = none
///        FEE_HOOK         route C: also deploy the pool's fee hook           true
///        HOOK_RECIPIENT   route C: who the hook's 1% of every trade is for    the deployer
///        MINING_SCALE     cumulative losses that emit half the reserve,      5,000,000
///                         in USDC units: 6 decimals, so $5M is 5000000000000
///
///      The script stops, before anything is sent, if
///        - the caller is not the Exchange's owner, or a coin is already attached;
///        - COIN is not a contract;
///        - MINING_SCALE is under $1,000 (almost certainly dollars typed without the 6 decimals);
///        - loss mining would start with no coin. From the moment the coin is attached every loss
///          moves along the emission curve, paid or not, so the reserve has to be there first;
///        - paying a loser in this coin does not fit in the gas the Exchange gives it. A coin whose
///          transfer is that expensive (taxes, hooks) would attach and then mine nothing, silently.
///
///      Like the exchange itself, these are created from deployable/ (see script/Deployable.sol):
///
///      node tools/deployable.mjs --forge
///      forge script script/AttachCoin.s.sol --rpc-url $RPC --broadcast --account <keystore>
contract AttachCoin is Script {
    /// @dev Exchange.MINING_GAS, which is private: the gas the Exchange gives the mining hook.
    uint256 internal constant MINING_GAS = 150_000;
    /// @dev Uniswap v4's PoolManager on Ethereum mainnet: what the launch coin has built in.
    address internal constant UNISWAP_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant GAS_PROBE = address(uint160(uint256(keccak256("loss mining gas probe"))));

    /// @dev Route C: the fee hook the coin's pool is opened with, deployed where Uniswap will read
    ///      the right permissions off its address. Zero if none was asked for.
    address public feeHook;

    /// @dev The sweeper marks the book with the prices the Exchange itself trades at, so which
    ///      sweeper it is follows the Exchange's oracle: only a PythOracle answers `pyth()`.
    function _sweeper(Exchange exchange) private returns (Sweeper sweeper) {
        address oracle = address(exchange.oracle());
        (bool isPyth, bytes memory answer) = oracle.staticcall(abi.encodeWithSignature("pyth()"));
        if (isPyth && answer.length == 32) {
            IPyth pyth = abi.decode(answer, (IPyth));
            sweeper = Sweeper(Deployable.create("Sweeper", abi.encode(exchange, pyth)));
            require(sweeper.pyth() == pyth, "the sweeper was not built with the arguments given");
        } else {
            require(
                SignedOracle(oracle).exchange() == address(exchange),
                "the Exchange's oracle is of no known kind"
            );
            sweeper = Sweeper(Deployable.create("SignedSweeper", abi.encode(exchange)));
            require(
                address(SignedSweeper(address(sweeper)).oracle()) == oracle,
                "the sweeper was not built with the arguments given"
            );
        }
    }

    function run() external returns (address coin, Staking staking, LossMining mining, Sweeper sweeper) {
        Exchange exchange = Exchange(vm.envAddress("EXCHANGE"));
        coin = vm.envOr("COIN", address(0));
        uint256 scale = vm.envOr("MINING_SCALE", uint256(5_000_000e6));
        require(scale >= 1_000e6, "MINING_SCALE is in USDC units (6 decimals): $5M is 5000000000000");
        require(exchange.staking() == address(0), "a coin is already attached");

        Deployable.requireReady();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        require(exchange.owner() == deployer, "only the Exchange owner can attach the coin");

        uint256 reserve;
        bool fresh = coin == address(0);
        bool launchCoin = fresh && vm.envOr("LAUNCH_COIN", false);
        if (launchCoin) {
            // The hook first: it needs nothing from the coin, and if its deployment were to fail
            // nothing else would have been sent yet.
            if (vm.envOr("FEE_HOOK", true)) feeHook = _feeHook(deployer);
            // One fifth of the fixed supply is reserved for traders' loss rewards.
            reserve = vm.envOr("RESERVE", vm.envOr("COIN_SUPPLY", uint256(1_000_000_000e18)) / 5);
            coin = _launchCoin(deployer, reserve);
            require(
                feeHook == address(0)
                    || address(FeeHook(feeHook).poolManager()) == LaunchCoin(coin).POOL_MANAGER(),
                "the fee hook and the coin do not agree on Uniswap's PoolManager"
            );
        } else if (fresh) {
            uint256 supply = vm.envOr("COIN_SUPPLY", uint256(1_000_000_000e18));
            reserve = vm.envOr("RESERVE", supply / 5);
            require(reserve != 0 && reserve <= supply, "RESERVE must be between 1 and the supply");
            string memory coinName = vm.envOr("COIN_NAME", string("Tape"));
            string memory coinSymbol = vm.envOr("COIN_SYMBOL", string("TAPE"));
            coin = Deployable.create("Coin", abi.encode(coinName, coinSymbol, supply, deployer));
            // Constructor arguments are handed over as bytes, so nothing but this checks them.
            require(
                keccak256(bytes(Coin(coin).name())) == keccak256(bytes(coinName))
                    && keccak256(bytes(Coin(coin).symbol())) == keccak256(bytes(coinSymbol))
                    && Coin(coin).totalSupply() == supply && Coin(coin).balanceOf(deployer) == supply,
                "the coin was not built with the arguments given"
            );
        } else {
            require(coin.code.length != 0, "COIN is not a contract");
            reserve = vm.envUint("RESERVE");
            require(reserve != 0, "RESERVE is zero");
            require(IERC20(coin).balanceOf(deployer) >= reserve, "the deployer does not hold RESERVE of COIN");
        }

        staking = Staking(Deployable.create("Staking", abi.encode(coin, exchange.usdc(), exchange)));
        // The Rekt Jackpot: every loss is tickets, an hour's tickets are drawn for the pot, and the pot
        // is filled with JACKPOT_BPS of the team's half of the fees through a FeeSplitter that
        // becomes the Exchange's dev recipient. JACKPOT=false attaches the coin without one.
        address jackpot;
        if (vm.envOr("JACKPOT", true)) {
            uint64 hour = uint64(block.timestamp - (block.timestamp % 3600));
            jackpot =
                Deployable.create("Jackpot", abi.encode(exchange.usdc(), hour, uint64(3600), uint16(10_000)));
        }
        mining = LossMining(Deployable.create("LossMining", abi.encode(coin, exchange, scale, jackpot)));
        if (jackpot != address(0)) {
            Jackpot(jackpot).bind(address(mining));
            uint256 shareInput = vm.envOr("JACKPOT_BPS", uint256(3_000));
            require(shareInput <= 10_000, "JACKPOT_BPS is 0 to 10000");
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 share = uint16(shareInput);
            address splitter = Deployable.create(
                "FeeSplitter", abi.encode(exchange.usdc(), jackpot, exchange.devRecipient(), share)
            );
            exchange.setDevRecipient(splitter);
            console2.log("Jackpot   ", jackpot);
            console2.log("FeeSplitter", splitter);
        }
        sweeper = _sweeper(exchange);
        require(
            address(staking.coin()) == coin && staking.usdc() == exchange.usdc()
                && staking.exchange() == address(exchange) && address(mining.coin()) == coin
                && mining.exchange() == address(exchange) && mining.scaleUsd() == scale
                && sweeper.exchange() == exchange,
            "staking, loss mining or the sweeper was not built with the arguments given"
        );

        // A launch coin limits what one wallet may hold. Loss mining holds the whole reserve and
        // staking holds every staker's coin, so both go outside the limit, which its owner can
        // only do before the pool is open.
        if (launchCoin) {
            LaunchCoin(coin).setExempt(address(mining));
            LaunchCoin(coin).setExempt(address(staking));
        }

        require(IERC20(coin).transfer(address(mining), reserve), "reserve transfer");
        // A coin that takes a cut on transfer may deliver less; it must deliver something.
        require(IERC20(coin).balanceOf(address(mining)) != 0, "loss mining received no coin");

        // Whatever of a freshly made plain coin is not the mining reserve goes to its recipient.
        // A launch coin keeps the rest inside itself for its pool, and an existing coin is left
        // where it is.
        if (fresh && !launchCoin) {
            address recipient = vm.envOr("COIN_RECIPIENT", deployer);
            uint256 rest = IERC20(coin).balanceOf(deployer);
            if (recipient != deployer && rest != 0) {
                require(IERC20(coin).transfer(recipient, rest), "rest transfer");
            }
        }

        if (launchCoin) {
            // Do this AFTER every CREATE so the reviewed token address is unchanged. Keep new
            // positions paused until the pool, all launch buys and the backend coin record are
            // verified. Otherwise a settled loss could spend the launch reserve before the LP
            // transaction and invalidate its full-reserve preflight.
            exchange.pauseOpens();
            require(
                exchange.totalCashMargin() == 0 && exchange.debtMarginOpen() == 0,
                "open positions remain: settle them before attaching a launch coin"
            );
        }
        exchange.attachCoin(address(staking), address(mining), address(sweeper));
        vm.stopBroadcast();

        _checkMiningFitsItsGas(exchange, mining, IERC20(coin));

        console2.log("Coin      ", coin);
        console2.log("Staking   ", address(staking));
        console2.log("LossMining", address(mining));
        console2.log("Sweeper   ", address(sweeper));
        if (feeHook != address(0)) console2.log("FeeHook   ", feeHook);

        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return (coin, staking, mining, sweeper);

        string memory json = "coin";
        vm.serializeAddress(json, "coin", coin);
        // The launch tool reads the hook from here. The zero address means the pool has none.
        vm.serializeAddress(json, "hook", feeHook);
        vm.serializeAddress(json, "staking", address(staking));
        vm.serializeAddress(json, "sweeper", address(sweeper));
        vm.serializeAddress(json, "jackpot", mining.jackpot());
        string memory out = vm.serializeAddress(json, "lossMining", address(mining));
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), "-coin.json"));
    }

    /// @dev Route C: the coin that launches its own pool. The deployer is its owner and is minted
    ///      the mining reserve, which `run` moves on to loss mining.
    function _launchCoin(address deployer, uint256 reserve) private returns (address coin) {
        uint256 supply = vm.envOr("COIN_SUPPLY", uint256(1_000_000_000e18));
        uint256 maxWalletBps = vm.envOr("MAX_WALLET_BPS", uint256(200));
        string memory coinName = vm.envOr("COIN_NAME", string("Tape"));
        string memory coinSymbol = vm.envOr("COIN_SYMBOL", string("TAPE"));
        require(reserve != 0 && reserve < supply, "RESERVE must leave something for the pool");
        require(maxWalletBps <= 10_000, "MAX_WALLET_BPS is basis points: 200 is 2%");
        coin = Deployable.create(
            "LaunchCoin", abi.encode(coinName, coinSymbol, supply, reserve, deployer, maxWalletBps, deployer)
        );
        address expectedCoin = vm.envOr("EXPECTED_COIN", address(0));
        require(
            expectedCoin == address(0) || coin == expectedCoin,
            "coin address changed: review deployer nonce and transaction order"
        );
        LaunchCoin made = LaunchCoin(coin);
        // Constructor arguments are handed over as bytes, so nothing but this checks them.
        require(
            keccak256(bytes(made.name())) == keccak256(bytes(coinName))
                && keccak256(bytes(made.symbol())) == keccak256(bytes(coinSymbol))
                && made.totalSupply() == supply && made.balanceOf(deployer) == reserve
                && made.balanceOf(coin) == supply - reserve && made.poolSupply() == supply - reserve
                && made.maxWallet() == supply * maxWalletBps / 10_000 && made.owner() == deployer
                && made.limitsInEffect() == (maxWalletBps != 0) && made.lpTokenId() == 0,
            "the launch coin was not built with the arguments given"
        );
        // Its pool is on Uniswap v4, and its liquidity is locked in UNCX's locker, at fixed
        // addresses. Without them the pool's part of the supply could never leave the coin, and the
        // coin would be attached for good. (All of this runs in the script's simulation first, so a
        // failure here stops it before anything is sent.)
        require(
            made.POOL_MANAGER().code.length != 0 && address(made.POSITION_MANAGER()).code.length != 0
                && made.PERMIT2().code.length != 0 && address(made.LOCKER()).code.length != 0,
            "Uniswap v4 or the liquidity locker is not on this chain at the addresses the launch coin uses"
        );
    }

    /// @dev Route C: the hook that takes 1% of the ETH side of every trade in the coin's pool, for
    ///      `HOOK_RECIPIENT`. It is created with CREATE2 at an address whose low bits say "swap
    ///      callbacks only", which is where Uniswap reads a hook's permissions from.
    function _feeHook(address deployer) private returns (address hook) {
        address recipient = vm.envOr("HOOK_RECIPIENT", deployer);
        // Its fees are sent as plain ETH, and they would be stuck in the hook if that could not arrive.
        require(
            recipient.code.length == 0,
            "HOOK_RECIPIENT has code: use a plain wallet, which can always be paid"
        );
        bytes memory initcode =
            abi.encodePacked(Deployable.code("FeeHook"), abi.encode(UNISWAP_POOL_MANAGER, recipient));
        uint160 permissions = _hookPermissions();
        (bytes32 salt, address expected) = HookMiner.find(initcode, permissions);
        hook = HookMiner.deploy(initcode, salt);
        require(
            hook == expected && uint160(hook) & HookMiner.PERMISSION_BITS == permissions
                && FeeHook(hook).PERMISSIONS() == permissions && FeeHook(hook).feeRecipient() == recipient
                && address(FeeHook(hook).poolManager()) == UNISWAP_POOL_MANAGER
                && FeeHook(hook).FEE_PIPS() == 10_000,
            "the fee hook was not built as asked, or is not where its permissions need it"
        );
    }

    /// @dev beforeSwap, afterSwap, and each one's right to change the amounts: FeeHook.PERMISSIONS.
    function _hookPermissions() private pure returns (uint160) {
        return (1 << 7) | (1 << 6) | (1 << 3) | (1 << 2);
    }

    /// @dev Pays a $1,000 loss to an address that has never held the coin, exactly as the Exchange
    ///      would, and takes it back. Runs in the script's own simulation only: a failure here
    ///      stops the script before a single transaction is sent.
    function _checkMiningFitsItsGas(Exchange exchange, LossMining mining, IERC20 coin) private {
        uint256 snapshot = vm.snapshotState();
        vm.prank(address(exchange));
        (bool ok,) =
            address(mining).call{gas: MINING_GAS}(abi.encodeCall(ILossMining.onLoss, (GAS_PROBE, 1_000e6)));
        bool paid = coin.balanceOf(GAS_PROBE) != 0;
        vm.revertToState(snapshot);
        require(ok && paid, "paying a loser in this coin does not fit in the Exchange's mining gas");
    }
}
