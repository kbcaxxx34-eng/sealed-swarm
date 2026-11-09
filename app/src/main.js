// SealedSwarm — a NEAR vault runs a swarm of bidding agents on Ethereum; every bid is encrypted with Zama FHE.
import "@fontsource-variable/schibsted-grotesk";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } from "@near-js/transactions";
import { baseDecode, getTransactionLastResult } from "@near-js/utils";
import { KeyPair, PublicKey } from "@near-js/crypto";
import { JsonRpcProvider, FailoverRpcProvider } from "@near-js/providers";
import vaultWasmUrl from "./swarm_vault.wasm?url";
import { contracts, chainAdapters, utils } from "chainsig.js";
import {
  createPublicClient, http, encodeFunctionData, recoverMessageAddress, formatEther, parseEther, toHex, keccak256, stringToBytes,
} from "viem";
import { sepolia } from "viem/chains";
import { initSDK, createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/web";
import { BrowserProvider, Contract, ContractFactory } from "ethers";
import artifact from "./contract.json";

// ------------------------------------------------------------------ config
const DEFAULT_CONTRACT = ""; // v2 (buyer pools): set after the Sepolia deployment
// NEAR network: testnet by default; mainnet adds settlement through NEAR Intents (mainnet only).
// Bids always go to Sepolia (Zama FHE); only the NEAR side changes.
const NET = (() => { try { return localStorage.getItem("ssNet") === "mainnet" ? "mainnet" : "testnet"; } catch (_) { return "testnet"; } })();
const NETS = {
  testnet: { mpc: "v1.signer-prod.testnet", rpcs: ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"], suffix: ".testnet", explorer: "https://testnet.nearblocks.io" },
  mainnet: { mpc: "v1.signer", rpcs: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"], suffix: ".near", explorer: "https://nearblocks.io" },
};
const MPC_CONTRACT = NETS[NET].mpc;
// Account registrar: creates top-level accounts with a given key (testnet: "testnet", mainnet: "near").
// Used so the vault can be deployed without asking the wallet to deploy code or add a full-access key.
const REGISTRAR = NET === "mainnet" ? "near" : "testnet";
// ssvault-alice.testnet for alice.testnet (dots in the owner name become dashes)
function vaultIdFor(owner) {
  const suffix = NETS[NET].suffix;
  const base = owner.endsWith(suffix) ? owner.slice(0, -suffix.length) : owner;
  return `ssvault-${base.replace(/\./g, "-")}${suffix}`.toLowerCase();
}
// settlement through NEAR Intents (mainnet): the vault pays sellers in wNEAR from its Intents balance
const INTENTS = "intents.near";
const SETTLE_TOKEN = "wrap.near";
const UNIT_YOCTO = 100000000000000000000n; // 1 auction unit = 0.0001 wNEAR
const AGENT_BUDGET_UNITS = 300n; // spending limit per agent (0.03 wNEAR)
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const AGENT_CALL_GAS = 300000000000000n; // 300 Tgas for request_sign (the vault forwards 250 Tgas to the MPC)
const TGAS = 1000000000000n;
const NEAR = 1000000000000000000000000n; // 1 NEAR in yocto
const FUND_AMOUNT = "0.004"; // ETH per agent
const VAULT_DEPOSIT = 3n * NEAR; // vault storage + 0.25 NEAR for each agent sub-account (it pays its own gas)
const POLICY_MAX_FEE = 50_000_000_000n; // 50 gwei
const POLICY_MAX_GAS = 3_000_000n;

const AGENTS = [
  { name: "Atlas", path: "sealedswarm-agent-1", style: "Value hunter", range: [0.7, 0.9], budget: 1000,
    why: "Only buys at a discount to the market estimate." },
  { name: "Nova", path: "sealedswarm-agent-2", style: "Aggressive", range: [0.95, 1.3], budget: 1000,
    why: "Values scarce resources above the market estimate." },
  { name: "Quill", path: "sealedswarm-agent-3", style: "Budget-capped", range: [0.85, 1.1], budget: 110,
    why: "Bids its true value, never above its budget." },
];

// ------------------------------------------------------------------ ui helpers
const $ = (id) => document.getElementById(id);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const errMsg = (e) => e?.shortMessage || e?.reason || e?.message || String(e);
function log(msg, kind = "") {
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $("log").appendChild(line);
  $("log").scrollTop = $("log").scrollHeight;
}
function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "Working…"; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; }
}

// ------------------------------------------------------------------ clients & state
const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const mpc = new contracts.ChainSignatureContract({ networkId: NET, contractId: MPC_CONTRACT });
const evm = new chainAdapters.evm.EVM({ publicClient, contract: mpc });
const abi = artifact.abi;
const nearRpc = new FailoverRpcProvider(NETS[NET].rpcs.map((url) => new JsonRpcProvider({ url })));

const state = {
  selector: null, wallet: null, accountId: null,
  agents: AGENTS.map((a) => ({ ...a, address: null, balance: null, valuation: null, bid: null })),
  contract: localStorage.getItem("ssContractV2") || DEFAULT_CONTRACT,
  auctions: [], selected: null, fhe: null,
  vaultId: null, vault: null, agentKeys: [], pools: {}, poolNames: {},
};

async function getFhe() {
  if (state.fhe) return state.fhe;
  log("Loading Zama FHE SDK (WASM)…");
  await initSDK();
  state.fhe = await createInstance({ ...SepoliaConfig, network: SEPOLIA_RPC });
  log("FHE SDK ready.", "ok");
  return state.fhe;
}

async function metamaskSigner() {
  if (!window.ethereum) throw new Error("MetaMask not found in this browser.");
  const prov = new BrowserProvider(window.ethereum);
  await prov.send("eth_requestAccounts", []);
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] }); } catch (_) {}
  const p2 = new BrowserProvider(window.ethereum);
  if (Number((await p2.getNetwork()).chainId) !== 11155111) throw new Error("Switch MetaMask to Sepolia.");
  return p2.getSigner();
}

const read = (functionName, args = []) =>
  publicClient.readContract({ address: state.contract, abi, functionName, args });

// ------------------------------------------------------------------ 1. NEAR
async function initNear() {
  state.selector = await setupWalletSelector({ network: NET, modules: [setupMeteorWallet()] });
  if (state.selector.isSignedIn()) {
    state.wallet = await state.selector.wallet();
    const accs = await state.wallet.getAccounts();
    if (accs.length) await onNear(accs[0].accountId);
  }
}

