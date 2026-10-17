// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {ISessions} from "../interfaces/ISessions.sol";

/// @title Intents
/// @notice The orders traders sign, and who may sign them.
/// @dev Opens and closes are signed by the owner's key or by one of their session keys (see
///      `Sessions`). Withdrawals are signed by the owner's wallet only.
///
///      The EIP-712 domain is the standard one: the name given at deployment, version "1", this
///      chain and this contract. It is worked out here rather than inherited: the usual base
///      contract also answers `eip712Domain()` with the name as a string, which nothing here
///      needs and which costs several hundred bytes that the Exchange does not have. The separator
///      is computed afresh on every call, so it is right on any chain the contract finds itself on.
abstract contract Intents {
    struct OpenIntent {
        address owner;
        uint16 market;
        bool isLong;
        /// @dev Fund the margin from the owner's queued payout first, then from their balance.
        bool useQueued;
        uint16 leverage;
        uint96 margin;
        /// @dev Worst acceptable entry (max for a long, min for a short). Zero means no limit.
        uint64 priceLimit;
        /// @dev The most the position may be charged on for its size, in whole dollars (see
        ///      `PerpMath.impactNotionalFor`). What it is charged on depends on what is open on
        ///      its side when the order lands, which other orders can change after this one is
        ///      signed. Zero means no limit.
        uint32 impactLimit;
        uint64 timestamp;
        uint64 salt;
    }

    struct CloseIntent {
        address owner;
        bytes32 positionId;
        uint64 timestamp;
    }

    /// @dev A take-profit or a stop-loss: close the position once a price at or beyond `price`
    ///      prints, from `timestamp` on. `above` says which way: at or above it, or at or below.
    struct TriggerIntent {
        address owner;
        bytes32 positionId;
        uint64 price;
        bool above;
        uint64 timestamp;
    }

    bytes32 private constant OPEN_TYPEHASH = keccak256(
        "Open(address owner,uint16 market,bool isLong,bool useQueued,uint16 leverage,uint96 margin,uint64 priceLimit,uint32 impactLimit,uint64 timestamp,uint64 salt)"
    );
    bytes32 private constant CLOSE_TYPEHASH =
        keccak256("Close(address owner,bytes32 positionId,uint64 timestamp)");
    bytes32 private constant TRIGGER_TYPEHASH =
        keccak256("Trigger(address owner,bytes32 positionId,uint64 price,bool above,uint64 timestamp)");
    bytes32 private constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address owner,address to,uint256 amount,uint256 nonce,uint64 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// @dev The hash of the name orders are signed under.
    bytes32 private immutable _nameHash;

    /// @notice One slot. Anything a trader does to their own account bites this long after the
    ///         block it lands in, so that it cannot reach an order already signed.
    uint64 public constant GRACE = 12;

    /// @notice The registry of session keys.
    ISessions public immutable sessions;

    /// @notice Replay counter for withdrawals signed by the wallet. Nothing else moves it, so no
    ///         other signature of the owner's can void a withdrawal already handed to an operator.
    mapping(address owner => uint256) public withdrawNonces;

    error BadSignature();

    constructor(string memory name_, ISessions sessions_) {
        _nameHash = keccak256(bytes(name_));
        sessions = sessions_;
    }

    /// @notice The EIP-712 domain separator orders are signed against.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, _nameHash, VERSION_HASH, block.chainid, address(this)));
    }

    /// @dev The digest a wallet signs for a struct with this hash, under this contract's domain.
    function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(domainSeparator(), structHash);
    }

    function _hashOpen(OpenIntent calldata it) internal view returns (bytes32) {
        return _hashTypedDataV4(
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

    function _hashClose(CloseIntent calldata it) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLOSE_TYPEHASH, it.owner, it.positionId, it.timestamp)));
    }

    function _hashTrigger(TriggerIntent calldata it) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(TRIGGER_TYPEHASH, it.owner, it.positionId, it.price, it.above, it.timestamp))
        );
    }

    function _hashWithdraw(address owner, address to, uint256 amount, uint256 nonce, uint64 deadline)
        internal
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, owner, to, amount, nonce, deadline)));
    }

    /// @dev An order is valid if signed by the owner's key, or by a session key whose validity
    ///      covers the order's own timestamp. A smart-contract wallet trades through a session key.
    function _requireTradeAuth(address owner, bytes32 digest, bytes calldata signature, uint64 timestamp)
        internal
        view
    {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError) revert BadSignature();
        if (signer != owner && !sessions.isValid(owner, signer, timestamp)) revert BadSignature();
    }

    /// @dev Withdrawals take the wallet's own signature. A session key is never enough.
    function _requireWalletAuth(address owner, bytes32 digest, bytes calldata signature) internal view virtual {
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert BadSignature();
    }
}
