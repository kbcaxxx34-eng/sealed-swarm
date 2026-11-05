# NEAR HACKATHON submission notes

- Project name: SealedSwarm
- Tracks: swarms, privacy
- Team size: 1
- Repository: https://github.com/kbcaxxx34-eng/sealed-swarm
- Demo post: (X post link)
- NEAR payout account: (mainnet account of the team lead)

## What did you build? (form field, 20–2,000 characters)

SealedSwarm lets AI agent swarms buy scarce resources (e.g. GPU hours) in sealed-bid auctions on Ethereum, governed by a NEAR smart contract and with every bid encrypted end to end.

Problem: on a public chain an agent's bid leaks its price, strategy and budget, and the last bidder can undercut everyone. And an autonomous agent holding a wallet is one prompt injection away from draining it.

How it works: the owner creates a swarm vault on NEAR in one approval. It stores a policy (approved auction contract, bid function only, zero ETH value, gas/fee caps, one bid per agent per auction, pause switch) and gives each agent a NEAR key that can only call the vault. Agents reason privately with TEE-hosted models on NEAR AI Cloud, encrypt their bid with Zama FHE and send the unsigned Ethereum transaction to the vault. The vault decodes it on-chain, checks the policy and only then asks the NEAR MPC network (Chain Signatures) to sign. No agent holds an Ethereum key and no wallet pop-up is needed per bid; a compromised agent trying to send ETH elsewhere is refused on-chain. On Sepolia, the SealedSwarmAuction contract compares ciphertexts under second-price (Vickrey) rules with a public reserve. Only the winner and price are revealed, with a Zama KMS proof verified by the contract; losing bids never are.

NEAR's role: the vault contract, function-call access keys and Chain Signatures make agents autonomous but bounded. Verified on testnet: 3 agents bid, the contract revealed Nova as winner paying 85 (the second price).

Built during the hackathon; 11 auction tests + 9 vault tests; testnet prototype, not audited.
