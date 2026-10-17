/**
 * The relayer's public address: api.tapemarket.io.
 *
 * Cloudflare answers on that name and passes every request on to the server the relayer runs on.
 * The site and its visitors only ever see api.tapemarket.io; where the server is, and under what
 * name, is this file's business alone.
 *
 * Two headers go with each request, for the server's own front door (Caddy):
 *   X-Edge-Key    a key only this Worker and the server know. The server answers nothing without
 *                 it, so the relayer cannot be reached around Cloudflare.
 *   X-Client-Ip   the visitor's address as Cloudflare saw it. The relayer's limits are per visitor,
 *                 and every request reaches the server from Cloudflare's own addresses.
 *
 * The body is passed on as a stream both ways: each visitor holds one long-lived event stream open.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("x-edge-key", env.EDGE_KEY);
    headers.set("x-client-ip", request.headers.get("cf-connecting-ip") ?? "");
    const init = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
    try {
      return await fetch(env.UPSTREAM + url.pathname + url.search, init);
    } catch {
      return new Response(JSON.stringify({ error: "The exchange's server is not answering right now. Try again in a moment." }), {
        status: 502,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }
  },
};
