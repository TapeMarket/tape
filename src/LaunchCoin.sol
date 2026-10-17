// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IPositionManager {
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function approve(address spender, uint256 tokenId) external;
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @dev UNCX's liquidity locker for Uniswap v4 positions (UniV4LiquidityLockerV3).
interface ILiquidityLocker {
    function lockNFTPosition(uint256 tokenId, uint256 unlockTime, bool mintLockNFT)
        external
        payable
        returns (uint256 lockId);
    function transferLockOwnership(uint256 lockId, address newOwner) external;
    function flatFee() external view returns (uint256);
    function lpFee() external view returns (uint256);
}

/// @title LaunchCoin
/// @notice A fixed-supply ERC-20 that opens its own Uniswap v4 pool against ETH and locks that
///         liquidity in UNCX's liquidity locker in the same transaction.
/// @dev The supply is minted once, in two parts:
///
///      - `reserve` goes to `reserveTo`: the coin the exchange's loss mining will pay out.
///      - the rest stays in this contract until `launch()` (the owner, once) creates the ETH pool,
///        puts all of it in as one single-sided position, and hands that position to the locker
///        until `lockFor` has passed. The lock is then made over to `lockOwner`. From there it is
///        the locker's business and no longer this contract's: the lock's owner collects the
///        position's trading fees there, and can withdraw the position, or lock it for longer,
///        once the lock has run out, and not a moment before. This contract keeps nothing: no
///        position, no fees, and no function that touches either.
///
///      The locker takes a cut for holding it: a flat fee in ETH, a share of the liquidity when
///      it is locked, and a share of the fees collected. `launch()` is told the most it may take
///      of the liquidity and reverts if the locker asks for more.
///
///      The pool can be opened with a Uniswap v4 hook (`hook`, or the zero address for none). A
///      hook is a contract the pool calls on every swap, and it is part of the pool for good. This
///      contract does not look inside it: whoever launches answers for what it does.
///
///      While `limitsInEffect`, no wallet may end a transfer holding more than `maxWallet`. The
///      pool (Uniswap's PoolManager), this contract and the burn address are outside that, and so
///      is whatever the owner names with `setExempt` BEFORE the launch: the exchange's loss mining
///      and staking contracts, which hold coin for many people. Every exemption is an `Exempted`
///      event and shows in `isExempt`; nothing can be exempted once the pool is open; the owner
///      is under the limit like anyone else unless it is in that list. `removeLimits()` switches
///      the limit off for good; it cannot be switched back on. The limit is on what an address
///      holds, not on a person: coin staked, or put into a pool as liquidity, is not in a wallet.
///
///      The owner can do four things and nothing else: exempt before the launch, launch once,
///      remove the limit, and give the role up once the pool is open and the limit is off. No
///      mint, no tax, no blacklist, no pause.
contract LaunchCoin is ERC20, ERC20Burnable, ERC20Permit {
    // Uniswap v4 on Ethereum mainnet.
    address public constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    IPositionManager public constant POSITION_MANAGER = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice UNCX's Uniswap v4 liquidity locker on Ethereum mainnet.
    ILiquidityLocker public constant LOCKER = ILiquidityLocker(0x147AECa171a79466Fe9E2c03f21b45155Ff403F8);
    /// @notice The shortest a launch may lock the liquidity for.
    uint256 public constant MIN_LOCK = 30 days;

    /// @notice The most a wallet may hold while `limitsInEffect`.
    uint256 public immutable maxWallet;
    /// @notice What `launch()` puts in the pool: the supply less the mining reserve.
    uint256 public immutable poolSupply;

    /// @notice Exempts before the launch, launches once, removes the limit once. Nothing else.
    address public owner;
    bool public limitsInEffect;
    mapping(address => bool) public isExempt;
    /// @notice The Uniswap v4 position the launch made and locked (0 until the launch).
    uint256 public lpTokenId;
    /// @notice Its lock in the locker, and when that lock was made to run out.
    uint256 public lockId;
    uint256 public lockedUntil;
    PoolKey public poolKey;

    event Launched(
        uint256 indexed lpTokenId, uint24 fee, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity
    );
    event LiquidityLocked(uint256 indexed lpTokenId, uint256 indexed lockId, uint256 until, address indexed lockOwner);
    event Exempted(address indexed account);
    event LimitsRemoved();
    event OwnershipRenounced();

    error NotOwner();
    error ZeroAddress();
    error BadParams();
    error AlreadyLaunched();
    error NotLaunched();
    error LimitsStillOn();
    error MaxWallet();
    error Expired();
    error PoolNotFilled();
    error LockTooShort();
    error NotTheLockersFee();
    error LockerTakesTooMuch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param supply        the whole supply, 18 decimals
    /// @param reserve       the part minted to `reserveTo` (loss mining); the rest goes into the pool
    /// @param maxWalletBps  the wallet limit in basis points of the supply (200 = 2%); 0 = no limit
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply,
        uint256 reserve,
        address reserveTo,
        uint256 maxWalletBps,
        address owner_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (reserve != 0 && reserveTo == address(0)) revert ZeroAddress();
        // Uniswap counts what a pool is owed as an int128, and something has to be left for the pool.
        if (reserve >= supply || supply > uint128(type(int128).max) || maxWalletBps > 10_000) revert BadParams();
        owner = owner_;
        maxWallet = supply * maxWalletBps / 10_000;
        poolSupply = supply - reserve;
        // Minted before the limit is on: the reserve is one holding far above it, on its way to
        // loss mining.
        if (reserve != 0) _mint(reserveTo, reserve);
        _mint(address(this), supply - reserve);
        limitsInEffect = maxWalletBps != 0;
    }

    // ---------------------------------------------------------------------------------------- limit

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (
            limitsInEffect && to != address(0) && to != POOL_MANAGER && to != address(this) && to != DEAD
                && !isExempt[to] && balanceOf(to) > maxWallet
        ) revert MaxWallet();
    }

    /// @notice Puts `account` outside the wallet limit. Only before the launch, and for good.
    function setExempt(address account) external onlyOwner {
        if (lpTokenId != 0) revert AlreadyLaunched();
        if (account == address(0)) revert ZeroAddress();
        isExempt[account] = true;
        emit Exempted(account);
    }

    /// @notice Switches the wallet limit off for good.
    function removeLimits() external onlyOwner {
        limitsInEffect = false;
        emit LimitsRemoved();
    }

    /// @notice Gives the owner role up. Only once the pool is open and the limit is off: before
    ///         that it would strand the pool's coin in this contract, or leave the limit on forever.
    function renounceOwnership() external onlyOwner {
        if (lpTokenId == 0) revert NotLaunched();
        if (limitsInEffect) revert LimitsStillOn();
        owner = address(0);
        emit OwnershipRenounced();
    }

    // ---------------------------------------------------------------------------------------- launch

    /// @notice Creates the ETH pool at `sqrtPriceX96`, adds `poolSupply` as one single-sided
    ///         position over [tickLower, tickUpper], and locks that position in the locker for
    ///         `lockFor`, in `lockOwner`'s name. The start price is the top of the range, so the
    ///         pool needs no ETH. What rounding leaves over is burned, and it has to be no more
    ///         than rounding: if the numbers given would put less than all but a millionth of
    ///         `poolSupply` in the pool, this reverts.
    /// @dev `fee` and `tickSpacing` are chosen now, so nobody can create the pool first to block
    ///      this: a pool that already exists at a dearer price makes the mint revert (this contract
    ///      pays no ETH into it), and the owner launches on another tier. One that exists at a
    ///      cheaper price changes nothing: there is no liquidity between it and the top of this
    ///      range.
    ///
    ///      `deadline` is for the transaction itself: a launch signed for a bundle and left over
    ///      must not open the pool, alone, an hour later.
    ///
    ///      `fee` is the pool's own trading fee, paid to its liquidity. `hook` is the pool's hook,
    ///      or the zero address: it is called on every swap in this pool for as long as it exists.
    ///
    ///      The ETH sent with the call has to be exactly the locker's flat fee: the locker keeps
    ///      whatever it is sent. `maxLockerLpFee` is the most of the liquidity the locker may take
    ///      for itself, in basis points; it can change its rates, and this refuses a dearer one.
    function launch(
        uint24 fee,
        int24 tickSpacing,
        address hook,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 deadline,
        uint256 lockFor,
        address lockOwner,
        uint256 maxLockerLpFee
    ) external payable onlyOwner {
        if (lpTokenId != 0) revert AlreadyLaunched();
        if (block.timestamp > deadline) revert Expired();
        if (lockOwner == address(0)) revert ZeroAddress();
        if (lockFor < MIN_LOCK) revert LockTooShort();
        // Uniswap accepts a hook address with nothing at it, and every swap would then fail for good.
        if (hook != address(0) && hook.code.length == 0) revert BadParams();
        if (msg.value != LOCKER.flatFee()) revert NotTheLockersFee();
        if (LOCKER.lpFee() > maxLockerLpFee) revert LockerTakesTooMuch();

        PoolKey memory key = PoolKey(address(0), address(this), fee, tickSpacing, hook);
        poolKey = key;
        POSITION_MANAGER.initializePool(key, sqrtPriceX96); // does nothing if it already exists

        // The casts below cannot truncate: the constructor refuses a supply above int128.
        // forge-lint: disable-start(unsafe-typecast)
        uint256 amount = poolSupply;
        // Coin anyone sent here before the launch is in this balance too. It is not the pool's.
        uint256 held = balanceOf(address(this));
        _approve(address(this), PERMIT2, amount);
        IPermit2(PERMIT2).approve(address(this), address(POSITION_MANAGER), uint160(amount), uint48(block.timestamp));

        uint256 id = POSITION_MANAGER.nextTokenId();
        bytes[] memory params = new bytes[](2);
        // amount0Max = 0: never any ETH. amount1Max = everything this contract holds for the pool.
        params[0] = abi.encode(
            key, tickLower, tickUpper, uint256(liquidity), uint128(0), uint128(amount), address(this), bytes("")
        );
        // forge-lint: disable-end(unsafe-typecast)
        params[1] = abi.encode(key.currency0, key.currency1);
        // MINT_POSITION, SETTLE_PAIR
        POSITION_MANAGER.modifyLiquidities(
            abi.encode(abi.encodePacked(uint8(0x02), uint8(0x0d)), params), block.timestamp
        );
        lpTokenId = id;

        _approve(address(this), PERMIT2, 0);
        uint256 left = balanceOf(address(this));
        // What went into the pool, whatever else was sitting here. A `liquidity` too small for the
        // range would otherwise open a thin pool and burn the rest of the supply as if it were dust.
        if (amount - (held - left) > amount / 1_000_000) revert PoolNotFilled();
        if (left != 0) _transfer(address(this), DEAD, left);
        emit Launched(id, fee, tickSpacing, tickLower, tickUpper, liquidity);

        // The locker pulls the position and takes its share of the liquidity. It records the caller
        // as the lock's owner, so the lock is made over to `lockOwner` straight after.
        uint256 until = block.timestamp + lockFor;
        POSITION_MANAGER.approve(address(LOCKER), id);
        uint256 lock = LOCKER.lockNFTPosition{value: msg.value}(id, until, false);
        LOCKER.transferLockOwnership(lock, lockOwner);
        require(POSITION_MANAGER.ownerOf(id) == address(LOCKER), "position not locked");
        lockId = lock;
        lockedUntil = until;
        emit LiquidityLocked(id, lock, until, lockOwner);
    }

    /// @notice Liquidity in the position the launch locked.
    function lockedLiquidity() external view returns (uint128) {
        return lpTokenId == 0 ? 0 : POSITION_MANAGER.getPositionLiquidity(lpTokenId);
    }
}
