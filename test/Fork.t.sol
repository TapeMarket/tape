// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {Pricing} from "../src/Pricing.sol";
import {Sessions} from "../src/Sessions.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {PerpMath} from "../src/libraries/PerpMath.sol";
import {Lens} from "../src/periphery/Lens.sol";
import {Gateway} from "../src/periphery/Gateway.sol";
import {Deployer} from "./Deployer.sol";

interface IUSDC is IERC20 {
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @dev Runs the protocol on a fork of Ethereum mainnet against the real Pyth contract and the real
///      USDC, using guardian-signed price updates lifted from public mainnet transactions
///      (tools/fetch-onchain-fixture.mjs). Nothing is mocked.
///
///      Pyth's guardian set rotates and an old update only verifies in its own era, so each test
///      forks at the block of the update it replays. That needs an archive RPC
///      (ETH_ARCHIVE_RPC_URL, default a public one).
///
///          FORK=true forge test --match-contract ForkTest -vv
contract ForkTest is Deployer {
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant PYTH = 0x4305FB66699C3B2702D4d05CF36551390A4c69C6;
    bytes32 internal constant BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes4 internal constant NOT_IN_RANGE = bytes4(keccak256("PriceFeedNotFoundWithinRange()"));

    // The launch parameters: the reference exchange's own.
    uint32 internal constant RATE = 15_000;
    uint32 internal constant BTC_POSITION = 814_598;
    uint32 internal constant ETH_POSITION = 483_979;
    uint32 internal constant BTC_TICK = 1e7;
    uint32 internal constant ETH_TICK = 1e6;
    uint64 internal constant BTC_BUFFER = 476041580087574;
    uint64 internal constant ETH_BUFFER = 481304050180130;
    /// @dev The launch depth: what may be open on a side at the reference price, in dollars.
    uint32 internal constant DEPTH = 1_000_000;

    bytes32 internal constant OPEN_TYPEHASH = keccak256(
        "Open(address owner,uint16 market,bool isLong,bool useQueued,uint16 leverage,uint96 margin,uint64 priceLimit,uint32 impactLimit,uint64 timestamp,uint64 salt)"
    );
    bytes32 internal constant CLOSE_TYPEHASH =
        keccak256("Close(address owner,bytes32 positionId,uint64 timestamp)");

    struct Print {
        bytes32 feed;
        uint64 time;
        uint64 prev;
        uint64 price;
        uint256 blockNumber;
        uint256 guardianSet;
        bytes update;
    }

    Exchange internal ex;
    PythOracle internal oracle;
    Lens internal lens;
    Gateway internal gateway;
    Print[] internal prints;

    address internal operator = makeAddr("operator");
    uint256 internal alicePk = 0xA11CE;
    address internal alice = vm.addr(alicePk);
    uint64 internal salt;

    function setUp() public {
        if (!vm.envOr("FORK", false)) return;
        string memory json = vm.readFile("test/fixtures/pyth-onchain.json");
        for (uint256 i; vm.keyExistsJson(json, string.concat(".updates[", vm.toString(i), "]")); ++i) {
            string memory at = string.concat(".updates[", vm.toString(i), "]");
            assertEq(
                vm.parseJsonInt(json, string.concat(at, ".expo")), -8, "fixture prices are expected at 1e8"
            );
            prints.push(
                Print({
                    feed: vm.parseJsonBytes32(json, string.concat(at, ".feed")),
                    time: uint64(vm.parseJsonUint(json, string.concat(at, ".time"))),
                    prev: uint64(vm.parseJsonUint(json, string.concat(at, ".prev"))),
                    price: uint64(vm.parseUint(vm.parseJsonString(json, string.concat(at, ".price")))),
                    blockNumber: vm.parseJsonUint(json, string.concat(at, ".block")),
                    guardianSet: vm.parseJsonUint(json, string.concat(at, ".guardianSet")),
                    update: vm.parseJsonBytes(json, string.concat(at, ".update"))
                })
            );
        }
    }

    modifier onFork() {
        if (!vm.envOr("FORK", false)) {
            vm.skip(true);
        }
        _;
    }

    // --------------------------------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------------------------------

    /// @dev Forks mainnet at `blockNumber` (zero for the latest block) and deploys the protocol on it.
    function _boot(uint256 blockNumber) internal {
        string memory rpc = vm.envOr("ETH_ARCHIVE_RPC_URL", string("https://eth.drpc.org"));
        if (blockNumber == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blockNumber);

        Sessions sessions = Sessions(_deployed("Sessions", type(Sessions).creationCode, abi.encode("TAPE")));
        Pricing pricing = Pricing(_deployed("Pricing", type(Pricing).creationCode, ""));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        oracle = PythOracle(
            payable(_deployed("PythOracle", type(PythOracle).creationCode, abi.encode(PYTH, predicted)))
        );
        ex = Exchange(
            _deployed(
                "Exchange",
                type(Exchange).creationCode,
                abi.encode(
                    "TAPE",
                    USDC,
                    oracle,
                    pricing,
                    sessions,
                    address(this),
                    address(this),
                    uint256(1_000_000e6),
                    uint96(1e6)
                )
            )
        );
        assertEq(address(ex), predicted, "exchange address prediction");
        lens = Lens(_deployed("Lens", type(Lens).creationCode, abi.encode(ex)));
        gateway = Gateway(_deployed("Gateway", type(Gateway).creationCode, abi.encode(USDC, ex)));
        vm.deal(address(oracle), 0.01 ether);

        ex.setOperator(operator, true);
        // Wide confidence limit: the fixture must not be refused on that account.
        ex.listMarket(
            BTC_USD,
            "BTC",
            1_000,
            Exchange.Curve(RATE, BTC_POSITION, BTC_TICK, BTC_BUFFER, DEPTH),
            9_000,
            100,
            10_000_000e6,
            1e15,
            1e15
        );
        ex.listMarket(
            ETH_USD,
            "ETH",
            1_000,
            Exchange.Curve(RATE, ETH_POSITION, ETH_TICK, ETH_BUFFER, DEPTH),
            9_000,
            100,
            10_000_000e6,
            1e15,
            1e15
        );

        deal(USDC, alice, 10_000e6);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(ex), type(uint256).max);
        ex.deposit(5_000e6);
        vm.stopPrank();
    }

