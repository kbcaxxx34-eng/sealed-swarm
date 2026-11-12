// SwarmVault — a NEAR contract that controls a swarm of bidding agents.
//
// Each agent is its own NEAR sub-account of the vault (atlas.vault.alice.testnet, ...), created
// by the vault at configuration. The only key on an agent account is a function-call key that can
// call `request_sign` on this vault, so an agent cannot move its NEAR, add keys or call anything
// else. Agents never hold an Ethereum key. The vault checks every request against the owner's
// policy, then asks the NEAR MPC network to sign the Ethereum transaction for that agent's
// derived address (vault account + path sealedswarm-agent-<n>).
//
// Policy enforced on-chain, per request:
//   - the caller is one of the vault's agent sub-accounts
//   - the vault is not paused
//   - the Ethereum transaction is EIP-1559 on Sepolia (chain id 11155111)
//   - it calls the approved auction contract with no ETH value, and only these functions:
//     placeBid(uint256,bytes32,bytes), joinPool(uint256,uint256,bytes32,bytes), submitPool(uint256,uint256)
//   - gas limit and max fee per gas are under the owner's caps
//   - each agent enters each auction at most once (one bid, or one pool contribution);
//     submitPool is allowed only for an agent that already joined a pool in that auction
//
// Settlement (optional): through NEAR Intents on mainnet, or directly with NEP-141 ft_transfer on a
// token such as wrap.testnet (set_settlement with the token as both accounts) on testnet:
//   an agent that won (alone or in a pool) asks the vault to pay the seller its share. The vault
//   pays from its own balance (mt_transfer inside the Intents verifier, or ft_transfer), only if the seller is
//   on the owner's allowlist, the agent entered that auction, has not paid it yet, and the amount
//   fits the agent's remaining budget (a spending limit set by the owner). A failed transfer
//   restores the budget in a callback.
//
// Written against the raw NEAR host API (no SDK) and compiled with AssemblyScript.

// ------------------------------------------------------------------ NEAR host functions
@external("env", "input") declare function input(register_id: u64): void;
@external("env", "register_len") declare function register_len(register_id: u64): u64;
@external("env", "read_register") declare function read_register(register_id: u64, ptr: u64): void;
@external("env", "value_return") declare function value_return(len: u64, ptr: u64): void;
@external("env", "panic_utf8") declare function panic_utf8(len: u64, ptr: u64): void;
@external("env", "log_utf8") declare function log_utf8(len: u64, ptr: u64): void;
@external("env", "storage_write") declare function storage_write(key_len: u64, key_ptr: u64, value_len: u64, value_ptr: u64, register_id: u64): u64;
@external("env", "storage_remove") declare function storage_remove(key_len: u64, key_ptr: u64, register_id: u64): u64;
@external("env", "storage_read") declare function storage_read(key_len: u64, key_ptr: u64, register_id: u64): u64;
@external("env", "predecessor_account_id") declare function predecessor_account_id(register_id: u64): void;
@external("env", "keccak256") declare function keccak256(value_len: u64, value_ptr: u64, register_id: u64): void;
@external("env", "promise_create") declare function promise_create(account_id_len: u64, account_id_ptr: u64, method_name_len: u64, method_name_ptr: u64, arguments_len: u64, arguments_ptr: u64, amount_ptr: u64, gas: u64): u64;
@external("env", "promise_return") declare function promise_return(promise_idx: u64): void;
@external("env", "current_account_id") declare function current_account_id(register_id: u64): void;
@external("env", "promise_then") declare function promise_then(promise_index: u64, account_id_len: u64, account_id_ptr: u64, method_name_len: u64, method_name_ptr: u64, arguments_len: u64, arguments_ptr: u64, amount_ptr: u64, gas: u64): u64;
@external("env", "promise_result") declare function promise_result(result_idx: u64, register_id: u64): u64;
@external("env", "promise_results_count") declare function promise_results_count(): u64;
@external("env", "promise_batch_create") declare function promise_batch_create(account_id_len: u64, account_id_ptr: u64): u64;
@external("env", "promise_batch_action_create_account") declare function promise_batch_action_create_account(promise_index: u64): void;
@external("env", "promise_batch_action_transfer") declare function promise_batch_action_transfer(promise_index: u64, amount_ptr: u64): void;
@external("env", "promise_batch_action_add_key_with_function_call") declare function promise_batch_action_add_key_with_function_call(promise_index: u64, public_key_len: u64, public_key_ptr: u64, nonce: u64, allowance_ptr: u64, receiver_id_len: u64, receiver_id_ptr: u64, method_names_len: u64, method_names_ptr: u64): void;

