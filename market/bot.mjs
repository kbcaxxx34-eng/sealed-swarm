// SealedSwarm live market — a long-running process that keeps a real GPU market going on testnet.
//
// Every round (default: every 3 hours):
//   1. a seller agent opens a sealed-bid auction for a GPU lot on Sepolia
//   2. four buyer agents (sub-accounts of a SwarmVault on NEAR testnet) decide what the lot is worth
//      (NEAR AI Cloud if NEARAI_API_KEY is set, otherwise scripted strategies), encrypt their bids
//      with Zama FHE, and get them signed through the vault + NEAR Chain Signatures; agents that can't
//      reach the reserve form an encrypted buyer pool
//   3. one agent is "prompt-injected" and tries to send ETH to an attacker; the vault refuses on-chain
//   4. after the end time the seller closes, the Zama KMS decrypts winner + price, the result is
//      published on-chain
// Every step's transaction hashes are appended to market.json, which the public dashboard reads.
//
// Testnet only. Keys live in the state file (STATE_FILE); nothing here holds mainnet funds.
//
//   node bot.mjs init      → create keys, print what to fund / create
//   node bot.mjs setup     → create the vault (needs the owner account to exist and hold testnet NEAR)
//   node bot.mjs round     → run one round now
//   node bot.mjs run       → run rounds forever (systemd)

import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseEther, formatEther, toHex, keccak256, stringToBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sepolia } from "viem/chains";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider, FailoverRpcProvider } from "@near-js/providers";
import { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } from "@near-js/transactions";
import { baseDecode, getTransactionLastResult } from "@near-js/utils";
import { contracts, chainAdapters, utils } from "chainsig.js";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";

const env = (k, d) => process.env[k] ?? d;
const STATE_FILE = env("STATE_FILE", path.join(process.cwd(), "state.json"));
const OUT_FILE = env("MARKET_JSON", path.join(process.cwd(), "market.json"));
const CONTRACT = env("AUCTION_CONTRACT", "");
const OWNER = env("NEAR_OWNER", ""); // e.g. market.anderssonm.testnet (created by a human, full-access key = bot key)
const SEPOLIA_RPC = env("SEPOLIA_RPC", "https://ethereum-sepolia-rpc.publicnode.com");
const ROUND_EVERY_MIN = Number(env("ROUND_EVERY_MIN", "180"));
const AUCTION_MIN = Number(env("AUCTION_MIN", "15"));
const NEARAI_KEY = env("NEARAI_API_KEY", "");
const NEARAI_MODEL = env("NEARAI_MODEL", "Qwen/Qwen3.6-35B-A3B-FP8");
const MPC = "v1.signer-prod.testnet";
const TGAS = 1000000000000n;
const NEAR = 1000000000000000000000000n;
const EXPLORER = { near: "https://testnet.nearblocks.io/txns/", eth: "https://sepolia.etherscan.io/tx/" };

const AGENTS = [
  { name: "atlas", style: "value hunter", range: [0.7, 0.9] },
  { name: "nova", style: "aggressive", range: [0.95, 1.3] },
  { name: "quill", style: "budget-capped", range: [0.85, 1.1], budget: 0.45 },
  { name: "orion", style: "truthful", range: [0.9, 1.1], budget: 0.5 },
];
const LOTS = [
  { item: "8x H100 · 1 hour", estimate: 220, reserve: 150 },
  { item: "4x A100 · 2 hours", estimate: 140, reserve: 90 },
  { item: "8x L40S · 1 hour", estimate: 110, reserve: 70 },
  { item: "8x H200 · 1 hour", estimate: 300, reserve: 220 },
  { item: "16x RTX 6000 · 1 hour", estimate: 90, reserve: 50 },
];

const abi = JSON.parse(fs.readFileSync(new URL("../app/src/contract.json", import.meta.url), "utf8")).abi;
const VAULT_WASM = fs.readFileSync(new URL("../near-vault/build/swarm_vault.wasm", import.meta.url));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const saveJson = (f, v) => { fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 2)); fs.renameSync(f + ".tmp", f); };

