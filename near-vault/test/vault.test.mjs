// Runs the compiled SwarmVault wasm against a mock of the NEAR host API.
// Checks the policy logic: owner, agent keys, transaction decoding and every rejection path.
import fs from "node:fs";
import assert from "node:assert/strict";
import { keccak256, serializeTransaction, encodeFunctionData, hexToBytes, bytesToHex } from "viem";

const wasm = fs.readFileSync(new URL("../build/swarm_vault.wasm", import.meta.url));
const abi = JSON.parse(fs.readFileSync("/home/claude/sealed-swarm/app/src/contract.json", "utf8")).abi;

class Panic extends Error {}

function makeVm() {
  const storage = new Map();
  const ctx = { input: new Uint8Array(), predecessor: "", signerPk: new Uint8Array(33), logs: [], ret: null, promises: [] };
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
    panic_utf8: (l, p) => { throw new Panic(Buffer.from(read(l, p)).toString()); },
    log_utf8: (l, p) => ctx.logs.push(Buffer.from(read(l, p)).toString()),
    storage_write: (kl, kp, vl, vp, r) => { const k = key(read(kl, kp)); const had = storage.has(k); if (had) regs.set(r, storage.get(k)); storage.set(k, read(vl, vp)); return had ? 1n : 0n; },
    storage_read: (kl, kp, r) => { const k = key(read(kl, kp)); if (!storage.has(k)) return 0n; regs.set(r, storage.get(k)); return 1n; },
    predecessor_account_id: (r) => regs.set(r, new TextEncoder().encode(ctx.predecessor)),
    signer_account_pk: (r) => regs.set(r, ctx.signerPk),
    keccak256: (l, p, r) => regs.set(r, hexToBytes(keccak256(read(l, p)))),
    promise_create: (al, ap, ml, mp, gl, gp, amp, gas) => {
      ctx.promises.push({ account: Buffer.from(read(al, ap)).toString(), method: Buffer.from(read(ml, mp)).toString(),
        args: Buffer.from(read(gl, gp)).toString(), amount: read(16, amp), gas });
      return BigInt(ctx.promises.length - 1);
    },
    promise_return: () => {},
  };
  function call(method, { input = new Uint8Array(), predecessor = "owner.testnet", signerPk = new Uint8Array(33) } = {}) {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), { env });
    mem = inst.exports.memory;
    Object.assign(ctx, { input, predecessor, signerPk, logs: [], ret: null, promises: [] });
    inst.exports[method]();
    return { ret: ctx.ret ? Buffer.from(ctx.ret).toString() : null, logs: ctx.logs, promises: ctx.promises };
  }
  return { call, storage };
}

const AUCTION = "0x2B5a1C37967FC1612EE075d2516c3ACa7b543b05";
const keys = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
const pk = (k) => { const b = new Uint8Array(33); b.set(k, 1); return b; };

function configArgs({ auction = AUCTION, maxFee = 50_000_000_000n, maxGas = 3_000_000n, agents = keys } = {}) {
  const be = (v) => { let h = v.toString(16); if (h.length % 2) h = "0" + h; return hexToBytes("0x" + h); };
  const f = be(maxFee), g = be(maxGas);
  return new Uint8Array([...hexToBytes(auction), f.length, ...f, g.length, ...g, agents.length, ...agents.flatMap((k) => [...k])]);
}

function tx({ to = AUCTION, chainId = 11155111, value = 0n, auctionId = 1n, maxFeePerGas = 2_000_000_000n, gas = 1_000_000n, data } = {}) {
  data ??= encodeFunctionData({ abi, functionName: "placeBid", args: [auctionId, "0x" + "ab".repeat(32), "0x" + "cd".repeat(100)] });
  return hexToBytes(serializeTransaction({ type: "eip1559", chainId, nonce: 3, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas, gas, to, value, data }));
}

