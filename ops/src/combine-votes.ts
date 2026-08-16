// combine-votes.ts — THE PUBLISHED RESULT for one question, across all 20 chains.
//
// WHY THIS EXISTS. Since the chain-local voting design voting is chain-local: a question is created
// on all 20 chains with identical parameters, holders vote on whichever chains
// hold their tokens, and each chain tallies only its own ballots. No chain knows
// the answer. The result is the sum of all 20 and it is computed HERE, off-chain,
// because nothing on-chain can see another chain.
//
// THE ONE RULE THAT MATTERS: SUM THE MATRICES, THEN DECIDE ONCE.
// Head-to-head is not additive through its winner. Combining per-chain WINNERS -
// by majority of chains, or by counting chain wins - can elect an option that
// loses the actual head-to-head. Worked counterexample, 2 options, 3 chains:
//
//     chain 0:  A 100  B  99      -> A wins this chain
//     chain 1:  A 100  B  99      -> A wins this chain
//     chain 2:  A   0  B 500      -> B wins this chain
//
//   by chains won:  A 2, B 1  -> elects A
//   by summed weight: A 200, B 698 -> B is preferred by 698 to 200
//
// A won two chains and lost by nearly 500 weight. So this program sums the RAW
// pairwise matrices element-wise and runs Copeland/Condorcet exactly ONCE over
// the total. Per-chain winners are never computed, never mind combined.
//
// EXACT DECIMALS, NOT FLOATS - AND THE JSON NUMBER PATH IS UNUSABLE.
//
// CORRECTION, 2026-08-14. An earlier version of this file claimed the node "sends
// a bare JSON number only when the value is exactly representable". That is
// FALSE, and a cold review caught it. Pact's encoder tests the MANTISSA against
// 2^53-1, not double-representability (StableEncoding.hs: `isSafeInteger
// mantissa`), so for a 12-decimal-place value EVERY weight below ~9007.199254740991
// is sent as a bare JSON number - and @kadena/client has already run it through
// JSON.parse into a double before this program sees it. Measured against mainnet:
//
//     sent 8834.228695441326  ->  bare  ->  JS reads 8834.228695441327   (+1e-12)
//     sent 9007.199254740991  ->  bare  ->  JS reads 9007.199254740992   (+1e-12)
//     sent 9007.199254740992  ->  {decimal:"..."}  ->  exact
//     sent 0.000000123456     ->  bare  ->  String(v) is "1.23456e-7"
//
// PCO's entire distributed float is inside that range, so this was not a corner
// case. Since `copeland` decides on a strict `>`, a one-unit error at the
// boundary is exactly what turns a genuine win into a reported tie. And the
// exponent form made any sub-1e-6 total unparseable, which would have blocked a
// question's result permanently for the price of a dust ballot.
//
// THE FIX: ask the CHAIN for strings. readCode() below wraps every decimal in
// `(format "{}" [x])`, which renders a Pact Decimal exactly (verified in the 5.4
// engine, including 0.000000123456 -> "0.000000123456", no exponent). A JSON
// string crosses the wire losslessly, so no weight is ever a double at any point.
// toUnits() therefore REFUSES bare numbers outright rather than reconstructing
// them: if one appears, the read was not wrapped, and rounding it silently is the
// bug this comment exists to record.
//
// (env.ts's unwrap() would also destroy exactness - `Number(v.decimal)` - but it
// is shallow and get-head-to-head returns an object, so it never reaches these.)
//
// IT REFUSES BY DEFAULT. Nine conditions must hold before anything is published;
// any failure prints the reasons and exits non-zero with no result. That is not
// caution for its own sake - a partial or mismatched combine produces a number
// that looks exactly like a real one. the chain-local voting design moved this obligation here when
// C6 was withdrawn, so this file is the ONLY place the nine are checked.
//
// Usage:
//   PCO_NS=user npx tsx src/combine-votes.ts <proposal-id>
//   PCO_NETWORK=mainnet01 PCO_HOST=https://api.chainweb-community.org \
//     PCO_NS=n_… npx tsx src/combine-votes.ts <proposal-id>
import { CHAINS, NS, localCall } from './env.js';

// ---------------------------------------------------------------- exact decimals
// PCO's precision is fixed at deploy and matches coin (12). Ballot weights are
// balances, which the contract enforce-unit's to that precision, so every value
// in a pairwise matrix is a sum of 12dp numbers and is itself 12dp. Anything
// carrying more fractional digits than that did not come from a ballot weight,
// and is refused rather than rounded.
export const SCALE = 12;
const POW = 10n ** BigInt(SCALE);

