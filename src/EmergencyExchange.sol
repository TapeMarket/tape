// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ExchangeState} from "./base/ExchangeState.sol";
import {IOracle} from "./interfaces/IOracle.sol";
import {IPricing} from "./interfaces/IPricing.sol";
import {ISessions} from "./interfaces/ISessions.sol";
import {EmergencyCustodyVault} from "./EmergencyCustodyVault.sol";

interface IMigrationExchange {
    function usdc() external view returns (IERC20);
    function balances(address user) external view returns (uint256);
    function depositFor(address user, uint256 amount) external;
    function donate(uint256 amount) external;
}

/// @notice Recovery implementation: trading and deposits have no callable entry points.
/// @dev Installed immediately by HybridUpgradeController.emergencyPause. It shares the exact
///      exchange state prefix, leaves FastExchange's execution timestamps untouched, and uses a
///      separate namespace for recovery configuration. Upgrading back requires an owner action.
///      Only free balances move. Open margin, queue liabilities and accrued fees stay reserved.
contract EmergencyExchange is ExchangeState {
    using SafeERC20 for IERC20;

    // ERC-7201: keccak256(abi.encode(uint256(keccak256("tape.exchange.recovery")) - 1)) & ~bytes32(uint256(0xff)).
    bytes32 private constant RECOVERY_SLOT =
        0x00ec7a576f8ec9dd633aab085d76792e7397da17db002385e54637c6e8110600;

    struct RecoveryState {
        address target;
        bytes32 targetCodeHash;
        EmergencyCustodyVault vault;
    }

    event MigrationTargetSet(address indexed target, bytes32 codeHash);
    event BalanceMigrated(address indexed user, address indexed target, uint256 amount);
    event HouseMigrated(address indexed target, uint256 amount);
    event EmergencyEvacuated(address indexed vault, uint256 amount);
    event CustodyRestored(uint256 amount);
    error InvalidMigrationTarget();
    error MigrationCreditMismatch();
    error OutstandingLiabilities();

    constructor(IERC20 usdc_, IOracle oracle_, IPricing pricing_, ISessions sessions_, uint256 stakerCap_)
        ExchangeState("Tape", usdc_, oracle_, pricing_, sessions_, address(this), address(this), stakerCap_, 0)
    {}

    function _recovery() private pure returns (RecoveryState storage state) {
        bytes32 slot = RECOVERY_SLOT;
        assembly ("memory-safe") { state.slot := slot }
    }

    function migrationTarget() external view returns (address) { return _recovery().target; }
    function custodyVault() external view returns (address) { return address(_recovery().vault); }

    /// @dev Only the proxy's own ProxyAdmin can enter recovery, atomically with its upgrade.
    function activateEmergency() external {
        _requireProxyAdmin();
        opensPaused = true;
        delete _recovery().target;
        delete _recovery().targetCodeHash;
    }

    function _requireProxyAdmin() private view {
        address admin = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"01")))));
        if (msg.sender != admin) revert BadParams();
    }

    /// @notice Moves all actual USDC into a newly created, source-bound rescue vault.
    /// @dev Liabilities and balances remain on this proxy. This is custody evacuation, not a
    ///      settlement or cancellation of positions, queue claims or fee entitlements.
    function evacuateToVault() external nonReentrant {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        RecoveryState storage state = _recovery();
        if (address(state.vault) == address(0)) state.vault = new EmergencyCustodyVault(usdc, address(this));
        uint256 amount = usdc.balanceOf(address(this));
        if (amount != 0) usdc.safeTransfer(address(state.vault), amount);
        emit EmergencyEvacuated(address(state.vault), amount);
    }

    /// @dev The controller recalls custody atomically before installing reviewed trading code.
    function restoreCustody() external nonReentrant {
        _requireProxyAdmin();
        EmergencyCustodyVault vault = _recovery().vault;
        if (address(vault) == address(0)) return;
        uint256 amount = usdc.balanceOf(address(vault));
        delete _recovery().vault;
        if (amount != 0) vault.release(amount);
        emit CustodyRestored(amount);
    }

    function _ensureLiquidity(uint256 amount) private {
        uint256 held = usdc.balanceOf(address(this));
        if (held < amount) {
            EmergencyCustodyVault vault = _recovery().vault;
            if (address(vault) == address(0)) revert InsufficientBalance();
            vault.release(amount - held);
        }
    }

    /// @notice Approves the same-collateral replacement exchange; zero revokes approval.
    /// @dev The owner is trusted to choose and verify the replacement's code and administration.
    function setMigrationTarget(address target) external onlyOwner {
        if (target != address(0)) {
            if (target == address(this) || target.code.length == 0
                || address(IMigrationExchange(target).usdc()) != address(usdc)) revert InvalidMigrationTarget();
        }
        RecoveryState storage state = _recovery();
        state.target = target;
        state.targetCodeHash = target == address(0) ? bytes32(0) : target.codehash;
        emit MigrationTargetSet(target, state.targetCodeHash);
    }

    /// @notice Immediately withdraws the caller's free balance to their own wallet.
    /// @dev No operator or delayed request is needed because all trading is disabled.
    function emergencyWithdraw(uint256 amount) external nonReentrant {
        _debit(msg.sender, amount);
        _ensureLiquidity(amount);
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, msg.sender, amount);
    }

    /// @notice Anyone may move a free balance to the same wallet on the approved replacement.
    /// @dev Neither the caller nor the administrator can choose a different beneficiary. A
    ///      failed deposit, changed target code or incorrect credit rolls back the entire move.
    function migrateBalance(address user, uint256 amount) external nonReentrant {
        IMigrationExchange target = _target();
        uint256 beforeCredit = target.balances(user);
        _ensureLiquidity(amount);
        uint256 beforeCash = usdc.balanceOf(address(target));
        uint256 beforeSourceCash = usdc.balanceOf(address(this));
        _debit(user, amount);
        usdc.forceApprove(address(target), amount);
        target.depositFor(user, amount);
        usdc.forceApprove(address(target), 0);
        if (target.balances(user) != beforeCredit + amount
            || usdc.balanceOf(address(target)) != beforeCash + amount
            || usdc.balanceOf(address(this)) != beforeSourceCash - amount) revert MigrationCreditMismatch();
        emit Withdrawn(user, address(target), amount);
        emit BalanceMigrated(user, address(target), amount);
    }

    /// @notice Moves only unencumbered house USDC after positions and queued winnings are settled.
    /// @dev User balances and both fee shares remain backed in this contract. Unfunded queued
    ///      winnings are never represented as transferable cash or silently cancelled.
    function migrateHouse(uint256 amount) external onlyOwner nonReentrant {
        if (totalCashMargin != 0 || debtMarginOpen != 0 || totalQueued != 0) revert OutstandingLiabilities();
        if (amount == 0) revert ZeroAmount();
        if (amount > lpCash()) revert InsufficientBalance();
        IMigrationExchange target = _target();
        _ensureLiquidity(amount);
        uint256 beforeCash = usdc.balanceOf(address(target));
        treasury -= amount;
        usdc.forceApprove(address(target), amount);
        target.donate(amount);
        usdc.forceApprove(address(target), 0);
        if (usdc.balanceOf(address(target)) != beforeCash + amount) revert MigrationCreditMismatch();
        emit HouseMigrated(address(target), amount);
    }

    function _target() private view returns (IMigrationExchange target) {
        RecoveryState storage state = _recovery();
        if (state.target == address(0) || state.target.codehash != state.targetCodeHash) revert InvalidMigrationTarget();
        target = IMigrationExchange(state.target);
    }

    function _debit(address user, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        if (balances[user] < amount) revert InsufficientBalance();
        balances[user] -= amount;
        totalBalances -= amount;
        treasury -= amount;
        ++withdrawNonces[user];
    }

    function lpCash() public view returns (uint256) {
        return treasury - totalBalances - totalCashMargin - stakerFees - devFees;
    }

    function lpExcess() external pure returns (uint256) { return 0; }

    // Preserve reads needed to inspect the frozen book and prepare a repair.
    function getPosition(bytes32 id) external view returns (Position memory) { return _positions[id]; }
    function openIdsOf(address user) external view returns (bytes32[] memory) { return _openIds[user]; }
    function marketCount() external view returns (uint256) { return _markets.length; }
    function getMarket(uint16 id) external view returns (Market memory) {
        if (id >= _markets.length) revert BadMarket();
        return _markets[id];
    }
}