const REG: u64 = 0;
const DEFAULT_MPC = "v1.signer-prod.testnet"; // owner can switch to "v1.signer" on mainnet (set_mpc)
const SETTLE_GAS: u64 = 30_000_000_000_000; // mt_transfer on the Intents verifier
const CALLBACK_GAS: u64 = 10_000_000_000_000;
const SIGN_GAS: u64 = 250_000_000_000_000; // 250 Tgas for the MPC sign call
const PATH_PREFIX = "sealedswarm-agent-";
const SEPOLIA_CHAIN_ID: StaticArray<u8> = [0xaa, 0x36, 0xa7]; // 11155111
const PLACE_BID_SELECTOR: StaticArray<u8> = [0x3e, 0xc0, 0x4a, 0x7d]; // placeBid(uint256,bytes32,bytes)
const JOIN_POOL_SELECTOR: StaticArray<u8> = [0x0e, 0xc8, 0x0e, 0xb9]; // joinPool(uint256,uint256,bytes32,bytes)
const SUBMIT_POOL_SELECTOR: StaticArray<u8> = [0x25, 0xe2, 0x1f, 0xba]; // submitPool(uint256,uint256)
const MAX_AGENTS: i32 = 16;
// 0.25 NEAR, u128 little-endian: funds each agent account for gas (and is its key's allowance)


// ------------------------------------------------------------------ low-level helpers
function ptr(a: Uint8Array): u64 { return <u64>a.dataStart; }

function utf8(s: string): Uint8Array { return Uint8Array.wrap(String.UTF8.encode(s)); }

function readRegister(): Uint8Array {
  const len = <i32>register_len(REG);
  const out = new Uint8Array(len);
  if (len > 0) read_register(REG, ptr(out));
  return out;
}

function fail(msg: string): void {
  const b = utf8(msg);
  panic_utf8(<u64>b.length, ptr(b));
}

function abortHandler(message: string | null, file: string | null, line: u32, column: u32): void {
  fail(message != null ? message! : "abort");
}

function log(msg: string): void {
  const b = utf8(msg);
  log_utf8(<u64>b.length, ptr(b));
}

function readInput(): Uint8Array { input(REG); return readRegister(); }

function returnBytes(b: Uint8Array): void { value_return(<u64>b.length, ptr(b)); }

function sget(key: string): Uint8Array | null {
  const k = utf8(key);
  if (storage_read(<u64>k.length, ptr(k), REG) == 0) return null;
  return readRegister();
}

function sgetBytesKey(k: Uint8Array): bool {
  return storage_read(<u64>k.length, ptr(k), REG) == 1;
}

function storage_remove_key(k: Uint8Array): void { storage_remove(<u64>k.length, ptr(k), REG); }

function sset(key: string, value: Uint8Array): void {
  const k = utf8(key);
  storage_write(<u64>k.length, ptr(k), <u64>value.length, ptr(value), REG);
}

function ssetBytesKey(k: Uint8Array, value: Uint8Array): void {
  storage_write(<u64>k.length, ptr(k), <u64>value.length, ptr(value), REG);
}

function eq(a: Uint8Array, b: Uint8Array): bool {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}

function eqStatic(a: Uint8Array, b: StaticArray<u8>): bool {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}