/**
 * The read every consumer must use. Wraps each decimal in `(format "{}" [x])` so
 * the chain renders it exactly and it crosses the wire as a JSON STRING. See the
 * header: the bare JSON number path silently rounds every 12dp weight below
 * ~9007.2, which is PCO's whole distributed float.
 *
 * `wins` is carried too, so the combiner can compare each chain's own Copeland
 * count against its own matrix and catch a chain running different module code.
 */
export const readCode = (ns: string, pid: string): string =>
  `(let ((h (${ns}.pco.get-head-to-head "${pid}")))
     { "title": (at 'title h), "options": (at 'options h)
     , "starts-at": (at 'starts-at h), "ends-at": (at 'ends-at h)
     , "cancelled": (at 'cancelled h), "closed": (at 'closed h)
     , "available": (at 'available h)
     , "pairs": (map (lambda (x:decimal) (format "{}" [x])) (at 'pairs h))
     , "wins": (map (lambda (x:decimal) (format "{}" [x])) (at 'wins h))
     , "turnout": (format "{}" [(at 'turnout h)]) })`;

/** Parse a Pact decimal EXACTLY into scaled BigInt units. Throws on anything lossy. */
export function toUnits(v: unknown, where: string): bigint {
  let s: string;
  if (typeof v === 'string') {
    s = v;                                   // the only path readCode produces
  } else if (v !== null && typeof v === 'object' && 'decimal' in (v as any)) {
    s = String((v as any).decimal);          // still exact; accepted for robustness
  } else if (typeof v === 'number') {
    // REFUSED, not reconstructed. A bare JSON number has already been through
    // JSON.parse into a double, and Pact emits bare numbers for every 12dp value
    // whose mantissa fits in 2^53-1 — i.e. everything under ~9007.199254740991,
    // which is PCO's entire float. Reconstructing from the double is exactly the
    // silent +/-1e-12 corruption that can flip a strict `>` and turn a real win
    // into a reported tie. Seeing one here means the caller did not use
    // readCode(); that is a bug to fix, never a value to round.
    throw new Error(
      `${where}: got a bare JSON number (${v}) — its precision is already lost. ` +
      `Read through readCode(), which makes the chain return exact strings.`,
    );
  } else {
    throw new Error(`${where}: not a decimal (${JSON.stringify(v)?.slice(0, 40)})`);
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`${where}: not a plain decimal string ("${s.slice(0, 40)}")`);
  const [, sign, whole, frac = ''] = m;
  if (frac.length > SCALE) {
    throw new Error(
      `${where}: ${frac.length} decimal places exceeds PCO's precision of ${SCALE} ` +
      `("${s.slice(0, 40)}") — this did not come from a ballot weight`,
    );
  }
  const units = BigInt(whole) * POW + BigInt((frac + '0'.repeat(SCALE)).slice(0, SCALE));
  return sign === '-' ? -units : units;
}

