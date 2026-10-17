// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {SignedOracle} from "../src/SignedOracle.sol";
import {SignedSweeper} from "../src/periphery/SignedSweeper.sol";
import {Sweeper} from "../src/periphery/Sweeper.sol";
import {SweeperBase} from "../src/periphery/SweeperBase.sol";
import {Base} from "./Base.t.sol";

/// @dev A caller that cannot receive ETH.
contract MuteCaller {
    function sweep(Sweeper sweeper, bytes[] calldata updates) external payable returns (uint256) {
        return sweeper.sweep{value: msg.value}(updates);
    }
}

/// @dev The oracle whose prices one key signs, and the sweeper that reads it: what each accepts,
///      what each refuses, and who may change the key. The rest of the suite runs the Exchange on
///      this oracle too (see Base); this file is about the oracle itself.
contract SignedOracleTest is Base {
    uint64 internal constant P0 = 80_000e8;
    uint64 internal constant ETH0 = 2_500e8;
    /// @dev The order of the secp256k1 curve: a signature (r, s) has a twin (r, N - s).
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint256 internal otherPk = 0xBAD51C;

    event SignerSet(address indexed signer);

    function _useSigned() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        _fund(alice, 100_000e6);
        _fund(bob, 100_000e6);
    }

    function _one(bytes memory blob) internal pure returns (bytes[] memory update) {
        update = new bytes[](1);
        update[0] = blob;
    }

    function _parts(bytes memory blob)
        internal
        pure
        returns (bytes32 feed, uint64 price, uint64 conf, uint64 time, uint64 prev, uint8 v, bytes32 r, bytes32 s)
    {
        return abi.decode(blob, (bytes32, uint64, uint64, uint64, uint64, uint8, bytes32, bytes32));
    }

    // --------------------------------------------------------------------------------------
    // What a print is
    // --------------------------------------------------------------------------------------

    function test_read_returnsWhatTheSignerSigned() public view {
        (uint64 price, uint64 conf, uint64 time, uint64 prev) =
            prices.read(BTC_FEED, _updateFull(BTC_FEED, P0, 123, T0 + 5, T0 + 3));
        assertEq(price, P0);
        assertEq(conf, 123);
        assertEq(time, T0 + 5);
        assertEq(prev, T0 + 3);
    }

    function test_read_theDomainIsThisContractOnThisChain() public view {
        assertEq(
            prices.PRINT_TYPEHASH(),
            keccak256("Print(bytes32 feedId,uint64 price,uint64 conf,uint64 publishTime,uint64 prevPublishTime)")
        );
        assertEq(
            prices.domainSeparator(),
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("SignedOracle"),
                    keccak256("1"),
                    block.chainid,
                    address(prices)
                )
            )
        );
        assertEq(prices.exchange(), address(ex));
        assertEq(prices.signer(), priceSigner);
    }

    /// @dev The relayer's own signer (relayer/src/prices/signer.mjs) made this print, with anvil's
    ///      account 9, for an oracle at 0x…51c4 on chain 1. The contract has to read it back: the
    ///      two sides agree on the typed data, the encoding and the signature.
    function test_read_acceptsThePrintTheRelayerSigns() public {
        address at = address(uint160(0x51c4));
        address relayerSigner = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
        SignedOracle built = SignedOracle(
            _deployed("SignedOracle", type(SignedOracle).creationCode, abi.encode(address(ex), relayerSigner))
        );
        vm.etch(at, address(built).code);
        vm.store(at, bytes32(0), bytes32(uint256(uint160(relayerSigner))));
        assertEq(SignedOracle(at).signer(), relayerSigner);
        vm.chainId(1);

        bytes memory blob =
            hex"68797065726c69717569643a425443000000000000000000000000000000000000000000000000000000000000000000000000000000000000000591ba6b70000000000000000000000000000000000000000000000000000000000002faf080000000000000000000000000000000000000000000000000000000006b49d202000000000000000000000000000000000000000000000000000000006b49d201000000000000000000000000000000000000000000000000000000000000001c07c70778b7888e37ed3a986cf0ea409b761bbeb41cec5bf52eaeeb73b2d03b4465b2bc93d510a16f1f01343cce7b8d42f3839bc8c3418f347d6b04b61f91abe7";
        (uint64 price, uint64 conf, uint64 time, uint64 prev) =
            SignedOracle(at).read(bytes32("hyperliquid:BTC"), _one(blob));
        assertEq(price, 61_234.56e8);
        assertEq(conf, 0.5e8);
        assertEq(time, 1_800_000_002);
        assertEq(prev, 1_800_000_001);

        // On another chain the same print is nobody's.
        vm.chainId(8453);
        vm.expectRevert(SignedOracle.BadSignature.selector);
        SignedOracle(at).read(bytes32("hyperliquid:BTC"), _one(blob));
    }

    function test_read_refusesAnotherKeysSignature() public {
        bytes[] memory forged = _one(_print(otherPk, BTC_FEED, P0, 0, T0 + 2, T0 + 1));
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, forged);
    }

    /// @dev Every number in a print is under the signature: change one and it is nobody's.
    function test_read_everyFieldIsSigned() public {
        (bytes32 feed, uint64 price, uint64 conf, uint64 time, uint64 prev, uint8 v, bytes32 r, bytes32 s) =
            _parts(_print(priceSignerPk, BTC_FEED, P0, 5, T0 + 10, T0 + 8));

        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, _one(abi.encode(feed, price + 1, conf, time, prev, v, r, s)));
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, _one(abi.encode(feed, price, conf + 1, time, prev, v, r, s)));
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, _one(abi.encode(feed, price, conf, time + 1, prev, v, r, s)));
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, _one(abi.encode(feed, price, conf, time, prev + 1, v, r, s)));

        // The feed too: relabelled for ETH it is refused, and as it stands it is no ETH price.
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(ETH_FEED, _one(abi.encode(ETH_FEED, price, conf, time, prev, v, r, s)));
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.read(ETH_FEED, _one(abi.encode(feed, price, conf, time, prev, v, r, s)));

        // Untouched, it reads.
        prices.read(BTC_FEED, _one(abi.encode(feed, price, conf, time, prev, v, r, s)));
    }

    /// @dev A print is for one oracle. Signed for this one, it is nothing to another deployment
    ///      with the very same signer.
    function test_read_refusesAPrintSignedForAnotherOracle() public {
        SignedOracle other = new SignedOracle(address(ex), priceSigner);
        bytes[] memory forHere = _update(BTC_FEED, P0, T0 + 2);
        prices.read(BTC_FEED, forHere);
        vm.expectRevert(SignedOracle.BadSignature.selector);
        other.read(BTC_FEED, forHere);

        bytes[] memory forThere = _one(_printFor(address(other), priceSignerPk, BTC_FEED, P0, 0, T0 + 2, T0 + 1));
        other.read(BTC_FEED, forThere);
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, forThere);
    }

    function test_read_refusesAPrintFromAnotherChain() public {
        bytes[] memory update = _update(BTC_FEED, P0, T0 + 2);
        bytes32 domain = prices.domainSeparator();
        vm.chainId(block.chainid + 1);
        assertTrue(prices.domainSeparator() != domain);
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, update);
    }

    /// @dev Every signature has a second form that recovers the same key. Only one is a print.
    function test_read_refusesTheSecondFormOfASignature() public {
        (bytes32 feed, uint64 price, uint64 conf, uint64 time, uint64 prev, uint8 v, bytes32 r, bytes32 s) =
            _parts(_print(priceSignerPk, BTC_FEED, P0, 0, T0 + 2, T0 + 1));
        bytes32 twin = bytes32(N - uint256(s));
        uint8 flipped = v == 27 ? 28 : 27;
        // It is a true signature: ecrecover itself gives the signer.
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                prices.domainSeparator(),
                keccak256(abi.encode(prices.PRINT_TYPEHASH(), feed, price, conf, time, prev))
            )
        );
        assertEq(ecrecover(digest, flipped, r, twin), priceSigner);

        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, _one(abi.encode(feed, price, conf, time, prev, flipped, r, twin)));
        // Nor the 0 / 1 spelling of v, nor an empty signature.
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, _one(abi.encode(feed, price, conf, time, prev, v - 27, r, s)));
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, _one(abi.encode(feed, price, conf, time, prev, uint8(27), bytes32(0), bytes32(0))));
    }

    function test_read_refusesAnythingThatIsNotOnePrint() public {
        bytes memory blob = _print(priceSignerPk, BTC_FEED, P0, 0, T0 + 2, T0 + 1);

        vm.expectRevert(SignedOracle.BadUpdate.selector);
        prices.read(BTC_FEED, new bytes[](0));

        bytes[] memory two = new bytes[](2);
        two[0] = blob;
        two[1] = blob;
        vm.expectRevert(SignedOracle.BadUpdate.selector);
        prices.read(BTC_FEED, two);

        vm.expectRevert(SignedOracle.BadUpdate.selector);
        prices.read(BTC_FEED, _one(abi.encodePacked(blob, uint8(0))));
        vm.expectRevert(SignedOracle.BadUpdate.selector);
        prices.read(BTC_FEED, _one(""));

        // A number too large for its field is not quietly cut down to fit.
        (bytes32 feed,, uint64 conf, uint64 time, uint64 prev, uint8 v, bytes32 r, bytes32 s) = _parts(blob);
        vm.expectRevert();
        prices.read(BTC_FEED, _one(abi.encode(feed, (uint256(1) << 64) + P0, conf, time, prev, v, r, s)));
    }

    function test_read_refusesAZeroPriceAndAPrintBeforeItsPredecessor() public {
        bytes[] memory zero = _updateFull(BTC_FEED, 0, 0, T0 + 2, T0 + 1);
        vm.expectRevert(SignedOracle.NonPositivePrice.selector);
        prices.read(BTC_FEED, zero);

        bytes[] memory backward = _updateFull(BTC_FEED, P0, 0, T0 + 2, T0 + 3);
        vm.expectRevert(SignedOracle.BadUpdate.selector);
        prices.read(BTC_FEED, backward);

        // A later print of the same second names that second as its predecessor's.
        prices.read(BTC_FEED, _updateFull(BTC_FEED, P0, 0, T0 + 2, T0 + 2));
    }

    function testFuzz_read_givesBackAnyPrintTheSignerSigned(
        bytes32 feed,
        uint64 price,
        uint64 conf,
        uint64 time,
        uint64 prev
    ) public view {
        price = uint64(bound(price, 1, type(uint64).max));
        prev = uint64(bound(prev, 0, time));
        (uint64 gotPrice, uint64 gotConf, uint64 gotTime, uint64 gotPrev) =
            prices.read(feed, _updateFull(feed, price, conf, time, prev));
        assertEq(gotPrice, price);
        assertEq(gotConf, conf);
        assertEq(gotTime, time);
        assertEq(gotPrev, prev);
    }

    /// @dev Flip any one bit of a good print and it is refused, whichever bit.
    function testFuzz_read_refusesAPrintWithAnyBitChanged(uint256 bit) public {
        bytes memory blob = _print(priceSignerPk, BTC_FEED, P0, 7, T0 + 2, T0 + 1);
        bit = bound(bit, 0, blob.length * 8 - 1);
        blob[bit / 8] = bytes1(uint8(blob[bit / 8]) ^ uint8(1 << (bit % 8)));
        bytes[] memory update = _one(blob);
        vm.expectRevert();
        prices.read(BTC_FEED, update);
    }

    // --------------------------------------------------------------------------------------
    // The Exchange's two questions
    // --------------------------------------------------------------------------------------

    /// @dev `pinned` is the FIRST print at or after a second. The print before it must have been
    ///      published earlier than that second, or this one is not the first.
    function test_pinned_takesOnlyTheFirstPrintAtOrAfterTheSecond() public {
        uint64 pin = T0 + 100;

        (uint64 price,, uint64 time) = prices.pinned(BTC_FEED, _updateFull(BTC_FEED, P0, 0, pin, pin - 1), pin, pin + 10);
        assertEq(price, P0);
        assertEq(time, pin);
        // The signer skipped a few seconds: the first print after the pin is still the one.
        prices.pinned(BTC_FEED, _updateFull(BTC_FEED, P0, 0, pin + 3, pin - 1), pin, pin + 10);
        prices.pinned(BTC_FEED, _updateFull(BTC_FEED, P0, 0, pin + 10, pin - 4), pin, pin + 10);

        // Too early, and past the window.
        bytes[] memory update = _updateFull(BTC_FEED, P0, 0, pin - 1, pin - 2);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.pinned(BTC_FEED, update, pin, pin + 10);
        update = _updateFull(BTC_FEED, P0, 0, pin + 11, pin - 1);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.pinned(BTC_FEED, update, pin, pin + 10);

        // A later print of the pinned second: an earlier one of that second exists.
        update = _updateFull(BTC_FEED, P0, 0, pin, pin);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.pinned(BTC_FEED, update, pin, pin + 10);
        // A print two seconds on, when one was published in between.
        update = _updateFull(BTC_FEED, P0, 0, pin + 2, pin + 1);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.pinned(BTC_FEED, update, pin, pin + 10);
        update = _updateFull(BTC_FEED, P0, 0, pin + 2, pin);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.pinned(BTC_FEED, update, pin, pin + 10);

        // Another market's print.
        update = _updateFull(ETH_FEED, ETH0, 0, pin, pin - 1);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.pinned(BTC_FEED, update, pin, pin + 10);
    }

    /// @dev `within` is any print inside a window, first of its second or not: that is how a
    ///      touch between two seconds can bust a position.
    function test_within_takesAnyPrintInsideTheWindow() public {
        uint64 from = T0 + 100;

        prices.within(BTC_FEED, _updateFull(BTC_FEED, P0, 0, from, from - 1), from, from + 30);
        prices.within(BTC_FEED, _updateFull(BTC_FEED, P0, 0, from + 30, from + 29), from, from + 30);
        (uint64 price,, uint64 time) =
            prices.within(BTC_FEED, _updateFull(BTC_FEED, P0 + 1, 0, from + 5, from + 5), from, from + 30);
        assertEq(price, P0 + 1);
        assertEq(time, from + 5);

        bytes[] memory update = _updateFull(BTC_FEED, P0, 0, from - 1, from - 2);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.within(BTC_FEED, update, from, from + 30);
        update = _updateFull(BTC_FEED, P0, 0, from + 31, from + 30);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.within(BTC_FEED, update, from, from + 30);
        update = _updateFull(ETH_FEED, ETH0, 0, from, from - 1);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        prices.within(BTC_FEED, update, from, from + 30);
    }

    /// @dev It holds nothing and changes nothing, so it does not matter who asks.
    function test_anyoneMayAsk() public {
        bytes[] memory update = _update(BTC_FEED, P0, T0 + 2);
        vm.startPrank(stranger);
        prices.pinned(BTC_FEED, update, T0 + 2, T0 + 12);
        prices.within(BTC_FEED, update, T0, T0 + 12);
        prices.read(BTC_FEED, update);
        vm.stopPrank();
    }

    // --------------------------------------------------------------------------------------
    // The Exchange on signed prices
    // --------------------------------------------------------------------------------------

    function test_exchange_fillsClosesAndBustsAtTheSignersPrices() public {
        bytes32 won = _open(alicePk, btc, true, 100e6, 100, P0);
        assertEq(ex.getPosition(won).entryPrice, P0);
        uint256 before = ex.balances(alice);
        _close(alicePk, won, _px(80_400));
        assertGt(ex.balances(alice) + ex.queuedOf(alice), before + 100e6, "a win is paid");

        bytes32 lost = _open(bobPk, eth, true, 100e6, 1_000, ETH0);
        _liquidate(lost, uint64(_bustOf(lost)));
        assertEq(ex.getPosition(lost).owner, address(0), "the position is gone");
        _assertSolvent();
    }

    /// @dev Nobody but the signer makes a price. An operator with a print of its own gets nowhere.
    function test_exchange_refusesAPriceTheSignerDidNotSign() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes memory sig = _sign(alicePk, _hashOpen(it));
        bytes[] memory forged = _one(_print(otherPk, BTC_FEED, _px(1), 0, it.timestamp + 2, it.timestamp + 1));
        skip(12);
        vm.prank(operator);
        vm.expectRevert(SignedOracle.BadSignature.selector);
        ex.open(it, sig, forged);

        // Nor can anyone bust a position with a price of their own, however long they wait.
        bytes32 id = _open(alicePk, btc, true, 100e6, 1_000, P0);
        skip(2 minutes);
        forged = _one(
            _print(
                otherPk, BTC_FEED, _px(1), 0, uint64(vm.getBlockTimestamp()) - 61, uint64(vm.getBlockTimestamp()) - 62
            )
        );
        vm.prank(stranger);
        vm.expectRevert(SignedOracle.BadSignature.selector);
        ex.liquidate(id, forged);
        assertEq(ex.getPosition(id).owner, alice);
    }

    /// @dev A true print of one market is no price for another.
    function test_exchange_refusesAnotherMarketsPrint() public {
        Intents.OpenIntent memory it = _intent(alice, btc, true, 100e6, 100);
        bytes memory sig = _sign(alicePk, _hashOpen(it));
        bytes[] memory ethPrint = _update(ETH_FEED, ETH0, it.timestamp + 2);
        skip(12);
        vm.prank(operator);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        ex.open(it, sig, ethPrint);
    }

    /// @dev Without the operator: the owner asks to close, and after the wait anyone can execute
    ///      it, with the signer's print for the pinned second and no other.
    function test_exchange_aDirectCloseSettlesAtTheSignersPinnedPrint() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        vm.prank(alice);
        ex.requestClose(id);
        uint64 pin = uint64(vm.getBlockTimestamp()) + ex.DIRECT_DELAY();
        skip(ex.DIRECT_DELAY() + ex.INTENT_TTL() + 1);

        bytes[] memory late = _updateFull(BTC_FEED, _px(90_000), 0, pin + 1, pin);
        vm.prank(stranger);
        vm.expectRevert(SignedOracle.NoPriceInWindow.selector);
        ex.executeClose(id, late);

        uint256 before = ex.balances(alice);
        bytes[] memory first = _update(BTC_FEED, _px(80_400), pin);
        vm.prank(stranger);
        ex.executeClose(id, first);
        assertGt(ex.balances(alice) + ex.queuedOf(alice), before + 100e6);
        _assertSolvent();
    }

    // --------------------------------------------------------------------------------------
    // The signer
    // --------------------------------------------------------------------------------------

    function test_constructor_refusesZeroAddresses() public {
        vm.expectRevert(SignedOracle.ZeroAddress.selector);
        new SignedOracle(address(0), priceSigner);
        vm.expectRevert(SignedOracle.ZeroAddress.selector);
        new SignedOracle(address(ex), address(0));
    }

    function test_setSigner_isTheExchangeOwnersAlone() public {
        address next = vm.addr(otherPk);
        address[5] memory others = [stranger, operator, guardian, priceSigner, dev];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(SignedOracle.NotOwner.selector);
            prices.setSigner(next);
        }
        vm.prank(admin);
        vm.expectRevert(SignedOracle.ZeroAddress.selector);
        prices.setSigner(address(0));
        assertEq(prices.signer(), priceSigner);

        vm.expectEmit(true, false, false, false, address(prices));
        emit SignerSet(next);
        vm.prank(admin);
        prices.setSigner(next);
        assertEq(prices.signer(), next);
    }

    /// @dev A leaked key is answered by replacing it: from that block on its prints are nothing,
    ///      old ones included, and positions it opened close at the new key's prices.
    function test_setSigner_endsTheOldKeyAtOnce() public {
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, P0);
        bytes[] memory old = _update(BTC_FEED, P0, T0 + 500);
        prices.read(BTC_FEED, old);

        vm.prank(admin);
        prices.setSigner(vm.addr(otherPk));
        vm.expectRevert(SignedOracle.BadSignature.selector);
        prices.read(BTC_FEED, old);

        // The suite's helpers still sign with the old key: a close with it is refused.
        Intents.CloseIntent memory it =
            Intents.CloseIntent({owner: alice, positionId: id, timestamp: uint64(vm.getBlockTimestamp())});
        bytes memory sig = _sign(alicePk, _hashClose(it));
        bytes[] memory stale = _update(BTC_FEED, _px(90_000), it.timestamp + 2);
        bytes[] memory fresh = _one(_print(otherPk, BTC_FEED, _px(80_400), 0, it.timestamp + 2, it.timestamp + 1));
        skip(12);
        vm.prank(operator);
        vm.expectRevert(SignedOracle.BadSignature.selector);
        ex.close(it, sig, stale);
        vm.prank(operator);
        ex.close(it, sig, fresh);
        assertEq(ex.getPosition(id).owner, address(0));
        _assertSolvent();
    }

    /// @dev The oracle has no owner of its own. Hand the Exchange over and the signer goes with it.
    function test_setSigner_followsTheExchangesOwner() public {
        address next = vm.addr(otherPk);
        vm.prank(admin);
        ex.transferOwnership(carol);

        // Offered, not yet accepted: still the old owner's.
        vm.prank(carol);
        vm.expectRevert(SignedOracle.NotOwner.selector);
        prices.setSigner(next);

        vm.prank(carol);
        ex.acceptOwnership();
        vm.prank(admin);
        vm.expectRevert(SignedOracle.NotOwner.selector);
        prices.setSigner(next);
        vm.prank(carol);
        prices.setSigner(next);
        assertEq(prices.signer(), next);
    }

    // --------------------------------------------------------------------------------------
    // The sweeper that marks the book with signed prints
    // --------------------------------------------------------------------------------------

    function _hedged() internal returns (uint256 held) {
        _attachCoin();
        _seedHouse(STAKER_CAP + 1_000e6);
        _open(alicePk, btc, true, 100e6, 10, P0);
        _open(alicePk, eth, false, 100e6, 10, ETH0);
        // Both sit at their entry: what stays behind is the cushion, 20 bps of the $2,000 open.
        held = 4e6;
    }

    function _mark(bytes32 feed, uint64 price, uint64 age) internal view returns (bytes memory) {
        return _update(feed, price, uint64(vm.getBlockTimestamp()) - age)[0];
    }

    function test_sweeper_readsTheExchangesOwnOracle() public {
        _attachCoin();
        assertEq(address(SignedSweeper(address(sweeper)).oracle()), address(prices));
        assertEq(address(sweeper.exchange()), address(ex));
        assertEq(sweeper.sweeperFor(), address(ex));
    }

    /// @dev One print for each market with something open, in any order, among whatever else.
    function test_sweeper_findsEachMarketsPrintAmongTheRest() public {
        uint256 held = _hedged();
        bytes[] memory updates = new bytes[](5);
        updates[0] = "";
        updates[1] = _mark(ETH_FEED, ETH0, 0);
        updates[2] = hex"deadbeef";
        updates[3] = _mark(keccak256("SOL/USD"), _px(150), 0);
        updates[4] = _mark(BTC_FEED, P0, 0);
        assertEq(sweeper.sweep(updates), 1_000e6 - held);
        assertEq(ex.lpCash(), STAKER_CAP + held);
    }

    function test_sweeper_needsAPrintOfTheLastThirtySecondsForEveryLiveMarket() public {
        uint256 held = _hedged();
        bytes[] memory updates = new bytes[](2);
        updates[0] = _mark(BTC_FEED, P0, 0);

        // ETH is left out.
        updates[1] = "";
        vm.expectRevert(SignedSweeper.NoPriceInWindow.selector);
        sweeper.sweep(updates);
        vm.expectRevert(SignedSweeper.NoPriceInWindow.selector);
        sweeper.sweep(new bytes[](0));

        // 31 seconds old, and one second in the future.
        updates[1] = _mark(ETH_FEED, ETH0, 31);
        vm.expectRevert(SignedSweeper.NoPriceInWindow.selector);
        sweeper.sweep(updates);
        updates[1] = _update(ETH_FEED, ETH0, uint64(vm.getBlockTimestamp()) + 1)[0];
        vm.expectRevert(SignedSweeper.NoPriceInWindow.selector);
        sweeper.sweep(updates);

        // Thirty seconds is the edge that is accepted.
        updates[1] = _mark(ETH_FEED, ETH0, 30);
        assertEq(sweeper.sweep(updates), 1_000e6 - held);
    }

    /// @dev A stale print for a market does not hide a fresh one that follows it.
    function test_sweeper_passesOverAStalePrintForAFreshOne() public {
        uint256 held = _hedged();
        bytes[] memory updates = new bytes[](3);
        updates[0] = _mark(BTC_FEED, _px(90_000), 31);
        updates[1] = _mark(BTC_FEED, P0, 0);
        updates[2] = _mark(ETH_FEED, ETH0, 0);
        assertEq(sweeper.sweep(updates), 1_000e6 - held);
    }

    /// @dev The mark is the signer's and nobody else's: a print of the caller's own stops the sweep.
    function test_sweeper_refusesAPriceTheSignerDidNotSign() public {
        _hedged();
        bytes[] memory updates = new bytes[](2);
        uint64 nowTime = uint64(vm.getBlockTimestamp());
        updates[0] = _print(otherPk, BTC_FEED, _px(1), 0, nowTime, nowTime - 1);
        updates[1] = _mark(ETH_FEED, ETH0, 0);
        vm.expectRevert(SignedOracle.BadSignature.selector);
        sweeper.sweep(updates);
    }

    /// @dev What the open positions are up is held back, at the signer's price.
    function test_sweeper_holdsBackWhatTheBookIsUp() public {
        _attachCoin();
        _seedHouse(STAKER_CAP + 1_000e6);
        _open(alicePk, btc, true, 100e6, 10, P0); // $1,000 long
        bytes[] memory updates = new bytes[](1);

        // 10% up: the long is up $100, plus the $2 cushion.
        updates[0] = _mark(BTC_FEED, _px(88_000), 0);
        assertEq(sweeper.sweep(updates), 1_000e6 - 100e6 - 2e6);
    }

    function test_sweeper_isTheOperatorsToCall() public {
        _hedged();
        bytes[] memory updates = new bytes[](2);
        updates[0] = _mark(BTC_FEED, P0, 0);
        updates[1] = _mark(ETH_FEED, ETH0, 0);
        vm.prank(stranger);
        vm.expectRevert(SweeperBase.NotOperator.selector);
        sweeper.sweep(updates);
    }

    /// @dev Signed prices cost nothing to read. ETH sent by mistake comes back, and a caller that
    ///      cannot take ETH back simply sends none.
    function test_sweeper_needsNoEthAndReturnsAnySent() public {
        uint256 held = _hedged();
        bytes[] memory updates = new bytes[](2);
        updates[0] = _mark(BTC_FEED, P0, 0);
        updates[1] = _mark(ETH_FEED, ETH0, 0);
        MuteCaller mute = new MuteCaller();
        vm.prank(admin);
        ex.setOperator(address(mute), true);
        uint256 snapshot = vm.snapshotState();

        vm.expectRevert(SweeperBase.RefundFailed.selector);
        mute.sweep{value: 1}(sweeper, updates);
        assertEq(mute.sweep(sweeper, updates), 1_000e6 - held);
        vm.revertToState(snapshot);

        vm.deal(operator, 1 ether);
        vm.prank(operator);
        assertEq(sweeper.sweep{value: 1 ether}(updates), 1_000e6 - held);
        assertEq(operator.balance, 1 ether);
        assertEq(address(sweeper).balance, 0);
    }
}
