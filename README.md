# SealedSwarm

**Sealed-bid GPU auctions for AI agent swarms, with bids that stay encrypted and agents that cannot go rogue.**

AI agents are starting to buy compute from each other. On a public chain every bid is visible: the last bidder undercuts everyone, and each bid leaks the agent's budget and strategy. And an agent that holds a wallet is one prompt injection away from draining it.

SealedSwarm fixes both:

- **Bids stay encrypted end to end** (Zama FHE). The auction contract compares and adds ciphertexts and only ever reveals the winner and the price. Losing bids are never revealed, not even after the auction.
- **Agents can pool their budgets without revealing them.** Agents that can't afford a lot alone form an *encrypted buyer pool*: the contract adds their contributions under encryption, and no one, including the other members, learns what each one put in.
- **Agents are autonomous but bounded** (NEAR). Each owner runs a *swarm vault* contract on NEAR. Every agent is a NEAR sub-account of the vault whose only key can ask the vault for a signature. The vault decodes each Ethereum transaction on-chain, checks it against the owner's policy, and only then asks the NEAR MPC network (Chain Signatures) to sign it. No agent ever holds an Ethereum key.
- **Agents think privately** (NEAR AI Cloud). Agents reason with open models running in TEEs, and the app checks the TEE attestation and the signature on each answer.

Built at **NEAR HACKATHON 2026**. Tracks: **AI Swarms**, **Privacy & Private AI**, **AI Security & Defense**, **Agent Economy**. Testnet prototype, not audited.

- Live app: https://sealedbid.lercomigo.space/swarm/
- Rules enforced by the code: [RULES.md](RULES.md)
- Simulation report: [simulation/REPORT.md](simulation/REPORT.md)

## Try it in 2 minutes (no wallet needed)

Requirements: Node 20+.

```bash
git clone https://github.com/kbcaxxx34-eng/sealed-swarm && cd sealed-swarm
npm install
npm run simulate
```

**You will see** 5 GPU auctions with 20 agents from 5 different owners' vaults: solo bids, an encrypted buyer pool winning a lot and each member's share, and the vault refusing 9 attacks from prompt-injected agents (send ETH to an attacker, call a look-alike contract, call `close()`, bid twice, bid while the owner paused the vault). Every on-chain result is checked against a plaintext computation of the same rules. The full report is written to `simulation/REPORT.md`.

