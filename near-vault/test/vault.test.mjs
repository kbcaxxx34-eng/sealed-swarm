// Runs the compiled SwarmVault wasm against a mock of the NEAR host API.
// Checks the policy logic: agent sub-accounts, transaction decoding and every rejection path.
import fs from "node:fs";
import assert from "node:assert/strict";
import { keccak256, serializeTransaction, encodeFunctionData, hexToBytes } from "viem";
import { makeVm, configArgs, Panic, settlementArgs, budgetArgs, settleArgs } from "../lib/vault-vm.mjs";

const abi = JSON.parse(fs.readFileSync(new URL("../../app/src/contract.json", import.meta.url), "utf8")).abi;

const VAULT = "vault.owner.testnet";
const AUCTION = "0x2B5a1C37967FC1612EE075d2516c3ACa7b543b05";
const AGENTS = ["atlas", "nova", "quill"].map((name, i) => ({ name, publicKey: new Uint8Array(32).fill(i + 1) }));
const acct = (i) => `${AGENTS[i].name}.${VAULT}`;
const QUARTER_NEAR = 250_000_000_000_000_000_000_000n;

function setup(opts = {}) {
  const vm = makeVm({ accountId: VAULT });
  const r = vm.call("configure", { input: configArgs({ auction: AUCTION, agents: AGENTS, ...opts }) });
  return { vm, r };
}

const id32 = (n) => "0x" + n.toString(16).padStart(64, "0");
function tx({ to = AUCTION, chainId = 11155111, value = 0n, auctionId = 1n, maxFeePerGas = 2_000_000_000n, gas = 1_000_000n, data, fn = "placeBid" } = {}) {
  if (!data) {
    const args = fn === "placeBid" ? [auctionId, "0x" + "ab".repeat(32), "0x" + "cd".repeat(100)]
      : fn === "joinPool" ? [auctionId, 0n, "0x" + "ab".repeat(32), "0x" + "cd".repeat(100)]
      : [auctionId, 1n];
    data = encodeFunctionData({ abi, functionName: fn, args });
  }
  return hexToBytes(serializeTransaction({ type: "eip1559", chainId, nonce: 3, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas, gas, to, value, data }));
}

