// sign-step.ts — sign ONE ceremony step's 20 transactions with ONE device.
//
// WHY THIS EXISTS. The ceremony signs by STEP, not by transaction: all 20 chains
// of `deploy-token` are signed on device B, the operator swaps, all 20 are signed
// on device A, the step is validated, then the next step begins. Founder decision,
// and the right one — the alternative is ~120 device swaps across the deploy phase
// instead of 6, and every swap is a chance to sign with the wrong seat.
//
// Doing that by hand is 20 invocations of `ledger-signer sign` per device per step,
// each needing the correct file, path, output and flags. That is 240 hand-typed
// commands across the deploy phase, and a skipped or misdirected one is invisible
// until submit.
//
// This orchestrates the PINNED `ledger-signer` (tools-verified-v9) and does not
// modify it. Anything that touches a hardware wallet stays inside the tool covered
// by TOOL-INTEGRITY.md; this file only decides which files it is pointed at and
// checks its work afterwards.
//
// Usage:
//   PCO_NETWORK=mainnet01 npx tsx src/sign-step.ts 30-token --seat B
//   PCO_NETWORK=mainnet01 npx tsx src/sign-step.ts 30-token --seat B --dry-run
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import { NETWORK_ID } from './env.js';

const LEDGER_SIGNER = process.env.PCO_LEDGER_SIGNER ?? '/home/aflor/enterprise/ledger-signer';

type Cfg = { deviceA: string; deviceB: string; gasPayer: { publicKey: string } };
const cfg: Cfg = JSON.parse(readFileSync(new URL('../mainnet-config.json', import.meta.url), 'utf8'));

const die = (m: string): never => { console.error(`\nABORT: ${m}`); process.exit(1); };
const fromHex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const fromB64url = (s: string) =>
  new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
const b64url = (b: Uint8Array) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const prefix = process.argv[2];
const seatArg = (process.argv[process.argv.indexOf('--seat') + 1] ?? '').toUpperCase();
const dryRun = process.argv.includes('--dry-run');
if (!prefix || !['A', 'B'].includes(seatArg)) {
  console.error('usage: sign-step.ts <file-prefix> --seat A|B [--path <bip44>] [--dry-run]');
  console.error('  e.g. sign-step.ts 30-token --seat B');
  process.exit(2);
}

// Slot layout is fixed by build-tx's signer order: [gas softkey, device A, device B].
// Signing into the wrong slot produces a signature that cannot verify, which submit.ts
// would catch — but only after the devices are back in the safe.
const SEAT = seatArg as 'A' | 'B';
const slot = SEAT === 'A' ? 1 : 2;
const expectedPub = SEAT === 'A' ? cfg.deviceA : cfg.deviceB;
const path = process.argv[process.argv.indexOf('--path') + 1]?.startsWith('m/')
  ? process.argv[process.argv.indexOf('--path') + 1]
  : "m/44'/626'/0'/0/0";   // both active seats are index 0 on their own device

const outDir = fileURLToPath(new URL(`../out/${NETWORK_ID}/`, import.meta.url));
if (!existsSync(outDir)) die(`no built transactions at ${outDir} — run build-tx for this step first`);
const files = readdirSync(outDir)
  .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
  .sort((a, b) => (Number(a.match(/-c(\d+)\.json$/)?.[1] ?? 0) - Number(b.match(/-c(\d+)\.json$/)?.[1] ?? 0)));
if (files.length === 0) die(`no files matching "${prefix}*" in ${outDir}`);

console.log(`sign-step — ${files.length} transaction(s) matching "${prefix}*" on ${NETWORK_ID}`);
console.log(`  seat ${SEAT}  ->  slot ${slot}  ->  ${expectedPub.slice(0, 16)}…${expectedPub.slice(-8)}`);
console.log(`  path ${path}`);

