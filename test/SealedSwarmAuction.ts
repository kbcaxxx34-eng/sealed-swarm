import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { SealedSwarmAuction, SealedSwarmAuction__factory } from "../types";

const DURATION = 3600;

async function deploy() {
  const factory = (await ethers.getContractFactory("SealedSwarmAuction")) as SealedSwarmAuction__factory;
  const c = (await factory.deploy()) as SealedSwarmAuction;
  return { c, addr: await c.getAddress() };
}

async function bid(c: SealedSwarmAuction, addr: string, id: bigint, who: HardhatEthersSigner, value: number) {
  const enc = await fhevm.createEncryptedInput(addr, who.address).add64(value).encrypt();
  return (await c.connect(who).placeBid(id, enc.handles[0], enc.inputProof)).wait();
}

async function endAuction() {
  await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
  await ethers.provider.send("evm_mine", []);
}

async function closeAndReveal(c: SealedSwarmAuction, id: bigint, caller: HardhatEthersSigner) {
  await (await c.connect(caller).close(id)).wait();
  const [winnerHandle, priceHandle] = await c.getResultHandles(id);
  const res = await fhevm.publicDecrypt([winnerHandle, priceHandle]);
  await (await c.connect(caller).reveal(id, res.abiEncodedClearValues, res.decryptionProof)).wait();
  return c.getAuction(id);
}

describe("SealedSwarmAuction", function () {
  let seller: HardhatEthersSigner, a1: HardhatEthersSigner, a2: HardhatEthersSigner, a3: HardhatEthersSigner;
  let c: SealedSwarmAuction;
  let addr: string;

  before(async function () {
    [seller, a1, a2, a3] = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    ({ c, addr } = await deploy());
  });

  async function create(reserve = 0) {
    await (await c.connect(seller).createAuction("GPU hour", DURATION, reserve)).wait();
    return await c.auctionCount();
  }

  it("[A5][A7] highest bidder wins and pays the second-highest bid", async function () {
    const id = await create();
    await bid(c, addr, id, a1, 120);
    await bid(c, addr, id, a2, 300);
    await bid(c, addr, id, a3, 180);
    await endAuction();
    const a = await closeAndReveal(c, id, a1);
    expect(a.winner).to.eq(a2.address);
    expect(a.price).to.eq(180n);
    expect(a.revealed).to.eq(true);
  });

  it("[A5] works regardless of bid order (winner first, runner-up last)", async function () {
    const id = await create();
    await bid(c, addr, id, a1, 500);
    await bid(c, addr, id, a2, 100);
    await bid(c, addr, id, a3, 450);
    await endAuction();
    const a = await closeAndReveal(c, id, seller);
    expect(a.winner).to.eq(a1.address);
    expect(a.price).to.eq(450n);
  });

  it("[A1][A5] price never goes below the public reserve", async function () {
    const id = await create(200);
    await bid(c, addr, id, a1, 250);
    await bid(c, addr, id, a2, 150);
    await endAuction();
    const a = await closeAndReveal(c, id, seller);
    expect(a.winner).to.eq(a1.address);
    expect(a.price).to.eq(200n);
  });

  it("[A5] no sale when every bid is below the reserve", async function () {
    const id = await create(1000);
    await bid(c, addr, id, a1, 900);
    await endAuction();
    const a = await closeAndReveal(c, id, seller);
    expect(a.winner).to.eq(ethers.ZeroAddress);
    expect(a.price).to.eq(0n);
  });

  it("[A5] ties keep the earlier bidder", async function () {
    const id = await create();
    await bid(c, addr, id, a1, 300);
    await bid(c, addr, id, a2, 300);
    await endAuction();
    const a = await closeAndReveal(c, id, seller);
    expect(a.winner).to.eq(a1.address);
    expect(a.price).to.eq(300n);
  });

  it("[A5] a single bidder pays the reserve", async function () {
    const id = await create(50);
    await bid(c, addr, id, a1, 400);
    await endAuction();
    const a = await closeAndReveal(c, id, seller);
    expect(a.winner).to.eq(a1.address);
    expect(a.price).to.eq(50n);
  });

  it("[A3][A6] each bidder can decrypt only its own bid", async function () {
    const id = await create();
    await bid(c, addr, id, a1, 77);
    const h = await c.getBid(id, a1.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, h, addr, a1)).to.eq(77n);
    let failed = false;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint64, h, addr, a2);
    } catch {
      failed = true;
    }
    expect(failed).to.eq(true);
  });

  it("[A2] rejects a second bid from the same address", async function () {
    const id = await create();
    await bid(c, addr, id, a1, 10);
    const enc = await fhevm.createEncryptedInput(addr, a1.address).add64(20).encrypt();
    await expect(c.connect(a1).placeBid(id, enc.handles[0], enc.inputProof)).to.be.revertedWithCustomError(
      c,
      "AlreadyBid",
    );
  });

  it("[A1][A5] rejects bids after the end time and early close", async function () {
    const id = await create();
    await expect(c.close(id)).to.be.revertedWithCustomError(c, "AuctionNotEnded");
    await endAuction();
    const enc = await fhevm.createEncryptedInput(addr, a1.address).add64(20).encrypt();
    await expect(c.connect(a1).placeBid(id, enc.handles[0], enc.inputProof)).to.be.revertedWithCustomError(
      c,
      "AuctionEnded",
    );
  });

  it("[A6] rejects a forged reveal", async function () {
    const id = await create();
    await bid(c, addr, id, a1, 100);
    await bid(c, addr, id, a2, 200);
    await endAuction();
    await (await c.close(id)).wait();
    const [wh, ph] = await c.getResultHandles(id);
    const res = await fhevm.publicDecrypt([wh, ph]);
    const forged = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint64"], [a1.address, 1]);
    await expect(c.reveal(id, forged, res.decryptionProof)).to.be.reverted;
  });

  it("[A6] cannot reveal before close or twice", async function () {
    const id = await create();
    await bid(c, addr, id, a1, 100);
    await expect(c.reveal(id, "0x", "0x")).to.be.revertedWithCustomError(c, "NotClosed");
    await endAuction();
    await closeAndReveal(c, id, seller);
    await expect(c.reveal(id, "0x", "0x")).to.be.revertedWithCustomError(c, "AlreadyRevealed");
  });
});