    function _market(bytes32 feed) internal pure returns (uint16) {
        return feed == BTC_USD ? 0 : 1;
    }

    /// @dev The bust trigger of a position on `feed`'s market, from the launch parameters.
    function _bust(bytes32 feed, uint256 entry, uint256 leverage, bool isLong)
        internal
        pure
        returns (uint256)
    {
        return feed == BTC_USD
            ? PerpMath.bustPrice(entry, leverage, isLong, BTC_TICK, BTC_BUFFER)
            : PerpMath.bustPrice(entry, leverage, isLong, ETH_TICK, ETH_BUFFER);
    }

    function _wrap(bytes memory update) internal pure returns (bytes[] memory list) {
        list = new bytes[](1);
        list[0] = update;
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", ex.domainSeparator(), structHash));
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signOpen(Intents.OpenIntent memory it) internal view returns (bytes memory) {
        return _sign(
            _digest(
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
            )
        );
    }

    /// @dev Signs an open stamped two seconds before `p` printed and submits it with `p`.
    function _open(Print memory p, bool isLong, uint96 margin, uint16 leverage) internal returns (bytes32) {
        Intents.OpenIntent memory it = Intents.OpenIntent(
            alice, _market(p.feed), isLong, false, leverage, margin, 0, 0, p.time - 2, ++salt
        );
        bytes memory sig = _signOpen(it);
        vm.warp(p.time + 10);
        vm.prank(operator);
        return ex.open(it, sig, _wrap(p.update));
    }

    function _close(bytes32 id, Print memory p) internal {
        Intents.CloseIntent memory it = Intents.CloseIntent(alice, id, p.time - 2);
        bytes memory sig =
            _sign(_digest(keccak256(abi.encode(CLOSE_TYPEHASH, it.owner, it.positionId, it.timestamp))));
        vm.warp(p.time + 10);
        vm.prank(operator);
        ex.close(it, sig, _wrap(p.update));
    }

    function _isFirstOfItsSecond(Print memory p) internal pure returns (bool) {
        return p.prev < p.time;
    }

    /// @dev The first print of `feed` that is the first of its second, at or after index `from`.
    function _firstPinnable(bytes32 feed, uint256 from) internal view returns (uint256) {
        for (uint256 i = from; i < prints.length; ++i) {
            if (prints[i].feed == feed && _isFirstOfItsSecond(prints[i])) return i;
        }
        revert("fixture has no pinnable print for this feed");
    }

    // --------------------------------------------------------------------------------------
    // Tests
    // --------------------------------------------------------------------------------------

    function test_fork_fixtureCoversBothFeeds() public onFork {
        assertGe(prints.length, 4);
        _firstPinnable(BTC_USD, 0);
        _firstPinnable(ETH_USD, 0);
    }

    /// @dev A real signed print becomes the entry price, on both feeds.
    function test_fork_opensAtTheRealPythPrice() public onFork {
        Print memory b = prints[_firstPinnable(BTC_USD, 0)];
        _boot(b.blockNumber);
        // Pyth sets its own fee and changes it; the oracle reads it and pays from its float.
        uint256 fee = IPyth(PYTH).getUpdateFee(_wrap(b.update));
        bytes32 id = _open(b, true, 100e6, 10);
        Exchange.Position memory p = ex.getPosition(id);
        assertEq(p.entryPrice, b.price);
        assertEq(p.openTime, b.time);
        assertGt(p.entryPrice, 10_000e8, "BTC priced in the tens of thousands");
        assertEq(address(oracle).balance, 0.01 ether - fee, "the oracle paid Pyth's fee from its float");
        emit log_named_decimal_uint("Pyth fee (ETH)", fee, 18);

        Print memory e = prints[_firstPinnable(ETH_USD, 0)];
        _boot(e.blockNumber);
        id = _open(e, false, 100e6, 10);
        p = ex.getPosition(id);
        assertEq(p.entryPrice, e.price);
        assertLt(p.entryPrice, 10_000e8, "ETH priced in the thousands");
        emit log_named_decimal_uint("BTC entry", b.price, 8);
        emit log_named_decimal_uint("ETH entry", e.price, 8);
    }

    /// @dev Pyth itself refuses a print that is not the first of its second as a fill.
    function test_fork_refusesAPrintThatIsNotTheFirstOfItsSecond() public onFork {
        uint256 found = type(uint256).max;
        for (uint256 i; i < prints.length; ++i) {
            if (!_isFirstOfItsSecond(prints[i])) {
                found = i;
                break;
            }
        }
        if (found == type(uint256).max) {
            vm.skip(true);
        }
        Print memory p = prints[found];
        _boot(p.blockNumber);

        Intents.OpenIntent memory it =
            Intents.OpenIntent(alice, _market(p.feed), true, false, 10, 100e6, 0, 0, p.time - 2, 1);
        bytes memory sig = _signOpen(it);
        vm.warp(p.time + 10);
        vm.prank(operator);
        vm.expectRevert(NOT_IN_RANGE);
        ex.open(it, sig, _wrap(p.update));

        // The very same print is a valid liquidation proof, where any print in range will do.
        vm.prank(address(ex));
        (uint64 price,, uint64 time) = oracle.within(p.feed, _wrap(p.update), p.time, p.time);
        assertEq(price, p.price);
        assertEq(time, p.time);
    }

    /// @dev Nor one for another feed, one that printed before the pin, or one that was tampered with.
    function test_fork_refusesTheWrongPrint() public onFork {
        Print memory e = prints[_firstPinnable(ETH_USD, 0)];
        _boot(e.blockNumber);
        vm.warp(e.time + 10);

        // BTC intent, ETH update.
        Intents.OpenIntent memory it =
            Intents.OpenIntent(alice, 0, true, false, 10, 100e6, 0, 0, e.time - 2, 1);
        bytes memory sig = _signOpen(it);
        vm.prank(operator);
        vm.expectRevert(NOT_IN_RANGE);
        ex.open(it, sig, _wrap(e.update));

        // ETH intent stamped so that the pin falls one second after the print.
        it = Intents.OpenIntent(alice, 1, true, false, 10, 100e6, 0, 0, e.time - 1, 2);
        sig = _signOpen(it);
        vm.prank(operator);
        vm.expectRevert(NOT_IN_RANGE);
        ex.open(it, sig, _wrap(e.update));

        // One flipped bit in the payload and guardian verification fails.
        it = Intents.OpenIntent(alice, 1, true, false, 10, 100e6, 0, 0, e.time - 2, 3);
        sig = _signOpen(it);
        bytes memory forged = bytes.concat(e.update);
        forged[forged.length - 30] = bytes1(uint8(forged[forged.length - 30]) ^ 0x01);
        vm.prank(operator);
        vm.expectRevert();
        ex.open(it, sig, _wrap(forged));

        // Untouched, it opens.
        vm.prank(operator);
        ex.open(it, sig, _wrap(e.update));
    }

    /// @dev Open on one real print, close on a later one: the payout is exactly what the math says.
    function test_fork_closesBetweenTwoRealPrints() public onFork {
        uint256 i = _firstPinnable(ETH_USD, 0);
        uint256 j = _firstPinnable(ETH_USD, i + 1);
        Print memory a = prints[i];
        Print memory b = prints[j];
        assertEq(a.guardianSet, b.guardianSet, "fixture: the two prints must share a guardian set");
        _boot(b.blockNumber);

        // Seed the house so a win is paid at once.
        deal(USDC, address(this), 100_000e6);
        IERC20(USDC).approve(address(ex), 100_000e6);
        ex.donate(100_000e6);

        uint256 before = ex.balances(alice);
        bytes32 id = _open(a, true, 100e6, 20);
        (bool busted, int256 quoted) = lens.quoteClose(id, b.price);
        _close(id, b);

        (bool win, uint256 amount) =
            PerpMath.settle(a.price, b.price, 2_000e6, true, 100_000, RATE, ETH_POSITION, 9_000, ETH_TICK);
        int256 expected = busted ? -100e6 : win ? int256(amount - (amount * 200) / 10_000) : -int256(amount);
        assertEq(quoted, expected);
        assertEq(int256(ex.balances(alice)) - int256(before), expected);
        assertEq(ex.totalQueued(), 0);
        emit log_named_decimal_uint("entry", a.price, 8);
        emit log_named_decimal_uint("exit ", b.price, 8);
        emit log_named_decimal_int("pnl  ", expected, 6);
    }

    /// @dev A real print past the trigger busts a 1000x position; one short of it does not.
    function test_fork_liquidatesOnARealTouch() public onFork {
        // Find an entry and a later print of the same feed and era at least 5 bps apart.
        for (uint256 i; i < prints.length; ++i) {
            if (!_isFirstOfItsSecond(prints[i])) continue;
            for (uint256 j = i + 1; j < prints.length; ++j) {
                if (prints[j].feed != prints[i].feed || prints[j].guardianSet != prints[i].guardianSet) {
                    continue;
                }
                Print memory a = prints[i];
                Print memory b = prints[j];
                bool longBusts = PerpMath.crossed(b.price, _bust(a.feed, a.price, 1_000, true), true);
                bool shortBusts = PerpMath.crossed(b.price, _bust(a.feed, a.price, 1_000, false), false);
                if (!longBusts && !shortBusts) continue;
                _boot(b.blockNumber);

                bytes32 loser = _open(a, longBusts, 100e6, 1_000);
                bytes32 survivor = _open(a, !longBusts, 100e6, 1_000);
                uint256 before = ex.balances(alice);

                vm.warp(b.time + 5);
                vm.prank(operator);
                vm.expectRevert(Exchange.NotLiquidatable.selector);
                ex.liquidate(survivor, _wrap(b.update));

                vm.prank(operator);
                ex.liquidate(loser, _wrap(b.update));
                assertEq(ex.getPosition(loser).owner, address(0));
                assertEq(ex.balances(alice), before, "the whole margin is forfeited");
                assertEq(ex.lpCash(), 98e6, "less the 2% carved for stakers and the dev");
                emit log_named_decimal_uint("entry", a.price, 8);
                emit log_named_decimal_uint("touch", b.price, 8);
                return;
            }
        }
        vm.skip(true);
    }

    /// @dev The real USDC accepts the permit the Gateway relies on.
    function test_fork_gatewayDepositsWithARealUsdcPermit() public onFork {
        _boot(0);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                alice,
                address(gateway),
                uint256(750e6),
                IUSDC(USDC).nonces(alice),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            alicePk, keccak256(abi.encodePacked("\x19\x01", IUSDC(USDC).DOMAIN_SEPARATOR(), structHash))
        );

        vm.prank(operator);
        gateway.depositWithPermit(alice, 750e6, deadline, v, r, s);
        assertEq(ex.balances(alice), 5_750e6);
        assertEq(IERC20(USDC).balanceOf(alice), 4_250e6);
    }

    /// @dev Real USDC leaves through the exit that needs no operator.
    function test_fork_withdrawsRealUsdc() public onFork {
        _boot(0);
        vm.startPrank(alice);
        ex.requestWithdraw(1_000e6);
        skip(15 minutes);
        ex.executeWithdraw(alice);
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(alice), 6_000e6);
        assertEq(ex.treasury(), 4_000e6);
        assertEq(IERC20(USDC).balanceOf(address(ex)), 4_000e6);
    }
}
