// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Deposits, DepositBox, IExchangeDepositFor} from "../src/periphery/Deposits.sol";
import {MockUSDC} from "./mocks/Mocks.sol";
import {Base} from "./Base.t.sol";

/// @dev A token whose transfer calls back into the Deposits contract, to try to take a deposit twice.
contract ReentrantToken {
    Deposits public target;
    address public victim;
    mapping(address => uint256) public balanceOf;
    uint256 public calls;

    function arm(Deposits target_, address victim_) external {
        target = target_;
        victim = victim_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    address public other;
    IERC20 public usdc;
    bool public gotIntoABox;

    function aim(address other_, IERC20 usdc_) external {
        other = other_;
        usdc = usdc_;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        ++calls;
        if (address(target) != address(0) && calls < 4) {
            // Called by the victim's own box, mid-recovery. Everything it could try from there:
            try DepositBox(msg.sender).empty(usdc, address(this)) {
                gotIntoABox = true;
            } catch {}
            try DepositBox(target.addressOf(other)).empty(usdc, address(this)) {
                gotIntoABox = true;
            } catch {}
            try target.reclaim() {} catch {}
            try target.recover(other, IERC20(address(this))) {} catch {}
            try target.collect(victim) {} catch {}
            try target.recover(victim, IERC20(address(this))) {} catch {}
        }
        return true;
    }
}

/// @dev A token that says nothing when it transfers, as USDT does.
contract SilentToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev A token that answers "no" and moves nothing.
contract RefusingToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Deposit addresses: a plain transfer of USDC to a wallet's own address becomes that
///      wallet's Exchange balance, whoever asks for it to be collected, and nothing else.
contract DepositsTest is Base {
    Deposits internal deposits;

    event Collected(address indexed user, uint256 amount);
    event Reclaimed(address indexed user, uint256 amount);

    function setUp() public override {
        super.setUp();
        deposits = Deposits(_deployed("Deposits", type(Deposits).creationCode, abi.encode(usdc, ex)));
    }

    function _send(address user, uint256 amount) internal returns (address at) {
        at = deposits.addressOf(user);
        usdc.mint(at, amount);
    }

    // --------------------------------------------------------------------------------------
    // The address
    // --------------------------------------------------------------------------------------

    function test_address_isTheWalletsOwnAndNeverChanges() public {
        address a = deposits.addressOf(alice);
        address b = deposits.addressOf(bob);
        assertTrue(a != b);
        assertTrue(a != alice && a != address(deposits) && a != address(0));
        assertEq(a.code.length, 0, "nothing is there until the first collect");

        _send(alice, 50e6);
        assertEq(deposits.pending(alice), 50e6);
        deposits.collect(alice);
        assertGt(a.code.length, 0, "the box is there now");
        assertEq(deposits.addressOf(alice), a, "and the address is the same");
        assertEq(deposits.addressOf(bob), b);
    }

    function test_address_dependsOnThisContractToo() public {
        // Another Deposits contract gives the same wallet another address: an address is only good
        // for the contract that names it.
        Deposits other = new Deposits(IERC20(address(usdc)), deposits.exchange());
        assertTrue(other.addressOf(alice) != deposits.addressOf(alice));
        assertTrue(other.box() != deposits.box());
    }

    // --------------------------------------------------------------------------------------
    // Collecting
    // --------------------------------------------------------------------------------------

    function test_collect_turnsATransferIntoTheWalletsBalance() public {
        uint256 treasury = ex.treasury();
        _send(alice, 50e6);
        assertEq(ex.balances(alice), 0);

        vm.expectEmit(true, false, false, true, address(deposits));
        emit Collected(alice, 50e6);
        vm.prank(stranger);
        assertEq(deposits.collect(alice), 50e6);

        assertEq(ex.balances(alice), 50e6, "it is alice's, whoever collected it");
        assertEq(ex.balances(stranger), 0);
        assertEq(ex.treasury(), treasury + 50e6);
        assertEq(usdc.balanceOf(deposits.addressOf(alice)), 0);
        assertEq(usdc.balanceOf(address(deposits)), 0, "the contract keeps nothing");
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(deposits.pending(alice), 0);
        _assertSolvent();
    }

    function test_collect_worksEveryTimeTheAddressIsUsed() public {
        _send(alice, 10e6);
        deposits.collect(alice);
        _send(alice, 25e6);
        _send(alice, 5e6); // two transfers before the next collect arrive together
        assertEq(deposits.collect(alice), 30e6);
        assertEq(ex.balances(alice), 40e6);

        vm.expectRevert(Deposits.NothingToCollect.selector);
        deposits.collect(alice);
    }

    function test_collect_keepsWalletsApart() public {
        _send(alice, 10e6);
        _send(bob, 70e6);
        deposits.collect(bob);
        assertEq(ex.balances(bob), 70e6);
        assertEq(ex.balances(alice), 0, "alice's is still waiting at her own address");
        assertEq(deposits.pending(alice), 10e6);
        deposits.collect(alice);
        assertEq(ex.balances(alice), 10e6);
    }

    function test_collect_refusesNothingAndNobody() public {
        vm.expectRevert(Deposits.NothingToCollect.selector);
        deposits.collect(alice);
        assertEq(deposits.addressOf(alice).code.length, 0, "a failed collect leaves nothing behind");
        vm.expectRevert(Deposits.ZeroAddress.selector);
        deposits.collect(address(0));
    }

    /// @dev The money can then be traded with and withdrawn like any other deposit.
    function test_collect_theBalanceIsAnOrdinaryOne() public {
        _send(alice, 500e6);
        deposits.collect(alice);
        bytes32 id = _open(alicePk, btc, true, 100e6, 100, _px(80_000));
        assertEq(ex.balances(alice), 400e6);
        _close(alicePk, id, _px(80_000));
        assertGe(ex.balances(alice), 498e6);
        _assertSolvent();
    }

    function testFuzz_collect_creditsExactlyWhatWasSent(address user, uint96 first, uint96 second) public {
        vm.assume(user != address(0) && user != address(ex) && user != address(deposits));
        first = uint96(bound(first, 1, 1e15));
        second = uint96(bound(second, 1, 1e15));
        uint256 before = ex.balances(user);
        _send(user, first);
        assertEq(deposits.collect(user), first);
        _send(user, second);
        assertEq(deposits.collect(user), second);
        assertEq(ex.balances(user) - before, uint256(first) + second);
        assertEq(usdc.balanceOf(address(deposits)), 0);
        assertEq(usdc.balanceOf(deposits.addressOf(user)), 0);
    }

    // --------------------------------------------------------------------------------------
    // What nobody can do
    // --------------------------------------------------------------------------------------

    /// @dev A box answers the Deposits contract and nobody else, before and after it holds money.
    function test_box_answersOnlyItsDepositsContract() public {
        _send(alice, 10e6);
        deposits.collect(alice);
        _send(alice, 90e6);
        DepositBox box = DepositBox(deposits.addressOf(alice));

        address[3] memory callers = [stranger, alice, operator];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(DepositBox.NotDeposits.selector);
            box.empty(IERC20(address(usdc)), callers[i]);
        }
        // The code all boxes share is itself a box that answers only the Deposits contract.
        DepositBox shared = DepositBox(deposits.box());
        vm.prank(stranger);
        vm.expectRevert(DepositBox.NotDeposits.selector);
        shared.empty(IERC20(address(usdc)), stranger);

        assertEq(usdc.balanceOf(address(box)), 90e6);
        deposits.collect(alice);
        assertEq(ex.balances(alice), 100e6);
    }

    /// @dev The address is worked out here from the CREATE2 rule and the standard minimal proxy,
    ///      without asking the contract: only this Deposits contract can put code there, and only
    ///      that proxy to the one box. What ends up there is exactly it, byte for byte.
    function test_box_isTheStandardProxyAtTheAddressTheRuleGives() public {
        address code = deposits.box();
        bytes memory proxy = abi.encodePacked(hex"363d3d373d3d3d363d73", code, hex"5af43d82803e903d91602b57fd5bf3");
        bytes memory initcode = abi.encodePacked(hex"3d602d80600a3d3981f3", proxy);
        address expected = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), address(deposits), bytes32(uint256(uint160(alice))), keccak256(initcode)
                        )
                    )
                )
            )
        );
        assertEq(deposits.addressOf(alice), expected);

        // Collecting with nothing there fails and deploys nothing.
        vm.prank(stranger);
        vm.expectRevert(Deposits.NothingToCollect.selector);
        deposits.collect(alice);
        assertEq(expected.code.length, 0);

        // ETH sent to the bare address beforehand does not stand in the box's way.
        vm.deal(expected, 1 ether);
        _send(alice, 20e6);
        vm.prank(stranger);
        deposits.collect(alice);
        assertEq(expected.code, proxy, "exactly the minimal proxy to the box, and nothing else");
        assertEq(ex.balances(alice), 20e6);
    }

    /// @dev USDC sent to the Deposits contract itself is nobody's deposit: no later collect picks
    ///      it up for whoever happens to be next.
    function test_collect_doesNotHandOutUsdcSentToTheContractItself() public {
        usdc.mint(address(deposits), 777e6);
        _send(alice, 10e6);
        assertEq(deposits.collect(alice), 10e6);
        assertEq(ex.balances(alice), 10e6);
        assertEq(usdc.balanceOf(address(deposits)), 777e6);
    }

    // --------------------------------------------------------------------------------------
    // Taking it back
    // --------------------------------------------------------------------------------------

    function test_reclaim_givesAWalletItsOwnWaitingUsdcBack() public {
        _send(alice, 60e6);
        _send(bob, 40e6);

        vm.expectEmit(true, false, false, true, address(deposits));
        emit Reclaimed(alice, 60e6);
        vm.prank(alice);
        assertEq(deposits.reclaim(), 60e6);
        assertEq(usdc.balanceOf(alice), 60e6, "straight back to her wallet");
        assertEq(ex.balances(alice), 0);
        assertEq(usdc.balanceOf(address(deposits)), 0);
        // Bob's is untouched, and still a deposit.
        assertEq(deposits.pending(bob), 40e6);
        deposits.collect(bob);
        assertEq(ex.balances(bob), 40e6);

        vm.prank(alice);
        vm.expectRevert(Deposits.NothingToCollect.selector);
        deposits.reclaim();
    }

    /// @dev There is no way to reclaim for somebody else: it is always the caller's own address.
    function test_reclaim_isOnlyEverForOneself() public {
        _send(alice, 60e6);
        vm.prank(stranger);
        vm.expectRevert(Deposits.NothingToCollect.selector);
        deposits.reclaim();
        assertEq(deposits.pending(alice), 60e6);
        assertEq(usdc.balanceOf(stranger), 0);
    }

    /// @dev The way out when collecting cannot work: here the Exchange refuses every deposit.
    function test_reclaim_worksWhenCollectingDoesNot() public {
        _send(alice, 60e6);
        vm.mockCallRevert(address(ex), abi.encodeWithSelector(ex.depositFor.selector), "frozen");
        vm.expectRevert();
        deposits.collect(alice);
        assertEq(deposits.pending(alice), 60e6, "a failed collect leaves it where it was");
        vm.prank(alice);
        deposits.reclaim();
        assertEq(usdc.balanceOf(alice), 60e6);
    }

    function test_box_takesNoEth() public {
        _send(alice, 1e6);
        deposits.collect(alice);
        address at = deposits.addressOf(alice);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool sent,) = at.call{value: 1 ether}("");
        assertFalse(sent, "a deployed box refuses ETH");
        vm.prank(stranger);
        (sent,) = address(deposits).call{value: 1 ether}("");
        assertFalse(sent, "and so does the Deposits contract");
    }

    // --------------------------------------------------------------------------------------
    // Other tokens
    // --------------------------------------------------------------------------------------

    function test_recover_sendsAnotherTokenBackToTheWallet() public {
        MockUSDC other = new MockUSDC();
        address at = deposits.addressOf(alice);
        other.mint(at, 123e6);
        _send(alice, 50e6);

        // Anyone may ask; it goes to alice.
        vm.prank(stranger);
        assertEq(deposits.recover(alice, IERC20(address(other))), 123e6);
        assertEq(other.balanceOf(alice), 123e6);
        assertEq(other.balanceOf(stranger), 0);
        assertEq(other.balanceOf(at), 0);
        // The USDC is untouched by that, and is still a deposit.
        assertEq(usdc.balanceOf(at), 50e6);
        deposits.collect(alice);
        assertEq(ex.balances(alice), 50e6);
        // Nothing there: nothing happens.
        assertEq(deposits.recover(alice, IERC20(address(other))), 0);
    }

    /// @dev USDC at a deposit address is a deposit. If it could be bounced back to the wallet,
    ///      anyone could undo a deposit before it was collected.
    function test_recover_refusesUsdc() public {
        _send(alice, 50e6);
        vm.expectRevert(Deposits.UsdcIsCollected.selector);
        deposits.recover(alice, IERC20(address(usdc)));
        vm.expectRevert(Deposits.ZeroAddress.selector);
        deposits.recover(address(0), IERC20(address(usdc)));
        assertEq(usdc.balanceOf(deposits.addressOf(alice)), 50e6);
    }

    /// @dev A token that calls back in while it is being recovered gets nothing by it, though it
    ///      is the box's own callee at that moment: a box answers only the Deposits contract, and
    ///      each call there can only move what is at one wallet's address to that wallet or to its
    ///      balance.
    function test_recover_aTokenThatCallsBackInGainsNothing() public {
        ReentrantToken evil = new ReentrantToken();
        address at = deposits.addressOf(alice);
        evil.mint(at, 1_000);
        _send(alice, 50e6);
        _send(bob, 70e6);
        deposits.collect(bob); // bob's box exists, and holds more
        _send(bob, 30e6);
        evil.arm(deposits, alice);
        evil.aim(bob, IERC20(address(usdc)));

        deposits.recover(alice, IERC20(address(evil)));
        assertGt(evil.calls(), 0);
        assertFalse(evil.gotIntoABox(), "no box let it in");
        // Its callback collected alice's USDC on her behalf, once. That is all it could do.
        assertEq(ex.balances(alice), 50e6);
        assertEq(usdc.balanceOf(at), 0);
        assertEq(usdc.balanceOf(address(evil)), 0);
        assertEq(usdc.balanceOf(address(deposits)), 0);
        assertEq(evil.balanceOf(alice), 1_000);
        assertEq(deposits.pending(bob), 30e6, "bob's waiting USDC is where it was");
        _assertSolvent();
    }

    /// @dev Tokens that do not answer as the standard says: one that says nothing still comes
    ///      back; one that says no, and an address with no token at it, fail and move nothing.
    function test_recover_tokensThatDoNotBehave() public {
        address at = deposits.addressOf(alice);
        SilentToken silent = new SilentToken();
        silent.mint(at, 5e6);
        assertEq(deposits.recover(alice, IERC20(address(silent))), 5e6);
        assertEq(silent.balanceOf(alice), 5e6);

        RefusingToken refusing = new RefusingToken();
        refusing.mint(at, 5e6);
        vm.expectRevert();
        deposits.recover(alice, IERC20(address(refusing)));

        vm.expectRevert();
        deposits.recover(alice, IERC20(stranger));
    }

    // --------------------------------------------------------------------------------------
    // The contract itself
    // --------------------------------------------------------------------------------------

    function test_constructor_wiresAndRefusesZero() public {
        assertEq(address(deposits.usdc()), address(usdc));
        assertEq(address(deposits.exchange()), address(ex));
        assertEq(usdc.allowance(address(deposits), address(ex)), type(uint256).max);
        IExchangeDepositFor exchange = deposits.exchange();
        vm.expectRevert(Deposits.ZeroAddress.selector);
        new Deposits(IERC20(address(0)), exchange);
        vm.expectRevert(Deposits.ZeroAddress.selector);
        new Deposits(IERC20(address(usdc)), IExchangeDepositFor(address(0)));
    }
}