/** Render scaled units back to a decimal string, trailing zeros trimmed to one dp. */
export function fromUnits(u: bigint): string {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const whole = a / POW;
  const frac = (a % POW).toString().padStart(SCALE, '0').replace(/0+$/, '') || '0';
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// ------------------------------------------------------------------- the readings
export type Reading =
  | { chain: string; ok: true; data: Record<string, any> }
  | { chain: string; ok: false; error: string };

export type Combined = {
  title: string;
  options: string[];
  endsAt: string;
  pairs: bigint[];       // summed, row-major K x K
  wins: number[];        // Copeland count per option, from the SUM
  condorcet: string;     // "" when no option beats every other (a cycle or a tie)
  perChain: { chain: string; turnout: string }[];
  totalWeight: string;   // sum of turnout across chains, raw count only
};

const fingerprint = (d: Record<string, any>): string =>
  JSON.stringify([d.title, d.options, timeOf(d['starts-at']), timeOf(d['ends-at'])]);

/** Pact times arrive as {time|timep: "..."} nested, or already unwrapped to a string. */
export function timeOf(v: unknown): string {
  if (v !== null && typeof v === 'object') {
    const o = v as any;
    if ('time' in o) return String(o.time);
    if ('timep' in o) return String(o.timep);
  }
  return String(v);
}

/**
 * THE NINE CONDITIONS. Pure — no network — so every refusal is testable against
 * a crafted set of readings. Returns the reasons it refuses; empty means publish.
 *
 * Each condition is listed once and only once. If you delete one, the test named
 * for it in test/combine-checks.ts goes red; that is the whole point of keeping
 * them here as data rather than scattered through the read loop.
 */
export function refusals(readings: Reading[], expectedChains: readonly string[]): string[] {
  const out = replicationRefusals(readings, expectedChains);
  const good = readings.filter((r): r is Extract<Reading, { ok: true }> => r.ok);
  if (good.length === 0) return out;   // replicationRefusals already said so

  // 3. all closed — a running tally is not a result
  const open = good.filter((r) => r.data.closed !== true).map((r) => r.chain);
  if (open.length) out.push(`still open on chain(s) ${open.join(',')} — a running tally is not a result`);

  // 4. none cancelled — a voided copy must never be summed into a total. The
  //    contract reports `cancelled` SEPARATELY from `closed` precisely so this
  //    is decidable; folding them together is what made a voided chain look
  //    like a normally-closed one.
  const cancelled = good.filter((r) => r.data.cancelled === true).map((r) => r.chain);
  if (cancelled.length) out.push(`cancelled on chain(s) ${cancelled.join(',')} — a voided copy is not a zero, it is not a copy`);

  // 9. every weight parses EXACTLY. Checked as a condition rather than trusted,
  //    because the failure is silent: a rounded weight still adds up to a
  //    plausible-looking total.
  for (const r of good) {
    if (!Array.isArray(r.data.pairs)) continue;
    for (let i = 0; i < r.data.pairs.length; i++) {
      try { toUnits(r.data.pairs[i], `chain ${r.chain} pairs[${i}]`); }
      catch (e: any) { out.push(`inexact value: ${e.message}`); }
    }
    try { toUnits(r.data.turnout, `chain ${r.chain} turnout`); }
    catch (e: any) { out.push(`inexact value: ${e.message}`); }
  }

  // 10. EACH CHAIN'S OWN ANSWER MUST MATCH OUR ARITHMETIC ON ITS OWN MATRIX.
  //     Free, and it is the only check that can catch a chain whose module
  //     computes head-to-head under different semantics from the one this
  //     program implements — a divergence no amount of comparing chains to each
  //     other would reveal, because they would all be self-consistent.
  //     Skipped where the matrix was already rejected above.
  for (const r of good) {
    if (r.data.available !== true || !Array.isArray(r.data.pairs) || !Array.isArray(r.data.wins)) continue;
    const kk = Array.isArray(r.data.options) ? r.data.options.length : 0;
    if (r.data.pairs.length !== kk * kk || r.data.wins.length !== kk) continue;
    let mine: number[]; let theirs: number[];
    try {
      mine = copeland(r.data.pairs.map((p: unknown, i: number) => toUnits(p, `chain ${r.chain} pairs[${i}]`)), kk);
      theirs = r.data.wins.map((w: unknown, i: number) => Number(toUnits(w, `chain ${r.chain} wins[${i}]`) / (10n ** BigInt(SCALE))));
    } catch { continue; }   // already reported by condition 9
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
      out.push(`chain ${r.chain} reports Copeland ${JSON.stringify(theirs)} but its own matrix gives ` +
               `${JSON.stringify(mine)} — that chain is running different module code`);
    }
  }

  return out;
}

/**
 * THE REPLICATION CONDITIONS ALONE: is this ONE question, present and identical
 * on every chain? Split out because it is needed at two different moments with
 * opposite expectations about `closed` — before ANNOUNCING a question (nothing
 * has closed, nothing has been voted) and before PUBLISHING its result (all 20
 * must have closed). Two copies of this logic would drift, and a drift here
 * means announcing a question that cannot later be combined.
 */
