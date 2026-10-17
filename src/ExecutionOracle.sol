// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {SignedOracle} from "./SignedOracle.sol";

/// @notice Signed market prints plus execution prices bound to one exact trader-signed order.
/// @dev The signer remains trusted for price accuracy and prompt, single-price execution. It must
///      persist the first execution quote for an order before releasing it, and must never sign a
///      second price for that order. Binding a quote to its full EIP-712 order digest prevents a
///      trader or operator from substituting an ordinary historical print or another order's quote.
///      No fixed pricing delay is imposed. Public prints still support liquidations and direct exits.
contract ExecutionOracle is SignedOracle {
    bytes32 public constant FILL_TYPEHASH = keccak256(
        "Fill(bytes32 feedId,bytes32 orderId,uint64 price,uint64 conf,uint64 publishTime,uint64 observedAt)"
    );
    uint256 private constant FILL_LENGTH = 288;
    bytes32 public constant TICK_TYPEHASH = keccak256(
        "Tick(bytes32 feedId,uint64 price,uint64 conf,uint64 publishTime,uint64 prevPublishTime,uint64 observedAt,uint64 prevObservedAt)"
    );

    constructor(address exchange_, address signer_) SignedOracle(exchange_, signer_) {}

    /// @notice Fixed wallet-signature validation, including ERC-1271 wallets. Kept here so the
    ///         Exchange's runtime remains within Ethereum's code-size limit. No signer setting
    ///         participates in this check: only the owner's actual wallet can authorize it.
    function checkWalletSignature(address owner, bytes32 digest, bytes calldata signature)
        external
        view
        returns (bool)
    {
        return SignatureChecker.isValidSignatureNow(owner, digest, signature);
    }

    /// @notice An execution price signed for this feed and this complete order digest.
    /// @dev `observedAt` is the source observation in milliseconds; public position times remain
    ///      seconds. The operator cannot turn a normal signed market print into an execution quote.
    function fill(bytes32 feedId, bytes32 orderId, bytes[] calldata update, uint64 minTime, uint64 maxTime)
        external
        view
        returns (uint64 price, uint64 conf, uint64 publishTime, uint64 observedAt)
    {
        if (update.length != 1 || update[0].length != FILL_LENGTH) revert BadUpdate();
        bytes32 feed;
        bytes32 order;
        uint8 v;
        bytes32 r;
        bytes32 s;
        (feed, order, price, conf, publishTime, observedAt, v, r, s) =
            abi.decode(update[0], (bytes32, bytes32, uint64, uint64, uint64, uint64, uint8, bytes32, bytes32));
        if (feed != feedId || order != orderId || orderId == bytes32(0)) revert NoPriceInWindow();
        if (price == 0) revert NonPositivePrice();
        if (publishTime < minTime || publishTime > maxTime || observedAt / 1000 != publishTime) {
            revert NoPriceInWindow();
        }
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(),
                keccak256(abi.encode(FILL_TYPEHASH, feed, order, price, conf, publishTime, observedAt))
            )
        );
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, v, r, s);
        if (error != ECDSA.RecoverError.NoError || recovered != signer) revert BadSignature();
    }

    /// @notice Public tick with millisecond ordering, for proving a post-entry bust or trigger.
    function afterMs(bytes32 feedId, bytes[] calldata update, uint64 afterTime)
        external
        view
        returns (uint64 price, uint64 conf, uint64 publishTime, uint64 observedAt)
    {
        (price, conf, publishTime,, observedAt) = _tick(feedId, update);
        if (observedAt <= afterTime) revert NoPriceInWindow();
    }

    function read(bytes32 feedId, bytes[] calldata update)
        public
        view
        override
        returns (uint64 price, uint64 conf, uint64 publishTime, uint64 prevPublishTime)
    {
        (price, conf, publishTime, prevPublishTime,) = _tick(feedId, update);
    }

    function _tick(bytes32 feedId, bytes[] calldata update)
        private
        view
        returns (uint64 price, uint64 conf, uint64 publishTime, uint64 prevPublishTime, uint64 observedAt)
    {
        if (update.length != 1 || update[0].length != 320) revert BadUpdate();
        bytes32 feed;
        uint64 prevObservedAt;
        uint8 v;
        bytes32 r;
        bytes32 s;
        (feed, price, conf, publishTime, prevPublishTime, observedAt, prevObservedAt, v, r, s) = abi.decode(
            update[0], (bytes32, uint64, uint64, uint64, uint64, uint64, uint64, uint8, bytes32, bytes32)
        );
        if (feed != feedId) revert NoPriceInWindow();
        if (price == 0) revert NonPositivePrice();
        if (
            observedAt / 1000 != publishTime || prevObservedAt / 1000 != prevPublishTime
                || prevObservedAt >= observedAt
        ) revert BadUpdate();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(),
                keccak256(abi.encode(TICK_TYPEHASH, feed, price, conf, publishTime, prevPublishTime, observedAt, prevObservedAt))
            )
        );
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, v, r, s);
        if (error != ECDSA.RecoverError.NoError || recovered != signer) revert BadSignature();
    }
}
