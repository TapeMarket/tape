/**
 * Builds the bytecode that goes on the chain, into deployable/.
 *
 * Why the deploy scripts do not simply write `new Exchange(...)`: with `via_ir`, what the Solidity
 * compiler makes of one contract depends on which other files are in the same compiler run. The
 * Exchange comes out 313 bytes apart depending on whether it is compiled with the rest of this
 * project or with nothing but its own imports (solc 0.8.26, 0.8.28 and 0.8.30 all do it; no other
 * contract here is affected). Etherscan compiles a contract with nothing but its own imports. So a
 * deployment made from the project's build could not be verified, and at the wrong moment would
 * not fit in a contract at all.
 *
 * So each contract is built here the way a verification builds it: forge is asked for the exact
 * compiler input it would send to Etherscan, and the pinned solc compiles that and nothing else.
 * The scripts deploy these artifacts (script/Deployable.sol), which makes "what is deployed" and
 * "what verifies" the same thing by construction. For each contract this writes
 *
 *   deployable/<Name>.json         abi and bytecode, as forge's own artifacts are laid out
 *   deployable/<Name>.input.json   the compiler input, as Etherscan takes it (Standard-Json-Input)
 *
 * and deployable/manifest.json, a hash of every source file that went in. The scripts refuse to
 * deploy if a source has changed since.
 *
 * One more thing has to hold before a script can run. `forge script` works out the constructor
 * arguments of each contract it sees created from its own build of that contract in out/, and
 * stops, before sending anything, if that is not the same bytes as what was created. So forge's
 * own build has to agree with deployable/. It does when each of these contracts was compiled by
 * forge on its own before the rest of the project, which is what --forge does:
 *
 *   node tools/deployable.mjs            build deployable/ from the sources as they stand
 *   node tools/deployable.mjs --forge    first rebuild out/ so that forge's build agrees with it:
 *                                        forge clean, each contract alone, then everything else
 *   node tools/deployable.mjs --check    build nothing: fail unless deployable/ is exactly what
 *                                        the sources build and forge's own build agrees with it
 *
 * The tests need none of that: `DEPLOYABLE=true forge test` runs them on deployable/ whatever is
 * in out/.
 *
 * Set SOLC to the compiler binary if it is not where svm (Foundry's own installer) keeps it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FAST = process.argv.includes("--fast");
const HYBRID = process.argv.includes("--hybrid");
if (FAST && HYBRID) throw Error("Choose --fast or --hybrid");
const DIR = join(ROOT, "deployable", ...(HYBRID ? ["hybrid"] : FAST ? ["fast"] : []));
if (FAST || HYBRID) {
  process.env.FOUNDRY_PROFILE = "fast";
  process.env.FOUNDRY_OUT ??= HYBRID ? "out-hybrid" : "out-fast";
  process.env.FOUNDRY_CACHE_PATH ??= HYBRID ? "cache-hybrid" : "cache-fast";
}
const PROJECT_OUT = (process.env.FOUNDRY_OUT ?? "out").replace(/\/+$/, "");
const CHECK = process.argv.includes("--check");
const FORGE = process.argv.includes("--forge");
const SIZE_LIMIT = 24_576;
/** A contract this close to the limit is one edit away from not deploying. */
const SIZE_WARNING = 200;

// Everything script/Deploy.s.sol and script/AttachCoin.s.sol create.
const CONTRACTS = HYBRID ? [
  "src/FastExchange.sol:FastExchange", "src/ExecutionOracle.sol:ExecutionOracle",
  "src/ExchangeBootstrap.sol:ExchangeBootstrap", "src/EmergencyExchange.sol:EmergencyExchange",
  "src/EmergencyCustodyVault.sol:EmergencyCustodyVault",
  "src/HybridUpgradeController.sol:HybridUpgradeController", "src/HybridExchangeProxy.sol:HybridExchangeProxy",
] : FAST ? ["src/FastExchange.sol:FastExchange", "src/ExecutionOracle.sol:ExecutionOracle"] : [
  "src/Exchange.sol:Exchange",
  "src/Pricing.sol:Pricing",
  "src/SignedOracle.sol:SignedOracle",
  "src/PythOracle.sol:PythOracle",
  "src/Sessions.sol:Sessions",
  "src/periphery/Lens.sol:Lens",
  "src/periphery/Gateway.sol:Gateway",
  "src/periphery/Batcher.sol:Batcher",
  "src/periphery/Deposits.sol:Deposits",
  "src/periphery/SignedSweeper.sol:SignedSweeper",
  "src/periphery/Sweeper.sol:Sweeper",
  "src/Coin.sol:Coin",
  "src/LaunchCoin.sol:LaunchCoin",
  "src/periphery/FeeHook.sol:FeeHook",
  "src/Staking.sol:Staking",
  "src/LossMining.sol:LossMining",
  "src/Jackpot.sol:Jackpot",
  "src/periphery/FeeSplitter.sol:FeeSplitter",
];

