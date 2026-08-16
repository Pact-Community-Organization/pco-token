/**
 * ops-checks.ts — the ceremony tooling defends itself, or this fails.
 *
 * WHY THIS FILE EXISTS. A mutation audit (2026-07-29) broke `ops/src/*.ts` in
 * every way it could think of and the test suite stayed green 12/12, because
 * `tests/run.sh` runs `.repl` files only and nothing asserted anything about
 * the TypeScript. Mutations that survived undetected included: flipping the
 * default network to `mainnet01`, deleting five of `submit.ts`'s seven
 * fail-closed guards, putting the hot gas softkey inside the governance keyset,
 * and shrinking the chain list from 20 to 5.
 *
 * This is the code that will build and submit real transactions signed by three
 * hardware wallets. Each check below corresponds to a mutant that previously
 * survived; if you change the tooling and one of these fails, the check is
 * probably right and the change is probably wrong.
 *
 *   npm run test-ops
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  PASS  ${name}`); }
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// ---------------------------------------------------------------- safe cleanup
// NEVER `rmSync(out/mainnet01, {recursive:true})`. That is the REAL ceremony
// output directory. On 2026-07-31 an earlier version of this file did exactly
// that and deleted a freshly built 20-transaction step; it was unsigned, so the
// cost was a rebuild. Had it run while 40 hardware signatures were sitting in
// those files it would have destroyed them, and the operator would have had to
// re-approve every one on two devices.
//
// So: snapshot what exists BEFORE, and remove only what this file created.
function snapshotOut(): Set<string> {
  const d = new URL('../out/mainnet01/', import.meta.url);
  try { return new Set(readdirSync(d)); } catch { return new Set(); }
}
function cleanupOut(before: Set<string>): void {
  const d = new URL('../out/mainnet01/', import.meta.url);
  let now: string[] = [];
  try { now = readdirSync(d); } catch { return; }
  for (const f of now) if (!before.has(f)) rmSync(new URL(f, d), { force: true });
}

console.log('ceremony tooling checks\n');

// ---------------------------------------------------------------- env defaults
{
  const s = src('env.ts');
  // Mutant: default network flipped to mainnet01. A default of mainnet means a
  // forgotten env var targets real money instead of failing safe on devnet.
  const m = s.match(/PCO_NETWORK\s*\?\?\s*'([^']+)'/);
  check('the DEFAULT network is a devnet, never mainnet',
    m?.[1] !== undefined && m[1] !== 'mainnet01', `default is ${m?.[1]}`);
  const h = s.match(/PCO_HOST\s*\?\?\s*'([^']+)'/);
  check('the DEFAULT host is local, never a public endpoint',
    /localhost|127\.0\.0\.1/.test(h?.[1] ?? ''), `default is ${h?.[1]}`);
  // Mutant: CHAINS shortened. A short list silently deploys to fewer chains and
  // every "all 20 chains" verification then passes vacuously.
  const c = s.match(/length:\s*(\d+)\s*\}/);
  check('the chain list is all 20 chains', c?.[1] === '20', `length is ${c?.[1]}`);
}

// ---------------------------------------------------------------- build-tx
{
  const s = src('build-tx.ts');
  // Mutant: the hot gas softkey added to the governance keyset. That would put a
  // key that lives unencrypted on the build machine into the 2-of-3 that guards
  // the whole system.
  const gov = s.match(/GOV_KEYS\s*=\s*\{[^}]*\}/s)?.[0] ?? '';
  check('the governance keyset holds ONLY device keys',
    /deviceA/.test(gov) && /deviceB/.test(gov) && /deviceC/.test(gov)
    && !/gasPayer/.test(gov), gov.replace(/\s+/g, ' ').slice(0, 80));
  check('the governance keyset predicate is keys-2', /pred:\s*'keys-2'/.test(gov));

  const ops = s.match(/OPS_KEYS\s*=\s*\{[^}]*\}/s)?.[0] ?? '';
  check('the ops authority excludes the break-glass seat (device C)',
    /deviceA/.test(ops) && /deviceB/.test(ops) && !/deviceC/.test(ops));
  check('the ops authority does NOT include the gas softkey', !/gasPayer/.test(ops));

  // Mutant: deploy gas limits lowered back to the devnet-derived ceilings. The
  // mainnet dry run measured token 44,778 / claim 24,523.
  const tok = Number(s.match(/contract\('pco\.pact'\)[^)]*?,\s*(\d+),/s)?.[1] ?? 0);
  const clm = Number(s.match(/contract\('pco-claim\.pact'\)[^)]*?,\s*(\d+),/s)?.[1] ?? 0);
  check('the token deploy limit clears the MEASURED mainnet cost with margin',
    tok >= 44778 * 1.5 && tok <= 150000, `limit ${tok}, measured 44778`);
  check('the claim deploy limit clears the MEASURED mainnet cost with margin',
    clm >= 24523 * 1.5 && clm <= 150000, `limit ${clm}, measured 24523`);
  check('no deploy limit exceeds the 150k per-transaction ceiling',
    tok <= 150000 && clm <= 150000);

  // Float policy (founder, 2026-07-29): keep it small. The float is the only
  // real value this otherwise-valueless system holds, so it is sized to be
  // losable rather than sized to a forecast. A small float bounds what we have
  // not thought of, and costs nothing given the 0.5 KDA/day epoch cap.
  const flt = Number(s.match(/PCO_STATION_FLOAT\s*\?\?\s*'([\d.]+)'/)?.[1] ?? 99);
  check('the default station float is small', flt > 0 && flt <= 1.0, `default ${flt} KDA`);
  check('an oversized float is refused rather than emitted',
    /outside the sanctioned range/.test(s));
}

// ---------------------------------------------------------------- submit guards
{
  const s = src('submit.ts');
  // Each of these is one of the fail-closed guards the mutation audit deleted
  // without any test noticing.
  check('submit refuses a networkId that is not the configured one', /NETWORK_ID/.test(s) && /die\(/.test(s));
  check('submit recomputes the hash from cmd', /blake2b/.test(s));
  check('submit verifies signatures locally before sending', /nacl\.sign\.detached\.verify|detached\.verify/.test(s));
  check('submit requires --send to leave the machine', /--send/.test(s) && /doSend/.test(s));
}

// ---------------------------------------------------------------- submit, executed
// The static checks above can be fooled by code that merely MENTIONS a guard.
// These run the real binary against deliberately broken input and require it to
// abort. This is the part that actually proves the guards work.
{
  const dir = mkdtempSync(join(tmpdir(), 'ops-checks-'));
  // The fixture is a built (unsigned) transaction. It lives under out/, which is
  // gitignored, so on a fresh clone it will not exist - build it rather than
  // skipping, because a check that silently skips is the thing this file exists
  // to prevent.
  const fixture = new URL('../out/mainnet01-dryrun/keyset.json', import.meta.url);
  if (!existsSync(fixture)) {
    execFileSync('npx', ['tsx', 'src/dryrun.ts', 'keyset'],
      { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
  }
  const good = JSON.parse(readFileSync(fixture, 'utf8'));

  const run = (tx: unknown, env: Record<string, string>) => {
    const f = join(dir, 'tx.json');
    writeFileSync(f, JSON.stringify(tx));
    try {
      execFileSync('npx', ['tsx', 'src/submit.ts', f], {
        cwd: new URL('..', import.meta.url).pathname,
        env: { ...process.env, ...env }, stdio: 'pipe',
      });
      return { aborted: false, out: '' };
    } catch (e: any) {
      return { aborted: true, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
  };

  // a mainnet01 file must NOT be submittable while the harness targets devnet
  const wrongNet = run(good, { PCO_NETWORK: 'recap-development', PCO_HOST: 'http://localhost:8090' });
  check('a mainnet file is REFUSED when the harness targets devnet',
    wrongNet.aborted && /network/i.test(wrongNet.out), wrongNet.out.slice(0, 90));

  // a tampered cmd must be caught by the hash recompute
  const tampered = { ...good, cmd: String(good.cmd).replace('"gasLimit":15000', '"gasLimit":150000') };
  const badHash = run(tampered, { PCO_NETWORK: 'mainnet01', PCO_HOST: 'https://api.chainweb-community.org' });
  check('a tampered cmd is REFUSED by the hash recompute',
    badHash.aborted && /hash/i.test(badHash.out), badHash.out.slice(0, 90));

  // unsigned slots must not be sendable
  const unsigned = run(good, { PCO_NETWORK: 'mainnet01', PCO_HOST: 'https://api.chainweb-community.org' });
  check('a transaction with unfilled signature slots is REFUSED',
    unsigned.aborted && /signature|slot|unfilled/i.test(unsigned.out), unsigned.out.slice(0, 90));
}

// ------------------------------------------------- the freeze: one-way, so gated
// The freeze is the only deploy that can never be repeated, corrected or rolled
// back, and until 2026-07-29 it was the only deploy with NO TOOLING at all: 21
// steps in build-tx.ts and not one of them was `freeze`, so the permanent final
// deploy was a hand edit under ceremony pressure. Every check here corresponds to
// a way that hand edit could have gone wrong.
{
  const { freezeSource, FREEZE_MARKER } = await import('../src/freeze-source.js');
  const pco = readFileSync(new URL('../../contracts/pco.pact', import.meta.url), 'utf8');
  const H = 'd0X8poMDmjx8tkFPRG_1qB5h43cg274oIMre4AgInfc';

  const r = freezeSource(pco, H);
  check('the freeze flips FROZEN-MODULE to true', /\(defconst FROZEN-MODULE:bool true/.test(r.source));
  check('the freeze inserts the bless form', r.source.includes(`(bless "${H}")`));
  check('no `false` freeze flag survives', !/FROZEN-MODULE:bool false/.test(r.source));
  // The strong one: the transform must change NOTHING ELSE. This source is about
  // to be signed by three hardware wallets and deployed permanently.
  // Reconstruct the inserted block EXACTLY rather than regexing it out: a greedy
  // pattern eats the blank line that belonged to the original source and then
  // reports a false difference.
  const block = `  ${FREEZE_MARKER}\n  (bless "${H}")\n\n`;
  const undone = r.source
    .replace(block, '')
    .replace('FROZEN-MODULE:bool true', 'FROZEN-MODULE:bool false');
  check('the freeze changes NOTHING but the flag and the bless', undone === pco,
    undone === pco ? '' : 'the transform touched code it was not asked to');

  // A malformed hash is rejected by Pact at LOAD time — i.e. after signing.
  for (const bad of ['abc', '', 'not/base64+chars/here/not/base64+chars/here', H + 'x']) {
    let refused = false;
    try { freezeSource(pco, bad); } catch { refused = true; }
    check(`a malformed bless hash is refused (${bad.slice(0, 12) || 'empty'})`, refused);
  }
  let noHash = false;
  try { freezeSource(pco, []); } catch { noHash = true; }
  check('freezing with no hash to bless is refused', noHash);

  // Multiple hashes: every hash an in-flight cross-chain defpact could resume
  // against must be blessed, so the transform must take a set.
  const H2 = 'v_h3wtMw1FSSaIKBLZiTZTJTb7Z4zInRSzw0XXd1_6s';
  const multi = freezeSource(pco, [H, H2]);
  check('every supplied hash is blessed',
    multi.source.includes(`(bless "${H}")`) && multi.source.includes(`(bless "${H2}")`));

  // Since the cross-chain voting upgrade the source ships with a permanent bless of
  // the hash it replaced, and every upgrade appends another. The freeze must carry ALL of them
  // through: each records a hash something may still pin — a dependent mid two-step
  // upgrade, or an in-flight transfer-crosschain whose step 1 has no rollback — and
  // the freeze is the one deploy after which nothing can be repaired.
  //
  // Read the expected set FROM the contract rather than hardcoding it, so the check
  // keeps testing the invariant after the next upgrade appends a hash instead of
  // quietly testing a stale literal.
  const inSource = [...pco.matchAll(/\(bless\s+"([^"]*)"\s*\)/g)].map((m) => m[1]);
  check('the contract carries at least one bless to preserve', inSource.length > 0,
    inSource.length ? `${inSource.length} in source` : 'none found — the permanent bless may have been reverted');
  const kept = freezeSource(pco, H);
  check('the freeze preserves every bless already in the source',
    inSource.every((h) => kept.source.includes(`(bless "${h}")`)),
    inSource.filter((h) => !kept.source.includes(`(bless "${h}")`)).join(',') || '');
  check('the freeze reports the union of existing and supplied hashes',
    [...inSource, H].every((h) => kept.blessed.includes(h)) &&
    kept.blessed.length === new Set([...inSource, H]).size);

  // Supplying a hash the source already blesses must not emit it twice: a duplicate
  // (bless ...) is a load-time error, discovered after three hardware signatures.
  const dup = freezeSource(pco, inSource[0]);
  check('re-supplying an already-blessed hash does not duplicate it',
    dup.source.split(`(bless "${inSource[0]}")`).length === 2);

  // Re-freezing an already-frozen source needs a human decision about which
  // hashes stay blessed; it must never happen silently.
  let twice = false;
  try { freezeSource(r.source, H); } catch { twice = true; }
  check('re-freezing an already-frozen source is refused', twice);
}

// ------------------------------------- the freeze refusals, and the station bar
{
  const s = src('build-tx.ts');
  check('build-tx has a freeze step', /case 'freeze'/.test(s));
  check('build-tx has an upgrade step', /case 'upgrade'/.test(s));
  // The gas station pins coin at runtime through withdraw, so freezing it
  // strands the float on the next coin upgrade. It must not even be selectable.
  const freezeCase = s.slice(s.indexOf("case 'freeze'"));
  check('freeze REFUSES pco-gas-station',
    /pco-gas-station must NEVER be frozen/.test(freezeCase)
    && !/'pco-gas-station':\s*'pco-gas-station\.pact'/.test(freezeCase.slice(0, 900)));
  check('freeze aborts when the on-chain preconditions are not met',
    /freezePreflight/.test(freezeCase) && /process\.exit\(2\)/.test(freezeCase));
  check('freeze writes the frozen source back for committing',
    /writeFileSync\(target/.test(freezeCase) && /COMMIT THIS FILE/.test(freezeCase));
  // An unblessed upgrade strands in-flight cross-chain transfers and breaks
  // every dependent pin — measured as "hash not blessed" on set-open, the
  // master kill switch.
  const upCase = s.slice(s.indexOf("case 'upgrade'"), s.indexOf("case 'freeze'"));
  check('upgrade refuses a source carrying no (bless ...) form', /carries no \(bless/.test(upCase));
  check('the preflight is given build-tx\'s OWN namespace, not env.ts\'s default',
    /freezePreflight\(cfg\.ns/.test(freezeCase));
}

// ------------------------------------------- the late-table list agrees 3 ways
// B4 in the remediation: this list existed in three places with THREE DIFFERENT
// values (4 / 5 / 8), and the two omitted from the freeze checklist were
// rcv-margins (the authoritative pairwise tally) and non-voting (which every
// cast-vote reads). Both are uncreatable after the flip. A prose instruction to
// "keep these in sync" was already present and had not worked, so it is a check
// now.
{
  const list = (file: string, name: string) => {
    const m = src(file).match(new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
    return m ? m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean).sort() : null;
  };
  const vd = list('verify-deployed.ts', 'LATE');
  const rh = list('rehearse.ts', 'LATE_TABLES');
  const fp = src('freeze-preflight.ts');
  const fpPco = fp.match(/pco:\s*\[([\s\S]*?)\]/);
  const fpList = fpPco
    ? fpPco[1].split(',').map((x) => x.trim().replace(/['"\n]/g, '')).filter(Boolean).sort()
    : null;
  check('verify-deployed and rehearse agree on the late-added pco tables',
    !!vd && !!rh && JSON.stringify(vd) === JSON.stringify(rh),
    `verify-deployed=${vd?.length} rehearse=${rh?.length}`);
  check('freeze-preflight agrees with them too',
    !!fpList && JSON.stringify(fpList) === JSON.stringify(vd),
    `freeze-preflight=${JSON.stringify(fpList)} vs ${JSON.stringify(vd)}`);
  for (const t of ['rcv-margins', 'non-voting']) {
    check(`the freeze table list includes ${t} (it cannot be created after the flip)`,
      !!fpList && fpList.includes(t));
  }
}

// --------------------------------------------- the mint: the ungated ceremony tx
// D2: `init-mint` accepts ANY recipient list that sums to TOTAL-SUPPLY, and
// `grep -n "mint" ops/test/ops-checks.ts` returned nothing - the one-shot,
// irreversible distribution was the only ceremony transaction with no gate at
// all. The on-chain half (a split guard inside init-mint) is a contract change;
// this is the cheap half, and it catches the realistic mistake: a hand-edited or
// mis-parameterised mint step.
{
  const s = src('build-tx.ts');
  const mint = s.slice(s.indexOf("case 'mint'"), s.indexOf("case 'fund-station'"));
  check('the mint pays the claim pool by DERIVED principal, never a literal',
    /\$\{C\}\.pool-account/.test(mint) && /\$\{C\}\.pool-guard/.test(mint));
  check('the mint pays the governance reserve by keyset-ref principal',
    /"r:\$\{KS\}"/.test(mint) && /keyset-ref-guard "\$\{KS\}"/.test(mint));
  check('the mint names exactly TWO recipients', (mint.match(/"account":/g) ?? []).length === 2);
  // 9:1. A transposed split would put 900,000 PCO under the governance keyset
  // and 100,000 in the community pool - irreversibly, on a one-shot mint.
  check('the split is 90% pool / 10% reserve, computed from totalSupply',
    /totalSupply \* 0\.9/.test(mint) && /totalSupply \* 0\.1/.test(mint));
  check('the mint is hub-only', /HUB/.test(mint));
  check('the mint requires BOTH governance devices', /AB\)\)/.test(mint));
}

// ------------------------------- a devnet config must not build mainnet txs
// mainnet-config.json is gitignored, so it is whatever was last left on disk —
// and what is normally left there is a DEVNET config (ns "user", gasPayer
// "sender00"). build-tx never talks to a chain, so without this guard it emits
// 20 well-formed files in a namespace that is not ours, the operator hash-signs
// every one on hardware, and the mistake surfaces at submit: 40 device approvals
// and a TTL window spent to learn a JSON file was stale.
//
// Asserted by BEHAVIOUR, not by grep. A grep for the checks would still pass if
// the guard were moved below the point where the transactions are built.
{
  const bad = { ns: 'user', deviceA: 'a'.repeat(64), deviceB: 'b'.repeat(64), deviceC: 'c'.repeat(64),
                gasPayer: { account: 'sender00', publicKey: 'd'.repeat(64) }, totalSupply: 1000000.0 };
  // The file is GITIGNORED, so it exists on a developer machine and does not
  // exist in CI. Handle both: remember whether it was there, and restore that
  // exact state. (The first version of this check assumed it existed and broke
  // the CI run — the same class of drift the check itself is about.)
  const cfgPath = new URL('../mainnet-config.json', import.meta.url);
  const existed = existsSync(cfgPath);
  const saved = existed ? readFileSync(cfgPath, 'utf8') : null;
  try {
    writeFileSync(cfgPath, JSON.stringify(bad, null, 2));
    let aborted = false, out = '';
    try {
      execFileSync('npx', ['tsx', 'src/build-tx.ts', 'keyset'], {
        cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
        env: { ...process.env, PCO_NETWORK: 'mainnet01', PCO_HOST: 'https://api.chainweb-community.org' },
      });
    } catch (e: any) {
      aborted = true; out = String(e.stdout ?? '') + String(e.stderr ?? '');
    }
    check('build-tx REFUSES a devnet config when the target is mainnet01',
      aborted && /REFUSING TO BUILD FOR mainnet01/.test(out));
    check('...and names the offending field rather than failing vaguely',
      /is not a principal namespace/.test(out));
  } finally {
    // restore the EXACT prior state: the developer's config, or no file at all
    if (existed) writeFileSync(cfgPath, saved as string);
    else rmSync(cfgPath, { force: true });
  }
}

// --------------------------------- create-proposal: 20 chains, identical or not at all
// A question is 20 separate transactions and the ONLY thing that makes them one
// question is that their arguments are byte-identical. Everything here is
// asserted by RUNNING the builder, because a grep would pass on a guard that had
// been moved below the point where the transactions are built.
//
// Every bound is checked at BUILD time rather than left to the contract: this is
// an ops-tier step, so a question the chain rejects costs 20 device approvals
// before anyone finds out.
{
  const outBefore = snapshotOut();
  const cfgPath = new URL('../mainnet-config.json', import.meta.url);
  const had = existsSync(cfgPath);
  const prior = had ? readFileSync(cfgPath, 'utf8') : null;
  if (!had) {
    writeFileSync(cfgPath, JSON.stringify({
      ns: 'user', deviceA: 'a'.repeat(64), deviceB: 'b'.repeat(64), deviceC: 'c'.repeat(64),
      gasPayer: { account: 'sender00', publicKey: 'd'.repeat(64) }, totalSupply: 1000000.0,
    }, null, 2));
  }
  // Far enough out that the 12h announce floor is met from a created-at of "now".
  const soon = new Date(Date.now() + 40 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const later = new Date(Date.now() + 240 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const base = {
    PCO_PID: 'q-test', PCO_TITLE: 'Which first?', PCO_OPTIONS: 'Alpha|Beta|Gamma',
    PCO_STARTS: soon, PCO_ENDS: later,
  };
  const build = (over: Record<string, string> = {}) => {
    try {
      const out = execFileSync('npx', ['tsx', 'src/build-tx.ts', 'create-proposal'], {
        cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
        env: { ...process.env, ...base, ...over,
               PCO_NETWORK: 'mainnet01', PCO_HOST: 'https://api.chainweb-community.org' },
      });
      return { aborted: false, out: String(out) };
    } catch (e: any) {
      return { aborted: true, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
  };
  try {
    const good = build();
    check('build-tx HAS a create-proposal step at all', !/unknown step/i.test(good.out), good.out.slice(0, 120));
    check('a well-formed question BUILDS', !good.aborted, good.out.slice(0, 200));
    check('...emitting one transaction per chain (20)',
      (good.out.match(/60-create-proposal-q-test-c\d+\.json/g) ?? []).length === 20,
      String((good.out.match(/60-create-proposal-q-test-c\d+\.json/g) ?? []).length));

    // THE PROPERTY. Read the emitted files and compare their code fields: the
    // 20 must differ ONLY in chainId. Checked against the artifacts rather than
    // against the builder's own claim about them.
    const dir = new URL(`../out/mainnet01/`, import.meta.url);
    const codes = new Set<string>(); const chainIds = new Set<string>();
    for (let c = 0; c < 20; c++) {
      const f = new URL(`60-create-proposal-q-test-c${c}.json`, dir);
      if (!existsSync(f)) continue;
      const cmd = JSON.parse(JSON.parse(readFileSync(f, 'utf8')).cmd);
      codes.add(cmd.payload.exec.code);
      chainIds.add(cmd.meta.chainId);
    }
    check('the 20 transactions carry BYTE-IDENTICAL code', codes.size === 1, `${codes.size} variants`);
    check('...and differ in chainId, so they are 20 chains and not 20 copies of one',
      chainIds.size === 20, `${chainIds.size} distinct chainIds`);

    // Bounds, each refused at build time. These mirror the contract's enforces;
    // if the contract's bound changed and this did not, the mismatch shows up as
    // a question that builds and then aborts on all 20 chains.
    check('REFUSES a starts-at inside the 12h announce floor',
      build({ PCO_STARTS: new Date(Date.now() + 3 * 3600_000).toISOString() }).aborted);
    check('REFUSES ends-at before starts-at', build({ PCO_ENDS: soon, PCO_STARTS: later }).aborted);
    check('REFUSES a span longer than a year',
      build({ PCO_ENDS: new Date(Date.now() + 400 * 24 * 3600_000).toISOString() }).aborted);
    check('REFUSES fewer than 2 options', build({ PCO_OPTIONS: 'OnlyOne' }).aborted);
    check('REFUSES more than 5 options', build({ PCO_OPTIONS: 'a|b|c|d|e|f' }).aborted);
    check('REFUSES duplicate options', build({ PCO_OPTIONS: 'Alpha|Alpha' }).aborted);
    check('REFUSES a proposal id containing a colon (ballot keys are <pid>:<account>)',
      build({ PCO_PID: 'q:1' }).aborted);
    check('REFUSES a title over 120 chars', build({ PCO_TITLE: 'x'.repeat(121) }).aborted);
    // Quotes are REFUSED, never silently substituted: this text is interpolated
    // into Pact source AND published verbatim as the question people read.
    const q = build({ PCO_TITLE: 'Which "first"?' });
    check('REFUSES a quote in the title instead of rewriting it', q.aborted && /double quote/.test(q.out),
      q.out.slice(0, 120));
    // The skew is bounded BOTH ways by the contract. The forward direction used
    // to be unreachable: the check computed `3600 - (now - tc)`, which for a
    // future created-at only grows.
    const isoZ = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    check('REFUSES a created-at older than the 1h skew',
      build({ PCO_CREATED: isoZ(Date.now() - 2 * 3600_000) }).aborted);
    const future = build({ PCO_CREATED: isoZ(Date.now() + 3 * 3600_000), PCO_STARTS: isoZ(Date.now() + 40 * 3600_000) });
    check('...and one in the FUTURE, which the one-sided check could never catch',
      future.aborted && /FUTURE/.test(future.out), future.out.slice(0, 140));

    // Pact's (time "...") takes %Y-%m-%dT%H:%M:%SZ and nothing else, while
    // Date.parse takes far more. Each of these satisfies Date.parse and fails on
    // all 20 chains; the offset form is the worst, because Date.parse converts it
    // and the 12h floor is then checked against a different instant than the one
    // written into the transaction.
    for (const [label, t] of [
      ['milliseconds', '2027-01-17T12:00:00.500Z'],
      ['date only', '2027-01-17'],
      ['a human date', 'Jan 17 2027'],
      ['a UTC offset instead of Z', '2027-01-17T12:00:00+02:00'],
    ] as const) {
      check(`REFUSES a time Pact cannot parse (${label})`, build({ PCO_STARTS: t }).aborted);
    }

    // A raw newline is a Pact LEXICAL error, and PCO_BODY is allowed 2000 chars,
    // so a pasted multi-paragraph rationale is the natural way to hit it.
    const nl = build({ PCO_BODY: 'First paragraph.\n\nSecond paragraph.' });
    check('REFUSES a newline in the body (a Pact lexical error, not a runtime one)',
      nl.aborted && /newline/.test(nl.out), nl.out.slice(0, 140));

    // PCO_PID was the one operator string never passed through clean(), and both
    // " and \ are ASCII so the ASCII check did not cover them.
    check('REFUSES a quote in the proposal id', build({ PCO_PID: 'q"1' }).aborted);
    check('REFUSES a backslash in the proposal id', build({ PCO_PID: 'q\\1' }).aborted);
    check('REFUSES a backslash in the title', build({ PCO_TITLE: 'back\\slash' }).aborted);
    check('REFUSES a quote in an option', build({ PCO_OPTIONS: 'Alpha|Be"ta' }).aborted);
    check('REFUSES a non-ASCII proposal id', build({ PCO_PID: 'q-café' }).aborted);
    check('REFUSES a body over 2000 chars', build({ PCO_BODY: 'x'.repeat(2001) }).aborted);
    check('REFUSES a proposal id over 64 chars', build({ PCO_PID: 'q'.repeat(65) }).aborted);
    check('REFUSES an option over 60 chars', build({ PCO_OPTIONS: `Alpha|${'b'.repeat(61)}` }).aborted);

    // Fail-closed on a forgotten variable, like every other step. TWO distinct
    // paths: an empty value trips the length check, while a genuinely UNSET
    // variable defaults to the TO-FILL placeholder and passes every pid check —
    // it is caught only by emit(). The old test exercised the first and was named
    // for the second.
    check('REFUSES an empty PCO_PID', build({ PCO_PID: '' }).aborted);
    const unset = build({ PCO_PID: undefined as unknown as string });
    check('REFUSES a genuinely UNSET PCO_PID rather than emitting a TO-FILL question',
      unset.aborted && /TO-FILL/.test(unset.out), unset.out.slice(0, 140));
  } finally {
    if (had) writeFileSync(cfgPath, prior as string);
    else rmSync(cfgPath, { force: true });
    cleanupOut(outBefore);
  }
}

// ------------------------------- the bless gate is MODULE-AWARE, both ways
// Requiring a bless on every module made the sanctioned freeze order
// unbuildable: its step 4 redeploys `pco-claim` AFTER `pco` is frozen, to
// re-pin, and the gate aborted that step over a hazard `pco-claim` does not
// have. Requiring it on NO module would strand in-flight cross-chain transfers.
// Both directions are asserted by running the real builder, because the whole
// defect was a gate that was correct in spirit and wrong in scope.
{
  // ANY check that EXECUTES build-tx needs ops/mainnet-config.json to exist,
  // because build-tx parses it at module load. That file is GITIGNORED, so it
  // is present on a developer machine and absent in CI — and a check that only
  // greps the source never noticed. This is the second check to trip over it;
  // hence the shared helper rather than a third ad-hoc rescue.
  const outBefore = snapshotOut();
  const cfgPath = new URL('../mainnet-config.json', import.meta.url);
  const had = existsSync(cfgPath);
  const prior = had ? readFileSync(cfgPath, 'utf8') : null;
  if (!had) {
    writeFileSync(cfgPath, JSON.stringify({
      ns: 'user', deviceA: 'a'.repeat(64), deviceB: 'b'.repeat(64), deviceC: 'c'.repeat(64),
      gasPayer: { account: 'sender00', publicKey: 'd'.repeat(64) }, totalSupply: 1000000.0,
    }, null, 2));
  }
  const upgrade = (mod: string) => {
    try {
      const out = execFileSync('npx', ['tsx', 'src/build-tx.ts', 'upgrade', '0'], {
        cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
        // PIN THE NETWORK rather than inheriting it. This used to pass `...process.env`
        // alone, so the emitted files landed in out/<whatever PCO_NETWORK happened to be>.
        // Two consequences, both observed: an operator with PCO_NETWORK=mainnet01 exported
        // (i.e. mid-ceremony) had this suite write real module-UPGRADE transactions, carrying
        // the real device keys and namespace, into the ceremony directory; and with the var
        // unset they went to out/recap-development/, which snapshotOut/cleanupOut do not
        // watch, so they were never removed. Pinning it here makes the emitted path match
        // the directory the cleanup below actually cleans.
        env: {
          ...process.env, PCO_MODULE: mod,
          PCO_NETWORK: 'mainnet01', PCO_HOST: 'https://api.chainweb-community.org',
        },
      });
      return { aborted: false, out: String(out) };
    } catch (e: any) {
      return { aborted: true, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
  };
  const pcoPath = new URL('../../contracts/pco.pact', import.meta.url);
  const pcoOriginal = readFileSync(pcoPath, 'utf8');
  try {
    const claim = upgrade('pco-claim');
    check('the freeze order step 4 (redeploy pco-claim) can actually be BUILT',
      !claim.aborted, claim.out.slice(0, 100));
    // This build was previously REFUSED, because `pco` carried no bless
    // and an unblessed upgrade strands every in-flight cross-chain transfer and
    // breaks both dependents' pins. The permanent bless supplies that, so the upgrade is now
    // buildable — which is the point of carrying it, not a side effect.
    const token = upgrade('pco');
    check('a `pco` upgrade BUILDS now that C1 blesses the deployed hash',
      !token.aborted, token.out.slice(0, 200));
    // ...and the gate that forced C1 is still live. Without this, the gate would be
    // permanently satisfied by C1 and never exercised again: a check that can no
    // longer fail has stopped being a check. Strip the bless and the SAME build
    // must refuse. Fails closed — if the strip removed nothing the build succeeds
    // and this check goes red.
    writeFileSync(pcoPath, pcoOriginal.replace(/^[ \t]*\(bless\s+"[^"]*"\)[ \t]*\r?\n/gm, ''));
    const stripped = upgrade('pco');
    check('...and is still REFUSED if that bless is removed',
      stripped.aborted && /carries no \(bless/.test(stripped.out), stripped.out.slice(0, 100));
  } finally {
    // Restore FIRST, then prove it. A restore that silently failed would leave a
    // tracked contract mutilated, and the next thing to read it is a deploy build.
    writeFileSync(pcoPath, pcoOriginal);
    check('contracts/pco.pact restored byte-for-byte after the bless-strip probe',
      readFileSync(pcoPath, 'utf8') === pcoOriginal, 'THE CONTRACT ON DISK IS MODIFIED — git checkout it');
    // restore the EXACT prior state: the developer's config, or no file at all
    if (had) writeFileSync(cfgPath, prior as string);
    else rmSync(cfgPath, { force: true });
    // and remove every ceremony file this block caused build-tx to emit. In a `finally`
    // because a FAILING check must not leave a signable upgrade transaction on disk —
    // that is exactly when the operator is distracted.
    cleanupOut(outBefore);
  }
}

// ------------------------------- the gas-payer secret can never be committed
// The ceremony gas payer is a HOT softkey living on the build machine. That is
// the design — it pays gas and sits in no keyset — but the secret must never
// leave ops/out/. Verified rather than trusted, because "it's gitignored" is an
// assumption that survives exactly until someone moves the file.
{
  const keyFile = new URL('../out/mainnet-gas-payer.json', import.meta.url).pathname;
  if (existsSync(keyFile)) {
    const repo = new URL('../..', import.meta.url).pathname;
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', '-q', 'ops/out/mainnet-gas-payer.json'],
        { cwd: repo, stdio: 'pipe' });
      ignored = true;
    } catch { ignored = false; }
    check('the gas-payer key file is gitignored', ignored);

    const secret = JSON.parse(readFileSync(keyFile, 'utf8')).secretKey as string;
    let tracked = '';
    try {
      tracked = String(execFileSync('git', ['grep', '-l', secret, '--', '.'],
        { cwd: repo, stdio: 'pipe' }));
    } catch { tracked = ''; }   // git grep exits non-zero when it finds nothing
    check('the gas-payer SECRET appears in no tracked file', tracked.trim() === '',
      tracked.trim().slice(0, 80));
  } else {
    console.log('  SKIP  gas-payer key not generated yet (checks arm themselves once it is)');
  }
}

// ------------------------------- the ns guard must not block the ns preflight
// The mainnet guard requires cfg.ns to be a principal namespace. `preflight-ns`
// is the step that DERIVES that value — its code reads only the gov keyset and
// never interpolates cfg.ns — so requiring a filled cfg.ns to run it demanded
// the answer as the price of asking the question. Measured 2026-07-30, with all
// three device keys confirmed and only ns outstanding:
//   REFUSING TO BUILD FOR mainnet01: ns "user" is not a principal namespace
// Asserted in BOTH directions, because the obvious over-correction — dropping
// the ns check, or exempting every step — silently re-opens the hazard the
// guard exists for: 20 well-formed transactions in someone else's namespace,
// hash-signed on hardware before anyone finds out.
{
  const outBefore = snapshotOut();
  const cfgPath = new URL('../mainnet-config.json', import.meta.url);
  const had = existsSync(cfgPath);
  const prior = had ? readFileSync(cfgPath, 'utf8') : null;
  // ns unfilled; everything else valid, so ONLY the ns check is in play.
  const noNs = {
    ns: '', deviceA: 'a'.repeat(64), deviceB: 'b'.repeat(64), deviceC: 'c'.repeat(64),
    gasPayer: { account: `k:${'d'.repeat(64)}`, publicKey: 'd'.repeat(64) }, totalSupply: 1000000.0,
  };
  const run = (step: string) => {
    try {
      // capture stdout on SUCCESS too — the earlier version returned '' here, which
      // made "the output contains X" checks vacuously true whatever the builder emitted.
      const out = String(execFileSync('npx', ['tsx', 'src/build-tx.ts', step], {
        cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
        env: { ...process.env, PCO_NETWORK: 'mainnet01', PCO_HOST: 'https://api.chainweb-community.org' },
      }));
      return { ok: true, out };
    } catch (e: any) { return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
  };
  try {
    writeFileSync(cfgPath, JSON.stringify(noNs, null, 2));
    const pre = run('preflight-ns');
    check('preflight-ns BUILDS for mainnet01 while ns is still unfilled', pre.ok,
      pre.out.slice(0, 120));
    // ...and it really is the derivation, not something that merely exits 0.
    check('...and emits the create-principal-namespace call',
      pre.ok && /ns\.create-principal-namespace/.test(pre.out));
    check('...over all three device keys with pred keys-2',
      pre.ok && ['a', 'b', 'c'].every((x) => pre.out.includes(x.repeat(64))) && /keys-2/.test(pre.out));
    for (const step of ['keyset', 'namespace', 'deploy-token', 'mint']) {
      const r = run(step);
      check(`${step} is STILL refused while ns is unfilled`,
        !r.ok && /is not a principal namespace/.test(r.out), r.out.slice(0, 100));
    }
  } finally {
    if (had) writeFileSync(cfgPath, prior as string);
    else rmSync(cfgPath, { force: true });
    // Remove anything this check (or a mutant of it) managed to BUILD. Observed
    // while mutation-proving the guard: a mutant that wrongly exempted every step
    // emitted 20 well-formed mainnet transactions built from this file's FAKE keys
    // into the real ceremony output directory, and left them there. Nothing about
    // ops/out/mainnet01/*.json says which keys produced it, so a later operator
    // would find a populated output directory and no way to tell those from the
    // genuine article — the exact "sign 20 stale files on hardware and find out at
    // submit" failure the guard above exists to prevent, manufactured by its test.
    cleanupOut(outBefore);
  }
}

// ------------------------------- local.ts must accept env-data
// The RUNBOOK's namespace preflight is `(ns.create-principal-namespace
// (read-keyset 'pco-gov))`, which cannot resolve without env-data. localCall
// took no data parameter, so the documented step was not executable by the
// shipped tooling — a runbook instruction that could not be followed.
{
  const e = src('env.ts');
  check('localCall accepts env-data', /localCall\(code: string, chainId: string, data\?:/.test(e));
  check('...and actually attaches it via addData', /Object\.entries\(data \?\? \{\}\)[\s\S]{0,80}addData/.test(e));
  const l = src('local.ts');
  check('local.ts passes env-data through to localCall', /localCall\(code, ch, data\)/.test(l));
  // Malformed JSON must fail loudly. Silently dropping it would run the preflight
  // with NO keyset and report whatever that returns as the namespace.
  let rejected = false, msg = '';
  try {
    execFileSync('npx', ['tsx', 'src/local.ts', '(+ 1 1)', '0', '{not json'], {
      cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
    });
  } catch (err: any) { rejected = true; msg = String(err.stdout ?? '') + String(err.stderr ?? ''); }
  check('local.ts REJECTS malformed env-data instead of silently ignoring it',
    rejected && /env-data is not valid JSON/.test(msg), msg.slice(0, 100));
}

// ------------------------------- sign-step: the per-step batch signer
// The ceremony signs by STEP: all 20 chains on one device, swap, all 20 on the
// other. These assert the properties that make that safe. They cannot exercise a
// hardware wallet, so they cover everything up to the device boundary — which is
// where the dangerous mistakes are anyway (wrong seat, wrong slot, wrong step).
{
  const s = src('sign-step.ts');

  // Slot layout is fixed by build-tx's signer order: [gas softkey, A, B].
  // Off-by-one here signs into the gas slot and every signature fails to verify.
  check('sign-step maps seat A->slot 1 and seat B->slot 2',
    /const slot = SEAT === 'A' \? 1 : 2;/.test(s));

  // THE reason this file exists. A swapped Nano S+ reappears on the same busid,
  // so without an identity check "point it at seat B" can silently mean the other seat.
  check('sign-step refuses to sign if the connected device is not the named seat',
    /onDevice !== expectedPub/.test(s) && /WRONG DEVICE for seat/.test(s));
  check('...and checks identity BEFORE signing anything',
    s.indexOf('WRONG DEVICE for seat') < s.indexOf("sign(['sign'"));

  // Each signature is verified against the seat key immediately, not at submit.
  check('sign-step verifies each signature locally right after producing it',
    /nacl\.sign\.detached\.verify/.test(s) && /does NOT verify against seat/.test(s));

  // A file whose hash does not recompute is not something to sign.
  check('sign-step recomputes the hash from cmd before signing',
    /hash does not recompute from cmd/.test(s));

  // Re-running a step must not walk the operator through 20 approvals again.
  check('sign-step is idempotent (already-signed slots are verified, not re-signed)',
    /already signed, verified/.test(s));

  // It must orchestrate the PINNED signer, never reimplement device I/O.
  check('sign-step drives the pinned ledger-signer rather than talking to the device itself',
    /ledger-signer/.test(s) && !/node-hid|@ledgerhq|Transport/.test(s));

  // The operator watches the DEVICE, not this terminal. A hash they cannot read
  // beside the device is not a check they perform — and a TRUNCATED hex column is
  // useless for the comparison it exists to support (found the hard way during
  // step 4, at 20 transactions; the deploys are 60).
  check('sign-step writes a hash sheet before any prompt',
    /HASHES-\$\{prefix\}\.txt/.test(s) && s.indexOf('hash sheet ->') < s.indexOf("sign(['sign'"));
  check('...carrying BOTH encodings in full, never truncated',
    /base64url\s+\$\{tx\.hash\}/.test(s) && /hex\s+\$\{hexOf\(tx\.hash\)\}/.test(s)
    && !/hash\.slice\(0,|hexOf\([^)]*\)\.slice\(/.test(s));

  // Behaviour: a bad seat argument must fail loudly rather than defaulting.
  let rejected = false;
  try {
    execFileSync('npx', ['tsx', 'src/sign-step.ts', '30-token', '--seat', 'Z'], {
      cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
    });
  } catch { rejected = true; }
  check('sign-step REJECTS an unknown --seat instead of defaulting to one', rejected);
}

// ------------------------------- spread-gas must not report success as failure
// Measured on mainnet 2026-07-30: 6 of 19 chains returned "defpact execution
// already completed" because a third-party finisher redeemed the SPV
// continuation first. Every one of those chains HAD the funds. The old code
// printed "step1 FAILED", and the operator's remedy for a failed chain is to
// re-send — building a second cross-chain transfer and spending PER_CHAIN again
// for nothing, six times over.
{
  const s = src('spread-gas.ts');
  check('spread-gas treats an already-completed defpact as funded, not failed',
    /already completed/i.test(s) && /do NOT re-send/.test(s));
  // The distinguishing property: it asks the CHAIN, because "someone else
  // finished it" and "it silently did not happen" give the same error string.
  check('...and confirms it by reading the balance rather than inferring',
    /coin\.get-balance/.test(s) && /balance now/.test(s));
  check('...while a genuine failure is still reported as FAILED',
    /step1 FAILED/.test(s));
}

// ------------------------------- namespace + keyset must be ONE transaction
// Cold audit 2026-07-30, MEDIUM-1. `ns.validate` constrains only the namespace
// ADMIN guard and a first-time `define-namespace` enforces no signature, so
// anyone who learns the governance keyset can create n_<hash> unsigned, take the
// USER guard, and first-define <ns>.pco-gov as their own. Governance reclaims the
// namespace but can NEVER reclaim the keyset — redefinition enforces the CURRENT
// keyset. The ceremony's own transaction carries the keyset in addData, so it is
// public from the first mempool entry while 19 chains are still unclaimed:
// secrecy cannot close this, only atomicity can.
//
// Asserted by BUILDING, not by grepping the source, because the property is
// "these calls land in the same exec" and only the artifact shows that.
{
  const outBefore = snapshotOut();
  const cfgPath = new URL('../mainnet-config.json', import.meta.url);
  const had = existsSync(cfgPath);
  const prior = had ? readFileSync(cfgPath, 'utf8') : null;
  const good = {
    ns: `n_${'a'.repeat(40)}`, deviceA: 'a'.repeat(64), deviceB: 'b'.repeat(64), deviceC: 'c'.repeat(64),
    gasPayer: { account: `k:${'d'.repeat(64)}`, publicKey: 'd'.repeat(64) }, totalSupply: 1000000.0,
  };
  try {
    writeFileSync(cfgPath, JSON.stringify(good, null, 2));
    execFileSync('npx', ['tsx', 'src/build-tx.ts', 'namespace'], {
      cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
      env: { ...process.env, PCO_NETWORK: 'mainnet01', PCO_HOST: 'https://api.chainweb-community.org' },
    });
    const dir = new URL('../out/mainnet01/', import.meta.url);
    const built = readdirSync(dir).filter((f) => /namespace/.test(f));
    check('the namespace step emits one artifact per chain (20)', built.length === 20, `got ${built.length}`);
    const one = JSON.parse(readFileSync(new URL(built[0], dir), 'utf8'));
    const code = JSON.parse(one.cmd).payload.exec.code as string;
    check('...and define-namespace + define-keyset are in the SAME transaction',
      /define-namespace/.test(code) && /define-keyset/.test(code), code.slice(0, 90));
    // The gap is what was exploitable; a build that emits them separately must fail here.
    check('...so there is no instant where the namespace exists without its keyset',
      code.indexOf('define-namespace') < code.indexOf('define-keyset'));
  } finally {
    if (had) writeFileSync(cfgPath, prior as string); else rmSync(cfgPath, { force: true });
    cleanupOut(outBefore);
  }
}

console.log(`\n${failed === 0 ? 'ALL CEREMONY TOOLING CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
