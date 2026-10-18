// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FastExchange} from "../src/FastExchange.sol";
import {Exchange} from "../src/Exchange.sol";
import {Intents} from "../src/base/Intents.sol";
import {ExchangeState} from "../src/base/ExchangeState.sol";
import {ExecutionOracle} from "../src/ExecutionOracle.sol";
import {ExchangeBootstrap} from "../src/ExchangeBootstrap.sol";
import {HybridExchangeProxy} from "../src/HybridExchangeProxy.sol";
import {HybridUpgradeController} from "../src/HybridUpgradeController.sol";
import {EmergencyExchange} from "../src/EmergencyExchange.sol";
import {Pricing} from "../src/Pricing.sol";
import {Sessions} from "../src/Sessions.sol";
import {MockUSDC} from "./mocks/Mocks.sol";
import {EmergencyCustodyVault} from "../src/EmergencyCustodyVault.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract BrokenMigrationTarget {
    IERC20 public immutable usdc;
    mapping(address => uint256) public balances;
    bool public pull;
    constructor(IERC20 token, bool pull_) { usdc = token; pull = pull_; }
    function depositFor(address user, uint256 amount) external {
        if (pull) usdc.transferFrom(msg.sender, address(this), amount);
        balances[user] += pull ? amount - 1 : amount;
    }
    function donate(uint256) external {}
}

contract ReentrantMigrationTarget {
    IERC20 public immutable usdc;
    address public immutable source;
    mapping(address => uint256) public balances;
    bool public reentryBlocked;
    constructor(IERC20 token, address source_) { usdc = token; source = source_; }
    function depositFor(address user, uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        (bool ok,) = source.call(abi.encodeCall(EmergencyExchange.migrateBalance, (user, amount)));
        reentryBlocked = !ok;
        balances[user] += amount;
    }
}