async function connectNear() {
  try {
    if (!window.meteorCom && !window.meteorWallet) throw new Error("Meteor Wallet extension not found. Install it and reload.");
    state.wallet = await state.selector.wallet("meteor-wallet");
    const accs = await state.wallet.signIn({ contractId: MPC_CONTRACT, methodNames: [] });
    const id = accs?.[0]?.accountId || (await state.wallet.getAccounts())[0]?.accountId;
    if (!id) throw new Error("Wallet returned no account.");
    await onNear(id);
  } catch (e) { log("NEAR connect failed: " + errMsg(e), "err"); }
}

async function onNear(id) {
  state.accountId = id;
  state.vaultId = vaultIdFor(id);
  $("nearInfo").innerHTML = `Connected as <code>${id}</code>`;
  $("btnNear").hidden = true;
  $("btnNearOut").hidden = false;
  $("vaultId").textContent = state.vaultId;
  if (!id.endsWith(NETS[NET].suffix)) log(`${id} does not look like a ${NET} account — switch Meteor to ${NET}.`, "warn");
  log(`NEAR account connected: ${id}`, "ok");
  loadAgentKeys();
  for (const a of state.agents) {
    const { address } = await evm.deriveAddressAndPublicKey(state.vaultId, a.path);
    a.address = address;
  }
  log("Agents derived from the vault: " + state.agents.map((a) => `${a.name} ${short(a.address)}`).join(", "), "ok");
  await refreshVault();
  await createBotAccount();
  await refreshIntentsBalance();
  await refreshBalances();
  updateUi();
}

// ------------------------------------------------------------------ 2a. vault
function loadAgentKeys() {
  const k = `ssAgentKeys:${state.accountId}`;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(k)); } catch (_) {}
  if (!Array.isArray(saved) || saved.length !== AGENTS.length) {
    saved = AGENTS.map(() => KeyPair.fromRandom("ed25519").toString());
    try { localStorage.setItem(k, JSON.stringify(saved)); } catch (_) {}
  }
  state.agentKeys = saved.map((x) => KeyPair.fromString(x));
}

async function viewVault(method, argsBytes = new Uint8Array()) {
  const res = await nearRpc.query({
    request_type: "call_function", finality: "optimistic", account_id: state.vaultId,
    method_name: method, args_base64: btoa(String.fromCharCode(...argsBytes)),
  });
  return new TextDecoder().decode(new Uint8Array(res.result));
}

async function refreshVault() {
  try {
    state.vault = JSON.parse(await viewVault("get_config"));
    if (!state.vault.configured) throw new Error("not configured");
    const okAuction = state.vault.auction.toLowerCase() === state.contract.toLowerCase();
    $("vaultStatus").innerHTML = `<span class="${state.vault.paused ? "warn" : "ok"}">${state.vault.paused ? "PAUSED" : "active"}</span> · owner <code>${state.vault.owner}</code> · approved auction <code>${short(state.vault.auction)}</code>${okAuction ? "" : ' <span class="warn">(different from the contract below — create a new vault for this contract)</span>'} · agents: ${(state.vault.agent_accounts || []).map((x) => `<code>${x.split(".")[0]}</code>`).join(", ")}`;
    $("btnPause").textContent = state.vault.paused ? "Resume vault" : "Pause vault";
  } catch (_) {
    state.vault = null;
    $("vaultStatus").textContent = "not created yet";
  }
  updateUi();
}

const agentAccount = (i) => `${state.agents[i].name.toLowerCase()}.${state.vaultId}`;

function vaultConfigBytes() {
  const be = (v) => { let h = v.toString(16); if (h.length % 2) h = "0" + h; return h.match(/../g).map((x) => parseInt(x, 16)); };
  const auction = state.contract.slice(2).match(/../g).map((x) => parseInt(x, 16));
  const fee = be(POLICY_MAX_FEE), gas = be(POLICY_MAX_GAS);
  const agents = state.agentKeys.flatMap((k, i) => {
    const name = [...new TextEncoder().encode(state.agents[i].name.toLowerCase())];
    return [name.length, ...name, ...k.getPublicKey().data];
  });
  const owner = [...new TextEncoder().encode(state.accountId)];
  return new Uint8Array([...auction, fee.length, ...fee, gas.length, ...gas, state.agentKeys.length, ...agents, owner.length, ...owner]);
}

const enc8 = (t) => new TextEncoder().encode(t);
const u128le = (v) => { const b = new Uint8Array(16); let x = BigInt(v); for (let i = 0; i < 16; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; };

// mainnet only: MPC signer, settlement token, the owner as allowed seller, per-agent spending limits
function settlementSetupActions() {
  if (NET !== "mainnet") return [];
  const fc = (m, a) => actionCreators.functionCall(m, a, 10n * TGAS, 0n);
  return [
    fc("set_mpc", enc8(MPC_CONTRACT)),
    fc("set_settlement", new Uint8Array([INTENTS.length, ...enc8(INTENTS), SETTLE_TOKEN.length, ...enc8(SETTLE_TOKEN)])),
    fc("allow_seller", enc8(state.accountId)),
    ...state.agents.map((_, i) => fc("set_budget", new Uint8Array([i, ...u128le(AGENT_BUDGET_UNITS * UNIT_YOCTO)]))),
  ];
}

// Owner deposits wNEAR into NEAR Intents on behalf of the vault (one approval):
// register on wrap.near if needed, wrap NEAR, then ft_transfer_call to intents.near with msg = vault.
async function fundIntents() {
  const btn = $("btnFundIntents");
  const amount = BigInt(state.agents.length) * AGENT_BUDGET_UNITS * UNIT_YOCTO;
  busy(btn, true, "Approve in Meteor…");
  try {
    await state.wallet.signAndSendTransaction({
      receiverId: SETTLE_TOKEN,
      actions: [
        actionCreators.functionCall("storage_deposit", enc8(JSON.stringify({ account_id: state.accountId, registration_only: true })), 30n * TGAS, 1250000000000000000000n),
        actionCreators.functionCall("near_deposit", enc8("{}"), 10n * TGAS, amount),
        actionCreators.functionCall("ft_transfer_call", enc8(JSON.stringify({ receiver_id: INTENTS, amount: amount.toString(), msg: state.vaultId })), 100n * TGAS, 1n),
      ],
    });
    log(`Deposited ${Number(amount) / 1e24} wNEAR into NEAR Intents for ${state.vaultId}.`, "ok");
    await refreshIntentsBalance();
  } catch (e) { log("Intents deposit failed: " + errMsg(e), "err"); }
  busy(btn, false); updateUi();
}

async function refreshIntentsBalance() {
  if (NET !== "mainnet" || !state.vaultId) return;
  try {
    const res = await nearRpc.query({ request_type: "call_function", finality: "optimistic", account_id: INTENTS, method_name: "mt_balance_of",
      args_base64: btoa(JSON.stringify({ account_id: state.vaultId, token_id: `nep141:${SETTLE_TOKEN}` })) });
    const bal = JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
    $("intentsBal").textContent = `${Number(BigInt(bal)) / 1e24} wNEAR`;
  } catch (_) { $("intentsBal").textContent = "—"; }
}

// An agent (or each pool member, for its share) asks the vault to pay the seller via NEAR Intents.
async function agentSettle(idx, auctionId, units, seller) {
  const kp = state.agentKeys[idx];
  const pub = kp.getPublicKey();
  const account = agentAccount(idx);
  const id = new Uint8Array(32); let x = BigInt(auctionId); for (let i = 31; i >= 0; i--) { id[i] = Number(x & 255n); x >>= 8n; }
  const args = new Uint8Array([...id, ...u128le(BigInt(units) * UNIT_YOCTO), seller.length, ...enc8(seller)]);
  const ak = await nearRpc.query({ request_type: "view_access_key", finality: "final", account_id: account, public_key: pub.toString() });
  const block = await nearRpc.block({ finality: "final" });
  const tx = createTransaction(account, pub, state.vaultId, BigInt(ak.nonce) + 1n,
    [actionCreators.functionCall("settle", args, 100n * TGAS, 0n)], baseDecode(block.header.hash));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encodeTransaction(tx)));
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pub.keyType, data: kp.sign(hash).signature }) });
  const outcome = await nearRpc.sendTransactionUntil(signed, "FINAL");
  const failure = nearFailure(outcome);
  return { ok: !failure, reason: failure, nearTx: outcome?.transaction?.hash };
}

