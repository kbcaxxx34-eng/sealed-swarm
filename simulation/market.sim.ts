// SealedSwarm market simulation — runs with no wallet, no testnet and no LLM:  npm run simulate
// Optional: NEARAI_API_KEY=sk-... npm run simulate  → agents reason with a TEE-hosted model on
// NEAR AI Cloud (NEARAI_MODEL, default Qwen/Qwen3.6-35B-A3B-FP8); the code still caps every bid.
//
// 5 GPU providers sell compute in sealed-bid second-price auctions. 5 owners each run a SwarmVault
// with 4 buyer agents (20 agents). Agents follow scripted strategies; budget-limited agents form
// encrypted buyer pools. Two agents are "prompt-injected" and try to misuse their keys.
//
// What is real here:
//   - the auction contract runs on Hardhat with Zama's FHE mock (same Solidity as on Sepolia);
//     bids are encrypted, compared and revealed exactly as on-chain
//   - every agent transaction is first checked by the real SwarmVault wasm (the same build that is
//     deployed on NEAR) running on a mocked NEAR host; only approved transactions are sent
// What is mocked:
//   - the NEAR MPC signature: on testnet the vault's call to v1.signer-prod.testnet returns it;
//     here the agent's local key stands in for its MPC-derived address
//
// The run checks every on-chain result against a plaintext computation of the same rules and
// writes simulation/REPORT.md.

import { ethers, fhevm, artifacts } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encodeFunctionData, serializeTransaction, hexToBytes, toHex, parseEther, type Hex } from "viem";
import { SealedSwarmAuction, SealedSwarmAuction__factory } from "../types";

// dynamic ESM import that survives ts-node's CommonJS transpilation
const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;

const DURATION = 3600;
const SEPOLIA = 11155111;
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // native USDC on NEAR
const UNIT = 10_000n; // 1 auction unit = 0.01 USDC (USDC has 6 decimals)

// deterministic pseudo-random numbers, so every run gives the same market
function rng(seed: string) {
  let h = BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed)));
  return () => {
    h = BigInt(ethers.keccak256(ethers.toBeHex(h, 32)));
    return Number(h % 1_000_000n) / 1_000_000;
  };
}

type Strategy = "truthful" | "value-hunter" | "aggressive" | "budget-capped";
interface Agent {
  name: string;
  owner: string;
  account: string; // NEAR sub-account of the vault
  vaultIndex: number;
  wallet: ethers.HDNodeWallet | ethers.Wallet;
  strategy: Strategy;
  budget: number;
  target: number; // lot index
  valuation: number;
  action: "bid" | "pool" | "skip";
  amount: number;
  rogue?: boolean;
}

const LOTS = [
  { item: "8x H100 · 1 hour", estimate: 220, reserve: 150 },
  { item: "4x A100 · 2 hours", estimate: 140, reserve: 90 },
  { item: "8x L40S · 1 hour", estimate: 110, reserve: 70 },
  { item: "8x H200 · 1 hour", estimate: 300, reserve: 220 },
  { item: "16x RTX 6000 · 1 hour", estimate: 90, reserve: 50 },
];
const OWNERS = ["lab", "studio", "quant", "biotech", "indie"];
const NAMES = ["atlas", "nova", "quill", "orion", "vega", "lyra", "rhea", "juno", "kai", "zed",
  "iris", "milo", "nyx", "otto", "pax", "remy", "sol", "tao", "uma", "wren"];
const STRATS: Strategy[] = ["truthful", "value-hunter", "aggressive", "budget-capped"];

