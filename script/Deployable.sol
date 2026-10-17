// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @title Deployable
/// @notice Creates contracts from the artifacts in deployable/, not from the project's own build.
/// @dev With `via_ir` the compiler can make different bytecode of one contract depending on what
///      else is compiled with it, and Etherscan compiles a contract with nothing but its own
///      imports. tools/deployable.mjs builds each contract exactly that way; deploying those
///      artifacts is what makes a deployment verifiable (see that file for the whole story).
///
///      The artifacts are only as good as the sources they were built from, so `requireFresh`
///      compares every source file with the hash taken when they were built and stops the script
///      if one has changed. A script also needs forge's own build to be the same bytes
///      (`requireForgeAgrees`): `forge script` works out each created contract's constructor
///      arguments from its own build of that contract, and fails with a decoding error, before
///      sending anything, when that is another compilation of the same source.
library Deployable {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string private constant DIR = "deployable/";

    /// @notice Stops unless deployable/ was built from the sources as they are now.
    function requireFresh() internal view {
        string memory manifest;
        try VM.readFile(string.concat(DIR, "manifest.json")) returns (string memory text) {
            manifest = text;
        } catch {
            revert("deployable/ is missing: run node tools/deployable.mjs");
        }
        string[] memory paths = VM.parseJsonKeys(manifest, ".sources");
        require(paths.length != 0, "deployable/manifest.json lists no sources");
        for (uint256 i; i < paths.length; ++i) {
            bytes32 built = VM.parseJsonBytes32(manifest, string.concat('.sources["', paths[i], '"]'));
            require(
                sha256(bytes(VM.readFile(paths[i]))) == built,
                string.concat(paths[i], " changed since deployable/ was built: run node tools/deployable.mjs")
            );
        }
    }

    /// @notice Stops unless forge's own build of every contract is the bytes in deployable/.
    function requireForgeAgrees() internal view {
        string memory manifest = VM.readFile(string.concat(DIR, "manifest.json"));
        string[] memory names = VM.parseJsonKeys(manifest, ".contracts");
        require(
            names.length != 0,
            "deployable/manifest.json lists no contracts: run node tools/deployable.mjs --forge"
        );
        for (uint256 i; i < names.length; ++i) {
            string memory own = VM.parseJsonString(manifest, string.concat(".contracts.", names[i]));
            require(
                keccak256(VM.getCode(own)) == keccak256(code(names[i])),
                string.concat(
                    "forge's own build of ",
                    names[i],
                    " is not the one in deployable/: run node tools/deployable.mjs --forge"
                )
            );
        }
    }

    /// @notice Everything a deploy script needs of deployable/ before it sends anything.
    function requireReady() internal view {
        requireFresh();
        requireForgeAgrees();
    }

    /// @notice The creation code of `name` as it will be verified.
    function code(string memory name) internal view returns (bytes memory) {
        return VM.getCode(string.concat(DIR, name, ".json"));
    }

    /// @notice Creates `name` with ABI-encoded constructor arguments `args`.
    /// @dev Inlined into the caller, so under `vm.startBroadcast` this is a transaction of the
    ///      broadcaster's like any `new`.
    function create(string memory name, bytes memory args) internal returns (address addr) {
        bytes memory initcode = abi.encodePacked(code(name), args);
        assembly ("memory-safe") {
            addr := create(0, add(initcode, 0x20), mload(initcode))
        }
        require(addr != address(0), string.concat("creating ", name, " failed"));
    }
}
