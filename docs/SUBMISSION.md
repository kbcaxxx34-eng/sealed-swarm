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

NEAR's role: each owner deploys a swarm vault contract. Every agent is a NEAR sub-account of the vault whose only key can call vault.request_sign and vault.settle. The vault decodes each Ethereum transaction on-chain and checks the policy (approved contract and functions, no ETH, gas caps, one entry per auction, pause switch) before asking Chain Signatures MPC to sign. No agent holds an Ethereum key, so a prompt-injected agent is refused on-chain. Agents can reason with TEE-hosted models on NEAR AI Cloud; the app checks the attestation and each response signature. The vault also settles winners: live on testnet in wNEAR (NEP-141 ft_transfer through the vault's settle), and through NEAR Intents (mt_transfer) on mainnet.

Live: a market bot runs 8 agents from two labs' vaults on NEAR testnet + Sepolia every 3 hours. Agents pool budgets across labs, one agent is hijacked each round with one of six attacks and its vault refuses on NEAR, and the winner (or each pool member, for its share) pays the seller in wNEAR on NEAR through its vault. Each round has a Verify in my browser button that rebuilds every Sepolia transaction from the NEAR vault call and MPC signature using public nodes only: https://sealedbid.lercomigo.space/swarm/market/

Check it without a wallet or keys (the README has a do-X / see-Y table):
- npm ci && npm run test:all: 38 tests (21 auction, pool and limit tests on the FHE mock, 17 on the real vault wasm) plus a fuzz test that sends 10,000 random requests to the vault wasm: 0 policy violations signed. npm run rules shows every rule in RULES.md with the tests that check it.
- npm run simulate: 5 auctions, 20 agents from 5 vaults, a winning buyer pool and 10 blocked attacks, checked against plaintext.
- cd verify && npm ci && npm run verify: rechecks the live deployment from public RPC (146 checks on 12 Nov, more with every round). Deployed vault code = repo wasm, 0 vault keys, request_sign-only agent keys, Sepolia bytecode = repo contract, and for every live-market action that the NEAR request_sign transaction plus the NEAR MPC signature rebuild exactly the Sepolia transaction from the agent's derived address. Every hijack attempt failed on NEAR, and on Zama's ACL no bid is decryptable by anyone but its own bidder: unlike commit-reveal markets, losing bids are never revealed.

CI runs all three on every push and daily, and commits verify/REPORT.md.
