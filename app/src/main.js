// SealedSwarm — a NEAR vault runs a swarm of bidding agents on Ethereum; every bid is encrypted with Zama FHE.
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } from "@near-js/transactions";
import { baseDecode, getTransactionLastResult } from "@near-js/utils";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider, FailoverRpcProvider } from "@near-js/providers";
import vaultWasmUrl from "./swarm_vault.wasm?url";
import { contracts, chainAdapters, utils } from "chainsig.js";
import {
  createPublicClient, http, encodeFunctionData, formatEther, parseEther, toHex, keccak256, stringToBytes,
} from "viem";
import { sepolia } from "viem/chains";
import { initSDK, createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/web";
import { BrowserProvider, Contract, ContractFactory } from "ethers";
import artifact from "./contract.json";

// ------------------------------------------------------------------ config
const DEFAULT_CONTRACT = "0x2B5a1C37967FC1612EE075d2516c3ACa7b543b05"; // Sepolia deployment used in the demo
const MPC_CONTRACT = "v1.signer-prod.testnet";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const AGENT_CALL_GAS = 300000000000000n; // 300 Tgas for request_sign (the vault forwards 250 Tgas to the MPC)
const TGAS = 1000000000000n;
const NEAR = 1000000000000000000000000n; // 1 NEAR in yocto
const FUND_AMOUNT = "0.004"; // ETH per agent
const VAULT_DEPOSIT = 2n * NEAR; // storage + MPC deposits
const AGENT_KEY_ALLOWANCE = NEAR; // gas allowance per agent key
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
const mpc = new contracts.ChainSignatureContract({ networkId: "testnet", contractId: MPC_CONTRACT });
const evm = new chainAdapters.evm.EVM({ publicClient, contract: mpc });
const abi = artifact.abi;
const nearRpc = new FailoverRpcProvider([
  new JsonRpcProvider({ url: "https://rpc.testnet.near.org" }),
  new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }),
]);

const state = {
  selector: null, wallet: null, accountId: null,
  agents: AGENTS.map((a) => ({ ...a, address: null, balance: null, valuation: null, bid: null })),
  contract: localStorage.getItem("ssContract") || DEFAULT_CONTRACT,
  auctions: [], selected: null, fhe: null,
  vaultId: null, vault: null, agentKeys: [],
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
  state.selector = await setupWalletSelector({ network: "testnet", modules: [setupMeteorWallet()] });
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
  state.vaultId = `vault.${id}`;
  $("nearInfo").innerHTML = `Connected as <code>${id}</code>`;
  $("btnNear").hidden = true;
  $("btnNearOut").hidden = false;
  $("vaultId").textContent = state.vaultId;
  if (!id.endsWith(".testnet")) log(`${id} does not look like a testnet account — switch Meteor to Testnet.`, "warn");
  log(`NEAR account connected: ${id}`, "ok");
  loadAgentKeys();
  for (const a of state.agents) {
    const { address } = await evm.deriveAddressAndPublicKey(state.vaultId, a.path);
    a.address = address;
  }
  log("Agents derived from the vault: " + state.agents.map((a) => `${a.name} ${short(a.address)}`).join(", "), "ok");
  await refreshVault();
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
    $("vaultStatus").innerHTML = `<span class="${state.vault.paused ? "warn" : "ok"}">${state.vault.paused ? "PAUSED" : "active"}</span> · owner <code>${state.vault.owner}</code> · approved auction <code>${short(state.vault.auction)}</code>${okAuction ? "" : ' <span class="warn">(different from the contract below)</span>'} · ${state.vault.agents} agents`;
    $("btnPause").textContent = state.vault.paused ? "Resume vault" : "Pause vault";
  } catch (_) {
    state.vault = null;
    $("vaultStatus").textContent = "not created yet";
  }
  updateUi();
}

function vaultConfigBytes() {
  const be = (v) => { let h = v.toString(16); if (h.length % 2) h = "0" + h; return h.match(/../g).map((x) => parseInt(x, 16)); };
  const auction = state.contract.slice(2).match(/../g).map((x) => parseInt(x, 16));
  const fee = be(POLICY_MAX_FEE), gas = be(POLICY_MAX_GAS);
  const keys = state.agentKeys.flatMap((k) => [...k.getPublicKey().data]);
  return new Uint8Array([...auction, fee.length, ...fee, gas.length, ...gas, state.agentKeys.length, ...keys]);
}

