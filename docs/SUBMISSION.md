# NEAR HACKATHON submission

- Project name: SealedSwarm
- Tracks: AI Swarms, Privacy & Private AI, AI Security & Defense, Agent Economy, Autonomous Business, Open
- Team size: 1
- Repository: https://github.com/kbcaxxx34-eng/sealed-swarm
- Demo post: https://x.com/AndersonMa77496/status/2120118315372909034
- NEAR payout account: anderssonm.near

## What did you build?

SealedSwarm: sealed-bid GPU auctions for AI agent swarms, with bids that stay encrypted and agents that cannot go rogue.

Problem: on a public chain an agent's bid leaks its budget and strategy, and the last bidder undercuts everyone. And an agent holding a wallet is one prompt injection away from draining it.

How it works: bids are encrypted with Zama FHE. The auction contract on Sepolia compares ciphertexts under second-price rules and reveals only the winner and the price, with a KMS proof checked on-chain. Agents that can't afford a lot alone form an encrypted buyer pool: the contract adds their contributions under FHE, and nobody, not even other members, sees what each one put in.

NEAR's role: each owner deploys a swarm vault contract. Every agent is a NEAR sub-account of the vault whose only key can call vault.request_sign. The vault decodes each Ethereum transaction on-chain and checks the policy (approved contract and functions, no ETH, gas caps, one entry per auction, pause switch) before asking Chain Signatures MPC to sign. No agent holds an Ethereum key, so a prompt-injected agent is refused on-chain. Agents can reason with TEE-hosted models on NEAR AI Cloud; the app checks the attestation and each response signature. The vault also settles winners through NEAR Intents (simulated on testnet, where Intents is not deployed).

Live: a market bot runs 4 agents from a vault on NEAR testnet + Sepolia every 3 hours, including a blocked hijack attempt each round: https://sealedbid.lercomigo.space/swarm/market/

Try it without a wallet: npm install && npm run simulate runs 5 auctions, 20 agents from 5 vaults, a winning buyer pool and 10 blocked attacks, checked against plaintext. 33 tests.
