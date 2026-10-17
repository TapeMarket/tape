import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Rejected } from "./util.mjs";

const DAY = 86_400_000;
const RETENTION = 90 * DAY;
const ID = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const MESSAGE_ID = /^[a-zA-Z0-9_-]{16,64}$/;
const TOPICS = new Set(["Trading", "Deposits", "Withdrawals", "Something else"]);
const hash = value => createHash("sha256").update(value).digest();
const bearer = req => /^Bearer ([a-f0-9.]+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
const clean = value => typeof value === "string" ? value.trim() : "";

/** Private, human support. No wallet or transaction is required for a customer conversation. */
export async function createSupport({ dir, admins, verifyMessage, now = Date.now, log = console }) {
  const allowed = new Set(admins.map(a => a.toLowerCase()));
  const rows = new Map();
  const locks = new Map();
  const challenges = new Map();
  const sessions = new Map();
  const rates = new Map();
  const listeners = new Set();
  let lastPrune = 0;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of await readdir(dir)) {
    if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
    try {
      const row = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (!ID.test(row.id) || file !== `${row.id}.json` || !TOKEN.test(row.secretHash) || !Array.isArray(row.messages)) continue;
      if (now() - row.updatedAt > RETENTION) { await unlink(join(dir, file)); continue; }
      rows.set(row.id, row);
    } catch (error) { log.warn(`support: could not load ticket ${file}: ${error.message}`); }
  }

  function limit(key, max, period = 60_000) {
    const t = now();
    const hit = rates.get(key);
    if (hit && t - hit.at < period) {
      if (hit.n >= max) throw new Rejected("Please wait a moment before sending another message.", 429);
      hit.n++;
    } else {
      if (rates.size > 10_000) for (const [k, value] of rates) if (t - value.at > DAY) rates.delete(k);
      if (rates.size > 20_000) throw new Rejected("Support is busy. Please try again shortly.", 503);
      rates.set(key, { at: t, n: 1 });
    }
  }
  function staff(req) {
    const token = bearer(req);
    const session = sessions.get(hash(token).toString("hex"));
    if (!session || session.until <= now()) throw new Rejected("Sign in to the support inbox.", 401);
    return session;
  }
  const online = () => [...sessions.values()].some(s => s.until > now() && s.availableUntil > now());
  function customer(req, id) {
    const [ticket, secret, extra] = bearer(req).split(".");
    const row = rows.get(id);
    if (extra || ticket !== id || !TOKEN.test(secret ?? "") || !row || !timingSafeEqual(hash(secret), Buffer.from(row.secretHash, "hex"))) {
      throw new Rejected("This conversation could not be opened. Use the browser where you started it.", 401);
    }
    return row;
  }
  const view = row => ({ id: row.id, topic: row.topic, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, messages: row.messages, online: online() });
  const summary = row => ({ id: row.id, topic: row.topic, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
    preview: row.messages.at(-1)?.text ?? "", unread: row.messages.slice(row.seenCount ?? 0).filter(m => m.role === "customer").length });
  function emit(id) { for (const listener of listeners) if (!listener.id || listener.id === id) listener.send({ id, online: online() }); }
  async function save(row) {
    const file = join(dir, `${row.id}.json`);
    const temp = `${file}.tmp`;
    const handle = await open(temp, "w", 0o600);
    try { await handle.writeFile(JSON.stringify(row)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    rows.set(row.id, row);
    emit(row.id);
  }
  async function serial(id, fn) {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    locks.set(id, next);
    try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
  }
  async function prune() {
    if (now() - lastPrune < DAY) return;
    lastPrune = now();
    for (const [id, row] of rows) if (now() - row.updatedAt > RETENTION && !locks.has(id)) {
      await serial(id, async () => {
        if (now() - (rows.get(id)?.updatedAt ?? now()) <= RETENTION) return;
        await unlink(join(dir, `${id}.json`)).catch(() => {});
        rows.delete(id);
      });
    }
    for (const [key, value] of sessions) if (value.until <= now()) sessions.delete(key);
    for (const [key, value] of challenges) if (value.until <= now()) challenges.delete(key);
  }
  function message(body) {
    const text = clean(body?.text);
    const id = body?.messageId;
    if (!text || text.length > 3000) throw new Rejected("Write a message of up to 3,000 characters.");
    if (!MESSAGE_ID.test(id ?? "")) throw new Rejected("The message reference is missing. Please retry.");
    return { id, text };
  }
  async function add(id, body, role, req) {
    const m = message(body);
    return serial(id, async () => {
      const row = role === "staff" ? (staff(req), rows.get(id)) : customer(req, id);
      if (!row) throw new Rejected("Conversation not found.", 404);
      const previous = row.messages.find(value => value.id === m.id);
      if (previous) {
        if (previous.role !== role || previous.text !== m.text) throw new Rejected("That message reference is already in use.", 409);
        return view(row);
      }
      limit(`messages:${role}:${id}`, role === "staff" ? 60 : 15);
      if (row.messages.length >= 300) throw new Rejected("This conversation has reached its message limit. Start a new conversation.", 409);
      const next = { ...row, status: "open", updatedAt: now(), messages: [...row.messages, { ...m, role, at: now() }] };
      await save(next);
      return view(next);
    });
  }

  return {
    async handle({ req, res, path, url, body, client, send }) {
      if (!path.startsWith("/support/")) return false;
      res.setHeader("cache-control", "no-store");
      limit(`requests:${client}`, 300);
      await prune();
      const post = req.method === "POST";
      if (path === "/support/status" && req.method === "GET") { send(res, 200, { online: online(), retentionDays: 90 }); return true; }
      if (path === "/support/auth/challenge" && post) {
        limit(`auth:${client}`, 8);
        const owner = clean(body?.owner).toLowerCase();
        if (!allowed.has(owner)) throw new Rejected("This wallet does not have support inbox access.", 403);
        const nonce = randomBytes(24).toString("hex");
        const until = now() + 5 * 60_000;
        const message = `Tape support inbox\nSite: https://tapemarket.io\nWallet: ${owner}\nNonce: ${nonce}\nExpires: ${new Date(until).toISOString()}\n\nSign in to read and reply to customer messages. No transaction or token approval.`;
        challenges.set(nonce, { owner, message, until });
        send(res, 200, { nonce, message }); return true;
      }
      if (path === "/support/auth" && post) {
        limit(`auth:${client}`, 8);
        const challenge = challenges.get(body?.nonce);
        challenges.delete(body?.nonce);
        if (!challenge || challenge.until <= now() || !allowed.has(challenge.owner)) throw new Rejected("The sign-in request expired. Try again.", 401);
        if (!await verifyMessage({ address: challenge.owner, message: challenge.message, signature: body?.signature }).catch(() => false)) throw new Rejected("That signature does not match the support wallet.", 401);
        const token = randomBytes(32).toString("hex");
        const until = now() + 8 * 60 * 60_000;
        sessions.set(hash(token).toString("hex"), { owner: challenge.owner, until, availableUntil: 0 });
        send(res, 200, { token, until }); return true;
      }
      if (path === "/support/logout" && post) { staff(req); sessions.delete(hash(bearer(req)).toString("hex")); emit(); send(res, 200, { ok: true }); return true; }
      if (path === "/support/presence" && post) { const s = staff(req); s.availableUntil = body?.available === true ? now() + 45_000 : 0; emit(); send(res, 200, { online: online() }); return true; }
      if (path === "/support/inbox" && req.method === "GET") { staff(req); send(res, 200, { conversations: [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summary), online: online() }); return true; }
      if (path === "/support/conversations" && post) {
        if (body?.website) throw new Rejected("Message refused.", 400);
        const { id, token } = body ?? {};
        const m = message(body);
        if (!ID.test(id ?? "") || !TOKEN.test(token ?? "")) throw new Rejected("The conversation reference is missing. Please retry.");
        if (!TOPICS.has(body?.topic)) throw new Rejected("Choose a support topic.");
        await serial(id, async () => {
          const existing = rows.get(id);
          if (existing) {
            if (!timingSafeEqual(hash(token), Buffer.from(existing.secretHash, "hex"))) throw new Rejected("That conversation already exists.", 409);
            const previous = existing.messages.find(value => value.id === m.id);
            if (!previous || previous.role !== "customer" || previous.text !== m.text) throw new Rejected("The conversation has already started. Reopen it to continue.", 409);
            send(res, 200, view(existing)); return;
          }
          limit(`new:${client}`, 4, 60 * 60_000);
          if (rows.size >= 5000) throw new Rejected("The support inbox is full. Please try again later.", 503);
          const row = { id, secretHash: hash(token).toString("hex"), topic: body.topic, status: "open", createdAt: now(), updatedAt: now(), seenCount: 0, messages: [{ ...m, role: "customer", at: now() }] };
          await save(row);
          send(res, 200, view(row));
        });
        return true;
      }
      if (path === "/support/events" && req.method === "GET") {
        const id = url.searchParams.get("id");
        const session = id ? (customer(req, id), null) : staff(req);
        const sessionKey = session ? hash(bearer(req)).toString("hex") : null;
        if ([...listeners].filter(l => l.client === client).length >= 4 || listeners.size >= 2000) throw new Rejected("Too many support connections.", 429);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
        const listener = { id, client, send: data => {
          if ((sessionKey && (!sessions.has(sessionKey) || session.until <= now())) || (id && !rows.has(id))) { res.end(); return; }
          if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
        } };
        listeners.add(listener);
        listener.send({ online: online() });
        const timer = setInterval(() => {
          if (session && session.until <= now()) { res.end(); return; }
          listener.send({ online: online() });
        }, 15_000);
        res.on("close", () => { clearInterval(timer); listeners.delete(listener); });
        return true;
      }
      const match = /^\/support\/(conversations|tickets)\/([a-f0-9]{32})(?:\/(messages|resolve|seen))?$/.exec(path);
      if (match) {
        const [, section, id, action] = match;
        const isStaff = section === "tickets";
        const row = isStaff ? (staff(req), rows.get(id)) : customer(req, id);
        if (!row) throw new Rejected("Conversation not found.", 404);
        if (!action && req.method === "GET") { send(res, 200, view(row)); return true; }
        if (action === "messages" && post) { send(res, 200, await add(id, body, isStaff ? "staff" : "customer", req)); return true; }
        if (isStaff && post && (action === "seen" || action === "resolve")) {
          const updated = await serial(id, async () => {
            staff(req);
            const current = rows.get(id);
            if (!current) throw new Rejected("Conversation not found.", 404);
            const next = { ...current, seenCount: current.messages.length, ...(action === "resolve" ? { status: "closed" } : {}) };
            await save(next); return next;
          });
          send(res, 200, view(updated)); return true;
        }
      }
      throw new Rejected("Support route not found.", 404);
    },
    close() { for (const listener of listeners) listener.send({ reconnect: true }); },
  };
}
