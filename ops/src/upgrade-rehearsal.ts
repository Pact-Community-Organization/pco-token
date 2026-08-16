// upgrade-rehearsal.ts — REHEARSE THE ACTUAL MAINNET UPGRADE, ON A NODE.
//
// WHY THIS EXISTS. The mainnet action is an UPGRADE of a module that already
// holds real balances, and the thing standing between a clean upgrade and a
// user-visible outage is one `bless` line. Everything else rehearses a FRESH
// deploy: `rehearse.ts` builds the world from nothing, and the REPL suite proves
// the bless mechanics in a simulated database. Neither runs the sequence that
// will actually happen:
//
//     1. deploy the NEW pco over the OLD one          <- pco-claim still pins the OLD hash here
//     2. redeploy pco-claim so it re-pins
//
// Between those two steps every pco-claim call goes through a stale pin, and
// without the bless it aborts with "hash not blessed". With a claim round open
// over a ~900,000 PCO pool, that window is user-visible.
//
// THE BLESS VALUE IS NETWORK-SPECIFIC, and that is the first thing this proved.
// `contracts/pco.pact` hardcodes the hash deployed on MAINNET. A module's hash
// covers its namespace and its dependencies, so the same source deployed to a
// devnet namespace hashes differently — the shipped bless can never match
// anything here. This rehearsal therefore substitutes the hash it actually
// observes on the node, exactly as make-dryrun.sh substitutes the throwaway
// supply. What it proves is the MECHANISM and the SEQUENCE; the mainnet VALUE is
// proven separately, by verify-deployed reading the live chain.
//
// READS CANNOT SEE THIS BREAK. `enforceBlessedHashes` is called only by
// `guardTable`, which bypasses it for reads when the node runs
// `--allowReadsInLocal` — as this devnet and the public mainnet endpoint do. A
// /local `pool-balance` answers 900000 across a broken pin. Every probe here
// therefore goes through a real transaction; an earlier version used /local and
// concluded, wrongly, that the hazard did not exist on 3.2.
//
// BOTH DIRECTIONS, because a check that cannot fail proves nothing:
//   * upgrade with the WRONG hash blessed -> pco-claim MUST break
//   * upgrade again with the RIGHT hash    -> pco-claim MUST recover
// The second upgrade repairs the first, which is what makes both testable in one
// namespace without resetting the devnet.
//
// Runs in ns `free` on the devnet, deliberately: `user` holds the rehearsal's
// own state and its pending question, and this must not disturb them.
//
// Usage:  npx tsx src/upgrade-rehearsal.ts        (devnet only; refuses mainnet)
import { readFileSync } from 'node:fs';
import { HUB, NS, SENDER00, checks, localCall, record, send, type Keypair } from './env.js';
import { preupgradeSource } from './preupgrade-source.js';

if (process.env.PCO_NETWORK && process.env.PCO_NETWORK !== 'recap-development') {
  console.error(`ABORT: this rehearsal deploys and upgrades modules. It is devnet-only; PCO_NETWORK=${process.env.PCO_NETWORK}`);
  process.exit(2);
}
if (NS !== 'free') {
  console.error(`ABORT: run with PCO_NS=free — this must not touch the 'user' namespace, which holds the main rehearsal's state.`);
  process.exit(2);
}

const K = JSON.parse(readFileSync(new URL('../out/rehearsal-keys.json', import.meta.url), 'utf8')) as Record<string, Keypair>;
const T = `${NS}.pco`;
const C = `${NS}.pco-claim`;
const KS = `${NS}.pco-gov`;
const gas = { kp: SENDER00, caps: (wc: any) => [wc('coin.GAS')] };
const gov = [{ kp: K.deviceA }, { kp: K.deviceB }];
// The OLD contracts still read symbol/precision/total-supply from the data block
// — that parameterisation is exactly what cold-audit F3 removed, because an
// upgrade carrying a wrong `precision` permanently broke fractional balances. The
// new contracts ignore these keys entirely; they are supplied only so the OLD
// version can be deployed here at all. That the new deploys need none of them is
// itself the fix working.
const LEGACY = { symbol: 'PCO', precision: 12, 'total-supply': 1000000.0 };
const DATA = { ns: NS, upgrade: false, ...LEGACY };
const GOVKS = { keys: [K.deviceA.publicKey, K.deviceB.publicKey, K.deviceC.publicKey], pred: 'keys-2' };

