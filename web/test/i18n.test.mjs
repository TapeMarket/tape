import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
const catalog = locale => JSON.parse(readFileSync(new URL(`../src/locales/${locale}.json`, import.meta.url), "utf8"));
const english = catalog("en");
const tokens = text => [...text.matchAll(/<\/?\d+>|\{\d+\}/g)].map(match => match[0]).sort();
const bundle = await build({ stdin: { contents: 'export * from "./i18n"; export * from "./format";', resolveDir: fileURLToPath(new URL("../src/lib/", import.meta.url)), loader: "ts" }, bundle: true, write: false, format: "cjs", platform: "node", external: ["react", "react/jsx-runtime"], logLevel: "silent" });
function fixture() { const module = { exports: {} }; new Function("module", "exports", "require", bundle.outputFiles[0].text)(module, module.exports, require); return module.exports; }

test("every language covers the English catalog and preserves amounts, rich-text slots and link structure", () => {
  for (const locale of ["zh-CN", "ru", "ko", "ja"]) {
    const translated = catalog(locale);
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort(), `${locale} coverage`);
    for (const [key, value] of Object.entries(translated)) {
      assert.ok(typeof value === "string" && value.trim(), `${locale}: empty ${key}`);
      assert.deepEqual(tokens(value), tokens(key), `${locale}: slots changed in ${key}`);
      const stack = [];
      for (const match of value.matchAll(/<(\/?)(\d+)>/g)) {
        if (!match[1]) stack.push(match[2]); else assert.equal(stack.pop(), match[2], `${locale}: invalid rich-text nesting`);
      }
      assert.equal(stack.length, 0, `${locale}: unclosed rich-text tag`);
    }
  }
});

test("static interface messages and accessible labels have catalog entries", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = ["main.tsx", "ExchangeApp.tsx", ...["components", "pages"].flatMap(dir => readdirSync(root + dir).filter(name => name.endsWith(".tsx")).map(name => `${dir}/${name}`))];
  for (const file of files) {
    const ast = ts.createSourceFile(file, readFileSync(root + file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = node => {
      let key;
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "tx" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) key = node.arguments[0].text;
      if (ts.isJsxAttribute(node) && node.name.getText(ast) === "message" && node.initializer) {
        const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
        if (value && ts.isStringLiteral(value)) key = value.text;
      }
      if (key) assert.ok(Object.hasOwn(english, key.trim()), `${file}: missing ${key}`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

test("switching languages preserves financial amounts, input parsing, addresses and English fallback", async () => {
  const f = fixture();
  for (const locale of ["en", "zh-CN", "ru", "ko", "ja"]) {
    await f.setLocale(locale, false);
    assert.equal(f.tx("Total balance"), locale === "en" ? "Total balance" : catalog(locale)["Total balance"]);
    assert.equal(f.usd("20776100"), "$20.78");
    assert.equal(f.usdExact("20776100"), "20.7761 USDC");
    assert.equal(f.amountTyped("", "20.7761"), "20.7761");
    assert.equal(f.tx("Unrecognised provider error"), "Unrecognised provider error");
    assert.equal(f.tx("constructor"), "constructor");
    const address = "0x2260611726a4A6d71FAD6C040A40A0a76F221865";
    assert.ok(f.tx("Sent on {0} to {1}.", ["Ethereum", address]).includes(address));
    assert.equal(f.tx(" padded unknown "), " padded unknown ");
  }
});

test("rich translations keep recovery links and escape user-provided values", async () => {
  const f = fixture();
  for (const locale of ["en", "zh-CN", "ru", "ko", "ja"]) {
    await f.setLocale(locale, false);
    const markup = renderToStaticMarkup(React.createElement(f.Localized, {
      message: "<0>Previous exchange{0}.</0> Withdraw your remaining USDC here. <1>Trade on current Tape →</1>",
      values: [" <script>never run</script>"], components: [React.createElement("strong"), React.createElement("a", { href: "/trade?legacy=1" })],
    }));
    assert.ok(markup.includes('href="/trade?legacy=1"'));
    assert.ok(markup.includes("&lt;script&gt;"));
    assert.ok(!markup.includes("<script>"));
  }
});

test("a slower language load cannot overwrite a newer choice", async () => {
  const f = fixture();
  const slow = f.setLocale("ru", false);
  await f.setLocale("en", false); await slow;
  assert.equal(f.getLocale(), "en");
  await f.setLocale("unsupported", false);
  assert.equal(f.getLocale(), "en");
});
