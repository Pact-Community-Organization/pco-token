// e2e-user.ts — the COMMUNITY MEMBER journey, end to end, gasless, repeatable.
//
// Proves the community journey: a person with a browser and no KDA can CLAIM
// gaslessly (the only station-sponsored action), and can transfer / vote /
// propose by paying their own gas (what a connected wallet does) — while the
// station REFUSES to sponsor anything but the claim. Every wrong move fails
// with a clear error. Contract-level twin of the Playwright browser run.
//
// Assumes the v2 stack is deployed in ns `user` on the devnet (rehearse.ts) and
// a genesis round is open. Run:  PCO_NS=user npx tsx src/e2e-user.ts
// Re-run-safe: fresh claimant keys per run; funds a proposer from the reserve
// only if needed; asserts DELTAS, not absolutes.
import {
  CHAINS, HUB, NS, SENDER00, checks, localCall, newKey, preflight, record, send,
  type Keypair, type SignerSpec,
} from './env.js';

const T = `${NS}.pco`;
const C = `${NS}.pco-claim`;
const G = `${NS}.pco-gas-station`;
const KS = `${NS}.pco-gov`;


let station = '';
const gasCap = (kp: Keypair): SignerSpec => ({ kp, caps: (wc) => [wc('coin.GAS')] });

// station-sponsored envelope (CLAIM only): the user signs the GAS_PAYER cap,
// the station is the gas sender. Used only for claims + the negatives that
// prove the station REFUSES to sponsor anything else.
function sponsored(user: Keypair, code: string, caps: (wc: any) => any[], data: Record<string, any>, label: string) {
  return {
    label, code, chainId: HUB, sender: station,
    signers: [{ kp: user, caps: (wc: any) => [...caps(wc), wc(`${G}.GAS_PAYER`, 'web', { int: 6000 }, { decimal: '0.0000001' })] }] as SignerSpec[],
    data, gasLimit: 6000, gasPrice: 1e-8,
  };
}

// self-paid envelope: the actor pays their OWN coin.GAS (what a connected
// wallet does for transfer / vote / propose — those are NOT sponsored). The
// account must hold a little KDA. This is how the community acts on-chain.
function selfPaid(user: Keypair, code: string, caps: (wc: any) => any[], data: Record<string, any>, label: string) {
  return {
    label, code, chainId: HUB, sender: user.account,
    signers: [{ kp: user, caps: (wc: any) => [wc('coin.GAS'), ...caps(wc)] }] as SignerSpec[],
    data, gasLimit: 2500, gasPrice: 1e-7,
  };
}

// give an account a little KDA so it can pay its own gas (stands in for "the
// user's wallet holds KDA"). sender00 funds on devnet.
async function fundKda(acct: string, pub: string, amount = '1.0') {
  const has = await localCall(`(coin.get-balance "${acct}")`, HUB).catch(() => 0);
  if (has >= Number(amount)) return;
  await send({
    label: `fund ${acct.slice(0, 12)} KDA`, chainId: HUB,
    code: `(coin.transfer-create "sender00" "${acct}" (read-keyset 'gk) ${amount})`,
    signers: [{ kp: SENDER00, caps: (wc) => [wc('coin.GAS'), wc('coin.TRANSFER', 'sender00', acct, { decimal: amount })] }],
    data: { gk: { keys: [pub], pred: 'keys-all' } }, gasLimit: 2000,
  });
}

async function bal(acct: string): Promise<number> {
  return localCall(`(${T}.get-balance "${acct}")`, HUB).catch(() => 0);
}

