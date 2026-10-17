// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IOracle} from "./interfaces/IOracle.sol";

/// @dev As much of the Exchange as this oracle asks of it.
interface IOwned {
    function owner() external view returns (address);
}

/// @title SignedOracle
/// @notice A price source for the Exchange whose prices are signed by one key: the price signer.
/// @dev The signer reads a market's price off-chain (at launch, Hyperliquid's order book through
///      its public API) and signs it, one print after another. This contract checks the signature
///      and the Exchange's two questions, and nothing else.
///
///      What that means, plainly: THE SIGNER IS TRUSTED. Whoever holds its key decides every fill,
///      every close and every bust. Nothing on-chain can tell a true price from a false one. The
///      key is kept apart from the operator's (it never sends a transaction and needs no ETH) and
///      the Exchange's owner can replace it at once (`setSigner`), which is the only remedy if it
///      leaks.
///
///      What is still enforced on-chain:
///      1. A print is for one feed, on one chain, for this contract: it cannot be replayed for
///         another market, on a fork, or against another deployment (EIP-712).
///      2. Each print names the publish time of the print before it. `pinned` takes only the
///         FIRST print at or after a second, so a trade signed for second T has one price, and
///         the operator who submits it cannot pick among the signer's prints.
///
///      A print is `abi.encode(feedId, price, conf, publishTime, prevPublishTime, v, r, s)`: the
///      price and its uncertainty scaled to 1e8, both times in unix seconds.
///
///      The contract holds no funds and has no owner of its own: its one setting follows the
///      Exchange's owner, so handing the Exchange over hands this over with it.
contract SignedOracle is IOracle {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("SignedOracle");
    bytes32 private constant VERSION_HASH = keccak256("1");
    /// @notice The EIP-712 type the signer signs.
    bytes32 public constant PRINT_TYPEHASH =
        keccak256("Print(bytes32 feedId,uint64 price,uint64 conf,uint64 publishTime,uint64 prevPublishTime)");
    /// @dev Eight words: the feed, four numbers and a signature.
    uint256 private constant PRINT_LENGTH = 256;

    /// @notice The Exchange this prices for. Its owner is the one who may change the signer.
    address public immutable exchange;
    /// @notice The key whose prints are prices.
    address public signer;

    event SignerSet(address indexed signer);

    error ZeroAddress();
    error NotOwner();
    error BadUpdate();
    error BadSignature();
    error NonPositivePrice();
    error NoPriceInWindow();

    constructor(address exchange_, address signer_) {
        if (exchange_ == address(0) || signer_ == address(0)) revert ZeroAddress();
        exchange = exchange_;
        signer = signer_;
        emit SignerSet(signer_);
    }

    /// @notice Replaces the price signer. Every print the old key signed stops counting at once.
    function setSigner(address signer_) external {
        if (msg.sender != IOwned(exchange).owner()) revert NotOwner();
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerSet(signer_);
    }

    /// @inheritdoc IOracle
    function pinned(bytes32 feedId, bytes[] calldata update, uint64 minTime, uint64 maxTime)
        external
        view
        override
        returns (uint64 price, uint64 conf, uint64 publishTime)
    {
        uint64 prevPublishTime;
        (price, conf, publishTime, prevPublishTime) = read(feedId, update);
        // The first print at or after `minTime`: the one before it was published earlier.
        if (prevPublishTime >= minTime || publishTime < minTime || publishTime > maxTime) revert NoPriceInWindow();
    }

    /// @inheritdoc IOracle
    function within(bytes32 feedId, bytes[] calldata update, uint64 minTime, uint64 maxTime)
        external
        view
        override
        returns (uint64 price, uint64 conf, uint64 publishTime)
    {
        (price, conf, publishTime,) = read(feedId, update);
        if (publishTime < minTime || publishTime > maxTime) revert NoPriceInWindow();
    }

    /// @notice The print in `update`, if it is for `feedId` and the signer signed it. Reverts
    ///         otherwise.
    function read(bytes32 feedId, bytes[] calldata update)
        public
        view
        virtual
        returns (uint64 price, uint64 conf, uint64 publishTime, uint64 prevPublishTime)
    {
        if (update.length != 1 || update[0].length != PRINT_LENGTH) revert BadUpdate();
        bytes32 feed;
        uint8 v;
        bytes32 r;
        bytes32 s;
        (feed, price, conf, publishTime, prevPublishTime, v, r, s) =
            abi.decode(update[0], (bytes32, uint64, uint64, uint64, uint64, uint8, bytes32, bytes32));
        // A print for another market is no price for this one.
        if (feed != feedId) revert NoPriceInWindow();
        if (price == 0) revert NonPositivePrice();
        // A print cannot come before the one it follows.
        if (prevPublishTime > publishTime) revert BadUpdate();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(),
                keccak256(abi.encode(PRINT_TYPEHASH, feedId, price, conf, publishTime, prevPublishTime))
            )
        );
        // Rejects a malformed signature and the second form of a valid one.
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, v, r, s);
        if (error != ECDSA.RecoverError.NoError || recovered != signer) revert BadSignature();
    }

    /// @notice The EIP-712 domain prints are signed under: this contract, on this chain.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }
}
