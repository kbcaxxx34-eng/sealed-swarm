# Demo video script (~90 s)

Narration in Portuguese (recorded by the author), English subtitles burned in.

| # | Time | On screen | Narração (PT) | Subtitle (EN) |
|---|---|---|---|---|
| 1 | 0–10 s | Title card: "AI agents are buying GPUs. Every bid is public." | Agentes de IA já compram GPU uns dos outros. Só que, numa blockchain, todo lance é público, e um agente com carteira pode ser manipulado. | AI agents already buy GPUs from each other. On-chain, every bid is public, and an agent with a wallet can be hijacked. |
| 2 | 10–25 s | App: Create vault → explorer showing atlas/nova/quill.vault.anderssonm | Eu crio um cofre na NEAR com uma única aprovação. Cada agente vira uma sub-conta do cofre, e a chave dele só serve para pedir assinatura ao cofre. | One approval creates a vault on NEAR. Each agent is a sub-account whose only key can ask the vault for a signature. |
| 3 | 25–45 s | Agents appraise (NEAR AI reasons + Verified panel) → Agents bid on their own (log: vault approved, MPC signed, Sepolia tx); pool forming | Os agentes pensam com IA privada da NEAR, rodando em hardware protegido. Depois dão lances sozinhos, criptografados com FHE. Quem não alcança o preço mínimo se junta num grupo, e ninguém vê quanto cada um colocou. | Agents reason privately on NEAR AI Cloud, then bid on their own, encrypted with FHE. Agents that can't reach the reserve pool their budgets — no one sees anyone's share. |
| 4 | 45–60 s | Simulate a compromised agent → "Blocked on-chain by the vault" | Agora um agente foi manipulado e tenta mandar dinheiro para um atacante. O cofre lê a transação na própria blockchain e recusa. Nada é assinado. | Now an agent is prompt-injected and tries to pay an attacker. The vault decodes the transaction on-chain and refuses. Nothing is signed. |
| 5 | 60–78 s | Close → Decrypt winner & price → pool wins, shares; Winner pays via NEAR Intents (nearblocks mt_transfer) | No fim, só o vencedor e o preço são revelados. Os lances perdedores continuam secretos para sempre. E o vencedor paga o vendedor pela NEAR Intents, dentro do limite que eu defini. | Only the winner and the price are revealed. Losing bids stay secret forever. The winner pays the seller through NEAR Intents, within the limit I set. |
| 6 | 78–90 s | Terminal: `npm run simulate` output (20 agents, 10 attacks blocked) + repo URL | Quer testar sem carteira? Um comando roda 20 agentes, 5 leilões e 10 ataques bloqueados. SealedSwarm, feito no NEAR Hackathon. | Try it without a wallet: one command runs 20 agents, 5 auctions, 10 blocked attacks. SealedSwarm — built at #NEARHackathon. |

## X post (draft — the author reviews and publishes)

> AI agents are starting to buy compute from each other. On-chain, every bid is public — and an agent holding a wallet is one prompt injection away from draining it.
>
> SealedSwarm: sealed-bid GPU auctions for agent swarms, built at #NEARHackathon @NEARProtocol
>
> • a NEAR vault gives each agent a sub-account that can only ask for signatures; the vault checks every Ethereum tx before Chain Signatures signs it
> • bids encrypted with FHE; agents can pool budgets without revealing shares
> • agents think on NEAR AI Cloud (TEE); winners pay via NEAR Intents
>
> Try it without a wallet: `npm run simulate`
> Repo: https://github.com/kbcaxxx34-eng/sealed-swarm
> Demo: https://sealedbid.lercomigo.space/swarm/
>
> Which limit would you want on your own agents' wallets?
