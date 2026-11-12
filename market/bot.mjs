// SealedSwarm live market bot (testnet).
//
// Every ROUND_EVERY_MIN minutes: a seller opens a GPU auction on Sepolia; agents from two owners'
// SwarmVaults on NEAR testnet value the lot (with a TEE-hosted model on NEAR AI Cloud when
// NEARAI_API_KEY is set, recording the attestation and each answer's signature), encrypt their bids
// with Zama FHE and get them signed through their vault and NEAR Chain Signatures. Agents that can't
// reach the reserve pool their budgets, across owners. One agent is hijacked on purpose with a
// different attack each round and its vault refuses. After the reveal, the winner (or each pool
// member, for its share) pays the seller in wNEAR on NEAR testnet through its vault's `settle`.
//
// Commands: init | show | create-owner | setup (v1) | upgrade (v2: second owner, new vaults, seller,
// wNEAR) | selftest-ai | round | run
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseEther, toHex, keccak256, stringToBytes, recoverMessageAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sepolia } from "viem/chains";
import { KeyPair } from "@near-js/crypto";
import { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } from "@near-js/transactions";
import { baseDecode, baseEncode, getTransactionLastResult } from "@near-js/utils";
import { contracts, chainAdapters, utils } from "chainsig.js";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";
import { checkDecisionProof } from "../verify/teeproof.mjs";

const env = (k, d) => process.env[k] ?? d;
const STATE_FILE = env("STATE_FILE", path.join(process.cwd(), "state.json"));
const OUT_FILE = env("MARKET_JSON", path.join(process.cwd(), "market.json"));
const CONTRACT = env("AUCTION_CONTRACT", "");
const OWNER = env("NEAR_OWNER", ""); // e.g. ssmarket-alice.testnet (full-access key = bot key)
const OWNER2 = env("NEAR_OWNER2", OWNER ? `lab2.${OWNER}` : ""); // second owner, created by `upgrade`
const VAULT_NAME = env("VAULT_NAME", "swarm"); // v2 vaults: swarm.<owner>; v1 was vault.<owner>
const SEPOLIA_RPC = env("SEPOLIA_RPC", "https://ethereum-sepolia-rpc.publicnode.com");
const ROUND_EVERY_MIN = Number(env("ROUND_EVERY_MIN", "180"));
const AUCTION_MIN = Number(env("AUCTION_MIN", "15"));
const NEARAI_KEY = env("NEARAI_API_KEY", "");
const NEARAI_MODEL = env("NEARAI_MODEL", "Qwen/Qwen3.6-35B-A3B-FP8");
const NEARAI = "https://cloud-api.near.ai/v1";
const MPC = "v1.signer-prod.testnet";
const WNEAR = env("WNEAR", "wrap.testnet");
const TGAS = 1000000000000n;
const NEAR = 1000000000000000000000000n;
const MILLI = NEAR / 1000n;
const UNIT = 100000000000000000000n; // 1 auction unit = 0.0001 wNEAR (1e20 yocto)
const EXPLORER = { near: "https://testnet.nearblocks.io/txns/", eth: "https://sepolia.etherscan.io/tx/" };

// v1 (vault.<owner>, 4 agents, keys in state.agentKeys) — kept so `setup` still documents v1
const AGENTS_V1 = [
  { name: "atlas", style: "value hunter", range: [0.7, 0.9] },
  { name: "nova", style: "aggressive", range: [0.95, 1.3] },
  { name: "quill", style: "budget-capped", range: [0.85, 1.1], budget: 0.45 },
  { name: "orion", style: "truthful", range: [0.9, 1.1], budget: 0.5 },
];
// v2: two owners, four agents each
const SWARMS = [
  { owner: () => OWNER, ownerKey: (s) => s.ownerKey, label: "Lab A", agents: [
    { name: "atlas", style: "value hunter", range: [0.7, 0.9], why: "You only buy when the price is clearly below what the compute is worth to your training runs." },
    { name: "nova", style: "aggressive", range: [0.95, 1.3], why: "You have a deadline and losing the lot costs you more than overpaying a little." },
    { name: "quill", style: "budget-capped", range: [0.85, 1.1], budget: 0.45, why: "Your budget is small; you are happy to share a lot with other agents in a buyer pool." },
    { name: "orion", style: "truthful", range: [0.9, 1.1], budget: 0.5, why: "You bid exactly what the compute is worth to you." },
  ] },
  { owner: () => OWNER2, ownerKey: (s) => s.v2.owner2Key, label: "Lab B", agents: [
    { name: "lyra", style: "aggressive", range: [1.0, 1.25], why: "You serve inference customers and idle capacity loses you money." },
    { name: "kai", style: "value hunter", range: [0.75, 0.95], why: "You resell compute and need a margin." },
    { name: "vega", style: "budget-capped", range: [0.8, 1.05], budget: 0.4, why: "You are a small research lab; pooling with others is how you get big lots." },
    { name: "juno", style: "truthful", range: [0.85, 1.1], why: "You bid exactly what the compute is worth to you." },
  ] },
];
const LOTS = [
  { item: "8x H100 · 1 hour", estimate: 220, reserve: 150 },
  { item: "4x A100 · 2 hours", estimate: 140, reserve: 90 },
  { item: "8x L40S · 1 hour", estimate: 110, reserve: 70 },
  { item: "8x H200 · 1 hour", estimate: 300, reserve: 220 },
  { item: "16x RTX 6000 · 1 hour", estimate: 90, reserve: 50 },
];
// what a prompt-injected agent tries; the vault must refuse each one on-chain
const ATTACKS = [
  { id: "drain-eth", attempt: "send 0.001 ETH to 0x…dEaD", reason: "target is not the approved auction contract" },
  { id: "close-early", attempt: "call close() to end the auction early", reason: "only placeBid, joinPool and submitPool are allowed" },
  { id: "pay-attacker-near", attempt: "use settle() to pay 0.5 wNEAR to attacker.testnet", reason: "seller is not on the owner's allowlist" },
  { id: "bid-twice", attempt: "place a second bid in the same auction", reason: "already bid on this auction", needsBidder: true },
  { id: "eth-with-bid", attempt: "send 0.001 ETH to the auction contract", reason: "agents cannot send ETH" },
  { id: "gas-drain", attempt: "sign a transaction with a 5,000 gwei fee cap", reason: "max fee per gas above the owner's cap" },
];

