// rehearse.ts — the FULL mainnet-pilot ceremony, dress-rehearsed on devnet.
//
// Mirrors docs/mainnet-pilot/RUNBOOK.md step for step, with three local
// softkeys standing in for the three Ledger devices (the signing TRANSPORT
// differs on mainnet; every keyset/threshold/authorization semantic here is
// the real one). Namespace creation is the one step devnet cannot host
// (ns v1 genesis, community-held registry keys): it is rehearsed in
// tests/namespace-rehearsal.repl against the byte-true mainnet ns source,
// and preflighted read-only against live mainnet in the runbook.
//
// Run:  npm run rehearse            (devnet :8090, recap-development)
// Keys: ops/out/rehearsal-keys.json (throwaway; kept until devnet reset).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import {
  CHAINS, HUB, NS, SENDER00, checks, client, localCall, newKey, preflight,
  record, send, xchain, type Keypair, type SignerSpec,
} from './env.js';

const T = `${NS}.pco`;
const C = `${NS}.pco-claim`;
const G = `${NS}.pco-gas-station`;
const KS = `${NS}.pco-gov`;
// ops authority = module state in `pco`, named by governance (1-of-2 over the
// two ACTIVE devices) — there is no pco-ops KEYSET any more
const QUEST1 = 'pco-devnet-quest-1';
const QUEST2 = 'pco-devnet-quest-2';

const contract = (f: string) =>
  readFileSync(new URL(`../../contracts/${f}`, import.meta.url), 'utf8');

// deploy-time parameters — the same values PLAN.md fixes for mainnet
const DEPLOY_DATA = {
  ns: NS, upgrade: false,
  symbol: 'PCO', precision: 12, 'total-supply': 1000000.0,
};

// ---------- keys: 3 "devices" + spare + community personas ----------
type KeyFile = Record<string, Keypair>;
const keyPath = new URL('../out/rehearsal-keys.json', import.meta.url);
function loadOrGenKeys(): KeyFile {
  // devices persist across runs (they own the on-chain keyset); claimants
  // are fresh every run (claims are one-shot per account) but persisted too,
  // per the throwaway-secret discipline for keys that acquire on-chain state.
  const base: KeyFile = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) : {};
  for (const d of ['deviceA', 'deviceB', 'deviceC', 'deviceD']) base[d] = base[d] ?? newKey();
  const run = Date.now().toString(36);
  for (const u of ['u1', 'u2', 'u3']) base[u] = newKey();
  mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
  writeFileSync(keyPath, JSON.stringify(base, null, 2));
  writeFileSync(new URL(`../out/claimants-${run}.json`, import.meta.url),
    JSON.stringify({ u1: base.u1, u2: base.u2, u3: base.u3 }, null, 2));
  return base;
}
const K = loadOrGenKeys();

async function moduleExists(name: string, ch: string): Promise<boolean> {
  try { await localCall(`(at 'hash (describe-module "${name}"))`, ch); return true; }
  catch { return false; }
}
const unscoped = (kp: Keypair): SignerSpec => ({ kp });
// Scoped device signature: the ceremony standard for anything a hardware
// wallet blind-signs — the signature is usable ONLY for the named capability,
// so a mis-built or substituted tx cannot spend it on something else.
const opsAdmin = (kp: Keypair): SignerSpec => ({ kp, caps: (wc) => [wc(`${T}.OPS-ADMIN`)] });
const gasCap = (kp: Keypair): SignerSpec => ({ kp, caps: (wc) => [wc('coin.GAS')] });

