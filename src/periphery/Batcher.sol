// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Exchange} from "../Exchange.sol";

/// @title Batcher
/// @notice Puts many Exchange calls into one transaction, each succeeding or failing on its own.
/// @dev The relayer signs one transaction for a whole block's worth of orders instead of one each.
///      One order that no longer applies (its position was busted a moment earlier, say) must not
///      sink the others, so every call is made separately and a failure is only reported.
///
///      The Exchange lists this contract as an operator. It passes calls on only from addresses
///      the Exchange itself lists as operators, so it gives nobody a power they did not have. It
///      holds no funds and has no owner.
contract Batcher {
    Exchange public immutable exchange;

    event CallFailed(uint256 index, bytes reason);

    error NotOperator();

    constructor(Exchange exchange_) {
        exchange = exchange_;
    }

    /// @notice Makes each call on the Exchange in order.
    /// @return ok Which of them went through. The rest are in `CallFailed` events, with the reason.
    function multicall(bytes[] calldata calls) external returns (bool[] memory ok) {
        if (!exchange.isOperator(msg.sender)) revert NotOperator();
        ok = new bool[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool success, bytes memory result) = address(exchange).call(calls[i]);
            ok[i] = success;
            if (!success) emit CallFailed(i, result);
        }
    }
}
