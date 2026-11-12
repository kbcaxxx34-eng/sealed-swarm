#!/usr/bin/env node
// SealedSwarm verifier — rechecks every public claim against NEAR testnet and Sepolia public RPC.
// Needs no keys, no wallet and no account. Run:  cd verify && npm ci && npm run verify
//
// What it proves (each line becomes a PASS/FAIL row in verify/REPORT.md):
//  1. the vault code deployed on NEAR is byte-for-byte the wasm in this repo (sha256 = code_hash)
//  2. the vault accounts hold zero access keys (nobody can redeploy or drain them)
//  3. every agent key is a function-call key that can only call request_sign on its vault
//  4. the vault's on-chain policy points at the deployed auction and the NEAR MPC signer
//  5. the Sepolia auction bytecode is byte-for-byte the contract compiled from this repo
//  6. every revealed auction winner actually entered that auction (bid or submitted pool)
//  7. for every bid/pool action in the live market, the NEAR vault transaction carried the exact
//     unsigned Ethereum transaction, the NEAR MPC returned its signature, and that signature IS
//     the Sepolia transaction (same hash), sent from the agent's MPC-derived address
//  8. every hijack attempt was refused by the vault on NEAR with the policy reason
//  9. each dashboard round (winner, price, bid count, pool members) matches the chain
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak256, parseTransaction, serializeTransaction, recoverTransactionAddress, getAddress, encodeAbiParameters, decodeFunctionResult, encodeFunctionData } from "viem";
import { contracts } from "chainsig.js";

const here = (p) => new URL(p, import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : (process.env[k.toUpperCase().replace(/-/g, "_")] ?? d); };

const AUCTION = "0x4994b9537D50756c5858399bDd460Ba70BE878cc";
const VAULTS = ["vault.ssmarket-anderssonm.testnet", "ssvault-anderssonm.testnet"];
const MPC = "v1.signer-prod.testnet";
const PATH_PREFIX = "sealedswarm-agent-";
const MARKET_URL = arg("market-url", "https://sealedbid.lercomigo.space/swarm/market/market.json");
const NEAR_RPCS = (arg("near-rpc", "") || "https://archival-rpc.testnet.fastnear.com,https://rpc.testnet.near.org,https://test.rpc.fastnear.com").split(",");
const ETH_RPCS = (arg("sepolia-rpc", "") || "https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co,https://sepolia.drpc.org").split(",");
const OUT_DIR = arg("out", fileURLToDir(here("./")));

function fileURLToDir(u) { return decodeURIComponent(u.pathname); }

// ---------- small helpers ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(buf) {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = "1" + s; else break; }
  return s;
}
const short = (h) => (h && h.length > 20 ? h.slice(0, 10) + "…" + h.slice(-6) : h);

async function post(urls, method, params, label) {
  let last;
  for (const url of urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
        const res = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        clearTimeout(t);
        const j = await res.json();
        if (j.error) { last = new Error(`${label} ${url}: ${JSON.stringify(j.error).slice(0, 300)}`); if (j.error.code === -32000 || /pruned|limit|rate/i.test(JSON.stringify(j.error))) break; continue; }
        return j.result;
      } catch (e) { last = e; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
    }
  }
  throw last ?? new Error(`${label}: no RPC answered`);
}
const near = (method, params) => post(NEAR_RPCS, method, params, "NEAR " + method);
const eth = (method, params) => post(ETH_RPCS, method, params, "Sepolia " + method);
// some public nodes prune receipts: ask each node until one has it
async function ethReceipt(hash) {
  for (const url of ETH_RPCS) { try { const r = await post([url], "eth_getTransactionReceipt", [hash], "Sepolia receipt"); if (r) return r; } catch {} }
  return null;
}
const view = async (account, fn, args = {}) => {
  const r = await near("query", { request_type: "call_function", finality: "final", account_id: account, method_name: fn, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
};

const abi = JSON.parse(fs.readFileSync(here("../app/src/contract.json"), "utf8")).abi;
async function ethCall(fn, args = []) {
  const data = encodeFunctionData({ abi, functionName: fn, args });
  const out = await eth("eth_call", [{ to: AUCTION, data }, "latest"]);
  return decodeFunctionResult({ abi, functionName: fn, data: out });
}
const poolAddress = (id, poolId) => getAddress("0x" + keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], ["SealedSwarm.pool", AUCTION, BigInt(id), BigInt(poolId)])).slice(-40));