export function replicationRefusals(readings: Reading[], expectedChains: readonly string[]): string[] {
  const out: string[] = [];

  // 1. all 20 read, exactly once each
  const seen = new Map<string, number>();
  for (const r of readings) seen.set(r.chain, (seen.get(r.chain) ?? 0) + 1);
  const missing = expectedChains.filter((c) => !seen.has(c));
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  const extra = [...seen.keys()].filter((c) => !expectedChains.includes(c));
  if (missing.length) out.push(`not every chain was read: missing ${missing.join(',')}`);
  if (dupes.length) out.push(`a chain was read more than once: ${dupes.join(',')}`);
  if (extra.length) out.push(`a chain outside the expected set was read: ${extra.join(',')}`);

  // 2. all present — a read that failed is NOT evidence of absence, and the
  //    difference between "no such question here" and "this node did not answer"
  //    is exactly the difference between 19 chains and an unknown number.
  const failed = readings.filter((r) => !r.ok) as Extract<Reading, { ok: false }>[];
  // Grouped by error text: twenty chains failing the same way is ONE fact, and
  // printing it twenty times pushes the other refusals off the operator's screen.
  const byError = new Map<string, string[]>();
  for (const f of failed) (byError.get(f.error) ?? byError.set(f.error, []).get(f.error)!).push(f.chain);
  for (const [err, chs] of byError) {
    out.push(`chain(s) ${chs.join(',')} did not return the question: ${err}`);
  }
  const good = readings.filter((r): r is Extract<Reading, { ok: true }> => r.ok);
  if (good.length === 0) {
    // Wording stays neutral: this function is shared with the ANNOUNCE gate,
    // where "nothing to combine" names the wrong activity entirely.
    out.push('no chain returned a readable question — check the id, the namespace and the network');
    return out;  // every check below reads `good`
  }

  // 5. options identical AS AN ORDERED LIST — the matrix is indexed by position,
  //    so two chains carrying the same options in a different order describe
  //    different questions and their matrices are not addable.
  const opts = JSON.stringify(good[0].data.options);
  const optMismatch = good.filter((r) => JSON.stringify(r.data.options) !== opts).map((r) => r.chain);
  if (optMismatch.length) {
    out.push(`options differ (as an ORDERED list) on chain(s) ${optMismatch.join(',')} — ` +
             `the matrix is indexed by position, so these are not the same question`);
  }

  // 6. one absolute deadline everywhere — the anti-double-vote control (C4). If
  //    the copies close at different instants, tokens can vote on a chain whose
  //    copy is still open after their ballot elsewhere has frozen.
  const ends = timeOf(good[0].data['ends-at']);
  const endMismatch = good.filter((r) => timeOf(r.data['ends-at']) !== ends).map((r) => r.chain);
  if (endMismatch.length) out.push(`ends-at differs on chain(s) ${endMismatch.join(',')} — the copies do not close at one instant`);

  // 7. identical fingerprint — title, options, and both window bounds. Catches
  //    every "same id, different question" case at once, including the ones the
  //    two narrower checks above do not name.
  const fp = fingerprint(good[0].data);
  const fpMismatch = good.filter((r) => fingerprint(r.data) !== fp).map((r) => r.chain);
  if (fpMismatch.length) out.push(`the question itself differs on chain(s) ${fpMismatch.join(',')} — same id, different question`);

  // 8. pairwise record present and correctly shaped.
  //
  //    THIS IS A REPLICATION CHECK, NOT A RESULT CHECK, and putting it with the
  //    result checks was a real defect: `create-proposal` inserts the KxK zero
  //    matrix in the SAME transaction that creates the question (pco.pact,
  //    `insert rcv-margins`), so on any chain running the current module
  //    `available` is true from creation. `available: false` at announce time
  //    therefore means THAT CHAIN IS RUNNING AN OLDER `pco` — precisely the
  //    per-chain upgrade drift this project already tracks.
  //
  //    While it lived in refusals() only, verify-proposal would print
  //    "identical on all 20 chains — SAFE TO ANNOUNCE" over a chain that had
  //    missed the upgrade, the community would vote for a week, and only then
  //    would the combiner refuse. It is decidable before the first ballot and
  //    free there, which is the whole argument for checking it here.
  const k = Array.isArray(good[0].data.options) ? good[0].data.options.length : 0;
  const unavailable = good.filter((r) => r.data.available !== true).map((r) => r.chain);
  if (unavailable.length) {
    out.push(`no pairwise record on chain(s) ${unavailable.join(',')} — the question exists there but ` +
             `carries no matrix, which means that chain is running an older pco`);
  }
  const misshaped = good
    .filter((r) => r.data.available === true && (!Array.isArray(r.data.pairs) || r.data.pairs.length !== k * k))
    .map((r) => r.chain);
  if (misshaped.length) out.push(`pairwise matrix is not ${k}x${k} on chain(s) ${misshaped.join(',')}`);

  return out;
}

/** Copeland win-count per option — mirrors pco.pact's h2h-wins EXACTLY: a strict
 *  majority is required, so an exact pairwise tie credits neither side. */
export function copeland(pairs: bigint[], k: number): number[] {
  return Array.from({ length: k }, (_, i) => {
    let w = 0;
    for (let j = 0; j < k; j++) if (i !== j && pairs[i * k + j] > pairs[j * k + i]) w++;
    return w;
  });
}