// ---------------------------------------------------------------- hash sheet
// WRITTEN BEFORE ANY PROMPT, because the operator is watching the DEVICE, not
// this terminal. Scrolling back through 60 approvals to find the expected value
// is not a check anyone performs; a printed sheet beside the device is.
//
// Both encodings, both complete. The request key is base64url but the Nano may
// render hex, and a truncated hex column is useless for the one comparison it
// exists to support — which is exactly the mistake this fixes (founder, step 4).
const hexOf = (h: string) => Buffer.from(h.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex');
const sheetPath = `${outDir}HASHES-${prefix}.txt`;
{
  const rows = files.map((f) => {
    const tx = JSON.parse(readFileSync(`${outDir}${f}`, 'utf8'));
    const ch = f.match(/-c(\d+)\.json$/)?.[1] ?? '?';
    return `chain ${ch.padStart(2)}\n  base64url  ${tx.hash}\n  hex        ${hexOf(tx.hash)}\n`;
  });
  writeFileSync(sheetPath,
    `PCO ceremony — expected transaction hashes for "${prefix}*" on ${NETWORK_ID}\n` +
    `Compare against the DEVICE SCREEN. Signing order is top to bottom.\n` +
    `The device may render either encoding; both are given in full.\n\n${rows.join('\n')}`);
  console.log(`  hash sheet -> ${sheetPath}`);
  console.log(`  (open it beside the device; ${files.length} entries, in signing order)\n`);
}

// ---------------------------------------------------------------- TTL budget
// THE CLOCK STARTS AT BUILD, NOT AT SIGNING. On 2026-07-31 the gas-station step
// was built with ttl 7200 (2h), then 40 approvals plus a device swap took 126
// minutes; submit.ts refused the first transaction with "Tx time outside of
// valid range" and all 40 signatures were void. Nothing was lost but the
// operator's time — and the operator's time is the scarce resource here.
//
// So refuse UP FRONT rather than discovering it at submit. The budget must cover
// this device's approvals, the swap, the OTHER device's approvals, and submit.
// ~45s per approval is measured, not guessed: the 20-transaction gas-station
// round took roughly an hour per device on ~15 KB deploys.
{
  // MEASURED, not estimated. The 2026-07-31 gas-station step took 126 minutes for
  // 40 approvals plus one swap — about 166s per approval on ~15 KB deploys, once
  // scrolling and comparing a 64-char hash is included. An earlier version of this
  // guard used an optimistic 45s and would have PASSED the very 2h build that then
  // expired, which is the failure it exists to prevent. If a future step is
  // consistently faster, lower this from a measurement, never from a hope.
  const SEC_PER_APPROVAL = 170;
  const unsignedHere = files.filter((f) => !JSON.parse(readFileSync(`${outDir}${f}`, 'utf8')).sigs[slot]).length;
  const bothSlots = files.reduce((n, f) => {
    const s = JSON.parse(readFileSync(`${outDir}${f}`, 'utf8')).sigs;
    return n + (s[1] ? 0 : 1) + (s[2] ? 0 : 1);
  }, 0);
  const needSec = bothSlots * SEC_PER_APPROVAL + 15 * 60;   // + swap and submit
  const now = Math.floor(Date.now() / 1000);
  let minLeft = Infinity;
  for (const f of files) {
    const m = JSON.parse(JSON.parse(readFileSync(`${outDir}${f}`, 'utf8')).cmd).meta;
    minLeft = Math.min(minLeft, m.creationTime + m.ttl - now);
  }
  const mm = (s: number) => `${Math.floor(s / 60)} min`;
  console.log(`  TTL: ${mm(minLeft)} left · need ~${mm(needSec)} for ${bothSlots} remaining approval(s) + swap + submit`);
  if (minLeft <= 0) {
    die(`these transactions EXPIRED ${mm(-minLeft)} ago. Rebuild the step (build-tx) and re-sign — ` +
        `signatures cannot be reused because the hash covers creationTime.`);
  }
  if (minLeft < needSec) {
    die(`not enough TTL left: ${mm(minLeft)} remaining, ~${mm(needSec)} needed.\n` +
        `  Signing now would waste ${bothSlots} approvals on transactions that expire before submit.\n` +
        `  Rebuild the step first (build-tx), optionally with PCO_TTL=<seconds>.`);
  }
  if (unsignedHere === 0) console.log(`  (all ${files.length} already signed for seat ${SEAT})`);
}

// ---------------------------------------------------------------- device identity
// THE CHECK THAT EARNS THIS FILE. A Nano S+ swapped into the same USB port
// reappears on the SAME busid; nothing host-side distinguishes one from another.
// Without this, pointing at the wrong device signs 20 transactions with the wrong
// seat and the mistake surfaces at submit — after the devices are put away.
// Confirmed on 2026-07-30: a swapped device enumerated on the same busid as the one before it.
const sign = (args: string[]) =>
  String(execFileSync('pnpm', ['--filter', '@smartpacts/ledger-cli', 'exec', 'ledger-signer', ...args],
    { cwd: LEDGER_SIGNER, stdio: 'pipe' }));

// --dry-run signs nothing, so it must not require a device: its whole purpose is
// producing the hash sheet BEFORE the operator connects anything.
let onDevice: string;
if (dryRun) {
  console.log(`  --dry-run: skipping the device check (nothing will be signed)\n`);
  onDevice = expectedPub;
} else try {
  const out = sign(['keys', '--path', path]);
  onDevice = out.match(/Public Key:\s*([0-9a-f]{64})/)?.[1] ?? '';
} catch (e: any) {
  die(`could not read the device: ${String(e.stderr ?? e.message).slice(0, 200)}`);
}
if (!onDevice) die('could not parse a public key from ledger-signer');
if (onDevice !== expectedPub) {
  console.error(`\n  connected device derives : ${onDevice}`);
  console.error(`  seat ${SEAT} expects        : ${expectedPub}`);
  die(`WRONG DEVICE for seat ${SEAT}. Nothing has been signed. Connect the other device and re-run.`);
}
// NOT printed under --dry-run: nothing was checked, and a "CONFIRMED" line that
// confirms nothing is the precise shape of a gate that passes by omission.
if (!dryRun) console.log(`  device identity CONFIRMED — the connected device is seat ${SEAT}\n`);

// ---------------------------------------------------------------- sign each file
let signed = 0, skipped = 0;
for (const [i, f] of files.entries()) {
  const p = `${outDir}${f}`;
  const tx = JSON.parse(readFileSync(p, 'utf8')) as { cmd: string; hash: string; sigs: ({ sig: string } | null)[] };

  // The file's hash must recompute from cmd, or we are about to sign something
  // other than what the file claims to contain.
  const recomputed = b64url(blake2b(Buffer.from(tx.cmd, 'utf8'), undefined, 32));
  if (recomputed !== tx.hash) die(`${f}: hash does not recompute from cmd (file corrupt or tampered)`);

  const cmd = JSON.parse(tx.cmd);
  if (cmd.signers[slot]?.pubKey !== expectedPub) {
    die(`${f}: slot ${slot} expects ${cmd.signers[slot]?.pubKey?.slice(0, 16)}… not seat ${SEAT}. Wrong step or stale build.`);
  }

  if (tx.sigs[slot]) {
    // Already signed by this seat — verify it and move on. Re-running a step must
    // not double-prompt the operator through 20 approvals for nothing.
    const ok = nacl.sign.detached.verify(fromB64url(tx.hash), fromHex(tx.sigs[slot]!.sig), fromHex(expectedPub));
    if (!ok) die(`${f}: slot ${slot} already holds a signature that does NOT verify — rebuild this step`);
    console.log(`  [${String(i + 1).padStart(2)}/${files.length}] ${f}  already signed, verified`);
    skipped++;
    continue;
  }

  // The hash printed here is what the DEVICE SCREEN must show. Signatures in these
  // slots are UNSCOPED — deploys and define-namespace are keyset-enforced, so there
  // is no capability to scope to, and a substituted transaction would carry the full
  // authority of the governance keyset. Comparing this string against the device is
  // the only control left while clear-signing is a stub.
  console.log(`  [${String(i + 1).padStart(2)}/${files.length}] ${f}`);
  console.log(`         device must show ONE of these, in full:`);
  console.log(`           base64url  ${tx.hash}`);
  console.log(`           hex        ${hexOf(tx.hash)}`);
  if (dryRun) { skipped++; continue; }

  try {
    sign(['sign', p, '--path', path, '--hash', '--add', '-o', p]);
  } catch (e: any) {
    die(`${f}: signing failed (rejected on device?) — ${String(e.stderr ?? e.message).slice(0, 200)}\n` +
        `  ${signed} file(s) were signed before this. They are valid; re-run to continue.`);
  }

  // Verify what the device actually produced, here, before moving to the next file.
  // A wrong-slot or wrong-key signature caught now costs one approval; caught at
  // submit it costs the whole step.
  const after = JSON.parse(readFileSync(p, 'utf8')) as typeof tx;
  const s = after.sigs[slot];
  if (!s?.sig) die(`${f}: ledger-signer reported success but slot ${slot} is still empty`);
  if (!nacl.sign.detached.verify(fromB64url(after.hash), fromHex(s.sig), fromHex(expectedPub)))
    die(`${f}: the signature does NOT verify against seat ${SEAT}'s key — STOP, do not retry blindly`);
  if (after.hash !== tx.hash) die(`${f}: the hash CHANGED during signing — the file was rewritten underneath us`);
  console.log(`         signed and verified`);
  signed++;
}

// ---------------------------------------------------------------- report
console.log(`\n  seat ${SEAT}: ${signed} signed, ${skipped} already present`);
const remaining = files.filter((f) => {
  const tx = JSON.parse(readFileSync(`${outDir}${f}`, 'utf8'));
  return !tx.sigs[1] || !tx.sigs[2];
});
if (remaining.length === 0) {
  console.log(`  BOTH device slots filled on all ${files.length} file(s) — ready to submit.`);
} else {
  const needA = files.filter((f) => !JSON.parse(readFileSync(`${outDir}${f}`, 'utf8')).sigs[1]).length;
  const needB = files.filter((f) => !JSON.parse(readFileSync(`${outDir}${f}`, 'utf8')).sigs[2]).length;
  console.log(`  still unsigned — seat A: ${needA}, seat B: ${needB}. Swap devices and re-run with the other --seat.`);
}
