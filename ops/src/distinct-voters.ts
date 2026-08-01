// distinct-voters.ts — the honest-numbers query for a proposal.
//
// The program promises to publish "honest participation numbers (distinct
// accounts) after every close". The weighted tally alone cannot do that: one
// account holding 5,000 PCO and fifty accounts holding 100 each produce the same
// turnout. This reports the ACCOUNT dimension alongside the weight dimension.
//
// Source of truth: the ballot table itself. Every cast-vote writes a row keyed
// "<pid>:<account>" (pco.pact, cast-vote-internal), and Pact has no row
// deletion, so the row set IS the exact set of accounts that cast a ballot —
// authoritative, one read, no block scan, no indexer, no pagination.
//
// (An earlier version scanned block payloads over a height range. That was both
// fragile and wrong here: it read `results.yes/no/abstain`, fields that stopped
// existing at the ranked-choice migration, and it hit
// /block/height/{h}/payload, which this node answers 404 — so it could only
// ever report zero. Fixed 2026-07-25 after the external audit flagged it.)
//
// Usage:
//   PCO_NS=user npx tsx src/distinct-voters.ts <proposal-id>
//   PCO_NS=user npx tsx src/distinct-voters.ts --all
//   PCO_NETWORK=mainnet01 PCO_HOST=https://api.chainweb-community.org \
//     PCO_NS=n_… npx tsx src/distinct-voters.ts <proposal-id>
import { HUB, NS, localCall } from './env.js';

const T = `${NS}.pco`;
const arg = process.argv[2];
if (!arg) {
  console.error('usage: distinct-voters.ts <proposal-id> | --all');
  process.exit(2);
}

const num = (v: unknown): number =>
  v && typeof v === 'object'
    ? Number((v as Record<string, unknown>).decimal ?? (v as Record<string, unknown>).int ?? NaN)
    : Number(v);

// every ballot row key is "<pid>:<account>"; pid is a decimal counter, so the
// FIRST colon is the separator (accounts themselves contain colons, e.g. k:…)
async function ballotsFor(pid: string) {
  const keys = (await localCall(`(keys ${T}.rcv-ballots)`, HUB)) as string[];
  const out: { account: string; ranking: number[]; weight: number }[] = [];
  for (const k of keys) {
    const i = k.indexOf(':');
    if (k.slice(0, i) !== pid) continue;
    const account = k.slice(i + 1);
    const b = (await localCall(`(${T}.get-ballot "${pid}" "${account}")`, HUB)) as Record<string, unknown>;
    out.push({
      account,
      ranking: ((b.ranking as unknown[]) ?? []).map(num),
      weight: num(b.weight),
    });
  }
  return out;
}

async function report(pid: string) {
  const r = (await localCall(`(${T}.get-results "${pid}")`, HUB)) as Record<string, unknown>;
  const options = (r.options as string[]) ?? [];
  const scores = ((r.scores as unknown[]) ?? []).map(num);
  const turnout = num(r.turnout);
  const K = options.length;
  const ballots = await ballotsFor(pid);

  console.log(`\nproposal ${pid}: "${r.title}"  ${r.closed ? '(closed)' : '(open)'}`);
  console.log('  weighted tally (Borda points):');
  const width = Math.max(...options.map((o) => o.length), 6);
  options.forEach((o, i) => console.log(`    ${o.padEnd(width)}  ${scores[i]}`));
  console.log(`  turnout (weight)          : ${turnout} PCO`);
  console.log(`  distinct voter ACCOUNTS   : ${ballots.length}`);

  if (!ballots.length) return;

  // Ballot-completion index. A complete ballot of K options contributes
  // w*(K + K-1 + … + 1) = w*K(K+1)/2 points, so with every ballot complete the
  // score total is exactly turnout*K(K+1)/2. C = 1.0 means nobody truncated.
  // Under the shipped Borda rule truncation is strictly dominant, so a low C is
  // the signal that the published scores are behaving like weighted plurality
  // rather than a ranking. Publish it beside every tally.
  const maxPts = (turnout * K * (K + 1)) / 2;
  const total = scores.reduce((a, b) => a + b, 0);
  const C = maxPts > 0 ? total / maxPts : 0;
  const partial = ballots.filter((b) => b.ranking.length < K).length;
  console.log(`  ballot completion index   : ${C.toFixed(3)}  (1.000 = nobody truncated)`);
  console.log(`  partial ballots           : ${partial} of ${ballots.length}`);

  // weight concentration — the other half of "honest numbers"
  const sorted = [...ballots].sort((a, b) => b.weight - a.weight);
  const top = sorted[0];
  if (turnout > 0) {
    console.log(`  largest single ballot     : ${top.weight} PCO `
      + `(${((100 * top.weight) / turnout).toFixed(1)}% of turnout, ${top.account.slice(0, 18)}…)`);
  }
  console.log('  ballots:');
  for (const b of sorted) {
    const names = b.ranking.map((i) => options[i] ?? `?${i}`).join(' > ') || '(empty)';
    console.log(`    ${b.account.slice(0, 20)}…  w=${String(b.weight).padStart(8)}  ${names}`);
  }
}

if (arg === '--all') {
  const ids = (await localCall(`(${T}.open-ids)`, HUB)) as string[];
  console.log(`open proposals: ${JSON.stringify(ids)}`);
  for (const pid of ids) await report(pid);
} else {
  await report(arg);
}