// big-endian unsigned compare of minimal encodings (leading zero bytes tolerated)
function leBE(a: Uint8Array, b: Uint8Array): bool {
  let ai = 0; while (ai < a.length && a[ai] == 0) ai++;
  let bi = 0; while (bi < b.length && b[bi] == 0) bi++;
  const al = a.length - ai, bl = b.length - bi;
  if (al != bl) return al < bl;
  for (let i = 0; i < al; i++) {
    if (a[ai + i] != b[bi + i]) return a[ai + i] < b[bi + i];
  }
  return true;
}

const HEX = "0123456789abcdef";
function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += HEX.charAt(b[i] >> 4);
    s += HEX.charAt(b[i] & 15);
  }
  return s;
}

function predecessor(): Uint8Array { predecessor_account_id(REG); return readRegister(); }

// The vault itself also counts as owner: the app deploys it with a temporary full-access key that is
// deleted in the same transaction, so after setup no one can sign as the vault again.
function ownerOrFail(): void {
  const owner = sget("owner");
  if (owner == null) { fail("not configured"); return; }
  const p = predecessor();
  if (!eq(p, owner!) && !eq(p, selfId())) fail("only the owner can do this");
}

// ------------------------------------------------------------------ RLP (just enough for EIP-1559)
class Item {
  constructor(public start: i32, public len: i32, public next: i32, public isList: bool) {}
}

function readLen(b: Uint8Array, pos: i32, n: i32): i32 {
  if (n > 3) { fail("rlp length too big"); return 0; }
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 8) | b[pos + i];
  return v;
}

function rlpItem(b: Uint8Array, pos: i32): Item {
  if (pos >= b.length) { fail("rlp out of bounds"); }
  const p = b[pos];
  let item: Item;
  if (p < 0x80) item = new Item(pos, 1, pos + 1, false);
  else if (p <= 0xb7) item = new Item(pos + 1, p - 0x80, pos + 1 + (p - 0x80), false);
  else if (p <= 0xbf) {
    const n = p - 0xb7; const l = readLen(b, pos + 1, n);
    item = new Item(pos + 1 + n, l, pos + 1 + n + l, false);
  } else if (p <= 0xf7) item = new Item(pos + 1, p - 0xc0, pos + 1 + (p - 0xc0), true);
  else {
    const n = p - 0xf7; const l = readLen(b, pos + 1, n);
    item = new Item(pos + 1 + n, l, pos + 1 + n + l, true);
  }
  if (item.next > b.length) fail("rlp item overflows input");
  return item;
}

function slice(b: Uint8Array, it: Item): Uint8Array { return b.subarray(it.start, it.start + it.len); }

// ------------------------------------------------------------------ methods

// 0.25 NEAR = 250_000_000_000_000_000_000_000 yocto, as u128 little-endian
function agentFund(): Uint8Array {
  const out = new Uint8Array(16);
  // 0x34F086F3B33B68400000 (big-endian) = 2.5e23
  const be: StaticArray<u8> = [0x34, 0xf0, 0x86, 0xf3, 0xb3, 0x3b, 0x68, 0x40, 0x00, 0x00];
  for (let i = 0; i < be.length; i++) out[i] = be[be.length - 1 - i];
  return out;
}

function selfId(): Uint8Array { current_account_id(REG); return readRegister(); }

