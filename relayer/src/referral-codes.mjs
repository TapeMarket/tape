import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAddress, isHex } from "viem";
import { REFERRAL_CODE_RULE, referralCodeMessage } from "../../shared/referral-code.mjs";
import { isAddr, lower, Rejected } from "./util.mjs";

/** Permanent custom codes, independent of display names; no released code can change owner. */
export function createReferralCodes({ config, chain, addressOfName, log, file }) {
  const path = file ?? join(config.dataDir ?? join(config.root, "relayer", "data"), `referral-codes-${config.chainId}.json`);
  const codes = new Map();
  const owners = new Map();
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid referral-code registry.");
    for (const [owner, code] of Object.entries(saved)) {
      if (!isAddr(owner) || typeof code !== "string" || !REFERRAL_CODE_RULE.test(code) || owners.has(code)) throw new Error("Invalid referral-code registry.");
      const key = lower(owner);
      const named = addressOfName(code);
      if (codes.has(key) || (named && lower(named) !== key)) throw new Error("Conflicting referral-code registry.");
      codes.set(key, code);
      owners.set(code, key);
    }
  }

  function check(owner, code) {
    const previous = codes.get(owner);
    if (previous && previous !== code) throw new Rejected("This wallet already has a permanent custom code.", 409);
    const holder = owners.get(code) ?? addressOfName(code);
    if (holder && lower(holder) !== owner) throw new Rejected("That referral code is taken. Try another.", 409);
  }

  async function claim(body) {
    const { owner, signature } = body ?? {};
    const code = typeof body?.code === "string" ? body.code.trim().toLowerCase() : "";
    if (!isAddr(owner) || typeof signature !== "string" || !isHex(signature)) throw new Rejected("Malformed request.");
    if (!REFERRAL_CODE_RULE.test(code)) throw new Rejected("Use 3 to 16 letters, numbers or underscores.");
    const key = lower(owner);
    check(key, code);
    const message = referralCodeMessage({ code, owner, chainId: config.chainId, exchange: chain.addresses.exchange });
    const valid = await chain.publicClient.verifyMessage({ address: getAddress(owner), message, signature }).catch(() => false);
    if (!valid) throw new Rejected("That signature does not match. Try again.", 401);
    // A different claim or username can win while signature verification awaits its RPC.
    check(key, code);
    if (codes.get(key) === code) return { ok: true, code };
    const next = new Map(codes).set(key, code);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(Object.fromEntries(next)), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      log.warn(`referral codes: could not save: ${error.message}`);
      throw new Rejected("Couldn’t save your code. Please try again.", 503);
    }
    codes.set(key, code);
    owners.set(code, key);
    return { ok: true, code };
  }

  return { claim, codeOf: owner => codes.get(lower(owner)) ?? null, addressOf: code => owners.get(String(code).toLowerCase()) };
}