// offline: v1.signer-prod.testnet's root key is public, so derived addresses need no RPC
const mpc = new contracts.ChainSignatureContract({ networkId: "testnet", contractId: MPC });
const addrCache = new Map();
async function agentAddress(vault, index) {
  const k = vault + "#" + index;
  if (!addrCache.has(k)) {
    const pk = await mpc.getDerivedPublicKey({ path: PATH_PREFIX + index, predecessor: vault });
    addrCache.set(k, getAddress("0x" + keccak256(Buffer.from(pk.slice(2), "hex")).slice(-40)));
  }
  return addrCache.get(k);
}

// ---------- report ----------
const rows = [];
let failures = 0;
function record(section, claim, ok, evidence) {
  rows.push({ section, claim, ok: !!ok, evidence });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${section}] ${claim}${evidence ? "  — " + evidence : ""}`);
}
async function guard(section, claim, fn) {
  try { await fn(); } catch (e) { record(section, claim, false, "error: " + String(e.message || e).slice(0, 240)); }
}

// ---------- NEAR transaction decoding ----------
// old transactions are only on archival nodes; those rate-limit, so retry patiently
const NEAR_ARCHIVAL = (arg("near-archival", "") || "https://archival-rpc.testnet.fastnear.com,https://archival-rpc.testnet.near.org").split(",");
async function nearTx(hash, sender) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await post([NEAR_ARCHIVAL[attempt % NEAR_ARCHIVAL.length]], "tx", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" }, "NEAR tx"); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
  }
  throw last;
}
function requestSignArgs(tx) {
  const a = tx.transaction.actions.find((x) => x.FunctionCall)?.FunctionCall;
  if (!a) throw new Error("no function call in NEAR tx");
  return { method: a.method_name, unsigned: "0x" + Buffer.from(a.args, "base64").toString("hex"), receiver: tx.transaction.receiver_id };
}
function mpcSignature(tx) {
  const v = tx.status?.SuccessValue;
  if (!v) return null;
  const s = JSON.parse(Buffer.from(v, "base64").toString());
  if (!s?.big_r?.affine_point) return null;
  return { r: "0x" + s.big_r.affine_point.slice(2), s: "0x" + s.s.scalar, yParity: s.recovery_id };
}
const logsOf = (tx) => (tx.receipts_outcome || []).flatMap((r) => r.outcome.logs);

// Proves: NEAR vault tx → MPC signature → exactly the Sepolia tx, from the agent's derived address.
async function proveSignedAction(section, label, nearHash, sender, ethHash, vault, agentIndex) {
  await guard(section, label, async () => {
    const tx = await nearTx(nearHash, sender);
    const { method, unsigned, receiver } = requestSignArgs(tx);
    if (method !== "request_sign" || receiver !== vault) throw new Error(`NEAR tx calls ${receiver}.${method}`);
    const sig = mpcSignature(tx);
    if (!sig) throw new Error("NEAR tx returned no MPC signature: " + JSON.stringify(tx.status).slice(0, 200));
    const parsed = parseTransaction(unsigned);
    const signed = serializeTransaction(parsed, sig);
    const hash = keccak256(signed);
    const signer = await recoverTransactionAddress({ serializedTransaction: signed });
    const expected = await agentAddress(vault, agentIndex);
    const onchain = await ethReceipt(ethHash);
    const ok = hash.toLowerCase() === ethHash.toLowerCase() && signer === expected && getAddress(parsed.to) === getAddress(AUCTION) && onchain?.status === "0x1" && getAddress(onchain.from) === expected;
    record(section, label, ok, `NEAR ${short(nearHash)} → MPC sig → Sepolia ${short(hash)}${hash.toLowerCase() === ethHash.toLowerCase() ? "" : " ≠ " + short(ethHash)}, signer ${short(signer)} (derived ${PATH_PREFIX}${agentIndex} = ${short(expected)}), status ${onchain?.status}`);
  });
}

// ---------- checks ----------
async function main() {
  console.log(`SealedSwarm verifier — NEAR ${NEAR_RPCS[0]} · Sepolia ${ETH_RPCS[0]}\n`);
  const wasm = fs.readFileSync(here("../near-vault/build/swarm_vault.wasm"));
  const wasmHash = base58(crypto.createHash("sha256").update(wasm).digest());

  // 1–4: NEAR vaults
  const configs = {};
  for (const vault of VAULTS) {
    await guard("NEAR vault", `${vault}: deployed code = repo wasm`, async () => {
      const acc = await near("query", { request_type: "view_account", finality: "final", account_id: vault });
      record("NEAR vault", `${vault}: deployed code = repo wasm`, acc.code_hash === wasmHash, `code_hash ${acc.code_hash}, sha256(near-vault/build/swarm_vault.wasm) ${wasmHash}`);
    });
    await guard("NEAR vault", `${vault}: holds zero access keys`, async () => {
      const keys = await near("query", { request_type: "view_access_key_list", finality: "final", account_id: vault });
      record("NEAR vault", `${vault}: holds zero access keys`, keys.keys.length === 0, `${keys.keys.length} keys — no one can redeploy, upgrade or drain it`);
    });
    await guard("NEAR vault", `${vault}: policy targets the auction and the NEAR MPC`, async () => {
      const c = await view(vault, "get_config");
      configs[vault] = c;
      const ok = c.configured && c.auction.toLowerCase() === AUCTION.toLowerCase() && c.mpc === MPC && c.path_prefix === PATH_PREFIX && c.paused === false;
      record("NEAR vault", `${vault}: policy targets the auction and the NEAR MPC`, ok, `auction ${c.auction}, mpc ${c.mpc}, ${c.agents} agents, max gas ${parseInt(c.max_gas_hex, 16)}, max fee ${parseInt(c.max_fee_per_gas_hex, 16) / 1e9} gwei`);
    });
    for (const agent of configs[vault]?.agent_accounts ?? []) {
      await guard("NEAR vault", `${agent}: keys can only call request_sign on the vault`, async () => {
        const keys = await near("query", { request_type: "view_access_key_list", finality: "final", account_id: agent });
        const ok = keys.keys.length > 0 && keys.keys.every((k) => { const fc = k.access_key.permission?.FunctionCall; return fc && fc.receiver_id === vault && fc.method_names.length === 1 && fc.method_names[0] === "request_sign"; });
        record("NEAR vault", `${agent}: keys can only call request_sign on the vault`, ok, `${keys.keys.length} key(s), ${keys.keys.map((k) => JSON.stringify(k.access_key.permission)).join("; ").slice(0, 160)}`);
      });
    }
  }

  // 5: Sepolia bytecode
  await guard("Sepolia auction", "deployed bytecode = contract compiled from this repo", async () => {
    const artifactPath = here("../artifacts/contracts/SealedSwarmAuction.sol/SealedSwarmAuction.json");
    if (!fs.existsSync(artifactPath)) throw new Error("run `npm run compile` in the repo root first (artifacts/ is not committed)");
    const art = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const code = await eth("eth_getCode", [AUCTION, "latest"]);
    const h = (x) => crypto.createHash("sha256").update(x.toLowerCase()).digest("hex");
    record("Sepolia auction", "deployed bytecode = contract compiled from this repo", code.toLowerCase() === art.deployedBytecode.toLowerCase(), `${(code.length - 2) / 2} bytes, sha256 ${h(code).slice(0, 16)}… on chain vs ${h(art.deployedBytecode).slice(0, 16)}… compiled`);
  });

  // 6: every revealed auction
  const auctions = {};
  await guard("Sepolia auction", "every revealed winner entered the auction", async () => {
    const count = Number(await ethCall("auctionCount"));
    let revealed = 0, noSale = 0; const bad = [];
    for (let id = 1; id <= count; id++) {
      const a = await ethCall("getAuction", [BigInt(id)]);
      auctions[id] = a;
      if (!a.revealed) continue;
      revealed++;
      if (a.winner === "0x0000000000000000000000000000000000000000") { noSale++; continue; }
      let entered = await ethCall("hasBid", [BigInt(id), a.winner]);
      if (!entered) {
        const pools = Number(await ethCall("poolCount", [BigInt(id)]));
        for (let p = 1; p <= pools && !entered; p++) if (poolAddress(id, p) === getAddress(a.winner)) entered = (await ethCall("getPool", [BigInt(id), BigInt(p)]))[2];
      }
      if (!entered || a.price < a.reservePrice) bad.push(id);
    }
    record("Sepolia auction", "every revealed winner entered the auction", bad.length === 0, `${count} auctions, ${revealed} revealed (${noSale} below reserve, no sale), every winner was a bidder or a submitted pool and paid ≥ reserve${bad.length ? "; bad: " + bad.join(",") : ""}`);
  });

  // 7–9: the live market
  let market, source;
  try {
    const r = await fetch(MARKET_URL, { cache: "no-store" });
    market = await r.json(); source = MARKET_URL;
    fs.writeFileSync(here("./market.snapshot.json"), JSON.stringify(market, null, 1));
  } catch (e) {
    market = JSON.parse(fs.readFileSync(here("./market.snapshot.json"), "utf8")); source = "verify/market.snapshot.json (live dashboard unreachable: " + String(e.message).slice(0, 80) + ")";
  }
  console.log(`\nmarket data: ${source}, ${market.rounds.length} rounds, updated ${market.updated}\n`);
  const vault = market.vault;
  const agentsList = configs[vault]?.agent_accounts ?? [];
  const indexOf = (account) => agentsList.indexOf(account) + 1;
  const nameToAccount = (n) => (n.includes(".") ? n : agentsList.find((a) => a.startsWith(n + ".")));
  let signed = 0, refusals = 0;

  for (const round of market.rounds) {
    const sec = `Round · auction #${round.auction}`;
    await guard(sec, "dashboard result = on-chain result", async () => {
      const a = auctions[round.auction] ?? (await ethCall("getAuction", [BigInt(round.auction)]));
      let expectedWinner;
      if (round.pool && /^pool/.test(round.winner || "")) expectedWinner = poolAddress(round.auction, round.pool.id);
      else if (round.winner && !/no sale/i.test(round.winner)) expectedWinner = await agentAddress(vault, indexOf(nameToAccount(round.winner.split(" ")[0])));
      else expectedWinner = "0x0000000000000000000000000000000000000000";
      const ok = a.revealed && Number(a.price) === Number(round.price ?? 0) && a.bidCount === round.bidCount && getAddress(a.winner) === getAddress(expectedWinner);
      record(sec, "dashboard result = on-chain result", ok, `"${round.lot}": winner ${round.winner} → ${short(a.winner)}, price ${a.price} (dashboard ${round.price}), ${a.bidCount} sealed bids`);
    });
    if (round.pool) {
      await guard(sec, `pool #${round.pool.id} members are the named agents`, async () => {
        const members = (await ethCall("getPoolMembers", [BigInt(round.auction), BigInt(round.pool.id)])).map((x) => getAddress(x));
        const expected = await Promise.all(round.pool.members.map((n) => agentAddress(vault, indexOf(nameToAccount(n)))));
        record(sec, `pool #${round.pool.id} members are the named agents`, JSON.stringify(members) === JSON.stringify(expected), `${round.pool.members.join(" + ")} = ${members.map(short).join(", ")}`);
      });
    }
    for (const ag of round.agents) {
      if (!ag.ok || !ag.near || !ag.eth) continue;
      signed++;
      await proveSignedAction(sec, `${ag.name} "${ag.action}" was signed by the NEAR MPC through the vault`, ag.near, ag.account, ag.eth, vault, indexOf(ag.account));
    }
    for (const t of round.txs) {
      if (!t.near || !t.eth) continue;
      const who = t.what.split(" by ")[1];
      const acct = nameToAccount(who);
      signed++;
      await proveSignedAction(sec, `${t.what} was signed by the NEAR MPC through the vault`, t.near, acct, t.eth, vault, indexOf(acct));
    }
    if (round.blocked?.near) {
      refusals++;
      await guard(sec, "hijack attempt was refused by the vault on NEAR", async () => {
        const tx = await nearTx(round.blocked.near, round.blocked.agent);
        const { unsigned } = requestSignArgs(tx);
        const target = parseTransaction(unsigned).to;
        const failure = JSON.stringify(tx.status);
        const ok = !tx.status.SuccessValue && failure.includes("target is not the approved auction contract") && getAddress(target) !== getAddress(AUCTION);
        record(sec, "hijack attempt was refused by the vault on NEAR", ok, `${round.blocked.attempt} (to ${short(target)}) → NEAR ${short(round.blocked.near)}: ${failure.match(/Smart contract panicked: [^"\\]*/)?.[0] ?? failure.slice(0, 120)}`);
      });
    }
  }

  // ---------- write report ----------
  const passed = rows.filter((r) => r.ok).length;
  const report = { generated: new Date().toISOString(), auction: AUCTION, vaults: VAULTS, market: { source, updated: market.updated, rounds: market.rounds.length, signedActions: signed, hijacksRefused: refusals }, passed, failed: failures, rows };
  fs.writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  const md = [
    `# SealedSwarm verification report`,
    ``,
    `Generated ${report.generated} by \`verify/verify.mjs\` from public RPC only (no keys).`,
    ``,
    `**${passed} passed, ${failures} failed.** ${signed} agent actions traced from NEAR vault → NEAR MPC signature → Sepolia transaction; ${refusals} hijack attempts confirmed refused on NEAR.`,
    ``,
    `Market data: ${source} (updated ${market.updated}).`,
    ``,
    `| | Section | Claim | Evidence |`,
    `|---|---|---|---|`,
    ...rows.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.section} | ${r.claim.replace(/\|/g, "/")} | ${String(r.evidence || "").replace(/\|/g, "/")} |`),
    ``,
  ].join("\n");
  fs.writeFileSync(`${OUT_DIR}/REPORT.md`, md);
  console.log(`\n${passed} passed, ${failures} failed — wrote ${OUT_DIR}/REPORT.md and report.json`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
