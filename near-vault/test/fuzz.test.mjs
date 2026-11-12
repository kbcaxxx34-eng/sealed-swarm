// Fuzz: thousands of random requests — most of them attacks — against the compiled SwarmVault wasm.
//
// Safety: whatever the vault approves, decoded independently with viem, must obey the whole policy
//   (caller is an agent, not paused, EIP-1559 on Sepolia, the approved auction contract, no ETH, an
//   allowed function, under the gas caps, first entry per auction), and the MPC payload must be the
//   keccak of exactly those bytes. Any approved request that breaks a rule fails the test.
// Liveness: every well-formed request that obeys the policy must be approved.
// Settlement: random settle calls never pay an unlisted seller, never pay twice, never exceed budget.
//
// Deterministic (seeded); FUZZ_N overrides the request count (default 10,000).
import fs from "node:fs";
import assert from "node:assert/strict";
import { keccak256, serializeTransaction, encodeFunctionData, hexToBytes, bytesToHex, parseTransaction, toFunctionSelector } from "viem";
import { makeVm, configArgs, Panic, settlementArgs, budgetArgs, settleArgs } from "../lib/vault-vm.mjs";

const abi = JSON.parse(fs.readFileSync(new URL("../../app/src/contract.json", import.meta.url), "utf8")).abi;
const N = Number(process.env.FUZZ_N || 10000);
const VAULT = "vault.owner.testnet", OWNER = "owner.testnet", MPC = "v1.signer-prod.testnet";
const AUCTION = "0x2B5a1C37967FC1612EE075d2516c3ACa7b543b05";
const MAX_FEE = 50_000_000_000n, MAX_GAS = 3_000_000n;
const AGENTS = ["atlas", "nova", "quill", "orion"].map((name, i) => ({ name, publicKey: new Uint8Array(32).fill(i + 1) }));
const acct = (i) => `${AGENTS[i].name}.${VAULT}`;
const ALLOWED = new Map([[toFunctionSelector("placeBid(uint256,bytes32,bytes)"), "bid"], [toFunctionSelector("joinPool(uint256,uint256,bytes32,bytes)"), "join"], [toFunctionSelector("submitPool(uint256,uint256)"), "submit"]]);

