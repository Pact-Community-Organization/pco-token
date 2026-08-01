// submit.ts — attach signatures to an emitted ceremony tx, verify, submit, poll.
//
// The missing third leg of the ceremony pipeline (build-tx.ts emits unsigned,
// devices hash-sign): this tool takes the emitted JSON + the device signatures
// (hex, from `ledger-signer --hash`), fills the gas-softkey slot itself, and
// only after EVERY signature verifies locally does it POST /send and poll.
//
// Usage:
//   npx tsx src/submit.ts <out/<network>/NN-step.json> \
//     --sig <64-hex-pubkey>=<128-hex-signature>   (repeat per device slot)
//     --sign-with <64-hex-secret>                 (softkey slots: sign locally;
//                                                  repeatable; matches its own pubkey)
//     [--send]                                    (default: preflight /local only —
//                                                  nothing hits the mempool without --send)
//
// Guards (all fail-closed):
//   * the file's networkId must equal the harness NETWORK_ID (PCO_NETWORK) —
//     a devnet-built file can never be pushed at mainnet by accident;
//   * the file's hash must recompute from cmd (blake2b-256, base64url);
//   * every signer slot must be filled and every signature must ed25519-verify
//     against its slot pubkey BEFORE anything leaves this machine;
//   * the mined request key must equal the hash.
//
// TTL note: signatures are over the hash; the cmd carries creationTime+ttl
// (2h for ceremony files) — if the TTL has lapsed, rebuild + re-sign.
import { readFileSync } from 'node:fs';
import { blake2b } from 'blakejs';
import nacl from 'tweetnacl';
import { NETWORK_ID, client } from './env.js';

type Emitted = { cmd: string; hash: string; sigs: ({ sig: string } | null)[] };

const b64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) =>
  new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
const fromHex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

function die(msg: string): never { console.error(`ABORT: ${msg}`); process.exit(1); }

// ---------- args ----------
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) die('usage: submit.ts <emitted.json> --sig pub=sighex ... [--sign-with secrethex] [--send]');
const sigArgs = new Map<string, string>();   // pubkey -> signature hex
const signWith: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sig') {
    const [pub, sig] = (args[++i] ?? '').split('=');
    if (!/^[0-9a-f]{64}$/.test(pub ?? '') || !/^[0-9a-f]{128}$/.test(sig ?? ''))
      die(`--sig wants <64-hex-pubkey>=<128-hex-signature>, got: ${pub}=${(sig ?? '').slice(0, 16)}…`);
    sigArgs.set(pub, sig);
  } else if (args[i] === '--sign-with') {
    const sec = args[++i] ?? '';
    if (!/^[0-9a-f]{64}$/.test(sec)) die('--sign-with wants a 64-hex ed25519 secret (softkey only)');
    signWith.push(sec);
  }
}
const doSend = args.includes('--send');

// ---------- load + integrity ----------
const tx: Emitted = JSON.parse(readFileSync(file, 'utf8'));
const cmd = JSON.parse(tx.cmd);
if (cmd.networkId !== NETWORK_ID)
  die(`file networkId=${cmd.networkId} but this harness targets ${NETWORK_ID} (set PCO_NETWORK deliberately)`);
const recomputed = b64url(blake2b(new TextEncoder().encode(tx.cmd), undefined, 32));
if (recomputed !== tx.hash) die(`hash mismatch: file says ${tx.hash}, cmd hashes to ${recomputed}`);
const hashBytes = fromB64url(tx.hash);

// ---------- fill slots ----------
const signers: { pubKey: string }[] = cmd.signers;
const sigs: { sig: string }[] = [];
for (const sec of signWith) {
  const kp = nacl.sign.keyPair.fromSeed(fromHex(sec));
  const pub = Buffer.from(kp.publicKey).toString('hex');
  const sig = Buffer.from(nacl.sign.detached(hashBytes, kp.secretKey)).toString('hex');
  sigArgs.set(pub, sig);
}
for (const s of signers) {
  const sig = sigArgs.get(s.pubKey);
  if (!sig) die(`no signature supplied for signer slot ${s.pubKey.slice(0, 12)}… (${signers.length} slots total)`);
  if (!nacl.sign.detached.verify(hashBytes, fromHex(sig), fromHex(s.pubKey)))
    die(`signature for ${s.pubKey.slice(0, 12)}… does NOT verify against the hash — wrong device/slot? DO NOT retry blindly`);
  sigs.push({ sig });
}
console.log(`✓ ${signers.length}/${signers.length} signatures verified locally against ${tx.hash}`);
console.log(`  network ${cmd.networkId} · chain ${cmd.meta.chainId} · gasLimit ${cmd.meta.gasLimit} · sender ${cmd.meta.sender}`);

// ---------- preflight, then (only with --send) submit + poll ----------
const signed = { cmd: tx.cmd, hash: tx.hash, sigs } as any;
const pre = await client.local(signed, { preflight: true, signatureVerification: true });
if (pre.result.status !== 'success')
  die(`preflight FAILED (nothing submitted): ${JSON.stringify((pre.result as any).error).slice(0, 300)}`);
console.log(`✓ preflight success (gas ${pre.gas})`);
if (!doSend) { console.log('dry run only — re-run with --send to submit'); process.exit(0); }

const desc = await client.submit(signed);
if (desc.requestKey !== tx.hash) die(`request key ${desc.requestKey} != hash ${tx.hash}`);
console.log(`→ submitted, request key ${desc.requestKey}; polling…`);
const r = await client.pollOne(desc, { timeout: 300_000, interval: 3_000 });
if (r.result.status !== 'success')
  die(`tx FAILED on-chain: ${JSON.stringify((r.result as any).error).slice(0, 300)}`);
console.log(`✓ MINED gas=${r.gas} result=${JSON.stringify((r.result as any).data).slice(0, 120)}`);
