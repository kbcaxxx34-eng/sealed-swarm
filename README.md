# Leilão Selado Confidencial (FHE / Zama fhEVM)

Seu primeiro projeto de **contrato inteligente confidencial** usando Fully Homomorphic
Encryption (FHE) sobre o protocolo da Zama. Construído em cima do template oficial
`fhevm-hardhat-template`.

## A ideia

Numa concorrência (licitação, leilão), cada participante envia um **lance cifrado**.
Ninguém vê o lance dos outros. O contrato compara os lances **sobre dados que seguem
criptografados** e guarda o maior lance e o endereço do vencedor, também cifrados.
Só depois do encerramento o dono do leilão fica autorizado a decriptar e revelar o vencedor.

Resultado: zero front-running, zero combinação de preço. É o caso de uso clássico de FHE,
e um ótimo primeiro projeto porque cabe inteiro na cabeça.

## O que este projeto exercita (as habilidades-núcleo de FHE)

- Entrada cifrada vinda do cliente: `FHE.fromExternal(input, prova)`
- Comparação sobre dados cifrados: `FHE.gt(a, b)` → `ebool`
- O "if" cifrado: `FHE.select(cond, seVerdadeiro, seFalso)`
- Endereço cifrado: `eaddress` + `FHE.asEaddress(...)`
- Controle de acesso (ACL): `FHE.allowThis(...)` e `FHE.allow(..., endereco)`

O contrato está em `contracts/LeilaoSelado.sol`. O `contracts/FHECounter.sol` (contador
cifrado, do template) é o seu **aquecimento**: entenda-o primeiro.

## Pré-requisitos

- Node.js 20+ e npm
- Uma carteira (ex.: MetaMask) com um pouco de ETH de testnet da Sepolia (de faucet, grátis)
- Opcional para deploy: uma chave de API Infura/Alchemy e a seed/chave da carteira de teste
  (use SEMPRE uma carteira de teste, nunca a principal)

## Passo a passo

```bash
# 1. Instalar dependências
npm install

# 2. Compilar (primeiro checkpoint — tem que passar limpo)
npx hardhat compile

# 3. Rodar os testes no ambiente mock local (sem gastar nada)
npx hardhat test

# 4. (Depois) Deploy na testnet Sepolia
#    Configure as variáveis abaixo antes (veja hardhat.config.ts):
npx hardhat vars set MNEMONIC
npx hardhat vars set INFURA_API_KEY
npx hardhat deploy --network sepolia
```

## Estrutura

- `contracts/LeilaoSelado.sol` — o contrato do leilão selado (o projeto)
- `contracts/FHECounter.sol` — contador cifrado (aquecimento, do template)
- `test/` — testes em TypeScript (adapte `test/LeilaoSelado.ts`)
- `deploy/` — scripts de deploy
- `hardhat.config.ts` — configuração das redes e do plugin fhevm

## Caminho de estudo sugerido

1. Leia e rode o `FHECounter`: entenda `fromExternal`, `allowThis`, `allow` e a decriptação no teste.
2. Leia o `LeilaoSelado` linha por linha: veja como `gt` + `select` fazem um "maior lance" sem revelar nada.
3. Rode `npx hardhat test` e faça o teste do leilão passar.
4. Deploy na Sepolia e teste ponta a ponta.
5. Upgrade: trocar a revelação pelo dono por `FHE.makePubliclyDecryptable` (revelação pública on-chain).

## Zama Developer Program

Quando a próxima temporada abrir (o registro é pelo Guild da Zama e pede carteira + GitHub),
este projeto serve de submissão na **Builder Track** (casos reais, prêmio mensal de até US$ 7.000).
A submissão pede um vídeo de pitch de até 2 minutos, **com pessoa real** (voz de IA é desqualificada).

## Licença e uso

Código de estudo. O uso **comercial** do código da Zama exige licença de patente da Zama —
resolva isso antes de transformar em produto pago. Para estudo, bounty e portfólio, tranquilo.