const abi = JSON.parse(fs.readFileSync(new URL("../app/src/contract.json", import.meta.url), "utf8")).abi;
const VAULT_WASM = fs.readFileSync(new URL("../near-vault/build/swarm_vault.wasm", import.meta.url));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const saveJson = (f, v) => { fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 2)); fs.renameSync(f + ".tmp", f); };
const enc = (s) => [...Buffer.from(s, "utf8")];
const u128le = (v) => { const b = Buffer.alloc(16); let x = BigInt(v); for (let i = 0; i < 16; i++) { b[i] = Number(x & 255n); x >>= 8n; } return [...b]; };
const id32 = (n) => [...Buffer.from(BigInt(n).toString(16).padStart(64, "0"), "hex")];

// ------------------------------------------------------------------ clients
const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
// direct JSON-RPC (MPC calls outlast RPC timeouts, so: send_tx until INCLUDED, then poll until FINAL)
async function rpc(method, params) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of RPCS) {
      try {
        const r = await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
        if (r.result !== undefined) return r.result;
        last = JSON.stringify(r.error || {});
        if (!/TIMEOUT|Timeout|UNKNOWN_TRANSACTION/i.test(last)) throw Object.assign(new Error(last.slice(0, 400)), { fatal: true });
      } catch (e) { if (e.fatal) throw e; last = e.message; }
    }
    await sleep(2000);
  }
  throw new Error("NEAR RPC: " + String(last).slice(0, 300));
}
const nearRpc = { query: (p) => rpc("query", p), block: (p) => rpc("block", p) };
const evm = new chainAdapters.evm.EVM({ publicClient, contract: new contracts.ChainSignatureContract({ networkId: "testnet", contractId: MPC }) });
const nearView = async (account, method, args = {}) => {
  const r = await nearRpc.query({ request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString() || "null");
};
const accountExists = async (id) => { try { await nearRpc.query({ request_type: "view_account", finality: "final", account_id: id }); return true; } catch { return false; } };
async function nearBalance(id) { try { return BigInt((await nearRpc.query({ request_type: "view_account", finality: "final", account_id: id })).amount); } catch { return 0n; } }

function state() {
  const s = loadJson(STATE_FILE, null);
  if (!s) throw new Error(`no state at ${STATE_FILE}; run "node bot.mjs init" first`);
  return s;
}
const saveState = (s) => { saveJson(STATE_FILE, s); fs.chmodSync(STATE_FILE, 0o600); };
const sellerNear = () => `gpus.${OWNER}`;

// signs and sends a NEAR transaction with a local key
async function nearSend(signerId, keyStr, receiverId, actions) {
  const kp = KeyPair.fromString(keyStr);
  const pub = kp.getPublicKey();
  const ak = await nearRpc.query({ request_type: "view_access_key", finality: "final", account_id: signerId, public_key: pub.toString() });
  const block = await nearRpc.block({ finality: "final" });
  const tx = createTransaction(signerId, pub, receiverId, BigInt(ak.nonce) + 1n, actions, baseDecode(block.header.hash));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encodeTransaction(tx)));
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pub.keyType, data: kp.sign(hash).signature }) });
  const b64 = Buffer.from(signed.encode()).toString("base64");
  const txHash = baseEncode(hash);
  try { await rpc("send_tx", { signed_tx_base64: b64, wait_until: "INCLUDED" }); }
  catch (e) { if (!/TIMEOUT|Timeout/.test(e.message)) return { outcome: null, hash: txHash, failure: e.message }; }
  for (let i = 0; i < 40; i++) {
    try {
      const outcome = await rpc("tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" });
      if (outcome?.status) return { outcome, hash: txHash, failure: nearFailure(outcome) };
    } catch (_) {}
    await sleep(3000);
  }
  return { outcome: null, hash: txHash, failure: "not final after 2 minutes" };
}