/// configure(args): one-time setup; the caller becomes the owner.
/// Binary args: [20 auction][1 n_fee][fee BE][1 n_gas][gas BE][1 n_agents]
///              then per agent: [1 name_len][name][32 ed25519 public key]
/// Creates <name>.<vault> for each agent, funds it with 0.25 NEAR and adds the agent's key as a
/// function-call key restricted to <vault>.request_sign and <vault>.settle (no allowance cap; the
/// balance is the cap).
export function configure(): void {
  if (sget("owner") != null) { fail("already configured"); return; }
  // owner = the caller, unless the vault configures itself during setup (deployed with a temporary
  // key that the same transaction deletes): then the owner is named at the end of the arguments.
  const caller = predecessor();
  const selfSetup = eq(caller, selfId());
  if (!selfSetup) sset("owner", caller);

  const a = readInput();
  let p = 0;
  if (a.length < 23) { fail("bad config"); return; }
  sset("auction", a.slice(p, p + 20)); p += 20;
  const nf = <i32>a[p]; p += 1; sset("maxfee", a.slice(p, p + nf)); p += nf;
  const ng = <i32>a[p]; p += 1; sset("maxgas", a.slice(p, p + ng)); p += ng;
  const n = <i32>a[p]; p += 1;
  if (n < 1 || n > MAX_AGENTS) { fail("1 to 16 agents"); return; }

  const self = selfId();
  const selfStr = String.UTF8.decode(self.buffer);
  const fund = agentFund();
  const methods = utf8("request_sign,settle"); // NEAR host format: comma-separated
  const noAllowance = new Uint8Array(16);
  for (let i = 0; i < n; i++) {
    if (p >= a.length) { fail("bad agent list"); return; }
    const nl = <i32>a[p]; p += 1;
    if (nl < 2 || nl > 16 || p + nl + 32 > a.length) { fail("bad agent entry"); return; }
    const name = a.slice(p, p + nl); p += nl;
    for (let j = 0; j < nl; j++) {
      const c = name[j];
      if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39))) { fail("agent names: a-z and 0-9 only"); return; }
    }
    const pk = new Uint8Array(33); // borsh PublicKey: 0 = ed25519, then 32 bytes
    pk.set(a.subarray(p, p + 32), 1); p += 32;
    const account = utf8(String.UTF8.decode(name.buffer) + "." + selfStr);
    sset("a" + i.toString(), account);

    const pr = promise_batch_create(<u64>account.length, ptr(account));
    promise_batch_action_create_account(pr);
    promise_batch_action_transfer(pr, ptr(fund));
    // allowance 0 = unlimited: a NEAR allowance is consumed by *prepaid* gas and never refunded, so a
    // finite one would lock the agent out after a few 300 Tgas calls. The agent's balance (0.25 NEAR)
    // is the real spending cap, and the key still can only call request_sign and settle.
    promise_batch_action_add_key_with_function_call(pr, 33, ptr(pk), 0, ptr(noAllowance),
      <u64>self.length, ptr(self), <u64>methods.length, ptr(methods));
  }
  if (selfSetup) {
    if (p >= a.length) { fail("self-setup needs an owner"); return; }
    const ol = <i32>a[p]; p += 1;
    if (ol < 2 || ol > 64 || p + ol != a.length) { fail("bad owner"); return; }
    sset("owner", a.slice(p, p + ol)); p += ol;
  }
  if (p != a.length) { fail("trailing config bytes"); return; }
  const nb = new Uint8Array(1); nb[0] = <u8>n; sset("n", nb);
  const z = new Uint8Array(1); sset("paused", z);
  log("SwarmVault configured with " + n.toString() + " agent sub-accounts");
}

/// pause(args: 1 byte, 1 = paused): emergency stop, owner only.
export function pause(): void {
  ownerOrFail();
  const a = readInput();
  const v = new Uint8Array(1); v[0] = a.length > 0 && a[0] != 0 ? 1 : 0;
  sset("paused", v);
  log(v[0] == 1 ? "SwarmVault paused" : "SwarmVault resumed");
}