function expectPanic(fn, text) {
  assert.throws(fn, (e) => e instanceof Panic && e.message.includes(text), `expected panic containing "${text}"`);
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ✔ " + name); }

console.log("SwarmVault (wasm, mocked NEAR host)");

test("configure creates one funded sub-account per agent with a key that can only call request_sign and settle", () => {
  const { vm, r } = setup();
  assert.equal(r.promises.length, 3);
  r.promises.forEach((p, i) => {
    assert.equal(p.kind, "batch");
    assert.equal(p.account, acct(i));
    assert.deepEqual(p.actions.map((a) => a.type), ["CreateAccount", "Transfer", "AddKey"]);
    assert.equal(p.actions[1].amount, QUARTER_NEAR);
    const k = p.actions[2];
    assert.equal(k.receiver, VAULT);
    assert.equal(k.methods, "request_sign,settle");
    assert.equal(k.allowance, 0n); // unlimited allowance; the 0.25 NEAR balance is the cap
    assert.equal(k.publicKey[0], 0); // ed25519
    assert.deepEqual([...k.publicKey.slice(1)], [...AGENTS[i].publicKey]);
  });
  const cfg = JSON.parse(vm.call("get_config").ret);
  assert.equal(cfg.owner, "owner.testnet");
  assert.equal(cfg.auction, AUCTION.toLowerCase());
  assert.deepEqual(cfg.agent_accounts, [0, 1, 2].map(acct));
  assert.equal(cfg.paused, false);
});

test("configure runs once; only the owner can pause; agent names are checked", () => {
  const { vm } = setup();
  expectPanic(() => vm.call("configure", { input: configArgs({ auction: AUCTION, agents: AGENTS }), predecessor: "mallory.testnet" }), "already configured");
  expectPanic(() => vm.call("pause", { input: new Uint8Array([1]), predecessor: "mallory.testnet" }), "only the owner");
  expectPanic(() => makeVm({ accountId: VAULT }).call("configure", { input: configArgs({ auction: AUCTION, agents: [{ name: "Bad.Name", publicKey: new Uint8Array(32) }] }) }), "a-z and 0-9");
});

test("a valid bid from an agent sub-account is sent to the MPC signer with that agent's path", () => {
  const { vm } = setup();
  const t = tx();
  const r = vm.call("request_sign", { input: t, predecessor: acct(1) });
  assert.equal(r.promises.length, 1);
  const p = r.promises[0];
  assert.equal(p.account, "v1.signer-prod.testnet");
  assert.equal(p.method, "sign");
  assert.equal(p.amount, 1n);
  const args = JSON.parse(p.args);
  assert.equal(args.request.path, "sealedswarm-agent-2");
  assert.equal(args.request.domain_id, 0);
  assert.equal("0x" + args.request.payload_v2.Ecdsa, keccak256(t));
});

test("each agent enters an auction once, but can enter many auctions", () => {
  const { vm } = setup();
  vm.call("request_sign", { input: tx({ auctionId: 7n }), predecessor: acct(0) });
  expectPanic(() => vm.call("request_sign", { input: tx({ auctionId: 7n }), predecessor: acct(0) }), "already bid");
  expectPanic(() => vm.call("request_sign", { input: tx({ auctionId: 7n, fn: "joinPool" }), predecessor: acct(0) }), "already bid");
  vm.call("request_sign", { input: tx({ auctionId: 7n }), predecessor: acct(2) });
  vm.call("request_sign", { input: tx({ auctionId: 8n }), predecessor: acct(0) });
  assert.equal(vm.call("has_bid", { input: new Uint8Array([0, ...hexToBytes(id32(7n))]) }).ret, "true");
  assert.equal(vm.call("has_bid", { input: new Uint8Array([1, ...hexToBytes(id32(7n))]) }).ret, "false");
});

test("pool flow: join once, submit only after joining, submit once", () => {
  const { vm } = setup();
  expectPanic(() => vm.call("request_sign", { input: tx({ auctionId: 3n, fn: "submitPool" }), predecessor: acct(0) }), "has not joined");
  vm.call("request_sign", { input: tx({ auctionId: 3n, fn: "joinPool" }), predecessor: acct(0) });
  vm.call("request_sign", { input: tx({ auctionId: 3n, fn: "joinPool" }), predecessor: acct(1) });
  const r = vm.call("request_sign", { input: tx({ auctionId: 3n, fn: "submitPool" }), predecessor: acct(0) });
  assert.ok(r.logs.some((l) => l.includes("submitPool")));
  expectPanic(() => vm.call("request_sign", { input: tx({ auctionId: 3n, fn: "submitPool" }), predecessor: acct(0) }), "already submitted");
});

test("an agent that bid alone cannot submit a pool (found by the fuzz test)", () => {
  const { vm } = setup();
  vm.call("request_sign", { input: tx({ auctionId: 5n }), predecessor: acct(0) }); // solo bid
  expectPanic(() => vm.call("request_sign", { input: tx({ auctionId: 5n, fn: "submitPool" }), predecessor: acct(0) }), "has not joined");
});

test("rejects callers that are not this vault's agents (including the owner)", () => {
  const { vm } = setup();
  expectPanic(() => vm.call("request_sign", { input: tx(), predecessor: "mallory.testnet" }), "not one of this vault's agents");
  expectPanic(() => vm.call("request_sign", { input: tx(), predecessor: "owner.testnet" }), "not one of this vault's agents");
  expectPanic(() => vm.call("request_sign", { input: tx(), predecessor: "atlas.vault.mallory.testnet" }), "not one of this vault's agents");
});

test("rejects other contracts, chains, ETH value and functions (prompt-injection attempts)", () => {
  const { vm } = setup();
  const s = acct(0);
  expectPanic(() => vm.call("request_sign", { input: tx({ to: "0x000000000000000000000000000000000000dEaD" }), predecessor: s }), "approved auction");
  expectPanic(() => vm.call("request_sign", { input: tx({ chainId: 1 }), predecessor: s }), "Sepolia only");
  expectPanic(() => vm.call("request_sign", { input: tx({ value: 1n }), predecessor: s }), "cannot send ETH");
  const close = encodeFunctionData({ abi, functionName: "close", args: [1n] });
  expectPanic(() => vm.call("request_sign", { input: tx({ data: close }), predecessor: s }), "only placeBid, joinPool and submitPool");
  expectPanic(() => vm.call("request_sign", { input: tx({ data: "0x" }), predecessor: s }), "only placeBid, joinPool and submitPool");
});

test("enforces the owner's gas caps", () => {
  const { vm } = setup({ maxFee: 10_000_000_000n, maxGas: 2_000_000n });
  const s = acct(0);
  expectPanic(() => vm.call("request_sign", { input: tx({ maxFeePerGas: 10_000_000_001n }), predecessor: s }), "max fee");
  expectPanic(() => vm.call("request_sign", { input: tx({ gas: 2_000_001n }), predecessor: s }), "gas limit");
  vm.call("request_sign", { input: tx({ maxFeePerGas: 10_000_000_000n, gas: 2_000_000n }), predecessor: s }); // exactly at the cap is fine
});

test("pause stops every agent until resumed", () => {
  const { vm } = setup();
  vm.call("pause", { input: new Uint8Array([1]) });
  expectPanic(() => vm.call("request_sign", { input: tx(), predecessor: acct(0) }), "paused");
  vm.call("pause", { input: new Uint8Array([0]) });
  vm.call("request_sign", { input: tx(), predecessor: acct(0) });
});

test("rejects malformed transactions", () => {
  const { vm } = setup();
  const s = acct(0);
  const good = tx();
  expectPanic(() => vm.call("request_sign", { input: good.slice(0, good.length - 5), predecessor: s }), "rlp");
  const legacy = new Uint8Array(good); legacy[0] = 0x01;
  expectPanic(() => vm.call("request_sign", { input: legacy, predecessor: s }), "EIP-1559");
});

test("self-configured vault (temporary key, deleted at setup): owner named in the arguments", () => {
  const vm = makeVm({ accountId: VAULT });
  expectPanic(() => vm.call("configure", { input: configArgs({ auction: AUCTION, agents: AGENTS }), predecessor: VAULT }), "needs an owner");
  vm.call("configure", { input: configArgs({ auction: AUCTION, agents: AGENTS, owner: "alice.testnet" }), predecessor: VAULT });
  assert.equal(JSON.parse(vm.call("get_config").ret).owner, "alice.testnet");
  vm.call("pause", { input: new Uint8Array([1]), predecessor: "alice.testnet" });
  expectPanic(() => vm.call("pause", { input: new Uint8Array([1]), predecessor: "mallory.testnet" }), "only the owner");
  // an outside caller cannot smuggle an owner field
  expectPanic(() => makeVm({ accountId: VAULT }).call("configure", { input: configArgs({ auction: AUCTION, agents: AGENTS, owner: "mallory.testnet" }), predecessor: "owner.testnet" }), "trailing");
});

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
function settlementSetup() {
  const { vm } = setup();
  vm.call("set_settlement", { input: settlementArgs("intents.near", USDC) });
  vm.call("allow_seller", { input: new TextEncoder().encode("gpu-seller.near") });
  vm.call("set_budget", { input: budgetArgs(0, 1_000_000n) }); // atlas: 1 USDC
  vm.call("request_sign", { input: tx({ auctionId: 4n }), predecessor: acct(0) }); // atlas entered auction 4
  return vm;
}

test("settlement: an agent pays an allowed seller through NEAR Intents, within its budget", () => {
  const vm = settlementSetup();
  const r = vm.call("settle", { input: settleArgs(4n, 250_000n, "gpu-seller.near"), predecessor: acct(0) });
  const [transfer, then] = r.promises;
  assert.equal(transfer.account, "intents.near");
  assert.equal(transfer.method, "mt_transfer");
  assert.equal(transfer.amount, 1n);
  const args = JSON.parse(transfer.args);
  assert.equal(args.receiver_id, "gpu-seller.near");
  assert.equal(args.token_id, "nep141:" + USDC);
  assert.equal(args.amount, "250000");
  assert.ok(args.memo.includes("agent 1"));
  assert.equal(then.kind, "then");
  assert.equal(then.account, VAULT);
  assert.equal(then.method, "on_settled");
  assert.equal(vm.call("get_budget", { input: new Uint8Array([0]) }).ret, "750000");
  assert.equal(JSON.parse(vm.call("get_config").ret).settlement_token, USDC);
});

test("settlement: refuses unknown sellers, other auctions, double payment, over-budget and non-agents", () => {
  const vm = settlementSetup();
  expectPanic(() => vm.call("settle", { input: settleArgs(4n, 1n, "attacker.near"), predecessor: acct(0) }), "allowlist");
  expectPanic(() => vm.call("settle", { input: settleArgs(5n, 1n, "gpu-seller.near"), predecessor: acct(0) }), "did not enter");
  expectPanic(() => vm.call("settle", { input: settleArgs(4n, 1_000_001n, "gpu-seller.near"), predecessor: acct(0) }), "exceeds");
  expectPanic(() => vm.call("settle", { input: settleArgs(4n, 0n, "gpu-seller.near"), predecessor: acct(0) }), "positive");
  expectPanic(() => vm.call("settle", { input: settleArgs(4n, 5n, "gpu-seller.near"), predecessor: "owner.testnet" }), "not one of this vault's agents");
  vm.call("settle", { input: settleArgs(4n, 5n, "gpu-seller.near"), predecessor: acct(0) });
  expectPanic(() => vm.call("settle", { input: settleArgs(4n, 5n, "gpu-seller.near"), predecessor: acct(0) }), "already paid");
  expectPanic(() => vm.call("set_budget", { input: budgetArgs(0, 9n), predecessor: acct(0) }), "only the owner");
  expectPanic(() => vm.call("allow_seller", { input: new TextEncoder().encode("attacker.near"), predecessor: acct(0) }), "only the owner");
});

test("settlement: a failed transfer restores the budget and allows a retry; the callback is private", () => {
  const vm = settlementSetup();
  vm.call("settle", { input: settleArgs(4n, 400_000n, "gpu-seller.near"), predecessor: acct(0) });
  const cb = new Uint8Array([0, ...settleArgs(4n, 400_000n, "x").slice(0, 48)]);
  expectPanic(() => vm.call("on_settled", { input: cb, predecessor: acct(0), results: [2] }), "private callback");
  const r = vm.call("on_settled", { input: cb, predecessor: VAULT, results: [2] });
  assert.equal(r.ret, "false");
  assert.equal(vm.call("get_budget", { input: new Uint8Array([0]) }).ret, "1000000");
  vm.call("settle", { input: settleArgs(4n, 400_000n, "gpu-seller.near"), predecessor: acct(0) }); // retry works
  assert.equal(vm.call("on_settled", { input: cb, predecessor: VAULT, results: [1] }).ret, "true");
  assert.equal(vm.call("get_budget", { input: new Uint8Array([0]) }).ret, "600000");
});

test("settlement on testnet: with the token as both accounts the vault pays with NEP-141 ft_transfer (wrap.testnet)", () => {
  const { vm } = setup();
  vm.call("set_settlement", { input: settlementArgs("wrap.testnet", "wrap.testnet") });
  vm.call("allow_seller", { input: new TextEncoder().encode("gpus.seller.testnet") });
  vm.call("set_budget", { input: budgetArgs(1, 5_000_000_000_000_000_000_000n) }); // nova: 0.005 wNEAR
  vm.call("request_sign", { input: tx({ auctionId: 9n }), predecessor: acct(1) }); // nova entered auction 9
  const r = vm.call("settle", { input: settleArgs(9n, 2_090_000_000_000_000_000_000n, "gpus.seller.testnet"), predecessor: acct(1) });
  const [transfer, then] = r.promises;
  assert.equal(transfer.account, "wrap.testnet");
  assert.equal(transfer.method, "ft_transfer");
  assert.equal(transfer.amount, 1n); // 1 yoctoNEAR, required by NEP-141
  const args = JSON.parse(transfer.args);
  assert.deepEqual(Object.keys(args), ["receiver_id", "amount", "memo"]);
  assert.equal(args.receiver_id, "gpus.seller.testnet");
  assert.equal(args.amount, "2090000000000000000000");
  assert.ok(args.memo.includes("0x" + "0".repeat(63) + "9") && args.memo.includes("agent 2"));
  assert.equal(then.method, "on_settled");
  assert.equal(vm.call("get_budget", { input: new Uint8Array([1]) }).ret, "2910000000000000000000");
  expectPanic(() => vm.call("settle", { input: settleArgs(9n, 1n, "gpus.seller.testnet"), predecessor: acct(1) }), "already paid");
  expectPanic(() => vm.call("settle", { input: settleArgs(9n, 1n, "gpus.seller.testnet"), predecessor: acct(0) }), "did not enter");
});

test("owner can point the vault at the mainnet MPC signer", () => {
  const { vm } = setup();
  vm.call("set_mpc", { input: new TextEncoder().encode("v1.signer") });
  const r = vm.call("request_sign", { input: tx(), predecessor: acct(0) });
  assert.equal(r.promises[0].account, "v1.signer");
  expectPanic(() => vm.call("set_mpc", { input: new TextEncoder().encode("evil.near"), predecessor: acct(0) }), "only the owner");
});

console.log(`\n  ${passed} passing`);