// xorshift PRNG, seeded
let seed = 0x5eed5a1n;
const rnd = () => { seed ^= seed << 13n; seed &= (1n << 64n) - 1n; seed ^= seed >> 7n; seed ^= seed << 17n; seed &= (1n << 64n) - 1n; return Number(seed % 1000000007n) / 1000000007; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const randHex = (n) => "0x" + Array.from({ length: n }, () => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join("");

const vm = makeVm({ accountId: VAULT });
vm.call("configure", { input: configArgs({ auction: AUCTION, maxFee: MAX_FEE, maxGas: MAX_GAS, agents: AGENTS }), predecessor: OWNER });

// reference model of the vault's per-agent state
const entered = new Set(), joined = new Set(), submitted = new Set();
let paused = false;
const counts = { requests: 0, approved: 0, refused: 0, validApproved: 0, attacksRefused: 0, attacks: {} };
const callers = [...AGENTS.map((_, i) => acct(i)), OWNER, "mallory.testnet", `atlas.vault.mallory.testnet`, `atlas${VAULT}`, VAULT, "atlas.vault.owner.testne"];

function buildRequest() {
  const caller = chance(0.75) ? acct(Math.floor(rnd() * 4)) : pick(callers);
  const auctionId = BigInt(1 + Math.floor(rnd() * (chance(0.5) ? 40 : 5000))); // some reuse (double entry), mostly fresh
  const fn = chance(0.7) ? pick(["placeBid", "joinPool", "submitPool"]) : pick(["close", "reveal", "createAuction", "transfer", "empty", "random", "short"]);
  let data;
  if (fn === "placeBid") data = encodeFunctionData({ abi, functionName: "placeBid", args: [auctionId, randHex(32), randHex(1 + Math.floor(rnd() * 120))] });
  else if (fn === "joinPool") data = encodeFunctionData({ abi, functionName: "joinPool", args: [auctionId, BigInt(Math.floor(rnd() * 3)), randHex(32), randHex(1 + Math.floor(rnd() * 120))] });
  else if (fn === "submitPool") data = encodeFunctionData({ abi, functionName: "submitPool", args: [auctionId, BigInt(1 + Math.floor(rnd() * 2))] });
  else if (fn === "close") data = encodeFunctionData({ abi, functionName: "close", args: [auctionId] });
  else if (fn === "reveal") data = encodeFunctionData({ abi, functionName: "reveal", args: [auctionId, "0x00", "0x00"] });
  else if (fn === "createAuction") data = encodeFunctionData({ abi, functionName: "createAuction", args: ["8x H100", 600n, 1n] });
  else if (fn === "transfer") data = "0xa9059cbb" + "00".repeat(12) + "dead".repeat(5) + "00".repeat(31) + "01"; // ERC-20 transfer
  else if (fn === "empty") data = "0x";
  else if (fn === "short") data = randHex(Math.floor(rnd() * 35));
  else data = randHex(4 + Math.floor(rnd() * 80));
  const lookalike = AUCTION.toLowerCase().slice(0, -1) + "6"; // one character off
  const to = chance(0.8) ? AUCTION : pick([lookalike, "0x000000000000000000000000000000000000dead", randHex(20)]);
  const chainId = chance(0.88) ? 11155111 : pick([1, 11155112, 5, 8453, 42161]);
  const value = chance(0.88) ? 0n : BigInt(1 + Math.floor(rnd() * 1e9));
  const gas = chance(0.85) ? BigInt(21000 + Math.floor(rnd() * Number(MAX_GAS - 21000n))) : MAX_GAS + BigInt(1 + Math.floor(rnd() * 1e7));
  const maxFeePerGas = chance(0.85) ? BigInt(1 + Math.floor(rnd() * Number(MAX_FEE))) : MAX_FEE + BigInt(1 + Math.floor(rnd() * 1e13));
  const type = chance(0.93) ? "eip1559" : pick(["legacy", "eip2930"]);
  let raw;
  if (type === "eip1559") raw = serializeTransaction({ type, chainId, nonce: Math.floor(rnd() * 1000), maxPriorityFeePerGas: 1n, maxFeePerGas, gas, to, value, data, ...(chance(0.04) ? { accessList: [{ address: to, storageKeys: [] }] } : {}) });
  else if (type === "legacy") raw = serializeTransaction({ type, chainId, nonce: 1, gasPrice: maxFeePerGas, gas, to, value, data });
  else raw = serializeTransaction({ type, chainId, nonce: 1, gasPrice: maxFeePerGas, gas, to, value, data, accessList: [] });
  let bytes = hexToBytes(raw);
  const corrupt = chance(0.06);
  if (corrupt) {
    const m = pick(["truncate", "flip", "append", "zero"]);
    if (m === "truncate") bytes = bytes.slice(0, Math.max(1, Math.floor(rnd() * bytes.length)));
    else if (m === "append") bytes = new Uint8Array([...bytes, ...hexToBytes(randHex(1 + Math.floor(rnd() * 8)))]);
    else { bytes = new Uint8Array(bytes); const i = Math.floor(rnd() * bytes.length); bytes[i] = m === "zero" ? 0 : bytes[i] ^ (1 << Math.floor(rnd() * 8)); }
  }
  return { caller, bytes, corrupt, intended: { fn, to, chainId, value, gas, maxFeePerGas, type, auctionId } };
}

// what the policy says about a decoded request (independent of the wasm)
function policyViolations(caller, bytes) {
  const v = [];
  const agent = AGENTS.findIndex((_, i) => acct(i) === caller);
  if (agent < 0) v.push("caller is not an agent");
  if (paused) v.push("vault paused");
  let t;
  try { t = parseTransaction(bytesToHex(bytes)); } catch { return { agent, v: [...v, "malformed transaction"] }; }
  if (t.type !== "eip1559") v.push("not EIP-1559");
  if (t.chainId !== 11155111) v.push("wrong chain");
  if (!t.to || t.to.toLowerCase() !== AUCTION.toLowerCase()) v.push("wrong target");
  if ((t.value ?? 0n) !== 0n) v.push("sends ETH");
  if (t.accessList?.length) v.push("access list");
  if ((t.gas ?? 0n) > MAX_GAS) v.push("gas above cap");
  if ((t.maxFeePerGas ?? 0n) > MAX_FEE) v.push("fee above cap");
  const kind = t.data && t.data.length >= 10 ? ALLOWED.get(t.data.slice(0, 10)) : undefined;
  if (!kind || t.data.length < 2 + 2 * 36) v.push("function not allowed");
  let key = null;
  if (kind && agent >= 0 && t.data.length >= 74) {
    key = `${agent}:${BigInt("0x" + t.data.slice(10, 74))}`;
    if (kind === "submit") { if (!joined.has(key)) v.push("submit without joining"); else if (submitted.has(key)) v.push("pool submitted twice"); }
    else if (entered.has(key)) v.push("entered the auction twice");
  }
  return { agent, v, t, kind, key };
}

console.log(`SwarmVault fuzz (compiled wasm, ${N.toLocaleString("en")} random requests)`);
for (let n = 0; n < N; n++) {
  if (paused ? chance(0.2) : chance(0.004)) { paused = !paused; vm.call("pause", { input: new Uint8Array([paused ? 1 : 0]), predecessor: OWNER }); } // short pauses
  const { caller, bytes } = buildRequest();
  const expect = policyViolations(caller, bytes);
  let approved = false, payload = null;
  try {
    const r = vm.call("request_sign", { input: bytes, predecessor: caller });
    approved = r.promises.length === 1 && r.promises[0].account === MPC;
    payload = approved ? "0x" + JSON.parse(r.promises[0].args).request.payload_v2.Ecdsa : null;
  } catch (e) { if (!(e instanceof Panic)) throw e; }
  counts.requests++;
  if (approved) {
    counts.approved++;
    // SAFETY: an approved request must obey every rule, and the MPC signs exactly these bytes
    assert.deepEqual(expect.v, [], `vault approved a request that breaks the policy: ${expect.v.join(", ")} (request #${n})`);
    assert.equal(payload, keccak256(bytes), `MPC payload is not keccak of the request (#${n})`);
    if (expect.kind === "submit") submitted.add(expect.key); else { entered.add(expect.key); if (expect.kind === "join") joined.add(expect.key); }
    counts.validApproved++;
  } else {
    counts.refused++;
    // LIVENESS: a well-formed request that obeys the policy must not be refused
    assert.ok(expect.v.length > 0, `vault refused a valid request (#${n}, caller ${caller})`);
    counts.attacksRefused++;
    for (const r of expect.v) counts.attacks[r] = (counts.attacks[r] || 0) + 1;
  }
}

// settlement fuzz: unlisted sellers, other auctions, double pay, over budget, non-agents
const s = makeVm({ accountId: VAULT });
s.call("configure", { input: configArgs({ auction: AUCTION, agents: AGENTS }), predecessor: OWNER });
s.call("set_settlement", { input: settlementArgs("wrap.testnet", "wrap.testnet"), predecessor: OWNER });
s.call("allow_seller", { input: new TextEncoder().encode("gpus.owner.testnet"), predecessor: OWNER });
const budget = [500n, 500n, 500n, 500n];
AGENTS.forEach((_, i) => s.call("set_budget", { input: budgetArgs(i, budget[i]), predecessor: OWNER }));
const entry = new Set();
for (let a = 0; a < 4; a++) for (let id = 1n; id <= 6n; id++) if (chance(0.7)) {
  s.call("request_sign", { input: hexToBytes(serializeTransaction({ type: "eip1559", chainId: 11155111, nonce: 1, maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, gas: 100000n, to: AUCTION, value: 0n, data: encodeFunctionData({ abi, functionName: "placeBid", args: [id, randHex(32), "0x00"] }) })), predecessor: acct(a) });
  entry.add(`${a}:${id}`);
}
const paid = new Set(); let pays = 0, settleRefused = 0;
for (let n = 0; n < Math.round(N / 5); n++) {
  const caller = chance(0.85) ? acct(Math.floor(rnd() * 4)) : pick([OWNER, "mallory.testnet", VAULT]);
  const a = AGENTS.findIndex((_, i) => acct(i) === caller);
  const id = BigInt(1 + Math.floor(rnd() * 8));
  const amount = BigInt(Math.floor(rnd() * 300));
  const seller = chance(0.7) ? "gpus.owner.testnet" : pick(["attacker.testnet", "gpus.owner.testnet.evil", "gpus-owner.testnet", "owner.testnet"]);
  const ok = a >= 0 && seller === "gpus.owner.testnet" && amount > 0n && entry.has(`${a}:${id}`) && !paid.has(`${a}:${id}`) && amount <= budget[a];
  let did = false;
  try { const r = s.call("settle", { input: settleArgs(id, amount, seller), predecessor: caller }); did = r.promises[0]?.method === "ft_transfer"; if (did) assert.equal(JSON.parse(r.promises[0].args).receiver_id, "gpus.owner.testnet"); }
  catch (e) { if (!(e instanceof Panic)) throw e; }
  assert.equal(did, ok, `settle #${n}: vault ${did ? "paid" : "refused"}, policy says ${ok ? "pay" : "refuse"}`);
  if (did) { pays++; paid.add(`${a}:${id}`); budget[a] -= amount; } else settleRefused++;
}

const top = Object.entries(counts.attacks).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ");
console.log(`  ✔ ${counts.requests.toLocaleString("en")} request_sign calls: ${counts.validApproved.toLocaleString("en")} valid requests signed, ${counts.attacksRefused.toLocaleString("en")} policy violations refused, 0 violations signed`);
console.log(`    violations seen: ${top}`);
console.log(`  ✔ ${Math.round(N / 5).toLocaleString("en")} settle calls: ${pays} legitimate payments, ${settleRefused} refused (unlisted seller, other auction, paid twice, over budget, not an agent); 0 bad payments`);
console.log(`\n  fuzz passing`);
