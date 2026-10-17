// Exercise shared-server Caddy preservation and failure recovery without SSH or real services.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
const installer = readFileSync(new URL("./server-install.sh", import.meta.url), "utf8");
const section = [...installer.matchAll(/remote_in 'bash -s' <<'REMOTE'\r?\n([\s\S]*?)\r?\nREMOTE/g)].map((m) => m[1]).find((s) => s.includes("Caddyfile.tape-backup"));
assert.ok(section, "Caddy install section must exist");
const bash = process.platform === "win32" ? join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe") : "bash";
const posix = (p) => p.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const prior = '# Existing shared sites\nexisting.example {\n  respond "old-service"\n}\n';
const next = 'tape.example {\n  respond "tape-service"\n}\n';

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "tape-installer-"));
  const caddy = join(dir, "etc/caddy"), systemd = join(dir, "etc/systemd");
  mkdirSync(join(caddy, "tape"), { recursive: true });
  writeFileSync(join(caddy, "Caddyfile"), prior);
  writeFileSync(join(caddy, "tape/Caddyfile.new"), next);
  const restartLog = join(dir, "restarts"), failureFlag = join(dir, "failed-once");
  const stubs = `
systemctl() {
  if [ "$1" = restart ]; then
    printf 'restart\\n' >> '${posix(restartLog)}'
    if [ "$FAIL_RESTART" = 1 ] && [ ! -e '${posix(failureFlag)}' ]; then touch '${posix(failureFlag)}'; return 1; fi
  fi
  return 0
}
caddy() { [ "$FAIL_VALIDATE" != 1 ]; }
ufw() { return 0; }
sleep() { return 0; }
`;
  const script = stubs + section.replaceAll("/etc/caddy", posix(caddy)).replaceAll("/etc/systemd", posix(systemd));
  const run = (env = {}) => spawnSync(bash, ["--noprofile", "--norc", "-s"], { input: script, encoding: "utf8", windowsHide: true, env: { ...process.env, FAIL_VALIDATE: "0", FAIL_RESTART: "0", ...env } });
  try { fn({ caddy, run, restartLog }); } finally {
    if (realpathSync(dirname(dir)) !== realpathSync(tmpdir()) || !dirname(dir) || !dir.includes("tape-installer-")) throw Error("Refusing unsafe test cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
}
test("install preserves existing sites and repeating it does not restart Caddy", () => fixture(({ caddy, run, restartLog }) => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const main = readFileSync(join(caddy, "Caddyfile"), "utf8");
  assert.ok(main.startsWith(prior));
  assert.equal(main.split("import ").length - 1, 1);
  assert.equal(readFileSync(join(caddy, "tape/Caddyfile"), "utf8"), next);
  writeFileSync(join(caddy, "tape/Caddyfile.new"), next);
  const repeated = run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(restartLog, "utf8"), "restart\n");
}));
test("invalid Caddy settings restore the previous main file without restarting", () => fixture(({ caddy, run, restartLog }) => {
  const result = run({ FAIL_VALIDATE: "1" });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(caddy, "Caddyfile"), "utf8"), prior);
  assert.equal(existsSync(join(caddy, "tape/Caddyfile")), false);
  assert.equal(existsSync(restartLog), false);
}));
test("a failed restart restores the previous main file and Tape fragment, then restarts", () => fixture(({ caddy, run, restartLog }) => {
  const oldFragment = 'tape.example { respond "previous-tape" }\n';
  writeFileSync(join(caddy, "tape/Caddyfile"), oldFragment);
  const result = run({ FAIL_RESTART: "1" });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(caddy, "Caddyfile"), "utf8"), prior);
  assert.equal(readFileSync(join(caddy, "tape/Caddyfile"), "utf8"), oldFragment);
  assert.equal(readFileSync(restartLog, "utf8"), "restart\nrestart\n");
}));