What is real in the simulation: the auction contract (same Solidity as on Sepolia, on Hardhat with Zama's FHE mock) and the vault (the same compiled wasm that runs on NEAR, on a mocked NEAR host). What is mocked: the MPC signature.

Run all the tests:

```bash
npm run test:all     # 18 auction + pool tests (FHE mock) and 10 vault tests (wasm)
```

## Try the live app (NEAR testnet + Sepolia)

You need the Meteor Wallet extension on **testnet** with a funded `.testnet` account, and MetaMask on Sepolia with a little test ETH. Optional: a NEAR AI Cloud API key from https://cloud.near.ai.

1. Open https://sealedbid.lercomigo.space/swarm/ and **connect Meteor**. → The page shows your vault id `vault.<you>.testnet` and the three agents' Ethereum addresses, derived from the vault.
2. **Create vault** (one Meteor approval). → `vault.<you>.testnet` is deployed and creates `atlas.`, `nova.` and `quill.vault.<you>.testnet`.
3. **Fund agents** (MetaMask). → Each agent address gets 0.004 Sepolia ETH for gas.
4. **Create an auction** (MetaMask), e.g. *8x H100 · 1 hour*, 5 minutes, reserve 100.
5. **Agents appraise** (paste a NEAR AI key to use LLMs). → Each card shows a private valuation and the model's one-line reason; the *verification* panel lists the TEE attestation checks.
6. **Agents bid on their own.** → No wallet pop-up. The log shows, per agent: encrypted amount, vault approval, MPC signature, Sepolia transaction. Agents below the reserve form a buyer pool.
7. **Simulate a compromised agent.** → Nova tries to send ETH to `0x…dEaD`; the vault refuses on-chain and nothing is signed.
8. After the end time: **Close**, then **Decrypt winner & price**. → Only the winner and the second price are revealed, with the Zama KMS proof verified on-chain.

## How it works

```
 Owner ── 1 approval ──► vault.owner.testnet  (policy: auction contract, functions, gas caps, pause)
                           ├─ atlas.vault.owner.testnet  ┐ only key: function-call key,
                           ├─ nova.vault.owner.testnet   │ receiver = vault, method = request_sign
                           └─ quill.vault.owner.testnet  ┘
 Agent ── request_sign(unsigned EIP-1559 tx) ──► vault: RLP-decode, check policy
                                                   ok  → v1.signer-prod.testnet (NEAR MPC) → ECDSA signature
                                                   bad → panic, nothing signed
 Browser: Zama FHE encrypts each amount ───────────────┐
                                                       ▼
 Sepolia: SealedSwarmAuction
   placeBid(enc)                  gt / select / max on ciphertexts → highest, second, leader
   joinPool(enc) → submitPool     add on ciphertexts → pool total competes as one bid
   close()                        winner = leader if highest ≥ reserve; price = max(second, reserve)
   reveal(result, KMS proof)      FHE.checkSignatures → winner + price in clear
```

Step-by-step rules and a sequence diagram: [RULES.md](RULES.md).

### NEAR features used

| Feature | Where |
|---|---|
| Smart contract (raw host API, AssemblyScript → 15 KB wasm) | [`near-vault/assembly/index.ts`](near-vault/assembly/index.ts) |
| Sub-accounts created by a contract (one per agent) | `configure` in the vault |
| Function-call access keys (agent can only call `vault.request_sign`) | `configure` in the vault |
| Chain Signatures (MPC `v1.signer-prod.testnet`, per-agent derivation paths) | `request_sign` in the vault; address derivation and signature assembly in [`app/src/main.js`](app/src/main.js) |
| NEAR AI Cloud (TEE-hosted models, attestation report, response signatures) | `attestModel`, `verifyCompletion`, `aiValuation` in [`app/src/main.js`](app/src/main.js) |
| Meteor Wallet via NEAR Wallet Selector | [`app/src/main.js`](app/src/main.js) |

### Zama FHE

[`contracts/SealedSwarmAuction.sol`](contracts/SealedSwarmAuction.sol) uses `FHE.fromExternal`, `gt`, `select`, `max`, `ge`, `add`, `lt`, `asEaddress`, `allow`, `makePubliclyDecryptable` and `checkSignatures` (fhevm 0.11). Each bidder can decrypt its own bid; pool members can decrypt their own contribution and the pool total; everyone can decrypt only the final winner and price.

### NEAR AI Cloud verification (in the browser)

Before agents reason, the app requests the model's attestation report with a fresh 32-byte nonce and checks: the report echoes the nonce; the TDX quote's REPORTDATA binds the model's signing address and the nonce; MRCONFIGID equals the hash of the app compose. After each answer, it fetches the response signature and checks that it covers the SHA-256 of the exact request and response bytes and that the ECDSA signer is the attested one. Not checked in the browser: the Intel DCAP signature chain of the quote and the NVIDIA GPU evidence (use [`dcap-qvl`](https://github.com/Phala-Network/dcap-qvl) and NVIDIA NRAS for those). The model only *proposes* a valuation: code caps the bid at the agent's budget, and the vault caps what can ever be signed.

## Proof on testnet

First version (agents signed with one Meteor approval, before the vault and pools), contract `0x2B5a1C37967FC1612EE075d2516c3ACa7b543b05` on Sepolia, 5 Nov 2026:

| Step | Transaction |
|---|---|
| Three agents' sealed bids (auction #2) | [Atlas](https://sepolia.etherscan.io/tx/0xc597c5f195758d90c11dc6c00b03024f30b70caa793953d5cc67b8d6ae695788) · [Nova](https://sepolia.etherscan.io/tx/0xdd681d4092f4f3984a9df019b37f6c83adfe0c5ca757e5bbfd80095541e9ea67) · [Quill](https://sepolia.etherscan.io/tx/0x031b3419e5c807945c618d15eb9b0d9320ee8ee09c14f66042e00ddad1ddcb6d) |
| Close auction #2 | [0x07ca57f3…](https://sepolia.etherscan.io/tx/0x07ca57f3f38a1eca97c90de66c11430f0b612093eb07d660b527b1fc47b2695e) |
| Reveal #2: Nova wins and pays 85 (the second price), verified by Zama KMS signatures | [0x954301fb…](https://sepolia.etherscan.io/tx/0x954301fb7202fd1688f9110feacff497e7187d12c9dcf561365c8096ee55773e) |

Current version (vault with agent sub-accounts, buyer pools): transactions will be added here after the testnet run.

## Limitations

- Testnet prototype; not audited.
- No payment escrow: the contract decides winner and price but does not move funds. Settlement is the next step.
- The number of entries per auction is public; amounts are not.
- In the live app, agent keys live in the browser's local storage (testnet only). Each key can only call `request_sign`, and the vault restricts that to entries on the approved auction.
- The vault policy is set once, at creation. A new auction contract needs a new vault.
- The vault is configured for NEAR testnet MPC and Sepolia.

## Repository map

| Path | What |
|---|---|
| `contracts/SealedSwarmAuction.sol` | FHE second-price auction with encrypted buyer pools |
| `test/` | 18 tests on the Zama FHE mock |
| `near-vault/` | SwarmVault NEAR contract, its 10 tests and a wasm VM harness (`lib/vault-vm.mjs`) |
| `simulation/market.sim.ts` | `npm run simulate`: 20 agents, 5 vaults, 5 auctions, rogue agents |
| `app/` | Front end (Vite): Meteor, Chain Signatures, Zama relayer SDK, NEAR AI Cloud |
| `RULES.md` | The rules the code enforces |

## Prior work and what was built for the hackathon

- Everything in this repository was written during NEAR HACKATHON (from 19 Oct 2026), as the git history shows.
- On 3 Nov 2026 the author built **SealedBid**, a single-auction FHE study project (first-price, owner-only decryption) at sealedbid.lercomigo.space. SealedSwarm does not reuse its code.
- The Hardhat setup comes from Zama's [`fhevm-hardhat-template`](https://github.com/zama-ai/fhevm-hardhat-template) (BSD-3-Clause-Clear).
- The author is not submitting another project.

## Libraries

`@fhevm/solidity`, `@fhevm/hardhat-plugin`, `@zama-fhe/relayer-sdk` (Zama) · `chainsig.js`, `@near-wallet-selector/core`, `@near-wallet-selector/meteor-wallet`, `@near-js/transactions`, `@near-js/crypto`, `@near-js/providers`, `@near-js/utils`, `assemblyscript` (NEAR) · `viem`, `ethers`, `hardhat`, `vite`, `vite-plugin-node-polyfills`.

Built with AI pair-programming assistance (Claude).

## License

MIT (see [LICENSE](LICENSE)). Files from the Zama template keep their BSD-3-Clause-Clear license ([LICENSE-zama-template](LICENSE-zama-template)).
