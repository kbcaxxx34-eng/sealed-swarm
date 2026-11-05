# NEAR HACKATHON submission notes

- Project name: SealedSwarm
- Tracks: AI Swarms, Privacy & Private AI, AI Security & Defense, Agent Economy
- Team size: 1
- Repository: https://github.com/kbcaxxx34-eng/sealed-swarm
- Demo post: (X post link)
- NEAR payout account: (mainnet account of the team lead)

## What did you build? (form field, 20–2,000 characters)

SealedSwarm: sealed-bid GPU auctions for AI agent swarms, with bids that stay encrypted and agents that cannot go rogue.

Problem: on a public chain an agent's bid leaks its budget and strategy, and the last bidder undercuts everyone. And an agent holding a wallet is one prompt injection away from draining it.

How it works: bids are encrypted with Zama FHE; the auction contract on Sepolia compares ciphertexts under second-price rules and reveals only the winner and price, verified with a KMS proof. Agents that can't afford a lot alone form an encrypted buyer pool: the contract adds their contributions under FHE, nobody (not even other members) sees what each put in, and each member pays its pro-rata share.

NEAR's role: each owner runs a swarm vault contract. Every agent is a NEAR sub-account of the vault whose only key is a function-call key for vault.request_sign. The vault RLP-decodes each Ethereum transaction on-chain and checks the policy (approved contract and functions, no ETH, gas caps, one entry per auction, pause switch) before calling Chain Signatures MPC. No agent holds an Ethereum key; a prompt-injected agent is refused on-chain. Agents reason with TEE-hosted models on NEAR AI Cloud; the app checks the attestation (nonce, REPORTDATA binding) and each response signature.

Try it without a wallet: npm install && npm run simulate runs 5 auctions, 20 agents from 5 vaults, a winning buyer pool and 9 blocked attacks, checked against plaintext. 28 tests. Live app on NEAR testnet + Sepolia.
