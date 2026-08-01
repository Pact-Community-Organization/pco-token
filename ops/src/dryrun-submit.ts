/**
 * dryrun-submit.ts — sign and submit ONE dry-run step, using the throwaway keys.
 *
 * A thin wrapper around submit.ts whose only job is to keep secret key material
 * off the command line and out of any transcript or shell history. It reads the
 * throwaway keys from the gitignored ops/out/mnet-dryrun-throwaway.json and
 * passes them to submit.ts, which does the actual verification and sending.
 *
 * THROWAWAY KEYS ONLY. It refuses to run if the key file is not the throwaway
 * one, and it has no path to a device or a production key.
 *
 *   npm run dryrun-submit -- <step>            # preflight only (default)
 *   npm run dryrun-submit -- <step> --send     # actually submit
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const step = process.argv[2];
const send = process.argv.includes('--send');
if (!step || step.startsWith('--')) {
  console.error('usage: dryrun-submit <step> [--send]');
  process.exit(1);
}

const keyPath = new URL('../out/mnet-dryrun-throwaway.json', import.meta.url);
if (!existsSync(keyPath)) {
  console.error('ABORT: throwaway key file not found — nothing to sign with');
  process.exit(1);
}
const keys = JSON.parse(readFileSync(keyPath, 'utf8'));
if (!String(keys.note ?? '').includes('THROWAWAY')) {
  console.error('ABORT: key file is not marked THROWAWAY — refusing to sign');
  process.exit(1);
}

const txPath = `out/mainnet01-dryrun/${step}.json`;
const tx = JSON.parse(readFileSync(new URL(`../${txPath}`, import.meta.url), 'utf8'));
const signerPubs: string[] = JSON.parse(tx.cmd).signers.map((s: any) => s.pubKey);

// map each signer slot to the throwaway secret that owns it; refuse on a gap,
// because a partially-signed ceremony file is worse than none
const secrets: string[] = [];
for (const pub of signerPubs) {
  const entry = Object.entries(keys).find(
    ([k, v]: [string, any]) => k !== 'note' && v?.publicKey === pub,
  );
  if (!entry) {
    console.error(`ABORT: no throwaway key for signer slot ${pub.slice(0, 16)}…`);
    process.exit(1);
  }
  secrets.push((entry[1] as any).secretKey);
}

console.log(`step        ${step}`);
console.log(`file        ${txPath}`);
console.log(`signers     ${signerPubs.length}`);
for (const p of signerPubs) {
  const name = Object.entries(keys).find(([k, v]: any) => k !== 'note' && v?.publicKey === p)?.[0];
  console.log(`  ${name?.padEnd(6)} ${p}`);
}
console.log(`mode        ${send ? 'SEND (mainnet01)' : 'preflight only'}`);
console.log('---');

const args = ['tsx', 'src/submit.ts', txPath];
for (const s of secrets) args.push('--sign-with', s);
if (send) args.push('--send');

const r = spawnSync('npx', args, {
  stdio: 'inherit',
  env: { ...process.env, PCO_NETWORK: 'mainnet01', PCO_HOST: 'https://api.chainweb-community.org' },
});
process.exit(r.status ?? 1);