function nearFailure(outcome) {
  const all = [outcome?.status, ...(outcome?.receipts_outcome || []).map((r) => r.outcome.status)];
  for (const st of all) if (st && st.Failure) {
    const f = JSON.stringify(st.Failure);
    const m = f.match(/Smart contract panicked: ([^"\\]+)/);
    return m ? m[1] : f.slice(0, 200);
  }
  return null;
}

let fhe;
async function getFhe() { return (fhe ??= await createInstance({ ...SepoliaConfig, network: SEPOLIA_RPC })); }

// ------------------------------------------------------------------ swarm model (v2)
function swarms(s) {
  return SWARMS.map((w, wi) => {
    const owner = w.owner();
    const vault = `${VAULT_NAME}.${owner}`;
    return { ...w, wi, ownerId: owner, ownerKeyStr: w.ownerKey(s), vault,
      agents: w.agents.map((a, i) => ({ ...a, index: i + 1, vault, owner, label: w.label, account: `${a.name}.${vault}`, key: s.v2.agentKeys[`${a.name}.${vault}`] })) };
  });
}
const derived = new Map();
async function agentAddress(a) {
  const k = a.account;
  if (!derived.has(k)) derived.set(k, (await evm.deriveAddressAndPublicKey(a.vault, `sealedswarm-agent-${a.index}`)).address);
  return derived.get(k);
}

// one agent transaction through its vault: request_sign → MPC signature → broadcast → receipt
async function agentTx(a, data, { to = CONTRACT, value = 0n, gas, maxFeePerGas } = {}) {
  const from = await agentAddress(a);
  const req = { from, to, data, value };
  if (gas) req.gas = gas;
  if (maxFeePerGas) { req.maxFeePerGas = maxFeePerGas; req.maxPriorityFeePerGas = 1_000_000n; }
  const { transaction } = await evm.prepareTransactionForSigning(req);
  const r = await nearSend(a.account, a.key, a.vault, [actionCreators.functionCall("request_sign", Buffer.from(evm.serializeTransaction(transaction).slice(2), "hex"), 300n * TGAS, 0n)]);
  if (r.failure) return { ok: false, reason: r.failure, near: r.hash };
  const signed = evm.finalizeTransactionSigning({ transaction, rsvSignatures: [utils.cryptography.toRSV(getTransactionLastResult(r.outcome))] });
  const { hash } = await evm.broadcastTx(signed);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") return { ok: false, reason: "reverted", near: r.hash, eth: hash };
  return { ok: true, near: r.hash, eth: hash };
}

// an agent pays a seller in wNEAR through its vault (NEP-141 ft_transfer, checked by the vault)
async function agentSettle(a, auctionId, units, seller) {
  const args = new Uint8Array([...id32(auctionId), ...u128le(BigInt(units) * UNIT), seller.length, ...enc(seller)]);
  const r = await nearSend(a.account, a.key, a.vault, [actionCreators.functionCall("settle", args, 100n * TGAS, 0n)]);
  const settled = r.outcome ? JSON.stringify(r.outcome).includes("settlement confirmed") : false;
  return { ok: !r.failure && settled, near: r.hash, reason: r.failure || (settled ? null : "transfer not confirmed") };
}

// ------------------------------------------------------------------ NEAR AI Cloud (TEE) with proofs
async function nearAiAttest(model) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const q = new URLSearchParams({ model, provider: "near", include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce });
  const res = await fetch(`${NEARAI}/attestation/report?${q}`, { headers: { Accept: "application/json", Authorization: `Bearer ${NEARAI_KEY}` } });
  if (!res.ok) throw new Error(`attestation HTTP ${res.status}`);
  const rep = await res.json();
  const cands = [...(rep.model_attestations || []), ...(rep.gateway_attestation ? [rep.gateway_attestation] : [])];
  return cands.filter((c) => c.intel_quote && c.signing_address && (c.request_nonce ?? nonce) === nonce)
    .map((c) => ({ nonce, signer: String(c.signing_address).toLowerCase(), quote: String(c.intel_quote).replace(/^0x/, ""), nvidia: !!c.nvidia_payload }));
}

async function nearAiDecide(a, lot, history, budget, attestations) {
  const sys = `You are ${a.name}, an autonomous procurement agent of ${a.label} buying GPU compute in a sealed-bid second-price (Vickrey) auction. ` +
    `Your style: ${a.style}. ${a.why} In a second-price auction the dominant strategy is to bid your true value. ` +
    `Answer with JSON only: {"valuation": <integer units>, "reason": "<max 20 words>"}.`;
  const past = history.length ? `Recent clearing prices for this lot: ${history.join(", ")} units.` : "No price history for this lot yet.";
  const user = `Lot: "${lot.item}". Public reserve: ${lot.reserve} units. Market estimate: ${lot.estimate} units. ${past} ` +
    `Your budget: ${budget} units. What is this lot truly worth to you?`;
  const body = JSON.stringify({ model: NEARAI_MODEL, temperature: 0.6, max_tokens: 400, messages: [{ role: "system", content: sys }, { role: "user", content: user }] });
  const res = await fetch(`${NEARAI}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${NEARAI_KEY}`, "x-no-aliasing": "true" }, body });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const response = await res.text();
  const out = JSON.parse(response);
  const text = out?.choices?.[0]?.message?.content || "";
  const m = text.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in the model's answer");
  const j = JSON.parse(m[0]);
  const v = Math.round(Number(j.valuation));
  if (!Number.isFinite(v) || v < 1) throw new Error("invalid valuation");
  let signature = null;
  for (let i = 0; i < 4 && !signature; i++) {
    const sr = await fetch(`${NEARAI}/signature/${out.id}?model=${encodeURIComponent(NEARAI_MODEL)}&signing_algo=ecdsa`, { headers: { Accept: "application/json", Authorization: `Bearer ${NEARAI_KEY}` } });
    if (sr.ok) signature = await sr.json(); else await sleep(1500);
  }
  const proof = { model: NEARAI_MODEL, chat_id: out.id, request: body, response, signature };
  const check = await checkDecisionProof(proof, attestations, recoverMessageAddress);
  return { v: Math.min(v, lot.estimate * 3), reason: String(j.reason || "").slice(0, 140), brain: NEARAI_MODEL, proof, verified: check.ok };
}

