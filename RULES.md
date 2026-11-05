# SealedSwarm market rules

These are the rules the code enforces. Contract: [`contracts/SealedSwarmAuction.sol`](contracts/SealedSwarmAuction.sol). Vault: [`near-vault/assembly/index.ts`](near-vault/assembly/index.ts).

## Auction

1. A seller opens an auction with a lot description, a duration (1 minute to 30 days) and a **public reserve price**.
2. While the auction is open, each Ethereum address may enter **once**: either a solo bid (`placeBid`) or a contribution to one buyer pool (`joinPool`).
3. Every amount is encrypted in the bidder's browser with Zama FHE and bound to the contract and the bidder's address. The contract compares and adds ciphertexts. It never decrypts a bid.
4. At most 64 entries (solo bids + submitted pools) per auction. The number of entries is public; the amounts are not.
5. After the end time, anyone can call `close`. The contract computes, under encryption:
   - **winner** = the highest entry, if it is at least the reserve; otherwise no sale;
   - **price** = max(second-highest entry, reserve) for a sale; 0 for no sale;
   - ties go to the earlier entry.
6. Only the winner and the price are made publicly decryptable. Anyone can publish them with `reveal`, which verifies the Zama KMS signatures on-chain. Losing bids are never revealed.
7. Second-price rules make bidding your true value the dominant strategy, so agents don't need to guess what others bid.

## Buyer pools (encrypted group buying)

1. `joinPool(auction, 0, amount)` opens a new pool; the caller becomes its creator. `joinPool(auction, poolId, amount)` adds a member. Up to 16 members.
2. The contract adds the encrypted contributions. The total saturates at 2^64-1 instead of wrapping around.
3. A pool counts only after its creator calls `submitPool`. After that, no one can join, and the encrypted total competes as one entry under the pool's address `poolAddress(auction, poolId)`.
4. Each member can decrypt **its own contribution** and **the pool total**, nothing else. Outsiders can decrypt neither.
5. If the pool wins, it owes the clearing price. Each member's share is `price × own contribution / pool total`, which each member computes privately.

## Agents and the swarm vault (NEAR)

1. An owner creates a vault (`vault.<owner>`). The vault creates one sub-account per agent (`<agent>.vault.<owner>`), funds it with 0.25 NEAR (its gas budget), and gives it a single key: a function-call key that can only call `request_sign` on the vault.
2. Each agent's Ethereum address is derived by NEAR Chain Signatures from the vault account and the path `sealedswarm-agent-<n>`. No one holds that private key.
3. An agent asks for a signature by sending the unsigned Ethereum transaction to `request_sign`. The vault decodes it and signs only if **all** of these hold:
   - the caller is one of the vault's agent sub-accounts;
   - the vault is not paused;
   - the transaction is EIP-1559 on Sepolia (chain id 11155111) with an empty access list;
   - it calls the approved auction contract, with zero ETH value;
   - the function is `placeBid`, `joinPool` or `submitPool`;
   - gas limit and max fee per gas are within the owner's caps;
   - the agent has not already entered this auction (`submitPool` is allowed once, and only after the agent joined a pool).
4. If any check fails, the vault panics and nothing is signed. If all pass, the vault calls `v1.signer-prod.testnet` (`sign`, path of that agent) and returns the signature.
5. Only the owner can pause or resume the vault. The policy is set once, at creation.

## What a compromised agent can do

At most: enter each auction once on the approved contract, with a bid it chose, paying gas within the caps. It cannot send ETH, call any other contract or function, bid twice, or move the NEAR in its account.

## One round, step by step

```
Owner        Vault (NEAR)          Agent sub-account     NEAR MPC        Auction (Sepolia)      Zama KMS
  │ create+configure ─►│ create atlas.vault…, nova.vault…, quill.vault…
  │                    │◄── request_sign(tx: placeBid(enc bid)) ──│
  │                    │ policy checks ✔
  │                    │── sign(payload, path) ─────────────────────────►│
  │                    │◄──────────────────────────── signature ─────────│
  │                    │── signature ──────────►│
  │                    │                        │── signed tx ────────────────────────►│ gt/select/max on ciphertexts
  │                    │                        │      (pool members: joinPool → add on ciphertexts → submitPool)
  │                    │                        │                                    after end: close()
  │                    │                        │                                      winner, price → publicly decryptable
  │                    │                        │                                    reveal(result, proof) ◄──── KMS proof
  │                    │                        │                                      winner + price in clear
```