contract HybridExchangeTest is Test {
    uint64 constant T = 1_800_000_000;
    uint256 constant USER_KEY = 0xA11CE;
    uint256 constant SIGNER_KEY = 0x51C4ED;
    bytes32 constant FEED = bytes32("hyperliquid:BTC");
    bytes32 constant OPEN = keccak256("Open(address owner,uint16 market,bool isLong,bool useQueued,uint16 leverage,uint96 margin,uint64 priceLimit,uint32 impactLimit,uint64 timestamp,uint64 salt)");
    bytes32 constant CLOSE = keccak256("Close(address owner,bytes32 positionId,uint64 timestamp)");
    MockUSDC usdc;
    Pricing pricing;
    Sessions sessions;
    ExchangeBootstrap bootstrap;
    ExecutionOracle oracle;
    FastExchange implementation;
    EmergencyExchange recoveryCode;
    EmergencyExchange recovery;
    HybridUpgradeController controller;
    FastExchange ex;
    address user;
    address guardian = address(0x6A);
    uint64 salt;

    function createArtifact(string memory name, bytes memory args) internal returns (address created) {
        bytes memory code = abi.encodePacked(vm.getCode(string.concat("deployable/hybrid/", name, ".json")), args);
        assembly ("memory-safe") { created := create(0, add(code, 32), mload(code)) }
        require(created != address(0), "Artifact deployment failed");
    }

    function setUp() public {
        vm.warp(T);
        user = vm.addr(USER_KEY);
        usdc = new MockUSDC();
        pricing = new Pricing();
        sessions = new Sessions("Tape");
        bootstrap = new ExchangeBootstrap();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 4);
        oracle = new ExecutionOracle(predicted, vm.addr(SIGNER_KEY));
        implementation = FastExchange(createArtifact("FastExchange", abi.encode("Tape", usdc, oracle, pricing,
            sessions, address(this), address(this), uint256(5_000_000e6), uint96(1e6))));
        recoveryCode = new EmergencyExchange(usdc, oracle, pricing, sessions, 5_000_000e6);
        controller = new HybridUpgradeController(address(this), guardian, predicted, recoveryCode);
        HybridExchangeProxy proxy = new HybridExchangeProxy(implementation, bootstrap, address(controller),
            ExchangeBootstrap.InitialConfig(address(this), guardian, address(this), 1e6, 0));
        assertEq(address(proxy), predicted);
        ex = FastExchange(address(proxy));
        recovery = EmergencyExchange(address(proxy));
        assertEq(controller.proxyAdmin().owner(), address(controller));
        assertEq(ex.owner(), address(this));
        assertTrue(ex.opensPaused());
        ex.setOperator(address(this), true);
        ex.listMarket(FEED, "BTC", 1000, Exchange.Curve(15_000, 814_598, 1e7, 476041580087574, type(uint32).max),
            9_000, 50, 10_000_000e6, 1e15, 1e15);
        ex.unpauseOpens();
        usdc.mint(user, 10_000e6);
        vm.startPrank(user);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(10_000e6);
        vm.stopPrank();
    }

    function digest(bytes32 domain, bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, h));
    }
    function sig(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }
    function fill(bytes32 id, uint64 price, uint64 ms) internal view returns (bytes[] memory data) {
        bytes32 h = digest(oracle.domainSeparator(), keccak256(abi.encode(oracle.FILL_TYPEHASH(), FEED, id, price, uint64(0), ms / 1000, ms)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, h);
        data = new bytes[](1);
        data[0] = abi.encode(FEED, id, price, uint64(0), ms / 1000, ms, v, r, s);
    }
    function opened() internal returns (bytes32 id) {
        Intents.OpenIntent memory it = Intents.OpenIntent(user, 0, true, false, 100, 100e6, 0, 0, T, ++salt);
        id = digest(ex.domainSeparator(), keccak256(abi.encode(OPEN, it.owner, it.market, it.isLong, it.useQueued,
            it.leverage, it.margin, it.priceLimit, it.impactLimit, it.timestamp, it.salt)));
        ex.open(it, sig(USER_KEY, id), fill(id, 80_000e8, T * 1000 + 100));
    }
    function closed(bytes32 id) internal {
        Intents.CloseIntent memory it = Intents.CloseIntent(user, id, T);
        bytes32 h = digest(ex.domainSeparator(), keccak256(abi.encode(CLOSE, user, id, T)));
        ex.close(it, sig(USER_KEY, h), fill(h, 80_100e8, T * 1000 + 200));
    }
    function paused() internal { vm.prank(guardian); controller.emergencyPause(); }
    function replacement() internal returns (FastExchange target) {
        target = FastExchange(createArtifact("FastExchange", abi.encode("Tape", usdc, oracle, pricing,
            sessions, address(this), address(this), uint256(5_000_000e6), uint96(1e6))));
        recovery.setMigrationTarget(address(target));
    }

    function test_guardianPausesImmediatelyAndUserCanExitWithoutOperator() public {
        bytes32 id = opened();
        paused();
        assertTrue(controller.emergencyPaused());
        assertTrue(recovery.opensPaused());
        assertEq(recovery.balances(user), 9_900e6);
        assertEq(recovery.getPosition(id).owner, user);
        vm.prank(user);
        recovery.emergencyWithdraw(9_900e6);
        assertEq(usdc.balanceOf(user), 9_900e6);
        assertEq(recovery.totalCashMargin(), 100e6);
        assertEq(usdc.balanceOf(address(ex)), 100e6);
        assertEq(recovery.withdrawNonces(user), 1);
    }
    function test_tradingDepositsAndOldWithdrawalRoutesAreDisabledInRecovery() public {
        bytes32 id = opened();
        Intents.CloseIntent memory it = Intents.CloseIntent(user, id, T);
        bytes32 h = digest(ex.domainSeparator(), keccak256(abi.encode(CLOSE, user, id, T)));
        bytes memory signature = sig(USER_KEY, h);
        bytes[] memory update = fill(h, 80_100e8, T * 1000 + 200);
        paused();
        vm.expectRevert();
        ex.deposit(1e6);
        vm.expectRevert();
        ex.close(it, signature, update);
        vm.expectRevert();
        ex.requestWithdraw(1e6);
    }
    function test_unauthorizedPauseUpgradeAndTargetChangesRevert() public {
        vm.prank(user); vm.expectRevert(HybridUpgradeController.NotGuardian.selector);
        controller.emergencyPause();
        vm.prank(user); vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        controller.upgrade(address(implementation), "");
        paused();
        vm.prank(user); vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        recovery.setMigrationTarget(address(implementation));
        vm.prank(user); vm.expectRevert(ExchangeState.BadParams.selector);
        recovery.activateEmergency();
    }
    function test_migrationPreservesBeneficiaryAndCannotBeReplayed() public {
        paused();
        FastExchange target = replacement();
        vm.prank(address(0xB0B));
        recovery.migrateBalance(user, 10_000e6);
        assertEq(target.balances(user), 10_000e6);
        assertEq(target.balances(address(0xB0B)), 0);
        assertEq(recovery.balances(user), 0);
        assertEq(recovery.totalBalances(), 0);
        assertEq(recovery.treasury(), 0);
        assertEq(usdc.allowance(address(ex), address(target)), 0);
        vm.expectRevert(ExchangeState.InsufficientBalance.selector);
        recovery.migrateBalance(user, 1);
    }
    function test_wrongCollateralAndSelfMigrationAreRejected() public {
        paused();
        vm.expectRevert(EmergencyExchange.InvalidMigrationTarget.selector);
        recovery.setMigrationTarget(address(ex));
        BrokenMigrationTarget wrong = new BrokenMigrationTarget(new MockUSDC(), true);
        vm.expectRevert(EmergencyExchange.InvalidMigrationTarget.selector);
        recovery.setMigrationTarget(address(wrong));
    }
    function test_failedOrFakeCreditRollsBackSourceBalanceAndAllowance() public {
        paused();
        for (uint256 i; i < 2; ++i) {
            BrokenMigrationTarget bad = new BrokenMigrationTarget(usdc, i == 0);
            recovery.setMigrationTarget(address(bad));
            vm.expectRevert(EmergencyExchange.MigrationCreditMismatch.selector);
            recovery.migrateBalance(user, 100e6);
            assertEq(recovery.balances(user), 10_000e6);
            assertEq(recovery.treasury(), 10_000e6);
            assertEq(usdc.balanceOf(address(ex)), 10_000e6);
            assertEq(usdc.allowance(address(ex), address(bad)), 0);
        }
    }
    function test_changedTargetCodeIsRejected() public {
        paused();
        FastExchange target = replacement();
        vm.etch(address(target), hex"00");
        vm.expectRevert(EmergencyExchange.InvalidMigrationTarget.selector);
        recovery.migrateBalance(user, 1e6);
    }
    function test_repairPreservesPositionsPricingTimesAndReplayProtection() public {
        bytes32 id = opened();
        bytes32 domain = ex.domainSeparator();
        paused();
        controller.upgrade(address(implementation), "");
        assertFalse(controller.emergencyPaused());
        assertTrue(ex.opensPaused());
        assertEq(ex.domainSeparator(), domain);
        assertTrue(ex.usedIntent(id));
        assertEq(ex.openIdsOf(user)[0], id);
        assertEq(ex.getPosition(id).margin, 100e6);
        closed(id);
        assertEq(ex.getPosition(id).owner, address(0));
        assertGt(ex.queuedOf(user), 0);
    }
    function test_houseMigrationCannotTakePositionMarginOrUnpaidWinnings() public {
        bytes32 id = opened();
        paused();
        replacement();
        vm.expectRevert(EmergencyExchange.OutstandingLiabilities.selector);
        recovery.migrateHouse(1);
        controller.upgrade(address(implementation), "");
        closed(id);
        paused();
        replacement();
        assertGt(recovery.totalQueued(), 0);
        vm.expectRevert(EmergencyExchange.OutstandingLiabilities.selector);
        recovery.migrateHouse(1);
    }
    function test_houseMigrationLeavesUserFundsBacked() public {
        usdc.mint(address(this), 500e6);
        usdc.approve(address(ex), 500e6);
        ex.donate(500e6);
        paused();
        FastExchange target = replacement();
        recovery.migrateHouse(500e6);
        assertEq(target.lpCash(), 500e6);
        assertEq(recovery.treasury(), 10_000e6);
        assertEq(usdc.balanceOf(address(ex)), recovery.totalBalances());
        vm.prank(user); recovery.emergencyWithdraw(10_000e6);
        assertEq(usdc.balanceOf(user), 10_000e6);
    }
    function test_newPairsCanStillBeListedAndSurviveAnUpgrade() public {
        ex.listMarket(bytes32("hyperliquid:ETH"), "ETH", 500,
            Exchange.Curve(15_000, 483_979, 1e6, 481304050180130, 1_000_000), 9_000, 50, 1_000_000e6, 1e15, 1e15);
        paused();
        controller.upgrade(address(implementation), "");
        assertEq(ex.marketCount(), 2);
        assertEq(ex.getMarket(1).maxLeverage, 500);
    }
    function test_bootstrapCannotInitializeAfterConstructionOrBeTakenOver() public {
        ExchangeBootstrap.InitialConfig memory config = ExchangeBootstrap.InitialConfig(user, user, user, 0, 0);
        vm.expectRevert(ExchangeState.BadParams.selector);
        bootstrap.initialize(config);
        (bool ok,) = address(ex).call(abi.encodeCall(ExchangeBootstrap.initialize, (config)));
        assertFalse(ok);
        assertEq(ex.owner(), address(this));
    }
    function test_guardianCannotResumeOrInstallArbitraryCode() public {
        paused();
        vm.prank(guardian); vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        controller.upgrade(address(implementation), "");
        assertTrue(controller.emergencyPaused());
    }
    function test_repeatedPauseDoesNotReplaceApprovedMigrationTarget() public {
        paused();
        FastExchange target = replacement();
        paused();
        assertEq(recovery.migrationTarget(), address(target));
    }
    function test_reenteringRecoveryRevokesThePreviousMigrationTarget() public {
        paused(); replacement();
        controller.upgrade(address(implementation), "");
        paused();
        assertEq(recovery.migrationTarget(), address(0));
    }
    function test_guardianCanEvacuateEntireCustodyWithoutChangingPositionsOrBalances() public {
        bytes32 id = opened();
        paused();
        vm.prank(guardian); recovery.evacuateToVault();
        EmergencyCustodyVault vault = EmergencyCustodyVault(recovery.custodyVault());
        assertEq(vault.source(), address(ex));
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertEq(usdc.balanceOf(address(vault)), 10_000e6);
        assertEq(recovery.balances(user), 9_900e6);
        assertEq(recovery.totalCashMargin(), 100e6);
        assertEq(recovery.getPosition(id).owner, user);
        vm.prank(user); vm.expectRevert(EmergencyCustodyVault.NotSource.selector);
        vault.release(10_000e6);
        vm.prank(user); vm.expectRevert(ExchangeState.NotGuardian.selector);
        recovery.evacuateToVault();
    }
    function test_withdrawalAndMigrationCanDrawFromRescueVault() public {
        opened(); paused(); recovery.evacuateToVault();
        address vault = recovery.custodyVault();
        vm.prank(user); recovery.emergencyWithdraw(900e6);
        FastExchange target = replacement();
        recovery.migrateBalance(user, 9_000e6);
        assertEq(usdc.balanceOf(user), 900e6);
        assertEq(target.balances(user), 9_000e6);
        assertEq(recovery.balances(user), 0);
        assertEq(usdc.balanceOf(vault), 100e6);
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertEq(recovery.treasury(), 100e6);
    }
    function test_repairAtomicallyRestoresRescueCustodyBeforeTradingCode() public {
        bytes32 id = opened(); paused(); recovery.evacuateToVault();
        address vault = recovery.custodyVault();
        FastExchange updated = FastExchange(createArtifact("FastExchange", abi.encode("Tape", usdc, oracle,
            pricing, sessions, address(this), address(this), uint256(5_000_000e6), uint96(1e6))));
        controller.upgrade(address(updated), "");
        assertEq(usdc.balanceOf(address(ex)), 10_000e6);
        assertEq(usdc.balanceOf(vault), 0);
        assertEq(ex.balances(user), 9_900e6);
        closed(id);
        assertGt(ex.queuedOf(user), 0);
    }
    function test_recoveryCannotBeExitedThroughAnUnauthorizedCustodyRecall() public {
        paused(); recovery.evacuateToVault();
        vm.expectRevert(ExchangeState.BadParams.selector);
        recovery.restoreCustody();
        assertEq(usdc.balanceOf(address(ex)), 0);
    }
    function test_queuedClaimsSurviveEvacuationAndFreeBalanceMigration() public {
        bytes32 id = opened(); closed(id);
        uint256 owed = ex.queuedOf(user);
        uint256 head = ex.queueHead();
        (address claimant, uint96 amount) = ex.claims(head);
        paused(); recovery.evacuateToVault(); replacement();
        recovery.migrateBalance(user, recovery.balances(user));
        assertEq(recovery.queuedOf(user), owed);
        assertEq(recovery.totalQueued(), owed);
        (address afterClaimant, uint96 afterAmount) = recovery.claims(head);
        assertEq(afterClaimant, claimant);
        assertEq(afterAmount, amount);
    }
    function test_migrationRejectsReentryWithoutDoubleDebiting() public {
        paused(); recovery.evacuateToVault();
        ReentrantMigrationTarget target = new ReentrantMigrationTarget(usdc, address(ex));
        recovery.setMigrationTarget(address(target));
        recovery.migrateBalance(user, 100e6);
        assertTrue(target.reentryBlocked());
        assertEq(target.balances(user), 100e6);
        assertEq(recovery.balances(user), 9_900e6);
        assertEq(recovery.treasury(), 9_900e6);
    }
    function test_timelockedUpgradesDoNotDelayEmergencyPause() public {
        address[] memory actors = new address[](1);
        actors[0] = address(this);
        TimelockController timelock = new TimelockController(1 days, actors, actors, address(0));
        controller.transferOwnership(address(timelock));
        bytes memory accept = abi.encodeCall(controller.acceptOwnership, ());
        timelock.schedule(address(controller), 0, accept, bytes32(0), bytes32(uint256(1)), 1 days);
        vm.warp(T + 1 days);
        timelock.execute(address(controller), 0, accept, bytes32(0), bytes32(uint256(1)));
        paused();
        assertTrue(controller.emergencyPaused());
        recovery.evacuateToVault();
        bytes memory upgrade = abi.encodeCall(controller.upgrade, (address(implementation), bytes("")));
        timelock.schedule(address(controller), 0, upgrade, bytes32(0), bytes32(uint256(2)), 1 days);
        vm.expectRevert();
        timelock.execute(address(controller), 0, upgrade, bytes32(0), bytes32(uint256(2)));
        assertTrue(controller.emergencyPaused());
        vm.warp(T + 2 days);
        timelock.execute(address(controller), 0, upgrade, bytes32(0), bytes32(uint256(2)));
        assertFalse(controller.emergencyPaused());
        assertEq(ex.balances(user), 10_000e6);
        assertEq(usdc.balanceOf(address(ex)), 10_000e6);
    }
    function testFuzz_rescueWithdrawalNeverSpendsLockedMargin(uint96 requested) public {
        opened(); paused(); recovery.evacuateToVault();
        uint256 amount = bound(uint256(requested), 1, 9_900e6);
        address vault = recovery.custodyVault();
        vm.prank(user); recovery.emergencyWithdraw(amount);
        assertEq(recovery.totalCashMargin(), 100e6);
        assertEq(recovery.balances(user), 9_900e6 - amount);
        assertEq(recovery.treasury(), usdc.balanceOf(vault) + usdc.balanceOf(address(ex)));
        assertGe(usdc.balanceOf(vault), 100e6);
    }
}
