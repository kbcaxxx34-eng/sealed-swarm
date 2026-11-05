// SwarmVault — a NEAR contract that controls a swarm of bidding agents.
//
// Agents never hold an Ethereum key and never hold a full-access NEAR key. Each agent holds a
// function-call key on the owner's account that can only call `request_sign` on this vault.
// The vault checks every request against the owner's policy, then asks the NEAR MPC network to
// sign the Ethereum transaction for that agent's derived address (path sealedswarm-agent-<n>).
//
// Policy enforced on-chain, per request:
//   - the caller is the owner account and the key used is a registered agent key
//   - the vault is not paused
//   - the Ethereum transaction is EIP-1559 on Sepolia (chain id 11155111)
//   - it calls the approved auction contract, function placeBid(uint256,bytes32,bytes), with no ETH value
//   - gas limit and max fee per gas are under the owner's caps
//   - each agent bids at most once per auction
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
@external("env", "storage_read") declare function storage_read(key_len: u64, key_ptr: u64, register_id: u64): u64;
@external("env", "predecessor_account_id") declare function predecessor_account_id(register_id: u64): void;
@external("env", "signer_account_pk") declare function signer_account_pk(register_id: u64): void;
@external("env", "keccak256") declare function keccak256(value_len: u64, value_ptr: u64, register_id: u64): void;
@external("env", "promise_create") declare function promise_create(account_id_len: u64, account_id_ptr: u64, method_name_len: u64, method_name_ptr: u64, arguments_len: u64, arguments_ptr: u64, amount_ptr: u64, gas: u64): u64;
@external("env", "promise_return") declare function promise_return(promise_idx: u64): void;

const REG: u64 = 0;
const MPC_ACCOUNT = "v1.signer-prod.testnet";
const SIGN_GAS: u64 = 250_000_000_000_000; // 250 Tgas for the MPC sign call
const PATH_PREFIX = "sealedswarm-agent-";
const SEPOLIA_CHAIN_ID: StaticArray<u8> = [0xaa, 0x36, 0xa7]; // 11155111
const PLACE_BID_SELECTOR: StaticArray<u8> = [0x3e, 0xc0, 0x4a, 0x7d]; // placeBid(uint256,bytes32,bytes)
const MAX_AGENTS: i32 = 16;

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

function ownerOrFail(): void {
  const owner = sget("owner");
  if (owner == null) { fail("not configured"); return; }
  if (!eq(predecessor(), owner!)) fail("only the owner can do this");
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

/// configure(args): first call sets the caller as owner; later calls must come from the owner.
/// Binary args: [20 auction][1 n_fee][fee BE][1 n_gas][gas BE][1 n_agents][n_agents x 32 ed25519 keys]
export function configure(): void {
  const owner = sget("owner");
  if (owner == null) sset("owner", predecessor());
  else ownerOrFail();

  const a = readInput();
  let p = 0;
  if (a.length < 23) { fail("bad config"); return; }
  sset("auction", a.slice(p, p + 20)); p += 20;
  const nf = <i32>a[p]; p += 1; sset("maxfee", a.slice(p, p + nf)); p += nf;
  const ng = <i32>a[p]; p += 1; sset("maxgas", a.slice(p, p + ng)); p += ng;
  const n = <i32>a[p]; p += 1;
  if (n < 1 || n > MAX_AGENTS) { fail("1 to 16 agents"); return; }
  if (a.length != p + n * 32) { fail("bad agent keys"); return; }
  for (let i = 0; i < n; i++) {
    const pk = new Uint8Array(33); // borsh PublicKey: 0 = ed25519, then 32 bytes
    pk[0] = 0;
    pk.set(a.subarray(p + i * 32, p + i * 32 + 32), 1);
    sset("a" + i.toString(), pk);
  }
  const nb = new Uint8Array(1); nb[0] = <u8>n; sset("n", nb);
  const z = new Uint8Array(1); sset("paused", z);
  log("SwarmVault configured with " + n.toString() + " agents");
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
/// Called by an agent through its function-call key on the owner account.
export function request_sign(): void {
  const paused = sget("paused");
  if (paused != null && paused!.length > 0 && paused![0] == 1) { fail("vault is paused"); return; }
  ownerOrFail();

  // which agent? identified by the public key that signed this transaction
  signer_account_pk(REG);
  const pk = readRegister();
  const nb = sget("n");
  if (nb == null) { fail("not configured"); return; }
  const n = <i32>nb![0];
  let agent = -1;
  for (let i = 0; i < n; i++) {
    const k = sget("a" + i.toString());
    if (k != null && eq(k!, pk)) { agent = i; break; }
  }
  if (agent < 0) { fail("this key is not a registered agent"); return; }

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
  if (d.length < 36 || !eqStatic(d.subarray(0, 4), PLACE_BID_SELECTOR)) { fail("only placeBid is allowed"); return; }
  if (nonce.isList || prio.isList) { fail("malformed transaction"); return; }

  // one bid per agent per auction
  const usedKey = new Uint8Array(1 + 1 + 32);
  usedKey[0] = 0x75; // 'u'
  usedKey[1] = <u8>agent;
  usedKey.set(d.subarray(4, 36), 2);
  if (sgetBytesKey(usedKey)) { fail("this agent already bid on this auction"); return; }
  const one = new Uint8Array(1); one[0] = 1;
  ssetBytesKey(usedKey, one);

  // payload = keccak256(0x02 || rlp(...)), signed for this agent's path
  keccak256(<u64>tx.length, ptr(tx), REG);
  const payload = readRegister();
  const path = PATH_PREFIX + (agent + 1).toString();
  const args = utf8('{"request":{"payload_v2":{"Ecdsa":"' + toHex(payload) + '"},"path":"' + path + '","domain_id":0}}');
  const acc = utf8(MPC_ACCOUNT);
  const method = utf8("sign");
  const amount = new Uint8Array(16); amount[0] = 1; // 1 yoctoNEAR, paid by the vault
  log("agent " + (agent + 1).toString() + " bid on auction 0x" + toHex(d.subarray(4, 36)) + " approved by policy");
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
  const json = '{"configured":true,"owner":"' + String.UTF8.decode(owner!.buffer) +
    '","auction":"0x' + toHex(auction) + '","agents":' + (<i32>n[0]).toString() +
    ',"max_fee_per_gas_hex":"0x' + toHex(sget("maxfee")!) + '","max_gas_hex":"0x' + toHex(sget("maxgas")!) +
    '","paused":' + (isPaused ? "true" : "false") + ',"mpc":"' + MPC_ACCOUNT + '","path_prefix":"' + PATH_PREFIX + '"}';
  returnBytes(utf8(json));
}

/// has_bid(args: [1 agent index (0-based)][32 auction id]): "true" or "false".
export function has_bid(): void {
  const a = readInput();
  if (a.length != 33) { fail("bad args"); return; }
  const k = new Uint8Array(34); k[0] = 0x75; k[1] = a[0]; k.set(a.subarray(1, 33), 2);
  returnBytes(utf8(sgetBytesKey(k) ? "true" : "false"));
}