const { dir: OLD, ref: OLD_REF } = preupgradeSource();   // extracted from git, fresh every run
const NEWSRC = new URL('../../contracts/', import.meta.url).pathname;
// The substituted contracts are NOT written to disk. They are one regex away from
// contracts/pco.pact and writing them into ops/out/ put two more generated pco
// near-copies under the static checker, inflating the pinned WARN baseline by 26
// for artifacts nobody reads.

/** The shipped pco.pact with its bless line repointed at `hash`. */
function pcoBlessing(hash: string): string {
  const src = readFileSync(`${NEWSRC}pco.pact`, 'utf8');
  const out = src.replace(/\(bless "[^"]*"\)/, `(bless "${hash}")`);
  if (out === src) throw new Error('refusing to continue: no (bless ...) form found in contracts/pco.pact');
  if (!out.includes(`(bless "${hash}")`)) throw new Error('bless substitution did not land');
  return out;
}

/** Deploys in upgrade mode whenever the module is already there, so the whole
 *  rehearsal is re-runnable — `create-table` aborts a second fresh deploy, and a
 *  rehearsal you can only run once is a rehearsal you stop running. */
async function moduleExists(qualified: string): Promise<boolean> {
  return localCall(`(describe-module "${qualified}")`, HUB).then(() => true).catch(() => false);
}
async function deploy(label: string, code: string, qualified: string, gasLimit = 90000) {
  const upgrade = await moduleExists(qualified);
  return send({
    label: `${label}${upgrade ? ' (upgrade mode)' : ''}`, chainId: HUB, code,
    data: { ...DATA, upgrade, 'pco-gov': GOVKS },
    signers: [gas, ...gov], gasLimit,
  });
}

/**
 * Exercise pco-claim's PINNED copy of pco through a REAL TRANSACTION, not /local.
 *
 * THIS DISTINCTION IS THE WHOLE TEST, and getting it wrong cost me a wrong
 * conclusion. `enforceBlessedHashes` has exactly one caller — `guardTable` — and
 * that caller bypasses the check for READS when the node runs with
 * `--allowReadsInLocal`, which this devnet and the public mainnet endpoint both
 * do (Pact/Core/IR/Eval/Runtime/Utils.hs, `checkLocalBypass`: GtWrite and
 * GtCreateTable always enforce, everything else returns early when the flag is
 * set). So a /local read of pool-balance answers 900000 across a broken pin and
 * looks perfectly healthy.
 *
 * Measured on this devnet, same call, same moment:
 *     via /local : OK -> 900000
 *     via /send  : "Execution aborted, hash not blessed for module: free.pco"
 *
 * THE OPERATIONAL CONSEQUENCE IS WORSE THAN A CLEAN BREAK. After an unblessed
 * upgrade every read-only health check keeps reporting a healthy pool while every
 * user transaction fails — verify-deployed included, since it reads via /local.
 * Nothing we run today would notice.
 */
async function claimCallWorks(): Promise<{ ok: boolean; err: string }> {
  try {
    await send({ label: 'pco-claim -> pco through the pinned copy', chainId: HUB,
      code: `(${C}.pool-balance)`, signers: [gas], gasLimit: 5000 });
    return { ok: true, err: '' };
  } catch (e: any) { return { ok: false, err: String(e.message).slice(0, 320) }; }
}

async function main() {
  console.log(`upgrade rehearsal — ns=${NS} on the devnet (hub chain ${HUB})`);
  console.log(`pre-upgrade contracts from git at ${OLD_REF.slice(0, 8)}\n`);

  // ---- 1. the world as it is on mainnet today: the OLD contracts ----
  await send({
    label: 'define the governance keyset', chainId: HUB,
    code: `(namespace "${NS}") (define-keyset "${KS}" (read-keyset 'pco-gov))`,
    data: { 'pco-gov': GOVKS }, signers: [gas, ...gov], gasLimit: 3000,
  }).catch(() => { /* already defined on a re-run */ });

  await deploy('deploy OLD pco (the version live on mainnet)', readFileSync(`${OLD}/pco.pact`, 'utf8'), T);
  await deploy('deploy OLD pco-claim (pins the OLD pco hash)', readFileSync(`${OLD}/pco-claim.pact`, 'utf8'), C, 60000);
  const oldHash = String(await localCall(`(at 'hash (describe-module "${T}"))`, HUB));
  record('U1', 'OLD contracts deployed; pco-claim pins the old pco', /^[A-Za-z0-9_-]{43}$/.test(oldHash), `old hash ${oldHash}`);

  // Mint, exactly as the real deployment does — the probe below reads the POOL's
  // balance through pco-claim's pinned copy of pco, and without the mint that
  // account does not exist, so the probe fails for a reason that has nothing to do
  // with pinning. A probe that cannot distinguish "stale pin" from "no such row"
  // proves nothing in either direction.
  const minted = (await localCall(`(${T}.chain-minted)`, HUB).catch(() => 0)) !== 0;
  if (!minted) {
    await send({
      label: 'one-shot mint so the pool exists', chainId: HUB,
      code: `(${T}.init-mint [
        { "account": (${C}.pool-account), "guard": (${C}.pool-guard), "amount": 900000.0 },
        { "account": "r:${KS}", "guard": (keyset-ref-guard "${KS}"), "amount": 100000.0 } ])`,
      data: { ...DATA, upgrade: true }, signers: [gas, ...gov], gasLimit: 6000,
    });
  }

  const baseline = await claimCallWorks();
  record('U1', 'baseline: pco-claim can call pco through its fresh pin', baseline.ok, baseline.err);

  // The shipped bless targets MAINNET's hash, which cannot match a devnet
  // deployment. Assert that rather than let it look like a passing case.
  const shipped = (readFileSync(`${NEWSRC}pco.pact`, 'utf8').match(/\(bless "([^"]*)"\)/) ?? [])[1] ?? '';
  record('U1', "the shipped bless is mainnet's hash and does NOT match this devnet's — substituting",
    shipped !== oldHash, `shipped ${shipped.slice(0, 12)}… vs devnet ${oldHash.slice(0, 12)}…`);

  // ---- 2. THE NEGATIVE: upgrade with the WRONG hash blessed ----
  // A well-formed hash that is simply not the one pco-claim pinned.
  const decoy = 'A'.repeat(43);
  await deploy('upgrade pco with the WRONG hash blessed', pcoBlessing(decoy), T);
  const broken = await claimCallWorks();
  // ASSERTED, now that the probe exercises the path that enforces.
  record('U2', 'an upgrade blessing the WRONG hash BREAKS pco-claim (this is the hazard)',
    !broken.ok && /not blessed/i.test(broken.err),
    broken.ok ? 'it did NOT break — check whether this probe is reading via /local' : broken.err);

  // ---- 3. THE POSITIVE: upgrade again, blessing the hash pco-claim actually pins ----
  await deploy('upgrade pco blessing the hash pco-claim pins', pcoBlessing(oldHash), T);
  const healed = await claimCallWorks();
  record('U3', 'blessing the right hash RESTORES pco-claim across the stale pin', healed.ok, healed.err);

  // ---- 4. the second ceremony step: pco-claim re-pins ----
  await deploy('redeploy pco-claim so it re-pins the new pco', readFileSync(`${NEWSRC}pco-claim.pact`, 'utf8'), C, 60000);
  const repinned = await claimCallWorks();
  record('U4', 'after the re-pin pco-claim works on its own, without relying on the bless', repinned.ok, repinned.err);

  // ---- 5. the new module really is the new one ----
  const live = await localCall(`(${T}.live-ids)`, HUB).then(() => true).catch(() => false);
  record('U4', 'the upgraded module exposes the new chain-local governance surface', live);

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} upgrade-rehearsal checks passed`);
  if (passed !== checks.length) process.exitCode = 1;
  else console.log('\nThe two-step mainnet sequence is proven on a node, in BOTH directions:\n'
    + '  blessing the wrong hash BREAKS pco-claim; blessing the right one restores it.\n'
    + '  The bless is load-bearing, and the probe must go through a TRANSACTION —\n'
    + '  a /local read answers healthy across a broken pin (see claimCallWorks).');
}

main().catch((e) => { console.error(e); process.exit(1); });
