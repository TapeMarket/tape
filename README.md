# Tape

Synthetic perpetuals on Ethereum at up to 1000x, traded against a house (the vault, on the site)
that starts with nothing. The coin is `$TAPE`; the site is
[tapemarket.io](https://tapemarket.io).

**Status: Ethereum core deployed.** The exchange and its seven supporting contracts are live on
Ethereum; the coin, staking, loss rewards and jackpot are not deployed or attached. The site uses
the live exchange by default; `?preview=1` opens practice mode. It has not been audited by an outside firm: read
[Review](#review) and [Status](#status) before putting money in.

## What it is

- Pick long or short, a margin and leverage up to 1000x. The site offers crypto, equity, index
  and gold markets; available markets and leverage limits come from the deployment. Collateral is USDC.
- No order book. Every trade is against the house. No fee on size, no spread, no funding.
- The house takes its cut from winning closes only: a 0.2 bps deadband, an impact haircut that
  shrinks as the move grows (a win keeps at most 90%), and a 2% fee. A loss costs the loss.
- Size costs. Each side of each market prices like that up to a depth ($1,000,000 open at launch).
  A position opened on a side that already holds more keeps less of a small win, the more so the
  fuller the side. That is what the reference exchange lacked, and what it was drained through: see
  [Moving the price](#moving-the-price).
- A position busts a little before its margin would be zero: 4.76 bps of that price for BTC, 4.81
  for ETH. At 1000x that is 5.25 bps from entry. A bust forfeits the whole margin.
- Inside that depth the pricing is the reference exchange's, parameter for parameter and rounding for
  rounding: `test/ReferenceParity.t.sol` replays 2,627 of its real settlements through the contract's
  math and gets the same money to the last unit of USDC on every one.
- The house holds no seed capital. Losses fund it. A win it cannot pay goes into a first-in,
  first-out queue and is paid as later losses arrive. Margin is never queued. Queued winnings can
  be used as margin.
- The optional reward contracts pay losers in a coin, sent to their wallet as the loss settles.
  These contracts are not attached to the live exchange yet. Staking the coin earns USDC:
  half of every fee, plus everything the house holds above a cap. The exchange works with or
  without the coin.

## Customer support

The Support button opens a private conversation with the Tape team. Customers do not need a
wallet connection. Replies arrive in the chat; the same browser can reopen its conversation.
The chat shows the team as available only while a staff member has enabled availability and is
actively viewing the inbox. Messages are deleted after 90 days without activity.

Staff use `/support` and sign in with an authorized wallet. Set `SUPPORT_ADMINS` to a
comma-separated list of staff wallet addresses on the relayer, and optionally set
`SUPPORT_DATA_DIR` to its private storage directory. Sign-in needs a message signature, not a
transaction. The inbox supports live replies, unread counts, resolution, and browser alerts.

## Deployed

The Ethereum core is deployed. The public address record is
[`deployments/1.json`](deployments/1.json); the coin and reward contracts remain undeployed.

| Contract | Ethereum address |
| --- | --- |
| FastExchange | `0x06FDA5DF6C1a8BbC24bF4A2E717302163E23b062` |
| Pricing | `0xd170144B7b2F6B3423Ac5974F29c1FED4759Cf93` |
| ExecutionOracle | `0x3c6dcFbcCD0deB7b682492ac89CAB6cCE6538055` |
| Sessions | `0x2d1dd1980c050E509042Fee55B91184c3979940F` |
| Lens | `0x91490008aa27Be3988B109D22b666537e703F89E` |
| Gateway | `0x54f7c8DFAaB564957d53f0ecfBa8EdD9F6C8070C` |
| Batcher | `0x42883d81D4CC1c541B7B728cCd103BC40F35A799` |
| Deposits | `0x937292c6D7F8dB3784c91cE8DFaa6F8352224Ceb` |

The current deployment uses `executionMode: "order-bound"`. Orders receive a fresh signed price
after intake, without the original exchange's fixed two-second wait. Ethereum confirmation still
takes time. Pricing and Sessions are reused; the exchange, oracle and four periphery contracts are new.
`/v2` serves the current API. The original exchange remains available at `/v1` and
`/trade?legacy=1` for withdrawals. Balances stay in their original contract until their owner withdraws.

`script/Deploy.s.sol` and `script/DeployDeposits.s.sol` build the original delayed variant, useful
for local development. They do not reproduce the current FastExchange deployment.
`script/AttachCoin.s.sol` is a separate, optional operation and must not be run when deploying only
the trading platform. No coin is attached to either exchange.

## Architecture

```
browser --signed orders--> relayer --transactions--> FastExchange <-- ExecutionOracle
   ^                          |  ^                      |         (checks the price signer's signature)
   +----- JSON + one SSE -----+  +-- Hyperliquid's API  +--> LossMining --coin--> loser's wallet
                                    (prices, which the  +--> Staking  (USDC for stakers)
                                     relayer signs)
```

Prices are Hyperliquid's (the middle of its best bid and ask), read by the relayer and signed with
the price signer's key. `ORACLE=pyth` at deploy swaps in `PythOracle` and Pyth's own signed
updates instead; see "Trust" for what the difference is.

### Contracts (`src/`)

| Contract | What it does |
| --- | --- |
| `Exchange.sol` | Balances, positions, settlement, fees, the payout queue. Not upgradeable, and no function touches a trader's balance. |
| `FastExchange.sol` | Current exchange. Extends Exchange with no fixed execution wait, signed prices bound to each order, and millisecond ordering of entry and subsequent prices. |
| `base/Intents.sol` | The EIP-712 orders traders sign: `Open`, `Close`, `Withdraw`. An open carries the worst price and the largest size charge it will accept. |
| `Sessions.sol` | Session keys for one-click trading. A key can trade and can never withdraw. |
| `libraries/PerpMath.sol` | The bust price, what a position is charged for the size ahead of it, and the value of a close. Mirrored in `shared/math.mjs`; keep the two in step. |
| `Pricing.sol` | `PerpMath` behind an address. The Exchange is at the size limit of a contract, so it calls its arithmetic instead of carrying it. Pure functions, no storage, no owner; the Exchange can never be pointed at another. |
| `ExecutionOracle.sol` | Current oracle. Fill signatures bind the order hash, feed, chain, oracle and observation time. Public Tick signatures price liquidations, triggers and direct exits. The signer remains trusted for price accuracy and quote selection. Holds nothing. |
| `SignedOracle.sol` | Base oracle and original delayed deployment. A print is signed by the price signer and names its previous publication time. The Exchange's owner can replace the signer. Holds nothing. |
| `PythOracle.sol` | The alternative (`ORACLE=pyth`): Pyth adapter. `pinned` returns the first print at or after a second. Holds an ETH float for Pyth's fee. No owner. |
| `LossMining.sol` | `onLoss` sends coin to the loser as the loss settles. Rejected delivery remains reserved for retry; tickets and loss accounting survive. No vesting or owner. |
| `Staking.sol` | Stake the coin, earn USDC. No lockup, no owner. |
| `Coin.sol` | A plain fixed-supply ERC-20. Optional: `Staking` and `LossMining` take any ERC-20. |
| `periphery/Lens.sol` | Read-only views for the relayer and the site. |
| `periphery/Gateway.sol` | Deposit from a signed USDC permit, so a trader needs no ETH. |
| `periphery/Batcher.sol` | Many Exchange calls in one transaction, each failing on its own. Passes calls on only from the Exchange's operators. No owner, holds nothing. |
| `periphery/SweeperBase.sol`, `SignedSweeper.sol`, `Sweeper.sol` | Sends house cash above the cap to stakers: at most what the operator calling it says can be spared, and never more than its own mark of the open book at a signed price allows. `SignedSweeper` marks with the price signer's prints, `Sweeper` with Pyth's. No owner, holds nothing. |

How the coin side moves money:

- **Loss mining.** `emitted = reserve * loss / (scale + cumulativeLoss + loss)`. Half the reserve is
  gone once cumulative losses reach `scale`, three quarters at three times that, and it never runs
  out. A bust mines on the whole margin; a close at a loss mines on the loss less the house-side
  fee. The Exchange gives the hook 150,000 gas and swallows a failure (`MiningFailed`), so the coin
  can never block a close. Rejected coin delivery preserves the loss and its jackpot tickets, and
  reserves the reward in `pendingRewards(user)`. Anyone can retry `claim(user)`, which always sends
  to that trader. Pending rewards are excluded from the remaining emission reserve; `totalMined`
  includes them, so a retry neither mines again nor changes the curve.
- **Jackpot funding and payment.** `fund(amount)` pulls approved USDC into the current round.
  The fee splitter transfers and calls `sync()` atomically. Plain transfers belong to the round
  in which they are first synced; call `sync()` in the same round, or use `fund` to avoid ambiguity.
  Rounds close and draw in order. Close freezes that round's prize before its future draw hash is
  known; partial prizes and empty pots roll into the next round. A failed USDC payment keeps the
  recorded winner and reserved prize; anyone can retry `claim(round)` to the same winning wallet.
  That reserved USDC never becomes another round's funding. The keeper follows `nextRound`,
  including empty rounds and recovery after downtime.
- **Staking.** USDC reaches `Staking` two ways. `Exchange.pushStakerFees()` (anyone can call it)
  sends the stakers' half of the fees collected so far. `sweep(priceUpdates, maxAmount)` on the sweeper (operators
  only) sends house cash above `stakerCap`. The keeper works out `maxAmount` position by position:
  every winning position's gain at the latest price is held back, no losing position's paper loss
  is counted, and a further 0.2% of everything open stays too. On-chain the Sweeper marks each
  side of each market as a whole at a signed price no older than 30 seconds and refuses to send
  more than that mark allows, which bounds an operator who gets the figure wrong. `Staking` pays
  what it receives **as a stream**: each payment is spread evenly over the next 24 hours, and
  every second of it goes to whoever is staked during that second. A new payment re-spreads what
  is left of the last one together with it. With nobody staked the money waits, and starts
  streaming when the first staker arrives. `claim()` credits the staker's trading balance on the
  Exchange through `depositFor`; it does not send USDC to the wallet. Nobody decides who is paid
  or when, and there is no lockup: a stake earns for exactly the time it is staked, so borrowed
  coin staked for one block earns one block's worth.
- Nothing reaches stakers while winners are queued: no fee is accrued and the excess reads zero
  until the queue is empty.

### Relayer (`relayer/`)

One Node process (Node 22+, one dependency: viem). It serves the site's exchange API.

| Part | File | Job |
| --- | --- | --- |
| Engine | `src/engine.mjs` | Validates signed orders, reserves their funds, takes the first qualifying fresh quote after intake and submits. Current deployments have no fixed execution wait; original deployments retain their pinned two-second pricing. Stale feeds stop new orders. |
| Transaction queue | `src/chain.mjs` | Two lanes on one key. Trades: one transaction in flight, everything that arrives meanwhile batched into the next through `Batcher.multicall` (up to 40 calls). Deposits and session registrations: a second lane. |
| Keeper | `src/keeper.mjs` | Busts positions when a print crosses their line. Executes direct close requests. Pays the queue. Pushes staker fees, and runs the sweep of house cash above the cap after it has liquidated everything past its line. Moves each side's open-interest cap to stay about $1B above that side's open interest (it moves the cap once the room has drifted more than 10%). Watches the oracle's ETH float. |
| Prices | `src/prices/` | `hyperliquid.mjs` streams best bid/ask and book updates. `execution.mjs` signs order-bound fills and public ticks for the current deployment; `signer.mjs` supports the original delayed oracle. Feed IDs determine the asset. Old quotes, an unsynchronized clock, wide books and missing or divergent reference prices stop signing. Prints and per-order quotes are durably written before use. Only one process may sign for an oracle; each deployment needs its own data directory. `dev.mjs` is local-chain only, and `hermes.mjs` supports Pyth deployments. |
| Indexer | `src/indexer.mjs` | Follows events into memory. Rebuilt from the chain's logs on every start. |
| Sampler | `src/series.mjs` | One sample a minute for the charts, last day kept. |
| API | `src/server.mjs` | The routes below. |

Persistent state lives under `DATA_DIR` (`relayer/data/` by default, ignored by git): signed-price
logs, order-bound execution journals, chart samples, usernames, referral bindings/payment history and pending take-profit/stop-loss
instructions. Keep this directory separate for Tape and back it up. Balances are on-chain, but
losing this state can lose pending trigger instructions and referral records.

Routes:

```
GET  /health
GET  /config                  chain, addresses, markets, timing constants, coin symbol
GET  /stream?owner=0x...      server-sent events: ticks, tape, trades, the house, one account
GET  /prices?market=0&seconds=900
GET  /account/:address
GET  /history/:address        { trades, transfers, staking, queue, emissions }
GET  /leaderboard?window=24h|7d|30d|all
GET  /house
GET  /coin
GET  /series?seconds=86400    minute samples for the charts
GET  /status                  feeds, operator ETH, price health, recent blocks
GET  /print?market=&time=     the signed price an order pinned at `time` fills at (latest without it)
GET  /intent/:id
POST /open /close             signed trading intents
POST /session /deposit /withdraw   wallet-signed account actions
POST /username                claim a display name, signed by the wallet
POST /dev/nudge               chain 31337 only: move the simulated price
```

Settings come from the environment or from `.env` at the repo root (`relayer/src/config.mjs`):

| Variable | Meaning | Default |
| --- | --- | --- |
| `CHAIN_ID` | Chain the relayer serves | `31337` |
| `RELAYER_RPC_URL` (or `RPC_URL`) | JSON-RPC endpoint | `http://127.0.0.1:8545` |
| `DEPLOYMENT` | Deployment file | `deployments/<chainId>.json` (a `-coin.json` next to it is merged in) |
| `OPERATOR_KEY_FILE` | File holding the operator key | none |
| `OPERATOR_KEY` | The key itself; prefer the file | anvil account 1 on 31337 |
| `PRICE_SOURCE` | `hyperliquid`, `hermes` or `dev` | `dev` on 31337; elsewhere what the deployment's oracle takes |
| `PRICE_SIGNER_KEY_FILE` | File holding the price signer's key | none (anvil account 9 on 31337) |
| `PRICE_SANITY_BPS` | Furthest a quote may be from the configured reference before nothing is signed; 0 for no deviation check | `150` |
| `PRICE_REFERENCE` | Cross-check prices against Hyperliquid's oracle, Coinbase, or none | `oracle` |
| `PRICE_MAX_SPREAD_BPS` | Widest Hyperliquid book, bid to ask, whose middle is signed; 0 for no limit | `100` |
| `HYPERLIQUID_WS_URL`, `HYPERLIQUID_API_URL` | Hyperliquid's endpoints | its public ones |
| `PYTH_API_KEY`, `HERMES_URL` | For a Pyth deployment: the Hermes key and base URL | none, `https://hermes.pyth.network` |
| `PORT` | HTTP port | `8787` |
| `CORS_ORIGIN` | Allowed browser origins, comma separated | `*` |
| `DATA_DIR` | Tape persistent state and price-log directory | `relayer/data` |
| `RATE_LIMIT` | Orders per account per minute | `40` |
| `TRUST_PROXY` | `1` behind a reverse proxy that sets `X-Forwarded-For` | `0` |
| `ORACLE_TOPUP_ETH` | ETH to send the oracle when its float drops under 0.004 ETH (`0` = only warn) | `0` |
| `STAKER_PUSH_SECONDS` | How often stakers are paid | `5` on 31337, `300` elsewhere |
| `STAKER_PUSH_MIN_USD` | Smallest amount worth a payout transaction | `1` on 31337, `25` elsewhere |
| `POLL_MS` | How often to look for new blocks | `700` on 31337, `4000` elsewhere |

### Site (`web/`)

Vite and React, one stylesheet. Pages: the front page (`/`), Trade, Vault (`/vault`, the house),
Staking, Leaderboard, Stats, Portfolio (from the account menu), and under "More": Dashboard,
Referrals, Docs, Status. In live mode everything it shows,
including the name and the contract addresses, comes from the relayer's `/config`.

| Build variable | Meaning |
| --- | --- |
| `VITE_API_URL` | Where the relayer lives. Read at build time. In `npm run dev` it defaults to `http://127.0.0.1:8787`. |
| `VITE_PREVIEW` | `1` forces preview mode at build time. |
| `VITE_BRAND` | The name shown in preview mode. Default `Tape`. `VITE_COIN` is the coin's ticker there, default `TAPE`. |
| `VITE_RPC_URL` | Only for the built-in test wallet on a local chain. |

### Preview mode

A production build with no `VITE_API_URL` has no relayer to talk to, so it runs an exchange inside
the browser tab (`web/src/lib/preview/`). `engine.ts` keeps the same books as `Exchange.sol` with
the same pricing (`shared/math.mjs`) and answers the same requests the relayer answers. `feed.ts`
takes real market prices from Hyperliquid's public feed. Simulated traders are disabled. The
money is play money: a play account starts
with $10,000 on the exchange and $40,000 in its wallet. State is saved in the browser's
`localStorage`. Nothing is on a chain, nothing is signed, and nothing can be deposited or withdrawn.

The checked-in `web/.env.production` points production builds at Tape's live API. To build a
practice site explicitly, set `VITE_PREVIEW=1`. Cloudflare can host the static site; the relayer
needs a server. Set `VITE_API_URL` at build time to use another relayer. Adding `?preview=1` to
any URL forces preview mode.

## What Ethereum forces

The reference exchange runs on Hyperliquid. These are the places where Ethereum made the design different:

- **A carried price instead of an order-book mid.** A contract on Ethereum cannot read
  Hyperliquid's order book. So the relayer reads it, signs what it read, and carries the signed
  price on-chain with each trade; `SignedOracle` checks the signature. That makes the price
  signer trusted in a way nothing on Hyperliquid has to be.
- **A fresh price bound to the order.** After accepting an order, the relayer waits for a fresh
  venue observation and signs it for that order's hash. A durable journal retains that selection
  across retries and restarts. The contract checks the binding, feed, signature and time range;
  it cannot independently prove which venue quote arrived first. There is no fixed two-second
  wait on the current exchange. Price delivery and Ethereum inclusion still add latency.
- **Operator-only opens and closes, with direct exits.** Because the price is fixed at signing
  while the transaction lands later, only a trusted submitter (an operator) may land an order, and
  only while it is fresh. If operators stop, a trader still gets out alone through
  `requestClose` / `executeClose` and `requestWithdraw` / `executeWithdraw`.
- **Session keys.** A wallet popup per trade does not work at 1000x. The wallet signs once to
  register a key held in the browser; that key signs every open and close and can never withdraw.
- **USDC deposits.** The default wallet flow transfers USDC on Ethereum and needs ETH for gas.
  The external-wallet flow supplies a dedicated deposit address. Where supported, the trader
  can instead sign an EIP-2612 permit and the `Gateway` moves the USDC with sponsored gas.
- **Gas paid by the relayer.** Opens, closes, permit deposits, withdrawals and session registrations
  are submitted by the operator key. Ordinary USDC transfers are sent by the depositing wallet.

**No free options.** Once a price is selected, a trader able to cancel an order before it
lands, or to bring a failing one to life, would keep only the orders that moved their way. So
nothing a trader can call directly changes the fate of an order they have already signed:

- a change to a session key bites one slot (12 s) later, on the order's own timestamp, and a key
  that has ended is never reopened;
- a direct withdrawal request moves no money: it freezes new opens, and pays out after 15 minutes,
  far longer than any order lives;
- a signed withdrawal has its own replay counter and goes through the operator, and the relayer
  sets its amount aside the moment it is accepted;
- a direct close is a binding request. Until every order signed before it has had time to land,
  only an operator can execute it, and a signed close priced after it is refused.

## Layout

```
src/                 contracts (see the table above)
script/              Deploy, AttachCoin, DevDeploy
test/                unit, fuzz, invariant and mainnet-fork tests; fixtures; mocks
shared/              pricing math and EIP-712 types, used by the relayer and the site
relayer/             the relayer; tape-relayer.service is its systemd unit
web/                 the site (Vite, React); web/e2e is the browser test
abi/                 ABIs exported from the build (npm run abi)
tools/               fixture and ABI scripts
deployments/         one JSON file per chain, written by the deploy scripts
lib/                 forge-std and OpenZeppelin, as git submodules
```

## Run it locally

Needs Foundry, Node 22+ and Git. Clone with `--recurse-submodules`, or initialize the pinned
dependencies after cloning:

```sh
git submodule update --init --recursive
npm --prefix relayer ci
npm --prefix web ci
```

The commands below use Anvil's public development key. Use a local chain and test funds only.
Then four terminals:

```sh
npm run dev:chain      # anvil on :8545
npm run dev:deploy     # clean build of deployable/ and out/, deploy with a mock USDC and prices signed by an anvil key, export ABIs
npm run dev:relayer    # http://127.0.0.1:8787
npm run dev:web        # http://127.0.0.1:5173
```

`dev:deploy` attaches the coin, funds four of anvil's accounts with mock USDC and coin, and writes
`deployments/31337.json`. On that chain the site offers built-in test wallets (anvil's public keys)
and the relayer follows public market prices with a little noise. Orders and prices use public
development keys and mock assets; the dev price source refuses to start on any chain but 31337. The protocol's own
contracts are created from `deployable/`, as on mainnet (see
[What gets deployed](#what-gets-deployed)), so the local stack runs the bytecode that ships; that
is also why `dev:deploy` rebuilds from clean first.

To look at preview mode locally, open `http://127.0.0.1:5173/?preview=1`.

## Tests

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm test` | Contract unit, fuzz and invariant tests, on the signed-price oracle that ships. `ORACLE=pyth forge test` runs the same suite on the Pyth adapter. | Foundry |
| `npm run test:deployable` | The same suite, on the bytecode that ships rather than the project's own build of it | Foundry, Node |
| `npm run test:fork` | Mainnet fork: real Pyth, real USDC, real signed price updates | An archive RPC (`ETH_ARCHIVE_RPC_URL`) |
| `npm run test:relayer` | The JavaScript pricing math against the Solidity, row by row; the price book; the price signer and the Hyperliquid source driven by hand; a simulated Hermes stream | Node 22 |
| `npm run test:frontend` | Deposit accounting and funding progress, navigation, market feeds, daily changes and request sharing | Node 22, web dependencies |
| `npm run build:web` | TypeScript checks and a production site build | Node 22, web dependencies |
| `node relayer/test/hyperliquid-live.mjs` | The Hyperliquid source against the real API for half a minute, its prints read back by the SignedOracle contract if the local stack is up | Node 22, a network |
| `npm run test:smoke` | One trader through the whole product over the relayer API. It can be run again on the same chain: it first tops the trader up and pays off whoever an earlier run left queued. | The local stack running |
| `npm run test:e2e` | The same in a real browser, plus every page | The local stack running, and Playwright's Chromium |

`npm run test:invariant` runs the invariants deeper, and `npm run abi` rebuilds and re-exports the
ABIs after a contract interface changes.

`test:fork` and `test:invariant` set an environment variable inline (`FORK=true forge test ...`).
That is POSIX shell syntax. On Windows npm runs scripts through `cmd.exe`, so run those two as bare
commands from Git Bash instead.

The fork test replays guardian-signed Pyth updates lifted out of public mainnet transactions
(`tools/fetch-onchain-fixture.mjs`), so it needs no Pyth API key. Pyth's guardian set rotates, so
each test forks at the block its update comes from; that is why it needs an archive RPC.

The current fast deployment has a separate compiler profile. To reproduce and test its exact
bytecode, run `npm run test:fast` (builds `deployable/fast` before running the fast-contract tests).
Use the default profile for the original exchange and its regression suite. Rebuild the fast
artifacts before running the full suite from a fresh checkout. The standard and fast artifacts
are kept separately so building reward contracts preserves the fast deployment.

Contract wallets are checked through `ExecutionOracle` on the fast deployment. An ERC-1271
wallet that restricts signature verification by caller must allow that oracle address.

## Parameters

Fixed in the contracts:

| | |
| --- | --- |
| Fee on a win's gain, and house-side fee carved from a loss | 2% |
| Stakers' share of every fee (the rest goes to the dev recipient) | 50% |
| Current fill | Fresh order-bound quote after intake, within 10 s of the signed timestamp; fixed wait 0 s |
| An order must land within | 60 s of its timestamp |
| Win deadband | 0.2 bps of the entry price, in whole price ticks |
| Impact curve: what a position is charged on while its side is inside the depth; least a large win is cut | 100,000 USDC, 10% |
| Impact curve past the depth: charged on | 100,000 USDC times how many depths deep the middle of the position sits on its side, fixed at open |
| Staking: a payment reaches stakers over | 24 h |
| Sweep: held back on top of open profit | 0.2% of everything open |
| Sweep: oldest price it will mark the book with | 30 s |
| A change to a session key or an exit request takes effect | 12 s later |
| Session key: longest life | 90 days (the site asks for 30) |
| Direct close: priced | 24 s after the request |
| Direct close: anyone may execute it | a further 60 s later (operators at once) |
| Direct close: lapses if not executed | after 10 min |
| Direct withdrawal delay | 15 min, with new opens frozen meanwhile |
| A non-operator may liquidate | 60 s after the print that crossed the line |
| Max leverage | 1000x |
| Open positions per account | 200 |
| Queue entries paid automatically on each loss | 4 |

Set at deploy and then fixed: the staker cap (house cash above it goes to stakers; default
5,000,000 USDC), the loss-mining scale (default 5,000,000 USDC), and per market the feed, max
leverage (1000), the impact curve's two multipliers (15,000 and 814.598 for BTC, 483.979 for ETH),
the price tick (0.10 USD for BTC, 0.01 for ETH), how far before zero equity a position busts
(4.76 bps of that price for BTC, 4.81 for ETH), the largest share of a gain a win keeps (90%), the
confidence limit (0.20% of price) and the size limit (10,000,000 USDC per position). These are
the reference exchange's own figures. A market's pricing never changes after listing; to change it, retire
the market and list a new one.

Adjustable by the owner only: the cap on what may be open on each side of each market (deployed at
25,000,000 USDC for BTC and 10,000,000 for ETH), each market's depth (deployed at 1,000,000 USDC a
side; see "Moving the price" below for both), the smallest margin (10 USDC) and the smallest
position (10,000 USDC of margin times leverage), which are the reference exchange's. A new depth applies to
positions opened after it; an open position keeps the terms it opened on. There is no flat fee and
nothing else to adjust.

## Who can do what

| Role | Can | Cannot |
| --- | --- | --- |
| Owner | List markets, set operators, guardian and dev recipient, set the caps on open interest and each market's depth, the smallest margin and position, attach the coin once, lift a pause; everything the guardian can | Change fees, the rest of a listed market's pricing, the terms of an open position, the staker share or the staker cap; move anyone's funds; upgrade |
| Operator | Submit signed orders and signed withdrawals, liquidate and execute direct closes at once, sweep house cash above the cap to stakers (within the Sweeper's mark) | Forge an order, choose a price, move funds to anyone but the staking contract, decide who can trade |
| Guardian | Pause new positions, retire a market at a price no older than 60 s | Unpause, touch funds |
| Price signer | Sign prices. Every fill, close and bust is at a price it signed. | Send a transaction, move funds, submit an order. But see below: whoever holds it decides what every position is worth. |
| Anyone | Liquidate and execute a direct close (after the waits above, with the price signer's print for that moment), pay the queue, push staker fees, send dev fees to their recipient, donate to the house | |

**The price signer's key is the first trust in this system.** `ExecutionOracle` accepts a price for
one reason: that key signed it. It cannot tell a true price from a false one, and there is no
second signer and no bound on a price. Whoever holds the key can open a position at the market,
ask for a direct close, and settle it at any price they sign, or bust every position on a side.
What limits the damage is how fast it is noticed: a guardian pauses opens, and the owner replaces
the key with `ExecutionOracle.setSigner`, after which nothing the old key signed counts. The relayer
keeps it apart from the operator's key and never sends it anywhere; it still sits on the same
server, and a break-in there has both. This is the price of reading Hyperliquid. With
`ORACLE=pyth` the price is checked on-chain against Pyth's own signatures and no key of ours can
forge one.

**The operator key is the second.** The contract trusts operators to submit orders
promptly, in order, and only when freshly signed. The only freshness check on-chain is that an
order lands within 60 seconds of its timestamp; the stricter rule (a stamp from the present second)
lives in the relayer. A dishonest or stolen operator key could:

- sit on an honest order for up to 60 seconds, or drop it, after seeing where the price went;
- let a partner trade on timestamps up to a minute old. That drains the house's cash and puts the
  partner ahead of later winners in the queue, and no admin function can undo a queued claim;

It cannot forge an order, substitute a quote signed for another order, or take balances or margin, and it
cannot stop a trader withdrawing their balance directly. Guard that key accordingly, and rotate it
with `setOperator`.

Other trust: Hyperliquid's order book, which is where the price is read; the relayer's checks on
it (freshness, clock, a 1.5% band around the configured reference, Hyperliquid's oracle by default);
and the code itself, which cannot be patched
once deployed.

## Costs to run

The operator pays gas for everything traders do through the site, and for the keeper's chores.
Prices cost nothing: Hyperliquid's feed is free, and a signed price is checked for the gas of one
signature. (On a Pyth deployment each priced call also pays Pyth's update fee out of the oracle
contract's ETH float.) Stakers and traders using the direct exits pay their own gas.

Gas per call, measured on the mainnet fork on 2026-10-11 with the contracts as they are now and no
coin attached: about 410k for an open, 310k for a close and 300k for a liquidation. A losing close
or a bust with the coin attached also carries the coin transfer.

## Moving the price

On 2026-10-10 the reference exchange, which this follows, lost about three fifths of its house in a few
hours. It prices positions off one venue's order book and fills any size at that price. Two
wallets held nine-figure longs, bought about $20M on that venue to lift its price 10 to 20 basis
points, and closed. The win was paid on the whole position; the push was paid for once.

The root of it is in the pricing. The reference exchange's curve has a term for size, and its contract fills
that term in with $100,000 for every position: of the 2,627 real settlements in
`test/fixtures/reference-settlements.csv`, 2,130 are positions of over a million dollars, and
every one was paid as if it were a hundred thousand. A ten-million-dollar position kept the same
share of a ten basis point move as a ten-thousand-dollar one.

The same arithmetic applies to any exchange that fills size at an oracle's price, this one
included. Four things stand against it here:

- **Size costs.** Every market has a depth: how much may be open on one side at the reference exchange's own
  price ($1,000,000 at launch). A side's open interest is a stack. A new position sits on top of
  what is already there, and the size term of its curve is multiplied by how many depths deep its
  middle sits. Up to the depth nothing changes; past it a small win keeps less and less, while a
  large one keeps nearly all of it, and a loss or a bust price is never touched. The charge
  follows the side and not the position, so cutting a position into pieces or spreading it over
  wallets climbs the same stack (the pieces come out about 6% ahead of the whole at most, and
  that does not grow with size), and it is fixed at open, so nobody's terms move after they are
  in. What a whole side can take from a small push then grows as the logarithm of the side, not
  in step with it, and as the square of the push, which is how the cost of making the push grows.
  Because the charge is decided when an order lands, and other orders can land first,
  every order carries the most it will accept (`impactLimit`, signed like the
  price limit; the site sets it a quarter above what the ticket showed, or one depth deeper where
  that is more) and is refused past it.
- **Each side of each market is capped**, so there is a most that can ever be open to be paid.
  Only the owner can change a cap or a depth (`setCaps`, `setDepth`); the relayer's key cannot.
- **The relayer selects a fresh price after accepting each order**, for the open and again for
  the close. This depends on the trusted price signer and cannot prevent manipulation of the
  venue's own prices. Removing the old fixed delay also removes its extra time requirement on a push.

What does NOT stand against it: the price is one venue's. It is read from Hyperliquid's order
book, the same single venue the reference exchange read, so a push means moving that one book and not the
whole market. The caps and the depth are the whole defence, and they are sized for it: at the
launch caps a 15 bps push is paid about $8,000 on a full ETH side and $17,000 on a full BTC side,
against the tens of thousands that buying Hyperliquid's book up that far and selling it back
costs. Raise a cap and that margin shrinks. (A Pyth deployment prices from many venues instead.)

What a side filled to its cap is paid for a push, in the worst case for the house (built from
empty, in small pieces), against what the reference exchange's curve alone would pay:

| | 10 bps push | 15 bps | 30 bps | 100 bps |
| --- | --- | --- | --- | --- |
| ETH, $10M a side: curve alone | $6,800 | $11,000 | $24,100 | $85,700 |
| ETH, $10M a side: with size charged | $4,400 | $7,900 | $19,500 | $79,400 |
| BTC, $25M a side: curve alone | $18,100 | $28,900 | $61,800 | $216,000 |
| BTC, $25M a side: with size charged | $9,400 | $17,200 | $44,400 | $190,700 |
| ETH, if a side were ever $100M: curve alone | $67,600 | $110,200 | | |
| ETH, if a side were ever $100M: with size charged | $12,400 | $24,800 | | |

Those are after the win fee, at the launch depth. `test/Depth.t.sol` replays the drain on the
Exchange itself (`test_aPushOnAFullSidePays...`, `test_aSideTenTimesTheSize...`) at that depth
and at half of it; `test/PerpMath.t.sol` holds the arithmetic to the properties behind them.

What this does not do. It does not make a push impossible, it makes one pay a fraction of what it
did: the judgment that this is less than moving the real BTC or ETH market costs is still a
judgment. At the launch caps it takes about 30% to 40% off a 15 bps push, 15% to 20% off a
50 bps one and 10% off a 100 bps one, so for anything but a small move it is still the caps that
bound the loss: keep that in mind before raising them. A big move that happens by itself is paid nearly in
full to whoever was on the right side, as it should be. Each side of each market is its own
stack, so a push up and back can be paid on the longs going up and on the shorts coming back.
And anyone can crowd a side: with no funding, a large position at low leverage costs its owner
only the capital, and worsens the terms of everyone who opens on that side after it. That is a
milder form of filling the cap, which was already possible. And it has a price for ordinary
traders: on a side that already holds more than its depth, a new position keeps less of a small win (the
ticket shows the multiple before the click). A smaller depth protects more and charges ordinary
traders sooner: at $500,000 the 15 bps column above reads $6,000, $12,600 and $15,500. A larger
one does the reverse. Move the caps and the depth slowly, with the house's
cash and the market's real depth in view. A weekend night is several times thinner than a weekday
afternoon.

## What gets deployed

Tape also enforces a cash-based exposure ceiling in its immutable `Pricing` contract:
each side of each market may hold at most 2,000,000 USDC plus 50 times actual house cash.
Deposits, open cash margin and accrued fees do not raise it. Static market caps apply too,
and falling cash never blocks an exit. The relayer can reject intake earlier but cannot relax
the on-chain ceiling. Contract deployment scripts are in `script/`. Team wallet funding plans,
launch runbooks, secrets and raw broadcast records are excluded from the public source release.

With `via_ir`, what the Solidity compiler makes of a contract can depend on which other files are
in the same compiler run. The Exchange has come out 313 bytes apart depending on whether it was
compiled with the rest of this project or with nothing but its own imports (solc 0.8.26, 0.8.28
and 0.8.30 all do it; no other contract here is affected). Etherscan compiles a contract with
nothing but its own imports. A deployment made from the project's build could therefore fail to
verify, and at the wrong moment would not fit in a contract at all: the Exchange is within a few
hundred bytes of the 24,576-byte limit.

So the scripts do not write `new Exchange(...)`. `tools/deployable.mjs` asks forge for the exact
compiler input a verification would send, compiles each contract from that and nothing else, and
writes the result to `deployable/` with the input beside it. The deploy scripts create contracts
from those files (`script/Deployable.sol`), check after each one that it was built with the
arguments given, and refuse to run at all if a source file has changed since `deployable/` was
built. What is deployed and what verifies are then the same bytes by construction.

`forge script` adds one condition of its own. It works out each created contract's constructor
arguments from its own build of that contract in `out/`, and stops with a decoding error, before
sending anything, if that is another compilation of the same source. So before a script runs,
forge's own build has to be the same bytes too. `--forge` sees to it: it cleans, has forge compile
each of these contracts alone (which is how a verification compiles them), then the rest of the
project, which leaves those alone. The scripts check that as well and say so in words.

```sh
node tools/deployable.mjs            # build deployable/, and print each contract's size
node tools/deployable.mjs --forge    # the same, after rebuilding out/ to agree with it: before any deploy script
node tools/deployable.mjs --check    # change nothing: fail unless both are in order
npm run test:deployable              # the whole contract suite on that bytecode
```

The tests run on the project's own build by default, like any Foundry project. Run them once more
on `deployable/` before a deployment. `tools/deployable.mjs` prints each contract's size against
the limit; keep the Exchange a few hundred bytes clear of it, because the same source has compiled
to sizes 313 bytes apart.

## The coin

`script/AttachCoin.s.sol` attaches a coin that already exists, deploys a plain fixed-supply one, or
deploys the one that opens its own Uniswap pool (`src/LaunchCoin.sol`). A
coin can be attached once and never replaced. Worth knowing before pricing it:

- **Mining has a cost floor, and it is lower than a dollar per dollar.** Someone can hold a long
  and a short at once, lose on one side and win on the other, and mine on the losing side. What
  that costs them is the house's cut of the winning side: at least about 12% of the loss they mine
  on. The coin's market price will not stay far above that cost of mining it.
- **Staking rewards are time-weighted.** A payment is streamed over 24 hours to whoever is staked
  second by second, so there is no moment worth staking around and nobody whose timing matters.
  Frequent payments keep re-spreading the remainder, so in steady state stakers receive money with
  about a day's lag.
- **The sweep is the operator's, because the on-chain mark is only a ceiling.** The Sweeper sees
  each side of a market as a whole. It cannot tell that another trader's paper loss is not cash,
  that a position opened a second ago is being marked at an older price, or that a position is
  past the point where its margin is gone and not yet liquidated. Open to everyone, each of those
  let a staker have the house pay out money it was about to owe a winner (`test/Review2.t.sol`
  has every case with its figures). So only operators may call it, the keeper passes the exact
  figure, and it sweeps only once nothing is waiting to be liquidated or closed. An operator who
  ignored that could still send stakers up to what the mark allows; the house would then sit
  below its cap until losses refilled it. No trader's balance is reachable either way.
- **A payment is re-spread, not queued.** Each new payment spreads what is left of the last one
  over a fresh 24 hours together with itself, however small it is. Paid in often, stakers receive
  about 63% of a payment within a day and 86% within two. Nothing is lost.
- **Use a plain ERC-20.** A coin that taxes transfers works, but stakers are credited what arrives.
  A rebasing coin would break staking's accounting.
- The emission reserve is what `LossMining` holds less its reserved pending rewards; anyone can top it up by sending coin
  to it. Nothing is ever minted. Losses reported while the reserve is empty still advance the curve
  and mine nothing, so fund the reserve before trading starts.

## Review

An earlier version of the contracts was given to an independent reviewer with the brief of
breaking it. It found no accounting error: the books, the queue and the house's cash held under its
own 60,000-action campaign. It did prove eight ways around the rules, six of them ways for a trader
to get a free option by timing a direct call against an order of their own:

| Finding | Fix |
| --- | --- |
| A session key registered late could revive an order once its price was known | A key signs only from one slot after it is registered, and an ended key is never reopened |
| A session registration shared a replay counter with withdrawals and could void one | Withdrawals have their own counter; the relayer sets a pending withdrawal's amount aside |
| A matured withdrawal request could cancel a pending open | A request freezes new opens until it is executed or cancelled |
| The direct close gave the owner a second price, and a way past a liquidation | Non-operators execute it only after everything signed before it could have landed; a signed close priced after it is refused |
| A direct close request that could never execute made a position unliquidatable | Requests lapse after ten minutes |
| A very small price at very high leverage could lock margin | Such an open is refused |
| A coin contract address without code would block losing closes | Each attached contract must answer, under its own name, that it was built for this Exchange |
| The flat fee was not part of the signed order | There is no flat fee any more |

Each has a regression test: `test/Review.t.sol` replays four of the exploits step by step, and the
rest sit next to the code they concern in `test/Exchange.t.sol` and `test/House.t.sol`.

A second pass looked at the coin side once it existed. It found that money could be moved to
stakers that the house was about to owe traders, and that a payout could be captured by staking
around it:

| Finding | Fix |
| --- | --- |
| Hold a long and a short, close the loser, have that loss swept to stakers as "cash above the cap", then close the winner and be paid out of the cap | Only an operator sweeps, with the keeper's position-by-position figure as the ceiling; the `Sweeper` also marks the open book at a fresh Pyth price and refuses more than that |
| A payout landed in one block and an operator chose the block, so a one-block stake could take most of it | Staking streams every payment over 24 hours and has no operator |
| The first staker took everything that had built up before anyone staked | The backlog starts streaming when they arrive, like any other payment |
| A fee could be taken while queue-funded margin in other positions was still owed | The fee waits behind that margin too |
| `attachCoin` accepted any address, once, for good | Each contract is asked, under a name only its kind answers to, which Exchange it was built for |
| A mining hook without code reverted the settlement it was called from | The hook is called at the lowest level and a failure is only logged |
| A coin whose transfer needs more gas than the hook is given would attach and then mine nothing | `script/AttachCoin.s.sol` pays a test loss in simulation and refuses before sending anything |
| `script/AttachCoin.s.sol` trusted its inputs | It checks the owner, the coin, the scale's units and that the reserve is funded first |

A third pass, on 2026-10-11, followed the drain of the reference exchange (see "Moving the price"). It priced
size, moved the arithmetic behind `Pricing` to make room, and had the result attacked by a fresh
reviewer, who found nothing that broke the rule but these:

| Finding | Fix |
| --- | --- |
| What a position is charged on is decided when its order lands, so a larger order landing first, or a change of depth, could worsen an order already signed | Every order carries the most it will accept (`impactLimit`), and is refused past it |
| The Exchange compiled to different bytes inside the project than on its own: it would not have fitted, and would not have verified | The scripts deploy the build a verification makes (see "What gets deployed") |
| The inherited EIP-712 base cost 1,300 bytes for a view nothing used | The domain is worked out in `Intents`; a test holds it to the standard one |
| The relayer and the site carry the contract's timing rules as numbers of their own | The relayer compares them with the contract when it starts, and stops if they differ |

Left as they are, and worth knowing: the owner can move a market's depth at once (orders in
flight are covered by their own limit; positions keep their terms); splitting a position is paid a
few percent more than the whole; a side can be crowded on purpose.

That is three passes by the same tooling that wrote the code, not an audit. Before real money goes
in, an outside firm should audit all of it.

## Status

Eight core contracts are deployed on Ethereum and verified; addresses are in `deployments/1.json`.
The coin launch remains on hold. The three reward correctness findings have been fixed in source
with regression tests; the revised reward contracts remain undeployed. The live API is `https://api.tapemarket.io`.

What to know before using it:

- **Not audited.** The reviews above were done with the same tooling that wrote the code. No
  outside firm has audited it.
- **Prices are signed by one key.** They are Hyperliquid's, read and signed by the relayer. Whoever
  holds that key sets the price the contracts accept: see "Trust" under
  [Who can do what](#who-can-do-what).
- **The relayer is one server.** Orders go through it. A balance can always be withdrawn straight
  from the Exchange without it (after a 15-minute delay): see
  [What Ethereum forces](#what-ethereum-forces).
- **The contracts cannot be patched.** What is deployed is what runs.

## License and contributions

Tape's code is released under the [MIT license](LICENSE). Dependencies and bundled fonts retain
their own licenses. See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

