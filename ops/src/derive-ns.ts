// derive-ns.ts — compute the principal namespace name OFFLINE.
//
// WHY OFFLINE. The RUNBOOK used to derive this by posting
// `(ns.create-principal-namespace (read-keyset 'pco-gov))` to a PUBLIC node as
// `/local`, with the full three-key governance keyset in env-data. That is step 1
// of the cold audit's MEDIUM-1 exploit path, verbatim: publishing the keyset lets
// anyone derive `n_<hash>`, and a first-time `define-namespace` enforces no
// signature, so they can create it, take the USER guard, and first-define
// `<ns>.pco-gov` as their own keyset — which governance can never reclaim.
//
// Atomicity in build-tx is what actually closes that window (the ceremony
// transaction carries the keyset in addData anyway, so secrecy alone never could).
// This removes the gratuitous early disclosure: there is no reason to publish the
// keyset DAYS before the ceremony when the answer is computable locally.
//
// It is computed against `tests/fixtures/mainnet-ns.pact` — the live mainnet01
// `ns` module fetched byte-true via describe-module — so this is the same code
// mainnet will run, not a reimplementation of the derivation.
//
// Usage:  npx tsx src/derive-ns.ts            # from ops/, reads mainnet-config.json
//         npx tsx src/derive-ns.ts --check    # also assert it equals cfg.ns
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Cfg = { ns: string; deviceA: string; deviceB: string; deviceC: string };
const cfg: Cfg = JSON.parse(readFileSync(new URL('../mainnet-config.json', import.meta.url), 'utf8'));

const keys = [cfg.deviceA, cfg.deviceB, cfg.deviceC];
if (keys.some((k) => !/^[0-9a-f]{64}$/.test(k ?? ''))) {
  console.error('ABORT: deviceA/B/C must all be 64-hex pubkeys before the namespace can be derived');
  process.exit(1);
}
if (new Set(keys).size !== 3) {
  console.error('ABORT: deviceA/B/C are not three distinct keys — the namespace would encode a collapsed keyset');
  process.exit(1);
}

const fixtures = fileURLToPath(new URL('../../tests/fixtures/', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'derive-ns-'));
const repl = join(dir, 'derive.repl');
writeFileSync(repl, `
(begin-tx)
(env-data { "pco-gov": { "keys": ${JSON.stringify(keys)}, "pred": "keys-2" } })
(load "${fixtures}mainnet-ns.pact")
(print (concat ["NS=" (ns.create-principal-namespace (read-keyset 'pco-gov))]))
(commit-tx)
`);

let out = '';
try {
  out = String(execFileSync('pact', [repl], { stdio: 'pipe' }));
} catch (e: any) {
  console.error('ABORT: pact failed to evaluate the derivation');
  console.error(String(e.stdout ?? '') + String(e.stderr ?? ''));
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const ns = out.match(/NS=(n_[a-f0-9]{40})/)?.[1];
if (!ns) { console.error(`ABORT: could not parse a namespace from pact output:\n${out.slice(0, 400)}`); process.exit(1); }

console.log(ns);

if (process.argv.includes('--check')) {
  if (cfg.ns !== ns) {
    console.error(`\nMISMATCH: ops/mainnet-config.json records "${cfg.ns}" but the keyset derives "${ns}".`);
    console.error('The namespace is a pure function of deviceA/B/C + pred keys-2. If a device key');
    console.error('changed, the namespace changes with it — and it is created on-chain irreversibly.');
    process.exit(1);
  }
  console.log('  matches ops/mainnet-config.json');
}