/** Sum the matrices, then decide once. Callers must have checked refusals() first. */
export function combine(readings: Reading[]): Combined {
  const good = readings.filter((r): r is Extract<Reading, { ok: true }> => r.ok);
  const options: string[] = good[0].data.options;
  const k = options.length;

  const pairs = new Array<bigint>(k * k).fill(0n);
  for (const r of good) {
    for (let i = 0; i < k * k; i++) pairs[i] += toUnits(r.data.pairs[i], `chain ${r.chain} pairs[${i}]`);
  }

  const wins = copeland(pairs, k);
  // A Condorcet winner beats every OTHER option, i.e. k-1 wins. At most one
  // option can, so this is unambiguous; "" means a cycle or an exact tie, which
  // is a real outcome and is reported as one rather than broken by a tiebreak.
  const ci = wins.findIndex((w) => w === k - 1);

  let total = 0n;
  const perChain = good.map((r) => {
    const t = toUnits(r.data.turnout, `chain ${r.chain} turnout`);
    total += t;
    return { chain: r.chain, turnout: fromUnits(t) };
  });

  return {
    title: good[0].data.title,
    options,
    endsAt: timeOf(good[0].data['ends-at']),
    pairs,
    wins,
    condorcet: ci >= 0 ? options[ci] : '',
    perChain,
    totalWeight: fromUnits(total),
  };
}

// ----------------------------------------------------------------------- the CLI
async function main() {
  const pid = process.argv[2];
  if (!pid) {
    console.error('usage: combine-votes.ts <proposal-id>');
    process.exit(2);
  }
  console.log(`combine-votes — ${NS}.pco proposal "${pid}", ${CHAINS.length} chains\n`);

  const readings: Reading[] = [];
  for (const ch of CHAINS) {
    try {
      const data = await localCall(readCode(NS, pid), ch);
      readings.push({ chain: ch, ok: true, data: data as Record<string, any> });
    } catch (e: any) {
      // Keep the part AFTER "FAILED:", not the first 120 characters. localCall
      // prefixes every error with `local(<the whole call>) FAILED: …`, so a
      // head-slice returns the code we already know and truncates the one thing
      // that matters here: whether the row is absent or the node did not answer.
      // Condition 2 turns on exactly that distinction.
      const msg = String(e.message);
      const i = msg.indexOf('FAILED:');
      readings.push({ chain: ch, ok: false, error: (i >= 0 ? msg.slice(i + 7) : msg).trim().slice(0, 160) });
    }
  }

  const bad = refusals(readings, CHAINS);
  if (bad.length) {
    console.log('REFUSING TO PUBLISH — the combined result is not trustworthy:\n');
    for (const r of bad) console.log(`  ✗ ${r}`);
    console.log('\nNo result printed. Fix the above and re-run; do not publish a partial combine.');
    process.exit(1);
  }

  const c = combine(readings);
  const k = c.options.length;
  console.log(`  question : ${c.title}`);
  console.log(`  closed   : ${c.endsAt}  (identical on all ${c.perChain.length} chains)`);
  console.log(`  options  : ${c.options.map((o, i) => `[${i}] ${o}`).join('  ')}\n`);
  console.log('  SUMMED pairwise matrix — row i beats column j by this weight:');
  for (let i = 0; i < k; i++) {
    console.log(`    ${String(i).padStart(2)} | ` +
      Array.from({ length: k }, (_, j) => (i === j ? '—' : fromUnits(c.pairs[i * k + j])).padStart(16)).join(' '));
  }
  console.log('\n  Copeland (options beaten head-to-head, from the SUM):');
  c.options.forEach((o, i) => console.log(`    ${c.wins[i]}/${k - 1}  ${o}`));
  console.log(c.condorcet
    ? `\n  RESULT: "${c.condorcet}" beats every other option head to head.`
    : '\n  RESULT: NO Condorcet winner — a cycle or an exact tie. Report it as one; do not break it with a rule.');
  console.log(`\n  total weight cast : ${c.totalWeight}  (raw count; every percentage is computed off this)`);
  console.log('  per chain         : ' + c.perChain.map((p) => `c${p.chain}=${p.turnout}`).join('  '));
  console.log('\n  ADVISORY. Nothing executes, there is no quorum.');
}

// Importable for tests without firing the CLI.
if (process.argv[1] && process.argv[1].endsWith('combine-votes.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
