// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {PerpMath} from "../src/libraries/PerpMath.sol";

/// @notice Plays a long random session through the real contracts and writes down every balance
///         after every step. The site's preview mode keeps its own books in JavaScript
///         (web/src/lib/preview/books.ts); web/test/books.test.mjs replays this exact session
///         through them and requires every figure to match to the last unit.
/// @dev The session is seeded, so the fixture is the same on every run.
contract PreviewParityTest is Base {
    string internal constant OUT = "./test/fixtures/preview-scenario.jsonl";
    uint256 internal constant STEPS = 1_100;
    /// @dev Exchange.AUTO_HARVEST, which is private: queue entries paid after a losing settlement.
    uint256 internal constant AUTO_HARVEST = 4;
    /// @dev A depth the session's positions run past again and again, so the preview's books are
    ///      held to the contracts with size charged as well as at the reference price.
    uint32 internal constant DEPTH = 250_000;

    uint256[3] internal pks;
    address[3] internal users;
    uint64[2] internal price;

    struct Opened {
        bytes32 id;
        uint8 user;
        uint16 market;
        bool isLong;
        uint16 leverage;
        uint64 entry;
        bool alive;
    }

    Opened[] internal opened;
    /// @dev 0 leans down, 1 is flat, 2 leans up.
    uint256 internal drift = 2;
    uint256 internal rng = uint256(keccak256("preview parity session"));

    // What the session got to, so the test can insist it went everywhere worth going.
    uint256 internal sweeps;
    uint256 internal sweepsHeldBack;
    uint256 internal streamsRunOut;
    uint256 internal lastStakerLeft;

    function setUp() public override {
        super.setUp();
        _attachCoin();
        vm.startPrank(admin);
        ex.setDepth(btc, DEPTH);
        ex.setDepth(eth, DEPTH);
        vm.stopPrank();
        pks = [alicePk, bobPk, carolPk];
        users = [alice, bob, carol];
        price = [_px(80_000), _px(2_500)];
    }

    function test_writesTheSessionThePreviewBooksMustReproduce() public {
        vm.writeFile(OUT, "");
        vm.writeLine(
            OUT,
            string.concat(
                '{"op":"params","stakerCap":"',
                vm.toString(STAKER_CAP),
                '","miningScale":"',
                vm.toString(MINING_SCALE),
                '","reserve":"',
                vm.toString(RESERVE),
                '","autoHarvest":',
                vm.toString(AUTO_HARVEST),
                ',"markets":[',
                _marketJson(BTC_POSITION, BTC_TICK, BTC_BUFFER),
                ",",
                _marketJson(ETH_POSITION, ETH_TICK, ETH_BUFFER),
                "]}"
            )
        );

        for (uint8 u; u < 3; ++u) {
            uint256 amount = 60_000e6 + uint256(u) * 12_345_678;
            _fund(users[u], amount);
            _line(
                string.concat('"op":"deposit","u":', vm.toString(u), ',"amount":"', vm.toString(amount), '"')
            );
        }

        for (uint256 step; step < STEPS; ++step) {
            // With via_ir a plain `block.number` is cached across vm.roll; ask the cheatcode.
            vm.roll(vm.getBlockNumber() + 1);
            // Two thirds of the way in, the house is handed enough to pay off the queue and sit
            // above its cap, so the rest of the session also exercises fees with nobody queued and
            // the sweep of what is above the cap to stakers.
            if (step == (STEPS * 2) / 3) {
                // Enough to pay everyone queued and leave the house $2M over its cap.
                uint256 gift = ex.totalQueued() + ex.debtMarginOpen() + STAKER_CAP + 2_000_000e6;
                _seedHouse(gift);
                _line(string.concat('"op":"donate","amount":"', vm.toString(gift), '"'));
            }
            // Later still, every staker walks out at once, mid-stream. What was left of the stream
            // has to wait for whoever stakes next, and start again from then.
            if (step == (STEPS * 5) / 6) _everyoneLeaves();
            uint256 roll = _rand(100);
            if (roll < 32) _stepOpen();
            else if (roll < 55) _stepPrice();
            else if (roll < 78) _stepClose();
            else if (roll < 82) _stepHarvest();
            else if (roll < 89) _stepPay();
            else if (roll < 92) _stepWait();
            else _stepCoin();
        }
        _assertSolvent();
        // The session has to have gone everywhere worth going, or the comparison proves little.
        assertGt(staking.totalClaimed(), 0, "stakers never claimed");
        assertGt(mining.totalMined(), 0, "nothing was mined");
        assertGt(ex.queueTail(), 0, "nothing was ever queued");
        assertGt(sweeps, 0, "house cash above the cap was never swept");
        assertGt(sweepsHeldBack, 0, "no sweep ever had to hold anything back for open positions");
        assertGt(streamsRunOut, 0, "no stream ever ran its full day");
        assertGt(lastStakerLeft, 0, "the last staker never left with a stream running");
    }

    function _marketJson(uint256 positionMultiplier, uint256 tick, uint256 bustBuffer)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '{"rateMultiplier":',
            vm.toString(uint256(RATE)),
            ',"positionMultiplier":',
            vm.toString(positionMultiplier),
            ',"maxKeepBps":',
            vm.toString(uint256(MAX_KEEP)),
            ',"tick":',
            vm.toString(tick),
            ',"bustBuffer":"',
            vm.toString(bustBuffer),
            '","depth":',
            vm.toString(uint256(DEPTH)),
            "}"
        );
    }

    // --------------------------------------------------------------------------------------
    // Steps
    // --------------------------------------------------------------------------------------

    function _stepOpen() private {
        uint8 u = uint8(_rand(3));
        uint16 m = uint16(_rand(2));
        bool isLong = _rand(2) == 0;
        uint16[9] memory levs = [uint16(2), 5, 10, 25, 50, 100, 250, 500, 1000];
        uint16 lev = levs[_rand(9)];
        // Odd amounts on purpose: every rounding gets used.
        uint96 margin = uint96((5 + _rand(2_996)) * 1e6 + _rand(1e6));
        bool useQueued = _rand(100) < 40;

        uint256 debt = useQueued ? _min(ex.queuedOf(users[u]), margin) : 0;
        if (ex.balances(users[u]) < margin - debt) return;
        uint256 ahead = isLong ? ex.getMarket(m).oiLong : ex.getMarket(m).oiShort;
        if (ahead + uint256(margin) * lev > pricing.CASH_OI_FLOOR() + ex.lpCash() * 50) return;

        bytes32 id = useQueued
            ? _openQueued(pks[u], m, isLong, margin, lev, price[m])
            : _open(pks[u], m, isLong, margin, lev, price[m]);
        opened.push(Opened(id, u, m, isLong, lev, price[m], true));
        _line(
            string.concat(
                '"op":"open","u":',
                vm.toString(u),
                ',"m":',
                vm.toString(m),
                ',"long":',
                isLong ? "true" : "false",
                ',"lev":',
                vm.toString(lev),
                ',"margin":"',
                vm.toString(margin),
                '","useQueued":',
                useQueued ? "true" : "false",
                ',"price":"',
                vm.toString(price[m]),
                '","charge":"',
                vm.toString(uint256(ex.getPosition(id).impactNotional)),
                '"'
            )
        );
    }

    /// @dev Moves one market by up to 60 bps either way, then busts whatever that crossed, oldest
    ///      first: what the keeper does on every print.
    function _stepPrice() private {
        uint16 m = uint16(_rand(2));
        // The market trends: every so often it picks a direction and leans that way. Trends are
        // what make traders win more than the house holds, which is what fills the payout queue.
        if (_rand(25) == 0) drift = _rand(3);
        uint256 ppm = _rand(12_001) + drift * 5_000;
        price[m] = uint64((uint256(price[m]) * (1_000_000 + ppm - 11_000)) / 1_000_000);

        string memory busted = "";
        for (uint256 i; i < opened.length; ++i) {
            Opened storage o = opened[i];
            if (!o.alive || o.market != m) continue;
            uint256 bust =
                m == btc ? _btcBust(o.entry, o.leverage, o.isLong) : _ethBust(o.entry, o.leverage, o.isLong);
            if (!PerpMath.crossed(price[m], bust, o.isLong)) continue;
            _liquidate(o.id, price[m]);
            o.alive = false;
            busted = string.concat(busted, bytes(busted).length == 0 ? "" : ",", vm.toString(i));
        }
        _line(
            string.concat(
                '"op":"price","m":',
                vm.toString(m),
                ',"price":"',
                vm.toString(price[m]),
                '","liq":[',
                busted,
                "]"
            )
        );
    }

    function _stepClose() private {
        uint256 count = opened.length;
        if (count == 0) return;
        uint256 start = _rand(count);
        for (uint256 k; k < count; ++k) {
            uint256 i = (start + k) % count;
            Opened storage o = opened[i];
            if (!o.alive) continue;
            _close(pks[o.user], o.id, price[o.market]);
            o.alive = false;
            _line(
                string.concat(
                    '"op":"close","i":', vm.toString(i), ',"price":"', vm.toString(price[o.market]), '"'
                )
            );
            return;
        }
    }

    function _stepHarvest() private {
        ex.harvest(8);
        _line('"op":"harvest","n":8');
    }

    /// @dev What the keeper does for stakers: sends them the accrued fees, and has the sweeper send
    ///      whatever house cash above the cap the open positions leave spare.
    function _stepPay() private {
        if (ex.stakerFees() != 0) {
            ex.pushStakerFees();
            _line('"op":"push"');
        }
        uint256 excess = ex.lpExcess();
        if (excess == 0) return;

        bytes[] memory updates = new bytes[](2);
        uint64 nowTime = uint64(vm.getBlockTimestamp());
        updates[0] = _update(BTC_FEED, price[0], nowTime)[0];
        updates[1] = _update(ETH_FEED, price[1], nowTime)[0];
        uint256 moved;
        try sweeper.sweep{value: _fee(2)}(updates) returns (uint256 amount) {
            moved = amount;
            ++sweeps;
            if (amount < excess) ++sweepsHeldBack;
        } catch {
            // The open positions are up by more than the house has spare: nothing moves.
            ++sweepsHeldBack;
        }
        _line(
            string.concat(
                '"op":"sweep","prices":["',
                vm.toString(price[0]),
                '","',
                vm.toString(price[1]),
                '"],"moved":"',
                vm.toString(moved),
                '"'
            )
        );
    }

    /// @dev Lets anything from ten minutes to nine hours pass, so streams get somewhere, and now
    ///      and then run out.
    function _stepWait() private {
        bool running = staking.rewardRate() != 0 && vm.getBlockTimestamp() < staking.periodFinish();
        skip(600 + _rand(9 hours));
        if (running && vm.getBlockTimestamp() >= staking.periodFinish()) ++streamsRunOut;
        _line('"op":"wait"');
    }

    function _everyoneLeaves() private {
        if (ex.stakerFees() != 0) {
            ex.pushStakerFees();
            _line('"op":"push"');
        }
        for (uint8 u; u < 3; ++u) {
            uint256 staked = staking.staked(users[u]);
            if (staked == 0) continue;
            if (staked == staking.totalStaked() && staking.unstreamed() != 0) ++lastStakerLeft;
            vm.prank(users[u]);
            staking.unstake(staked);
            _line(
                string.concat('"op":"unstake","u":', vm.toString(u), ',"amount":"', vm.toString(staked), '"')
            );
        }
    }

    function _stepCoin() private {
        uint8 u = uint8(_rand(3));
        uint256 what = _rand(3);
        if (what == 0) {
            uint256 held = coin.balanceOf(users[u]);
            if (held == 0) return;
            // Not always everything: partial stakes exercise the accrual on a changing stake.
            uint256 amount = _rand(2) == 0 ? held : held / 3 + 1;
            vm.startPrank(users[u]);
            coin.approve(address(staking), amount);
            staking.stake(amount);
            vm.stopPrank();
            _line(string.concat('"op":"stake","u":', vm.toString(u), ',"amount":"', vm.toString(amount), '"'));
        } else if (what == 1) {
            uint256 staked = staking.staked(users[u]);
            if (staked == 0) return;
            // Sometimes all of it, so that now and then the last staker leaves mid-stream.
            uint256 amount = _rand(3) == 0 ? staked : staked / 2 + 1;
            if (amount == staking.totalStaked() && staking.unstreamed() != 0) ++lastStakerLeft;
            vm.prank(users[u]);
            staking.unstake(amount);
            _line(
                string.concat('"op":"unstake","u":', vm.toString(u), ',"amount":"', vm.toString(amount), '"')
            );
        } else {
            if (staking.pendingReward(users[u]) == 0) return;
            vm.prank(users[u]);
            staking.claim();
            _line(string.concat('"op":"claim","u":', vm.toString(u)));
        }
    }

    // --------------------------------------------------------------------------------------
    // Writing
    // --------------------------------------------------------------------------------------

    function _line(string memory op) private {
        vm.writeLine(
            OUT,
            string.concat(
                "{", op, ',"t":', vm.toString(vm.getBlockTimestamp()), ",", _money(), ",", _coinSide(), "}"
            )
        );
    }

    function _three(function(address) external view returns (uint256) read)
        private
        view
        returns (string memory)
    {
        return string.concat(
            '["',
            vm.toString(read(users[0])),
            '","',
            vm.toString(read(users[1])),
            '","',
            vm.toString(read(users[2])),
            '"]'
        );
    }

    function _money() private view returns (string memory) {
        return string.concat(
            '"b":',
            _three(ex.balances),
            ',"q":',
            _three(ex.queuedOf),
            ',"lp":"',
            vm.toString(ex.lpCash()),
            '","tq":"',
            vm.toString(ex.totalQueued()),
            '","sf":"',
            vm.toString(ex.stakerFees()),
            '","df":"',
            vm.toString(ex.devFees()),
            '","dm":"',
            vm.toString(ex.debtMarginOpen()),
            '","cm":"',
            vm.toString(ex.totalCashMargin()),
            '","tr":"',
            vm.toString(ex.treasury()),
            '","sz":',
            _sizes()
        );
    }

    /// @dev Open size per market and side, the figure the sweep marks the book with.
    function _sizes() private view returns (string memory) {
        return string.concat(
            '["',
            vm.toString(uint256(ex.getMarket(btc).sizeLong)),
            '","',
            vm.toString(uint256(ex.getMarket(btc).sizeShort)),
            '","',
            vm.toString(uint256(ex.getMarket(eth).sizeLong)),
            '","',
            vm.toString(uint256(ex.getMarket(eth).sizeShort)),
            '"]'
        );
    }

    function _coinSide() private view returns (string memory) {
        return string.concat(
            '"c":',
            _three(coin.balanceOf),
            ',"s":',
            _three(staking.staked),
            ',"p":',
            _three(staking.pendingReward),
            ',"res":"',
            vm.toString(mining.reserve()),
            '","cl":"',
            vm.toString(mining.cumulativeLossUsd()),
            '","un":"',
            vm.toString(staking.unstreamed()),
            '","wt":"',
            vm.toString(staking.waiting()),
            '","rr":"',
            vm.toString(staking.rewardRate()),
            '","rc":"',
            vm.toString(staking.totalReceived()),
            '","ts":"',
            vm.toString(staking.totalStaked()),
            '"'
        );
    }

    function _rand(uint256 n) private returns (uint256) {
        rng = uint256(keccak256(abi.encode(rng)));
        return rng % n;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