/// request_sign(args: unsigned EIP-1559 transaction bytes, 0x02 || rlp(...)).
/// Called by an agent from its own sub-account (its only key is restricted to this method).
export function request_sign(): void {
  const nb = sget("n");
  if (nb == null) { fail("not configured"); return; }
  const paused = sget("paused");
  if (paused != null && paused!.length > 0 && paused![0] == 1) { fail("vault is paused"); return; }

  // which agent? identified by the calling sub-account
  const caller = predecessor();
  const n = <i32>nb![0];
  let agent = -1;
  for (let i = 0; i < n; i++) {
    const k = sget("a" + i.toString());
    if (k != null && eq(k!, caller)) { agent = i; break; }
  }
  if (agent < 0) { fail("caller is not one of this vault's agents"); return; }

  // decode and check the Ethereum transaction
  const tx = readInput();
  if (tx.length < 2 || tx[0] != 0x02) { fail("only EIP-1559 transactions"); return; }
  const list = rlpItem(tx, 1);
  if (!list.isList || list.next != tx.length) { fail("malformed transaction"); return; }
  let pos = list.start;
  const chainId = rlpItem(tx, pos); pos = chainId.next;
  const nonce = rlpItem(tx, pos); pos = nonce.next;
  const prio = rlpItem(tx, pos); pos = prio.next;
  const maxFee = rlpItem(tx, pos); pos = maxFee.next;
  const gas = rlpItem(tx, pos); pos = gas.next;
  const to = rlpItem(tx, pos); pos = to.next;
  const value = rlpItem(tx, pos); pos = value.next;
  const data = rlpItem(tx, pos); pos = data.next;
  const access = rlpItem(tx, pos); pos = access.next;
  if (pos != list.start + list.len) { fail("unexpected transaction fields"); return; }

  if (!eqStatic(slice(tx, chainId), SEPOLIA_CHAIN_ID)) { fail("wrong chain: Sepolia only"); return; }
  if (!eq(slice(tx, to), sget("auction")!)) { fail("target is not the approved auction contract"); return; }
  if (value.len != 0) { fail("agents cannot send ETH"); return; }
  if (!access.isList || access.len != 0) { fail("access lists not allowed"); return; }
  if (!leBE(slice(tx, maxFee), sget("maxfee")!)) { fail("max fee per gas above the owner's cap"); return; }
  if (!leBE(slice(tx, gas), sget("maxgas")!)) { fail("gas limit above the owner's cap"); return; }
  const d = slice(tx, data);
  if (d.length < 36) { fail("only placeBid, joinPool and submitPool are allowed"); return; }
  const sel = d.subarray(0, 4);
  const isBid = eqStatic(sel, PLACE_BID_SELECTOR);
  const isJoin = eqStatic(sel, JOIN_POOL_SELECTOR);
  const isSubmit = eqStatic(sel, SUBMIT_POOL_SELECTOR);
  if (!isBid && !isJoin && !isSubmit) { fail("only placeBid, joinPool and submitPool are allowed"); return; }
  if (nonce.isList || prio.isList) { fail("malformed transaction"); return; }

  // each agent enters each auction once (a bid or a pool contribution)
  const usedKey = new Uint8Array(1 + 1 + 32);
  usedKey[0] = 0x75; // 'u'
  usedKey[1] = <u8>agent;
  usedKey.set(d.subarray(4, 36), 2);
  const entered = sgetBytesKey(usedKey);
  const joinKey = new Uint8Array(34); joinKey.set(usedKey); joinKey[0] = 0x6a; // 'j': joined a pool here
  if (isSubmit) {
    // only an agent that joined a pool in this auction (not one that bid alone) may submit a pool
    if (!sgetBytesKey(joinKey)) { fail("submitPool: this agent has not joined a pool in this auction"); return; }
    const sk = new Uint8Array(34); sk.set(usedKey); sk[0] = 0x73; // 's'
    if (sgetBytesKey(sk)) { fail("this agent already submitted a pool in this auction"); return; }
    const one = new Uint8Array(1); one[0] = 1;
    ssetBytesKey(sk, one);
  } else {
    if (entered) { fail("this agent already bid on this auction"); return; }
    const one = new Uint8Array(1); one[0] = 1;
    ssetBytesKey(usedKey, one);
    if (isJoin) ssetBytesKey(joinKey, one);
  }

  // payload = keccak256(0x02 || rlp(...)), signed for this agent's path
  keccak256(<u64>tx.length, ptr(tx), REG);
  const payload = readRegister();
  const path = PATH_PREFIX + (agent + 1).toString();
  const args = utf8('{"request":{"payload_v2":{"Ecdsa":"' + toHex(payload) + '"},"path":"' + path + '","domain_id":0}}');
  const acc = mpcAccount();
  const method = utf8("sign");
  const amount = new Uint8Array(16); amount[0] = 1; // 1 yoctoNEAR, paid by the vault
  const action = isBid ? "placeBid" : (isJoin ? "joinPool" : "submitPool");
  log("agent " + (agent + 1).toString() + " " + action + " on auction 0x" + toHex(d.subarray(4, 36)) + " approved by policy");
  const id = promise_create(<u64>acc.length, ptr(acc), <u64>method.length, ptr(method), <u64>args.length, ptr(args), ptr(amount), SIGN_GAS);
  promise_return(id);
}

