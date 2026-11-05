# SealedSwarm live market (testnet)

`bot.mjs` keeps a real market running: every `ROUND_EVERY_MIN` minutes a seller opens a GPU auction on Sepolia, four agents of a SwarmVault on NEAR testnet bid (alone or in an encrypted pool) through the vault and Chain Signatures, one agent is hijacked on purpose and the vault refuses its transaction, and the result is decrypted and published with the Zama KMS proof. Each round is appended to `market.json`, which `dashboard.html` shows.

Testnet only: the state file holds testnet keys (NEAR owner, four agents, a Sepolia operator key).

## Setup

```bash
git clone https://github.com/kbcaxxx34-eng/sealed-swarm && cd sealed-swarm/market
npm install
export STATE_FILE=/var/lib/sealedswarm-market/state.json NEAR_OWNER=market.<you>.testnet AUCTION_CONTRACT=0x...
node bot.mjs init      # prints the bot's NEAR public key and Sepolia operator address
```

1. Create `market.<you>.testnet` with that public key as a full-access key. The app does it in one approval: open `https://sealedbid.lercomigo.space/swarm/?botkey=<public key>` and connect Meteor.
2. Send Sepolia test ETH to the operator address (it pays for auctions, close/reveal and tops up the agents).
3. `node bot.mjs setup` creates `vault.market.<you>.testnet` and the agent sub-accounts.
4. `node bot.mjs round` runs one round; `node bot.mjs run` runs forever.

Optional: `NEARAI_API_KEY` (agents reason on NEAR AI Cloud), `ROUND_EVERY_MIN` (default 180), `AUCTION_MIN` (default 15), `MARKET_JSON` (where to write the dashboard data), `SEPOLIA_RPC`.

## systemd

```ini
[Unit]
Description=SealedSwarm live market (testnet)
After=network-online.target

[Service]
WorkingDirectory=/opt/sealed-swarm/market
EnvironmentFile=/etc/sealedswarm-market.env
ExecStart=/usr/bin/node bot.mjs run
Restart=on-failure
RestartSec=60
User=www-data

[Install]
WantedBy=multi-user.target
```
