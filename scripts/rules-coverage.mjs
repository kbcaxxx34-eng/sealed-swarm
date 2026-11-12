#!/usr/bin/env node
// Lists, for every rule in RULES.md (A1, P3, V3, ...), the tests that check it, and fails if a rule
// has no test. Test names carry rule IDs in brackets, e.g. it("[A5][A7] highest bidder wins ...").
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const rules = [...fs.readFileSync(new URL("RULES.md", root), "utf8").matchAll(/^\d+\. \*\*([APVS]\d+)\.\*\* (.*)$/gm)]
  .map((m) => ({ id: m[1], text: m[2].replace(/\*\*/g, "").replace(/`/g, "").slice(0, 90) }));
const files = ["test/SealedSwarmAuction.ts", "test/BuyerPools.ts", "test/Limits.ts", "near-vault/test/vault.test.mjs", "near-vault/test/fuzz.test.mjs"];
const tests = [];
for (const f of files) {
  const src = fs.readFileSync(new URL(f, root), "utf8");
  for (const m of src.matchAll(/(?:\bit|\btest|console\.log)\(\s*[`"']((?:\[[APVS]\d+\])+)\s*([^`"']*)/g)) tests.push({ ids: m[1].match(/[APVS]\d+/g), name: m[2].trim(), file: f });
  for (const m of src.matchAll(/fuzz ((?:\[[APVS]\d+\])+)/g)) tests.push({ ids: m[1].match(/[APVS]\d+/g), name: "fuzz: 10,000 random requests and 2,000 settle calls", file: f });
}
let missing = 0;
console.log(`${rules.length} rules, ${tests.length} tagged tests\n`);
for (const r of rules) {
  const t = tests.filter((x) => x.ids.includes(r.id));
  if (!t.length) missing++;
  console.log(`${t.length ? "✔" : "✗"} ${r.id}  ${r.text}`);
  for (const x of t) console.log(`      ${x.file}: ${x.name}`);
}
const unknown = [...new Set(tests.flatMap((x) => x.ids))].filter((id) => !rules.some((r) => r.id === id));
if (unknown.length) { console.log(`\ntests cite unknown rules: ${unknown.join(", ")}`); missing++; }
console.log(missing ? `\n${missing} rule(s) without a test` : `\nevery rule has at least one test`);
process.exit(missing ? 1 : 0);