async function settleAuction() {
  const btn = $("btnSettle");
  busy(btn, true, "Paying…");
  try {
    const a = state.auctions.find((x) => x.id === state.selected);
    if (!a?.revealed) throw new Error("Reveal the result first.");
    const seller = state.accountId; // demo: the owner is also the seller (allowlisted at vault creation)
    let payers = [];
    const solo = state.agents.findIndex((x) => x.address?.toLowerCase() === a.winner.toLowerCase());
    if (solo >= 0) payers = [{ idx: solo, units: BigInt(a.price) }];
    else {
      const key = Object.keys(state.poolAddr || {}).find((k) => k.startsWith(a.id + ":") && state.poolAddr[k].toLowerCase() === a.winner.toLowerCase());
      const members = key ? state.pools[key] : null;
      if (!members) throw new Error("The winner is not one of your agents.");
      const total = members.reduce((s, m) => s + m.amount, 0);
      payers = members.map((m) => ({ idx: state.agents.findIndex((x) => x.name === m.name), units: (BigInt(a.price) * BigInt(m.amount)) / BigInt(total) }));
    }
    for (const p of payers) {
      const r = await agentSettle(p.idx, a.id, p.units, seller);
      const name = state.agents[p.idx].name;
      if (!r.ok) { log(`${name}: vault refused payment — ${r.reason}`, "err"); continue; }
      log(`${name} paid ${Number(p.units * UNIT_YOCTO) / 1e24} wNEAR to ${seller} through NEAR Intents (${NETS[NET].explorer}/txns/${r.nearTx}).`, "ok");
    }
    $("settleResult").innerHTML = `<span class="ok">Settled through NEAR Intents. See the log for the transactions.</span>`;
    await refreshIntentsBalance();
  } catch (e) { log("Settlement failed: " + errMsg(e), "err"); $("settleResult").innerHTML = `<span class="err">${errMsg(e)}</span>`; }
  busy(btn, false); updateUi();
}

// Helper for the always-on market bot (market/bot.mjs): the owner creates ssmarket-<owner> with the
// bot's public key as its full-access key. Opened with ?botkey=ed25519:... (testnet only).
async function createBotAccount() {
  const key = new URLSearchParams(location.search).get("botkey");
  if (!key || NET !== "testnet") return;
  const id = `ssmarket-${state.accountId.replace(/\.testnet$/, "").replace(/\./g, "-")}.testnet`;
  if (!confirm(`Create ${id} with 10 testnet NEAR for the market bot (its key: ${key})?`)) return;
  try {
    await state.wallet.signAndSendTransaction({ receiverId: REGISTRAR, actions: [
      actionCreators.functionCall("create_account", new TextEncoder().encode(JSON.stringify({ new_account_id: id, new_public_key: key })), 100n * TGAS, 10n * NEAR),
    ] });
    log(`${id} created for the market bot.`, "ok");
  } catch (e) { log("Bot account creation failed: " + errMsg(e), "err"); }
}

// Meteor (rightly) refuses to deploy contract code from a web page. So setup is two transactions:
//  1. Meteor: create vault.<you> with 3 NEAR and a temporary full-access key generated in this page
//  2. this page, signing with that temporary key: deploy the vault, configure it (the vault records
//     <you> as owner) and DELETE the temporary key in the same transaction. Afterwards the vault has
//     no keys at all: only its code decides what happens.
async function signLocal(signerId, kp, receiverId, actions) {
  const pub = kp.getPublicKey();
  let ak = null;
  for (let i = 0; i < 15 && !ak; i++) {
    try { ak = await nearRpc.query({ request_type: "view_access_key", finality: "final", account_id: signerId, public_key: pub.toString() }); }
    catch (_) { await new Promise((r) => setTimeout(r, 2000)); }
  }
  if (!ak) throw new Error(`${signerId} not visible yet; try again in a minute.`);
  const block = await nearRpc.block({ finality: "final" });
  const tx = createTransaction(signerId, pub, receiverId, BigInt(ak.nonce) + 1n, actions, baseDecode(block.header.hash));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encodeTransaction(tx)));
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pub.keyType, data: kp.sign(hash).signature }) });
  const outcome = await nearRpc.sendTransactionUntil(signed, "FINAL");
  return { failure: nearFailure(outcome), hash: outcome?.transaction?.hash };
}