/// get_config(): JSON with the public policy.
export function get_config(): void {
  const owner = sget("owner");
  if (owner == null) { returnBytes(utf8('{"configured":false}')); return; }
  const auction = sget("auction")!;
  const n = sget("n")!;
  const paused = sget("paused");
  const isPaused = paused != null && paused!.length > 0 && paused![0] == 1;
  let list = "";
  for (let i = 0; i < <i32>n[0]; i++) {
    const acc = sget("a" + i.toString())!;
    list += (i > 0 ? "," : "") + '"' + String.UTF8.decode(acc.buffer) + '"';
  }
  const json = '{"configured":true,"owner":"' + String.UTF8.decode(owner!.buffer) +
    '","auction":"0x' + toHex(auction) + '","agents":' + (<i32>n[0]).toString() + ',"agent_accounts":[' + list + ']' +
    ',"max_fee_per_gas_hex":"0x' + toHex(sget("maxfee")!) + '","max_gas_hex":"0x' + toHex(sget("maxgas")!) +
    '","paused":' + (isPaused ? "true" : "false") + ',"mpc":"' + String.UTF8.decode(mpcAccount().buffer) +
    '","path_prefix":"' + PATH_PREFIX + '","intents":"' + strOr("intents") + '","settlement_token":"' + strOr("token") + '"}';
  returnBytes(utf8(json));
}

// ------------------------------------------------------------------ owner settings

function strOr(key: string): string {
  const v = sget(key);
  return v == null ? "" : String.UTF8.decode(v!.buffer);
}

function mpcAccount(): Uint8Array {
  const v = sget("mpc");
  return v == null ? utf8(DEFAULT_MPC) : v!;
}

/// set_mpc(args: utf8 account id): MPC signer contract, e.g. "v1.signer" on mainnet. Owner only.
export function set_mpc(): void {
  ownerOrFail();
  const a = readInput();
  if (a.length < 2 || a.length > 64) { fail("bad account"); return; }
  sset("mpc", a);
}

/// set_settlement(args: [1 len][intents verifier account][1 len][token contract]). Owner only.
export function set_settlement(): void {
  ownerOrFail();
  const a = readInput();
  if (a.length < 2) { fail("bad args"); return; }
  const il = <i32>a[0];
  if (1 + il + 1 > a.length) { fail("bad args"); return; }
  const tl = <i32>a[1 + il];
  if (2 + il + tl != a.length || il < 2 || tl < 2) { fail("bad args"); return; }
  sset("intents", a.slice(1, 1 + il));
  sset("token", a.slice(2 + il, 2 + il + tl));
  log("settlement: " + strOr("token") + " via " + strOr("intents"));
}

/// allow_seller(args: utf8 account id): add a seller the agents may pay. Owner only.
export function allow_seller(): void {
  ownerOrFail();
  const a = readInput();
  if (a.length < 2 || a.length > 64) { fail("bad account"); return; }
  sset("S" + String.UTF8.decode(a.buffer), oneByte());
  log("seller allowed: " + String.UTF8.decode(a.buffer));
}

