// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

interface IExchangeDepositFor {
    function depositFor(address user, uint256 amount) external;
}

/// @notice What sits at a deposit address once something has been collected from it.
/// @dev It hands the tokens it holds to wherever the Deposits contract that made it says, and
///      answers nobody else. It has no other function and cannot hold ETH.
contract DepositBox {
    using SafeERC20 for IERC20;

    address private immutable deposits;

    error NotDeposits();

    constructor() {
        deposits = msg.sender;
    }

    function empty(IERC20 token, address to) external returns (uint256 amount) {
        if (msg.sender != deposits) revert NotDeposits();
        amount = token.balanceOf(address(this));
        if (amount != 0) token.safeTransfer(to, amount);
    }
}

/// @title Deposits
/// @notice Gives every wallet its own deposit address. USDC sent there, by a plain transfer from
///         any wallet or exchange, becomes that wallet's balance on the Exchange.
/// @dev Why this exists beside the Gateway: a deposit through the Gateway is a signed permit, and
///      a deposit straight into the Exchange needs an approval. Wallets warn about both when the
///      contract being approved is new to them. A transfer is neither: the trader gives nobody
///      permission to move anything.
///
///      A wallet's deposit address is fixed by the wallet's own address (CREATE2), and exists
///      before anything is deployed there. `collect` puts the box there if it is not there yet,
///      takes the USDC it holds and deposits it for that wallet. Anyone may call it, for any
///      wallet: whatever is at a wallet's deposit address can only ever become that wallet's
///      Exchange balance. Nothing here can send it anywhere else, and there is no owner.
///
///      Any other token sent to a deposit address by mistake can be sent back to the wallet the
///      address belongs to (`recover`). ETH cannot be sent to a box at all once it is deployed;
///      before that, ETH sent to the bare address stays there for good, as with any wrong address.
///
///      A wallet can also take back USDC of its own that is still waiting at its address
///      (`reclaim`). Nobody can do that for it. It is the way out if collecting ever stops working,
///      which only the token's issuer could cause (by freezing this contract or the Exchange).
///
///      A deposit address has no key. USDC sent to it on another chain can only be reached by this
///      same contract standing at this same address there, which only the wallet that deployed
///      this one can arrange (same wallet, same nonce). Keep that wallet's key.
///
///      This contract holds nothing between calls. USDC sent to THIS contract's own address,
///      instead of to a deposit address, is not anyone's deposit and cannot be taken out.
contract Deposits {
    IERC20 public immutable usdc;
    IExchangeDepositFor public immutable exchange;
    /// @notice The code every deposit address runs, through a minimal proxy (EIP-1167).
    address public immutable box;

    event Collected(address indexed user, uint256 amount);
    event Reclaimed(address indexed user, uint256 amount);
    /// @dev `amount` is what the token itself reported: of a token nobody knows, take it as a claim.
    event Recovered(address indexed user, address indexed token, uint256 amount);

    error ZeroAddress();
    error NothingToCollect();
    error UsdcIsCollected();

    constructor(IERC20 usdc_, IExchangeDepositFor exchange_) {
        if (address(usdc_) == address(0) || address(exchange_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
        exchange = exchange_;
        box = address(new DepositBox());
        // Deposits are pulled from this contract by the Exchange, in the same call they arrive in.
        SafeERC20.forceApprove(usdc_, address(exchange_), type(uint256).max);
    }

    /// @notice The address `user` sends USDC to. The same for good, whether or not it has been
    ///         used yet.
    function addressOf(address user) public view returns (address) {
        return Clones.predictDeterministicAddress(box, _salt(user));
    }

    /// @notice USDC waiting at `user`'s deposit address.
    function pending(address user) external view returns (uint256) {
        return usdc.balanceOf(addressOf(user));
    }

    /// @notice Deposits whatever USDC is at `user`'s deposit address into `user`'s Exchange balance.
    function collect(address user) external returns (uint256 amount) {
        if (user == address(0)) revert ZeroAddress();
        amount = _boxOf(user).empty(usdc, address(this));
        if (amount == 0) revert NothingToCollect();
        exchange.depositFor(user, amount);
        emit Collected(user, amount);
    }

    /// @notice Sends the USDC waiting at the caller's own deposit address back to the caller.
    /// @dev Only for oneself, so it cannot be used to undo somebody else's deposit before it is
    ///      collected. It does not pass through this contract or the Exchange.
    function reclaim() external returns (uint256 amount) {
        amount = _boxOf(msg.sender).empty(usdc, msg.sender);
        if (amount == 0) revert NothingToCollect();
        emit Reclaimed(msg.sender, amount);
    }

    /// @notice Sends another token, sent to `user`'s deposit address by mistake, to `user`'s wallet.
    /// @dev Not USDC: that is a deposit, and bouncing it back would let anyone undo one before it
    ///      was collected.
    function recover(address user, IERC20 token) external returns (uint256 amount) {
        if (user == address(0)) revert ZeroAddress();
        if (token == usdc) revert UsdcIsCollected();
        amount = _boxOf(user).empty(token, user);
        emit Recovered(user, address(token), amount);
    }

    function _salt(address user) private pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev The box at `user`'s deposit address, deployed now if this is its first use.
    function _boxOf(address user) private returns (DepositBox) {
        address at = Clones.predictDeterministicAddress(box, _salt(user));
        if (at.code.length == 0) Clones.cloneDeterministic(box, _salt(user));
        return DepositBox(at);
    }
}