async function createVault() {
  const btn = $("btnVault");
  busy(btn, true, "Approve in Meteor…");
  try {
    const wasm = new Uint8Array(await (await fetch(vaultWasmUrl)).arrayBuffer());
    // if step 1 already happened (e.g. step 2 failed), resume with the saved setup key
    const skey = `ssVaultSetupKey:${state.vaultId}`;
    let exists = false;
    try { await nearRpc.query({ request_type: "view_account", finality: "final", account_id: state.vaultId }); exists = true; } catch (_) {}
    let saved = null; try { saved = localStorage.getItem(skey); } catch (_) {}
    let temp;
    if (exists && saved) {
      temp = KeyPair.fromString(saved);
      log(`${state.vaultId} already exists: resuming setup with its temporary key.`);
    } else if (exists) {
      throw new Error(`${state.vaultId} already exists but this browser doesn't have its setup key.`);
    } else {
      temp = KeyPair.fromRandom("ed25519");
      try { localStorage.setItem(skey, temp.toString()); } catch (_) {}
      if (state.vaultId.length > 58) throw new Error("Account name too long for a vault; use a shorter account.");
      log(`Step 1/2: the ${REGISTRAR} account registrar creates ${state.vaultId} with ${Number(VAULT_DEPOSIT / NEAR)} NEAR and a temporary setup key that this page holds (deleted in step 2).`);
      await state.wallet.signAndSendTransaction({
        receiverId: REGISTRAR,
        actions: [actionCreators.functionCall("create_account",
          new TextEncoder().encode(JSON.stringify({ new_account_id: state.vaultId, new_public_key: temp.getPublicKey().toString() })),
          100n * TGAS, VAULT_DEPOSIT)],
      });
    }
    busy(btn, false); busy(btn, true, "Deploying the vault…");
    log(`Step 2/2: deploy the vault, set the policy, create ${state.agents.map((_, i) => agentAccount(i)).join(", ")}, then delete the setup key.`);
    const r = await signLocal(state.vaultId, temp, state.vaultId, [
      actionCreators.deployContract(wasm),
      actionCreators.functionCall("configure", vaultConfigBytes(), 100n * TGAS, 0n),
      ...settlementSetupActions(),
      actionCreators.deleteKey(temp.getPublicKey()),
    ]);
    if (r.failure) throw new Error(r.failure);
    try { localStorage.removeItem(skey); } catch (_) {}
    log(`Vault deployed and locked: it has no keys left (${NETS[NET].explorer}/txns/${r.hash}).`, "ok");
    await refreshVault();
  } catch (e) { log("Vault creation failed: " + errMsg(e), "err"); }
  busy(btn, false); updateUi();
}

async function togglePause() {
  const btn = $("btnPause");
  const pause = !(state.vault && state.vault.paused);
  busy(btn, true, "Approve in Meteor…");
  try {
    await state.wallet.signAndSendTransaction({
      receiverId: state.vaultId,
      actions: [actionCreators.functionCall("pause", new Uint8Array([pause ? 1 : 0]), 10n * TGAS, 0n)],
    });
    log(pause ? "Vault paused: every agent is frozen." : "Vault resumed.", pause ? "warn" : "ok");
    await refreshVault();
  } catch (e) { log("Pause failed: " + errMsg(e), "err"); }
  busy(btn, false); updateUi();
}

function nearFailure(outcome) {
  const all = [outcome?.status, outcome?.transaction_outcome?.outcome?.status, ...(outcome?.receipts_outcome || []).map((r) => r.outcome.status)];
  for (const st of all) {
    if (st && st.Failure) {
      const f = JSON.stringify(st.Failure);
      const m = f.match(/Smart contract panicked: ([^"\\]+)/);
      return m ? m[1] : f.slice(0, 200);
    }
  }
  return null;
}

// An agent asks the vault to sign one Ethereum transaction, from its own NEAR sub-account, using
// its only key (a function-call key restricted to vault.request_sign).
async function agentRequestSign(idx, unsignedTxHex) {
  const kp = state.agentKeys[idx];
  const pub = kp.getPublicKey();
  const account = agentAccount(idx);
  const ak = await nearRpc.query({ request_type: "view_access_key", finality: "final", account_id: account, public_key: pub.toString() });
  const block = await nearRpc.block({ finality: "final" });
  const txBytes = Uint8Array.from(unsignedTxHex.slice(2).match(/../g).map((x) => parseInt(x, 16)));
  const tx = createTransaction(account, pub, state.vaultId, BigInt(ak.nonce) + 1n,
    [actionCreators.functionCall("request_sign", txBytes, AGENT_CALL_GAS, 0n)], baseDecode(block.header.hash));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encodeTransaction(tx)));
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pub.keyType, data: kp.sign(hash).signature }) });
  const outcome = await nearRpc.sendTransactionUntil(signed, "FINAL");
  const failure = nearFailure(outcome);
  if (failure) return { ok: false, reason: failure, nearTx: outcome?.transaction?.hash };
  return { ok: true, sig: getTransactionLastResult(outcome), nearTx: outcome?.transaction?.hash };
}

async function simulateRogue() {
  const btn = $("btnRogue");
  busy(btn, true, "Attacking…");
  $("vaultResult").innerHTML = "";
  try {
    const a = state.agents[1];
    const attacker = "0x000000000000000000000000000000000000dEaD";
    log(`Simulating a prompt-injected ${a.name}: it tries to send ETH to ${short(attacker)} using its own key.`, "warn");
    const { transaction } = await evm.prepareTransactionForSigning({ from: a.address, to: attacker, value: parseEther("0.001") });
    const r = await agentRequestSign(1, evm.serializeTransaction(transaction));
    if (r.ok) {
      log("Unexpected: the vault signed the rogue transaction (not broadcast).", "err");
      $("vaultResult").innerHTML = '<span class="err">The vault signed it — policy bug.</span>';
    } else {
      log(`Vault refused ${a.name}: "${r.reason}". Nothing was signed.`, "ok");
      $("vaultResult").innerHTML = `<span class="ok">Blocked on-chain by the vault: <b>${r.reason}</b>. No signature, no transfer.</span>`;
    }
  } catch (e) { log("Simulation failed: " + errMsg(e), "err"); }
  busy(btn, false); updateUi();
}

// ------------------------------------------------------------------ 2. swarm
function renderAgents() {
  $("agents").innerHTML = state.agents.map((a, i) => `
    <div class="agent">
      <h3>${a.name}</h3>
      <div class="style">${a.style}</div>
      <div class="mut">${a.why}</div>
      <div class="mut" style="margin-top:6px">NEAR: <code>${state.vaultId ? `${a.name.toLowerCase()}.${state.vaultId}` : "—"}</code></div>
      <div class="addr" style="margin-top:4px">${a.address || "connect NEAR to derive"}</div>
      <div class="mut">path <code>${a.path}</code> · ${a.balance == null ? "—" : Number(formatEther(a.balance)).toFixed(4) + " ETH"}</div>
      <label>Budget (units)</label><input type="number" min="1" value="${a.budget}" data-budget="${i}" />
      <div class="val">${a.valuation == null ? '<span class="mut">No appraisal yet</span>'
        : `Private valuation: <b>${a.valuation}</b> → sealed bid <b>${a.bid}</b> <span class="lock">🔒 encrypted before sending</span>
           <div class="mut" style="margin-top:4px">${a.brain && a.brain !== "rules" ? `🧠 ${a.brain}: “${escapeHtml(a.reason || "")}”` : "rule-based strategy"}</div>`}</div>
    </div>`).join("");
  document.querySelectorAll("[data-budget]").forEach((el) =>
    el.addEventListener("change", (e) => { state.agents[+e.target.dataset.budget].budget = Math.max(1, +e.target.value || 1); }));
}

