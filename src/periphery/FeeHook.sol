// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "../LaunchCoin.sol";

/// @dev Uniswap v4's swap parameters, as the PoolManager passes them to a hook.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @dev As much of Uniswap v4's PoolManager as this hook uses.
interface IPoolManagerClaims {
    function unlock(bytes calldata data) external returns (bytes memory);
    function mint(address to, uint256 id, uint256 amount) external;
    function burn(address from, uint256 id, uint256 amount) external;
    function take(address currency, address to, uint256 amount) external;
    function balanceOf(address owner, uint256 id) external view returns (uint256);
}

/// @title FeeHook
/// @notice A Uniswap v4 hook that takes 1% of the ETH side of every trade in an ETH pool, for one
///         fixed address. That is all it does.
/// @dev What it cannot do matters as much:
///
///      - It never refuses a trade. Neither callback has a condition under which it reverts when
///        the PoolManager calls it, whatever the size, the direction or the price. (A request for
///        more ETH than there is, 2^128 wei and up, is charged on 2^128 wei: a fee nobody can pay,
///        so it is the asker's own settlement that fails. Such a request cannot be left free
///        instead, or it would be the way to trade here without the fee.)
///      - It has no say over liquidity: adding it, removing it and collecting its fees never reach
///        this contract (its address carries the swap permissions and no others).
///      - The fee is a constant and the recipient is immutable. There is no owner and no setter.
///      - It holds no coin. Its fee is always ETH, kept inside the PoolManager as a claim until
///        `collect()` (anyone) sends all of it to the recipient. If the recipient could not be
///        paid, collecting would fail and trading would not notice.
///
///      A buy pays 1% of the ETH going in and a sell pays 1% of the ETH coming out, whichever of
///      the two amounts the trader fixed. This is on top of the pool's own fee, which goes to its
///      liquidity. In a pool whose first currency is not ETH the hook takes nothing.
///
///      When the amount the trader fixed is the ETH one, the fee is 1% of the amount asked for and
///      is taken before the swap. A swap that a price limit stops short has still paid on all it
///      asked for: asking for more than can be filled costs the asker, never the recipient. Uniswap's
///      own router sets no such limit.
///
///      Uniswap reads a hook's permissions from the low bits of its address, so this has to be
///      deployed at an address ending in `PERMISSIONS` (see script/HookMiner.sol).
contract FeeHook {
    /// @notice The fee, in millionths: 1%.
    uint256 public constant FEE_PIPS = 10_000;
    uint256 private constant ONE = 1_000_000;
    /// @notice beforeSwap, afterSwap, and the right of each to change what the swapper pays or gets.
    uint160 public constant PERMISSIONS = (1 << 7) | (1 << 6) | (1 << 3) | (1 << 2);
    /// @dev The ERC-6909 id the PoolManager keeps native ETH claims under.
    uint256 private constant ETH_ID = 0;

    IPoolManagerClaims public immutable poolManager;
    /// @notice Where every fee goes. Fixed for good.
    address public immutable feeRecipient;

    event Collected(address indexed to, uint256 amount);

    error NotPoolManager();
    error ZeroAddress();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManagerClaims poolManager_, address feeRecipient_) {
        if (address(poolManager_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        feeRecipient = feeRecipient_;
    }

    // ---------------------------------------------------------------------------------------- swaps

    /// @dev Called before every swap. When the amount the trader fixed is the ETH one, the fee comes
    ///      off here: ETH going in is swapped less the fee, ETH coming out is asked of the pool plus
    ///      the fee. The return value's upper half is what the hook takes of that currency.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int256, uint24)
    {
        uint256 fee;
        if (key.currency0 == address(0) && _ethIsFixed(params)) {
            fee = _feeOf(_magnitude(params.amountSpecified));
            _keep(fee);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return (this.beforeSwap.selector, int256(fee) << 128, 0);
    }

    /// @dev Called after every swap, with what the swap moved. When the amount the trader fixed is
    ///      the coin one, the ETH side is known only now, and the fee comes off here: the trader
    ///      pays that much more ETH for a buy, or gets that much less for a sell.
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, int256 delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        uint256 fee;
        if (key.currency0 == address(0) && !_ethIsFixed(params)) {
            // The ETH amount is the upper half of the delta: negative when the trader pays it.
            fee = _feeOf(_magnitude(delta >> 128));
            _keep(fee);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return (this.afterSwap.selector, int128(uint128(fee)));
    }

    /// @dev ETH is currency0, so a swap of 0 for 1 is a buy. The amount fixed is the input when it
    ///      is negative. A buy with its input fixed, or a sell with its output fixed, fixes ETH.
    function _ethIsFixed(SwapParams calldata params) private pure returns (bool) {
        return params.zeroForOne == (params.amountSpecified < 0);
    }

    /// @dev The size of `amount`. Unchecked, so the one int256 with no positive twin gives 2^255
    ///      and not a failed trade.
    function _magnitude(int256 amount) private pure returns (uint256) {
        unchecked {
            // forge-lint: disable-next-line(unsafe-typecast)
            return amount < 0 ? uint256(-amount) : uint256(amount);
        }
    }

    /// @dev 1% of `amount`, with the amount capped at what the PoolManager can move at all. Capped
    ///      and not waived: a swap asked for in a larger amount fills only as far as its price
    ///      limit allows, so waiving it would let that swap through without the fee. The result
    ///      stays far inside 128 bits.
    function _feeOf(uint256 amount) private pure returns (uint256) {
        if (amount > type(uint128).max) amount = type(uint128).max;
        return amount * FEE_PIPS / ONE;
    }

    /// @dev Books the fee the hook has just been credited as a claim on the PoolManager's ETH.
    function _keep(uint256 fee) private {
        if (fee != 0) poolManager.mint(address(this), ETH_ID, fee);
    }

    // ---------------------------------------------------------------------------------------- fees

    /// @notice ETH this hook has taken and not yet sent on.
    function pending() public view returns (uint256) {
        return poolManager.balanceOf(address(this), ETH_ID);
    }

    /// @notice Sends everything taken so far to `feeRecipient`. Anyone may call it.
    function collect() external returns (uint256 amount) {
        amount = pending();
        if (amount == 0) return 0;
        poolManager.unlock(abi.encode(amount));
        emit Collected(feeRecipient, amount);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        uint256 amount = abi.decode(data, (uint256));
        poolManager.burn(address(this), ETH_ID, amount);
        poolManager.take(address(0), feeRecipient, amount);
        return "";
    }
}
