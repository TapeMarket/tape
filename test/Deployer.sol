// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployable} from "../script/Deployable.sol";

/// @dev Lets a test suite run on either build of the protocol's contracts.
///
///      By default the tests create contracts from the project's own build, like any Foundry test.
///      What goes on the chain is another build of the same source: each contract compiled with
///      nothing but its own imports, the way Etherscan compiles it (tools/deployable.mjs). For the
///      Exchange the two are not the same bytes. So before a deployment the whole suite is run
///      once more on the shipping bytecode:
///
///          node tools/deployable.mjs
///          DEPLOYABLE=true forge test
abstract contract Deployer is Test {
    bool internal fromDeployable = vm.envOr("DEPLOYABLE", false);

    /// @dev Creates `name` with ABI-encoded constructor arguments `args`: from deployable/ when
    ///      asked to, otherwise from `projectCode`, which is `type(Name).creationCode`.
    function _deployed(string memory name, bytes memory projectCode, bytes memory args)
        internal
        returns (address addr)
    {
        bytes memory initcode = abi.encodePacked(fromDeployable ? Deployable.code(name) : projectCode, args);
        assembly ("memory-safe") {
            addr := create(0, add(initcode, 0x20), mload(initcode))
        }
        require(addr != address(0), string.concat("creating ", name, " failed"));
    }
}