async function refreshBalances() {
  for (const a of state.agents) {
    if (!a.address) continue;
    try { a.balance = await publicClient.getBalance({ address: a.address }); } catch (_) {}
  }
  renderAgents();
}

async function fundAgents() {
  const btn = $("btnFund");
  busy(btn, true, "Funding…");
  try {
    const signer = await metamaskSigner();
    for (const a of state.agents) {
      if (a.balance != null && a.balance >= parseEther("0.002")) { log(`${a.name} already funded.`); continue; }
      log(`Sending ${FUND_AMOUNT} ETH to ${a.name} (${short(a.address)})…`);
      const tx = await signer.sendTransaction({ to: a.address, value: parseEther(FUND_AMOUNT) });
      await tx.wait();
      log(`${a.name} funded: ${tx.hash}`, "ok");
    }
    await refreshBalances();
  } catch (e) { log("Funding failed: " + errMsg(e), "err"); }
  busy(btn, false); updateUi();
}

// ------------------------------------------------------------------ 3. contract & auctions
async function deployContract() {
  const btn = $("btnDeploy");
  busy(btn, true, "Deploying…");
  try {
    const signer = await metamaskSigner();
    const c = await new ContractFactory(abi, artifact.bytecode, signer).deploy();
    log("Deploy tx: " + c.deploymentTransaction().hash);
    await c.waitForDeployment();
    state.contract = await c.getAddress();
    localStorage.setItem("ssContractV2", state.contract);
    log("SealedSwarmAuction deployed at " + state.contract, "ok");
    await loadAuctions();
  } catch (e) { log("Deploy failed: " + errMsg(e), "err"); }
  busy(btn, false); updateUi();
}

async function createAuction() {
  const btn = $("btnCreate");
  const item = $("item").value.trim() || "GPU hour";
  const minutes = Math.max(1, +$("duration").value || 5);
  const reserve = Math.max(0, Math.floor(+$("reserve").value || 0));
  busy(btn, true, "Creating…");
  try {
    const signer = await metamaskSigner();
    const c = new Contract(state.contract, abi, signer);
    const tx = await c.createAuction(item, BigInt(minutes * 60), BigInt(reserve));
    log(`createAuction tx: ${tx.hash}`);
    await tx.wait();
    log(`Auction created: "${item}", ${minutes} min, reserve ${reserve}.`, "ok");
    await loadAuctions();
    state.selected = state.auctions.at(-1)?.id ?? null;
    renderAuctions();
  } catch (e) { log("Create failed: " + errMsg(e), "err"); }
  busy(btn, false); updateUi();
}

async function loadAuctions() {
  if (!state.contract) return;
  $("contractAddr").innerHTML = `<a href="https://sepolia.etherscan.io/address/${state.contract}" target="_blank" rel="noopener">${state.contract}</a>`;
  try {
    const n = Number(await read("auctionCount"));
    const list = [];
    for (let id = 1; id <= n; id++) {
      const a = await read("getAuction", [BigInt(id)]);
      list.push({ id, ...a });
      const pc = Number(await read("poolCount", [BigInt(id)]));
      for (let p = 1; p <= pc; p++) {
        const [, , , pa] = await read("getPool", [BigInt(id), BigInt(p)]);
        const members = await read("getPoolMembers", [BigInt(id), BigInt(p)]);
        const names = members.map((m) => state.agents.find((x) => x.address?.toLowerCase() === m.toLowerCase())?.name || short(m));
        state.poolAddr = state.poolAddr || {};
        state.poolAddr[`${id}:${p}`] = pa;
        state.poolNames[pa.toLowerCase()] = `#${p} (${names.join(" + ")})`;
      }
    }
    state.auctions = list;
    if (state.selected == null && list.length) state.selected = list.at(-1).id;
    renderAuctions();
  } catch (e) { log("Could not read auctions: " + errMsg(e), "err"); }
}

function agentName(addr) {
  const a = state.agents.find((x) => x.address && x.address.toLowerCase() === addr.toLowerCase());
  if (a) return `${a.name} (${short(addr)})`;
  const p = state.poolNames[addr.toLowerCase()];
  return p ? `pool ${p}` : short(addr);
}

// pool shares: each member pays price × own contribution / pool total. In the app all members are
// your own agents, so the browser already knows the contributions; on-chain each member can only
// decrypt its own contribution and the pool total.
function poolShares(auctionId, winner, price) {
  for (const [k, members] of Object.entries(state.pools)) {
    if (!k.startsWith(auctionId + ":")) continue;
    if (state.poolAddr?.[k]?.toLowerCase() !== winner.toLowerCase()) continue;
    const total = members.reduce((s, m) => s + m.amount, 0);
    return members.map((m) => `${m.name} pays ${(Number(price) * m.amount / total).toFixed(2)}`).join(", ");
  }
  return "";
}

function renderAuctions() {
  const now = Math.floor(Date.now() / 1000);
  if (!state.auctions.length) {
    $("auctions").innerHTML = `<tr><td colspan="7" class="mut">${state.contract ? "No auctions yet — create one." : "No contract yet."}</td></tr>`;
  } else {
    $("auctions").innerHTML = state.auctions.map((a) => {
      const left = Number(a.endTime) - now;
      const status = a.revealed ? '<span class="badge b-rev">revealed</span>'
        : a.closed ? '<span class="badge b-closed">closed</span>'
        : left > 0 ? `<span class="badge b-open">open · ${Math.floor(left / 60)}m${String(left % 60).padStart(2, "0")}s</span>`
        : '<span class="badge b-closed">ended · close it</span>';
      const result = a.revealed
        ? (a.winner === "0x0000000000000000000000000000000000000000" ? "No sale (below reserve)" : `${agentName(a.winner)} pays <b>${a.price}</b>`)
        : '<span class="lock">🔒 sealed</span>';
      return `<tr class="${a.id === state.selected ? "sel" : ""}"><td>${a.id}</td><td>${a.item}</td><td>${a.reservePrice}</td><td>${a.bidCount}</td><td>${status}</td><td>${result}</td><td><button class="ghost" data-sel="${a.id}">Select</button></td></tr>`;
    }).join("");
    document.querySelectorAll("[data-sel]").forEach((b) => b.addEventListener("click", () => { state.selected = +b.dataset.sel; renderAuctions(); updateUi(); }));
  }
  $("selId").textContent = state.selected ? `#${state.selected}` : "—";
  updateUi();
}

// ------------------------------------------------------------------ 4. swarm bidding
function unitFraction(seed) {
  const h = keccak256(stringToBytes(seed));
  return Number(BigInt(h.slice(0, 14))) / 2 ** 54;
}

