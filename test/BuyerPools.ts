import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { SealedSwarmAuction, SealedSwarmAuction__factory } from "../types";

const DURATION = 3600;

describe("SealedSwarmAuction · buyer pools (encrypted group buying)", function () {
  let seller: HardhatEthersSigner, s: HardhatEthersSigner[];
  let c: SealedSwarmAuction;
  let addr: string;

  before(async function () {
    const all = await ethers.getSigners();
    seller = all[0];
    s = all.slice(1, 8);
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    const factory = (await ethers.getContractFactory("SealedSwarmAuction")) as SealedSwarmAuction__factory;
    c = (await factory.deploy()) as SealedSwarmAuction;
    addr = await c.getAddress();
  });

  async function create(reserve = 0) {
    await (await c.connect(seller).createAuction("8x H100, 1 hour", DURATION, reserve)).wait();
    return await c.auctionCount();
  }
  async function enc(who: HardhatEthersSigner, v: number) {
    return fhevm.createEncryptedInput(addr, who.address).add64(v).encrypt();
  }
  async function bid(id: bigint, who: HardhatEthersSigner, v: number) {
    const e = await enc(who, v);
    await (await c.connect(who).placeBid(id, e.handles[0], e.inputProof)).wait();
  }
  async function join(id: bigint, poolId: bigint, who: HardhatEthersSigner, v: number) {
    const e = await enc(who, v);
    await (await c.connect(who).joinPool(id, poolId, e.handles[0], e.inputProof)).wait();
    return poolId === 0n ? await c.poolCount(id) : poolId;
  }
  async function closeAndReveal(id: bigint) {
    await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await c.close(id)).wait();
    const [w, p] = await c.getResultHandles(id);
    const res = await fhevm.publicDecrypt([w, p]);
    await (await c.reveal(id, res.abiEncodedClearValues, res.decryptionProof)).wait();
    return c.getAuction(id);
  }

  it("three small buyers pool their budgets and beat a bigger solo bidder", async function () {
    const id = await create();
    const p = await join(id, 0n, s[0], 40);
    await join(id, p, s[1], 50);
    await join(id, p, s[2], 30); // pool total 120
    await (await c.connect(s[0]).submitPool(id, p)).wait();
    await bid(id, s[3], 100); // solo whale
    const a = await closeAndReveal(id);
    expect(a.winner).to.eq(await c.poolAddress(id, p));
    expect(a.price).to.eq(100n); // pool pays the second price, not its total
  });

  it("each member sees only its own contribution and the pool total, and can compute its share", async function () {
    const id = await create();
    const p = await join(id, 0n, s[0], 40);
    await join(id, p, s[1], 60);
    await (await c.connect(s[0]).submitPool(id, p)).wait();
    await bid(id, s[3], 80);
    const a = await closeAndReveal(id);

    const totalHandle = await c.getPoolTotal(id, p);
    const total = await fhevm.userDecryptEuint(FhevmType.euint64, totalHandle, addr, s[1]);
    const own = await fhevm.userDecryptEuint(FhevmType.euint64, await c.getBid(id, s[1].address), addr, s[1]);
    expect(total).to.eq(100n);
    expect(own).to.eq(60n);
    expect((a.price * own) / total).to.eq(48n); // member 2 pays 60% of the clearing price (80)

    // a member cannot read another member's contribution; an outsider cannot read the total
    let failed = 0;
    try { await fhevm.userDecryptEuint(FhevmType.euint64, await c.getBid(id, s[0].address), addr, s[1]); } catch { failed++; }
    try { await fhevm.userDecryptEuint(FhevmType.euint64, totalHandle, addr, s[3]); } catch { failed++; }
    expect(failed).to.eq(2);
  });

  it("a losing pool just loses: the solo bidder pays the pool total as second price", async function () {
    const id = await create();
    const p = await join(id, 0n, s[0], 10);
    await join(id, p, s[1], 20);
    await (await c.connect(s[0]).submitPool(id, p)).wait();
    await bid(id, s[3], 100);
    const a = await closeAndReveal(id);
    expect(a.winner).to.eq(s[3].address);
    expect(a.price).to.eq(30n);
  });

  it("pools compete with each other", async function () {
    const id = await create();
    const p1 = await join(id, 0n, s[0], 50);
    await join(id, p1, s[1], 50); // 100
    const p2 = await join(id, 0n, s[2], 70);
    await join(id, p2, s[3], 60); // 130
    await (await c.connect(s[0]).submitPool(id, p1)).wait();
    await (await c.connect(s[2]).submitPool(id, p2)).wait();
    const a = await closeAndReveal(id);
    expect(a.winner).to.eq(await c.poolAddress(id, p2));
    expect(a.price).to.eq(100n);
  });

  it("an unsubmitted pool does not count", async function () {
    const id = await create();
    const p = await join(id, 0n, s[0], 500);
    await join(id, p, s[1], 500);
    await bid(id, s[3], 70);
    const a = await closeAndReveal(id);
    expect(a.winner).to.eq(s[3].address);
    expect((await c.getAuction(id)).bidCount).to.eq(1);
  });

  it("enforces the pool rules", async function () {
    const id = await create();
    const p = await join(id, 0n, s[0], 10);
    // a member cannot also bid alone or join twice
    const e = await enc(s[0], 5);
    await expect(c.connect(s[0]).placeBid(id, e.handles[0], e.inputProof)).to.be.revertedWithCustomError(c, "AlreadyBid");
    // only the creator submits, and only once
    await join(id, p, s[1], 10);
    await expect(c.connect(s[1]).submitPool(id, p)).to.be.revertedWithCustomError(c, "NotPoolCreator");
    await (await c.connect(s[0]).submitPool(id, p)).wait();
    await expect(c.connect(s[0]).submitPool(id, p)).to.be.revertedWithCustomError(c, "PoolAlreadySubmitted");
    // no joining after submission, and unknown pools are rejected
    const e2 = await enc(s[2], 5);
    await expect(c.connect(s[2]).joinPool(id, p, e2.handles[0], e2.inputProof)).to.be.revertedWithCustomError(c, "PoolAlreadySubmitted");
    await expect(c.connect(s[2]).joinPool(id, 99n, e2.handles[0], e2.inputProof)).to.be.revertedWithCustomError(c, "UnknownPool");
  });

  it("a pool total saturates instead of wrapping around", async function () {
    const id = await create();
    const max = 2n ** 64n - 1n;
    const e1 = await fhevm.createEncryptedInput(addr, s[0].address).add64(max - 5n).encrypt();
    await (await c.connect(s[0]).joinPool(id, 0n, e1.handles[0], e1.inputProof)).wait();
    const e2 = await fhevm.createEncryptedInput(addr, s[1].address).add64(10n).encrypt();
    await (await c.connect(s[1]).joinPool(id, 1n, e2.handles[0], e2.inputProof)).wait();
    await (await c.connect(s[0]).submitPool(id, 1n)).wait();
    const total = await fhevm.userDecryptEuint(FhevmType.euint64, await c.getPoolTotal(id, 1n), addr, s[0]);
    expect(total).to.eq(max);
  });
});