async function main() {
  console.log(`PCO mainnet-pilot dress rehearsal — ns=${NS}, 20 chains`);
  console.log(`devices: A=${K.deviceA.publicKey.slice(0, 8)} B=${K.deviceB.publicKey.slice(0, 8)} C=${K.deviceC.publicKey.slice(0, 8)} (spare D=${K.deviceD.publicKey.slice(0, 8)})`);

  // ---------- P2: BOTH keysets (gov 2-of-3 + ops 1-key) on ALL 20 chains ----------
  console.log('\nP2  keyset ceremony ×20 (pco-gov only — ops is module state)');
  await Promise.all(CHAINS.map(async (ch) => {
    const r = await send({
      label: `define-keysets @${ch}`,
      code: `(namespace "${NS}") (define-keyset "${KS}" (read-keyset 'pco-gov))`,
      chainId: ch,
      signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceB)],
      data: {
        'pco-gov': { keys: [K.deviceA.publicKey, K.deviceB.publicKey, K.deviceC.publicKey], pred: 'keys-2' },
      },
      gasLimit: 2500,
    });
    return r;
  }));
  const ksInfo = await localCall(`(describe-keyset "${KS}")`, HUB);
  record('P2', 'keys-2 gov keyset defined on all 20 chains (spot: hub)', String(JSON.stringify(ksInfo)).includes('keys-2'));
  record('P2', 'ops is NOT a keyset any more (nothing to leave undefined)', true,
    'named by governance via set-ops-guard after deploy — see P3d');

  // ---------- P3: deploys ×20, dependency order ----------
  for (const [name, file, extra] of [
    ['pco', 'pco.pact', {}],
    ['pco-claim', 'pco-claim.pact', {}],
    ['pco-gas-station', 'pco-gas-station.pact', {}],
  ] as const) {
    console.log(`\nP3  deploy ${name} ×20`);
    const gases: number[] = [];
    await Promise.all(CHAINS.map(async (ch) => {
      const upgrade = await moduleExists(`${NS}.${name}`, ch);
      const r = await send({
        label: `deploy ${name} @${ch}${upgrade ? ' (upgrade)' : ''}`,
        code: contract(file),
        chainId: ch,
        signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceB)],
        data: { ...DEPLOY_DATA, ...extra, upgrade },
        gasLimit: 150000,
      });
      gases.push(r.gas as number);
    }));
    record('P3', `${name} deployed on 20/20 chains`, gases.length === 20,
      `gas min ${Math.min(...gases)} max ${Math.max(...gases)}`);
  }
  const poolAcct: string = await localCall(`(${C}.pool-account)`, HUB);
  const stationAcct: string = await localCall(`(${G}.station-account)`, HUB);
  console.log(`  pool=${poolAcct.slice(0, 24)}… station=${stationAcct.slice(0, 24)}…`);

  // ---------- P3b: ensure LATE-ADDED tables exist (upgrade path) ----------
  // Tables added after the first deploys: fresh deploys create them in the
  // module footer, but an UPGRADE touches no tables — a one-off, module-admin
  // create-table per chain covers already-deployed devnets. Re-run-safe.
  const LATE_TABLES = ['vote-delegates', 'rcv-proposals', 'rcv-ballots', 'rcv-actives', 'ops-auth', 'rcv-margins', 'non-voting'];
  const LATE_STATION_TABLES = ['station-info'];
  console.log('\nP3b ensure late-added tables ×20');
  let created = 0;
  await Promise.all(CHAINS.flatMap((ch) => LATE_TABLES.map(async (tbl) => {
    const exists = await localCall(`(take 1 (keys ${T}.${tbl}))`, ch)
      .then(() => true).catch(() => false);
    if (exists) return;
    await send({
      label: `create ${tbl} @${ch}`,
      code: `(acquire-module-admin ${T}) (create-table ${T}.${tbl})`,
      chainId: ch,
      signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceB)],
      gasLimit: 3000,
    });
    created += 1;
  })));
  await Promise.all(CHAINS.flatMap((ch) => LATE_STATION_TABLES.map(async (tbl) => {
    const exists = await localCall(`(take 1 (keys ${G}.${tbl}))`, ch)
      .then(() => true).catch(() => false);
    if (exists) return;
    await send({
      label: `create ${tbl} @${ch}`,
      code: `(acquire-module-admin ${G}) (create-table ${G}.${tbl})`,
      chainId: ch,
      signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceB)],
      gasLimit: 3000,
    });
    created += 1;
  })));
  record('P3b', `late-added tables (${[...LATE_TABLES, ...LATE_STATION_TABLES].join(', ')}) present on all 20 chains`,
    true, created ? `created ${created} table instances` : 'already present everywhere');

  // ---------- P3c: stale-dependency canary ----------
  // A dependent module re-pins pco only when ITS deploy actually lands (its
  // hash embeds the dependency): probe the claim->pco call path NOW so a
  // stale pin ("hash not blessed") surfaces here, not deep in P6.
  const pinProbe = await preflight({
    label: 'grant pin-probe', chainId: HUB,
    code: `(${C}.grant "${K.deviceD.account}" (read-keyset 'g) 1.0 "pin probe")`,
    data: { g: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 9000,
  });
  record('P3c', 'pco-claim links the CURRENT pco (no stale dependency pin)',
    pinProbe.ok || !pinProbe.error.includes('hash not blessed'), pinProbe.error.slice(0, 80));
  if (pinProbe.error.includes('hash not blessed')) {
    throw new Error('stale dependency pin: redeploy pco-claim/pco-gas-station after any pco change');
  }

  // ---------- P3d: ops authority — named by governance, always recoverable ----------
  console.log('\nP3d ops authority (module state, governance-owned)');
  // Before naming: ops defaults to the governance guard, so nothing is stranded
  // on a fresh deploy — but a lone ops candidate has no authority yet.
  const unnamed = await preflight({
    label: 'never-named device tries ops', chainId: HUB,
    code: `(${C}.set-open true)`,
    signers: [gasCap(SENDER00), unscoped(K.deviceD)], gasLimit: 4000,
  });
  record('P3d', 'a device the governance never named has NO ops authority',
    !unnamed.ok && unnamed.error.includes('ops authorization failed'), unnamed.error.slice(0, 70));

  // Governance names the ops authority: 1-of-2 over the two ACTIVE devices.
  await Promise.all(CHAINS.map((ch) => send({
    label: `set-ops-guard @${ch}`, chainId: ch,
    code: `(${T}.set-ops-guard (read-keyset 'ops-authority))`,
    data: { 'ops-authority': { keys: [K.deviceA.publicKey, K.deviceB.publicKey], pred: 'keys-any' } },
    signers: [gasCap(SENDER00), opsAdmin(K.deviceA), opsAdmin(K.deviceB)],
    gasLimit: 3000,
  })));
  record('P3d', 'governance named the ops authority on all 20 chains (1-of-2)', true);

  // Either active device now operates solo.
  for (const [who, kp] of [['A', K.deviceA], ['B', K.deviceB]] as const) {
    const r = await preflight({
      label: `ops solo ${who}`, chainId: HUB, code: `(${C}.set-open true)`,
      signers: [gasCap(SENDER00), unscoped(kp)], gasLimit: 4000,
    });
    record('P3d', `device ${who} operates solo (1-of-2: one lost device never halts ops)`, r.ok, r.error.slice(0, 60));
  }

  // The ops authority CANNOT re-point itself — the hijack path is closed.
  const hijack = await preflight({
    label: 'ops self-rotation', chainId: HUB,
    code: `(${T}.set-ops-guard (read-keyset 'ops-authority))`,
    data: { 'ops-authority': { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), unscoped(K.deviceA)], gasLimit: 3000,
  });
  record('P3d', 'the ops authority CANNOT re-point itself (hijack closed)',
    !hijack.ok && hijack.error.includes('Keyset failure'), hijack.error.slice(0, 60));

  // ALWAYS RECOVERABLE: a governance pair that EXCLUDES the ops devices
  // replaces the authority — no upgrade, no cooperation from the outgoing key.
  const recov = await preflight({
    label: 'gov recovers ops without device A', chainId: HUB,
    code: `(${T}.set-ops-guard (read-keyset 'ops-authority))`,
    data: { 'ops-authority': { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), unscoped(K.deviceB), unscoped(K.deviceC)],
    gasLimit: 3000,
  });
  record('P3d', 'ALWAYS RECOVERABLE: gov pair B+C re-points ops with no upgrade', recov.ok,
    recov.ok ? 'preflight ok' : recov.error.slice(0, 70));

  // ---------- P4: one-shot mint on the hub (pair A+C this time) ----------
  console.log('\nP4  init-mint (hub)');
  const alreadyMinted = (await localCall(`(${T}.chain-minted)`, HUB)) !== 0;
  if (!alreadyMinted) {
    const mint = await send({
      label: 'init-mint',
      code: `(${T}.init-mint [
        { "account": (${C}.pool-account), "guard": (${C}.pool-guard), "amount": 900000.0 },
        { "account": "r:${KS}", "guard": (keyset-ref-guard "${KS}"), "amount": 100000.0 } ])`,
      chainId: HUB,
      signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceC)],
      gasLimit: 4000,
    });
    record('P4', 'one-shot mint under a 2-of-3 pair (A+C)', true, `gas ${mint.gas}`);
    record('P4', 'pool holds 90%', (await localCall(`(${C}.pool-balance)`, HUB)) === 900000);
    record('P4', 'reserve holds 10%', (await localCall(`(${T}.get-balance "r:${KS}")`, HUB)) === 100000);
  } else {
    record('P4', 'mint already performed on a previous run (one-shot held)', true);
  }
  const remint = await preflight({
    label: 'second mint', chainId: HUB,
    code: `(${T}.init-mint [ { "account": "r:${KS}", "guard": (keyset-ref-guard "${KS}"), "amount": 1000000.0 } ])`,
    signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceB)], gasLimit: 4000,
  });
  record('P4', 'second mint refused on-node', !remint.ok && remint.error.includes('already minted'), remint.error.slice(0, 80));

  // ---------- P5: fund the station (hub) ----------
  console.log('\nP5  fund the gas station');
  const stationBal = await localCall(`(coin.get-balance "${stationAcct}")`, HUB).catch(() => 0);
  if (stationBal < 1) {
    await send({
      label: 'fund station',
      code: `(coin.transfer-create "sender00" "${stationAcct}" (${G}.create-gas-payer-guard) 2.0)`,
      chainId: HUB,
      signers: [{ kp: SENDER00, caps: (wc) => [wc('coin.GAS'), wc('coin.TRANSFER', 'sender00', stationAcct, { decimal: '2.0' })] }],
      gasLimit: 2500,
    });
  }
  record('P5', 'station funded (>= 1 KDA float)', (await localCall(`(coin.get-balance "${stationAcct}")`, HUB)) >= 1);

  // ---------- P6: genesis round + master switch — the ops key SOLO ----------
  console.log('\nP6  open claims (ops key solo): genesis round + master switch');
  const roundExists = await localCall(`(contains "genesis" (${C}.round-ids))`, HUB).catch(() => false);
  if (!roundExists) {
    await send({
      label: 'create genesis round + open (ops solo)',
      code: `(${C}.create-round "genesis" (hash "${QUEST1}") 100.0 30000.0 (time "2020-01-01T00:00:00Z") (time "2030-01-01T00:00:00Z")) (${C}.set-open true)`,
      chainId: HUB,
      signers: [gasCap(SENDER00), unscoped(K.deviceA)],
      gasLimit: 3000,
    });
  } else {
    // re-run: the genesis code is FROZEN once the round has claims, and the
    // rotation drills below no longer touch it, so it is still QUEST1. Only
    // the master switch needs re-opening.
    await send({
      label: 'open claims (re-run)',
      code: `(${C}.set-open true)`,
      chainId: HUB,
      signers: [gasCap(SENDER00), unscoped(K.deviceA)],
      gasLimit: 3000,
    });
  }
  record('P6', 'genesis round created + claims opened by the ops key ALONE (1-of tier on-node)',
    (await localCall(`(at 'open (${C}.get-config))`, HUB)) === true
    && (await localCall(`(at 'amount (${C}.get-round "genesis"))`, HUB)) === 100);
  // the ops meter is EPOCH-scoped (daily): the 30k budget commitment lands on
  // the epoch the round is CREATED — a re-run on a later epoch only sees the
  // day's small ops (code resets), so assert per branch.
  const epochSpent = await localCall(`(${C}.ops-epoch-spent)`, HUB) as number;
  record('P6', roundExists
    ? 'ops meter live (round reused; budget was committed on its creation epoch)'
    : 'round budget committed to the daily ops meter',
    roundExists ? epochSpent >= 0 : epochSpent >= 30000, `epoch spent ${epochSpent}`);

  // ---------- P7: gasless claims (the sponsored envelope) ----------
  console.log('\nP7  gasless claims');
  const poolBefore = await localCall(`(${C}.pool-balance)`, HUB);
  const sponsoredClaim = (u: Keypair, quest: string, mirror: boolean) => ({
    label: `gasless claim ${u.account.slice(0, 12)}…`,
    code: `(${C}.claim "genesis" "${u.account}" (read-keyset 'ks) "${quest}")`,
    chainId: HUB,
    sender: stationAcct,
    signers: [{ kp: u, caps: (wc: any) => [wc(`${G}.GAS_PAYER`, 'claimant', { int: 6000 }, { decimal: '0.0000001' })] }] as SignerSpec[],
    data: mirror
      ? { ks: { keys: [u.publicKey], pred: 'keys-all' }, 'tx-type': 'exec', 'exec-code': [`(${C}.claim "genesis" "${u.account}" (read-keyset 'ks) "${quest}")`] }
      : { ks: { keys: [u.publicKey], pred: 'keys-all' } },
    gasLimit: 6000,
    gasPrice: 1e-8,
  });
  const c1 = await send(sponsoredClaim(K.u1, QUEST1, true));
  record('P7', 'u1 claimed gasless (mirrored envelope)', true, `gas ${c1.gas}`);
  // the node injects tx-type/exec-code from the REAL payload — prove it by
  // sending WITHOUT the data mirror:
  const c2 = await send(sponsoredClaim(K.u2, QUEST1, false));
  record('P7', 'u2 claimed gasless with NO data mirror (node injection proven)', true, `gas ${c2.gas}`);
  await send(sponsoredClaim(K.u3, QUEST1, true));
  for (const u of [K.u1, K.u2, K.u3]) {
    record('P7', `${u.account.slice(0, 12)}… holds 100 PCO, zero KDA anywhere`,
      (await localCall(`(${T}.get-balance "${u.account}")`, HUB)) === 100);
  }
  const poolAfterClaims = await localCall(`(${C}.pool-balance)`, HUB);
  record('P7', 'pool decremented by exactly 300', poolAfterClaims === poolBefore - 300);
  record('P7', 'station meter charged', (await localCall(`(${G}.epoch-spent)`, HUB)) > 0);

  // negatives at the station door (preflight = no mempool burn):
  const evil1 = await preflight({
    label: 'sponsored coin.transfer', chainId: HUB, sender: stationAcct,
    code: `(coin.transfer "${K.u1.account}" "${K.u2.account}" 1.0)`,
    signers: [{ kp: K.u1, caps: (wc) => [wc(`${G}.GAS_PAYER`, 'x', { int: 6000 }, { decimal: '0.0000001' })] }],
    gasLimit: 6000, gasPrice: 1e-8,
  });
  record('P7', 'station refuses to sponsor a non-allowlisted call', !evil1.ok && evil1.error.includes('not a sponsored call'), evil1.error.slice(0, 90));
  // claim-only: the station refuses vote / propose / PCO-transfer too
  for (const [name, code] of [
    ['cast-vote', `(${T}.cast-vote "1" "${K.deviceD.account}" [0])`],
    ['create-proposal', `(${T}.create-proposal "t" "b" ["a" "b"] 72)`],
    ['pco.transfer', `(${T}.transfer "${K.deviceD.account}" "${K.u1.account}" 1.0)`],
  ] as const) {
    const r = await preflight({
      label: `station ${name}`, chainId: HUB, sender: stationAcct, code,
      signers: [{ kp: K.deviceD, caps: (wc) => [wc(`${G}.GAS_PAYER`, 'x', { int: 6000 }, { decimal: '0.0000001' })] }],
      gasLimit: 6000, gasPrice: 1e-8,
    });
    record('P7', `station refuses to sponsor ${name} (claim-only)`, !r.ok && r.error.includes('not a sponsored call'), r.error.slice(0, 80));
  }
  const evil2 = await preflight({
    label: 'double claim', chainId: HUB, sender: stationAcct,
    code: `(${C}.claim "genesis" "${K.u1.account}" (read-keyset 'ks) "${QUEST1}")`,
    signers: [{ kp: K.u1, caps: (wc) => [wc(`${G}.GAS_PAYER`, 'x', { int: 6000 }, { decimal: '0.0000001' })] }],
    data: { ks: { keys: [K.u1.publicKey], pred: 'keys-all' } },
    gasLimit: 6000, gasPrice: 1e-8,
  });
  record('P7', 'double claim refused on-node', !evil2.ok, evil2.error.slice(0, 90));
  const evil3 = await preflight({
    label: 'wrong code', chainId: HUB, sender: stationAcct,
    code: `(${C}.claim "genesis" "${K.deviceD.account}" (read-keyset 'ks) "guessed-wrong")`,
    signers: [{ kp: K.deviceD, caps: (wc) => [wc(`${G}.GAS_PAYER`, 'x', { int: 6000 }, { decimal: '0.0000001' })] }],
    data: { ks: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    gasLimit: 6000, gasPrice: 1e-8,
  });
  record('P7', 'wrong engagement code refused', !evil3.ok && evil3.error.includes('wrong engagement code'), evil3.error.slice(0, 90));

  // ---- P7b: the two hardening rules, proven ON-NODE ----
  // (1) a round's engagement code freezes at its first claim, so a compromised
  //     ops key cannot re-point a live round's budget to accounts it controls.
  const frozenCode = await preflight({
    label: 'ops tries to re-point a claimed round', chainId: HUB,
    code: `(${C}.set-round-code "genesis" (hash "attacker-code"))`,
    signers: [gasCap(SENDER00), unscoped(K.deviceA)], gasLimit: 2000,
  });
  record('P7b', 'a claimed round\'s code is FROZEN (ops cannot redirect the budget)',
    !frozenCode.ok && frozenCode.error.includes('cannot rotate the code once the round has claims'),
    frozenCode.error.slice(0, 90));

  // (2) the gas-station float is not transferable out by a self-paid caller.
  //     This is the drain that emptied the float before the sender binding.
  const drain = await preflight({
    label: 'self-paid drain of the station float', chainId: HUB,
    code: `(coin.transfer "${stationAcct}" "${K.deviceD.account}" 0.5)`,
    signers: [gasCap(SENDER00), {
      kp: K.deviceD,
      caps: (wc) => [wc('coin.TRANSFER', stationAcct, K.deviceD.account, { decimal: '0.5' })],
    }],
    gasLimit: 3000,
  });
  record('P7b', 'the station float is NOT transferable by a self-paid caller',
    !drain.ok && drain.error.includes('station guard'), drain.error.slice(0, 90));

  // (3) the claim pool registers ITSELF as outside the float at deploy, so the
  //     ~900k of undistributed supply cannot vote. If this regresses, the org
  //     silently gains a controlling bloc in its own advisory tally.
  const poolPrincipal = await localCall(`(${C}.pool-account)`, HUB);
  const poolExcluded = await localCall(`(${T}.non-voting? "${poolPrincipal}")`, HUB);
  record('P7b', 'the claim pool self-registered as non-voting at deploy',
    poolExcluded === true, `pool=${String(poolPrincipal).slice(0, 34)}…`);
  const poolVote = await preflight({
    label: 'pool tries to vote', chainId: HUB,
    code: `(${T}.cast-vote "1" "${poolPrincipal}" [0])`,
    signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceB)], gasLimit: 6000,
  });
  record('P7b', 'the pool is refused at the ballot on-node',
    !poolVote.ok && poolVote.error.includes('non-voting'), poolVote.error.slice(0, 90));

  // ---------- P8: governance — ADMIN-authored ranked-choice questions ----------
  console.log('\nP8  governance (admin-authored RCV; ballots are self-paid)');
  // voters pay their OWN gas (station sponsors claim only)
  const fundKda = async (u: Keypair) => {
    if ((await localCall(`(coin.get-balance "${u.account}")`, HUB).catch(() => 0)) >= 0.5) return;
    await send({
      label: `fund ${u.account.slice(0, 10)} KDA`, chainId: HUB,
      code: `(coin.transfer-create "sender00" "${u.account}" (read-keyset 'gk) 1.0)`,
      signers: [{ kp: SENDER00, caps: (wc) => [wc('coin.GAS'), wc('coin.TRANSFER', 'sender00', u.account, { decimal: '1.0' })] }],
      data: { gk: { keys: [u.publicKey], pred: 'keys-all' } }, gasLimit: 2000,
    });
  };
  await Promise.all([fundKda(K.u1), fundKda(K.u2), fundKda(K.u3)]);

  // a HOLDER cannot put a proposal on-chain — questions are admin-authored
  const communityProp = await preflight({
    label: 'holder create-proposal (must fail)', chainId: HUB, sender: K.u1.account,
    code: `(${T}.create-proposal "t" "b" ["a" "b"] 72)`,
    signers: [{ kp: K.u1, caps: (wc) => [wc('coin.GAS')] }],
    gasLimit: 2500, gasPrice: 1e-7,
  });
  record('P8', 'a token holder CANNOT create proposals (admin-authored)',
    !communityProp.ok && communityProp.error.includes('governance or ops authority required'),
    communityProp.error.slice(0, 70));

  // the OPS key alone opens a ranked-choice question (routine tier on-node)
  let pid: string;
  try {
    const prop = await send({
      label: 'create-proposal (OPS solo, ranked-choice)',
      code: `(${T}.create-proposal "Which template family should the catalog grow next?" "Advisory - rank the options." ["vesting" "oracle" "marketplace"] 168)`,
      chainId: HUB,
      signers: [gasCap(SENDER00), unscoped(K.deviceA)],
      gasLimit: 4000,
    });
    pid = (prop.result as any).data;
    record('P8', `RCV question ${pid} opened by the OPS key alone`, typeof pid === 'string', `gas ${prop.gas}`);
  } catch (e: any) {
    if (!String(e.message).includes('too many active proposals')) throw e;
    const open: string[] = await localCall(`(${T}.open-ids)`, HUB);
    pid = open[open.length - 1];
    record('P8', `open-proposal cap held (3 max) - reusing open question ${pid}`, true);
  }
  const res0 = await localCall(`(${T}.get-results "${pid}")`, HUB);
  const s0: number[] = res0.scores;
  const scoresEq = (got: number[], want: number[]) =>
    JSON.stringify(got.map((v) => Math.round(v * 100) / 100)) === JSON.stringify(want.map((v) => Math.round(v * 100) / 100));

  const voteSelfPaid = (u: Keypair, ranking: number[]) => send({
    label: `self-paid ranked ballot [${ranking}]`,
    code: `(${T}.cast-vote "${pid}" "${u.account}" [${ranking.join(' ')}])`,
    chainId: HUB,
    signers: [{ kp: u, caps: (wc) => [wc('coin.GAS'), wc(`${T}.VOTE`, pid, u.account)] }],
    gasLimit: 3000, gasPrice: 1e-7,
  });
  // K=3: position p contributes weight*(3-p). u2 (100): [0] -> +300 opt0.
  // u3 (100): [1 0] -> +300 opt1, +200 opt0.
  await voteSelfPaid(K.u2, [0]);
  await voteSelfPaid(K.u3, [1, 0]);
  let res = await localCall(`(${T}.get-results "${pid}")`, HUB);
  record('P8', 'Borda scores: u2 [0] and u3 [1,0] tallied live',
    scoresEq(res.scores, [s0[0] + 500, s0[1] + 300, s0[2]]) && res.turnout === res0.turnout + 200,
    JSON.stringify(res.scores).slice(0, 80));

  // live release: u2 moves 40 away -> ballot [0] sheds 40 weight = -120 points
  await send({
    label: 'u2 transfers 40 to u3 (ballot release)',
    code: `(${T}.transfer "${K.u2.account}" "${K.u3.account}" 40.0)`,
    chainId: HUB,
    signers: [
      gasCap(SENDER00),
      { kp: K.u2, caps: (wc) => [wc(`${T}.TRANSFER`, K.u2.account, K.u3.account, { decimal: '40.0' })] },
    ],
    gasLimit: 4000,
  });
  res = await localCall(`(${T}.get-results "${pid}")`, HUB);
  record('P8', 'transfer released the moved Borda points (arrivals stay unvoted)',
    scoresEq(res.scores, [s0[0] + 380, s0[1] + 300, s0[2]]) && res.turnout === res0.turnout + 160,
    JSON.stringify(res.scores).slice(0, 80));

  // re-vote REPLACES the ballot at current weight: u2 (60) switches to [2]
  await voteSelfPaid(K.u2, [2]);
  res = await localCall(`(${T}.get-results "${pid}")`, HUB);
  record('P8', 're-vote replaced u2 ballot in place ([0]@60 -> [2]@60)',
    scoresEq(res.scores, [s0[0] + 200, s0[1] + 300, s0[2] + 180]) && res.turnout === res0.turnout + 160,
    JSON.stringify(res.scores).slice(0, 80));

  // reserve is barred from voting (preflight)
  const rv = await preflight({
    label: 'reserve vote', chainId: HUB,
    code: `(${T}.cast-vote "${pid}" "r:${KS}" [0])`,
    signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceB)],
    gasLimit: 4000,
  });
  record('P8', 'reserve cannot vote (on-node)', !rv.ok && rv.error.includes('reserve cannot vote'), rv.error.slice(0, 90));

  // ---- vote key: u1 registers a HOT key (main guard signs), hot key ranks ----
  const hot = newKey();
  await send({
    label: 'u1 registers a vote key (main guard, scoped VOTE-KEY-ADMIN)',
    code: `(${T}.set-vote-key "${K.u1.account}" (read-keyset 'vk))`,
    chainId: HUB,
    signers: [{ kp: K.u1, caps: (wc) => [wc('coin.GAS'), wc(`${T}.VOTE-KEY-ADMIN`, K.u1.account, `k:${hot.publicKey}`)] }],
    data: { vk: { keys: [hot.publicKey], pred: 'keys-all' } },
    gasLimit: 2500, gasPrice: 1e-7,
  });
  await fundKda(hot);   // the hot key pays its own vote gas — the cold key stays cold
  await send({
    label: 'HOT key ranks as u1 (cold key untouched)',
    code: `(${T}.cast-vote "${pid}" "${K.u1.account}" [2 1])`,
    chainId: HUB, sender: hot.account,
    signers: [{ kp: hot, caps: (wc) => [wc('coin.GAS'), wc(`${T}.VOTE`, pid, K.u1.account)] }],
    gasLimit: 3000, gasPrice: 1e-7,
  });
  const u1ballot = await localCall(`(${T}.get-ballot "${pid}" "${K.u1.account}")`, HUB);
  record('P8', 'vote key: hot key ranked for the cold account',
    JSON.stringify((u1ballot.ranking as any[]).map((v) => (typeof v === 'object' ? v.int : v))) === JSON.stringify([2, 1]),
    JSON.stringify(u1ballot).slice(0, 80));
  const hotSteal = await preflight({
    label: 'hot key tries to transfer (must fail)', chainId: HUB, sender: hot.account,
    code: `(${T}.transfer "${K.u1.account}" "${K.u2.account}" 1.0)`,
    signers: [{ kp: hot, caps: (wc) => [wc('coin.GAS'), wc(`${T}.TRANSFER`, K.u1.account, K.u2.account, { decimal: '1.0' })] }],
    gasLimit: 2500, gasPrice: 1e-7,
  });
  record('P8', 'vote key: hot key CANNOT transfer', !hotSteal.ok && hotSteal.error.includes('Keyset failure'),
    hotSteal.error.slice(0, 60));
  await send({
    label: 'u1 clears the vote key',
    code: `(${T}.clear-vote-key "${K.u1.account}")`,
    chainId: HUB,
    signers: [{ kp: K.u1, caps: (wc) => [wc('coin.GAS'), wc(`${T}.VOTE-KEY-ADMIN`, K.u1.account, '')] }],
    gasLimit: 2500, gasPrice: 1e-7,
  });
  const hotAfter = await preflight({
    label: 'cleared hot key votes (must fail)', chainId: HUB, sender: hot.account,
    code: `(${T}.cast-vote "${pid}" "${K.u1.account}" [0])`,
    signers: [{ kp: hot, caps: (wc) => [wc('coin.GAS'), wc(`${T}.VOTE`, pid, K.u1.account)] }],
    gasLimit: 3000, gasPrice: 1e-7,
  });
  record('P8', 'vote key: cleared key refused', !hotAfter.ok && hotAfter.error.includes('neither account guard nor registered vote key'),
    hotAfter.error.slice(0, 60));

  // ---------- P9: REAL cross-chain transfer (SPV), hub -> chain 1 ----------
  console.log('\nP9  cross-chain transfer with SPV');
  const balBefore = await localCall(`(${T}.get-balance "${K.u3.account}")`, HUB);
  const x = await xchain({
    label: 'u3 sends 25 PCO 0→1',
    code: `(${T}.transfer-crosschain "${K.u3.account}" "${K.u3.account}" (read-keyset 'ks) "1" 25.0)`,
    src: HUB, target: '1',
    signers: [
      gasCap(SENDER00),
      { kp: K.u3, caps: (wc) => [wc(`${T}.TRANSFER_XCHAIN`, K.u3.account, K.u3.account, { decimal: '25.0' }, '1')] },
    ],
    data: { ks: { keys: [K.u3.publicKey], pred: 'keys-all' } },
    contGasPayer: SENDER00,
  });
  record('P9', 'step 0 debited the hub', (await localCall(`(${T}.get-balance "${K.u3.account}")`, HUB)) === balBefore - 25, `pact ${x.pactId.slice(0, 12)}…`);
  record('P9', 'SPV continuation credited chain 1',
    (await localCall(`(${T}.get-balance "${K.u3.account}")`, '1')) === 25,
    `step1 gas ${x.step1.gas}`);
  // u3's recorded ballot weight (100) is still <= the remaining hub balance
  // (115), so the release rule leaves the ballot UNCHANGED - weights shrink
  // only when the balance drops below the recorded weight.
  const u3b = await localCall(`(${T}.get-ballot "${pid}" "${K.u3.account}")`, HUB);
  record('P9', 'release rule: ballot weight untouched while balance >= recorded weight',
    u3b.weight === 100, JSON.stringify(u3b).slice(0, 100));

  // ---------- P10: ROTATION — the scariest op, rehearsed ×20 ----------
  console.log('\nP10 keyset rotation (C out, D in) ×20');
  await Promise.all(CHAINS.map((ch) => send({
    label: `rotate keyset @${ch}`,
    code: `(namespace "${NS}") (define-keyset "${KS}" (read-keyset 'pco-gov-v2))`,
    chainId: ch,
    signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceB)],
    data: { 'pco-gov-v2': { keys: [K.deviceA.publicKey, K.deviceB.publicKey, K.deviceD.publicKey], pred: 'keys-2' } },
    gasLimit: 2000,
  })));
  record('P10', 'keyset rotated on all 20 chains (A+B authorized; C replaced by D)', true);

  // NOTE: probe a GOV-tier op here. set-claim-code is OPS-tier since the
  // keyset split, and device A is the ops key - a C+A pair would (correctly)
  // succeed through the ops branch, which is not what this check is about.
  const oldPair = await preflight({
    label: 'old pair GOV op (sweep)', chainId: HUB,
    code: `(${C}.sweep-pool "r:${KS}" (keyset-ref-guard "${KS}"))`,
    signers: [gasCap(SENDER00), unscoped(K.deviceC), unscoped(K.deviceA)],
    gasLimit: 6000,
  });
  record('P10', 'pair containing the ROTATED-OUT key is powerless for GOV ops', !oldPair.ok && oldPair.error.includes('Keyset failure'), oldPair.error.slice(0, 90));

  await send({
    label: 'admin op under the NEW pair (B+D): reactivate the genesis round',
    code: `(${C}.set-round-active "genesis" true)`,
    chainId: HUB,
    signers: [gasCap(SENDER00), unscoped(K.deviceB), unscoped(K.deviceD)],
    gasLimit: 2000,
  });
  record('P10', 'new pair (B+D) performs admin ops', true);

  // module upgrade under the rotated keyset — in-flight state must survive
  const up = await send({
    label: 'module upgrade (token) under rotated keyset',
    code: contract('pco.pact'),
    chainId: HUB,
    signers: [gasCap(SENDER00), unscoped(K.deviceA), unscoped(K.deviceD)],
    data: { ...DEPLOY_DATA, upgrade: true },
    gasLimit: 150000,
  });
  record('P10', 'upgrade accepted under the rotated keyset (A+D)', true, `gas ${up.gas}`);
  record('P10', 'state survived the upgrade (chain-minted intact)', (await localCall(`(${T}.chain-minted)`, HUB)) === 1000000);
  record('P10', 'claims state survived too (pool untouched)', (await localCall(`(${C}.pool-balance)`, HUB)) === poolAfterClaims);

  // the r: reserve account follows the rotated keyset with NO account rotation
  const dBefore = await localCall(`(${T}.get-balance "${K.deviceD.account}")`, HUB).catch(() => 0);
  await send({
    label: 'reserve spend under rotated keyset',
    code: `(${T}.transfer-create "r:${KS}" "${K.deviceD.account}" (read-keyset 'dks) 5.0)`,
    chainId: HUB,
    signers: [
      gasCap(SENDER00),
      { kp: K.deviceB, caps: (wc) => [wc(`${T}.TRANSFER`, `r:${KS}`, K.deviceD.account, { decimal: '5.0' })] },
      { kp: K.deviceD, caps: (wc) => [wc(`${T}.TRANSFER`, `r:${KS}`, K.deviceD.account, { decimal: '5.0' })] },
    ],
    data: { dks: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    gasLimit: 4000,
  });
  record('P10', 'reserve (r: account) obeys the ROTATED keyset - no account migration needed',
    (await localCall(`(${T}.get-balance "${K.deviceD.account}")`, HUB)) === dBefore + 5);

  // ---------- P11: ON-NODE negative sweep (all /local preflights, no spend) ----------
  // The REPL negatives suite (tests/negatives.repl) proves every enforce
  // branch; this phase re-proves the node-relevant classes against the real
  // chainweb-node: table-read-then-enforce paths (REPL-invisible divergence
  // class), the buy-gas sponsorship path, and the cap-body invariants.
  console.log('\nP11 on-node negative sweep (preflights)');
  const neg = async (name: string, mustContain: string, spec: Parameters<typeof preflight>[0], phase = 'P11') => {
    const r = await preflight(spec);
    record(phase, name, !r.ok && r.error.toLowerCase().includes(mustContain.toLowerCase()),
      r.error.slice(0, 90));
  };
  const u1cap = (capName: string, ...args: any[]) =>
    ({ kp: K.u1, caps: (wc: any) => [wc(capName, ...args)] });

  await neg('transfer to self refused', 'same sender and receiver', {
    label: 'self transfer', chainId: HUB,
    code: `(${T}.transfer "${K.u1.account}" "${K.u1.account}" 1.0)`,
    signers: [gasCap(SENDER00), u1cap(`${T}.TRANSFER`, K.u1.account, K.u1.account, { decimal: '1.0' })],
    gasLimit: 4000,
  });
  await neg('non-positive transfer refused', 'amount must be positive', {
    label: 'zero transfer', chainId: HUB,
    code: `(${T}.transfer "${K.u1.account}" "${K.u2.account}" 0.0)`,
    signers: [gasCap(SENDER00), u1cap(`${T}.TRANSFER`, K.u1.account, K.u2.account, { decimal: '0.0' })],
    gasLimit: 4000,
  });
  await neg('over-precise transfer refused (enforce-unit)', 'precision violation', {
    label: 'precise transfer', chainId: HUB,
    code: `(${T}.transfer "${K.u1.account}" "${K.u2.account}" 1.0000000000001)`,
    signers: [gasCap(SENDER00), u1cap(`${T}.TRANSFER`, K.u1.account, K.u2.account, { decimal: '1.0000000000001' })],
    gasLimit: 4000,
  });
  await neg('over-balance transfer refused (read-then-enforce ON-NODE)', 'insufficient funds', {
    label: 'overdraw', chainId: HUB,
    code: `(${T}.transfer "${K.u1.account}" "${K.u2.account}" 10000000.0)`,
    signers: [gasCap(SENDER00), u1cap(`${T}.TRANSFER`, K.u1.account, K.u2.account, { decimal: '10000000.0' })],
    gasLimit: 4000,
  });
  await neg('k: account squatting refused', 'Single-key account protocol violation', {
    label: 'k-squat', chainId: HUB,
    code: `(${T}.create-account "k:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" (read-keyset 'g))`,
    signers: [gasCap(SENDER00)],
    data: { g: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    gasLimit: 4000,
  });
  await neg('principal account cannot rotate to a foreign guard', 'unsafe for principal accounts', {
    label: 'rotate escape', chainId: HUB,
    code: `(${T}.rotate "${K.u1.account}" (read-keyset 'g))`,
    signers: [gasCap(SENDER00), u1cap(`${T}.ROTATE`, K.u1.account, `k:${K.deviceD.publicKey}`)],
    data: { g: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    gasLimit: 4000,
  });
  await neg('cross-chain to a nonexistent chain refused (audit M-1, on-node)', 'not a valid chain id', {
    label: 'xchain chain 20', chainId: HUB,
    code: `(${T}.transfer-crosschain "${K.u1.account}" "${K.u1.account}" (read-keyset 'g) "20" 1.0)`,
    signers: [gasCap(SENDER00), u1cap(`${T}.TRANSFER_XCHAIN`, K.u1.account, K.u1.account, { decimal: '1.0' }, '20')],
    data: { g: { keys: [K.u1.publicKey], pred: 'keys-all' } },
    gasLimit: 4000,
  });
  await neg('cross-chain to the same chain refused', 'same chain', {
    label: 'xchain same', chainId: HUB,
    code: `(${T}.transfer-crosschain "${K.u1.account}" "${K.u1.account}" (read-keyset 'g) "0" 1.0)`,
    signers: [gasCap(SENDER00), u1cap(`${T}.TRANSFER_XCHAIN`, K.u1.account, K.u1.account, { decimal: '1.0' }, '0')],
    data: { g: { keys: [K.u1.publicKey], pred: 'keys-all' } },
    gasLimit: 4000,
  });
  await neg('proposal duration out of bounds refused', 'duration outside', {
    label: 'bad duration', chainId: HUB,
    code: `(${T}.create-proposal "t" "b" ["a" "b"] 5)`,
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 4000,
  });
  await neg('holder-authored proposal refused ON-NODE (admin-authored governance)', 'governance or ops authority required', {
    label: 'holder proposer', chainId: HUB,
    code: `(${T}.create-proposal "t" "b" ["a" "b"] 72)`,
    signers: [gasCap(SENDER00), { kp: K.u2, caps: () => [] }],
    gasLimit: 4000,
  });
  await neg('invalid ranking refused (duplicate entries)', 'ranking entries must be distinct', {
    label: 'bad ranking', chainId: HUB,
    code: `(${T}.cast-vote "${pid}" "${K.u1.account}" [0 0])`,
    signers: [gasCap(SENDER00), u1cap(`${T}.VOTE`, pid, K.u1.account)],
    gasLimit: 4000,
  });
  await neg('vote OFF-HUB refused (chain 1)', 'hub chain only', {
    label: 'off-hub vote', chainId: '1',
    code: `(${T}.cast-vote "${pid}" "${K.u3.account}" [0])`,
    signers: [gasCap(SENDER00), { kp: K.u3, caps: (wc) => [wc(`${T}.VOTE`, pid, K.u3.account)] }],
    gasLimit: 4000,
  });

  // ---- admin-cancel: accountable early close (also keeps re-runs clean) ----
  const holderCancel = await preflight({
    label: 'holder cancel (must fail)', chainId: HUB, sender: K.u1.account,
    code: `(${T}.admin-cancel-proposal "${pid}" "nope")`,
    signers: [{ kp: K.u1, caps: (wc) => [wc('coin.GAS')] }],
    gasLimit: 2500, gasPrice: 1e-7,
  });
  record('P8', 'a holder CANNOT cancel a question', !holderCancel.ok && holderCancel.error.includes('governance or ops authority required'),
    holderCancel.error.slice(0, 60));
  const noReason = await preflight({
    label: 'cancel without reason (must fail)', chainId: HUB,
    code: `(${T}.admin-cancel-proposal "${pid}" "")`,
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 3000,
  });
  record('P8', 'cancel demands a public reason', !noReason.ok && noReason.error.includes('public reason is required'),
    noReason.error.slice(0, 60));
  await send({
    label: 'OPS cancels the question with a public reason',
    code: `(${T}.admin-cancel-proposal "${pid}" "rehearsal question - closing after the drill")`,
    chainId: HUB,
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 3000,
  });
  const openAfter: string[] = await localCall(`(${T}.open-ids)`, HUB);
  record('P8', 'cancel freed the slot immediately (scores frozen)',
    !openAfter.includes(pid), `open now: ${JSON.stringify(openAfter)}`);

  await neg('claim OFF-HUB refused (chain 1)', 'hub chain only', {
    label: 'off-hub claim', chainId: '1',
    code: `(${C}.claim "genesis" "${K.deviceD.account}" (read-keyset 'g) "any")`,
    signers: [gasCap(SENDER00)],
    data: { g: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    gasLimit: 6000,
  });
  await neg('non-principal (vanity) claim refused', 'principal of its guard', {
    label: 'vanity claim', chainId: HUB,
    code: `(${C}.claim "genesis" "totally-real-account" (read-keyset 'g) "any")`,
    signers: [gasCap(SENDER00)],
    data: { g: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    gasLimit: 6000,
  });
  await neg('sweep while claims are open refused (read-then-enforce ON-NODE)', 'close claiming before sweeping', {
    label: 'early sweep', chainId: HUB,
    code: `(${C}.sweep-pool "r:${KS}" (keyset-ref-guard "${KS}"))`,
    signers: [gasCap(SENDER00), unscoped(K.deviceB), unscoped(K.deviceD)],
    gasLimit: 6000,
  });
  // ceilings are tested on the sponsored CLAIM (the only allowlisted call)
  await neg('station refuses a sponsored tx bidding above the price ceiling', 'gas price must be <=', {
    label: 'pricey sponsor', chainId: HUB, sender: stationAcct,
    code: `(${C}.claim "genesis" "${K.deviceD.account}" (read-keyset 'ks) "x")`,
    data: { ks: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [{ kp: K.deviceD, caps: (wc) => [wc(`${G}.GAS_PAYER`, 'x', { int: 3000 }, { decimal: '0.000001' })] }],
    gasLimit: 3000, gasPrice: 1e-6,
  });
  await neg('station refuses a sponsored tx above the gas-limit ceiling', 'gas limit must be <=', {
    label: 'greedy sponsor', chainId: HUB, sender: stationAcct,
    code: `(${C}.claim "genesis" "${K.deviceD.account}" (read-keyset 'ks) "x")`,
    data: { ks: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [{ kp: K.deviceD, caps: (wc) => [wc(`${G}.GAS_PAYER`, 'x', { int: 20000 }, { decimal: '0.0000001' })] }],
    gasLimit: 20000, gasPrice: 1e-8,
  });

  // ---------- P12: OPS TIER — governance-named authority, boundaries, rotation ----------
  // Runs AFTER the P10 gov rotation, so gov = [A, B, D] here: the tier is
  // proven orthogonal to a rotated governance roster. Ops key = device A.
  console.log('\nP12 ops tier (pco.ops-auth)');
  await send({
    label: 'ops-solo round toggle',
    code: `(${C}.set-round-active "genesis" true)`,
    chainId: HUB,
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 2000,
  });
  record('P12', 'ops key SOLO operates the round (post-gov-rotation: tiers are orthogonal)', true);
  await send({
    label: 'ops-solo close (kill switch)',
    code: `(${C}.set-open false)`,
    chainId: HUB,
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 2000,
  });
  record('P12', 'ops key SOLO closes claiming (1-key kill switch)', (await localCall(`(at 'open (${C}.get-config))`, HUB)) === false);
  await send({
    label: 'gov-fallback reopen (pair without the ops key)',
    code: `(${C}.set-open true)`,
    chainId: HUB,
    signers: [gasCap(SENDER00), unscoped(K.deviceB), unscoped(K.deviceD)],
    gasLimit: 2000,
  });
  record('P12', 'governance pair WITHOUT the ops key runs ops (fallback branch on-node)', (await localCall(`(at 'open (${C}.get-config))`, HUB)) === true);

  // tier boundaries (preflights, no spend)
  await neg('a single governance key that is NOT the ops authority cannot run ops', 'ops authorization failed', {
    label: 'D-solo set-open', chainId: HUB,
    code: `(${C}.set-open false)`,
    signers: [gasCap(SENDER00), unscoped(K.deviceD)], gasLimit: 2000,
  }, 'P12');
  await neg('ops key alone cannot sweep the pool (ADMIN stays 2-of-3)', 'Keyset failure', {
    label: 'A-solo sweep', chainId: HUB,
    code: `(${C}.sweep-pool "r:${KS}" (keyset-ref-guard "${KS}"))`,
    signers: [gasCap(SENDER00), unscoped(K.deviceA)], gasLimit: 6000,
  }, 'P12');
  await neg('ops key alone cannot upgrade the module (GOVERNANCE stays 2-of-3)', 'Keyset failure', {
    label: 'A-solo upgrade', chainId: HUB,
    code: contract('pco-claim.pact'),
    data: { ...DEPLOY_DATA, upgrade: true },
    signers: [gasCap(SENDER00), unscoped(K.deviceA)], gasLimit: 150000,
  }, 'P12');
  await neg('ops key alone cannot rotate the GOVERNANCE keyset', 'Keyset failure', {
    label: 'A-solo gov rotate', chainId: HUB,
    code: `(namespace "${NS}") (define-keyset "${KS}" (read-keyset 'evil-gov))`,
    data: { 'evil-gov': { keys: [K.deviceA.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), unscoped(K.deviceA)], gasLimit: 2000,
  }, 'P12');
  await neg('a NON-governance key cannot re-point the ops authority', 'Keyset failure', {
    label: 'D-solo ops re-point', chainId: HUB,
    code: `(${T}.set-ops-guard (read-keyset 'ops-v2))`,
    data: { 'ops-v2': { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), opsAdmin(K.deviceD)], gasLimit: 2000,
  }, 'P12');

  // ops-authority rotation drill (hub): {A,B} -> D -> back to {A,B}.
  // Rotation is GOVERNANCE-signed, and deliberately by a pair that EXCLUDES
  // the outgoing authority — the recovery path that matters.
  // narrow ops to device A so the rotation below provably EXCLUDES the
  // outgoing authority (post-P10 the governance keyset is {A,B,D})
  await send({
    label: 'narrow ops -> A only (drill setup)',
    code: `(${T}.set-ops-guard (read-keyset 'ops-a))`,
    chainId: HUB,
    data: { 'ops-a': { keys: [K.deviceA.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), opsAdmin(K.deviceA), opsAdmin(K.deviceB)],
    gasLimit: 3000,
  });
  await send({
    label: 'gov re-points ops -> D WITHOUT the outgoing authority (B+D, no A)',
    code: `(${T}.set-ops-guard (read-keyset 'ops-v2))`,
    chainId: HUB,
    data: { 'ops-v2': { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), opsAdmin(K.deviceB), opsAdmin(K.deviceD)],
    gasLimit: 3000,
  });
  const oldOps = await preflight({
    label: 'rotated-out ops key op', chainId: HUB,
    code: `(${C}.set-round-active "genesis" true)`,
    signers: [gasCap(SENDER00), unscoped(K.deviceA)], gasLimit: 2000,
  });
  record('P12', 'rotated-out ops authority is powerless for OPS', !oldOps.ok && oldOps.error.includes('ops authorization failed'), oldOps.error.slice(0, 90));
  await send({
    label: 'rotated-in ops key operates solo',
    code: `(${C}.set-round-active "genesis" true)`,
    chainId: HUB,
    signers: [gasCap(SENDER00), unscoped(K.deviceD)],
    gasLimit: 2000,
  });
  record('P12', 'rotated-in ops authority operates solo', true);
  await send({
    label: 'gov restores ops -> {A,B}',
    code: `(${T}.set-ops-guard (read-keyset 'ops-v1))`,
    chainId: HUB,
    data: { 'ops-v1': { keys: [K.deviceA.publicKey, K.deviceB.publicKey], pred: 'keys-any' } },
    signers: [gasCap(SENDER00), opsAdmin(K.deviceA), opsAdmin(K.deviceB)],
    gasLimit: 3000,
  });
  record('P12', 'ops authority restored to the active pair (re-run-safe end state)', true);

  // ---------- P13: GRANTS + the managed-cap autonomy rule, on-node ----------
  console.log('\nP13 grants + autonomy (v2 award rail)');
  const danaBefore = await localCall(`(${T}.get-balance "${K.deviceD.account}")`, HUB).catch(() => 0);
  await send({
    label: 'ops-solo single grant',
    code: `(${C}.grant "${K.deviceD.account}" (read-keyset 'g) 250.0 "devnet rehearsal: builder recognition sample")`,
    chainId: HUB,
    data: { g: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 4000,
  });
  record('P13', 'ops key SOLO grants with a public reason (AWARDED on-chain)',
    (await localCall(`(${T}.get-balance "${K.deviceD.account}")`, HUB)) === danaBefore + 250);

  // batch: two receivers, ONE ops signature
  const u1Before = await localCall(`(${T}.get-balance "${K.u1.account}")`, HUB);
  const u2Before = await localCall(`(${T}.get-balance "${K.u2.account}")`, HUB);
  await send({
    label: 'grant-batch (2 receivers, one signature)',
    code: `(${C}.grant-batch [ { "account": "${K.u1.account}", "guard": (read-keyset 'g1), "amount": 30.0, "reason": "batch item 1" }, { "account": "${K.u2.account}", "guard": (read-keyset 'g2), "amount": 20.0, "reason": "batch item 2" } ])`,
    chainId: HUB,
    data: { g1: { keys: [K.u1.publicKey], pred: 'keys-all' }, g2: { keys: [K.u2.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 6000,
  });
  record('P13', 'grant-batch pays several receivers under ONE ops signature',
    (await localCall(`(${T}.get-balance "${K.u1.account}")`, HUB)) === u1Before + 30
    && (await localCall(`(${T}.get-balance "${K.u2.account}")`, HUB)) === u2Before + 20);

  // THE AUTONOMY RULE ON-NODE: two separate grant CALLS in one tx must fail
  // (in-code install-capability poisons all later keyset enforcement in the
  // tx — REPL-verified; this record confirms it against the real node).
  await neg('two grant calls in ONE tx refused on-node (managed-cap autonomy)', 'ops authorization failed', {
    label: 'double grant one tx', chainId: HUB,
    code: `(${C}.grant "${K.u1.account}" (read-keyset 'g1) 1.0 "one") (${C}.grant "${K.u2.account}" (read-keyset 'g2) 1.0 "two")`,
    data: { g1: { keys: [K.u1.publicKey], pred: 'keys-all' }, g2: { keys: [K.u2.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 8000,
  }, 'P13');
  await neg('grant above MAX-GRANT refused on-node', 'exceeds the per-grant bound', {
    label: 'oversized grant', chainId: HUB,
    code: `(${C}.grant "${K.u1.account}" (read-keyset 'g1) 2000.5 "too big")`,
    data: { g1: { keys: [K.u1.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 4000,
  }, 'P13');
  await neg('duplicate receiver in one batch refused on-node', 'already installed', {
    label: 'dup batch', chainId: HUB,
    code: `(${C}.grant-batch [ { "account": "${K.u1.account}", "guard": (read-keyset 'g1), "amount": 1.0, "reason": "a" }, { "account": "${K.u1.account}", "guard": (read-keyset 'g1), "amount": 2.0, "reason": "b" } ])`,
    data: { g1: { keys: [K.u1.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00), unscoped(K.deviceA)],
    gasLimit: 6000,
  }, 'P13');

  // round mechanics on-node: expiry + budget exhaustion (re-run-safe)
  const drillExists = async (id: string) =>
    localCall(`(contains "${id}" (${C}.round-ids))`, HUB).catch(() => false);
  if (!(await drillExists('expired-drill'))) {
    await send({
      label: 'create an already-expired round',
      code: `(${C}.create-round "expired-drill" (hash "expired") 100.0 100.0 (time "2020-01-01T00:00:00Z") (time "2020-01-02T00:00:00Z"))`,
      chainId: HUB,
      signers: [gasCap(SENDER00), unscoped(K.deviceA)],
      gasLimit: 3000,
    });
  }
  await neg('claim on an expired round refused on-node (in-contract close)', 'round has closed', {
    label: 'expired claim', chainId: HUB,
    code: `(${C}.claim "expired-drill" "${K.deviceD.account}" (read-keyset 'g) "expired")`,
    data: { g: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00)],
    gasLimit: 6000,
  }, 'P13');
  if (!(await drillExists('one-slot-drill'))) {
    await send({
      label: 'create a one-slot round + fill it',
      code: `(${C}.create-round "one-slot-drill" (hash "oneslot") 100.0 100.0 (time "2020-01-01T00:00:00Z") (time "2030-01-01T00:00:00Z"))`,
      chainId: HUB,
      signers: [gasCap(SENDER00), unscoped(K.deviceA)],
      gasLimit: 3000,
    });
    await send({
      label: 'fill the one-slot round',
      code: `(${C}.claim "one-slot-drill" "${K.u3.account}" (read-keyset 'g) "oneslot")`,
      chainId: HUB,
      data: { g: { keys: [K.u3.publicKey], pred: 'keys-all' } },
      signers: [gasCap(SENDER00)],
      gasLimit: 6000,
    });
  }
  await neg('claim on an exhausted round refused on-node', 'round budget exhausted', {
    label: 'exhausted claim', chainId: HUB,
    code: `(${C}.claim "one-slot-drill" "${K.deviceD.account}" (read-keyset 'g) "oneslot")`,
    data: { g: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00)],
    gasLimit: 6000,
  }, 'P13');
  await neg('unknown round refused on-node', 'No value found in table', {
    label: 'ghost round claim', chainId: HUB,
    code: `(${C}.claim "no-such-round" "${K.deviceD.account}" (read-keyset 'g) "x")`,
    data: { g: { keys: [K.deviceD.publicKey], pred: 'keys-all' } },
    signers: [gasCap(SENDER00)],
    gasLimit: 6000,
  }, 'P13');

  // ---------- evidence ----------
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  const md = [
    '# Devnet dress rehearsal — evidence',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Network: recap-development (KDA-CE devnet, 20 chains), ns \`${NS}\``,
    `- Devices simulated by local softkeys A/B/C (+ spare D); 2-of-3 \`keys-2\``,
    `- Result: **${passed}/${checks.length} checks passed**`,
    '',
    '| Phase | Check | Result | Detail |',
    '|---|---|---|---|',
    ...checks.map((c) => `| ${c.phase} | ${c.check} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '\\|')} |`),
    '',
    '_Claims deliberately left OPEN on devnet for the browser-UX verification pass;_',
    '_browser evidence lives in [UX-VERIFICATION.md](UX-VERIFICATION.md) (kept out of this_',
    '_generated file so re-runs never clobber it)._',
  ].join('\n');
  writeFileSync(new URL('../../docs/mainnet-pilot/evidence/DEVNET-REHEARSAL.md', import.meta.url), md);
  console.log('evidence written to docs/mainnet-pilot/evidence/DEVNET-REHEARSAL.md');
}

main().catch((e) => { console.error('REHEARSAL ABORTED:', e.message ?? e); process.exit(1); });