function expectPanic(fn, text) {
  assert.throws(fn, (e) => e instanceof Panic && e.message.includes(text), `expected panic containing "${text}"`);
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ✔ " + name); }

console.log("SwarmVault (wasm, mocked NEAR host)");

test("configure sets the owner and the policy", () => {
  const vm = makeVm();
  const r = vm.call("configure", { input: configArgs() });
  assert.ok(r.logs[0].includes("3 agents"));
  const cfg = JSON.parse(vm.call("get_config").ret);
  assert.equal(cfg.owner, "owner.testnet");
  assert.equal(cfg.auction, AUCTION.toLowerCase());
  assert.equal(cfg.agents, 3);
  assert.equal(cfg.paused, false);
});

test("only the owner can reconfigure or pause", () => {
  const vm = makeVm();
  vm.call("configure", { input: configArgs() });
  expectPanic(() => vm.call("configure", { input: configArgs(), predecessor: "mallory.testnet" }), "only the owner");
  expectPanic(() => vm.call("pause", { input: new Uint8Array([1]), predecessor: "mallory.testnet" }), "only the owner");
});

test("a valid bid is signed for the right agent path and payload", () => {
  const vm = makeVm();
  vm.call("configure", { input: configArgs() });
  const t = tx();
  const r = vm.call("request_sign", { input: t, signerPk: pk(keys[1]) });
  assert.equal(r.promises.length, 1);
  const p = r.promises[0];
  assert.equal(p.account, "v1.signer-prod.testnet");
  assert.equal(p.method, "sign");
  assert.equal(p.amount[0], 1);
  const args = JSON.parse(p.args);
  assert.equal(args.request.path, "sealedswarm-agent-2");
  assert.equal(args.request.domain_id, 0);
  assert.equal("0x" + args.request.payload_v2.Ecdsa, keccak256(t));
});

test("each agent can bid only once per auction, but on many auctions", () => {
  const vm = makeVm();
  vm.call("configure", { input: configArgs() });
  vm.call("request_sign", { input: tx({ auctionId: 7n }), signerPk: pk(keys[0]) });
  expectPanic(() => vm.call("request_sign", { input: tx({ auctionId: 7n }), signerPk: pk(keys[0]) }), "already bid");
  vm.call("request_sign", { input: tx({ auctionId: 7n }), signerPk: pk(keys[2]) }); // another agent, same auction
  vm.call("request_sign", { input: tx({ auctionId: 8n }), signerPk: pk(keys[0]) }); // same agent, new auction
  assert.equal(vm.call("has_bid", { input: new Uint8Array([0, ...hexToBytes("0x" + (7n).toString(16).padStart(64, "0"))]) }).ret, "true");
  assert.equal(vm.call("has_bid", { input: new Uint8Array([1, ...hexToBytes("0x" + (7n).toString(16).padStart(64, "0"))]) }).ret, "false");
});

test("rejects unknown keys and callers other than the owner", () => {
  const vm = makeVm();
  vm.call("configure", { input: configArgs() });
  expectPanic(() => vm.call("request_sign", { input: tx(), signerPk: pk(new Uint8Array(32).fill(9)) }), "not a registered agent");
  expectPanic(() => vm.call("request_sign", { input: tx(), signerPk: pk(keys[0]), predecessor: "mallory.testnet" }), "only the owner");
});

test("rejects other contracts, chains, ETH value and functions", () => {
  const vm = makeVm();
  vm.call("configure", { input: configArgs() });
  const s = pk(keys[0]);
  expectPanic(() => vm.call("request_sign", { input: tx({ to: "0x000000000000000000000000000000000000dEaD" }), signerPk: s }), "approved auction");
  expectPanic(() => vm.call("request_sign", { input: tx({ chainId: 1 }), signerPk: s }), "Sepolia only");
  expectPanic(() => vm.call("request_sign", { input: tx({ value: 1n }), signerPk: s }), "cannot send ETH");
  const close = encodeFunctionData({ abi, functionName: "close", args: [1n] });
  expectPanic(() => vm.call("request_sign", { input: tx({ data: close }), signerPk: s }), "only placeBid");
});

test("enforces the owner's gas caps", () => {
  const vm = makeVm();
  vm.call("configure", { input: configArgs({ maxFee: 10_000_000_000n, maxGas: 2_000_000n }) });
  const s = pk(keys[0]);
  expectPanic(() => vm.call("request_sign", { input: tx({ maxFeePerGas: 10_000_000_001n }), signerPk: s }), "max fee");
  expectPanic(() => vm.call("request_sign", { input: tx({ gas: 2_000_001n }), signerPk: s }), "gas limit");
  vm.call("request_sign", { input: tx({ maxFeePerGas: 10_000_000_000n, gas: 2_000_000n }), signerPk: s }); // exactly at the cap is fine
});

test("pause stops every agent until resumed", () => {
  const vm = makeVm();
  vm.call("configure", { input: configArgs() });
  vm.call("pause", { input: new Uint8Array([1]) });
  expectPanic(() => vm.call("request_sign", { input: tx(), signerPk: pk(keys[0]) }), "paused");
  vm.call("pause", { input: new Uint8Array([0]) });
  vm.call("request_sign", { input: tx(), signerPk: pk(keys[0]) });
});

test("rejects malformed transactions", () => {
  const vm = makeVm();
  vm.call("configure", { input: configArgs() });
  const s = pk(keys[0]);
  const good = tx();
  expectPanic(() => vm.call("request_sign", { input: good.slice(0, good.length - 5), signerPk: s }), "rlp");
  const legacy = new Uint8Array(good); legacy[0] = 0x01;
  expectPanic(() => vm.call("request_sign", { input: legacy, signerPk: s }), "EIP-1559");
});

console.log(`\n  ${passed} passing`);
