// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {FastExchange} from "./FastExchange.sol";
import {EmergencyExchange} from "./EmergencyExchange.sol";
import {ExecutionOracle} from "./ExecutionOracle.sol";

/// @notice Separates immediate emergency recovery from ordinary, owner-controlled code upgrades.
/// @dev The owner can be a multisig or TimelockController. The guardian can install only the
///      precommitted recovery implementation, never arbitrary code. Upgrades can change the
///      exchange's behavior and therefore require trust in the controller's owner.
contract HybridUpgradeController is Ownable2Step {
    ITransparentUpgradeableProxy public immutable proxy;
    ProxyAdmin public immutable proxyAdmin;
    address public immutable emergencyImplementation;
    address public immutable collateral;
    address public immutable sessions;
    address public guardian;
    bool public emergencyPaused;

    event EmergencyPaused(address indexed guardian);
    event ExchangeUpgraded(address indexed implementation);
    event GuardianSet(address indexed guardian);
    error InvalidImplementation();
    error NotGuardian();

    constructor(address owner_, address guardian_, address proxy_, EmergencyExchange recovery)
        Ownable(owner_)
    {
        require(guardian_ != address(0) && proxy_ != address(0), "Zero address");
        require(address(recovery).code.length != 0, "Missing recovery code");
        proxy = ITransparentUpgradeableProxy(proxy_);
        // OZ's transparent proxy creates its ProxyAdmin as its first CREATE.
        proxyAdmin = ProxyAdmin(address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", proxy_, hex"01"))))));
        emergencyImplementation = address(recovery);
        collateral = address(recovery.usdc());
        sessions = address(recovery.sessions());
        require(ExecutionOracle(address(recovery.oracle())).exchange() == proxy_, "Wrong recovery oracle");
        guardian = guardian_;
    }

    function setGuardian(address guardian_) external onlyOwner {
        require(guardian_ != address(0), "Zero guardian");
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Immediately freezes trading and installs the independently built withdrawal path.
    function emergencyPause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        if (emergencyPaused) return;
        emergencyPaused = true;
        proxyAdmin.upgradeAndCall(proxy, emergencyImplementation, abi.encodeCall(EmergencyExchange.activateEmergency, ()));
        emit EmergencyPaused(msg.sender);
    }

    /// @notice Installs reviewed trading code or a repaired implementation at the same address.
    /// @dev The release process must check storage layout and rehearse actual state before this
    ///      is scheduled or executed. These dependency checks cannot prove arbitrary code safe.
    function upgrade(address implementation, bytes calldata initialization) external onlyOwner {
        if (implementation == emergencyImplementation || implementation.code.length == 0) revert InvalidImplementation();
        FastExchange candidate = FastExchange(implementation);
        if (address(candidate.usdc()) != collateral || address(candidate.sessions()) != sessions
            || address(candidate.pricing()).code.length == 0 || candidate.EXEC_DELAY() != 0
            || ExecutionOracle(address(candidate.oracle())).exchange() != address(proxy)) revert InvalidImplementation();
        if (emergencyPaused) proxyAdmin.upgradeAndCall(proxy, emergencyImplementation,
            abi.encodeCall(EmergencyExchange.restoreCustody, ()));
        emergencyPaused = false;
        proxyAdmin.upgradeAndCall(proxy, implementation, initialization);
        emit ExchangeUpgraded(implementation);
    }
}
