// verify-deployed.ts — prove the DEPLOYED modules match this repository.
//
// The automated backbone of the "verify it yourself" story (docs/VERIFYING.md)
// and a post-deploy regression guard: for each module it fetches the on-chain
// `code` via describe-module and byte-compares it to the local contract's
// (module …) form. Also reports the module hash per chain (they must be
// uniform across all 20). Read-only — never signs, never submits.
//
// Usage:
//   PCO_NS=user npx tsx src/verify-deployed.ts            # devnet, hub only
//   PCO_NETWORK=mainnet01 PCO_HOST=https://api.chainweb-community.org \
//     PCO_NS=n_<hash> npx tsx src/verify-deployed.ts --all-chains
import { readFileSync } from 'node:fs';
import { CHAINS, HUB, NS, localCall } from './env.js';
import { NEEDS_BLESS } from './freeze-source.js';

const MODULES = ['pco', 'pco-claim', 'pco-gas-station'] as const;
const contractFile = (m: string) =>
  readFileSync(new URL(`../../contracts/${m}.pact`, import.meta.url), 'utf8');

// The stored on-chain `code` is the module's `(module …)` form (header comments,
// namespace line, define-keyset, and footer are tx payload, not stored code).
// Extract the same span from the local file: from the first `(module ` to its
// matching close paren.
function localModuleForm(src: string): string {
  const start = src.indexOf('(module ');
  if (start < 0) throw new Error('no (module …) form found');
  let depth = 0, inStr = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }   // skip escaped char inside a string
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === ';') { while (i < src.length && src[i] !== '\n') i++; continue; }  // line comment
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced parens in module form');
}

const chains = process.argv.includes('--all-chains') ? CHAINS : [HUB];