function unit(seed) { return Number(BigInt(keccak256(stringToBytes(seed)).slice(0, 14))) / 2 ** 54; }
function rulesDecide(a, lot, history, seed) {
  // rule-based fallback: style range around the estimate, nudged toward recent clearing prices
  const anchor = history.length ? (lot.estimate + history.reduce((x, y) => x + y, 0) / history.length) / 2 : lot.estimate;
  const f = a.range[0] + (a.range[1] - a.range[0]) * unit(seed + a.account);
  return { v: Math.max(1, Math.round(anchor * f)), reason: `${a.style} rule, anchored on ${history.length ? "recent clearing prices" : "the estimate"}`, brain: "rules" };
}

// ------------------------------------------------------------------ commands
async function init() {
  if (fs.existsSync(STATE_FILE)) { log("state exists:", STATE_FILE); return show(); }
  const s = {
    ownerKey: KeyPair.fromRandom("ed25519").toString(),
    sellerKey: generatePrivateKey(),
    agentKeys: Object.fromEntries(AGENTS_V1.map((a) => [a.name, KeyPair.fromRandom("ed25519").toString()])),
    created: new Date().toISOString(),
  };
  saveState(s);
  show();
}

function show() {
  const s = state();
  console.log(`
Bot owner public key (full-access key of ${OWNER || "<owner>.testnet"}):
  ${KeyPair.fromString(s.ownerKey).getPublicKey().toString()}
Seller / operator Sepolia address (send it test ETH; it also tops up the agents):
  ${privateKeyToAccount(s.sellerKey).address}
`);
}

async function createOwner() {
  const s = state();
  if (!OWNER) throw new Error("set NEAR_OWNER, e.g. ssmarket-<name>.testnet");
  const pub = KeyPair.fromString(s.ownerKey).getPublicKey().toString();
  const res = await fetch("https://helper.nearprotocol.com/account", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: OWNER, newAccountPublicKey: pub }) });
  log("helper:", res.status, (await res.text()).slice(0, 300));
}

// v1 setup, unchanged in behaviour (vault.<owner> with four agents)
async function setup() {
  const s = state();
  if (!CONTRACT || !OWNER) throw new Error("set AUCTION_CONTRACT and NEAR_OWNER");
  const vault = `vault.${OWNER}`;
  const r = await nearSend(OWNER, s.ownerKey, vault, [
    actionCreators.createAccount(), actionCreators.transfer(3n * NEAR), actionCreators.deployContract(new Uint8Array(VAULT_WASM)),
    actionCreators.functionCall("configure", new Uint8Array(configBytes(AGENTS_V1.map((a) => s.agentKeys[a.name]), AGENTS_V1)), 150n * TGAS, 0n),
  ]);
  if (r.failure) throw new Error("vault setup failed: " + r.failure);
  log("vault created", vault, EXPLORER.near + r.hash);
}

