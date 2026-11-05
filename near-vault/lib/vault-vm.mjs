// Runs the compiled SwarmVault wasm against an in-memory mock of the NEAR host API.
// Used by the unit tests and by the market simulation (so every simulated agent transaction goes
// through the real vault policy code).
import fs from "node:fs";
import { keccak256, hexToBytes } from "viem";

export const VAULT_WASM = fs.readFileSync(new URL("../build/swarm_vault.wasm", import.meta.url));

export class Panic extends Error {}

const dec = (b) => Buffer.from(b).toString();
const u128le = (b) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };

export function makeVm({ accountId = "vault.owner.testnet", wasm = VAULT_WASM } = {}) {
  const module = new WebAssembly.Module(wasm);
  const storage = new Map();
  const ctx = { input: new Uint8Array(), predecessor: "", logs: [], ret: null, promises: [], results: [] };
  const regs = new Map();
  let mem;
  const u8 = () => new Uint8Array(mem.buffer);
  const read = (len, ptr) => u8().slice(Number(ptr), Number(ptr) + Number(len));
  const key = (b) => Buffer.from(b).toString("hex");
  const env = {
    input: (r) => regs.set(r, ctx.input),
    register_len: (r) => (regs.has(r) ? BigInt(regs.get(r).length) : 0xffffffffffffffffn),
    read_register: (r, p) => u8().set(regs.get(r), Number(p)),
    value_return: (l, p) => { ctx.ret = read(l, p); },
    panic_utf8: (l, p) => { throw new Panic(dec(read(l, p))); },
    log_utf8: (l, p) => ctx.logs.push(dec(read(l, p))),
    storage_write: (kl, kp, vl, vp, r) => { const k = key(read(kl, kp)); const had = storage.has(k); if (had) regs.set(r, storage.get(k)); storage.set(k, read(vl, vp)); return had ? 1n : 0n; },
    storage_read: (kl, kp, r) => { const k = key(read(kl, kp)); if (!storage.has(k)) return 0n; regs.set(r, storage.get(k)); return 1n; },
    predecessor_account_id: (r) => regs.set(r, new TextEncoder().encode(ctx.predecessor)),
    current_account_id: (r) => regs.set(r, new TextEncoder().encode(accountId)),
    keccak256: (l, p, r) => regs.set(r, hexToBytes(keccak256(read(l, p)))),
    promise_create: (al, ap, ml, mp, gl, gp, amp, gas) => {
      ctx.promises.push({ kind: "call", account: dec(read(al, ap)), method: dec(read(ml, mp)), args: dec(read(gl, gp)), amount: u128le(read(16, amp)), gas });
      return BigInt(ctx.promises.length - 1);
    },
    promise_return: () => {},
    promise_then: (pi, al, ap, ml, mp, gl, gp, amp, gas) => {
      ctx.promises.push({ kind: "then", after: Number(pi), account: dec(read(al, ap)), method: dec(read(ml, mp)), args: read(gl, gp), amount: u128le(read(16, amp)), gas });
      return BigInt(ctx.promises.length - 1);
    },
    promise_results_count: () => BigInt(ctx.results.length),
    promise_result: (i) => BigInt(ctx.results[Number(i)] ?? 0),
    storage_remove: (kl, kp, r) => { const k = key(read(kl, kp)); const had = storage.has(k); if (had) { regs.set(r, storage.get(k)); storage.delete(k); } return had ? 1n : 0n; },
    promise_batch_create: (al, ap) => { ctx.promises.push({ kind: "batch", account: dec(read(al, ap)), actions: [] }); return BigInt(ctx.promises.length - 1); },
    promise_batch_action_create_account: (i) => ctx.promises[Number(i)].actions.push({ type: "CreateAccount" }),
    promise_batch_action_transfer: (i, ap) => ctx.promises[Number(i)].actions.push({ type: "Transfer", amount: u128le(read(16, ap)) }),
    promise_batch_action_add_key_with_function_call: (i, kl, kp, nonce, alp, rl, rp, ml, mp) => ctx.promises[Number(i)].actions.push({
      type: "AddKey", publicKey: read(kl, kp), nonce, allowance: u128le(read(16, alp)), receiver: dec(read(rl, rp)), methods: dec(read(ml, mp)),
    }),
  };
  // results: outcomes of the promises a callback waits on (1 = success, 2 = failure)
  function call(method, { input = new Uint8Array(), predecessor = "owner.testnet", results = [] } = {}) {
    const inst = new WebAssembly.Instance(module, { env });
    mem = inst.exports.memory;
    Object.assign(ctx, { input, predecessor, logs: [], ret: null, promises: [], results });
    inst.exports[method]();
    return { ret: ctx.ret ? dec(ctx.ret) : null, logs: ctx.logs, promises: ctx.promises };
  }
  return { call, storage, accountId };
}

/// Builds the binary configure() arguments.
export function configArgs({ auction, maxFee = 50_000_000_000n, maxGas = 3_000_000n, agents }) {
  const be = (v) => { let h = v.toString(16); if (h.length % 2) h = "0" + h; return [...hexToBytes("0x" + h)]; };
  const f = be(maxFee), g = be(maxGas);
  const out = [...hexToBytes(auction), f.length, ...f, g.length, ...g, agents.length];
  for (const a of agents) {
    const name = [...new TextEncoder().encode(a.name)];
    out.push(name.length, ...name, ...a.publicKey);
  }
  return new Uint8Array(out);
}

const enc = (t) => new TextEncoder().encode(t);
export const u128 = (v) => { const b = new Uint8Array(16); let x = BigInt(v); for (let i = 0; i < 16; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
export const settlementArgs = (intents, token) => new Uint8Array([enc(intents).length, ...enc(intents), enc(token).length, ...enc(token)]);
export const budgetArgs = (agentIndex, amount) => new Uint8Array([agentIndex, ...u128(amount)]);
export function settleArgs(auctionId, amount, seller) {
  const id = new Uint8Array(32); let x = BigInt(auctionId); for (let i = 31; i >= 0; i--) { id[i] = Number(x & 255n); x >>= 8n; }
  return new Uint8Array([...id, ...u128(amount), enc(seller).length, ...enc(seller)]);
}