async function createVault() {
  const btn = $("btnVault");
  busy(btn, true, "Approve in Meteor…");
  try {
    const wasm = new Uint8Array(await (await fetch(vaultWasmUrl)).arrayBuffer());
    const vaultTx = {
      signerId: state.accountId, receiverId: state.vaultId,
      actions: [
        actionCreators.createAccount(),
        actionCreators.transfer(VAULT_DEPOSIT),
        actionCreators.deployContract(wasm),
        actionCreators.functionCall("configure", vaultConfigBytes(), 30n * TGAS, 0n),
      ],
    };
    const keysTx = {
      signerId: state.accountId, receiverId: state.accountId,
      actions: state.agentKeys.map((k) => actionCreators.addKey(k.getPublicKey(),
        actionCreators.functionCallAccessKey(state.vaultId, ["request_sign"], AGENT_KEY_ALLOWANCE))),
    };
    log(`Creating ${state.vaultId}: deploy the vault, set the policy, give each agent a key that can only call request_sign.`);
    await state.wallet.signAndSendTransactions({ transactions: [vaultTx, keysTx] });
    log("Vault created and agents registered.", "ok");
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

// An agent asks the vault to sign one Ethereum transaction, using only its restricted key.
async function agentRequestSign(idx, unsignedTxHex) {
  const kp = state.agentKeys[idx];
  const pub = kp.getPublicKey();
  const ak = await nearRpc.query({ request_type: "view_access_key", finality: "final", account_id: state.accountId, public_key: pub.toString() });
  const block = await nearRpc.block({ finality: "final" });
  const txBytes = Uint8Array.from(unsignedTxHex.slice(2).match(/../g).map((x) => parseInt(x, 16)));
  const tx = createTransaction(state.accountId, pub, state.vaultId, BigInt(ak.nonce) + 1n,
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
      <div class="addr" style="margin-top:8px">${a.address || "connect NEAR to derive"}</div>
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
    localStorage.setItem("ssContract", state.contract);
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
    }
    state.auctions = list;
    if (state.selected == null && list.length) state.selected = list.at(-1).id;
    renderAuctions();
  } catch (e) { log("Could not read auctions: " + errMsg(e), "err"); }
}

function agentName(addr) {
  const a = state.agents.find((x) => x.address && x.address.toLowerCase() === addr.toLowerCase());
  return a ? `${a.name} (${short(addr)})` : short(addr);
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

// Each agent reasons privately on NEAR AI Cloud (models run inside TEEs). The model only proposes a
// valuation; code caps it by the agent's budget, and the vault caps what can ever be signed.
async function aiValuation(a, est, lot, key, model) {
  const sys = `You are ${a.name}, an autonomous procurement agent in a sealed-bid second-price (Vickrey) auction. ` +
    `Your style: ${a.style}. ${a.why} In a second-price auction the dominant strategy is to bid your true value. ` +
    `Answer with JSON only: {"valuation": <integer units>, "reason": "<max 20 words>"}.`;
  const user = `Lot: "${lot.item}". Public reserve: ${lot.reservePrice} units. Market estimate: ${est} units. ` +
    `Your budget: ${a.budget} units. What is this lot truly worth to you?`;
  const res = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0.4, max_tokens: 400,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`NEAR AI HTTP ${res.status}`);
  const out = await res.json();
  const text = out?.choices?.[0]?.message?.content || "";
  const m = text.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model answer");
  const j = JSON.parse(m[0]);
  const v = Math.round(Number(j.valuation));
  if (!Number.isFinite(v) || v < 1) throw new Error("invalid valuation");
  return { valuation: Math.min(v, est * 10), reason: String(j.reason || "").slice(0, 160) };
}

async function appraise() {
  const btn = $("btnAppraise");
  const est = Math.max(1, Math.floor(+$("estimate").value || 100));
  const lot = state.auctions.find((x) => x.id === state.selected) || { item: "lot", reservePrice: 0 };
  const key = $("aiKey").value.trim();
  const model = $("aiModel").value;
  busy(btn, true, key ? "Agents thinking…" : "Appraising…");
  if (key) log(`Agents reason privately on NEAR AI Cloud (${model}, TEE). Their valuations never leave this browser in clear.`);
  await Promise.all(state.agents.map(async (a) => {
    a.reason = null; a.brain = "rules";
    if (key) {
      try {
        const r = await aiValuation(a, est, lot, key, model);
        a.valuation = r.valuation; a.reason = r.reason; a.brain = model.split("/").pop();
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
  log(`Agents appraised auction #${state.selected} ("${lot.item}") against a market estimate of ${est}.`);
  busy(btn, false);
  renderAgents(); updateUi();
}

async function swarmBid() {
  const btn = $("btnBid");
  const id = BigInt(state.selected);
  busy(btn, true, "Encrypting…");
  $("bidResult").innerHTML = "";
  try {
    const fhe = await getFhe();
    const prepared = [];
    for (const a of state.agents) {
      if (!a.bid) continue;
      if (await read("hasBid", [id, a.address])) { log(`${a.name} already bid on #${id}.`, "warn"); continue; }
      const input = fhe.createEncryptedInput(state.contract, a.address);
      input.add64(BigInt(a.bid));
      const enc = await input.encrypt();
      const data = encodeFunctionData({ abi, functionName: "placeBid", args: [id, toHex(enc.handles[0]), toHex(enc.inputProof)] });
      const { transaction } = await evm.prepareTransactionForSigning({ from: a.address, to: state.contract, data, value: 0n });
      const cost = (transaction.gas ?? 0n) * (transaction.maxFeePerGas ?? 0n);
      const bal = await publicClient.getBalance({ address: a.address });
      if (bal < cost) { log(`${a.name} needs ~${formatEther(cost)} ETH for gas (has ${formatEther(bal)}). Fund it first.`, "err"); continue; }
      prepared.push({ a, transaction });
      log(`${a.name}: bid encrypted (handle ${toHex(enc.handles[0]).slice(0, 14)}…) and transaction prepared.`, "ok");
    }
    if (!prepared.length) throw new Error("No agent bid to send.");

    busy(btn, false); busy(btn, true, "Agents asking the vault…");
    log(`${prepared.length} agents ask the vault in parallel, each with its own restricted key. No wallet pop-up.`);
    const results = await Promise.all(prepared.map(async (p) => {
      const idx = state.agents.indexOf(p.a);
      try { return { p, r: await agentRequestSign(idx, evm.serializeTransaction(p.transaction)) }; }
      catch (e) { return { p, r: { ok: false, reason: errMsg(e) } }; }
    }));
    const sent = [];
    for (const { p, r } of results) {
      if (!r.ok) { log(`${p.a.name}: vault refused — ${r.reason}`, "err"); continue; }
      log(`${p.a.name}: vault approved, MPC signed (NEAR tx ${r.nearTx ? r.nearTx.slice(0, 10) + "…" : ""}).`, "ok");
      const signed = evm.finalizeTransactionSigning({ transaction: p.transaction, rsvSignatures: [utils.cryptography.toRSV(r.sig)] });
      const { hash } = await evm.broadcastTx(signed);
      log(`${p.a.name}: sealed bid sent to Sepolia ${hash}`);
      sent.push({ a: p.a, hash });
    }
    let ok = 0;
    for (const s of sent) {
      const r = await publicClient.waitForTransactionReceipt({ hash: s.hash });
      if (r.status === "success") { ok++; log(`${s.a.name}: sealed bid accepted on-chain.`, "ok"); }
      else log(`${s.a.name}: transaction reverted.`, "err");
    }
    $("bidResult").innerHTML = `<span class="${ok ? "ok" : "err"}">${ok}/${prepared.length} sealed bids accepted on auction #${id}.</span>`;
    await loadAuctions();
  } catch (e) {
    log("Swarm bid failed: " + errMsg(e), "err");
    $("bidResult").innerHTML = `<span class="err">${errMsg(e)}</span>`;
  }
  busy(btn, false); updateUi();
}

// ------------------------------------------------------------------ 5. close & reveal
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
      : `<span class="ok">Winner: <b>${agentName(a.winner)}</b> — pays <b>${a.price}</b> (second price). All losing bids remain encrypted.</span>`;
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
  $("btnVault").disabled = !(state.wallet && state.accountId) || vaultReady;
  $("btnPause").disabled = !vaultReady;
  $("btnRogue").disabled = !(vaultReady && haveSwarm);
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
