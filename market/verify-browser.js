// In-browser verification of the live market, from public RPC only. The visitor's browser, not our
// server, rebuilds each Sepolia transaction from the NEAR vault transaction and the NEAR MPC
// signature, recovers the signer and checks it is the agent's address derived from its vault.
import { keccak256, parseTransaction, serializeTransaction, recoverTransactionAddress, recoverMessageAddress, getAddress } from "https://esm.sh/viem@2.21.0";
import { secp256k1 } from "https://esm.sh/@noble/curves@1.6.0/secp256k1";
import { sha3_256 } from "https://esm.sh/@noble/hashes@1.5.0/sha3";

const NEAR_ARCHIVAL = ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
const NEAR_RPC = ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"];
const ETH_RPC = ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"];
const AUCTION = "0x4994b9537D50756c5858399bDd460Ba70BE878cc";
// public root key of v1.signer-prod.testnet (NEAR MPC, secp256k1)
const MPC_ROOT = "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function post(urls, method, params) {
  let last;
  for (let i = 0; i < 4; i++) for (const url of urls) {
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      if (j.result !== undefined && j.result !== null) return j.result;
      last = j.error ? JSON.stringify(j.error) : "empty result";
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw new Error(`${method}: ${String(last).slice(0, 160)}`);
}
const nearTx = (hash, sender) => post(NEAR_ARCHIVAL, "tx", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" });
const ethReceipt = (hash) => post(ETH_RPC, "eth_getTransactionReceipt", [hash]);

// the agent's Ethereum address = keccak(root + epsilon·G), epsilon = sha3("…derivation:<vault>,<path>")
const root = secp256k1.ProjectivePoint.fromHex("04" + hex(b58decode(MPC_ROOT.split(":")[1])));
const addrCache = new Map();
function derivedAddress(vault, index) {
  const k = vault + "#" + index;
  if (!addrCache.has(k)) {
    const eps = BigInt("0x" + hex(sha3_256(new TextEncoder().encode(`near-mpc-recovery v0.1.0 epsilon derivation:${vault},sealedswarm-agent-${index}`))));
    const child = root.add(secp256k1.ProjectivePoint.BASE.multiply(eps)).toRawBytes(false);
    addrCache.set(k, getAddress("0x" + keccak256(child.slice(1)).slice(-40)));
  }
  return addrCache.get(k);
}
const configs = new Map();
async function agentIndex(account) {
  const vault = account.split(".").slice(1).join(".");
  if (!configs.has(vault)) {
    const r = await post(NEAR_RPC, "query", { request_type: "call_function", finality: "final", account_id: vault, method_name: "get_config", args_base64: btoa("{}") });
    configs.set(vault, JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))));
  }
  return { vault, index: configs.get(vault).agent_accounts.indexOf(account) + 1 };
}

/** NEAR request_sign tx + MPC signature → exactly this Sepolia tx, from the agent's derived address */
export async function proveAction(account, nearHash, ethHash) {
  const tx = await nearTx(nearHash, account);
  const fc = tx.transaction.actions.find((a) => a.FunctionCall)?.FunctionCall;
  if (fc?.method_name !== "request_sign") throw new Error("not a request_sign call");
  const unsigned = "0x" + hex(b64bytes(fc.args));
  const sig = JSON.parse(atob(tx.status.SuccessValue));
  const parsed = parseTransaction(unsigned);
  const signed = serializeTransaction(parsed, { r: "0x" + sig.big_r.affine_point.slice(2), s: "0x" + sig.s.scalar, yParity: sig.recovery_id });
  const hash = keccak256(signed);
  const signer = await recoverTransactionAddress({ serializedTransaction: signed });
  const { vault, index } = await agentIndex(account);
  const expected = derivedAddress(vault, index);
  const rc = await ethReceipt(ethHash);
  const ok = hash.toLowerCase() === ethHash.toLowerCase() && signer === expected && getAddress(parsed.to) === getAddress(AUCTION) && rc.status === "0x1";
  return { ok, text: `NEAR ${nearHash.slice(0, 8)}… + MPC signature → Sepolia ${hash.slice(0, 10)}… ${hash.toLowerCase() === ethHash.toLowerCase() ? "(same hash)" : "≠ " + ethHash.slice(0, 10)}, signer ${signer.slice(0, 8)}… = ${vault} path ${index}` };
}

