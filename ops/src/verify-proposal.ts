// verify-proposal.ts — 20/20 READ-BACK. Run this before announcing a question.
//
// WHY IT IS A GATE AND NOT A CONVENIENCE. Since the chain-local voting design a question is 20
// separate transactions carrying identical arguments, signed and submitted one
// chain at a time. Nothing in that process notices if chain 13's transaction
// silently failed, or landed with a different deadline, or was never built.
//
// Every one of those failures is invisible until the vote is over:
//   * a chain missing the question disenfranchises everyone holding there, and
//     they find out when they try to vote,
//   * a chain carrying a different ends-at reopens the double-vote window C4
//     exists to close,
//   * and either way the combiner will REFUSE to publish the result — after the
//     community has already voted.
//
// So the question is not safely announceable until this prints 20/20. It reads
// only; it changes nothing.
//
// It shares its checks with the combiner ON PURPOSE (replicationRefusals): the
// property "one question, identical everywhere" is needed at two moments with
// opposite expectations about `closed`, and two copies of that logic would drift
// into announcing questions that cannot later be combined.
//
// Usage:
//   PCO_NS=user npx tsx src/verify-proposal.ts <proposal-id>
//   PCO_NETWORK=mainnet01 PCO_HOST=https://api.chainweb-community.org \
//     PCO_NS=n_… npx tsx src/verify-proposal.ts <proposal-id>
import { CHAINS, NS, localCall } from './env.js';
import { replicationRefusals, readCode, timeOf, type Reading } from './combine-votes.js';

async function main() {
  const pid = process.argv[2];
  if (!pid) {
    console.error('usage: verify-proposal.ts <proposal-id>');
    process.exit(2);
  }
  console.log(`verify-proposal — ${NS}.pco "${pid}" across ${CHAINS.length} chains\n`);

  const readings: Reading[] = [];
  for (const ch of CHAINS) {
    try {
      const data = await localCall(readCode(NS, pid), ch);
      readings.push({ chain: ch, ok: true, data: data as Record<string, any> });
    } catch (e: any) {
      const msg = String(e.message);
      const i = msg.indexOf('FAILED:');
      readings.push({ chain: ch, ok: false, error: (i >= 0 ? msg.slice(i + 7) : msg).trim().slice(0, 160) });
    }
  }

  const present = readings.filter((r) => r.ok).length;
  console.log(`  present on ${present}/${CHAINS.length} chains`);

  const bad = replicationRefusals(readings, CHAINS);
  if (bad.length) {
    console.log('\nNOT SAFE TO ANNOUNCE:\n');
    for (const r of bad) console.log(`  ✗ ${r}`);
    console.log('\nFix every line above before announcing. A chain missing the question');
    console.log('disenfranchises everyone holding there, and a chain carrying different');
    console.log('parameters makes the result impossible to publish.');
    process.exit(1);
  }

  const good = readings.filter((r): r is Extract<Reading, { ok: true }> => r.ok);
  const d = good[0].data;
  const now = Date.now();
  const starts = Date.parse(timeOf(d['starts-at']));
  const ends = Date.parse(timeOf(d['ends-at']));
  // An unparseable instant used to fall through both comparisons into the final
  // `else`, which announces "replicated and CLOSED — publish the result". That is
  // the worst possible default for an unreadable deadline, so it is refused here
  // rather than allowed to pick a branch by accident.
  if (Number.isNaN(starts) || Number.isNaN(ends)) {
    console.log(`\n  ✗ unreadable window: starts-at=${timeOf(d['starts-at'])} ends-at=${timeOf(d['ends-at'])}`);
    process.exit(1);
  }

  console.log(`  ✓ identical on all ${good.length} chains\n`);
  console.log(`  question : ${d.title}`);
  console.log(`  options  : ${(d.options as string[]).map((o, i) => `[${i}] ${o}`).join('   ')}`);
  console.log(`  opens    : ${timeOf(d['starts-at'])}`);
  console.log(`  closes   : ${timeOf(d['ends-at'])}`);

  // State is reported, never enforced: this tool is run before a question opens
  // AND while one is running, and neither is an error. What it must never do is
  // stay silent about a question that has already been cancelled or has closed.
  const cancelled = good.filter((r) => r.data.cancelled === true).length;
  if (cancelled) {
    console.log(`\n  ⚠ CANCELLED on ${cancelled} chain(s) — do not announce this question.`);
    process.exit(1);
  }
  if (now < starts) {
    const h = (starts - now) / 3600000;
    console.log(`\n  ✓ SAFE TO ANNOUNCE. Voting opens in ${h.toFixed(1)}h.`);
    if (h < 12) console.log(`  ⚠ under 12h of notice — the announce floor is measured from authoring, not from now.`);
  } else if (now < ends) {
    console.log(`\n  ✓ replicated and RUNNING. Closes in ${((ends - now) / 3600000).toFixed(1)}h.`);
    console.log(`  Cancellation is no longer possible — the window shut when voting opened.`);
  } else {
    console.log(`\n  ✓ replicated and CLOSED. Publish the result with:`);
    console.log(`      npx tsx src/combine-votes.ts ${pid}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