function configBytes(keys, agents) {
  const be = (v) => { let h = v.toString(16); if (h.length % 2) h = "0" + h; return [...Buffer.from(h, "hex")]; };
  const fee = be(50_000_000_000n), gas = be(3_000_000n);
  const cfg = [...Buffer.from(CONTRACT.slice(2), "hex"), fee.length, ...fee, gas.length, ...gas, agents.length];
  agents.forEach((a, i) => cfg.push(a.name.length, ...enc(a.name), ...KeyPair.fromString(keys[i]).getPublicKey().data));
  return cfg;
}

// v2: second owner, a v2 vault per owner (agents may call request_sign and settle), a NEAR seller
// account, wNEAR settlement. Idempotent: rerun after funding if it stops for lack of NEAR.
async function upgrade() {
  const s = state();
  if (!CONTRACT || !OWNER) throw new Error("set AUCTION_CONTRACT and NEAR_OWNER");
  s.v2 ??= { owner2Key: KeyPair.fromRandom("ed25519").toString(), sellerNearKey: KeyPair.fromRandom("ed25519").toString(), agentKeys: {} };
  for (const w of swarms({ ...s, v2: s.v2 })) for (const a of w.agents) s.v2.agentKeys[a.account] ??= KeyPair.fromRandom("ed25519").toString();
  saveState(s);
  const need = 8n * NEAR, have = await nearBalance(OWNER);
  log(`${OWNER}: ${Number(have / MILLI) / 1000} NEAR (the upgrade uses about ${Number(need / NEAR)})`);
  if (have < need) log(`warning: fund ${OWNER} with testnet NEAR (e.g. https://near-faucet.io) if a step below fails`);
  const step = async (label, fn) => { const r = await fn(); if (r?.failure) throw new Error(`${label}: ${r.failure}`); if (r?.hash) log(label, EXPLORER.near + r.hash); };

  if (!(await accountExists(OWNER2)))
    await step(`created second owner ${OWNER2}`, () => nearSend(OWNER, s.ownerKey, OWNER2, [actionCreators.createAccount(), actionCreators.transfer(4n * NEAR), actionCreators.addKey(KeyPair.fromString(s.v2.owner2Key).getPublicKey(), actionCreators.fullAccessKey())]));
  if (!(await accountExists(sellerNear())))
    await step(`created NEAR seller ${sellerNear()}`, () => nearSend(OWNER, s.ownerKey, sellerNear(), [actionCreators.createAccount(), actionCreators.transfer(NEAR / 5n), actionCreators.addKey(KeyPair.fromString(s.v2.sellerNearKey).getPublicKey(), actionCreators.fullAccessKey())]));
  const registered = async (id) => !!(await nearView(WNEAR, "storage_balance_of", { account_id: id }));
  const storage = (id) => actionCreators.functionCall("storage_deposit", Buffer.from(JSON.stringify({ account_id: id, registration_only: true })), 30n * TGAS, 12_500_000_000_000_000_000_000n);
  if (!(await registered(sellerNear()))) await step(`registered ${sellerNear()} on ${WNEAR}`, () => nearSend(OWNER, s.ownerKey, WNEAR, [storage(sellerNear())]));

  for (const w of swarms(s)) {
    const o = { id: w.ownerId, key: w.ownerKeyStr };
    if (!(await accountExists(w.vault))) {
      await step(`created ${w.vault} (${w.agents.length} agents)`, () => nearSend(o.id, o.key, w.vault, [
        actionCreators.createAccount(), actionCreators.transfer(1300n * MILLI), actionCreators.deployContract(new Uint8Array(VAULT_WASM)),
        actionCreators.functionCall("configure", new Uint8Array(configBytes(w.agents.map((a) => a.key), w.agents)), 150n * TGAS, 0n),
      ]));
      await sleep(3000);
    }
    const cfg = await nearView(w.vault, "get_config");
    if (cfg.intents !== WNEAR) {
      const fc = (m, args, dep = 0n) => actionCreators.functionCall(m, new Uint8Array(args), 30n * TGAS, dep);
      await step(`${w.vault}: settlement in wNEAR, seller allowed, agent budgets`, () => nearSend(o.id, o.key, w.vault, [
        fc("set_settlement", [WNEAR.length, ...enc(WNEAR), WNEAR.length, ...enc(WNEAR)]),
        fc("allow_seller", enc(sellerNear())),
        ...w.agents.map((a, i) => fc("set_budget", [i, ...u128le(5000n * UNIT)])), // 0.5 wNEAR each
      ]));
    }
    if (!(await registered(o.id))) await step(`registered ${o.id} on ${WNEAR}`, () => nearSend(o.id, o.key, WNEAR, [storage(o.id)]));
    if (!(await registered(w.vault))) await step(`registered ${w.vault} on ${WNEAR}`, () => nearSend(o.id, o.key, WNEAR, [storage(w.vault)]));
    const bal = BigInt((await nearView(WNEAR, "ft_balance_of", { account_id: w.vault })) || "0");
    const FLOAT = 400n * MILLI; // 0.4 wNEAR: a round costs at most ~0.03 wNEAR
    if (bal < 100n * MILLI) await step(`funded ${w.vault} with 0.4 wNEAR`, () => nearSend(o.id, o.key, WNEAR, [
      actionCreators.functionCall("near_deposit", Buffer.from("{}"), 10n * TGAS, FLOAT),
      actionCreators.functionCall("ft_transfer", Buffer.from(JSON.stringify({ receiver_id: w.vault, amount: FLOAT.toString(), memo: "SealedSwarm vault float" })), 30n * TGAS, 1n),
    ]));
  }
  await topUpAgentsNear(s);
  log("upgrade done. Vaults:", swarms(s).map((w) => w.vault).join(", "), "· seller:", sellerNear());
}