// ------------------------------------------------------------------ clients
const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const nearRpc = new FailoverRpcProvider([new JsonRpcProvider({ url: "https://rpc.testnet.near.org" }), new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" })]);
const evm = new chainAdapters.evm.EVM({ publicClient, contract: new contracts.ChainSignatureContract({ networkId: "testnet", contractId: MPC }) });

function state() {
  const s = loadJson(STATE_FILE, null);
  if (!s) throw new Error(`no state at ${STATE_FILE}; run "node bot.mjs init" first`);
  return s;
}
const vaultId = () => `vault.${OWNER}`;
const agentAccount = (a) => `${a.name}.${vaultId()}`;

// signs and sends a NEAR transaction with a local key
async function nearSend(signerId, keyStr, receiverId, actions) {
  const kp = KeyPair.fromString(keyStr);
  const pub = kp.getPublicKey();
  const ak = await nearRpc.query({ request_type: "view_access_key", finality: "final", account_id: signerId, public_key: pub.toString() });
  const block = await nearRpc.block({ finality: "final" });
  const tx = createTransaction(signerId, pub, receiverId, BigInt(ak.nonce) + 1n, actions, baseDecode(block.header.hash));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encodeTransaction(tx)));
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pub.keyType, data: kp.sign(hash).signature }) });
  const outcome = await nearRpc.sendTransactionUntil(signed, "FINAL");
  return { outcome, hash: outcome?.transaction?.hash, failure: nearFailure(outcome) };
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

// ------------------------------------------------------------------ commands
async function init() {
  if (fs.existsSync(STATE_FILE)) { log("state exists:", STATE_FILE); return show(); }
  const s = {
    ownerKey: KeyPair.fromRandom("ed25519").toString(),
    sellerKey: generatePrivateKey(),
    agentKeys: Object.fromEntries(AGENTS.map((a) => [a.name, KeyPair.fromRandom("ed25519").toString()])),
    created: new Date().toISOString(),
  };
  saveJson(STATE_FILE, s);
  fs.chmodSync(STATE_FILE, 0o600);
  show();
}

function show() {
  const s = state();
  console.log(`
Bot owner public key (add it as a FULL-ACCESS key when you create ${OWNER || "<owner>.testnet"}):
  ${KeyPair.fromString(s.ownerKey).getPublicKey().toString()}
Seller / operator Sepolia address (send it test ETH; it also tops up the agents):
  ${privateKeyToAccount(s.sellerKey).address}
`);
}

async function setup() {
  const s = state();
  if (!CONTRACT || !OWNER) throw new Error("set AUCTION_CONTRACT and NEAR_OWNER");
  const be = (v) => { let h = v.toString(16); if (h.length % 2) h = "0" + h; return [...Buffer.from(h, "hex")]; };
  const fee = be(50_000_000_000n), gas = be(3_000_000n);
  const cfg = [...Buffer.from(CONTRACT.slice(2), "hex"), fee.length, ...fee, gas.length, ...gas, AGENTS.length];
  for (const a of AGENTS) cfg.push(a.name.length, ...Buffer.from(a.name), ...KeyPair.fromString(s.agentKeys[a.name]).getPublicKey().data);
  const r = await nearSend(OWNER, s.ownerKey, vaultId(), [
    actionCreators.createAccount(),
    actionCreators.transfer(3n * NEAR),
    actionCreators.deployContract(new Uint8Array(VAULT_WASM)),
    actionCreators.functionCall("configure", new Uint8Array(cfg), 150n * TGAS, 0n),
  ]);
  if (r.failure) throw new Error("vault setup failed: " + r.failure);
  log("vault created", vaultId(), EXPLORER.near + r.hash);
}

async function agentAddress(a) { return (await evm.deriveAddressAndPublicKey(vaultId(), `sealedswarm-agent-${AGENTS.indexOf(a) + 1}`)).address; }

