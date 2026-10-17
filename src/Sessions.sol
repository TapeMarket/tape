// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {ISessions} from "./interfaces/ISessions.sol";

/// @title Sessions
/// @notice The session keys traders sign their orders with.
/// @dev A trader signs once with their wallet to register a session key. After that the key signs
///      every open and close, so trading needs no wallet popup and no gas. The Exchange asks this
///      contract one question, `isValid`, and a session key can never do more than trade: it cannot
///      withdraw.
///
///      Every order carries the second it was signed for, and that timestamp fixes its price. So the
///      validity of an order must not be something its signer can switch after the fact: a trader
///      who could cancel an order, or bring a dead one to life, after watching the next few seconds
///      of price would hold a free option against the house.
///
///      That is why every change to a key takes effect one slot later, measured on the order's own
///      timestamp. A new key only signs for timestamps from `validFrom` on. A revoked key keeps
///      signing for timestamps before its cut-off. And a key that has ended is never brought back:
///      doing so would have to either revive its old orders or cancel them.
///
///      No owner and no settings.
contract Sessions is ISessions, EIP712 {
    struct SessionKey {
        /// @dev The key signs for orders timestamped at or after this...
        uint64 validFrom;
        /// @dev ...and strictly before this.
        uint64 validUntil;
    }

    bytes32 private constant SESSION_TYPEHASH =
        keccak256("SessionKey(address owner,address key,uint64 validUntil,uint256 nonce)");

    /// @notice Longest a session key can be registered for.
    uint64 public constant MAX_DURATION = 90 days;

    /// @notice One slot. A change to a key bites this long after the block it lands in.
    /// @dev A block is assembled during the slot before its timestamp. An order timestamped up to
    ///      one slot after a block's timestamp could therefore already have been in flight, with
    ///      its price known, when a transaction in that block was sent.
    uint64 public constant GRACE = 12;

    mapping(address owner => mapping(address key => SessionKey)) public sessionKeys;

    /// @notice Replay counter for registrations signed by the wallet.
    mapping(address owner => uint256) public nonces;

    event SessionKeySet(address indexed owner, address indexed key, uint64 validFrom, uint64 validUntil);

    error ZeroKey();
    error BadExpiry();
    error KeyRetired();
    error BadSignature();

    constructor(string memory name_) EIP712(name_, "1") {}

    /// @inheritdoc ISessions
    function isValid(address owner, address key, uint64 timestamp) external view override returns (bool) {
        SessionKey memory session = sessionKeys[owner][key];
        return timestamp >= session.validFrom && timestamp < session.validUntil;
    }

    /// @notice Registers `key` for the caller, or changes when a live key expires.
    function setSessionKey(address key, uint64 validUntil) external {
        _set(msg.sender, key, validUntil);
    }

    /// @notice Registers `key` for `owner` from the owner's wallet signature. Anyone may submit it.
    function setSessionKeyBySig(address owner, address key, uint64 validUntil, bytes calldata signature)
        external
    {
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(SESSION_TYPEHASH, owner, key, validUntil, nonces[owner]++))
        );
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert BadSignature();
        _set(owner, key, validUntil);
    }

    /// @notice Revokes the caller's `key`. Orders it signed for a timestamp before the cut-off stay
    ///         valid until they expire on their own; nothing it signs for a later one is.
    function revokeSessionKey(address key) external {
        SessionKey storage session = sessionKeys[msg.sender][key];
        uint64 cutoff = uint64(block.timestamp) + GRACE;
        if (session.validUntil > cutoff) {
            session.validUntil = cutoff;
            emit SessionKeySet(msg.sender, key, session.validFrom, cutoff);
        }
    }

    /// @notice The EIP-712 domain separator registrations are signed against.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _set(address owner, address key, uint64 validUntil) private {
        if (key == address(0)) revert ZeroKey();
        uint64 floor = uint64(block.timestamp) + GRACE;
        if (validUntil <= floor || validUntil > block.timestamp + MAX_DURATION) revert BadExpiry();

        SessionKey storage session = sessionKeys[owner][key];
        if (session.validFrom == 0) {
            // A new key. It cannot sign for a timestamp that was already in the past, or in flight,
            // when it was registered: that would bring a dead order to life once its price is known.
            session.validFrom = floor;
        } else if (session.validUntil <= floor) {
            // Expired or revoked. Reopening it would either revive or cancel what it signed before.
            revert KeyRetired();
        }
        session.validUntil = validUntil;
        emit SessionKeySet(owner, key, session.validFrom, validUntil);
    }
}