describe("SealedSwarm market simulation", function () {
  this.timeout(600_000);

  it("runs 5 GPU auctions with 20 agents from 5 vaults, buyer pools and 2 rogue agents", async function () {
    if (!fhevm.isMock) this.skip();
    const vaultLib = await esmImport(pathToFileURL(path.join(__dirname, "../near-vault/lib/vault-vm.mjs")).href);
    const rand = rng("sealedswarm-sim-v1");
    const [funder] = await ethers.getSigners();

    // ---- contract + sellers
    const factory = (await ethers.getContractFactory("SealedSwarmAuction")) as SealedSwarmAuction__factory;
    const c = (await factory.deploy()) as SealedSwarmAuction;
    const addr = await c.getAddress();
    const abi = (await artifacts.readArtifact("SealedSwarmAuction")).abi;
    const fund = async (a: string) => ethers.provider.send("hardhat_setBalance", [a, toHex(parseEther("10"))]);
    const wallet = async (seed: string) => {
      const w = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(seed)), ethers.provider);
      await fund(w.address);
      return w;
    };
    const sellers = await Promise.all(LOTS.map((_, i) => wallet(`seller-${i}`)));
    for (let i = 0; i < LOTS.length; i++) {
      await (await c.connect(sellers[i]).createAuction(LOTS[i].item, DURATION, LOTS[i].reserve)).wait();
    }

    // ---- 5 owners, each with a SwarmVault and 4 agent sub-accounts
    const agents: Agent[] = [];
    const vaults = OWNERS.map((owner) => {
      const vm = vaultLib.makeVm({ accountId: `vault.${owner}.testnet` });
      return { owner, vm };
    });
    for (let v = 0; v < vaults.length; v++) {
      const names = NAMES.slice(v * 4, v * 4 + 4);
      const cfg = vaultLib.configArgs({
        auction: addr,
        agents: names.map((name, i) => ({ name, publicKey: new Uint8Array(32).fill(v * 4 + i + 1) })),
      });
      const r = vaults[v].vm.call("configure", { input: cfg, predecessor: `${vaults[v].owner}.testnet` });
      expect(r.promises.length).to.eq(4);
      // settlement through NEAR Intents: USDC, sellers allowlisted, per-agent spending limits
      const owner = `${vaults[v].owner}.testnet`;
      vaults[v].vm.call("set_settlement", { input: vaultLib.settlementArgs("intents.near", USDC), predecessor: owner });
      for (let k = 0; k < LOTS.length; k++) vaults[v].vm.call("allow_seller", { input: ethers.toUtf8Bytes(`gpu-seller-${k + 1}.near`), predecessor: owner });
      for (let i = 0; i < 4; i++) {
        const strategy = STRATS[(v + i) % 4];
        const target = Math.floor(rand() * LOTS.length);
        const est = LOTS[target].estimate;
        const budget = strategy === "budget-capped" ? Math.round(est * (0.25 + rand() * 0.25)) : Math.round(est * (1.1 + rand() * 0.6));
        const w = await wallet(`agent-${names[i]}`);
        agents.push({
          name: names[i], owner: vaults[v].owner, account: `${names[i]}.vault.${vaults[v].owner}.testnet`, vaultIndex: v,
          wallet: w, strategy, budget, target, valuation: 0, action: "skip", amount: 0,
        });
      }
    }

    // ---- valuations: scripted strategies by default; NEAR AI Cloud if NEARAI_API_KEY is set
    const key = process.env.NEARAI_API_KEY;
    const model = process.env.NEARAI_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8";
    async function llmValuation(a: Agent, est: number): Promise<number | null> {
      if (!key) return null;
      try {
        const res = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, temperature: 0.4, max_tokens: 300, messages: [
            { role: "system", content: `You are ${a.name}, a ${a.strategy} procurement agent buying GPU compute in a sealed-bid second-price auction, where bidding your true value is optimal. Answer with JSON only: {"valuation": <integer units>}.` },
            { role: "user", content: `Lot: ${LOTS[a.target].item}. Reserve ${LOTS[a.target].reserve}. Market estimate ${est}. Your budget ${a.budget}. Your true value?` },
          ] }),
        });
        const j = await res.json();
        const m = String(j?.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
        const v = m ? Math.round(Number(JSON.parse(m[0]).valuation)) : NaN;
        return Number.isFinite(v) && v > 0 ? Math.min(v, est * 10) : null;
      } catch { return null; }
    }
    let llmCount = 0;
    for (const a of agents) {
      const est = LOTS[a.target].estimate;
      const f = { truthful: 0.95 + rand() * 0.15, "value-hunter": 0.7 + rand() * 0.2, aggressive: 1.0 + rand() * 0.35, "budget-capped": 0.9 + rand() * 0.2 }[a.strategy];
      const llm = await llmValuation(a, est);
      if (llm) llmCount++;
      a.valuation = llm ?? Math.max(1, Math.round(est * f));
      // second-price: bidding the true value is optimal, capped by budget
      a.amount = Math.min(a.valuation, a.budget);
      a.action = a.amount >= LOTS[a.target].reserve ? "bid" : "pool"; // can't reach the reserve alone → pool
    }
    // the owner's spending limit for each agent = its budget, in USDC
    agents.forEach((a, i) => vaults[a.vaultIndex].vm.call("set_budget", { input: vaultLib.budgetArgs(i % 4, BigInt(a.budget) * UNIT), predecessor: `${a.owner}.testnet` }));
    agents[5].rogue = true;
    agents[12].rogue = true;

    // ---- every agent transaction goes through its vault first
    const vaultLog: { agent: string; action: string; ok: boolean; reason: string }[] = [];
    const nonces = new Map<string, number>();
    function vaultCheck(a: Agent, to: string, data: Hex, value = 0n, label = "") {
      const nonce = nonces.get(a.account) ?? 0;
      const unsigned = serializeTransaction({
        type: "eip1559", chainId: SEPOLIA, nonce, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 20_000_000_000n,
        gas: 2_000_000n, to: to as Hex, value, data,
      });
      try {
        const r = vaults[a.vaultIndex].vm.call("request_sign", { input: hexToBytes(unsigned), predecessor: a.account });
        const req = JSON.parse(r.promises[0].args).request;
        nonces.set(a.account, nonce + 1);
        vaultLog.push({ agent: a.account, action: label, ok: true, reason: `MPC sign request, path ${req.path}` });
        return true;
      } catch (e: any) {
        vaultLog.push({ agent: a.account, action: label, ok: false, reason: e.message });
        return false;
      }
    }

    // ---- solo bids
    for (const a of agents.filter((x) => x.action === "bid")) {
      const id = BigInt(a.target + 1);
      const enc = await fhevm.createEncryptedInput(addr, a.wallet.address).add64(a.amount).encrypt();
      const data = encodeFunctionData({ abi, functionName: "placeBid", args: [id, toHex(enc.handles[0]), toHex(enc.inputProof)] });
      if (vaultCheck(a, addr, data, 0n, `placeBid #${id}`)) {
        await (await c.connect(a.wallet).placeBid(id, enc.handles[0], enc.inputProof)).wait();
      }
    }

    // ---- buyer pools: agents that can't reach the reserve alone pool per lot (across owners)
    const pools: { lot: number; poolId: bigint; members: Agent[] }[] = [];
    for (let lot = 0; lot < LOTS.length; lot++) {
      const members = agents.filter((a) => a.action === "pool" && a.target === lot);
      if (members.length < 2) { members.forEach((m) => (m.action = "skip")); continue; }
      const id = BigInt(lot + 1);
      let poolId = 0n;
      for (const m of members) {
        const enc = await fhevm.createEncryptedInput(addr, m.wallet.address).add64(m.amount).encrypt();
        const data = encodeFunctionData({ abi, functionName: "joinPool", args: [id, poolId, toHex(enc.handles[0]), toHex(enc.inputProof)] });
        if (!vaultCheck(m, addr, data, 0n, `joinPool #${id}`)) continue;
        await (await c.connect(m.wallet).joinPool(id, poolId, enc.handles[0], enc.inputProof)).wait();
        if (poolId === 0n) poolId = await c.poolCount(id);
      }
      const creator = members[0];
      const data = encodeFunctionData({ abi, functionName: "submitPool", args: [id, poolId] });
      if (vaultCheck(creator, addr, data, 0n, `submitPool #${id}`)) {
        await (await c.connect(creator.wallet).submitPool(id, poolId)).wait();
        pools.push({ lot, poolId, members });
      }
    }

    // ---- rogue agents (prompt-injected): every attempt must be refused by their vault
    const attacker = "0x000000000000000000000000000000000000dEaD";
    for (const r of agents.filter((a) => a.rogue)) {
      expect(vaultCheck(r, attacker, "0x", parseEther("1"), "send 1 ETH to attacker")).to.eq(false);
      expect(vaultCheck(r, attacker, encodeFunctionData({ abi, functionName: "placeBid", args: [1n, toHex(new Uint8Array(32)), "0x"] }), 0n, "bid on a look-alike contract")).to.eq(false);
      expect(vaultCheck(r, addr, encodeFunctionData({ abi, functionName: "close", args: [1n] }), 0n, "call close() early")).to.eq(false);
      expect(vaultCheck(r, addr, encodeFunctionData({ abi, functionName: "placeBid", args: [BigInt(r.target + 1), toHex(new Uint8Array(32)), "0x"] }), 0n, "bid a second time")).to.eq(r.action === "skip");
    }
    vaults[4].vm.call("pause", { input: new Uint8Array([1]), predecessor: "indie.testnet" });
    const paused = agents.find((a) => a.vaultIndex === 4)!;
    expect(vaultCheck(paused, addr, encodeFunctionData({ abi, functionName: "placeBid", args: [5n, toHex(new Uint8Array(32)), "0x"] }), 0n, "bid while owner paused the vault")).to.eq(false);
    vaults[4].vm.call("pause", { input: new Uint8Array([0]), predecessor: "indie.testnet" }); // owner resumes

    // ---- close and reveal every auction
    await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
    await ethers.provider.send("evm_mine", []);
    const results = [];
    for (let lot = 0; lot < LOTS.length; lot++) {
      const id = BigInt(lot + 1);
      await (await c.connect(funder).close(id)).wait();
      const [w, p] = await c.getResultHandles(id);
      const dec = await fhevm.publicDecrypt([w, p]);
      await (await c.connect(funder).reveal(id, dec.abiEncodedClearValues, dec.decryptionProof)).wait();
      const a = await c.getAuction(id);

      // plaintext reference of the same rules (only possible in a simulation, where we know every bid)
      const entries: { who: string; value: number }[] = [];
      for (const ag of agents.filter((x) => x.action === "bid" && x.target === lot)) entries.push({ who: ag.wallet.address, value: ag.amount });
      for (const pl of pools.filter((x) => x.lot === lot)) entries.push({ who: await c.poolAddress(id, pl.poolId), value: pl.members.reduce((s, m) => s + m.amount, 0) });
      // contract order: solo bids first, then pools; ties keep the earlier entry
      let hi = { who: ethers.ZeroAddress, value: 0 }, second = 0;
      for (const e of entries) {
        if (e.value > hi.value) { second = hi.value; hi = e; } else if (e.value > second) second = e.value;
      }
      const meets = hi.value >= LOTS[lot].reserve;
      const expWinner = meets ? hi.who : ethers.ZeroAddress;
      const expPrice = meets ? Math.max(second, LOTS[lot].reserve) : 0;
      expect(a.winner).to.eq(expWinner);
      expect(Number(a.price)).to.eq(expPrice);

      // pool winners: each member computes its share privately (own contribution + pool total)
      const shares: string[] = [];
      const payments: string[] = [];
      const pay = (ag: Agent, amountUnits: bigint) => {
        const seller = `gpu-seller-${lot + 1}.near`;
        const vm = vaults[ag.vaultIndex].vm;
        const r = vm.call("settle", { input: vaultLib.settleArgs(id, amountUnits, seller), predecessor: ag.account });
        const t = JSON.parse(r.promises[0].args);
        expect(r.promises[0].account).to.eq("intents.near");
        expect(r.promises[0].method).to.eq("mt_transfer");
        vm.call("on_settled", { input: new Uint8Array([agents.filter((x) => x.vaultIndex === ag.vaultIndex).indexOf(ag), ...vaultLib.settleArgs(id, amountUnits, "x").slice(0, 48)]), predecessor: vm.accountId, results: [1] });
        payments.push(`${ag.account} → ${t.receiver_id}: ${(Number(t.amount) / 1e6).toFixed(2)} USDC`);
        vaultLog.push({ agent: ag.account, action: `settle #${id}`, ok: true, reason: `mt_transfer ${t.amount} ${t.token_id.slice(0, 14)}… on intents.near` });
      };
      const pool = pools.find((x) => x.lot === lot && a.winner !== ethers.ZeroAddress);
      if (pool && a.winner === (await c.poolAddress(id, pool.poolId))) {
        const totalH = await c.getPoolTotal(id, pool.poolId);
        for (const m of pool.members) {
          const total = await fhevm.userDecryptEuint(FhevmType.euint64, totalH, addr, m.wallet as any);
          const own = await fhevm.userDecryptEuint(FhevmType.euint64, await c.getBid(id, m.wallet.address), addr, m.wallet as any);
          shares.push(`${m.account} pays ${((Number(a.price) * Number(own)) / Number(total)).toFixed(2)}`);
          pay(m, (a.price * own * UNIT) / total); // each member pays only its share
        }
      }
      const winnerAgent = agents.find((x) => x.wallet.address === a.winner);
      if (winnerAgent) pay(winnerAgent, a.price * UNIT);
      // a loser cannot get paid out: settling an auction it did not win is the owner's policy problem,
      // but a payment to a seller that is not allowlisted is refused by the vault
      if (lot === 0 && winnerAgent) {
        let refused = false;
        try { vaults[winnerAgent.vaultIndex].vm.call("settle", { input: vaultLib.settleArgs(id, 1n, "attacker.near"), predecessor: winnerAgent.account }); }
        catch (e: any) { refused = true; vaultLog.push({ agent: winnerAgent.account, action: "pay a seller that is not allowlisted", ok: false, reason: e.message }); }
        expect(refused).to.eq(true);
      }
      results.push({
        lot, item: LOTS[lot].item, reserve: LOTS[lot].reserve, estimate: LOTS[lot].estimate, bids: Number(a.bidCount),
        winner: a.winner === ethers.ZeroAddress ? "no sale" : winnerAgent ? winnerAgent.account : `pool of ${pool!.members.length} agents`,
        price: Number(a.price), shares, payments,
      });
    }

    // ---- report
    const approved = vaultLog.filter((x) => x.ok).length;
    const refused = vaultLog.filter((x) => !x.ok);
    const lines: string[] = [];
    lines.push("# SealedSwarm market simulation report", "");
    lines.push(key ? `Agent valuations: ${llmCount}/20 from ${model} on NEAR AI Cloud (TEE), the rest scripted.` : "Agent valuations: scripted strategies (no LLM). Set NEARAI_API_KEY to let agents reason on NEAR AI Cloud.", "");
    lines.push("Generated by `npm run simulate` (deterministic seed `sealedswarm-sim-v1`). Hardhat + Zama FHE mock for the auction contract; the real SwarmVault wasm on a mocked NEAR host for every agent transaction; MPC signatures mocked.", "");
    lines.push("## Agents", "", "| Agent (NEAR sub-account) | Strategy | Lot | Budget | Private valuation | Action | Amount |", "|---|---|---|---|---|---|---|");
    for (const a of agents) lines.push(`| ${a.account}${a.rogue ? " ⚠ rogue" : ""} | ${a.strategy} | #${a.target + 1} | ${a.budget} | ${a.valuation} | ${a.action} | ${a.action === "skip" ? "-" : a.amount} |`);
    lines.push("", "Valuations and amounts above are known only because this is a simulation. On-chain, every amount is an FHE ciphertext.", "");
    lines.push("## Auctions (results verified against a plaintext computation of the same rules)", "", "| # | Lot | Reserve | Bids | Winner | Price paid |", "|---|---|---|---|---|---|");
    for (const r of results) lines.push(`| ${r.lot + 1} | ${r.item} | ${r.reserve} | ${r.bids} | ${r.winner} | ${r.price} |`);
    for (const r of results.filter((x) => x.shares.length)) lines.push("", `Auction #${r.lot + 1} was won by a buyer pool. Each member decrypted only its own contribution and the pool total, then computed its share: ${r.shares.join("; ")}.`);
    lines.push("", "## Settlement through NEAR Intents", "", "Each winner (or each pool member, for its share) asks its vault to pay the seller. The vault checks the seller allowlist, that the agent entered the auction, that it has not paid yet and that the amount fits the agent's spending limit, then calls `mt_transfer` on `intents.near` (USDC; 1 unit = 0.01 USDC). On testnet runs this step is simulated: the Intents verifier exists only on mainnet.", "");
    for (const r of results) for (const p of r.payments) lines.push(`- auction #${r.lot + 1}: ${p}`);
    lines.push("", "## Vault decisions", "", `${approved} agent transactions approved and forwarded to the MPC signer; ${refused.length} refused.`, "", "| Agent | Attempt | Vault decision |", "|---|---|---|");
    for (const x of refused) lines.push(`| ${x.agent} | ${x.action} | refused: ${x.reason} |`);
    lines.push("", "## What was public vs private", "", "- Public: lot, reserve, number of bids, winner, price.", "- Private: every bid, every pool contribution, every pool total (members only), every losing bid.", "");
    const out = lines.join("\n");
    fs.writeFileSync(path.join(__dirname, "REPORT.md"), out + "\n");

    console.log("\n" + "─".repeat(78));
    console.log(" SealedSwarm market: 5 GPU auctions · 20 agents · 5 vaults" + (key ? ` · ${llmCount} agents on NEAR AI (${model})` : " · scripted agents"));
    console.log("─".repeat(78));
    for (const r of results) console.log(` #${r.lot + 1} ${r.item.padEnd(22)} reserve ${String(r.reserve).padStart(3)} · ${r.bids} bids → ${r.winner} pays ${r.price}`);
    for (const r of results.filter((x) => x.shares.length)) console.log(`    pool shares (each member computed its own): ${r.shares.join("; ")}`);
    for (const r of results) for (const p of r.payments) console.log(`    💸 #${r.lot + 1} ${p} (NEAR Intents mt_transfer)`);
    console.log(` vault: ${approved} transactions approved, ${refused.length} refused:`);
    for (const x of refused) console.log(`    ✗ ${x.agent}: ${x.action} → ${x.reason}`);
    console.log(" every result matches a plaintext computation of the same rules ✔");
    console.log(" full report: simulation/REPORT.md");
    console.log("─".repeat(78));
  });
});