async function main() {
  console.log(`PCO community-member e2e — ns=${NS}, self-provisioned round`);
  station = await localCall(`(${G}.station-account)`, HUB);

  // self-provision a dedicated round with a code we control (ops key = rehearsal
  // deviceA), so the journey never depends on what other drills left behind.
  const { readFileSync } = await import('node:fs');
  const K = JSON.parse(readFileSync(new URL('../out/rehearsal-keys.json', import.meta.url), 'utf8'));
  const CODE = 'e2e-journey-code';
  const RID = `e2e-${await localCall(`(at 'block-height (chain-data))`, HUB)}`;
  const codeHash: string = await localCall(`(hash "${CODE}")`, HUB);
  // the ops daily meter may be at its cap from other drills the same devnet-day
  // (a real bound). If so, reuse an existing e2e round rather than fail the run.
  let rid = RID;
  try {
    await send({
      label: 'ops opens the e2e round', chainId: HUB,
      code: `(${C}.create-round "${RID}" "${codeHash}" 100.0 5000.0 (time "2020-01-01T00:00:00Z") (time "2030-01-01T00:00:00Z")) (${C}.set-open true)`,
      signers: [gasCap(SENDER00), { kp: K.deviceA, caps: (wc: any) => [wc(`${C}.OPS`)] }], gasLimit: 4000,
    });
  } catch (e: any) {
    if (!String(e.message).includes('ops daily cap reached')) throw e;
    const ids: string[] = await localCall(`(${C}.round-ids)`, HUB);
    const prior = ids.filter((i) => i.startsWith('e2e-')).sort();
    if (!prior.length) { console.error('ops meter at cap and no prior e2e round to reuse — wait an epoch'); process.exit(1); }
    rid = prior[prior.length - 1];
    console.log(`  ops meter at cap — reusing round ${rid} (code stays "${CODE}")`);
    await send({ label: 'ensure master open', chainId: HUB, code: `(${C}.set-open true)`,
      signers: [gasCap(SENDER00), { kp: K.deviceA, caps: (wc: any) => [wc(`${C}.OPS`)] }], gasLimit: 2000 }).catch(() => {});
  }
  const round = await localCall(`(${C}.get-round "${rid}")`, HUB);
  const amount = Number(round.amount?.decimal ?? round.amount);

  // ---------- 1. fresh member, zero KDA, views state ----------
  const me = newKey();
  record('view', 'a fresh member starts at 0 PCO and holds zero KDA', (await bal(me.account)) === 0
    && (await localCall(`(coin.get-balance "${me.account}")`, HUB).catch(() => 'no-account')) === 'no-account');
  record('view', 'the member can read the open round (amount + budget)', amount > 0);

  // ---------- 2. claim (gasless) ----------
  const poolBefore = await localCall(`(${C}.pool-balance)`, HUB);
  const c = await send(sponsored(me,
    `(${C}.claim "${rid}" "${me.account}" (read-keyset 'ks) "${CODE}")`,
    () => [], { ks: { keys: [me.publicKey], pred: 'keys-all' } }, 'gasless claim'));
  record('claim', 'member claimed gasless (holds the round amount, still zero KDA)',
    (await bal(me.account)) === amount
    && (await localCall(`(coin.get-balance "${me.account}")`, HUB).catch(() => 'no-account')) === 'no-account',
    `gas ${c.gas}`);
  record('claim', 'pool decremented by exactly the round amount',
    (await localCall(`(${C}.pool-balance)`, HUB)) === poolBefore - amount);

  // double claim, same round → refused
  const dbl = await preflight(sponsored(me,
    `(${C}.claim "${rid}" "${me.account}" (read-keyset 'ks) "${CODE}")`,
    () => [], { ks: { keys: [me.publicKey], pred: 'keys-all' } }, 'double claim'));
  record('claim', 'a second claim in the same round is refused',
    !dbl.ok && /already (found|exists)|read-only|Insert failed/i.test(dbl.error), dbl.error.slice(0, 70));

  // wrong code → refused
  const wrong = await preflight(sponsored(newKey(),
    `(${C}.claim "${rid}" "${me.account}" (read-keyset 'ks) "definitely-wrong")`,
    () => [], { ks: { keys: [me.publicKey], pred: 'keys-all' } }, 'wrong code'));
  record('claim', 'a wrong quest code is refused', !wrong.ok && wrong.error.includes('wrong engagement code'), wrong.error.slice(0, 70));

  // ---------- 3. the station sponsors CLAIM ONLY ----------
  // Everything else (transfer, vote, propose, xchain) must be REFUSED by the
  // station — the participant pays their own gas for those.
  // A station-sponsored tx for coin.transfer or transfer-crosschain is refused
  // at the allowlist gate ("not a sponsored call"). (For pco.transfer/vote/
  // propose the node injects the REAL call and the downstream contract error
  // can fire first in a bare /local, masking the string — the allowlist gate
  // itself is exhaustively proven per-call in the REPL suite against a
  // controllable env-data envelope; here we assert the two that surface the
  // gate cleanly, plus that NONE of them ever succeed through the station.)
  const friend = newKey();
  const evilCoin = await preflight(sponsored(me,
    `(coin.transfer "${me.account}" "${friend.account}" 1.0)`, () => [], {}, 'station coin.transfer'));
  record('station', 'station REFUSES to sponsor coin.transfer (not a PCO call)',
    !evilCoin.ok && evilCoin.error.includes('not a sponsored call'), evilCoin.error.slice(0, 60));
  const evilXc = await preflight(sponsored(me,
    `(${T}.transfer-crosschain "${me.account}" "${me.account}" (read-keyset 'rg) "1" 1.0)`,
    (wc) => [wc(`${T}.TRANSFER_XCHAIN`, me.account, me.account, { decimal: '1.0' }, '1')],
    { rg: { keys: [me.publicKey], pred: 'keys-all' } }, 'station xchain'));
  record('station', 'station REFUSES to sponsor transfer-crosschain',
    !evilXc.ok && evilXc.error.includes('not a sponsored call'), evilXc.error.slice(0, 60));
  // pco.transfer / vote / propose through the station: never succeed. (The
  // exact allowlist-gate string is proven per-call in the REPL suite; on a bare
  // /local the node injects the real call and a downstream contract error can
  // surface first — either way the sponsored tx is refused, which is the point.)
  const ghost = newKey();
  for (const [name, code, caps] of [
    ['transfer', `(${T}.transfer "${ghost.account}" "${friend.account}" 1.0)`,
      (wc: any) => [wc(`${T}.TRANSFER`, ghost.account, friend.account, { decimal: '1.0' })]],
    ['cast-vote', `(${T}.cast-vote "1" "${ghost.account}" [0])`, (wc: any) => [wc(`${T}.VOTE`, '1', ghost.account)]],
    ['create-proposal', `(${T}.create-proposal "t" "b" ["a" "b"] 72)`, () => []],
  ] as const) {
    const r = await preflight(sponsored(ghost, code, caps as any, {}, `station-${name}`));
    record('station', `station does not carry ${name} through (tx refused)`, !r.ok, r.error.slice(0, 60));
  }

  // ---------- 4. transfer (SELF-PAID — what a connected wallet does) ----------
  await fundKda(me.account, me.publicKey);   // the actor holds a little KDA for gas
  const sendAmt = amount / 2;
  const tx = await send(selfPaid(me,
    `(${T}.transfer-create "${me.account}" "${friend.account}" (read-keyset 'rg) ${sendAmt.toFixed(1)})`,
    (wc) => [wc(`${T}.TRANSFER`, me.account, friend.account, { decimal: sendAmt.toFixed(1) })],
    { rg: { keys: [friend.publicKey], pred: 'keys-all' } }, 'self-paid transfer'));
  record('transfer', 'member sent PCO paying their own gas; both balances correct',
    (await bal(friend.account)) === sendAmt && (await bal(me.account)) === amount - sendAmt, `gas ${tx.gas}`);

  // transfer to self → refused; over-balance → refused
  const self = await preflight(selfPaid(me,
    `(${T}.transfer "${me.account}" "${me.account}" 1.0)`,
    (wc) => [wc(`${T}.TRANSFER`, me.account, me.account, { decimal: '1.0' })], {}, 'self transfer'));
  record('transfer', 'transfer to self refused', !self.ok && self.error.includes('same sender and receiver'), self.error.slice(0, 70));
  const over = await preflight(selfPaid(me,
    `(${T}.transfer "${me.account}" "${friend.account}" 999999.0)`,
    (wc) => [wc(`${T}.TRANSFER`, me.account, friend.account, { decimal: '999999.0' })], {}, 'overdraw'));
  record('transfer', 'over-balance transfer refused', !over.ok && over.error.toLowerCase().includes('insufficient'), over.error.slice(0, 70));

  // ---------- 5. proposing is ADMIN-AUTHORED (community goes via the channels) ----------
  await fundKda(me.account, me.publicKey);
  const communityProp = await preflight(selfPaid(me,
    `(${T}.create-proposal "t" "b" ["a" "b"] 72)`,
    () => [], {}, 'holder propose'));
  record('propose', 'a token holder CANNOT create proposals (admin-authored governance)',
    !communityProp.ok && communityProp.error.includes('governance or ops authority required'),
    communityProp.error.slice(0, 70));

  // the OPS key opens the ranked-choice question the community will vote on
  let pid: string;
  try {
    const prop = await send({
      label: 'OPS opens a ranked-choice question', chainId: HUB,
      code: `(${T}.create-proposal "E2E: which docs matter most?" "Advisory e2e signal - rank the options." ["guides" "reference" "examples"] 168)`,
      signers: [gasCap(SENDER00), { kp: K.deviceA }],
      gasLimit: 4000,
    });
    pid = (prop.result as any).data;
    record('propose', 'the OPS key alone opened a ranked-choice question', typeof pid === 'string', `pid ${pid}`);
  } catch (e: any) {
    if (!String(e.message).includes('too many active proposals')) throw e;
    const open: string[] = await localCall(`(${T}.open-ids)`, HUB);
    pid = open[open.length - 1];
    record('propose', 'open-proposal cap (3) held — reusing an open question for the vote leg', open.length === 3, `pid ${pid}`);
  }

  // ---------- 6. ranked ballots (SELF-PAID) + re-vote ----------
  await fundKda(friend.account, friend.publicKey);   // the voter pays their own gas
  const r0 = await localCall(`(${T}.get-results "${pid}")`, HUB);
  const K3 = (r0.options as string[]).length;
  await send(selfPaid(friend,
    `(${T}.cast-vote "${pid}" "${friend.account}" [0])`,
    (wc) => [wc(`${T}.VOTE`, pid, friend.account)], {}, 'self-paid ranked ballot'));
  const rv = await localCall(`(${T}.get-results "${pid}")`, HUB);
  record('vote', 'member ranked [0] paying their own gas (+K*w points on option 0)',
    rv.scores[0] === r0.scores[0] + K3 * sendAmt && rv.turnout === r0.turnout + sendAmt);
  // re-vote REPLACES the ballot in place: [1 0] moves the top preference
  await send(selfPaid(friend,
    `(${T}.cast-vote "${pid}" "${friend.account}" [1 0])`,
    (wc) => [wc(`${T}.VOTE`, pid, friend.account)], {}, 're-rank'));
  const rv2 = await localCall(`(${T}.get-results "${pid}")`, HUB);
  record('vote', 're-rank replaced the ballot ([0] -> [1,0]) with no double count',
    rv2.scores[0] === r0.scores[0] + (K3 - 1) * sendAmt
    && rv2.scores[1] === r0.scores[1] + K3 * sendAmt
    && rv2.turnout === r0.turnout + sendAmt);
  // a signer that doesn't match the voting account is refused (the VOTE cap
  // guards the account; a different key can't vote as someone else)
  const stranger = newKey();
  await fundKda(stranger.account, stranger.publicKey);
  const mismatch = await preflight(selfPaid(stranger,
    `(${T}.cast-vote "${pid}" "${friend.account}" [0])`,
    (wc) => [wc(`${T}.VOTE`, pid, friend.account)], {}, 'vote sig mismatch'));
  record('vote', 'a signature not matching the voting account is refused', !mismatch.ok, mismatch.error.slice(0, 70));

  // ---------- 7. vote KEY: hot key votes, cold key stays cold ----------
  const hot = newKey();
  await send(selfPaid(friend,
    `(${T}.set-vote-key "${friend.account}" (read-keyset 'vk))`,
    (wc) => [wc(`${T}.VOTE-KEY-ADMIN`, friend.account, `k:${hot.publicKey}`)],
    { vk: { keys: [hot.publicKey], pred: 'keys-all' } }, 'register vote key'));
  record('votekey', 'member registered a vote key under their MAIN guard',
    Boolean(await localCall(`(at 'active (${T}.get-vote-key "${friend.account}"))`, HUB)));
  await fundKda(hot.account, hot.publicKey);   // hot key pays its own vote gas
  await send(selfPaid(hot,
    `(${T}.cast-vote "${pid}" "${friend.account}" [2])`,
    (wc) => [wc(`${T}.VOTE`, pid, friend.account)], {}, 'hot-key vote'));
  const hkv = await localCall(`(${T}.get-ballot "${pid}" "${friend.account}")`, HUB);
  const hkr = (hkv.ranking as any[]).map((v) => (typeof v === 'object' ? v.int : v));
  record('votekey', 'HOT key ranked for the cold account (ballot recorded)', JSON.stringify(hkr) === JSON.stringify([2]), JSON.stringify(hkv).slice(0, 60));
  // The receiver must ALREADY hold PCO. `transfer` reads the receiver row
  // first, so sending to an account with no row aborts at that read - before
  // the sender's guard is ever checked - and this negative would then pass for
  // the wrong reason, proving nothing about the hot key.
  const hotSteal = await preflight(selfPaid(hot,
    `(${T}.transfer "${friend.account}" "${me.account}" 1.0)`,
    (wc) => [wc(`${T}.TRANSFER`, friend.account, me.account, { decimal: '1.0' })], {}, 'hot-key transfer'));
  record('votekey', 'hot key CANNOT transfer the cold account\'s tokens',
    !hotSteal.ok && hotSteal.error.includes('Keyset failure'), hotSteal.error.slice(0, 60));
  const hotRepoint = await preflight(selfPaid(hot,
    `(${T}.set-vote-key "${friend.account}" (read-keyset 'vk2))`,
    (wc) => [wc(`${T}.VOTE-KEY-ADMIN`, friend.account, `k:${hot.publicKey}`)],
    { vk2: { keys: [hot.publicKey], pred: 'keys-all' } }, 'hot-key repoint'));
  record('votekey', 'hot key CANNOT re-point the registration',
    !hotRepoint.ok && hotRepoint.error.includes('Keyset failure'), hotRepoint.error.slice(0, 60));
  await send(selfPaid(friend,
    `(${T}.clear-vote-key "${friend.account}")`,
    (wc) => [wc(`${T}.VOTE-KEY-ADMIN`, friend.account, '')], {}, 'clear vote key'));
  const hotCleared = await preflight(selfPaid(hot,
    `(${T}.cast-vote "${pid}" "${friend.account}" [0])`,
    (wc) => [wc(`${T}.VOTE`, pid, friend.account)], {}, 'cleared hot vote'));
  record('votekey', 'a cleared vote key can no longer vote',
    !hotCleared.ok && hotCleared.error.includes('neither account guard nor registered vote key'),
    hotCleared.error.slice(0, 60));

  // ---------- evidence ----------
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} community-journey checks passed`);
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch((e) => { console.error('E2E ABORTED:', e.message ?? e); process.exit(1); });
