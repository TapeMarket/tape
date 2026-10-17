/**
 * The print log: every print the price signer signs, on disk before it leaves the process.
 *
 * Two things depend on it surviving a restart.
 *
 *   One chain. A print's place in the chain (which second it is the first print of) must never be
 *   signed twice. In memory alone, a process that restarts while the machine's clock has been set
 *   back would sign a second "first print" for a second it already signed. With the log, a new
 *   process starts from the last second on record, whatever the clock says.
 *
 *   No private copies. A direct close is priced at the first print at or after its moment, and
 *   anyone may execute it with that print. If a restart lost the print, the only copy would be
 *   whatever a trader had fetched from /print, to use or not as suited them.
 *
 * One file an hour, `prints-<chain>-<oracle>-<hour>.jsonl`, a line a print; the hour before last
 * is deleted as a new one starts. A lock file beside them names the process that is signing, and a
 * second process with the same key refuses to start while that one lives: two signers are two
 * chains.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { open, readdir, unlink } from "node:fs/promises";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and is somebody else's. ESRCH: no such process.
    return error.code === "EPERM";
  }
}

/**
 * @param {object} options
 * @param {string} options.dir where the files live
 * @param {number} options.chainId
 * @param {string} options.oracle the SignedOracle the prints are for
 * @param {string} options.signer the address signing them: another key's prints are not reloaded
 * @param {number} [options.keepSeconds] how far back a restart reloads
 */
export function createPrintLog({ dir, chainId, oracle, signer, keepSeconds = 30 * 60, now = Date.now, pid = process.pid }) {
  const stem = `prints-${chainId}-${oracle.toLowerCase()}`;
  const lockFile = join(dir, `${stem}.lock`);
  const fileOf = (hour) => join(dir, `${stem}-${hour}.jsonl`);
  const hourOf = (seconds) => Math.floor(seconds / 3600);
  const me = signer.toLowerCase();
  let locked = false;
  let lastHour = null;
  let durableWrites = Promise.resolve();
  const row = (feedId, print) => ({ signer: me, feedId, time: print.time, prev: print.prev, price: print.price.toString(), conf: print.conf.toString(), blob: print.blob,
    ...(print.observedAt !== undefined ? { observedAt: print.observedAt, prevObservedAt: print.prevObservedAt } : {}) });

  return {
    /** Takes the lock, or throws naming the process that holds it. */
    acquire() {
      mkdirSync(dir, { recursive: true });
      if (existsSync(lockFile)) {
        const holder = Number(readFileSync(lockFile, "utf8").trim());
        if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
          throw new Error(`Another relayer (pid ${holder}) is already signing prices for this oracle. Two signers would sign two different prices for the same second. Stop it first; if it is truly gone, delete ${lockFile}.`);
        }
      }
      writeFileSync(lockFile, `${pid}\n`);
      locked = true;
    },
    release() {
      if (!locked) return;
      locked = false;
      try {
        if (Number(readFileSync(lockFile, "utf8").trim()) === pid) rmSync(lockFile);
      } catch {
        // Already gone.
      }
    },
    /** This signer's prints of the last `keepSeconds`, oldest first. */
    load() {
      const nowSeconds = Math.floor(now() / 1000);
      const from = nowSeconds - keepSeconds;
      const out = [];
      for (let hour = hourOf(from); hour <= hourOf(nowSeconds) + 1; hour++) {
        let text;
        try {
          text = readFileSync(fileOf(hour), "utf8");
        } catch {
          continue;
        }
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const r = JSON.parse(line);
            if (String(r.signer).toLowerCase() !== me || !(r.time >= from)) continue;
            out.push({ feedId: r.feedId, time: r.time, prev: r.prev, price: BigInt(r.price), conf: BigInt(r.conf), blob: r.blob,
              ...(r.observedAt !== undefined ? { observedAt: r.observedAt, prevObservedAt: r.prevObservedAt } : {}) });
          } catch {
            // A line cut short by a crash: the print it held never left the process.
          }
        }
      }
      return out.sort((a, b) => (a.observedAt ?? a.time * 1000) - (b.observedAt ?? b.time * 1000));
    },
    /** Writes a print down. It has to return before the print is used for anything. */
    append(feedId, print) {
      const hour = hourOf(print.time);
      appendFileSync(fileOf(hour), `${JSON.stringify(row(feedId, print))}\n`);
      if (hour === lastHour) return;
      lastHour = hour;
      try {
        for (const name of readdirSync(dir)) {
          const m = name.startsWith(`${stem}-`) && /-(\d+)\.jsonl$/.exec(name);
          if (m && Number(m[1]) < hour - 1) rmSync(join(dir, name));
        }
      } catch {
        // Old files left behind cost disk space and nothing else.
      }
    },
    /** Async fsync before a high-resolution public tick is made available for settlement. */
    appendDurable(feedId, print) {
      const operation = durableWrites.then(async () => {
        const hour = hourOf(print.time);
        const handle = await open(fileOf(hour), "a", 0o600);
        try { await handle.writeFile(`${JSON.stringify(row(feedId, print))}\n`); await handle.sync(); }
        finally { await handle.close(); }
        if (hour !== lastHour) {
          lastHour = hour;
          for (const name of await readdir(dir)) {
            const match = name.startsWith(`${stem}-`) && /-(\d+)\.jsonl$/.exec(name);
            if (match && Number(match[1]) < hour - 1) await unlink(join(dir, name)).catch(() => {});
          }
        }
      });
      durableWrites = operation;
      return operation;
    },
  };
}