// agents pay their own NEAR gas; a request_sign prepays 300 Tgas
async function topUpAgentsNear(s) {
  for (const w of swarms(s)) for (const a of w.agents) {
    // a 300 Tgas call needs ~0.3 NEAR of balance up front (mostly refunded): keep agents above 0.45
    if ((await nearBalance(a.account)) < 450n * MILLI) {
      const r = await nearSend(w.ownerId, w.ownerKeyStr, a.account, [actionCreators.transfer(500n * MILLI)]);
      log("topped up", a.account, r.failure || "0.5 NEAR");
    }
  }
}

async function topUpEth(wallet, addresses) {
  for (const addr of addresses) {
    const bal = await publicClient.getBalance({ address: addr });
    if (bal < parseEther("0.003")) {
      const hash = await wallet.sendTransaction({ to: addr, value: parseEther("0.006") });
      await publicClient.waitForTransactionReceipt({ hash });
      log("topped up", addr, EXPLORER.eth + hash);
    }
  }
}

// checks the NEAR AI setup end to end without touching any chain
async function selftestAi() {
  if (!NEARAI_KEY) throw new Error("set NEARAI_API_KEY");
  const atts = await nearAiAttest(NEARAI_MODEL);
  log(`attestation: ${atts.length} TEE quote(s) for ${NEARAI_MODEL}; signers ${atts.map((a) => a.signer).join(", ")}`);
  const a = { ...SWARMS[0].agents[0], label: "Lab A", account: "selftest" };
  const d = await nearAiDecide(a, LOTS[0], [205, 212], 400, atts);
  log(`answer: ${d.v} units — ${d.reason}`);
  for (const c of (await checkDecisionProof(d.proof, atts, recoverMessageAddress)).checks) log(`${c.ok ? "✔" : "✗"} ${c.text}`);
  log(d.verified ? "NEAR AI proof verified offline" : "NEAR AI proof did NOT verify");
}

