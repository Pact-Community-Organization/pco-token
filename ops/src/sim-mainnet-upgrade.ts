// sim-mainnet-upgrade.ts — THE WHOLE MAINNET UPGRADE, SIMULATED ON 20 DEVNET CHAINS.
//
// Answers the two questions that decide whether this ships:
//   1. Do holders come through the upgrade untouched?
//   2. Does voting actually work on chains other than the hub, afterwards?
//
// It stages the world as mainnet has it today — the OLD contracts on all 20
// chains, a funded pool, an open claim round, holders with balances on SEVERAL
// chains — then runs the real two-step ceremony over it and keeps checking, at
// every step, that a holder can still do the things a holder does.
//
// EVERY PROBE IS A REAL TRANSACTION, NEVER /local. `enforceBlessedHashes` is
// reached only through `guardTable`, which skips the check for reads when the node
// runs `--allowReadsInLocal` (this devnet and the public mainnet endpoint both
// do). A /local read answers "healthy" straight across a broken dependency pin —
// measured: pool-balance returned 900000 while the same call as a transaction
// aborted with "hash not blessed". A read-only verification of this ceremony would
// therefore pass over exactly the failure it exists to catch.
//
// ---------------------------------------------------------------------------
// TWO DECLARED SUBSTITUTIONS, AND NOTHING ELSE
//
// A simulation that quietly tests different code is worse than no simulation, so
// the variant generator asserts that it changed exactly what it meant to and that
// the rest of the module is byte-identical to what ships.
//
//   1. THE BLESS HASH. A module hash covers its namespace and dependencies, so the
//      same source in a devnet namespace can never hash to the mainnet value the
//      contract carries. Substituted with the hash observed on this node. The
//      mainnet value is verified separately, against the live chain.
//
//   2. THE ANNOUNCE FLOOR, 12h -> minutes. This one buys the thing the wait would
//      otherwise cost a day: a REAL BALLOT, cast from a non-hub chain, tallied by
//      the real cast-vote / release-votes / pairwise code on a real node. The
//      floor itself is not what is under test here — it is pinned in the REPL at
//      both edges (11h59m59s refused, exactly 12h accepted) and mutation-checked.
//      What is under test is everything the floor otherwise prevents anyone from
//      reaching in a single session.
// ---------------------------------------------------------------------------
//
// Usage:  PCO_NETWORK=recap-development PCO_NS=free npx tsx src/sim-mainnet-upgrade.ts
import { readFileSync } from 'node:fs';
import { CHAINS, HUB, NS, SENDER00, checks, localCall, newKey, record, send, xchain, type Keypair } from './env.js';
import { preupgradeSource } from './preupgrade-source.js';

if ((process.env.PCO_NETWORK ?? '') !== 'recap-development') {
  console.error('ABORT: devnet only — this deploys, upgrades and mints.'); process.exit(2);
}
if (NS === 'user') { console.error('ABORT: use a scratch namespace; `user` holds the main rehearsal state.'); process.exit(2); }

const K = JSON.parse(readFileSync(new URL('../out/rehearsal-keys.json', import.meta.url), 'utf8')) as Record<string, Keypair>;
const T = `${NS}.pco`, C = `${NS}.pco-claim`, G = `${NS}.pco-gas-station`, KS = `${NS}.pco-gov`;
const gas = { kp: SENDER00, caps: (wc: any) => [wc('coin.GAS')] };
const gov = [{ kp: K.deviceA }, { kp: K.deviceB }];
const GOVKS = { keys: [K.deviceA.publicKey, K.deviceB.publicKey, K.deviceC.publicKey], pred: 'keys-2' };
const LEGACY = { symbol: 'PCO', precision: 12, 'total-supply': 1000000.0 };
const { dir: OLD, ref: OLD_REF } = preupgradeSource();   // extracted from git, fresh every run
const NEW = new URL('../../contracts/', import.meta.url).pathname;

// Holders on three DIFFERENT chains — the whole point of the change is that the
// two off-hub ones can vote afterwards, and the hub one must be unharmed by it.
const HOLDER_CHAINS = [HUB, '5', '13'] as const;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const chainTime = async (ch: string) => new Date(String(await localCall("(at 'block-time (chain-data))", ch)));