function ruleValuation(a, est) {
  const f = a.range[0] + (a.range[1] - a.range[0]) * unitFraction(`${state.accountId}|${a.path}|${state.contract}|${state.selected}`);
  return Math.max(1, Math.round(est * f));
}

// ---- NEAR AI Cloud: private inference in a TEE, with attestation checks done in this browser
const NEARAI = "https://cloud-api.near.ai/v1";
const hexOf = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (hex) => Uint8Array.from((hex.replace(/^0x/, "").match(/../g) || []).map((x) => parseInt(x, 16)));
const sha256Hex = async (bytes) => hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

// Preflight: fetch the model's TDX attestation for a fresh nonce and check what a browser can check.
async function attestModel(model, key) {
  const nonce = hexOf(crypto.getRandomValues(new Uint8Array(32)));
  const q = new URLSearchParams({ model, provider: "near", include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce });
  const res = await fetch(`${NEARAI}/attestation/report?${q}`, { headers: { Accept: "application/json", Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`attestation HTTP ${res.status}`);
  const rep = await res.json();
  const cands = rep.model_attestations || [];
  const checks = [];
  const verified = [];
  checks.push({ ok: cands.length > 0, text: `${cands.length} TEE attestation report(s) returned for ${model}` });
  for (const c of cands) {
    const quote = bytesOf(c.intel_quote || "");
    const reportData = hexOf(quote.slice(568, 632)); // TDX quote v4: 48-byte header + 520 bytes before REPORTDATA
    const signer = (c.signing_address || "").toLowerCase().replace(/^0x/, "");
    const expected = signer.padEnd(64, "0") + nonce;
    const nonceOk = c.request_nonce === nonce;
    const bindOk = quote.length >= 632 && reportData === expected;
    let cfgOk = null;
    try {
      let tcb = c.info?.tcb_info; if (typeof tcb === "string") tcb = JSON.parse(tcb);
      const compose = tcb?.app_compose;
      if (typeof compose === "string") {
        const want = "01" + (await sha256Hex(new TextEncoder().encode(compose))) + "00".repeat(15);
        cfgOk = hexOf(quote.slice(48 + 184, 48 + 232)) === want; // MRCONFIGID
      }
    } catch (_) { cfgOk = false; }
    checks.push({ ok: nonceOk, text: `report echoes our fresh nonce (${nonce.slice(0, 10)}…)` });
    checks.push({ ok: bindOk, text: `TDX quote REPORTDATA binds signer 0x${signer.slice(0, 8)}… and our nonce` });
    if (cfgOk !== null) checks.push({ ok: cfgOk, text: "MRCONFIGID matches SHA-256 of the app compose (the code running in the TEE)" });
    if (nonceOk && bindOk) verified.push({ signer: "0x" + signer, nvidia: !!c.nvidia_payload });
    if (c.nvidia_payload) checks.push({ ok: true, text: "NVIDIA GPU evidence present (confidential-compute GPU)" });
  }
  checks.push({ ok: null, text: "Intel DCAP quote signature chain: not checked in the browser (verify with dcap-qvl, see README)" });
  return { checks, verified };
}

// After a completion: fetch the TEE's signature and check it covers our exact request and response.
async function verifyCompletion(model, key, chatId, reqBytes, resBytes, verified) {
  const res = await fetch(`${NEARAI}/signature/${chatId}?signing_algo=ecdsa`, { headers: { Accept: "application/json", Authorization: `Bearer ${key}` } });
  if (!res.ok) return { ok: false, text: `no signature for ${chatId} (HTTP ${res.status})` };
  const sig = await res.json();
  const want = `${model}:${await sha256Hex(reqBytes)}:${await sha256Hex(resBytes)}`;
  const wantGw = want.slice(model.length + 1);
  const textOk = sig.text === want || (sig.signature_kind === "gateway" && sig.text === wantGw);
  let signerOk = false;
  try { signerOk = (await recoverMessageAddress({ message: sig.text, signature: sig.signature })).toLowerCase() === String(sig.signing_address).toLowerCase(); } catch (_) {}
  const attested = verified.some((v) => v.signer.toLowerCase() === String(sig.signing_address).toLowerCase());
  return { ok: textOk && signerOk && (attested || sig.signature_kind === "gateway"),
    text: `${sig.signature_kind || "signature"}: hashes match ${textOk ? "✔" : "✗"}, ECDSA signer recovered ${signerOk ? "✔" : "✗"}, signer is the attested TEE ${attested ? "✔" : sig.signature_kind === "gateway" ? "(gateway)" : "✗"}` };
}

// Each agent reasons privately on NEAR AI Cloud (models run inside TEEs). The model only proposes a
// valuation; code caps it by the agent's budget, and the vault caps what can ever be signed.
async function aiValuation(a, est, lot, key, model, verified) {
  const sys = `You are ${a.name}, an autonomous procurement agent buying GPU compute in a sealed-bid second-price (Vickrey) auction. ` +
    `Your style: ${a.style}. ${a.why} In a second-price auction the dominant strategy is to bid your true value. ` +
    `Answer with JSON only: {"valuation": <integer units>, "reason": "<max 20 words>"}.`;
  const user = `Lot: "${lot.item}". Public reserve: ${lot.reservePrice} units. Market estimate: ${est} units. ` +
    `Your budget: ${a.budget} units. What is this lot truly worth to you?`;
  const body = JSON.stringify({ model, temperature: 0.4, max_tokens: 400,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }] });
  const reqBytes = new TextEncoder().encode(body);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "x-no-aliasing": "true" };
  let res;
  try { res = await fetch(`${NEARAI}/chat/completions`, { method: "POST", headers, body: reqBytes }); }
  catch (_) { // in case a browser/CORS setup rejects the extra header
    delete headers["x-no-aliasing"];
    res = await fetch(`${NEARAI}/chat/completions`, { method: "POST", headers, body: reqBytes });
  }
  if (!res.ok) throw new Error(`NEAR AI HTTP ${res.status}`);
  const resBytes = new Uint8Array(await res.arrayBuffer());
  const out = JSON.parse(new TextDecoder().decode(resBytes));
  const text = out?.choices?.[0]?.message?.content || "";
  const m = text.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model answer");
  const j = JSON.parse(m[0]);
  const v = Math.round(Number(j.valuation));
  if (!Number.isFinite(v) || v < 1) throw new Error("invalid valuation");
  let proof = null;
  try { proof = await verifyCompletion(model, key, out.id, reqBytes, resBytes, verified); } catch (e) { proof = { ok: false, text: errMsg(e) }; }
  return { valuation: Math.min(v, est * 10), reason: String(j.reason || "").slice(0, 160), proof };
}