export async function proveRefusal(b) {
  const tx = await nearTx(b.near, b.agent);
  const f = JSON.stringify(tx.status);
  const ok = !tx.status.SuccessValue && f.includes(b.reason);
  return { ok, text: `refused on NEAR: ${f.match(/Smart contract panicked: [^"\\]*/)?.[0] ?? "no failure found"}` };
}

export async function provePayment(p) {
  const tx = await nearTx(p.near, p.agent);
  const logs = (tx.receipts_outcome || []).flatMap((r) => r.outcome.logs);
  // the transfer as logged by the token contract itself (NEP-141 event, or wrap.testnet's legacy line)
  let ev = null;
  for (const r of tx.receipts_outcome || []) {
    if (r.outcome.executor_id !== "wrap.testnet" || !("SuccessValue" in r.outcome.status)) continue;
    for (const l of r.outcome.logs) {
      if (l.startsWith("EVENT_JSON:")) { const e = JSON.parse(l.slice(11)); if (e.standard === "nep141" && e.event === "ft_transfer") ev = e.data[0]; }
      const m = l.match(/^Transfer (\d+) from (\S+) to (\S+)$/);
      if (m) ev = { amount: m[1], old_owner_id: m[2], new_owner_id: m[3] };
    }
  }
  const vault = p.agent.split(".").slice(1).join(".");
  const ok = !!ev && ev.old_owner_id === vault && ev.new_owner_id === p.seller && BigInt(ev.amount) === BigInt(p.units) * 100000000000000000000n && logs.includes("settlement confirmed");
  return { ok, text: ev ? `wrap.testnet transfer ${Number(BigInt(ev.amount) / 10n ** 20n) / 10000} wNEAR ${ev.old_owner_id} → ${ev.new_owner_id}` : "no transfer logged by wrap.testnet" };
}

// TEE proof: signature over sha256(request):sha256(response) from a signer bound to a TDX quote + nonce
const sha256 = async (s) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
export async function proveDecision(proof, attestations) {
  const sig = proof.signature;
  const want = `${proof.model}:${await sha256(proof.request)}:${await sha256(proof.response)}`;
  const hashes = sig.text === want || (sig.signature_kind === "gateway" && sig.text === want.slice(proof.model.length + 1));
  const signer = (await recoverMessageAddress({ message: sig.text, signature: sig.signature })).toLowerCase();
  const att = attestations.find((a) => a.signer === signer);
  let bound = false;
  if (att) { const q = att.quote.replace(/^0x/, ""); bound = q.slice(568 * 2, 632 * 2) === signer.slice(2).padEnd(64, "0") + att.nonce; }
  return { ok: hashes && bound, text: `TEE signature over the exact request+response ${hashes ? "✔" : "✗"}, signer ${signer.slice(0, 8)}… bound to a TDX quote with a fresh nonce ${bound ? "✔" : "✗"}` };
}

/** all checks for one dashboard round; onLine(ok, text) is called as each check finishes */
export async function verifyRound(r, base, onLine) {
  const run = async (label, p) => { try { const x = await p; onLine(x.ok, `${label}: ${x.text}`); } catch (e) { onLine(false, `${label}: ${e.message}`); } };
  for (const a of r.agents) if (a.ok && a.near && a.eth) await run(`${a.name} ${a.action}`, proveAction(a.account, a.near, a.eth));
  for (const t of r.txs) if (t.near && t.eth) { const acct = t.account ?? r.agents.find((x) => x.name === t.what.split(" by ")[1])?.account; await run(t.what, proveAction(acct, t.near, t.eth)); }
  if (r.blocked?.near) await run(`hijack (${r.blocked.attempt})`, proveRefusal({ ...r.blocked, reason: r.blocked.reason || "target is not the approved auction contract" }));
  for (const p of r.payments || []) await run(`${p.agent.split(".")[0]} paid`, provePayment(p));
  if (r.ai?.proofs) {
    try {
      const bundle = await (await fetch(base + r.ai.proofs, { cache: "no-store" })).json();
      for (const [acct, proof] of Object.entries(bundle.decisions)) await run(`${acct.split(".")[0]} decided in a TEE`, proveDecision(proof, bundle.attestations));
    } catch (e) { onLine(false, "TEE proofs: " + e.message); }
  }
}
