# SealedSwarm

**Sealed-bid auctions for AI agent swarms.** One NEAR account runs a swarm of bidding agents on Ethereum through **NEAR Chain Signatures**: no Ethereum private key exists anywhere. Every bid is encrypted with **Zama FHE** and compared on-chain without ever being decrypted. Auctions are second-price (Vickrey), so bidding your true value is the best strategy. When an auction closes, only two values are revealed: the winner and the price.

Built at **NEAR HACKATHON 2026** · tracks: **AI Swarms**, **Privacy & Private AI** · testnet prototype, not audited.

- Live demo: https://sealedbid.lercomigo.space/swarm/
- Contract (Sepolia): [`0x2B5a1C37967FC1612EE075d2516c3ACa7b543b05`](https://sepolia.etherscan.io/address/0x2B5a1C37967FC1612EE075d2516c3ACa7b543b05)
- NEAR MPC signer (testnet): `v1.signer-prod.testnet`

## The problem

Agents are starting to buy compute, data and API access from each other. On a public chain, bids are visible: whoever bids last sees everyone else's price, and an agent's bid leaks its strategy and its budget. Today's fixes ask you to trust someone: a commit-reveal scheme still exposes every bid at reveal time, and sealed-bid systems built on secure hardware (TEEs) ask you to trust the chip vendor and the operator.

## What SealedSwarm does

1. **One NEAR account, many bidders.** Each agent (Atlas, Nova, Quill) is an Ethereum address derived from your NEAR account plus its own path (`sealedswarm-agent-1`, `-2`, `-3`). Nobody holds those keys. The NEAR MPC network signs for an agent only when your account asks.
2. **Bids are encrypted in the browser** with Zama FHE, bound to the contract and to the agent's address.
3. **One approval signs the whole swarm.** The three bid transactions are signed by NEAR Chain Signatures in a single Meteor Wallet approval and broadcast to Sepolia.
4. **The contract compares ciphertexts.** It keeps the highest bid, the second-highest bid and the leader, all encrypted. Nobody, including the seller and the contract owner, can read a bid.
5. **Close and reveal.** Closing computes the result under encryption and marks only the winner and the price as publicly decryptable. Anyone can then publish the result with the Zama KMS proof, which the contract verifies on-chain. Losing bids are never revealed.

## Proof it works (Sepolia + NEAR testnet, 5 Nov 2026)

| Step | Transaction |
|---|---|
| Three agents' sealed bids in one approval (auction #2) | [Atlas](https://sepolia.etherscan.io/tx/0xc597c5f195758d90c11dc6c00b03024f30b70caa793953d5cc67b8d6ae695788) · [Nova](https://sepolia.etherscan.io/tx/0xdd681d4092f4f3984a9df019b37f6c83adfe0c5ca757e5bbfd80095541e9ea67) · [Quill](https://sepolia.etherscan.io/tx/0x031b3419e5c807945c618d15eb9b0d9320ee8ee09c14f66042e00ddad1ddcb6d) |
| Close auction #2 | [0x07ca57f3…](https://sepolia.etherscan.io/tx/0x07ca57f3f38a1eca97c90de66c11430f0b612093eb07d660b527b1fc47b2695e) |
| Reveal #2: Nova wins and pays 85 (the second price), verified by Zama KMS signatures | [0x954301fb…](https://sepolia.etherscan.io/tx/0x954301fb7202fd1688f9110feacff497e7187d12c9dcf561365c8096ee55773e) |

## How it works

```
 NEAR account (anderssonm.testnet)
   │  derive(path)  ──►  agent addresses on Ethereum (no private keys)
   │
   │  1 Meteor approval: sign([payload₁, payload₂, payload₃])
   ▼
 v1.signer-prod.testnet (NEAR MPC network) ──► ECDSA signatures
                                                    │
 Browser: Zama FHE encrypts each bid ───────────────┤
                                                    ▼
 Sepolia: SealedSwarmAuction.placeBid(encryptedBid, proof)   × 3
          gt / select / max on ciphertexts → highest, second, leader (encrypted)
          close()  → makePubliclyDecryptable(winner, price)
          reveal() → FHE.checkSignatures(KMS proof) → winner + price in clear
```

**NEAR's role.** NEAR is what makes a swarm practical: one account controls any number of agent addresses, the agents never hold keys that can leak, and one approval authorizes a whole round of bids. The NEAR integration (key derivation, batched MPC signature requests, signature assembly and broadcast) is in [`app/src/main.js`](app/src/main.js).

**Zama's role.** Bids are encrypted end to end and compared with homomorphic operations (`FHE.gt`, `FHE.select`, `FHE.max`, `FHE.ge`). The contract is [`contracts/SealedSwarmAuction.sol`](contracts/SealedSwarmAuction.sol).

**Auction rules.** Second-price with a public reserve. The highest bidder wins and pays the higher of the second-highest bid and the reserve. If no bid reaches the reserve, there is no sale. Ties go to the earlier bidder. One bid per address, up to 64 bids per auction.

**Agents.** Each agent appraises the lot against a market estimate using its own strategy and budget (Atlas: value hunter, Nova: aggressive, Quill: budget-capped). In this prototype the strategies are deterministic rules that run in the browser, not an LLM. Because the auction is second-price, each agent bids its true valuation, capped by its budget.

## Run it

Requirements: Node 20+.

```bash
npm install
npx hardhat test          # 11 tests on the Zama FHE mock
```

Front end:

```bash
cd app
npm install
npm run dev               # needs COOP/COEP headers (set in vite.config.js)
```

To use it you need the Meteor Wallet extension on **testnet** with a funded `.testnet` account ([faucet](https://docs.near.org/getting-started/faucet)) and MetaMask on Sepolia with a little test ETH. In the app: connect Meteor → deploy or reuse the contract → fund the agents → create an auction → *Agents appraise* → *Encrypt & bid* → wait for the end time → *Close* → *Decrypt winner & price*.

Deploy the contract from the command line (optional):

```bash
npx hardhat vars set MNEMONIC
npx hardhat vars set INFURA_API_KEY
npx hardhat deploy --network sepolia
```

## Tests

`test/SealedSwarmAuction.ts` covers: winner pays the second price, bid order independence, reserve floor, no sale below reserve, ties, single bidder, each bidder can decrypt only its own bid, one bid per address, no bids after the end, no early close, forged reveal rejected, reveal only once and only after close.

## Limitations

- Testnet prototype; not audited.
- No payment escrow: the contract decides the winner and the price but does not move funds. Settlement (for example a confidential token transfer) is the next step.
- The number of bids per auction is public; the values are not.
- Agent strategies are simple deterministic rules, not an LLM.
- Seller actions (deploy, create, close, reveal) use MetaMask in the demo; any account can call `close` and `reveal`.

## Prior work and what was built for the hackathon

- Everything in this repository was written during NEAR HACKATHON (from 19 Oct 2026), in this repo's history.
- Earlier, on 3 Nov 2026, the author built **SealedBid**, a single-auction FHE study project (first-price, one bidder per wallet, owner-only decryption) at sealedbid.lercomigo.space. SealedSwarm does not reuse its code: the contract, the second-price logic, the public reveal and the NEAR swarm are new.
- The Hardhat setup comes from Zama's [`fhevm-hardhat-template`](https://github.com/zama-ai/fhevm-hardhat-template) (BSD-3-Clause-Clear).

## Libraries

`@fhevm/solidity`, `@fhevm/hardhat-plugin`, `@zama-fhe/relayer-sdk` (Zama) · `chainsig.js`, `@near-wallet-selector/core`, `@near-wallet-selector/meteor-wallet`, `@near-js/transactions`, `@near-js/utils` (NEAR) · `viem`, `ethers`, `hardhat`, `vite`, `vite-plugin-node-polyfills`.

Built with AI pair-programming assistance (Claude).

## License

MIT for the code in `contracts/`, `test/`, `deploy/` and `app/` (see [LICENSE](LICENSE); template license in [LICENSE-zama-template](LICENSE-zama-template)). Files from the Zama template keep their BSD-3-Clause-Clear license.
