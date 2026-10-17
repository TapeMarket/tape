// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Finds and uses the address a Uniswap v4 hook has to be deployed at.
/// @dev Uniswap reads which callbacks a hook wants from the low 14 bits of its address. So a hook is
///      deployed with CREATE2, through the deployer every chain has at the same address, with a
///      salt tried until the address comes out ending in exactly the permissions the hook is
///      written for. One salt in 16,384 does.
library HookMiner {
    /// @dev The deterministic deployment proxy (Arachnid's): calldata is salt ++ initcode, and it
    ///      answers with the 20 bytes of the address it created.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant PERMISSION_BITS = (1 << 14) - 1;

    /// @notice The first salt that puts `initcode` at an address ending in `permissions`, and that
    ///         address. The same initcode always gives the same answer.
    function find(bytes memory initcode, uint160 permissions) internal pure returns (bytes32 salt, address hook) {
        bytes32 codeHash = keccak256(initcode);
        for (uint256 i; i < 1_000_000; ++i) {
            salt = bytes32(i);
            hook = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, codeHash))))
            );
            if (uint160(hook) & PERMISSION_BITS == permissions) return (salt, hook);
        }
        revert("no salt found for the hook's address");
    }

    /// @notice Deploys `initcode` with `salt` and returns where it landed. If it is there already,
    ///         that is this very contract (the address is made from the initcode, constructor
    ///         arguments and all, whoever sent it), and nothing is deployed.
    function deploy(bytes memory initcode, bytes32 salt) internal returns (address hook) {
        require(CREATE2_DEPLOYER.code.length != 0, "the CREATE2 deployer is not on this chain");
        hook = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(initcode)))))
        );
        if (hook.code.length != 0) return hook;
        (bool ok, bytes memory out) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initcode));
        require(ok && out.length == 20 && address(bytes20(out)) == hook, "deploying the hook failed");
        require(hook.code.length != 0, "the hook has no code");
    }
}