function renderVerified(model, checks) {
  const icon = (ok) => ok === null ? "◻" : ok ? "✔" : "✗";
  $("aiVerified").innerHTML = `<b>NEAR AI Cloud · ${escapeHtml(model)} · verification</b><ul style="margin:6px 0 0 18px;padding:0">` +
    checks.map((c) => `<li class="${c.ok === null ? "mut" : c.ok ? "ok" : "err"}">${icon(c.ok)} ${escapeHtml(c.text)}</li>`).join("") + "</ul>";
}

async function appraise() {
  const btn = $("btnAppraise");
  const est = Math.max(1, Math.floor(+$("estimate").value || 100));
  const lot = state.auctions.find((x) => x.id === state.selected) || { item: "lot", reservePrice: 0 };
  const key = $("aiKey").value.trim();
  const model = $("aiModel").value;
  busy(btn, true, key ? "Agents thinking…" : "Appraising…");
  $("aiVerified").innerHTML = "";
  let att = { checks: [], verified: [] };
  if (key) {
    log(`Agents reason privately on NEAR AI Cloud (${model}, TEE). Checking the TEE attestation first…`);
    try { att = await attestModel(model, key); }
    catch (e) { att.checks.push({ ok: false, text: `attestation unavailable: ${errMsg(e)}` }); }
    renderVerified(model, att.checks);
  }
  await Promise.all(state.agents.map(async (a) => {
    a.reason = null; a.brain = "rules";
    if (key) {
      try {
        const r = await aiValuation(a, est, lot, key, model, att.verified);
        a.valuation = r.valuation; a.reason = r.reason; a.brain = model.split("/").pop();
        if (r.proof) att.checks.push({ ok: r.proof.ok, text: `${a.name}'s answer — ${r.proof.text}` });
      } catch (e) {
        log(`${a.name}: NEAR AI unavailable (${errMsg(e)}); falling back to its rule-based strategy.`, "warn");
        a.valuation = ruleValuation(a, est);
      }
    } else {
      a.valuation = ruleValuation(a, est);
    }
    a.bid = Math.min(a.valuation, a.budget); // second-price: true value is optimal; the budget cap is enforced in code
    if (a.valuation > a.budget) log(`${a.name} valued it at ${a.valuation} but its budget caps the bid at ${a.budget}.`, "warn");
  }));
  if (key) renderVerified(model, att.checks);
  log(`Agents appraised auction #${state.selected} ("${lot.item}") against a market estimate of ${est}.`);
  busy(btn, false);
  renderAgents(); updateUi();
}

// One agent transaction: prepare → vault policy check + MPC signature → broadcast → receipt.
async function agentSend(a, data) {
  const { transaction } = await evm.prepareTransactionForSigning({ from: a.address, to: state.contract, data, value: 0n });
  const cost = (transaction.gas ?? 0n) * (transaction.maxFeePerGas ?? 0n);
  const bal = await publicClient.getBalance({ address: a.address });
  if (bal < cost) throw new Error(`${a.name} needs ~${formatEther(cost)} ETH for gas (has ${formatEther(bal)}). Fund it first.`);
  const r = await agentRequestSign(state.agents.indexOf(a), evm.serializeTransaction(transaction));
  if (!r.ok) throw new Error(`vault refused ${a.name}: ${r.reason}`);
  log(`${a.name}: vault approved, MPC signed${r.nearTx ? ` (NEAR tx ${r.nearTx.slice(0, 10)}…)` : ""}.`, "ok");
  const signed = evm.finalizeTransactionSigning({ transaction, rsvSignatures: [utils.cryptography.toRSV(r.sig)] });
  const { hash } = await evm.broadcastTx(signed);
  log(`${a.name}: sent to Sepolia ${hash}`);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${a.name}: transaction reverted`);
  return rc;
}

async function encryptFor(a, value) {
  const fhe = await getFhe();
  const input = fhe.createEncryptedInput(state.contract, a.address);
  input.add64(BigInt(value));
  const enc = await input.encrypt();
  log(`${a.name}: amount encrypted in this browser (handle ${toHex(enc.handles[0]).slice(0, 14)}…).`);
  return enc;
}

async function swarmBid() {
  const btn = $("btnBid");
  const id = BigInt(state.selected);
  const lot = state.auctions.find((x) => x.id === state.selected);
  const reserve = Number(lot?.reservePrice ?? 0);
  busy(btn, true, "Agents bidding…");
  $("bidResult").innerHTML = "";
  let solos = 0, pooled = 0;
  try {
    const ready = [];
    for (const a of state.agents) {
      if (!a.bid) continue;
      if (await read("hasBid", [id, a.address])) { log(`${a.name} already entered auction #${id}.`, "warn"); continue; }
      ready.push(a);
    }
    if (!ready.length) throw new Error("No agent bid to send.");
    // agents that can reach the reserve bid alone; the others pool their budgets (if at least two)
    let solo = ready.filter((a) => a.bid >= reserve);
    let pool = ready.filter((a) => a.bid < reserve);
    if (pool.length === 1) { log(`${pool[0].name} can't reach the reserve alone and has no partner; it sits out.`, "warn"); pool = []; }
    log(`No wallet pop-ups: each agent signs with its own NEAR sub-account; the vault checks the policy, then asks the NEAR MPC network to sign.`);

    // solo bids in parallel
    const soloRes = await Promise.allSettled(solo.map(async (a) => {
      const enc = await encryptFor(a, a.bid);
      await agentSend(a, encodeFunctionData({ abi, functionName: "placeBid", args: [id, toHex(enc.handles[0]), toHex(enc.inputProof)] }));
      log(`${a.name}: sealed bid accepted on-chain.`, "ok");
    }));
    soloRes.forEach((r, i) => { if (r.status === "fulfilled") solos++; else log(`${solo[i].name}: ${errMsg(r.reason)}`, "err"); });

    // buyer pool: creator opens it, the others join, the creator submits the encrypted total
    if (pool.length) {
      log(`${pool.map((a) => a.name).join(" + ")} can't reach the reserve (${reserve}) alone: they form an encrypted buyer pool.`);
      const [creator, ...rest] = pool;
      let enc = await encryptFor(creator, creator.bid);
      await agentSend(creator, encodeFunctionData({ abi, functionName: "joinPool", args: [id, 0n, toHex(enc.handles[0]), toHex(enc.inputProof)] }));
      const poolId = await read("poolCount", [id]);
      log(`${creator.name} opened pool #${poolId} with an encrypted contribution.`, "ok");
      pooled = 1;
      const joinRes = await Promise.allSettled(rest.map(async (a) => {
        const e = await encryptFor(a, a.bid);
        await agentSend(a, encodeFunctionData({ abi, functionName: "joinPool", args: [id, poolId, toHex(e.handles[0]), toHex(e.inputProof)] }));
        log(`${a.name} joined pool #${poolId} (its contribution stays encrypted, even to the other members).`, "ok");
      }));
      joinRes.forEach((r, i) => { if (r.status === "fulfilled") pooled++; else log(`${rest[i].name}: ${errMsg(r.reason)}`, "err"); });
      await agentSend(creator, encodeFunctionData({ abi, functionName: "submitPool", args: [id, poolId] }));
      log(`Pool #${poolId} submitted: the contract added the contributions under encryption; the total competes as one bid.`, "ok");
      state.pools[`${state.selected}:${poolId}`] = pool.filter((_, i) => i === 0 || joinRes[i - 1].status === "fulfilled").map((a) => ({ name: a.name, amount: a.bid }));
    }
    $("bidResult").innerHTML = `<span class="ok">${solos} sealed solo bid(s)${pooled ? ` + 1 encrypted pool of ${pooled} agents` : ""} on auction #${id}.</span>`;
    await loadAuctions();
  } catch (e) {
    log("Swarm bid failed: " + errMsg(e), "err");
    $("bidResult").innerHTML = `<span class="err">${errMsg(e)}</span>`;
  }
  busy(btn, false); updateUi();
}

