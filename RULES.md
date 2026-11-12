# SealedSwarm market rules

These are the rules the code enforces. Contract: [`contracts/SealedSwarmAuction.sol`](contracts/SealedSwarmAuction.sol). Vault: [`near-vault/assembly/index.ts`](near-vault/assembly/index.ts).

## Auction

1. **A1.** A seller opens an auction with a lot description, a duration (1 minute to 30 days) and a **public reserve price**.
2. **A2.** While the auction is open, each Ethereum address may enter **once**: either a solo bid (`placeBid`) or a contribution to one buyer pool (`joinPool`).
3. **A3.** Every amount is encrypted in the bidder's browser with Zama FHE and bound to the contract and the bidder's address. The contract compares and adds ciphertexts. It never decrypts a bid.
4. **A4.** At most 64 entries (solo bids + submitted pools) per auction. The number of entries is public; the amounts are not.
5. **A5.** After the end time, anyone can call `close`. The contract computes, under encryption:
   - **winner** = the highest entry, if it is at least the reserve; otherwise no sale;
   - **price** = max(second-highest entry, reserve) for a sale; 0 for no sale;
   - ties go to the earlier entry.
6. **A6.** Only the winner and the price are made publicly decryptable. Anyone can publish them with `reveal`, which verifies the Zama KMS signatures on-chain. Losing bids are never revealed.
7. **A7.** Second-price rules make bidding your true value the dominant strategy, so agents don't need to guess what others bid.

## Buyer pools (encrypted group buying)

1. **P1.** `joinPool(auction, 0, amount)` opens a new pool; the caller becomes its creator. `joinPool(auction, poolId, amount)` adds a member. Up to 16 members.
2. **P2.** The contract adds the encrypted contributions. The total saturates at 2^64-1 instead of wrapping around.
3. **P3.** A pool counts only after its creator calls `submitPool`. After that, no one can join, and the encrypted total competes as one entry under the pool's address `poolAddress(auction, poolId)`.
4. **P4.** Each member can decrypt **its own contribution** and **the pool total**, nothing else. Outsiders can decrypt neither.
5. **P5.** If the pool wins, it owes the clearing price. Each member's share is `price × own contribution / pool total`, which each member computes privately.

## Agents and the swarm vault (NEAR)

1. **V1.** An owner creates a vault (`ssvault-<owner>`). The vault creates one sub-account per agent (`<agent>.ssvault-<owner>`), funds it with 0.25 NEAR (its gas budget), and gives it a single key: a function-call key that can only call `request_sign` and `settle` on the vault (v1 vaults: `request_sign` only).
2. **V2.** Each agent's Ethereum address is derived by NEAR Chain Signatures from the vault account and the path `sealedswarm-agent-<n>`. No one holds that private key.
3. **V3.** An agent asks for a signature by sending the unsigned Ethereum transaction to `request_sign`. The vault decodes it and signs only if **all** of these hold:
   - the caller is one of the vault's agent sub-accounts;
   - the vault is not paused;
   - the transaction is EIP-1559 on Sepolia (chain id 11155111) with an empty access list;
   - it calls the approved auction contract, with zero ETH value;
   - the function is `placeBid`, `joinPool` or `submitPool`;
   - gas limit and max fee per gas are within the owner's caps;
   - the agent has not already entered this auction; `submitPool` is allowed once, and only for an agent that joined a pool in this auction (an agent that bid alone cannot submit; the v2 vaults deployed on 11 Nov only checked that the agent had entered, a gap the fuzz test found; the auction contract still refuses it on Sepolia, since only a pool's creator can submit it).
4. **V4.** If any check fails, the vault panics and nothing is signed. If all pass, the vault calls `v1.signer-prod.testnet` (`sign`, path of that agent) and returns the signature.
5. **V5.** Only the owner can pause or resume the vault. The policy is set once, at creation.

## Settlement on NEAR

1. **S1.** The owner configures the vault's settlement (`set_settlement`), allowlists sellers, and sets a spending limit per agent (`set_budget`). On mainnet: the NEAR Intents verifier (`intents.near`) and a token. On testnet, where Intents has no deployment: the token itself (`wrap.testnet`) as both accounts.
2. **S2.** The owner funds the vault: on mainnet by depositing into NEAR Intents on its behalf (`ft_transfer_call` to `intents.near` with `msg = vault`); on testnet by sending it wNEAR (`ft_transfer` on `wrap.testnet`, after `storage_deposit`).
3. **S3.** After the reveal, a winning agent calls `settle(auction, amount, seller)`. A pool member settles only its own share (`price × own contribution / pool total`). The vault pays only if:
   - the caller is one of its agents and the vault is not paused;
   - the seller is on the owner's allowlist;
   - the agent entered that auction and has not paid for it yet;
   - the amount is positive and within the agent's remaining spending limit.
4. **S4.** The vault then pays, with 1 yoctoNEAR attached and a memo naming the auction and the agent: `mt_transfer` on `intents.near` from its Intents balance (mainnet), or `ft_transfer` on the token (testnet; this runs live every market round). If the transfer fails, a private callback restores the budget and allows a retry.
5. **S5.** The vault cannot read Sepolia, so the payment amount comes from the agent. The allowlist, the one-payment-per-auction rule and the spending limit bound what a lying or compromised agent can pay.

## What a compromised agent can do

At most: enter each auction once on the approved contract, with a bid it chose, paying gas within the caps; and pay an allowlisted seller once per auction it entered, within its spending limit. It cannot send ETH, call any other contract or function, bid twice, pay anyone else, or move the NEAR in its account.

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

## Where each rule is tested

Every rule above has an ID (`A1`, `P3`, `V3`, ...). Test names carry the IDs of the rules they check, and `npm run rules` lists, for each rule, the tests that check it; it fails if a rule has none (it runs in CI). The live deployment is checked separately by `npm run verify` in `verify/`.

