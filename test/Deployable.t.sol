// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {Deployable} from "../script/Deployable.sol";

/// @notice What is deployed is not the project's own build but deployable/ (tools/deployable.mjs).
///         These hold that folder, when the suite is run on it, to being current and to being what
///         the tests actually ran against.
///
///             node tools/deployable.mjs && DEPLOYABLE=true forge test
contract DeployableTest is Base {
    modifier onDeployable() {
        if (!fromDeployable) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// @dev A source edited after deployable/ was built would have the suite pass on old bytecode.
    function test_deployableWasBuiltFromTheseSources() public onDeployable {
        Deployable.requireFresh();
    }

    function test_theSuiteRunsOnTheDeployableBytecode() public onDeployable {
        // Immutables are written into the code at creation, so the bytes differ there and only
        // there: same length, and the same code either side of them.
        bytes memory shipped = vm.getDeployedCode("deployable/Exchange.json");
        bytes memory running = address(ex).code;
        assertEq(running.length, shipped.length, "the Exchange under test is not the deployable one");
        uint256 same;
        for (uint256 i; i < running.length; ++i) {
            if (running[i] == shipped[i]) ++same;
        }
        // Eight immutables of at most 32 bytes, each used a handful of times.
        assertGt(same, running.length - 3_000);
    }

    function test_everyContractFits() public onDeployable {
        string[18] memory names = [
            "Exchange",
            "Pricing",
            "SignedOracle",
            "PythOracle",
            "Sessions",
            "Lens",
            "Gateway",
            "Batcher",
            "Deposits",
            "SignedSweeper",
            "Sweeper",
            "Coin",
            "LaunchCoin",
            "FeeHook",
            "Staking",
            "LossMining",
            "Jackpot",
            "FeeSplitter"
        ];
        for (uint256 i; i < names.length; ++i) {
            uint256 size = vm.getDeployedCode(string.concat("deployable/", names[i], ".json")).length;
            assertGt(size, 0, names[i]);
            assertLe(size, 24_576, string.concat(names[i], " does not fit in a contract"));
        }
    }

    /// @dev Either build is the same contract to anyone calling it.
    function test_theDomainIsTheStandardOne() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("TAPE"),
                keccak256("1"),
                block.chainid,
                address(ex)
            )
        );
        assertEq(ex.domainSeparator(), expected);
        assertEq(Exchange(address(ex)).FEE_BPS(), 200);
    }
}
