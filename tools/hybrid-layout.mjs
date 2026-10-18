import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function typeShape(layout, id, path = new Set()) {
  const t = layout.types[id];
  if (!t) throw Error(`Missing storage type ${id}`);
  if (path.has(id)) throw Error(`Recursive storage type ${id} needs manual review`);
  const nested = new Set([...path, id]);
  const shape = {
    encoding: t.encoding,
    label: t.label.replaceAll(/\b(?:Exchange|ExchangeState|FastExchange)\./g, ""),
    bytes: t.numberOfBytes,
  };
  for (const name of ["key", "value", "base"]) if (t[name]) shape[name] = typeShape(layout, t[name], nested);
  if (t.members) shape.members = t.members.map(m => ({
    label: m.label, slot: m.slot, offset: m.offset, type: typeShape(layout, m.type, nested),
  }));
  return shape;
}

export function canonicalLayout(layout) {
  if (!layout?.storage?.length) throw Error("Compiler artifact has no storage layout");
  return layout.storage.map(field => ({
    label: field.label, slot: field.slot, offset: field.offset, type: typeShape(layout, field.type),
  }));
}

export function requireCompatible(expected, actual, label) {
  if (actual.length < expected.length) throw Error(`${label}: existing storage was removed`);
  for (let i = 0; i < expected.length; ++i) {
    if (JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) {
      throw Error(`${label}: incompatible storage at ${expected[i].label} (index ${i})`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const json = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
  const baseline = json("test/fixtures/exchange-storage-layout.json");
  const current = canonicalLayout(json("deployable/hybrid/FastExchange.json").storageLayout);
  requireCompatible(baseline, current, "Trading implementation");
  if (baseline.at(-1).label !== "_executionTime") throw Error("Unexpected FastExchange storage tail");
  const shared = baseline.slice(0, -1);
  for (const name of ["EmergencyExchange", "ExchangeBootstrap"]) {
    const layout = canonicalLayout(json(`deployable/hybrid/${name}.json`).storageLayout);
    requireCompatible(shared, layout, name);
    if (layout.length !== shared.length) throw Error(`${name}: recovery must not overwrite FastExchange's trailing storage`);
  }
  console.log(`Storage compatible: ${current.length} trading fields; bootstrap and recovery preserve the ${shared.length}-field prefix.`);
}
