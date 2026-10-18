import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env, PATH: `${join(homedir(), ".foundry", "bin")}${delimiter}${process.env.PATH}`,
  FOUNDRY_PROFILE: "fast", FOUNDRY_OUT: "out-hybrid", FOUNDRY_CACHE_PATH: "cache-hybrid" };
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const file of ["tools/hybrid-admin.mjs", "tools/hybrid-layout.mjs", "tools/test-hybrid.mjs"]) {
  run(process.execPath, ["--check", file]);
}
if (!process.argv.includes("--skip-build")) run(process.execPath, ["tools/deployable.mjs", "--hybrid", "--forge"]);
run(process.execPath, ["tools/hybrid-layout.mjs"]);
run(process.execPath, ["--test", "tools/hybrid-layout.test.mjs"]);
env.FOUNDRY_PROFILE = "default";
env.FOUNDRY_OUT = "out-hybrid-test";
env.FOUNDRY_CACHE_PATH = "cache-hybrid-test";
run(join(homedir(), ".foundry", "bin", process.platform === "win32" ? "forge.exe" : "forge"),
  ["test", "--match-contract", "HybridExchangeTest", "-vv"]);