function oneByte(): Uint8Array { const b = new Uint8Array(1); b[0] = 1; return b; }

/// set_budget(args: [1 agent index][16 amount, u128 little-endian]): agent's remaining payment
/// budget in the settlement token's smallest unit. Owner only.
export function set_budget(): void {
  ownerOrFail();
  const a = readInput();
  if (a.length != 17) { fail("bad args"); return; }
  const nb = sget("n");
  if (nb == null || <i32>a[0] >= <i32>nb![0]) { fail("unknown agent"); return; }
  sset("b" + (<i32>a[0]).toString(), a.slice(1, 17));
}

/// get_budget(args: [1 agent index]): remaining budget as a decimal string.
export function get_budget(): void {
  const a = readInput();
  if (a.length != 1) { fail("bad args"); return; }
  const b = sget("b" + (<i32>a[0]).toString());
  returnBytes(utf8(b == null ? "0" : u128ToDec(b!)));
}

// ------------------------------------------------------------------ u128 (little-endian bytes)

function u128Le(a: Uint8Array, b: Uint8Array): bool { // a <= b
  for (let i = 15; i >= 0; i--) {
    if (a[i] != b[i]) return a[i] < b[i];
  }
  return true;
}

function u128Sub(a: Uint8Array, b: Uint8Array): Uint8Array { // a - b, assumes a >= b
  const out = new Uint8Array(16);
  let borrow = 0;
  for (let i = 0; i < 16; i++) {
    let d = <i32>a[i] - <i32>b[i] - borrow;
    borrow = d < 0 ? 1 : 0;
    if (d < 0) d += 256;
    out[i] = <u8>d;
  }
  return out;
}

function u128Add(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  let carry = 0;
  for (let i = 0; i < 16; i++) {
    const v = <i32>a[i] + <i32>b[i] + carry;
    out[i] = <u8>(v & 255);
    carry = v >> 8;
  }
  return out;
}

function u128IsZero(a: Uint8Array): bool {
  for (let i = 0; i < 16; i++) if (a[i] != 0) return false;
  return true;
}

function u128ToDec(a: Uint8Array): string {
  const n = new Uint8Array(16); n.set(a);
  if (u128IsZero(n)) return "0";
  let s = "";
  while (!u128IsZero(n)) {
    let rem = 0;
    for (let i = 15; i >= 0; i--) {
      const cur = (rem << 8) | <i32>n[i];
      n[i] = <u8>(cur / 10);
      rem = cur % 10;
    }
    s = String.fromCharCode(48 + rem) + s;
  }
  return s;
}

// ------------------------------------------------------------------ settlement