const version = /solc_version\s*=\s*"([^"]+)"/.exec(readFileSync(join(ROOT, "foundry.toml"), "utf8"))?.[1];
if (!version) throw new Error("foundry.toml does not pin solc_version");

function findSolc() {
  const candidates = [
    process.env.SOLC,
    process.env.APPDATA && join(process.env.APPDATA, "svm", version, `solc-${version}`),
    join(homedir(), ".svm", version, `solc-${version}`),
    join(homedir(), ".local", "share", "svm", version, `solc-${version}`),
    join(homedir(), "Library", "Application Support", "svm", version, `solc-${version}`),
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`solc ${version} not found. Run forge build once (it installs it), or set SOLC. Looked in:\n  ${candidates.join("\n  ")}`);
  return found;
}

const sha256 = (bytes) => `0x${createHash("sha256").update(bytes).digest("hex")}`;
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

const solc = findSolc();

if (FORGE) {
  // A contract forge compiles on its own, with nothing but its imports, comes out as a verification
  // compiles it. Once that is in out/, building the rest of the project leaves it alone. The
  // Exchange goes first: three of the others import it, and would otherwise compile it their way.
  const forge = (...args) => execFileSync("forge", args, { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  console.log("forge clean, then each contract on its own, then the rest (a few minutes)");
  forge("clean");
  for (const target of CONTRACTS) forge("build", target.split(":")[0]);
  if (!FAST && !HYBRID) forge("build");
}

const scratch = mkdtempSync(join(tmpdir(), "deployable-"));
const files = new Map();
const sources = {};
const windowsEndings = new Set();
/** Contracts whose build in forge's own output folder is not the bytes in deployable/. */
const disagree = [];
let failed = false;

console.log(`solc ${version}${CHECK ? ", checking deployable/ against the sources" : ""}\n`);
try {
  for (const target of CONTRACTS) {
    const [file, name] = target.split(":");
    // The input a verification would send: the contract's own imports and the project's settings.
    const inputText = execFileSync("forge", ["verify-contract", "0x0000000000000000000000000000000000000001", target, "--show-standard-json-input"], {
      cwd: ROOT,
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const input = JSON.parse(inputText);
    // The files as they are on disk, byte for byte: that is what the scripts can read back and compare.
    for (const path of Object.keys(input.sources)) sources[path] = sha256(readFileSync(join(ROOT, path)));
    // A contract's bytecode ends with a hash of its sources, so the same commit checked out with
    // Windows line endings would build different bytes. Sources are compiled with Unix ones always.
    let rewritten = false;
    for (const [path, source] of Object.entries(input.sources)) {
      if (!source.content.includes("\r\n")) continue;
      source.content = source.content.replaceAll("\r\n", "\n");
      windowsEndings.add(path);
      rewritten = true;
    }

    // What is asked for does not change what is compiled; the input kept for Etherscan is forge's own.
    const asked = structuredClone(input);
    asked.settings.outputSelection = { [file]: { [name]: ["abi", "storageLayout", "evm.bytecode.object", "evm.deployedBytecode.object"] } };
    const askedFile = join(scratch, `${name}.json`);
    writeFileSync(askedFile, JSON.stringify(asked));
    const output = JSON.parse(execFileSync(solc, ["--standard-json", askedFile], { maxBuffer: 1 << 30 }).toString());
    const errors = (output.errors ?? []).filter((e) => e.severity === "error");
    if (errors.length) throw new Error(`${name}: ${errors[0].formattedMessage}`);
    const built = output.contracts[file][name];
    const creation = built.evm.bytecode.object;
    const runtime = built.evm.deployedBytecode.object;
    if (creation.includes("__$")) throw new Error(`${name} needs a library linked in, which this does not do`);

    files.set(`${name}.json`, pretty({ contract: target, solc: version, abi: built.abi, storageLayout: built.storageLayout, bytecode: { object: `0x${creation}` }, deployedBytecode: { object: `0x${runtime}` } }));
    // Untouched, this is byte for byte what `forge verify-contract` sends.
    files.set(`${name}.input.json`, `${rewritten ? JSON.stringify(input) : inputText}\n`);

    const size = runtime.length / 2;
    const margin = SIZE_LIMIT - size;
    const notes = [];
    if (margin < 0) {
      notes.push(`${-margin} bytes OVER the limit`);
      failed = true;
    } else if (margin < SIZE_WARNING) notes.push(`only ${margin} bytes under the limit`);
    // Whether forge's own build of it is the same bytes. The deploy scripts need it to be.
    const projectArtifact = join(ROOT, PROJECT_OUT, file.split("/").pop(), `${name}.json`);
    const project = existsSync(projectArtifact) ? JSON.parse(readFileSync(projectArtifact, "utf8")).bytecode.object.slice(2) : null;
    if (project !== creation) {
      disagree.push(name);
      notes.push(project === null ? `not built in ${PROJECT_OUT}/` : `forge's build in ${PROJECT_OUT}/ differs`);
    }
    console.log(`${margin < 0 ? "FAIL" : "ok  "}  ${name.padEnd(11)} ${String(size).padStart(6)} bytes, ${String(margin).padStart(6)} to spare${notes.length ? `  ${notes.join("; ")}` : ""}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
files.set(
  "manifest.json",
  pretty({
    solc: version,
    // Each contract, and where forge keeps its own build of it.
    contracts: Object.fromEntries(CONTRACTS.map((target) => [target.split(":")[1], `${target.split("/").pop().split(":")[0]}:${target.split(":")[1]}`])),
    sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => (a < b ? -1 : 1))),
  }),
);

if (CHECK) {
  const stale = [...files].filter(([name, text]) => !existsSync(join(DIR, name)) || readFileSync(join(DIR, name), "utf8") !== text).map(([name]) => name);
  if (stale.length) {
    console.log(`\ndeployable/ is not what these sources build: ${stale.join(", ")}`);
    failed = true;
  }
} else if (!failed) {
  mkdirSync(DIR, { recursive: true });
  // The standard build and the fast build share a parent, but use different compiler profiles.
  // Rebuilding reward contracts must preserve deployable/fast and its exact deployed bytecode.
  for (const entry of readdirSync(DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) rmSync(join(DIR, entry.name));
  }
  for (const [name, text] of files) writeFileSync(join(DIR, name), text);
}

if (CHECK && disagree.length) failed = true;
if (failed) {
  console.log(`\nDo not deploy.${CHECK ? " Run node tools/deployable.mjs --forge and look at what it says." : ""}`);
  process.exit(1);
}
console.log(CHECK ? "\ndeployable/ is exactly what these sources build, forge's own build agrees with it, and every contract fits." : `\nWrote ${files.size} files to deployable/. Every contract fits.`);
if (disagree.length) {
  console.log(`\nforge's own build of ${disagree.join(", ")} is not the same bytes as deployable/. The tests do not mind`);
  console.log("(DEPLOYABLE=true forge test). The deploy scripts do, and will stop: run node tools/deployable.mjs --forge first.");
}
if (windowsEndings.size) {
  console.log(`\nNote: ${windowsEndings.size} source files are checked out with Windows line endings (${[...windowsEndings].slice(0, 3).join(", ")}${windowsEndings.size > 3 ? ", ..." : ""}).`);
  console.log("They were compiled with Unix ones, so the bytecode is the same as from any other checkout. `forge verify-contract`");
  console.log("would send the files as they are on disk, which differ: verify with deployable/<Name>.input.json instead, or check");
  console.log("the repository out again with `git config core.autocrlf false` (in lib/* too) so the two agree.");
}
