// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Exchange} from "./Exchange.sol";
import {ExecutionOracle} from "./ExecutionOracle.sol";
import {IPricing} from "./interfaces/IPricing.sol";
import {ISessions} from "./interfaces/ISessions.sol";

/// @notice Tape execution without a fixed pricing wait. Wallet authorization, collateral,
///         pricing, queues, fees and permissionless exits follow the original Exchange.
/// @dev Each manual execution needs a price-signer attestation for that exact order digest.
///      This deliberately trusts the signer to quote promptly from a fresh source and to retain
///      the first quote per order. Ethereum inclusion still follows pricing. A generic historical
///      market print cannot execute a manual open or close.
contract FastExchange is Exchange {
    mapping(bytes32 id => uint64 observedAt) private _executionTime;
    event PositionPricingTime(bytes32 indexed id, uint64 observedAt);

    constructor(
        string memory name_,
        IERC20 usdc_,
        ExecutionOracle oracle_,
        IPricing pricing_,
        ISessions sessions_,
        address owner_,
        address devRecipient_,
        uint256 stakerCap_,
        uint96 minMargin_
    ) Exchange(name_, usdc_, oracle_, pricing_, sessions_, owner_, devRecipient_, stakerCap_, minMargin_) {}

    function EXEC_DELAY() public pure override returns (uint64) {
        return 0;
    }

    function _requireWalletAuth(address owner, bytes32 digest, bytes calldata signature)
        internal
        view
        override
    {
        if (!ExecutionOracle(address(oracle)).checkWalletSignature(owner, digest, signature)) revert BadSignature();
    }

    function _openPrice(OpenIntent calldata it, bytes32 id, bytes[] calldata update)
        internal
        override
        returns (uint64 price, uint64 conf, uint64 publishTime)
    {
        uint64 observedAt;
        (price, conf, publishTime, observedAt) = ExecutionOracle(address(oracle)).fill(
            _markets[it.market].feedId, id, update, it.timestamp, it.timestamp + PIN_WINDOW
        );
        _executionTime[id] = observedAt;
        emit PositionPricingTime(id, observedAt);
    }

    function _intentClosePrice(CloseIntent calldata it, Position memory p, bytes[] calldata update)
        internal
        view
        override
        returns (uint64 price)
    {
        Market storage m = _markets[p.market];
        if (m.retired) return m.frozenPrice;
        uint64 observedAt;
        (price,,, observedAt) = ExecutionOracle(address(oracle)).fill(
            m.feedId, _hashClose(it), update, it.timestamp, it.timestamp + PIN_WINDOW
        );
        // An order-bound quote can close after an open within the same second. Its provenance
        // comes from the signed order digest, rather than selecting a public print for that second.
        if (observedAt <= _executionTime[it.positionId]) revert CloseNotAfterOpen();
    }

    function _triggerPrice(Position memory, uint64 touchedPrice, uint64, bytes[] calldata)
        internal
        pure
        override
        returns (uint64)
    {
        // The trigger was authorized before this touch. Its actual crossing print fixes the fill;
        // there is no delayed print for the operator to select after seeing the crossing.
        return touchedPrice;
    }

    function _triggerTouch(TriggerIntent calldata it, Position memory p, bytes[] calldata touch)
        internal
        view
        override
        returns (uint64 price, uint64 touchedAt)
    {
        uint64 afterTime = _executionTime[it.positionId];
        // Trigger timestamps use whole seconds. Requiring a later second prevents a newly signed
        // trigger selecting an already-known tick from the same second. Existing triggers have no
        // extra wait when they cross, and can fire within the position's opening second.
        uint64 afterSignature = (it.timestamp + 1) * 1000 - 1;
        if (afterSignature > afterTime) afterTime = afterSignature;
        (price,, touchedAt,) = ExecutionOracle(address(oracle)).afterMs(
            _markets[p.market].feedId, touch, afterTime
        );
    }

    function _liquidationPrice(bytes32 id, Position memory p, bytes[] calldata update)
        internal
        view
        override
        returns (uint64 price, uint64 publishTime)
    {
        (price,, publishTime,) = ExecutionOracle(address(oracle)).afterMs(
            _markets[p.market].feedId, update, _executionTime[id]
        );
    }

    function _removePosition(bytes32 id, Position memory p) internal override {
        super._removePosition(id, p);
        delete _executionTime[id];
    }
}