/** The shipped pco.pact with exactly two substitutions, both asserted. */
function simPco(blessHash: string, announceHours: number): string {
  const src = readFileSync(`${NEW}pco.pact`, 'utf8');
  let out = src.replace(/\(bless "[^"]*"\)/, `(bless "${blessHash}")`);
  out = out.replace(/\(defconst MIN-ANNOUNCE-HOURS 12\b/, `(defconst MIN-ANNOUNCE-HOURS ${announceHours}`);
  if (!out.includes(`(bless "${blessHash}")`)) throw new Error('bless substitution did not land');
  if (!out.includes(`(defconst MIN-ANNOUNCE-HOURS ${announceHours}`)) throw new Error('announce-floor substitution did not land');
  // Prove nothing else moved: undo both and the result must be the shipped file.
  const undone = out
    .replace(`(bless "${blessHash}")`, (src.match(/\(bless "[^"]*"\)/) ?? [''])[0])
    .replace(`(defconst MIN-ANNOUNCE-HOURS ${announceHours}`, '(defconst MIN-ANNOUNCE-HOURS 12');
  if (undone !== src) throw new Error('the simulation variant differs from the shipped contract by MORE than its two declared substitutions');
  return out;
}

const moduleExists = (q: string, ch: string) => localCall(`(describe-module "${q}")`, ch).then(() => true).catch(() => false);

// Records the WORST observed gas per step, so ceremony limits can be derived from
// receipts rather than guessed. A fresh pco-claim deploy measured 71,477 here
// against build-tx's 60,000 allowance — a limit that has drifted below the
// contract it has to carry.
const gasSeen: Record<string, number> = {};
async function deployAll(label: string, code: string, qualified: string, gasLimit: number, chains: readonly string[] = CHAINS) {
  await Promise.all(chains.map(async (ch) => {
    const upgrade = await moduleExists(qualified, ch);
    const r = await send({
      label: `${label} @${ch}`, chainId: ch, code,
      data: { ns: NS, upgrade, ...LEGACY, 'pco-gov': GOVKS },
      signers: [gas, ...gov], gasLimit,
    });
    const key = `${label}${upgrade ? ' (upgrade)' : ' (fresh)'}`;
    gasSeen[key] = Math.max(gasSeen[key] ?? 0, Number(r.gas ?? 0));
  }));
}

/** A holder action, as a REAL TRANSACTION. Returns the failure text if it broke. */
async function holderCanTransact(h: Keypair, to: Keypair, ch: string): Promise<{ ok: boolean; err: string }> {
  try {
    await send({
      label: `holder transfer probe @${ch}`, chainId: ch,
      // transfer-create: the receiver need not already exist, so the probe tests
      // the upgrade rather than the fixture.
      code: `(${T}.transfer-create "${h.account}" "${to.account}" (read-keyset 'pg) 1.0)`,
      data: { pg: { keys: [to.publicKey], pred: 'keys-all' } },
      signers: [{ kp: h, caps: (wc: any) => [wc('coin.GAS'), wc(`${T}.TRANSFER`, h.account, to.account, { decimal: '1.0' })] }],
      gasLimit: 4000, gasPrice: 1e-7,
    });
    return { ok: true, err: '' };
  } catch (e: any) { return { ok: false, err: String(e.message).slice(0, 300) }; }
}

async function main() {
  console.log(`SIMULATED MAINNET UPGRADE — ns=${NS}, ${CHAINS.length} chains\n`);
  console.log(`Pre-upgrade contracts extracted from git at ${OLD_REF.slice(0, 8)} (the version mainnet runs).`);
  console.log('Substitutions: bless hash (devnet), announce floor 12h -> 0h. Nothing else.\n');
  console.log('=== PHASE 0: stage the world as mainnet has it today (OLD contracts) ===');

  await Promise.all(CHAINS.map((ch) => send({
    label: `keyset @${ch}`, chainId: ch,
    code: `(namespace "${NS}") (define-keyset "${KS}" (read-keyset 'pco-gov))`,
    data: { 'pco-gov': GOVKS }, signers: [gas, ...gov], gasLimit: 3000,
  }).catch(() => null)));

  await deployAll('OLD pco', readFileSync(`${OLD}/pco.pact`, 'utf8'), T, 150000);
  await deployAll('OLD pco-claim', readFileSync(`${OLD}/pco-claim.pact`, 'utf8'), C, 120000);
  await deployAll('OLD station', readFileSync(`${OLD}/pco-gas-station.pact`, 'utf8'), G, 90000);
  record('S0', `OLD contracts deployed on all ${CHAINS.length} chains`, true);

  if ((await localCall(`(${T}.chain-minted)`, HUB).catch(() => 0)) === 0) {
    await send({
      label: 'one-shot mint (hub)', chainId: HUB,
      code: `(${T}.init-mint [
        { "account": (${C}.pool-account), "guard": (${C}.pool-guard), "amount": 900000.0 },
        { "account": "r:${KS}", "guard": (keyset-ref-guard "${KS}"), "amount": 100000.0 } ])`,
      data: { ns: NS, upgrade: true, ...LEGACY }, signers: [gas, ...gov], gasLimit: 6000,
    });
  }
  record('S0', 'pool holds 900,000 and the reserve 100,000', (await localCall(`(${C}.pool-balance)`, HUB)) === 900000);

  // Holders on three chains. The hub one is funded from the reserve; the off-hub
  // ones are minted-equivalent via a cross-chain send, which is how real holders
  // got there.
  // ONE holder account, present on three chains — which is how a real holder
  // exists: the same k: account, tokens spread across chains by real cross-chain
  // transfers. A separate key per chain would not be a holder, it would be three.
  const holder = newKey();
  const peer = newKey();
  for (const ch of HOLDER_CHAINS) {
    await send({
      label: `fund holder KDA @${ch}`, chainId: ch,
      code: `(coin.transfer-create "sender00" "${holder.account}" (read-keyset 'gk) 5.0)`,
      signers: [{ kp: SENDER00, caps: (wc: any) => [wc('coin.GAS'), wc('coin.TRANSFER', 'sender00', holder.account, { decimal: '5.0' })] }],
      data: { gk: { keys: [holder.publicKey], pred: 'keys-all' } }, gasLimit: 2000,
    });
  }
  await send({
    label: 'reserve funds the holder on the hub', chainId: HUB,
    code: `(${T}.transfer-create "r:${KS}" "${holder.account}" (read-keyset 'g) 3000.0)`,
    data: { g: { keys: [holder.publicKey], pred: 'keys-all' } },
    signers: [gas, ...gov.map((s) => ({ ...s, caps: (wc: any) => [wc(`${T}.TRANSFER`, `r:${KS}`, holder.account, { decimal: '3000.0' })] }))],
    gasLimit: 4000,
  });
  record('S0', 'a holder holds 3,000 PCO on the hub', (await localCall(`(${T}.get-balance "${holder.account}")`, HUB)) === 3000);

  // Move real tokens off-hub, the way a real holder would. This also exercises
  // the defpact whose in-flight continuations the bless protects.
  for (const ch of HOLDER_CHAINS.filter((c) => c !== HUB)) {
    if ((await localCall(`(${T}.get-balance "${holder.account}")`, ch).catch(() => 0)) > 0) continue;
    await xchain({
      label: `holder moves 500 PCO to chain ${ch}`, src: HUB, target: ch,
      code: `(${T}.transfer-crosschain "${holder.account}" "${holder.account}" (read-keyset 'g) "${ch}" 500.0)`,
      data: { g: { keys: [holder.publicKey], pred: 'keys-all' } },
      signers: [{ kp: holder, caps: (wc: any) => [wc('coin.GAS'), wc(`${T}.TRANSFER_XCHAIN`, holder.account, holder.account, { decimal: '500.0' }, ch)] }],
      contGasPayer: SENDER00,
    });
  }
  for (const ch of HOLDER_CHAINS.filter((c) => c !== HUB)) {
    record('S0', `the holder now holds PCO on chain ${ch} (arrived by cross-chain transfer)`,
      (await localCall(`(${T}.get-balance "${holder.account}")`, ch).catch(() => 0)) === 500);
  }

  console.log('\n=== PHASE 1: ceremony step 1 — the NEW pco over the OLD, all 20 chains ===');
  const oldHash = String(await localCall(`(at 'hash (describe-module "${T}"))`, HUB));
  const balancesBefore: Record<string, number> = {};
  for (const ch of HOLDER_CHAINS) balancesBefore[ch] = await localCall(`(${T}.get-balance "${holder.account}")`, ch).catch(() => 0);
  const poolBefore = await localCall(`(${C}.pool-balance)`, HUB);

  await deployAll('NEW pco (blessing the deployed hash)', simPco(oldHash, 0), T, 150000);
  record('S1', `NEW pco deployed on all ${CHAINS.length} chains, blessing ${oldHash.slice(0, 12)}…`, true);

  // THE GAP. pco-claim still pins the OLD pco here. This is the window the bless
  // exists for, and the only way to see it is a transaction.
  const inGap = await holderCanTransact(holder, peer, HUB);
  record('S1', '⭐ IN THE GAP: a holder can still transact while pco-claim is on a stale pin',
    inGap.ok, inGap.err);
  const claimGap = await send({
    label: 'pool-balance through the stale pin (transaction)', chainId: HUB,
    code: `(${C}.pool-balance)`, signers: [gas], gasLimit: 5000,
  }).then(() => ({ ok: true, err: '' })).catch((e: any) => ({ ok: false, err: String(e.message).slice(0, 300) }));
  record('S1', '⭐ IN THE GAP: pco-claim still reaches pco — THE BLESS DOING ITS JOB', claimGap.ok, claimGap.err);

  console.log('\n=== PHASE 2: ceremony step 2 — pco-claim re-pins, all 20 chains ===');
  await deployAll('NEW pco-claim', readFileSync(`${NEW}pco-claim.pact`, 'utf8'), C, 120000);
  const afterRepin = await send({
    label: 'pool-balance after the re-pin', chainId: HUB,
    code: `(${C}.pool-balance)`, signers: [gas], gasLimit: 5000,
  }).then(() => true).catch(() => false);
  record('S2', 'after the re-pin pco-claim stands on its own', afterRepin);

  console.log('\n=== PHASE 3: holders are unaffected ===');
  // "Unchanged" must mean unchanged BY THE UPGRADE, not unchanged full stop — the
  // in-gap probe deliberately moved 1.0 from the hub balance to prove a holder
  // could still act mid-ceremony. An earlier version compared raw before/after and
  // reported its own transfer as damage: a check that failed for a reason other
  // than the one it names.
  const probeSpend: Record<string, number> = { [HUB]: 1.0 };
  for (const ch of HOLDER_CHAINS) {
    const now = await localCall(`(${T}.get-balance "${holder.account}")`, ch).catch(() => 0);
    const expected = balancesBefore[ch] - (probeSpend[ch] ?? 0);
    record('S3', `holder balance on chain ${ch} changed ONLY by the holder's own action`,
      now === expected, `${balancesBefore[ch]} -> ${now} (expected ${expected}${probeSpend[ch] ? `, after spending ${probeSpend[ch]}` : ', untouched'})`);
  }
  record('S3', 'the pool is intact', (await localCall(`(${C}.pool-balance)`, HUB)) === poolBefore,
    `${poolBefore} -> ${await localCall(`(${C}.pool-balance)`, HUB)}`);
  const postTransfer = await holderCanTransact(holder, peer, HUB);
  record('S3', 'a holder can still transfer after the whole ceremony', postTransfer.ok, postTransfer.err);

  console.log('\n=== PHASE 4: voting, on chains other than the hub ===');
  // One question, identical parameters, on every chain the holders are on.
  const t0 = await chainTime(HUB);
  const pid = `sim-${await localCall("(at 'block-height (chain-data))", HUB)}`;
  const starts = new Date(t0.getTime() + 60_000);          // 1 min out (floor is 0 in the variant)
  const ends = new Date(starts.getTime() + 48 * 3600_000); // 48h, inside 24h..30d
  const code = `(${T}.create-proposal "${pid}" "Which chain should we test next?" "Advisory." `
             + `["alpha" "beta" "gamma"] (time "${iso(t0)}") (time "${iso(starts)}") (time "${iso(ends)}"))`;
  await Promise.all(CHAINS.map((ch) => send({
    label: `publish the question @${ch}`, chainId: ch, code,
    signers: [gas, ...gov], gasLimit: 9000,
  })));
  record('S4', `the same question published to all ${CHAINS.length} chains`, true, pid);

  // Identical everywhere?
  const stamps = await Promise.all(CHAINS.map(async (ch) => {
    const h = await localCall(`(${T}.get-head-to-head "${pid}")`, ch) as Record<string, any>;
    return JSON.stringify([h.title, h.options, h['starts-at'], h['ends-at']]);
  }));
  record('S4', 'all 20 copies carry IDENTICAL parameters', new Set(stamps).size === 1, `${new Set(stamps).size} variant(s)`);

  // Wait for the window to open, then vote FROM THE OFF-HUB CHAINS.
  while ((await chainTime(HUB)).getTime() < starts.getTime() + 2000) {
    await new Promise((r) => setTimeout(r, 5000));
  }
  for (const ch of HOLDER_CHAINS) {
    const h = holder;
    const bal = await localCall(`(${T}.get-balance "${h.account}")`, ch).catch(() => 0);
    if (bal <= 0) { record('S4', `holder on chain ${ch} has no PCO to vote with`, false, `balance ${bal}`); continue; }
    const r = await send({
      label: `ballot from chain ${ch}`, chainId: ch,
      code: `(${T}.cast-vote "${pid}" "${h.account}" [0 1])`,
      signers: [{ kp: h, caps: (wc: any) => [wc('coin.GAS'), wc(`${T}.VOTE`, pid, h.account)] }],
      gasLimit: 4000, gasPrice: 1e-7,
    }).then(() => ({ ok: true, err: '' })).catch((e: any) => ({ ok: false, err: String(e.message).slice(0, 300) }));
    record('S4', `⭐ a ballot cast FROM CHAIN ${ch}${ch === HUB ? ' (hub)' : ' — OFF-HUB, the whole point'}`, r.ok, r.err);
    if (r.ok) {
      const w = await localCall(`(at 'turnout (${T}.get-results "${pid}"))`, ch);
      record('S4', `...and chain ${ch} tallied it against the balance held THERE`, w === bal, `turnout ${w}, balance ${bal}`);
    }
  }

  console.log('\n=== MEASURED GAS (worst across 20 chains) — for ceremony limits ===');
  for (const [k, v] of Object.entries(gasSeen)) console.log(`  ${v.toString().padStart(7)}  ${k}   (2x margin: ${v * 2})`);

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} simulation checks passed`);
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