async function main() {
  console.log(`verify-deployed — ns=${NS}, ${chains.length} chain(s)`);
  let ok = true;

  for (const m of MODULES) {
    const qualified = `${NS}.${m}`;
    const localForm = localModuleForm(contractFile(m)).trim();
    const hashes = new Map<string, string[]>();  // hash -> chains
    const stale = new Map<string, string[]>();   // hash -> chains whose code differs from the repo

    for (const ch of chains) {
      let deployed: string, hash: string;
      try {
        deployed = String(await localCall(`(at 'code (describe-module "${qualified}"))`, ch)).trim();
        hash = String(await localCall(`(at 'hash (describe-module "${qualified}"))`, ch));
      } catch (e: any) {
        console.log(`  ✗ ${qualified} @${ch}: not deployed / unreadable (${String(e.message).slice(0, 60)})`);
        ok = false; continue;
      }
      (hashes.get(hash) ?? hashes.set(hash, []).get(hash)!).push(ch);
      if (deployed !== localForm) {
        // This chain runs OTHER code than the repo, so the repo represents a pending
        // upgrade and `hash` is a predecessor the new source has to bless. Where the
        // code MATCHES, `hash` is this very source's hash — a module does not bless
        // itself, and demanding it would fail every check right after a clean deploy.
        (stale.get(hash) ?? stale.set(hash, []).get(hash)!).push(ch);
        console.log(`  ✗ ${qualified} @${ch}: DEPLOYED CODE DIFFERS from the repo`);
        // point at the first divergence to make triage quick
        const n = Math.min(deployed.length, localForm.length);
        let i = 0; while (i < n && deployed[i] === localForm[i]) i++;
        console.log(`      first difference at byte ${i}: repo …${JSON.stringify(localForm.slice(i, i + 40))}`);
        console.log(`                                   chain …${JSON.stringify(deployed.slice(i, i + 40))}`);
        ok = false;
      }
    }

    if (hashes.size === 1) {
      const [[hash, chs]] = [...hashes];
      // Hash uniformity and code-match are DIFFERENT facts, and this line used to
      // assert both from evidence for only one: it printed "code matches the repo"
      // whenever the hash was uniform, so a repo ahead of the chain produced a ✗
      // mismatch line immediately followed by a ✓ claiming a match. Mid-ceremony
      // that reads as all-clear.
      const matches = stale.size === 0;
      console.log(`  ${matches ? '✓' : '✗'} ${qualified}: ` +
        `${matches ? 'code matches the repo' : 'code DIFFERS from the repo (above)'}; ` +
        `uniform hash ${hash} across ${chs.length} chain(s)`);
    } else if (hashes.size > 1) {
      console.log(`  ✗ ${qualified}: NON-UNIFORM hashes across chains (a partial/forked deploy):`);
      for (const [h, chs] of hashes) console.log(`      ${h} on chains ${chs.join(',')}`);
      ok = false;
    }

    // the chain-local voting design C1: before `pco` can be upgraded, the new source must bless the
    // hash that is ACTUALLY DEPLOYED. build-tx's gate only checks that SOME bless
    // form exists, which a stale one satisfies — and a stale bless is worse than
    // none, because it looks like the hazard was handled. Only the chain can settle
    // which hash that is, so it is checked here and not in a unit test.
    if (NEEDS_BLESS.has(m) && stale.size > 0) {
      const blessed = [...localModuleForm(contractFile(m)).matchAll(/\(bless\s+"([^"]*)"\s*\)/g)]
        .map((x) => x[1]);
      const unblessed = [...stale.entries()].filter(([h]) => !blessed.includes(h));
      if (unblessed.length === 0) {
        console.log(`  ✓ ${qualified}: the pending upgrade blesses every hash it replaces ` +
                    `(${[...stale.keys()].join(', ')}) — no pin breaks between the two deploys`);
      } else {
        console.log(`  ✗ ${qualified}: the repo source does NOT bless the deployed hash. An upgrade`);
        console.log(`      built from it strands in-flight cross-chain transfers and breaks every`);
        console.log(`      dependent pin. Add these to the module header before building:`);
        for (const [h, chs] of unblessed) console.log(`        (bless "${h}")   ; live on chain(s) ${chs.join(',')}`);
        if (blessed.length) console.log(`      (source currently blesses: ${blessed.join(', ')})`);
        ok = false;
      }
    }
  }

  // table-existence probe (audit F1): a chain deployed in UPGRADE mode that
  // misses a late-added table BRICKS every debit (the release path reads
  // rcv-actives) — verify every one on every verified chain, always.
  const LATE = ['vote-delegates', 'rcv-proposals', 'rcv-ballots', 'rcv-actives', 'ops-auth', 'rcv-margins', 'non-voting'];
  // station-info holds the station's own account name; the station guard reads
  // it, so a chain missing it cannot sponsor a claim (it fails closed to the
  // admin branch, but onboarding is dead there until the table is created).
  const LATE_STATION = ['station-info'];
  for (const ch of chains) {
    for (const tbl of LATE) {
      const present = await localCall(`(take 1 (keys ${NS}.pco.${tbl}))`, ch)
        .then(() => true).catch(() => false);
      if (!present) { ok = false; console.log(`  ✗ MISSING TABLE ${NS}.pco.${tbl} on chain ${ch} — debits on that chain will abort`); }
    }
  }
  for (const ch of chains) {
    for (const tbl of LATE_STATION) {
      const present = await localCall(`(take 1 (keys ${NS}.pco-gas-station.${tbl}))`, ch)
        .then(() => true).catch(() => false);
      if (!present) { ok = false; console.log(`  ✗ MISSING TABLE ${NS}.pco-gas-station.${tbl} on chain ${ch} — sponsored claims will fail there`); }
    }
  }
  if (ok) console.log(`  ✓ late-added tables (${[...LATE, ...LATE_STATION].join(', ')}) present on ${chains.length} chain(s)`);

  console.log(ok ? '\nALL VERIFIED — deployed modules match the repository.'
                 : '\nMISMATCH — see above. DO NOT trust the deployment until resolved.');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('verify aborted:', e.message ?? e); process.exit(1); });