/// settle(args: [32 auction id][16 amount, u128 LE][1 len][seller account]). Called by an agent.
export function settle(): void {
  const nb = sget("n");
  if (nb == null) { fail("not configured"); return; }
  const paused = sget("paused");
  if (paused != null && paused!.length > 0 && paused![0] == 1) { fail("vault is paused"); return; }
  const intents = sget("intents");
  const token = sget("token");
  if (intents == null || token == null) { fail("settlement is not configured"); return; }

  const caller = predecessor();
  let agent = -1;
  for (let i = 0; i < <i32>nb![0]; i++) {
    const k = sget("a" + i.toString());
    if (k != null && eq(k!, caller)) { agent = i; break; }
  }
  if (agent < 0) { fail("caller is not one of this vault's agents"); return; }

  const a = readInput();
  if (a.length < 50) { fail("bad args"); return; }
  const auctionId = a.subarray(0, 32);
  const amount = a.slice(32, 48);
  const sl = <i32>a[48];
  if (49 + sl != a.length || sl < 2) { fail("bad seller"); return; }
  const seller = String.UTF8.decode(a.slice(49, 49 + sl).buffer);
  if (sget("S" + seller) == null) { fail("seller is not on the owner's allowlist"); return; }
  if (u128IsZero(amount)) { fail("amount must be positive"); return; }

  const used = new Uint8Array(34); used[0] = 0x75; used[1] = <u8>agent; used.set(auctionId, 2);
  if (!sgetBytesKey(used)) { fail("this agent did not enter this auction"); return; }
  const paidKey = new Uint8Array(34); paidKey.set(used); paidKey[0] = 0x70; // 'p'
  if (sgetBytesKey(paidKey)) { fail("this agent already paid for this auction"); return; }

  const bkey = "b" + agent.toString();
  const budget = sget(bkey);
  if (budget == null || !u128Le(amount, budget!)) { fail("amount exceeds this agent's budget"); return; }
  sset(bkey, u128Sub(budget!, amount));
  ssetBytesKey(paidKey, oneByte());

  const dec = u128ToDec(amount);
  const memo = "SealedSwarm auction 0x" + toHex(auctionId) + " agent " + (agent + 1).toString();
  // intents == token: pay directly with NEP-141 ft_transfer on the token (testnet, e.g. wrap.testnet);
  // otherwise move the vault's balance inside the NEAR Intents verifier with mt_transfer (mainnet).
  const direct = eq(intents!, token!);
  const args = direct
    ? utf8('{"receiver_id":"' + seller + '","amount":"' + dec + '","memo":"' + memo + '"}')
    : utf8('{"receiver_id":"' + seller + '","token_id":"nep141:' + String.UTF8.decode(token!.buffer) +
      '","amount":"' + dec + '","memo":"' + memo + '"}');
  const method = utf8(direct ? "ft_transfer" : "mt_transfer");
  const yocto = new Uint8Array(16); yocto[0] = 1;
  log("agent " + (agent + 1).toString() + " pays " + dec + " to " + seller + " for auction 0x" + toHex(auctionId) +
    (direct ? " with ft_transfer on " + String.UTF8.decode(token!.buffer) : " via NEAR Intents"));
  const p = promise_create(<u64>intents!.length, ptr(intents!), <u64>method.length, ptr(method), <u64>args.length, ptr(args), ptr(yocto), SETTLE_GAS);

  const cbArgs = new Uint8Array(49); cbArgs[0] = <u8>agent; cbArgs.set(auctionId, 1); cbArgs.set(amount, 33);
  const self = selfId();
  const cb = utf8("on_settled");
  const zero = new Uint8Array(16);
  const p2 = promise_then(p, <u64>self.length, ptr(self), <u64>cb.length, ptr(cb), <u64>cbArgs.length, ptr(cbArgs), ptr(zero), CALLBACK_GAS);
  promise_return(p2);
}

/// on_settled(args: [1 agent][32 auction][16 amount]): private callback; refunds the budget if
/// the transfer failed.
export function on_settled(): void {
  if (!eq(predecessor(), selfId())) { fail("private callback"); return; }
  const a = readInput();
  if (a.length != 49) { fail("bad args"); return; }
  const ok = promise_results_count() == 1 && promise_result(0, REG) == 1;
  if (ok) { log("settlement confirmed"); returnBytes(utf8("true")); return; }
  const agent = <i32>a[0];
  const bkey = "b" + agent.toString();
  const budget = sget(bkey);
  const restored = budget == null ? a.slice(33, 49) : u128Add(budget!, a.slice(33, 49));
  sset(bkey, restored);
  const paidKey = new Uint8Array(34); paidKey[0] = 0x70; paidKey[1] = <u8>agent; paidKey.set(a.subarray(1, 33), 2);
  storage_remove_key(paidKey);
  log("settlement failed; budget restored");
  returnBytes(utf8("false"));
}

/// has_bid(args: [1 agent index (0-based)][32 auction id]): "true" or "false".
export function has_bid(): void {
  const a = readInput();
  if (a.length != 33) { fail("bad args"); return; }
  const k = new Uint8Array(34); k[0] = 0x75; k[1] = a[0]; k.set(a.subarray(1, 33), 2);
  returnBytes(utf8(sgetBytesKey(k) ? "true" : "false"));
}
