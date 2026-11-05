# NEAR HACKATHON submission notes

- Project name: SealedSwarm
- Tracks: swarms, privacy
- Team size: 1
- Repository: https://github.com/kbcaxxx34-eng/sealed-swarm
- Demo post: (X post link)
- NEAR payout account: (mainnet account of the team lead)

## What did you build? (form field, 20–2,000 characters)

SealedSwarm lets one NEAR account run a swarm of AI bidding agents in sealed-bid auctions on Ethereum, with every bid encrypted end to end.

Problem: on a public chain an agent's bid leaks its price, strategy and budget, and the last bidder can undercut everyone. Commit-reveal still exposes all bids at reveal time, and TEE-based sealed bids require trusting hardware vendors.

How it works: each agent is an Ethereum address derived from the user's NEAR account with NEAR Chain Signatures, so no agent holds a private key. Agents appraise the lot, their bids are encrypted in the browser with Zama FHE, and one Meteor approval asks the NEAR MPC network (v1.signer-prod.testnet) to sign all the bid transactions at once. On Sepolia, a new SealedSwarmAuction contract compares the ciphertexts (second-price/Vickrey rules, public reserve) without decrypting them. Closing marks only the winner and the price as decryptable; the result is published with a Zama KMS proof that the contract verifies. Losing bids are never revealed.

NEAR's role: one account controls any number of agent addresses, keys never exist on the agent side, and a single approval authorizes a whole bidding round. Verified on testnet: 3 agents bid in one approval, the contract revealed Nova as winner paying 85 (the second price).

Built during the hackathon; 11 tests on the Zama FHE mock; testnet prototype, not audited.
