/**
 * The feed's posts: what is posted and what is not, and the X signature's shape.
 *   node --test relayer/test/feed.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthHeader, postFor } from "../src/feed.mjs";

const options = { symbol: "BTC", name: null, minWinUsd: 250, minLiqUsd: 250_000, site: "https://tapemarket.io" };
const trade = (patch) => ({
  isLong: true,
  leverage: 1000,
  margin: 100_000000n,
  entryPrice: 8_140_250_000_000n,
  exitPrice: 8_143_710_000_000n,
  pnl: 412_550000n,
  busted: false,
  ...patch,
});

test("a big win is posted with its return on margin", () => {
  const text = postFor(trade({}), options);
  assert.match(text, /^\+\$412\.55 \(\+412\.5%\) on a 1000x BTC long\. In at \$81,402\.50, out at \$81,437\.10\./);
  assert.match(text, /tapemarket\.io\/trade$/);
});

test("a small win is not", () => {
  assert.equal(postFor(trade({ pnl: 249_000000n }), options), null);
});

test("a big liquidation is posted; a small one is not", () => {
  const big = postFor(trade({ busted: true, margin: 500_000000n, pnl: -500_000000n }), options);
  assert.match(big, /^Liquidated\. BTC long at 1000x, \$500,000\.00 position, \$500\.00 margin gone at \$81,437\.10\./);
  assert.equal(postFor(trade({ busted: true, margin: 100_000000n, pnl: -100_000000n }), options), null);
});

test("a username leads the post", () => {
  assert.match(postFor(trade({}), { ...options, name: "fomo_frank" }), /^fomo_frank: \+\$412\.55/);
});

test("a trade whose opening was not seen is not posted", () => {
  assert.equal(postFor(trade({ margin: null, leverage: null }), options), null);
});

test("the X header carries every OAuth field and a signature", () => {
  const header = oauthHeader("POST", "https://api.x.com/2/tweets", { apiKey: "k", apiSecret: "s", accessToken: "t", accessSecret: "a" }, "nonce", "1700000000");
  for (const field of ["oauth_consumer_key=\"k\"", "oauth_nonce=\"nonce\"", "oauth_signature_method=\"HMAC-SHA1\"", "oauth_timestamp=\"1700000000\"", "oauth_token=\"t\"", "oauth_version=\"1.0\"", "oauth_signature="]) {
    assert.ok(header.includes(field), field);
  }
  // Same inputs, same signature; a different secret, a different one.
  assert.equal(header, oauthHeader("POST", "https://api.x.com/2/tweets", { apiKey: "k", apiSecret: "s", accessToken: "t", accessSecret: "a" }, "nonce", "1700000000"));
  assert.notEqual(header, oauthHeader("POST", "https://api.x.com/2/tweets", { apiKey: "k", apiSecret: "z", accessToken: "t", accessSecret: "a" }, "nonce", "1700000000"));
});
