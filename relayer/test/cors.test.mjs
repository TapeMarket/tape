import test from "node:test";
import assert from "node:assert/strict";
import { corsFor } from "../src/server.mjs";
test("both Tape domains get one valid CORS origin, with cache variation", () => {
  const allowed = "https://tapemarket.io, https://www.tapemarket.io";
  for (const origin of allowed.split(", ")) assert.deepEqual(corsFor(allowed, origin), { vary: "Origin", "access-control-allow-origin": origin });
  for (const origin of [undefined, "null", "https://tapemarket.io.evil.test", "http://tapemarket.io", "https://evil.test"]) assert.deepEqual(corsFor(allowed, origin), { vary: "Origin" });
});
test("single-origin and public CORS configurations remain supported", () => {
  assert.equal(corsFor("https://tapemarket.io", "https://tapemarket.io")["access-control-allow-origin"], "https://tapemarket.io");
  assert.deepEqual(corsFor("*", "https://any.test"), { "access-control-allow-origin": "*" });
});
