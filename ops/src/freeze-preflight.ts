// freeze-preflight.ts — everything that must be TRUE on chain before a freeze,
// checked against the chain rather than asserted by an operator.
//
// The freeze is irreversible in a way nothing else here is. `create-table`
// becomes impossible forever, module admin becomes unobtainable forever, and any
// module hash not blessed by the freezing deploy becomes unreachable forever. So
// none of the checks below are advisory: `build-tx.ts freeze` refuses to WRITE a
// transaction unless every one of them passes.
//
//   npx tsx src/freeze-preflight.ts pco          # read-only, run it as often as you like
import { localCall, CHAINS, NS as ENV_NS } from './env.js';
import { readFileSync, existsSync } from 'node:fs';

// The namespace MUST be supplied by the caller, because the caller is what
// decides which namespace is being frozen. build-tx.ts reads it from
// ops/mainnet-config.json (`cfg.ns`); env.ts has its own PCO_NS default of
// `free`. Those two are NOT the same value, and an earlier draft of this file
// read env.ts's — so the preflight would happily verify tables and hashes in one
// namespace while build-tx froze a module in another. That is the same
// cross-artifact disagreement class as everything else in this remediation, so
// the namespace is now a required argument and the default is only a fallback
// for the standalone CLI.

// The late-added tables, per module. THIS IS THE SAME LIST as `LATE` in
// verify-deployed.ts and `LATE_TABLES` in rehearse.ts, and the canonical copy is
// RUNBOOK.md §D. All of them were out of sync at once (4 / 5 / 8) until
// 2026-07-29; if you add a table, it goes in all of them.
export const LATE_TABLES: Record<string, string[]> = {
  pco: ['vote-delegates', 'rcv-proposals', 'rcv-ballots', 'rcv-actives',
        'ops-auth', 'rcv-margins', 'non-voting'],
  'pco-claim': [],
  'pco-gas-station': ['station-info'],
};

export type Preflight = {
  ok: boolean;
  hashes: string[];          // every hash the freezing deploy must bless
  problems: string[];
};

/** Read the deployed module hash on every chain and require them identical. */
async function deployedHashes(NS: string, module: string, chains: string[]) {
  const byChain = new Map<string, string>();
  const problems: string[] = [];
  for (const ch of chains) {
    try {
      const h = await localCall(`(at 'hash (describe-module "${NS}.${module}"))`, ch);
      byChain.set(ch, String(h));
    } catch (e: any) {
      problems.push(`chain ${ch}: cannot read ${NS}.${module} hash — ${String(e.message ?? e).slice(0, 120)}`);
    }
  }
  return { byChain, problems };
}