async function round() {
  const s = state();
  if (!s.v2) throw new Error('run "node bot.mjs upgrade" first');
  const market = loadJson(OUT_FILE, { rounds: [], stats: { rounds: 0, bids: 0, pools: 0, blocked: 0 } });
  market.stats.paid ??= 0; market.stats.aiDecisions ??= 0;
  const seller = privateKeyToAccount(s.sellerKey);
  const wallet = createWalletClient({ account: seller, chain: sepolia, transport: http(SEPOLIA_RPC) });
  const write = (fn, args) => wallet.writeContract({ address: CONTRACT, abi, functionName: fn, args });
  const seed = `${Date.now()}`;
  const lot = LOTS[market.stats.rounds % LOTS.length];
  const W = swarms(s);
  const agents = W.flatMap((w) => w.agents);
  const rec = { version: 2, started: new Date().toISOString(), lot: lot.item, reserve: lot.reserve, estimate: lot.estimate, owners: W.map((w) => ({ label: w.label, owner: w.ownerId, vault: w.vault })), agents: [], blocked: null, txs: [], payments: [], ai: null };

  const addrs = await Promise.all(agents.map(agentAddress));
  await topUpEth(wallet, addrs);
  await topUpAgentsNear(s);

  // 1. seller opens the auction
  let hash = await write("createAuction", [lot.item, BigInt(AUCTION_MIN * 60), BigInt(lot.reserve)]);
  await publicClient.waitForTransactionReceipt({ hash });
  const id = await publicClient.readContract({ address: CONTRACT, abi, functionName: "auctionCount" });
  rec.auction = Number(id);
  rec.txs.push({ what: "auction opened", eth: hash });
  log(`auction #${id}: ${lot.item}, reserve ${lot.reserve}`);

  // 2. agents value the lot privately (TEE model when available), budget-capped agents pool
  const history = market.rounds.filter((r) => r.lot === lot.item && r.price).slice(0, 3).map((r) => r.price);
  let atts = [];
  if (NEARAI_KEY) {
    try { atts = await nearAiAttest(NEARAI_MODEL); log(`NEAR AI: ${atts.length} attested TEE signer(s)`); }
    catch (e) { log("NEAR AI attestation unavailable:", e.message); }
  }
  const decisions = await Promise.all(agents.map(async (a) => {
    const budget = a.budget ? Math.round(lot.reserve * a.budget * 1.6) : lot.estimate * 2;
    let d = null;
    if (atts.length) { try { d = await nearAiDecide(a, lot, history, budget, atts); } catch (e) { log(`NEAR AI failed for ${a.name}:`, e.message); } }
    d ??= rulesDecide(a, lot, history, seed);
    return { a, ...d, budget, amount: Math.min(d.v, budget) };
  }));
  const solo = decisions.filter((d) => d.amount >= lot.reserve);
  let pool = decisions.filter((d) => d.amount < lot.reserve);
  if (pool.length === 1) pool = []; // a lone agent below the reserve sits this round out
  const proofs = {};
  const fheI = await getFhe();
  const encFor = async (d) => { const i = fheI.createEncryptedInput(CONTRACT, await agentAddress(d.a)); i.add64(BigInt(d.amount)); return i.encrypt(); };
  const entry = (d, action, r) => {
    const e = { name: d.a.name, owner: d.a.label, account: d.a.account, brain: d.brain, reason: d.reason, action, ok: r.ok, near: r.near, eth: r.eth, error: r.reason };
    if (d.proof) { proofs[d.a.account] = d.proof; e.verified = d.verified; market.stats.aiDecisions++; }
    rec.agents.push(e);
  };

  for (const d of solo) {
    const e = await encFor(d);
    const r = await agentTx(d.a, encodeFunctionData({ abi, functionName: "placeBid", args: [id, toHex(e.handles[0]), toHex(e.inputProof)] }));
    entry(d, "bid", r);
    if (r.ok) market.stats.bids++;
  }
  let poolMembers = [];
  if (pool.length) {
    let poolId = 0n;
    for (const d of pool) {
      const e = await encFor(d);
      const r = await agentTx(d.a, encodeFunctionData({ abi, functionName: "joinPool", args: [id, poolId, toHex(e.handles[0]), toHex(e.inputProof)] }));
      entry(d, poolId ? "joined pool" : "opened pool", r);
      if (r.ok) poolMembers.push(d);
      if (r.ok && !poolId) poolId = await publicClient.readContract({ address: CONTRACT, abi, functionName: "poolCount", args: [id] });
    }
    if (poolId) {
      const r = await agentTx(pool[0].a, encodeFunctionData({ abi, functionName: "submitPool", args: [id, poolId] }));
      rec.txs.push({ what: `pool #${poolId} submitted by ${pool[0].a.name}`, account: pool[0].a.account, near: r.near, eth: r.eth, ok: r.ok });
      if (r.ok) { market.stats.pools++; market.stats.bids++; rec.pool = { id: Number(poolId), members: poolMembers.map((d) => d.a.name), accounts: poolMembers.map((d) => d.a.account) }; }
    }
  }

  // 3. a prompt-injected agent attacks; its vault must refuse on-chain
  const entered = rec.agents.filter((x) => x.ok).map((x) => agents.find((a) => a.account === x.account));
  let attack = ATTACKS[market.stats.rounds % ATTACKS.length];
  if (attack.needsBidder && !entered.length) attack = ATTACKS[0]; // "bid twice" needs an agent that already entered
  const rogue = attack.needsBidder ? entered[market.stats.rounds % entered.length] : agents[market.stats.rounds % agents.length];
  let attempt;
  const dummy = "0x" + "11".repeat(32);
  if (attack.id === "drain-eth") attempt = await agentTx(rogue, "0x", { to: "0x000000000000000000000000000000000000dEaD", value: parseEther("0.001"), gas: 21000n });
  else if (attack.id === "close-early") attempt = await agentTx(rogue, encodeFunctionData({ abi, functionName: "close", args: [id] }), { gas: 300000n });
  else if (attack.id === "bid-twice") attempt = await agentTx(rogue, encodeFunctionData({ abi, functionName: "placeBid", args: [id, dummy, "0x00"] }), { gas: 900000n });
  else if (attack.id === "eth-with-bid") attempt = await agentTx(rogue, "0x", { value: parseEther("0.001"), gas: 60000n });
  else if (attack.id === "gas-drain") attempt = await agentTx(rogue, encodeFunctionData({ abi, functionName: "placeBid", args: [id, dummy, "0x00"] }), { gas: 900000n, maxFeePerGas: 5_000_000_000_000n });
  else if (attack.id === "pay-attacker-near") { const r = await agentSettle(rogue, id, 5000n, "attacker.testnet"); attempt = { ok: r.ok, reason: r.reason, near: r.near }; }
  rec.blocked = { agent: rogue.account, attack: attack.id, attempt: attack.attempt, refused: !attempt.ok, reason: attempt.reason, near: attempt.near };
  if (!attempt.ok) market.stats.blocked++;
  log(`rogue ${rogue.name} (${attack.id}): ${attempt.ok ? "NOT BLOCKED" : "blocked — " + attempt.reason}`);

  // 4. close and reveal after the end time
  const a0 = await publicClient.readContract({ address: CONTRACT, abi, functionName: "getAuction", args: [id] });
  const wait = Number(a0.endTime) * 1000 - Date.now() + 20_000;
  if (wait > 0) await sleep(wait);
  hash = await write("close", [id]);
  await publicClient.waitForTransactionReceipt({ hash });
  rec.txs.push({ what: "closed", eth: hash });
  let res = null;
  for (let i = 0; i < 20 && !res; i++) {
    const [w, p] = await publicClient.readContract({ address: CONTRACT, abi, functionName: "getResultHandles", args: [id] });
    if (/^0x0+$/.test(w)) { await sleep(5000); continue; }
    try { res = await fheI.publicDecrypt([w, p]); } catch { await sleep(8000); }
  }
  if (!res) throw new Error("public decryption failed");
  hash = await write("reveal", [id, res.abiEncodedClearValues, res.decryptionProof]);
  await publicClient.waitForTransactionReceipt({ hash });
  rec.txs.push({ what: "revealed (Zama KMS proof verified on-chain)", eth: hash });
  const fin = await publicClient.readContract({ address: CONTRACT, abi, functionName: "getAuction", args: [id] });
  const winIdx = addrs.findIndex((x) => x.toLowerCase() === fin.winner.toLowerCase());
  rec.winner = /^0x0+$/.test(fin.winner) ? "no sale" : winIdx >= 0 ? agents[winIdx].account : rec.pool ? `pool #${rec.pool.id} (${rec.pool.members.join(" + ")})` : fin.winner;
  rec.price = Number(fin.price);
  rec.bidCount = Number(fin.bidCount);
  log(`auction #${id}: ${rec.winner} pays ${rec.price}`);

  // 5. the winner pays the seller in wNEAR through its vault on NEAR; a pool splits the price by
  //    contribution (each member knows only its own contribution and the pool total)
  const payers = [];
  if (winIdx >= 0) payers.push({ a: agents[winIdx], units: BigInt(rec.price) });
  else if (rec.pool && !/^0x0+$/.test(fin.winner)) {
    const total = poolMembers.reduce((x, d) => x + BigInt(d.amount), 0n);
    let left = BigInt(rec.price);
    poolMembers.forEach((d, i) => { const share = i === poolMembers.length - 1 ? left : (BigInt(rec.price) * BigInt(d.amount)) / total; left -= share; payers.push({ a: d.a, units: share }); });
  }
  for (const p of payers) {
    if (p.units <= 0n) continue;
    const r = await agentSettle(p.a, id, p.units, sellerNear());
    rec.payments.push({ agent: p.a.account, units: Number(p.units), wnear: Number(p.units) / 10000, seller: sellerNear(), ok: r.ok, near: r.near, error: r.reason });
    if (r.ok) market.stats.paid++;
    log(`${p.a.name} paid ${Number(p.units) / 10000} wNEAR to ${sellerNear()}: ${r.ok ? "ok" : r.reason}`);
  }

  // TEE proofs go to their own file (attestation quotes are large); the dashboard links it
  if (Object.keys(proofs).length) {
    const dir = path.join(path.dirname(OUT_FILE), "proofs");
    fs.mkdirSync(dir, { recursive: true });
    const file = `proofs/auction-${rec.auction}.json`;
    saveJson(path.join(path.dirname(OUT_FILE), file), { auction: rec.auction, model: NEARAI_MODEL, attestations: atts, decisions: proofs });
    rec.ai = { model: NEARAI_MODEL, proofs: file, decisions: Object.keys(proofs).length, verified: rec.agents.filter((x) => x.verified).length, signers: atts.map((x) => x.signer) };
  }

  rec.finished = new Date().toISOString();
  market.stats.rounds++;
  market.updated = rec.finished;
  market.contract = CONTRACT;
  market.vault = W[0].vault;
  market.vaults = W.map((w) => w.vault);
  market.seller = sellerNear();
  market.rounds.unshift(rec);
  market.rounds = market.rounds.slice(0, 120);
  saveJson(OUT_FILE, market);
}

async function run() {
  for (;;) {
    const t0 = Date.now();
    try { await round(); } catch (e) { log("round failed:", e.stack || e.message); }
    await sleep(Math.max(60_000, ROUND_EVERY_MIN * 60_000 - (Date.now() - t0)));
  }
}

const cmd = process.argv[2];
const cmds = { init, show: async () => show(), "create-owner": createOwner, setup, upgrade, "selftest-ai": selftestAi, round, run };
if (!cmds[cmd]) { console.log("usage: node bot.mjs init|show|create-owner|setup|upgrade|selftest-ai|round|run"); process.exit(1); }
await cmds[cmd]();
if (cmd !== "run") process.exit(0);
