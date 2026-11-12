import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { SealedSwarmAuction, SealedSwarmAuction__factory } from "../types";

// Limits from RULES.md that need many accounts: entries per auction (A4) and members per pool (P1).
describe("SealedSwarmAuction · limits", function () {
  let seller: HardhatEthersSigner;
  let c: SealedSwarmAuction;
  let addr: string;

  before(async function () {
    [seller] = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    const factory = (await ethers.getContractFactory("SealedSwarmAuction")) as SealedSwarmAuction__factory;
    c = (await factory.deploy()) as SealedSwarmAuction;
    addr = await c.getAddress();
  });

  // n fresh funded accounts (the default 20 signers are not enough)
  async function wallets(n: number) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await (await seller.sendTransaction({ to: w.address, value: ethers.parseEther("1") })).wait();
      out.push(w);
    }
    return out;
  }

  it("[A1] an auction lasts from 1 minute to 30 days", async function () {
    await expect(c.createAuction("lot", 59, 0)).to.be.revertedWithCustomError(c, "InvalidDuration");
    await expect(c.createAuction("lot", 30 * 24 * 3600 + 1, 0)).to.be.revertedWithCustomError(c, "InvalidDuration");
    await (await c.createAuction("lot", 60, 0)).wait();
    await (await c.createAuction("lot", 30 * 24 * 3600, 0)).wait();
    expect(await c.auctionCount()).to.eq(2n);
  });

  it("[A4] at most 64 entries per auction; the entry count is public, the amounts are not", async function () {
    this.timeout(600_000);
    await (await c.createAuction("lot", 3600, 0)).wait();
    const id = await c.auctionCount();
    const ws = await wallets(65);
    for (const [i, w] of ws.slice(0, 64).entries()) {
      const e = await fhevm.createEncryptedInput(addr, w.address).add64(10 + i).encrypt();
      await (await c.connect(w).placeBid(id, e.handles[0], e.inputProof)).wait();
    }
    expect((await c.getAuction(id)).bidCount).to.eq(64n);
    const e = await fhevm.createEncryptedInput(addr, ws[64].address).add64(999).encrypt();
    await expect(c.connect(ws[64]).placeBid(id, e.handles[0], e.inputProof)).to.be.revertedWithCustomError(c, "TooManyBids");
  });

  it("[P1] a pool takes at most 16 members", async function () {
    this.timeout(300_000);
    await (await c.createAuction("lot", 3600, 0)).wait();
    const id = await c.auctionCount();
    const ws = await wallets(17);
    let pool = 0n;
    for (const w of ws.slice(0, 16)) {
      const e = await fhevm.createEncryptedInput(addr, w.address).add64(5).encrypt();
      await (await c.connect(w).joinPool(id, pool, e.handles[0], e.inputProof)).wait();
      if (pool === 0n) pool = await c.poolCount(id);
    }
    expect((await c.getPool(id, pool)).members).to.eq(16n);
    const e = await fhevm.createEncryptedInput(addr, ws[16].address).add64(5).encrypt();
    await expect(c.connect(ws[16]).joinPool(id, pool, e.handles[0], e.inputProof)).to.be.revertedWithCustomError(c, "PoolFull");
  });
});
