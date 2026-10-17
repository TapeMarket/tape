// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {SignedOracle} from "../src/SignedOracle.sol";
import {Pricing} from "../src/Pricing.sol";
import {Sessions} from "../src/Sessions.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {Coin} from "../src/Coin.sol";
import {Staking} from "../src/Staking.sol";
import {LossMining} from "../src/LossMining.sol";
import {Lens} from "../src/periphery/Lens.sol";
import {Batcher} from "../src/periphery/Batcher.sol";
import {Sweeper} from "../src/periphery/Sweeper.sol";
import {SignedSweeper} from "../src/periphery/SignedSweeper.sol";
import {PerpMath} from "../src/libraries/PerpMath.sol";
import {Gateway} from "../src/periphery/Gateway.sol";
import {MockUSDC, MockPyth} from "./mocks/Mocks.sol";
import {Deployer} from "./Deployer.sol";

/// @dev The suite runs on either price source. By default the Exchange is priced by a SignedOracle,
///      which is what ships; `ORACLE=pyth forge test` runs it on the Pyth adapter over MockPyth.
///      Tests build every price through `_update` / `_updateFull`, which make whichever kind of
///      update the oracle in use takes. Tests of one source's own behaviour carry `pythOnly` or
///      `signedOnly`.
abstract contract Base is Deployer {
    uint64 internal constant T0 = 1_800_000_000;
    bytes32 internal constant BTC_FEED = keccak256("BTC/USD");
    bytes32 internal constant ETH_FEED = keccak256("ETH/USD");

    // Launch parameters: the reference exchange's own, as its contract holds them.
    uint32 internal constant RATE = 15_000;
    uint32 internal constant BTC_POSITION = 814_598;
    uint32 internal constant ETH_POSITION = 483_979;
    /// @dev One price tick in 1e8 terms: a dime for BTC, a cent for ETH.
    uint32 internal constant BTC_TICK = 1e7;
    uint32 internal constant ETH_TICK = 1e6;
    uint64 internal constant BTC_BUFFER = 476041580087574;
    uint64 internal constant ETH_BUFFER = 481304050180130;
    uint16 internal constant MAX_KEEP = 9_000;
    /// @dev What the impact curve is charged on while a side is no fuller than its depth.
    uint256 internal constant REFERENCE = 100_000;
    /// @dev A depth no test's open interest reaches ($4.29B a side), so every position is priced
    ///      as the reference prices it. The tests of size itself set a real one (test/Depth.t.sol).
    uint32 internal constant BOTTOMLESS = type(uint32).max;

    uint256 internal constant STAKER_CAP = 5_000_000e6;
    uint96 internal constant MIN_MARGIN = 1e6;
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant RESERVE = 200_000_000e18;
    uint256 internal constant MINING_SCALE = 5_000_000e6;

    bytes32 internal constant OPEN_TYPEHASH = keccak256(
        "Open(address owner,uint16 market,bool isLong,bool useQueued,uint16 leverage,uint96 margin,uint64 priceLimit,uint32 impactLimit,uint64 timestamp,uint64 salt)"
    );
    bytes32 internal constant CLOSE_TYPEHASH =
        keccak256("Close(address owner,bytes32 positionId,uint64 timestamp)");
    bytes32 internal constant SESSION_TYPEHASH =
        keccak256("SessionKey(address owner,address key,uint64 validUntil,uint256 nonce)");
    bytes32 internal constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address owner,address to,uint256 amount,uint256 nonce,uint64 deadline)");

    MockUSDC internal usdc;
    MockPyth internal pyth;
    /// @dev The Exchange's oracle, whichever kind it is. Only the two IOracle calls work on both.
    PythOracle internal oracle;
    /// @dev The same address as `oracle` when the suite runs on signed prices.
    SignedOracle internal prices;
    bool internal signed;
    uint256 internal priceSignerPk = 0x51C4ED;
    address internal priceSigner = vm.addr(priceSignerPk);
    Pricing internal pricing;
    Sessions internal sessions;
    Exchange internal ex;
    Lens internal lens;
    Batcher internal batcher;
    Sweeper internal sweeper;
    Gateway internal gateway;
    Coin internal coin;
    Staking internal staking;
    LossMining internal mining;

    address internal admin = makeAddr("admin");
    address internal dev = makeAddr("dev");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");

    uint256 internal alicePk = 0xA11CE;
    uint256 internal bobPk = 0xB0B;
    uint256 internal carolPk = 0xCA201;
    address internal alice = vm.addr(alicePk);
    address internal bob = vm.addr(bobPk);
    address internal carol = vm.addr(carolPk);

    uint16 internal btc;
    uint16 internal eth;
    uint64 internal salt;

    modifier pythOnly() {
        if (signed) {
            vm.skip(true);
            return;
        }
        _;
    }

    modifier signedOnly() {
        if (!signed) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// @dev Which price source the suite runs on. A test contract about one of them overrides this.
    function _useSigned() internal view virtual returns (bool) {
        return keccak256(bytes(vm.envOr("ORACLE", string("signed")))) != keccak256("pyth");
    }

    function setUp() public virtual {
        vm.warp(T0);
        signed = _useSigned();
        usdc = new MockUSDC();
        pyth = new MockPyth();

        // Every contract of the protocol goes through `_deployed`, so the suite can be run on the
        // bytecode that ships (see Deployer).
        sessions = Sessions(_deployed("Sessions", type(Sessions).creationCode, abi.encode("TAPE")));
        pricing = Pricing(_deployed("Pricing", type(Pricing).creationCode, ""));

        // The oracle and the Exchange point at each other, so the Exchange address is predicted.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        if (signed) {
            prices = SignedOracle(
                _deployed("SignedOracle", type(SignedOracle).creationCode, abi.encode(predicted, priceSigner))
            );
            oracle = PythOracle(payable(address(prices)));
        } else {
            oracle = PythOracle(
                payable(_deployed("PythOracle", type(PythOracle).creationCode, abi.encode(pyth, predicted)))
            );
        }
        ex = Exchange(
            _deployed(
                "Exchange",
                type(Exchange).creationCode,
                abi.encode("TAPE", usdc, oracle, pricing, sessions, admin, dev, STAKER_CAP, MIN_MARGIN)
            )
        );
        assertEq(address(ex), predicted, "exchange address prediction");
        vm.deal(address(oracle), 1 ether);

        lens = Lens(_deployed("Lens", type(Lens).creationCode, abi.encode(ex)));
        gateway = Gateway(_deployed("Gateway", type(Gateway).creationCode, abi.encode(usdc, ex)));

        vm.startPrank(admin);
        ex.setOperator(operator, true);
        ex.setGuardian(guardian);
        btc = ex.listMarket(BTC_FEED, "BTC", 1_000, _btcCurve(), MAX_KEEP, 50, 10_000_000e6, 1e15, 1e15);
        eth = ex.listMarket(ETH_FEED, "ETH", 1_000, _ethCurve(), MAX_KEEP, 50, 10_000_000e6, 1e15, 1e15);
        // The relayer batches its calls through the Batcher, which is therefore an operator too.
        batcher = Batcher(_deployed("Batcher", type(Batcher).creationCode, abi.encode(ex)));
        ex.setOperator(address(batcher), true);
        vm.stopPrank();
    }

    // --------------------------------------------------------------------------------------
    // Setup helpers
    // --------------------------------------------------------------------------------------

    function _attachCoin() internal {
        coin = Coin(
            _deployed("Coin", type(Coin).creationCode, abi.encode("Tape", "TAPE", SUPPLY, address(this)))
        );
        staking = Staking(_deployed("Staking", type(Staking).creationCode, abi.encode(coin, usdc, ex)));
        mining = LossMining(
            _deployed("LossMining", type(LossMining).creationCode, abi.encode(coin, ex, MINING_SCALE, address(0)))
        );
        sweeper = _deployedSweeper();
        coin.transfer(address(mining), RESERVE);
        vm.startPrank(admin);
        ex.attachCoin(address(staking), address(mining), address(sweeper));
        // The sweep is an operator's call. The tests sweep as themselves.
        ex.setOperator(address(this), true);
        vm.stopPrank();
    }

    /// @dev The sweeper of `ex` for the oracle in use, through `_deployed` like the rest. Both kinds
    ///      answer the same calls; only the Pyth one has `pyth()`.
    function _deployedSweeper() internal returns (Sweeper) {
        return signed
            ? Sweeper(_deployed("SignedSweeper", type(SignedSweeper).creationCode, abi.encode(ex)))
            : Sweeper(_deployed("Sweeper", type(Sweeper).creationCode, abi.encode(ex, pyth)));
    }

    /// @dev A sweeper of `exchange` for the oracle in use, built from the project's own code.
    function _newSweeper(Exchange exchange) internal returns (Sweeper) {
        return signed
            ? Sweeper(address(new SignedSweeper(exchange)))
            : new Sweeper(exchange, IPyth(address(pyth)));
    }

    /// @dev An oracle of the kind in use for an Exchange that will be created at `exchange`.
    function _newOracle(address exchange) internal returns (PythOracle) {
        if (!signed) return new PythOracle(IPyth(address(pyth)), exchange);
        prices = new SignedOracle(exchange, priceSigner);
        return PythOracle(payable(address(prices)));
    }

    // --------------------------------------------------------------------------------------
    // The markets' pricing parameters, and the library called with them
    // --------------------------------------------------------------------------------------

    function _btcCurve() internal pure returns (Exchange.Curve memory) {
        return Exchange.Curve(RATE, BTC_POSITION, BTC_TICK, BTC_BUFFER, BOTTOMLESS);
    }

    function _ethCurve() internal pure returns (Exchange.Curve memory) {
        return Exchange.Curve(RATE, ETH_POSITION, ETH_TICK, ETH_BUFFER, BOTTOMLESS);
    }

    function _btcSettle(uint256 entry, uint256 exit, uint256 notional, bool isLong)
        internal
        pure
        returns (bool win, uint256 amount)
    {
        return
            PerpMath.settle(entry, exit, notional, isLong, REFERENCE, RATE, BTC_POSITION, MAX_KEEP, BTC_TICK);
    }

    function _ethSettle(uint256 entry, uint256 exit, uint256 notional, bool isLong)
        internal
        pure
        returns (bool win, uint256 amount)
    {
        return
            PerpMath.settle(entry, exit, notional, isLong, REFERENCE, RATE, ETH_POSITION, MAX_KEEP, ETH_TICK);
    }

    function _btcBust(uint256 entry, uint256 leverage, bool isLong) internal pure returns (uint256) {
        return PerpMath.bustPrice(entry, leverage, isLong, BTC_TICK, BTC_BUFFER);
    }

    function _ethBust(uint256 entry, uint256 leverage, bool isLong) internal pure returns (uint256) {
        return PerpMath.bustPrice(entry, leverage, isLong, ETH_TICK, ETH_BUFFER);
    }

    /// @dev What closing `p` at `exit` is worth before the win fee, from its own market's
    ///      parameters and the size it was charged on when it opened.
    function _settleOf(Exchange.Position memory p, uint256 exit)
        internal
        view
        returns (bool win, uint256 amount)
    {
        Exchange.Market memory m = ex.getMarket(p.market);
        return PerpMath.settle(
            p.entryPrice,
            exit,
            uint256(p.margin) * p.leverage,
            p.isLong,
            p.impactNotional,
            m.rateMultiplier,
            m.positionMultiplier,
            m.maxKeepBps,
            m.tick
        );
    }

    /// @dev The bust price of an open position, from its own market's parameters.
    function _bustOf(bytes32 id) internal view returns (uint256) {
        Exchange.Position memory p = ex.getPosition(id);
        Exchange.Market memory m = ex.getMarket(p.market);
        return PerpMath.bustPrice(p.entryPrice, p.leverage, p.isLong, m.tick, m.bustBuffer);
    }

    /// @dev Sweeps house cash above the cap to stakers, marking the book at the given prices.
    function _sweep(uint64 btcPrice, uint64 ethPrice) internal returns (uint256) {
        bytes[] memory updates = new bytes[](2);
        uint64 nowTime = uint64(vm.getBlockTimestamp());
        updates[0] = _update(BTC_FEED, btcPrice, nowTime)[0];
        updates[1] = _update(ETH_FEED, ethPrice, nowTime)[0];
        return sweeper.sweep{value: _fee(2)}(updates);
    }

    function _fund(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(ex), amount);
        ex.deposit(amount);
        vm.stopPrank();
    }

    /// @dev Puts cash in the house without anyone being owed anything.
    function _seedHouse(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(ex), amount);
        ex.donate(amount);
    }

    // --------------------------------------------------------------------------------------
    // Prices
    // --------------------------------------------------------------------------------------

    function _px(uint256 dollars) internal pure returns (uint64) {
        return uint64(dollars * 1e8);
    }

    function _feed(uint16 market) internal view returns (bytes32) {
        return market == btc ? BTC_FEED : ETH_FEED;
    }

    /// @dev One price update for `feed` at `time`, whose previous publish was the second before.
    function _update(bytes32 feed, uint64 price, uint64 time) internal view returns (bytes[] memory update) {
        return _updateFull(feed, price, price / 100_000, time, time - 1);
    }

    function _updateFull(bytes32 feed, uint64 price, uint64 conf, uint64 time, uint64 prev)
        internal
        view
        returns (bytes[] memory update)
    {
        update = new bytes[](1);
        update[0] = signed
            ? _print(priceSignerPk, feed, price, conf, time, prev)
            : abi.encode(feed, int64(price), conf, int32(-8), time, prev);
    }

    /// @dev A print as the SignedOracle takes it, signed by `pk`.
    function _print(uint256 pk, bytes32 feed, uint64 price, uint64 conf, uint64 time, uint64 prev)
        internal
        view
        returns (bytes memory)
    {
        return _printFor(address(prices), pk, feed, price, conf, time, prev);
    }

    /// @dev The same for any SignedOracle. The EIP-712 hash is worked out here from the standard
    ///      and not asked of the contract: that checks the contract's own, and it keeps this free
    ///      of calls, so a test can build a price between `vm.prank` / `vm.expectRevert` and the
    ///      call they are for.
    function _printFor(
        address signedOracle,
        uint256 pk,
        bytes32 feed,
        uint64 price,
        uint64 conf,
        uint64 time,
        uint64 prev
    ) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SignedOracle"),
                keccak256("1"),
                block.chainid,
                signedOracle
            )
        );
        bytes32 print = keccak256(
            abi.encode(
                keccak256(
                    "Print(bytes32 feedId,uint64 price,uint64 conf,uint64 publishTime,uint64 prevPublishTime)"
                ),
                feed,
                price,
                conf,
                time,
                prev
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, print)));
        return abi.encode(feed, price, conf, time, prev, v, r, s);
    }

    /// @dev What the oracle in use says when an update holds no price for the feed and window asked.
    function _noPrice() internal view returns (bytes4) {
        return signed ? SignedOracle.NoPriceInWindow.selector : MockPyth.PriceFeedNotFoundWithinRange.selector;
    }

    /// @dev Pyth charges a fee for each update it reads; signed prices cost nothing.
    function _fee(uint256 updates) internal view returns (uint256) {
        return signed ? 0 : updates;
    }

    // --------------------------------------------------------------------------------------
    // Signing
    // --------------------------------------------------------------------------------------

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", ex.domainSeparator(), structHash));
    }

    /// @dev Session registrations are signed against the Sessions contract's own domain.
    function _sessionDigest(address owner, address key, uint64 validUntil) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(SESSION_TYPEHASH, owner, key, validUntil, sessions.nonces(owner)));
        return keccak256(abi.encodePacked("\x19\x01", sessions.domainSeparator(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _hashOpen(Intents.OpenIntent memory it) internal view returns (bytes32) {
        return _digest(
            keccak256(
                abi.encode(
                    OPEN_TYPEHASH,
                    it.owner,
                    it.market,
                    it.isLong,
                    it.useQueued,
                    it.leverage,
                    it.margin,
                    it.priceLimit,
                    it.impactLimit,
                    it.timestamp,
                    it.salt
                )
            )
        );
    }

    function _hashClose(Intents.CloseIntent memory it) internal view returns (bytes32) {
        return _digest(keccak256(abi.encode(CLOSE_TYPEHASH, it.owner, it.positionId, it.timestamp)));
    }

    function _intent(address owner, uint16 market, bool isLong, uint96 margin, uint16 leverage)
        internal
        returns (Intents.OpenIntent memory)
    {
        return Intents.OpenIntent({
            owner: owner,
            market: market,
            isLong: isLong,
            useQueued: false,
            leverage: leverage,
            margin: margin,
            priceLimit: 0,
            impactLimit: 0,
            timestamp: uint64(vm.getBlockTimestamp()),
            salt: ++salt
        });
    }

    // --------------------------------------------------------------------------------------
    // Trading helpers. Each one signs for "now", lets a block pass, and has the operator submit.
    // --------------------------------------------------------------------------------------

    function _submitOpen(uint256 pk, Intents.OpenIntent memory it, uint64 price)
        internal
        returns (bytes32 id)
    {
        bytes memory sig = _sign(pk, _hashOpen(it));
        bytes[] memory update = _update(_feed(it.market), price, it.timestamp + ex.EXEC_DELAY());
        skip(12);
        vm.prank(operator);
        id = ex.open(it, sig, update);
    }

    function _open(uint256 pk, uint16 market, bool isLong, uint96 margin, uint16 leverage, uint64 price)
        internal
        returns (bytes32)
    {
        return _submitOpen(pk, _intent(vm.addr(pk), market, isLong, margin, leverage), price);
    }

    function _openQueued(uint256 pk, uint16 market, bool isLong, uint96 margin, uint16 leverage, uint64 price)
        internal
        returns (bytes32)
    {
        Intents.OpenIntent memory it = _intent(vm.addr(pk), market, isLong, margin, leverage);
        it.useQueued = true;
        return _submitOpen(pk, it, price);
    }

    function _close(uint256 pk, bytes32 id, uint64 price) internal {
        Exchange.Position memory p = ex.getPosition(id);
        Intents.CloseIntent memory it =
            Intents.CloseIntent({owner: p.owner, positionId: id, timestamp: uint64(vm.getBlockTimestamp())});
        bytes memory sig = _sign(pk, _hashClose(it));
        bytes[] memory update = _update(_feed(p.market), price, it.timestamp + ex.EXEC_DELAY());
        skip(12);
        vm.prank(operator);
        ex.close(it, sig, update);
    }

    /// @dev Operator liquidation, proving `price` printed one second ago.
    function _liquidate(bytes32 id, uint64 price) internal {
        Exchange.Position memory p = ex.getPosition(id);
        skip(12);
        bytes[] memory update = _update(_feed(p.market), price, uint64(vm.getBlockTimestamp()) - 1);
        vm.prank(operator);
        ex.liquidate(id, update);
    }

    // --------------------------------------------------------------------------------------
    // Assertions
    // --------------------------------------------------------------------------------------

    /// @dev The accounting identity everything else rests on.
    function _assertSolvent() internal view {
        assertGe(usdc.balanceOf(address(ex)), ex.treasury(), "holds less USDC than it accounts for");
        assertGe(
            ex.treasury(),
            ex.totalBalances() + ex.totalCashMargin() + ex.stakerFees() + ex.devFees(),
            "liabilities exceed treasury"
        );
    }
}
