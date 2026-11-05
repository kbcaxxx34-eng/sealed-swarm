# SealedSwarm

**Sealed-bid auctions for AI agent swarms.** A NEAR smart contract (the *swarm vault*) runs a swarm of bidding agents on Ethereum through **NEAR Chain Signatures**: no Ethereum private key exists anywhere, agents bid on their own without wallet pop-ups, and the vault refuses to sign anything outside the owner's policy, so a compromised agent cannot steal funds. Every bid is encrypted with **Zama FHE** and compared on-chain without ever being decrypted. Auctions are second-price (Vickrey), so bidding your true value is the best strategy. When an auction closes, only two values are revealed: the winner and the price.

Built at **NEAR HACKATHON 2026** · tracks: **AI Swarms**, **Privacy & Private AI** · testnet prototype, not audited.

- Live demo: https://sealedbid.lercomigo.space/swarm/
- Contract (Sepolia): [`0x2B5a1C37967FC1612EE075d2516c3ACa7b543b05`](https://sepolia.etherscan.io/address/0x2B5a1C37967FC1612EE075d2516c3ACa7b543b05)
- NEAR MPC signer (testnet): `v1.signer-prod.testnet`
- NEAR swarm vault: [`near-vault/assembly/index.ts`](near-vault/assembly/index.ts), deployed per user at `vault.<your-account>.testnet`

## The problem

Agents are starting to buy compute, data and API access from each other. On a public chain, bids are visible: whoever bids last sees everyone else's price, and an agent's bid leaks its strategy and its budget. Today's fixes ask you to trust someone: a commit-reveal scheme still exposes every bid at reveal time, and sealed-bid systems built on secure hardware (TEEs) ask you to trust the chip vendor and the operator.

## What SealedSwarm does

1. **A vault on NEAR owns the swarm.** With one Meteor approval you create `vault.<you>.testnet`, set a policy (which auction contract, which function, gas and fee caps) and give each agent (Atlas, Nova, Quill) a NEAR key that can call only `request_sign` on the vault. Each agent's Ethereum address is derived from the vault account plus its own path (`sealedswarm-agent-1`, `-2`, `-3`). Nobody holds those Ethereum keys.
2. **Bids are encrypted in the browser** with Zama FHE, bound to the contract and to the agent's address.
3. **Agents bid on their own.** Each agent sends its unsigned Ethereum transaction to the vault. The vault decodes it on-chain and checks it against the policy: Sepolia chain id, the approved auction contract, the `placeBid` function only, zero ETH value, gas and fee caps, one bid per agent per auction, vault not paused. Only then does it ask the NEAR MPC network to sign. No wallet pop-up per bid.
4. **A compromised agent can't do damage.** If an agent is prompt-injected and tries to send ETH elsewhere, call another contract or bid twice, the vault panics and nothing is signed. The owner can pause the whole swarm with one transaction. The app has a *Simulate a compromised agent* button that shows this on testnet.
5. **The contract compares ciphertexts.** It keeps the highest bid, the second-highest bid and the leader, all encrypted. Nobody, including the seller and the contract owner, can read a bid.
6. **Close and reveal.** Closing computes the result under encryption and marks only the winner and the price as publicly decryptable. Anyone can then publish the result with the Zama KMS proof, which the contract verifies on-chain. Losing bids are never revealed.

## Proof it works (Sepolia + NEAR testnet, 5 Nov 2026)

| Step | Transaction |
|---|---|
| Three agents' sealed bids in one approval (auction #2) | [Atlas](https://sepolia.etherscan.io/tx/0xc597c5f195758d90c11dc6c00b03024f30b70caa793953d5cc67b8d6ae695788) · [Nova](https://sepolia.etherscan.io/tx/0xdd681d4092f4f3984a9df019b37f6c83adfe0c5ca757e5bbfd80095541e9ea67) · [Quill](https://sepolia.etherscan.io/tx/0x031b3419e5c807945c618d15eb9b0d9320ee8ee09c14f66042e00ddad1ddcb6d) |
| Close auction #2 | [0x07ca57f3…](https://sepolia.etherscan.io/tx/0x07ca57f3f38a1eca97c90de66c11430f0b612093eb07d660b527b1fc47b2695e) |
| Reveal #2: Nova wins and pays 85 (the second price), verified by Zama KMS signatures | [0x954301fb…](https://sepolia.etherscan.io/tx/0x954301fb7202fd1688f9110feacff497e7187d12c9dcf561365c8096ee55773e) |

These first runs used one Meteor approval for the whole swarm. The vault flow (agents signing through `vault.<account>.testnet` with no pop-ups) replaces it; its transactions will be added here.

## How it works

```
 Owner (anderssonm.testnet) ── 1 Meteor approval ──► vault.anderssonm.testnet
   │   policy: auction 0x2B5a…, placeBid only, 0 ETH, gas/fee caps, pause switch
   │   3 agent keys: may call only vault.request_sign
   ▼
 Agent (Atlas / Nova / Quill) ── request_sign(unsigned EIP-1559 tx) ──► vault
   vault: RLP-decode, check policy, one bid per agent per auction
     ok  ──► v1.signer-prod.testnet (NEAR MPC) ──► ECDSA signature ──► Sepolia
     bad ──► panic, nothing signed
                                                    │
 Browser: Zama FHE encrypts each bid ───────────────┤
                                                    ▼
 Sepolia: SealedSwarmAuction.placeBid(encryptedBid, proof)   × 3
          gt / select / max on ciphertexts → highest, second, leader (encrypted)
          close()  → makePubliclyDecryptable(winner, price)
          reveal() → FHE.checkSignatures(KMS proof) → winner + price in clear
```

**NEAR's role.** NEAR is what makes a swarm safe to run: a contract account controls any number of agent addresses, agents never hold keys that can leak, function-call access keys let each agent act alone but only through the vault, and the vault enforces the owner's rules before the MPC network signs anything. The vault contract is [`near-vault/assembly/index.ts`](near-vault/assembly/index.ts) (AssemblyScript on the raw NEAR host API, 13 KB of Wasm). The app side (vault creation, agent keys, signing agent transactions, signature assembly and broadcast) is in [`app/src/main.js`](app/src/main.js).

**Zama's role.** Bids are encrypted end to end and compared with homomorphic operations (`FHE.gt`, `FHE.select`, `FHE.max`, `FHE.ge`). The contract is [`contracts/SealedSwarmAuction.sol`](contracts/SealedSwarmAuction.sol).

**Auction rules.** Second-price with a public reserve. The highest bidder wins and pays the higher of the second-highest bid and the reserve. If no bid reaches the reserve, there is no sale. Ties go to the earlier bidder. One bid per address, up to 64 bids per auction.

**Agents.** Each agent (Atlas: value hunter, Nova: aggressive, Quill: budget-capped) appraises the lot. With a NEAR AI Cloud API key, each agent reasons with an open model running inside a TEE on NEAR AI Cloud (Qwen3.6, DeepSeek V4.1 Flash or GLM 5.3 Flash, all attested), so its strategy and valuation stay private end to end: private inference in a TEE, then an FHE-encrypted bid on-chain. The model only *proposes* a valuation: code caps the bid at the agent's budget, and the vault caps what can ever be signed. Without a key, agents fall back to deterministic rule-based strategies. Because the auction is second-price, each agent bids its true valuation.

**Use case: buying GPU hours.** Default lot: *"GPU hour"*. Picture a swarm of agents procuring compute for their owners: each one has its own budget and urgency, none should reveal its willingness to pay to competing agents or to the provider, and the provider should get a fair market price. SealedSwarm gives the provider a truthful second-price auction and gives every agent privacy for its bid and a hard spending policy on NEAR.

## Run it

Requirements: Node 20+.

```bash
npm install
npx hardhat test          # 11 tests on the Zama FHE mock
npm run test:all          # auction tests + vault tests
```

Front end:

```bash
cd app
npm install
npm run dev               # needs COOP/COEP headers (set in vite.config.js)
```

To use it you need the Meteor Wallet extension on **testnet** with a funded `.testnet` account ([faucet](https://docs.near.org/getting-started/faucet)) and MetaMask on Sepolia with a little test ETH. In the app: connect Meteor → *Create vault* (one approval) → fund the agents → create an auction → *Agents appraise* → *Encrypt & bid* → wait for the end time → *Close* → *Decrypt winner & price*.

Deploy the contract from the command line (optional):

```bash
npx hardhat vars set MNEMONIC
npx hardhat vars set INFURA_API_KEY
npx hardhat deploy --network sepolia
```

Vault contract:

```bash
cd near-vault
npm install
npm run build             # build/swarm_vault.wasm (reproducible)
npm test                  # 9 tests against a mocked NEAR host
```

## Tests

`near-vault/test/vault.test.mjs` covers: configure once, owner-only pause, a valid bid is forwarded to the MPC signer with the right path and payload, one bid per agent per auction, unknown keys and other callers rejected, wrong contract / chain / ETH value / function rejected, gas and fee caps, pause and resume, malformed transactions.

`test/SealedSwarmAuction.ts` covers: winner pays the second price, bid order independence, reserve floor, no sale below reserve, ties, single bidder, each bidder can decrypt only its own bid, one bid per address, no bids after the end, no early close, forged reveal rejected, reveal only once and only after close.

## Limitations

- Testnet prototype; not audited.
- No payment escrow: the contract decides the winner and the price but does not move funds. Settlement (for example a confidential token transfer) is the next step.
- The number of bids per auction is public; the values are not.
- LLM reasoning needs the user's own NEAR AI Cloud API key, typed into the page and kept only in memory; without it agents use rules.
- Seller actions (deploy, create, close, reveal) use MetaMask in the demo; any account can call `close` and `reveal`.
- Agent keys live in the browser's local storage in this demo (testnet only). They can only call `request_sign`, which the vault restricts to bids on the approved auction.
- The vault's policy is fixed at creation; changing it means creating a new vault.

## Prior work and what was built for the hackathon

- Everything in this repository was written during NEAR HACKATHON (from 19 Oct 2026), in this repo's history.
- Earlier, on 3 Nov 2026, the author built **SealedBid**, a single-auction FHE study project (first-price, one bidder per wallet, owner-only decryption) at sealedbid.lercomigo.space. SealedSwarm does not reuse its code: the contract, the second-price logic, the public reveal, the NEAR swarm and the vault are new.
- The Hardhat setup comes from Zama's [`fhevm-hardhat-template`](https://github.com/zama-ai/fhevm-hardhat-template) (BSD-3-Clause-Clear).

## Libraries

`@fhevm/solidity`, `@fhevm/hardhat-plugin`, `@zama-fhe/relayer-sdk` (Zama) · `chainsig.js`, `@near-wallet-selector/core`, `@near-wallet-selector/meteor-wallet`, `@near-js/transactions`, `@near-js/crypto`, `@near-js/providers`, `@near-js/utils`, `assemblyscript` (NEAR) · `viem`, `ethers`, `hardhat`, `vite`, `vite-plugin-node-polyfills`.

Built with AI pair-programming assistance (Claude).

## License

MIT for the code in `contracts/`, `test/`, `deploy/`, `app/` and `near-vault/` (see [LICENSE](LICENSE); template license in [LICENSE-zama-template](LICENSE-zama-template)). Files from the Zama template keep their BSD-3-Clause-Clear license.
