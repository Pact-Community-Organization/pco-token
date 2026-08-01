// seed.ts — DEVNET-ONLY website-testing seed. Run LAST, after any rehearse/e2e
// (those harnesses claim, which changes what this has to do).
//
//   PCO_NS=user npm run seed
//
// Ensures there IS an open round carrying the PUBLIC quest code
// ("fungible-v2"), plus at least two admin-authored ranked-choice questions.
// It is IDEMPOTENT and safe to re-run: if such a round is already open it
// changes nothing, because creating a round commits 30,000 against the 40,000
// per-epoch ops meter and a create-every-time seed exhausts that after one run.
// The round is not necessarily named "genesis" — once a round has claims its
// code is frozen by design, so this opens a fresh one beside it and prints the
// name of whichever round is actually open.
import { readFileSync } from 'node:fs';
import { HUB, NS, SENDER00, localCall, send, type Keypair } from './env.js';

const T = `${NS}.pco`;
const C = `${NS}.pco-claim`;
const CODE = 'fungible-v2';

async function main() {
  if (process.env.PCO_NETWORK && process.env.PCO_NETWORK !== 'recap-development') {
    throw new Error('seed.ts is DEVNET-only - refusing ' + process.env.PCO_NETWORK);
  }
  const K = JSON.parse(readFileSync(new URL('../out/rehearsal-keys.json', import.meta.url), 'utf8')) as Record<string, Keypair>;
  const opsCap = { kp: K.deviceA };
  const gas = { kp: SENDER00, caps: (wc: any) => [wc('coin.GAS')] };

  // 1. an OPEN round with the public quest code + master switch open.
  //
  // This used to always target the round literally named "genesis", resetting
  // its code. That only works until the round has a claim: a claimed round's
  // code is FROZEN on purpose, so ops cannot re-point an open round's budget to
  // a new secret (pco-claim: "cannot rotate the code once the round has
  // claims"). Every rehearse/e2e run claims, so the documented routine "run
  // seed after any harness run" failed on the second run of any devnet's life —
  // the contract was right and this tool's assumption was wrong.
  //
  // So: reset the round only while it is still resettable, otherwise open a
  // fresh one beside it. Round ids must satisfy validate-round-id, so keep them
  // short and plain.
  const codeHash = await localCall(`(hash "${CODE}")`, HUB);
  const existing: string[] = await localCall(`(${C}.round-ids)`, HUB).catch(() => []);
  const claimed = async (id: string) =>
    Number(await localCall(`(at 'claimed (${C}.get-round "${id}"))`, HUB).catch(() => 0)) > 0;

  // IDEMPOTENT FIRST. Creating a round commits its whole budget against the ops
  // meter (30,000 of 40,000 per epoch), so a seed that always creates can only
  // run once a day before "ops daily cap reached" — and re-running seed after a
  // harness is exactly what the routine asks for. If a usable round is already
  // open under the public code, say so and change nothing.
  let target = 'genesis';
  let mode: 'reset' | 'create' | 'noop' = 'create';
  for (const id of existing) {
    const r = await localCall(`(${C}.get-round "${id}")`, HUB).catch(() => null);
    if (r && r.active === true && String(r['code-hash']) === String(codeHash)) {
      target = id; mode = 'noop';
      console.log(`  note: round "${id}" is already open under the public code — nothing to do.`);
      break;
    }
  }
  if (mode === 'noop') {
    // still make sure the master switch is on; that is cheap and not metered
    await send({
      label: 'ensure claiming open', chainId: HUB,
      code: `(${C}.set-open true)`, signers: [gas, opsCap], gasLimit: 2000,
    });
  } else if (existing.includes('genesis') && !(await claimed('genesis'))) {
    mode = 'reset';
  } else if (existing.includes('genesis')) {
    // genesis is spent; find the first free demo-N beside it
    let n = 2;
    while (existing.includes(`demo-${n}`)) n++;
    target = `demo-${n}`;
    console.log(`  note: "genesis" already has claims, so its code is frozen by design.`);
    console.log(`        opening a fresh round "${target}" with the same public code instead.`);
  }
  if (mode !== 'noop') await send({
    label: mode === 'reset' ? `reset ${target} code + open` : `create round ${target} + open`,
    chainId: HUB,
    code: mode === 'reset'
      ? `(${C}.set-round-code "${target}" "${codeHash}") (${C}.set-round-active "${target}" true) (${C}.set-open true)`
      : `(${C}.create-round "${target}" "${codeHash}" 100.0 30000.0 (time "2020-01-01T00:00:00Z") (time "2035-01-01T00:00:00Z")) (${C}.set-open true)`,
    signers: [gas, opsCap], gasLimit: 4000,
  });

  // 2. at least two admin-authored ranked-choice questions
  const QUESTIONS: [string, string, string[]][] = [
    ['Which template family should the catalog grow next?',
      'Advisory - rank the options.', ['vesting', 'oracle', 'marketplace']],
    ['Which docs should we prioritize first?',
      'Advisory - rank the options.', ['guides', 'reference', 'examples', 'videos']],
  ];
  const open: string[] = await localCall(`(${T}.open-ids)`, HUB);
  for (let i = open.length; i < 2 && i < QUESTIONS.length; i++) {
    const [title, body, options] = QUESTIONS[i];
    try {
      const r = await send({
        label: `question: ${title.slice(0, 30)}…`, chainId: HUB,
        code: `(${T}.create-proposal "${title}" "${body}" [${options.map((o) => `"${o}"`).join(' ')}] 336)`,
        signers: [gas, opsCap], gasLimit: 4000,
      });
      console.log('question opened:', (r.result as any).data);
    } catch (e: any) {
      if (!String(e.message).includes('too many active')) throw e;
    }
  }
  const ids: string[] = await localCall(`(${T}.open-ids)`, HUB);
  const pool = await localCall(`(${C}.pool-balance)`, HUB);
  // Name the round that is actually open. Saying "genesis" when the open round
  // is demo-2 sends whoever reads this to a round whose code no longer works.
  console.log(`SEED DONE — open round "${target}", code="${CODE}", open questions ${JSON.stringify(ids)}, pool ${pool} PCO`);
}

main().catch((e) => { console.error('SEED FAILED:', e.message ?? e); process.exit(1); });