export async function freezePreflight(ns: string, module: string, chains = CHAINS): Promise<Preflight> {
  const NS = ns;
  const problems: string[] = [];

  // ---- 0. the station must never be frozen at all -------------------------
  if (module === 'pco-gas-station') {
    problems.push(
      'the gas station must NEVER be frozen: withdraw calls coin.transfer, so it ' +
      'pins coin at runtime. A frozen station cannot bless a future coin hash and ' +
      'the float becomes unrecoverable. Its deploy footer refuses the flag outright.',
    );
    return { ok: false, hashes: [], problems };
  }

  // ---- 1. every late-added table exists on every chain --------------------
  // A chain missing rcv-actives has NO on-chain recovery after the freeze:
  // create-table is impossible, and every exit from the pool is a debit, which
  // is exactly what the missing table blocks. pool-balance keeps reporting a
  // healthy balance the whole time, so this cannot be caught by monitoring.
  for (const [mod, tables] of Object.entries(LATE_TABLES)) {
    for (const ch of chains) {
      for (const tbl of tables) {
        const present = await localCall(`(take 1 (keys ${NS}.${mod}.${tbl}))`, ch)
          .then(() => true).catch(() => false);
        if (!present) {
          problems.push(`chain ${ch}: MISSING TABLE ${NS}.${mod}.${tbl} — freezing now strands that chain permanently`);
        }
      }
    }
  }

  // ---- 2. the deployed hash is uniform across all 20 chains ---------------
  const { byChain, problems: hp } = await deployedHashes(NS, module, chains);
  problems.push(...hp);
  const distinct = [...new Set(byChain.values())];
  if (distinct.length > 1) {
    problems.push(
      `the deployed hash is NOT uniform across chains (${distinct.length} distinct): ` +
      [...byChain.entries()].map(([c, h]) => `c${c}=${h.slice(0, 12)}…`).join(' ') +
      ' — freeze one code version, never a mixture',
    );
  }
  if (byChain.size !== chains.length) {
    problems.push(`read the hash from only ${byChain.size}/${chains.length} chains`);
  }

  // ---- 3. every hash an in-flight cross-chain defpact could resume against
  // must be blessed.
  //
  // WHAT THIS REPLACES, and why. The remediation brief asked for a scan of all
  // 20 chains for unpaired `pact.X_YIELD` events. That cannot be built against a
  // verified surface here: this chainweb node exposes no event query (/event,
  // /events and /txs/events are all 404) and no chainweb-data instance is
  // deployed, so an event-level reconciler would rest on an endpoint nobody has
  // confirmed. Rather than ship a best-effort scan that reports "0 in flight"
  // when it simply could not look, the same goal is met deterministically:
  //
  //   an in-flight defpact resumes against the module hash it STARTED under, so
  //   the set of hashes that must be blessed is exactly {every hash this module
  //   has ever been deployed with}. That set does not require an indexer - it is
  //   the deploy history, which we control and record.
  //
  // Strictly stronger than an event scan: it needs no live query, cannot report a
  // false zero, and covers a defpact started before ANY earlier upgrade. It is
  // also cheap - a bless form costs nothing and only widens what can resolve.
  //
  // deployed-hashes.json is written by the deploy steps and committed. If it is
  // absent we can still be safe on a first freeze, because the uniform current
  // hash is then the only hash that ever existed; that is asserted, not assumed.
  const histPath = new URL('../deployed-hashes.json', import.meta.url);
  let history: string[] = [];
  if (existsSync(histPath)) {
    const j = JSON.parse(readFileSync(histPath, 'utf8'));
    history = (j[module] ?? []) as string[];
  } else {
    problems.push(
      'ops/deployed-hashes.json is absent. On a FIRST freeze that is fine — the ' +
      'uniform current hash is the only hash that has ever existed — but confirm ' +
      'that no upgrade has ever been deployed, then create the file with the ' +
      'current hash so this check has something to verify. If any upgrade HAS ' +
      'shipped, its pre-upgrade hash MUST be listed or in-flight cross-chain ' +
      'transfers started under it can never resume.',
    );
  }

  const hashes = [...new Set([...distinct, ...history])];

  // ---- 4. the cross-chain quiet window ------------------------------------
  // Blessing every historical hash makes an in-flight transfer survivable, but
  // it is still better not to have one: announce a cross-chain quiet window
  // before the freeze, as RUNBOOK §D already requires for upgrades.
  console.log(`\nfreeze preflight — ${NS}.${module} on ${chains.length} chain(s)`);
  console.log(`  hashes to bless: ${hashes.length ? hashes.join(', ') : '(none resolved)'}`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  if (!problems.length) console.log('  ✓ all freeze preconditions satisfied');

  return { ok: problems.length === 0 && hashes.length > 0, hashes, problems };
}

// Runnable on its own: read-only, so it can be run repeatedly before the ceremony.
if (import.meta.url === `file://${process.argv[1]}`) {
  const mod = process.argv[2] ?? 'pco';
  // Standalone CLI: falls back to env.ts's PCO_NS. The ceremony path always
  // passes build-tx's cfg.ns explicitly.
  freezePreflight(process.env.PCO_NS ?? ENV_NS, mod).then((r) => {
    console.log(r.ok ? '\nFREEZE PRECONDITIONS MET' : '\nNOT SAFE TO FREEZE — resolve the above');
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => { console.error('preflight aborted:', e.message ?? e); process.exit(1); });
}
