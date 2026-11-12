// Offline check of a NEAR AI Cloud (TEE) proof, shared by the market bot and the verifier.
//
// A proof bundles: the attestation the bot fetched with a fresh nonce (the TDX quote of the TEE that
// runs the model, with the model's signing address and that nonce in REPORTDATA), and for one agent's
// decision, the exact request and response bytes plus the TEE's ECDSA signature over
// "<model>:<sha256(request)>:<sha256(response)>". Anyone can recheck it without an API key.
import crypto from "node:crypto";

const sha256Hex = (s) => crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const bytesOf = (hex) => Buffer.from(String(hex).replace(/^0x/, ""), "hex");

/** quote: hex TDX quote; returns REPORTDATA (64 bytes, hex) or null */
export function reportData(quoteHex) {
  const q = bytesOf(quoteHex);
  return q.length >= 632 ? q.subarray(568, 632).toString("hex") : null; // TDX quote v4: 48-byte header + 520 bytes
}

/** attestation: { nonce, signer, quote }. True if the quote binds this signer and this nonce. */
export function attestationBinds(att) {
  if (!att?.quote || !att?.signer || !att?.nonce) return false;
  const signer = att.signer.toLowerCase().replace(/^0x/, "");
  return reportData(att.quote) === signer.padEnd(64, "0") + att.nonce.toLowerCase();
}

/**
 * proof: { model, request, response, signature: { text, signature, signing_address, signature_kind } }
 * attestations: [{ nonce, signer, quote }] for the same round.
 * recover: viem's recoverMessageAddress (passed in so this file has no dependencies).
 * Returns { ok, checks: [{ ok, text }] }.
 */
export async function checkDecisionProof(proof, attestations, recoverMessageAddress) {
  const checks = [];
  const sig = proof?.signature;
  if (!sig) return { ok: false, checks: [{ ok: false, text: "no TEE signature recorded" }] };
  const want = `${proof.model}:${sha256Hex(proof.request)}:${sha256Hex(proof.response)}`;
  const hashesOk = sig.text === want || (sig.signature_kind === "gateway" && sig.text === want.slice(proof.model.length + 1));
  checks.push({ ok: hashesOk, text: "signature covers sha256 of the exact request and response" });
  let signer = null;
  try { signer = (await recoverMessageAddress({ message: sig.text, signature: sig.signature })).toLowerCase(); } catch {}
  const signerOk = !!signer && signer === String(sig.signing_address).toLowerCase();
  checks.push({ ok: signerOk, text: `ECDSA signer recovered: ${signer ?? "none"}` });
  const att = attestations.find((a) => a.signer?.toLowerCase() === signer);
  const attested = !!att && attestationBinds(att);
  checks.push({ ok: attested, text: attested ? `signer is bound to a TDX quote with the bot's fresh nonce ${att.nonce.slice(0, 10)}…` : "signer not found in this round's attested TEE quotes" });
  return { ok: hashesOk && signerOk && attested, checks };
}

export { sha256Hex };
