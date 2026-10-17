# Contributing to Tape

Use Node 22 or newer and Foundry. Initialize the pinned Git submodules, then install the locked
dependencies with `npm --prefix relayer ci` and `npm --prefix web ci`. The README describes the
local Anvil stack and its public test keys.

Before opening a pull request, run the checks relevant to the change:

```sh
forge test
npm run test:relayer
npm run test:frontend
npm run build:web
```

For Solidity changes, also run `npm run test:deployable` from a POSIX shell. The deploy scripts
use the isolated compiler inputs produced by `tools/deployable.mjs`; the ordinary Foundry build
alone does not establish that the deployable artifacts are current or within the contract size
limit. Changes to pricing must keep `shared/math.mjs` and Solidity in agreement and preserve the
parity fixtures.

Describe the problem, resulting behavior and validation in each pull request. Contract changes
need regression coverage for their accounting and authorization effects. UI changes should be
checked at desktop and phone widths, including keyboard access and error states.

Do not commit wallet keys, RPC credentials, `.env` files, personal account details, funding plans
or production service state. Use test wallets and local mock assets when developing. Public
development keys already present in Anvil examples must never hold real funds.

See `SECURITY.md` before sharing a potential exploit.