async function closeAuction() {
  const btn = $("btnClose");
  busy(btn, true, "Closing…");
  try {
    const c = new Contract(state.contract, abi, await metamaskSigner());
    const tx = await c.close(BigInt(state.selected));
    log("close tx: " + tx.hash);
    await tx.wait();
    log(`Auction #${state.selected} closed. Outcome computed under encryption.`, "ok");
    await loadAuctions();
  } catch (e) { log("Close failed: " + errMsg(e), "err"); }
  busy(btn, false); updateUi();
}

async function revealAuction() {
  const btn = $("btnReveal");
  busy(btn, true, "Decrypting…");
  try {
    const id = BigInt(state.selected);
    const ZERO = "0x" + "0".repeat(64);
    const fhe = await getFhe();
    let res = null;
    for (let i = 0; i < 12 && !res; i++) {
      // re-read every attempt: right after close() an RPC node may not have the new block yet
      const [winnerHandle, priceHandle] = await read("getResultHandles", [id]);
      if (winnerHandle === ZERO || priceHandle === ZERO) {
        log("Waiting for the close() block to reach the RPC node…", "warn");
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      try { res = await fhe.publicDecrypt([winnerHandle, priceHandle]); }
      catch (e) { log(`Relayer not ready yet (${errMsg(e).slice(0, 80)}). Retrying…`, "warn"); await new Promise((r) => setTimeout(r, 5000)); }
    }
    if (!res) throw new Error("Public decryption did not succeed.");
    log("Zama KMS returned the decrypted outcome with its proof. Publishing on-chain…", "ok");
    const c = new Contract(state.contract, abi, await metamaskSigner());
    const tx = await c.reveal(id, res.abiEncodedClearValues, res.decryptionProof);
    log("reveal tx: " + tx.hash);
    await tx.wait();
    await loadAuctions();
    const a = state.auctions.find((x) => BigInt(x.id) === id);
    $("revealResult").innerHTML = a.winner === "0x0000000000000000000000000000000000000000"
      ? '<span class="warn">No sale: every bid was below the reserve.</span>'
      : `<span class="ok">Winner: <b>${agentName(a.winner)}</b> — pays <b>${a.price}</b> (second price). All losing bids remain encrypted.${poolShares(a.id, a.winner, a.price) ? ` Pool shares: ${poolShares(a.id, a.winner, a.price)}.` : ""}</span>`;
  } catch (e) { log("Reveal failed: " + errMsg(e), "err"); }
  busy(btn, false); updateUi();
}

// ------------------------------------------------------------------ wiring
function updateUi() {
  const sel = state.auctions.find((a) => a.id === state.selected);
  const now = Math.floor(Date.now() / 1000);
  const open = sel && !sel.closed && Number(sel.endTime) > now;
  const haveSwarm = state.agents.every((a) => a.address);
  const vaultReady = !!(state.vault && state.vault.configured);
  $("btnVault").disabled = !(state.wallet && state.accountId && state.contract) || vaultReady;
  $("btnPause").disabled = !vaultReady;
  $("btnRogue").disabled = !(vaultReady && haveSwarm);
  $("btnFundIntents").disabled = !(vaultReady && NET === "mainnet");
  const selA = state.auctions.find((x) => x.id === state.selected);
  $("btnSettle").disabled = !(NET === "mainnet" && vaultReady && selA?.revealed && selA.winner !== "0x0000000000000000000000000000000000000000");
  $("btnFund").disabled = !haveSwarm;
  $("btnRefresh").disabled = !haveSwarm;
  $("btnCreate").disabled = !state.contract;
  $("btnAppraise").disabled = !(open && haveSwarm);
  $("btnBid").disabled = !(open && haveSwarm && state.agents.some((a) => a.bid) && vaultReady && !state.vault.paused);
  $("btnClose").disabled = !(sel && !sel.closed && Number(sel.endTime) <= now);
  $("btnReveal").disabled = !(sel && sel.closed && !sel.revealed);
}

$("btnNear").addEventListener("click", connectNear);
$("btnNearOut").addEventListener("click", async () => { try { await state.wallet?.signOut(); } catch (_) {} location.reload(); });
$("btnFund").addEventListener("click", fundAgents);
$("btnVault").addEventListener("click", createVault);
$("btnPause").addEventListener("click", togglePause);
$("btnRogue").addEventListener("click", simulateRogue);
$("btnFundIntents").addEventListener("click", fundIntents);
$("btnSettle").addEventListener("click", settleAuction);
$("netSel").value = NET;
$("netSel").addEventListener("change", (e) => { try { localStorage.setItem("ssNet", e.target.value); } catch (_) {} location.reload(); });
if (NET === "mainnet") document.querySelectorAll(".mainnet-only").forEach((el) => (el.hidden = false));
$("btnRefresh").addEventListener("click", refreshBalances);
$("btnDeploy").addEventListener("click", deployContract);
$("btnCreate").addEventListener("click", createAuction);
$("btnAppraise").addEventListener("click", appraise);
$("btnBid").addEventListener("click", swarmBid);
$("btnClose").addEventListener("click", closeAuction);
$("btnReveal").addEventListener("click", revealAuction);

renderAgents();
log("SealedSwarm loaded.");
initNear().catch((e) => log("NEAR init failed: " + errMsg(e), "err"));
loadAuctions();
setInterval(() => { renderAuctions(); }, 1000);
setInterval(() => { loadAuctions(); }, 15000);