// one agent transaction through the vault: request_sign → MPC signature → broadcast → receipt
async function agentTx(s, a, data, to = CONTRACT, value = 0n) {
  const from = await agentAddress(a);
  const { transaction } = await evm.prepareTransactionForSigning({ from, to, data, value });
  const r = await nearSend(agentAccount(a), s.agentKeys[a.name], vaultId(), [actionCreators.functionCall("request_sign", Buffer.from(evm.serializeTransaction(transaction).slice(2), "hex"), 300n * TGAS, 0n)]);
  if (r.failure) return { ok: false, reason: r.failure, near: r.hash };
  const signed = evm.finalizeTransactionSigning({ transaction, rsvSignatures: [utils.cryptography.toRSV(getTransactionLastResult(r.outcome))] });
  const { hash } = await evm.broadcastTx(signed);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") return { ok: false, reason: "reverted", near: r.hash, eth: hash };
  return { ok: true, near: r.hash, eth: hash };
}

function unit(seed) { return Number(BigInt(keccak256(stringToBytes(seed)).slice(0, 14))) / 2 ** 54; }

async function valuation(a, lot, seed) {
  if (NEARAI_KEY) {
    try {
      const res = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${NEARAI_KEY}` },
        body: JSON.stringify({ model: NEARAI_MODEL, temperature: 0.4, max_tokens: 300, messages: [
          { role: "system", content: `You are ${a.name}, a ${a.style} procurement agent buying GPU compute in a sealed-bid second-price auction, where bidding your true value is optimal. Answer with JSON only: {"valuation": <integer units>, "reason": "<max 15 words>"}.` },
          { role: "user", content: `Lot: ${lot.item}. Reserve ${lot.reserve}. Market estimate ${lot.estimate}. What is it truly worth to you?` },
        ] }),
      });
      const j = await res.json();
      const m = String(j?.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
      const o = m ? JSON.parse(m[0]) : null;
      const v = Math.round(Number(o?.valuation));
      if (Number.isFinite(v) && v > 0) return { v: Math.min(v, lot.estimate * 3), reason: String(o.reason || "").slice(0, 120), brain: NEARAI_MODEL };
    } catch (e) { log("NEAR AI unavailable:", e.message); }
  }
  const f = a.range[0] + (a.range[1] - a.range[0]) * unit(seed + a.name);
  return { v: Math.max(1, Math.round(lot.estimate * f)), reason: `${a.style} strategy`, brain: "rules" };
}

async function topUp(s, wallet, addresses) {
  for (const addr of addresses) {
    const bal = await publicClient.getBalance({ address: addr });
    if (bal < parseEther("0.003")) {
      const hash = await wallet.sendTransaction({ to: addr, value: parseEther("0.006") });
      await publicClient.waitForTransactionReceipt({ hash });
      log("topped up", addr, EXPLORER.eth + hash);
    }
  }
}

async function round() {
  const s = state();
  const market = loadJson(OUT_FILE, { rounds: [], stats: { rounds: 0, bids: 0, pools: 0, blocked: 0 } });
  const seller = privateKeyToAccount(s.sellerKey);
  const wallet = createWalletClient({ account: seller, chain: sepolia, transport: http(SEPOLIA_RPC) });
  const write = (fn, args) => wallet.writeContract({ address: CONTRACT, abi, functionName: fn, args });
  const seed = `${Date.now()}`;
  const lot = LOTS[market.stats.rounds % LOTS.length];
  const rec = { started: new Date().toISOString(), lot: lot.item, reserve: lot.reserve, estimate: lot.estimate, agents: [], blocked: null, txs: [] };

  const addrs = await Promise.all(AGENTS.map(agentAddress));
  await topUp(s, wallet, addrs);

  // 1. seller opens the auction
  let hash = await write("createAuction", [lot.item, BigInt(AUCTION_MIN * 60), BigInt(lot.reserve)]);
  await publicClient.waitForTransactionReceipt({ hash });
  const id = await publicClient.readContract({ address: CONTRACT, abi, functionName: "auctionCount" });
  rec.auction = Number(id);
  rec.txs.push({ what: "auction opened", eth: hash });
  log(`auction #${id}: ${lot.item}, reserve ${lot.reserve}`);

  // 2. agents value the lot; budget-capped agents get a budget below the reserve, so they pool
  const decisions = [];
  for (const a of AGENTS) {
    const val = await valuation(a, lot, seed);
    const budget = a.budget ? Math.round(lot.reserve * a.budget * 1.6) : lot.estimate * 2;
    decisions.push({ a, ...val, amount: Math.min(val.v, budget) });
  }
  const solo = decisions.filter((d) => d.amount >= lot.reserve);
  let pool = decisions.filter((d) => d.amount < lot.reserve);
  if (pool.length === 1) pool = []; // a lone agent below the reserve sits this round out
  const fheI = await getFhe();
  const encFor = async (d) => { const i = fheI.createEncryptedInput(CONTRACT, addrs[AGENTS.indexOf(d.a)]); i.add64(BigInt(d.amount)); return i.encrypt(); };

  for (const d of solo) {
    const e = await encFor(d);
    const r = await agentTx(s, d.a, encodeFunctionData({ abi, functionName: "placeBid", args: [id, toHex(e.handles[0]), toHex(e.inputProof)] }));
    rec.agents.push({ name: d.a.name, account: agentAccount(d.a), brain: d.brain, reason: d.reason, action: "bid", ok: r.ok, near: r.near, eth: r.eth, error: r.reason });
    if (r.ok) market.stats.bids++;
  }
  if (pool.length) {
    let poolId = 0n;
    for (const d of pool) {
      const e = await encFor(d);
      const r = await agentTx(s, d.a, encodeFunctionData({ abi, functionName: "joinPool", args: [id, poolId, toHex(e.handles[0]), toHex(e.inputProof)] }));
      rec.agents.push({ name: d.a.name, account: agentAccount(d.a), brain: d.brain, reason: d.reason, action: poolId ? "joined pool" : "opened pool", ok: r.ok, near: r.near, eth: r.eth, error: r.reason });
      if (r.ok && !poolId) poolId = await publicClient.readContract({ address: CONTRACT, abi, functionName: "poolCount", args: [id] });
    }
    if (poolId) {
      const r = await agentTx(s, pool[0].a, encodeFunctionData({ abi, functionName: "submitPool", args: [id, poolId] }));
      rec.txs.push({ what: `pool #${poolId} submitted by ${pool[0].a.name}`, near: r.near, eth: r.eth, ok: r.ok });
      if (r.ok) { market.stats.pools++; market.stats.bids++; rec.pool = { id: Number(poolId), members: pool.map((d) => d.a.name) }; }
    }
  }

  // 3. a prompt-injected agent tries to pay an attacker; the vault must refuse
  const rogue = AGENTS[market.stats.rounds % AGENTS.length];
  const attempt = await agentTx(s, rogue, "0x", "0x000000000000000000000000000000000000dEaD", parseEther("0.001"));
  rec.blocked = { agent: agentAccount(rogue), attempt: "send 0.001 ETH to 0x…dEaD", refused: !attempt.ok, reason: attempt.reason, near: attempt.near };
  if (!attempt.ok) market.stats.blocked++;
  log(`rogue ${rogue.name}: ${attempt.ok ? "NOT BLOCKED" : "blocked — " + attempt.reason}`);

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
  rec.winner = /^0x0+$/.test(fin.winner) ? "no sale" : winIdx >= 0 ? agentAccount(AGENTS[winIdx]) : rec.pool ? `pool #${rec.pool.id} (${rec.pool.members.join(" + ")})` : fin.winner;
  rec.price = Number(fin.price);
  rec.bidCount = Number(fin.bidCount);
  rec.finished = new Date().toISOString();
  log(`auction #${id}: ${rec.winner} pays ${rec.price}`);

  market.stats.rounds++;
  market.updated = rec.finished;
  market.contract = CONTRACT;
  market.vault = vaultId();
  market.rounds.unshift(rec);
  market.rounds = market.rounds.slice(0, 200);
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
const cmds = { init, show: async () => show(), setup, round, run };
if (!cmds[cmd]) { console.log("usage: node bot.mjs init|show|setup|round|run"); process.exit(1); }
await cmds[cmd]();
if (cmd !== "run") process.exit(0);
