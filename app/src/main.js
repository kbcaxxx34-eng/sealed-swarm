// SealedSwarm — one NEAR account, a swarm of bidding agents on Ethereum, every bid encrypted with Zama FHE.
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators } from "@near-js/transactions";
import { getTransactionLastResult } from "@near-js/utils";
import { contracts, chainAdapters, utils } from "chainsig.js";
import {
  createPublicClient, http, encodeFunctionData, formatEther, parseEther, toHex, keccak256, stringToBytes,
} from "viem";
import { sepolia } from "viem/chains";
import { initSDK, createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/web";
import { BrowserProvider, Contract, ContractFactory } from "ethers";
import artifact from "./contract.json";

// ------------------------------------------------------------------ config
const DEFAULT_CONTRACT = ""; // filled after the first deployment
const MPC_CONTRACT = "v1.signer-prod.testnet";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const SIGN_GAS = 300000000000000n; // 300 Tgas
const SIGN_DEPOSIT = 1n; // 1 yoctoNEAR (required by the MPC contract)
const FUND_AMOUNT = "0.004"; // ETH per agent

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

const state = {
  selector: null, wallet: null, accountId: null,
  agents: AGENTS.map((a) => ({ ...a, address: null, balance: null, valuation: null, bid: null })),
  contract: localStorage.getItem("ssContract") || DEFAULT_CONTRACT,
  auctions: [], selected: null, fhe: null,
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
  $("nearInfo").innerHTML = `Connected as <code>${id}</code>`;
  $("btnNear").hidden = true;
  $("btnNearOut").hidden = false;
  if (!id.endsWith(".testnet")) log(`${id} does not look like a testnet account — switch Meteor to Testnet.`, "warn");
  log(`NEAR account connected: ${id}`, "ok");
  for (const a of state.agents) {
    const { address } = await evm.deriveAddressAndPublicKey(id, a.path);
    a.address = address;
  }
  log("Swarm derived: " + state.agents.map((a) => `${a.name} ${short(a.address)}`).join(", "), "ok");
  await refreshBalances();
  updateUi();
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
        : `Private valuation: <b>${a.valuation}</b> → sealed bid <b>${a.bid}</b> <span class="lock">🔒 encrypted before sending</span>`}</div>
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

function appraise() {
  const est = Math.max(1, Math.floor(+$("estimate").value || 100));
  for (const a of state.agents) {
    const f = a.range[0] + (a.range[1] - a.range[0]) * unitFraction(`${state.accountId}|${a.path}|${state.contract}|${state.selected}`);
    a.valuation = Math.max(1, Math.round(est * f));
    a.bid = Math.min(a.valuation, a.budget); // second-price: bidding true value (capped by budget) is optimal
  }
  log(`Agents appraised auction #${state.selected} against a market estimate of ${est}. Valuations stay in this browser.`);
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
      const { transaction, hashesToSign } = await evm.prepareTransactionForSigning({ from: a.address, to: state.contract, data, value: 0n });
      const cost = (transaction.gas ?? 0n) * (transaction.maxFeePerGas ?? 0n);
      const bal = await publicClient.getBalance({ address: a.address });
      if (bal < cost) { log(`${a.name} needs ~${formatEther(cost)} ETH for gas (has ${formatEther(bal)}). Fund it first.`, "err"); continue; }
      prepared.push({ a, transaction, payload: utils.cryptography.uint8ArrayToHex(hashesToSign[0]) });
      log(`${a.name}: bid encrypted (handle ${toHex(enc.handles[0]).slice(0, 14)}…) and transaction prepared.`, "ok");
    }
    if (!prepared.length) throw new Error("No agent bid to send.");

    busy(btn, false); busy(btn, true, "Approve in Meteor…");
    log(`Requesting ${prepared.length} MPC signatures from ${MPC_CONTRACT} — approve once in Meteor.`);
    const outcomes = await state.wallet.signAndSendTransactions({
      transactions: prepared.map((p) => ({
        signerId: state.accountId,
        receiverId: MPC_CONTRACT,
        actions: [actionCreators.functionCall("sign",
          { request: { payload_v2: { Ecdsa: p.payload }, path: p.a.path, domain_id: 0 } }, SIGN_GAS, SIGN_DEPOSIT)],
      })),
    });

    busy(btn, false); busy(btn, true, "Broadcasting…");
    const sent = [];
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const o = outcomes[i];
      const nearTx = o?.transaction?.hash || o?.transaction_outcome?.id;
      const sig = getTransactionLastResult(o);
      if (!sig) { log(`${p.a.name}: MPC returned no signature.`, "err"); continue; }
      const signed = evm.finalizeTransactionSigning({ transaction: p.transaction, rsvSignatures: [utils.cryptography.toRSV(sig)] });
      const { hash } = await evm.broadcastTx(signed);
      log(`${p.a.name}: NEAR sign ${nearTx ? nearTx.slice(0, 10) + "…" : ""} → Sepolia ${hash}`);
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
    const [winnerHandle, priceHandle] = await read("getResultHandles", [id]);
    const fhe = await getFhe();
    let res = null;
    for (let i = 0; i < 8 && !res; i++) {
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
  $("btnFund").disabled = !haveSwarm;
  $("btnRefresh").disabled = !haveSwarm;
  $("btnCreate").disabled = !state.contract;
  $("btnAppraise").disabled = !(open && haveSwarm);
  $("btnBid").disabled = !(open && haveSwarm && state.agents.some((a) => a.bid) && state.wallet);
  $("btnClose").disabled = !(sel && !sel.closed && Number(sel.endTime) <= now);
  $("btnReveal").disabled = !(sel && sel.closed && !sel.revealed);
}

$("btnNear").addEventListener("click", connectNear);
$("btnNearOut").addEventListener("click", async () => { try { await state.wallet?.signOut(); } catch (_) {} location.reload(); });
$("btnFund").addEventListener("click", fundAgents);
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
