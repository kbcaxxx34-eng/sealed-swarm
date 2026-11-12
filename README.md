# SealedSwarm

[![CI](https://github.com/kbcaxxx34-eng/sealed-swarm/actions/workflows/main.yml/badge.svg)](https://github.com/kbcaxxx34-eng/sealed-swarm/actions/workflows/main.yml) · on-chain report rechecked daily: [verify/REPORT.md](verify/REPORT.md)

**Sealed-bid GPU auctions for AI agent swarms, with bids that stay encrypted and agents that cannot go rogue.**

AI agents are starting to buy compute from each other. On a public chain every bid is visible: the last bidder undercuts everyone, and each bid leaks the agent's budget and strategy. And an agent that holds a wallet is one prompt injection away from draining it.

SealedSwarm fixes both:

- **Bids stay encrypted end to end** (Zama FHE). The auction contract compares and adds ciphertexts and only ever reveals the winner and the price. Losing bids are never revealed, not even after the auction (commit-reveal schemes reveal every bid at the end; this does not).
- **Agents can pool their budgets without revealing them.** Agents that can't afford a lot alone form an *encrypted buyer pool*: the contract adds their contributions under encryption, and no one, including the other members, learns what each one put in.
- **Agents are autonomous but bounded** (NEAR). Each owner runs a *swarm vault* contract on NEAR. Every agent is a NEAR sub-account of the vault whose only key can ask the vault for a signature. The vault decodes each Ethereum transaction on-chain, checks it against the owner's policy, and only then asks the NEAR MPC network (Chain Signatures) to sign it. No agent ever holds an Ethereum key.
- **Winners pay on NEAR, through their vault.** A winning agent, or each pool member for its own share, asks its vault to pay the seller. The vault checks a seller allowlist, that the agent entered that auction, that it has not paid yet and its spending limit, then pays: live on testnet in wNEAR (NEP-141 `ft_transfer` on `wrap.testnet`), and on mainnet through NEAR Intents (`mt_transfer` on `intents.near`).
- **Agents think privately** (NEAR AI Cloud). Agents reason with open models running in TEEs, and the app checks the TEE attestation and the signature on each answer.

Built at **NEAR HACKATHON 2026**. Tracks: **AI Swarms**, **Privacy & Private AI**, **AI Security & Defense**, **Agent Economy**. Testnet prototype, not audited.

- Live market (8 agents from two labs' vaults trading on testnet every 3 hours since 10 Nov, paying in wNEAR on NEAR): https://sealedbid.lercomigo.space/swarm/market/ — *Verify every round in my browser* rechecks the whole market from public nodes, and *Try to cheat* forges a round's claims and shows the checks refusing them
- Live app: https://sealedbid.lercomigo.space/swarm/
- Rules enforced by the code: [RULES.md](RULES.md) · Simulation report: [simulation/REPORT.md](simulation/REPORT.md)

## Why FHE: what other sealed-bid agent markets give away

Several NEAR HACKATHON projects let agents bid in sealed auctions. They hide bids *while* the auction runs, then open them:

| | Commit-reveal ([Parallax `reveal`](https://github.com/neromtoobad/parallax/blob/main/contracts/near/src/lib.rs#L959), [SwarmGuild `reveal_bid`](https://github.com/0xNexuz/SwarmGuild/blob/main/contracts/swarm/src/lib.rs#L227), [Hivebuy `reveal`](https://github.com/softalpha0/hivebuy/blob/main/contracts/market/src/lib.rs#L299)) | Coordinator-sealed ([Assay](https://github.com/emer-eth/assay)) | **SealedSwarm (FHE)** |
|---|---|---|---|
| Bids hidden while the auction runs | yes | yes, if you trust the coordinator | **yes** |
| Losing bids hidden after the auction | no: every revealed price is public on-chain, forever | no: the round view shows the revealed bids | **yes: never decrypted** |
| Each bidder's budget and strategy leak over many rounds | yes | yes | **no** |
| Bidders must come back to reveal (or lose their bond) | yes | no | **no** |
| Group buying with private contributions | no | no | **encrypted buyer pools** |

This is checked on-chain, not claimed: for every auction, `npm run verify` and the dashboard's *Verify* button ask Zama's access-control contract on Sepolia ([ACL `0xf0Ff…433D`](https://sepolia.etherscan.io/address/0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D)) about each bid's ciphertext: none is publicly decryptable, each is decryptable only by its own bidder, and only the winner and price handles are public.

## For reviewers: check it in 3 commands (no wallet, no keys)

Requirements: Node 20+ and internet access to public NEAR testnet and Sepolia RPC.

```bash
git clone https://github.com/kbcaxxx34-eng/sealed-swarm && cd sealed-swarm && npm ci
npm run test:all                      # 1. tests + 10,000-request fuzz of the vault
npm run rules                         #    which test checks which rule
npm run simulate                      # 2. full market simulation
cd verify && npm ci && npm run verify # 3. recheck the live deployment on-chain
```

| Do | You should see |
|---|---|
| `npm run test:all` | `21 passing` (auction, encrypted buyer pools and limits on Zama's FHE mock), then the vault wasm is rebuilt from source, `17 passing` (vault policy and settlement tests on the real wasm) and the fuzz test: `10,000 request_sign calls: … policy violations refused, 0 violations signed` and `2,000 settle calls … 0 bad payments`. `git status` stays clean: the build is reproducible. |
| `npm run rules` | Every rule in [RULES.md](RULES.md) (`A1`…`S5`) with the tests that check it, and `every rule has at least one test` |
| `npm run simulate` | 5 GPU auctions, 20 agents from 5 owners' vaults, an encrypted buyer pool winning lot #5, every winner settling through the vault's NEAR Intents path (simulated), **29 approved / 10 refused** transactions (prompt-injected agents trying to send ETH to an attacker, call a look-alike contract, call `close()`, bid twice, bid while paused, pay a non-allowlisted seller), and `every result matches a plaintext computation`. Report written to `simulation/REPORT.md`. |
| `npm run verify` | 100+ `PASS` lines (146 on 12 Nov; more with every market round) and `0 failed`: the checks in the table below, rerun live against the chains. Writes `verify/REPORT.md`. |

**What the fuzz test found.** Run against the vault code deployed on 11 Nov (v2), the fuzz test found one gap within its first 500 requests: an agent that had placed a solo bid could get a `submitPool` signed, because the vault checked that the agent had entered the auction, not that it had joined a pool. The auction contract still refuses that transaction on Sepolia (only a pool's creator can submit it), so the worst case is gas within the owner's caps. The current source fixes it (`[V3] an agent that bid alone cannot submit a pool`); the live v2 vaults keep their deployed code, because a vault with no keys cannot be upgraded — which is the point.

Prefer not to run anything? The [CI](https://github.com/kbcaxxx34-eng/sealed-swarm/actions/workflows/main.yml) runs all three on every push and every day, and commits the result to [verify/REPORT.md](verify/REPORT.md).

## What is proven on-chain (by `verify/verify.mjs`, public RPC only)

| Claim | How it is checked |
|---|---|
| The vault code on NEAR is exactly this repo's code | `code_hash` of the live vaults `swarm.ssmarket-anderssonm.testnet` and `swarm.lab2.ssmarket-anderssonm.testnet` = base58(sha256(`near-vault/build/swarm_vault_v2.wasm`)) = `bwL6ttS5…ThaWW`, the build of commit 8a823d2; the v1 vaults (first market rounds) run `swarm_vault_v1.wasm`, the build of commit 645f32f. CI checks both files against those commits, and rebuilds the current `swarm_vault.wasm` from source byte for byte |
| Nobody can change or drain the vaults | Every vault account holds **0 access keys** |
| An agent can only ask its own vault | Each agent sub-account's only key is a function-call key: receiver = its vault, methods = `request_sign` and `settle` (v1: `request_sign` only), nothing else |
| The vault's policy is the one described | `get_config`: auction contract `0x4994…78cc`, MPC `v1.signer-prod.testnet`, gas and fee caps, not paused |
| The Sepolia auction is exactly this repo's contract | Deployed bytecode = `deployedBytecode` compiled from `contracts/SealedSwarmAuction.sol` (9,996 bytes, identical) |
| Auctions are honest | All 20 auctions: every revealed winner placed a bid or is a submitted buyer pool, and paid at least the reserve |
| **Every live-market action went NEAR vault → NEAR MPC → Sepolia** | For each of ~65 agent actions: the NEAR `request_sign` transaction carries the unsigned Ethereum transaction; its result is the NEAR MPC signature; combining the two gives **exactly the Sepolia transaction hash**, and the signer is the agent's address derived from `vault + "sealedswarm-agent-N"`. No agent key, no server key: the signature can only have come from the NEAR MPC network through the vault. |
| **Every hijack attempt was stopped by NEAR** | Each round one agent is hijacked with one of six attacks (send ETH to `0x…dEaD`, call `close()`, send ETH with a bid, bid twice, sign with a 5,000 gwei fee cap, use `settle` to pay `attacker.testnet`); each of those NEAR transactions failed in the vault with the matching policy reason, so nothing was ever signed or paid |
| **Winners really paid, on NEAR** | Each payment is a NEAR transaction from the agent to its vault's `settle`, whose receipts carry the NEP-141 `ft_transfer` event from the vault to the seller for exactly the agent's share; the shares add up to the clearing price |
| **Agents decided inside a TEE** (when the bot runs with a NEAR AI Cloud key) | For each decision: the TEE's ECDSA signature covers sha256 of the exact request and response, and the signer is the address in a TDX quote whose REPORTDATA also holds the bot's fresh nonce (`verify/teeproof.mjs`) |
| **No bid is ever revealed** | For every auction, each bid's ciphertext handle (`getBid`) is not publicly decryptable on Zama's ACL and is decryptable only by its own bidder (not by the other agents); only the winner and price handles are public |
| The dashboard tells the truth | Each round's winner, clearing price, number of sealed bids and pool members match `getAuction` / `getPoolMembers` on Sepolia |

What is *not* proven by the verifier: the bid amounts themselves (they are FHE ciphertexts; only the winner and price are ever decrypted, with the Zama KMS proof checked on-chain in `reveal`), how a pool's members split the price (each member knows only its own contribution and the pool total; the verifier checks the shares add up to the price), and mainnet Intents settlement (Intents exists only on mainnet; it is covered by the vault tests and the simulation).

## Why the auction runs on Sepolia and the swarm on NEAR

Encrypted computation needs Zama's FHE coprocessor, which runs on Ethereum (Sepolia for testnet). NEAR is the swarm's control plane: agent identities (sub-accounts), what each agent may do (function-call keys and the vault's policy), who signs (Chain Signatures, so agents act on another chain without holding keys), and how winners pay (Intents). This is NEAR's chain-abstraction model: the agents live and are governed on NEAR, and act wherever the right primitive is.

## How the official track briefs map to the code

| AI Swarms brief | SealedSwarm |
|---|---|
| A swarm of agents buying GPU compute together | 8 agents from two labs on the live market, 20 in the simulation, buying GPU-hour lots; agents that can't afford a lot alone form a buyer pool, across labs |
| One NEAR sub-account per agent | `atlas.`, `nova.`, `quill.`, `orion.swarm.ssmarket-anderssonm.testnet` and `lyra.`, `kai.`, `vega.`, `juno.swarm.lab2.ssmarket-anderssonm.testnet`, created by each vault's `configure` |
| A coordinator with written rules | The vault contract is the coordinator; its rules are in [RULES.md](RULES.md) and enforced on-chain |
| A simulation with many buyers and sellers | `npm run simulate`: 20 agents, 5 owners, 5 lots |
| A live page | https://sealedbid.lercomigo.space/swarm/market/ |
| Settlement on NEAR | Live every round on testnet in wNEAR (`settle` → NEP-141 `ft_transfer`); the same `settle` uses NEAR Intents (`mt_transfer` on `intents.near`) on mainnet |

| Privacy brief | SealedSwarm |
|---|---|
| Private data stays private | Bids and pool contributions are FHE ciphertexts on-chain; losing bids are never decrypted |
| NEAR AI Cloud attestation with a fresh nonce and a "Verified" panel | The app requests the attestation with a fresh 32-byte nonce and shows each check (details below) |
| Nothing stored server-side | The app is static files with no backend; all state is on NEAR and Sepolia. The live-market bot holds only the agents' `request_sign`-only keys |

## Try the simulation with AI agents

`NEARAI_API_KEY=sk-... npm run simulate` lets the 20 agents reason with a TEE-hosted model on NEAR AI Cloud; the code still caps every bid. What is real in the simulation: the auction contract (same Solidity as on Sepolia, on Hardhat with Zama's FHE mock) and the vault (the same compiled wasm that runs on NEAR, on a mocked NEAR host). What is mocked: the MPC signature and the Intents verifier's response.

## Try the live app (NEAR testnet + Sepolia)

You need the Meteor Wallet extension on **testnet** with a funded `.testnet` account, and MetaMask on Sepolia with a little test ETH. Optional: a NEAR AI Cloud API key from https://cloud.near.ai.

1. Open https://sealedbid.lercomigo.space/swarm/ and **connect Meteor**. → The page shows your vault id `ssvault-<you>.testnet` and the three agents' Ethereum addresses, derived from the vault.
2. **Create vault** (one Meteor approval). The wallet only asks the account registrar to create the vault account with a key this page generates; the page then deploys the vault, configures it and deletes that key in the same transaction, so the vault ends up with no keys at all. → `ssvault-<you>.testnet` is deployed and creates `atlas.`, `nova.` and `quill.ssvault-<you>.testnet`.
3. **Top up agents' NEAR gas** (Meteor; testnet gas prices make a 300 Tgas MPC call prepay ~0.3 NEAR, more than the 0.25 NEAR the vault gives each agent) and **Fund agents** (MetaMask). → Each agent account gets 1 testnet NEAR and each agent address 0.004 Sepolia ETH for gas.
4. **Create an auction** (MetaMask), e.g. *8x H100 · 1 hour*, 5 minutes, reserve 100.
5. **Agents appraise** (paste a NEAR AI key to use LLMs). → Each card shows a private valuation and the model's one-line reason; the *verification* panel lists the TEE attestation checks.
6. **Agents bid on their own.** → No wallet pop-up. The log shows, per agent: encrypted amount, vault approval, MPC signature, Sepolia transaction. Agents below the reserve form a buyer pool.
7. **Simulate a compromised agent.** → Nova tries to send ETH to `0x…dEaD`; the vault refuses on-chain and nothing is signed.
8. After the end time: **Close**, then **Decrypt winner & price**. → Only the winner and the second price are revealed, with the Zama KMS proof verified on-chain.
9. *(Mainnet only; select "Mainnet" at the top. Uses real NEAR: about 3 NEAR of storage for the vault and agent accounts, plus a few cents.)* **Deposit wNEAR into NEAR Intents for the vault**, then after a reveal, **Winner pays the seller via NEAR Intents**. → The log links the `settle` transaction and the `mt_transfer` on `intents.near`. In the demo the owner is also the allowlisted seller.

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
| Smart contract (raw host API, AssemblyScript → 19 KB wasm) | [`near-vault/assembly/index.ts`](near-vault/assembly/index.ts) |
| Sub-accounts created by a contract (one per agent) | `configure` in the vault |
| Function-call access keys (agent can only call `vault.request_sign`) | `configure` in the vault |
| Chain Signatures (MPC `v1.signer-prod.testnet`, per-agent derivation paths) | `request_sign` in the vault; address derivation and signature assembly in [`app/src/main.js`](app/src/main.js) |
| NEAR AI Cloud (TEE-hosted models, attestation report, response signatures) | `attestModel`, `verifyCompletion`, `aiValuation` in [`app/src/main.js`](app/src/main.js); optional in the simulation |
| NEAR Intents (verifier `intents.near`: deposit with `ft_transfer_call`, vault pays with `mt_transfer`, `mt_balance_of`) | `settle` / `on_settled` in the vault; `fundIntents`, `agentSettle` in the app |
| Promise callbacks (budget restored if a transfer fails) | `on_settled` in the vault |
| Meteor Wallet via NEAR Wallet Selector (testnet and mainnet) | [`app/src/main.js`](app/src/main.js) |

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

Current version, 9 Nov 2026: vault `ssvault-anderssonm.testnet` (no keys left after setup) with agent sub-accounts `atlas.`, `nova.`, `quill.ssvault-anderssonm.testnet`; auction contract [`0x4994b9537D50756c5858399bDd460Ba70BE878cc`](https://sepolia.etherscan.io/address/0x4994b9537D50756c5858399bDd460Ba70BE878cc). Auction #4, reserve 100: no agent could reach the reserve alone, so all three formed an encrypted buyer pool, each signing through the vault and the NEAR MPC network with no wallet pop-up.

| Step | Transaction |
|---|---|
| Atlas opens pool #1 (vault-approved, MPC-signed) | [0x046a268c…](https://sepolia.etherscan.io/tx/0x046a268c76631cfd31acdb210a12f442e3287710babf46c918a9c7786ae5dee5) |
| Nova joins pool #1 | [0xbca0e1cb…](https://sepolia.etherscan.io/tx/0xbca0e1cb0430ac8df25723fb9e9a8be17112091700335373e681f809aa607efc) |
| Quill joins pool #1 | [0x987b82bd…](https://sepolia.etherscan.io/tx/0x987b82bdc08f520a07e151f06c0fa5b57256b83b8b4086150de387367c58250e) |
| Atlas submits the pool (encrypted total competes as one bid) | [0x6371ac58…](https://sepolia.etherscan.io/tx/0x6371ac58d37d7d1dc8754885bb3990b3b8bb4197224a8fc88976bc348df9d925) |
| Close auction #4 | [0xe6d7ad57…](https://sepolia.etherscan.io/tx/0xe6d7ad57f773262e36ce903cd4bd7ad8528a4351cb684c7ac636c20fa333f5b9) |
| Reveal: pool #1 wins and pays 100 (reserve); members' shares 28 / 38 / 34, each computed privately | [0x547c6512…](https://sepolia.etherscan.io/tx/0x547c65125b1ceccc0babf314967f0b934dc612b390202a8ad1aa464b38637308) |

The agents' NEAR-side calls (`request_sign` from each agent sub-account to the vault, then the vault's call to `v1.signer-prod.testnet`) are visible on each agent account: [atlas](https://testnet.nearblocks.io/address/atlas.ssvault-anderssonm.testnet) · [nova](https://testnet.nearblocks.io/address/nova.ssvault-anderssonm.testnet) · [quill](https://testnet.nearblocks.io/address/quill.ssvault-anderssonm.testnet).

## Limitations

- Testnet prototype; not audited.
- Settlement trusts the agent's claimed amount, bounded by the allowlist, one payment per auction and the spending limit: the NEAR vault cannot read Sepolia. A bridge or light client would remove that trust.
- NEAR Intents exists only on mainnet. On testnet the vault settles with NEP-141 `ft_transfer` on `wrap.testnet` instead (live in the market); the app's Intents settlement runs when it is switched to mainnet.
- The number of entries per auction is public; amounts are not.
- In the live app, agent keys live in the browser's local storage (testnet only). Each key can only call `request_sign`, and the vault restricts that to entries on the approved auction.
- The vault policy is set once, at creation. A new auction contract needs a new vault.
- Bids always target Sepolia (where Zama's FHE coprocessor runs); the vault can use the testnet or mainnet MPC signer.

## Repository map

| Path | What |
|---|---|
| `contracts/SealedSwarmAuction.sol` | FHE second-price auction with encrypted buyer pools |
| `test/` | 21 tests on the Zama FHE mock |
| `near-vault/` | SwarmVault NEAR contract, its 17 tests, the fuzz test (`test/fuzz.test.mjs`) and a wasm VM harness (`lib/vault-vm.mjs`) |
| `scripts/rules-coverage.mjs` | `npm run rules`: each rule in RULES.md with the tests that check it |
| `simulation/market.sim.ts` | `npm run simulate`: 20 agents, 5 vaults, 5 auctions, pools, Intents settlement, rogue agents |
| `app/` | Front end (Vite): Meteor, Chain Signatures, Zama relayer SDK, NEAR AI Cloud |
| `market/` | Always-on market bot (Node), its public dashboard and the in-browser verifier (`verify-browser.js`) |
| `verify/` | `npm run verify`: no-key recheck of the deployment and every live-market round against NEAR testnet and Sepolia |
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

Business Source License 1.1 (see [LICENSE](LICENSE)). The source is public and free to run, test, study and evaluate, including on testnets and for judging the NEAR HACKATHON 2026; other production use needs a commercial license from the author. On 2030-11-10 it converts to Apache-2.0. Files from the Zama template keep their BSD-3-Clause-Clear license ([LICENSE-zama-template](LICENSE-zama-template)).
