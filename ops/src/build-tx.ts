// build-tx.ts — emit UNSIGNED command JSONs for the mainnet ceremony.
//
// Every ceremony transaction is built here from ops/mainnet-config.json so
// the runbook is executable, reviewable, and deterministic. The output files
// go to ops/out/mainnet/<NN-name-chain>.json; the operator hash-signs each
// with two of the three devices (ledger-signer, hash mode), the local gas
// softkey fills its own slot, and the submit step posts + polls.
//
// Usage:
//   npx tsx src/build-tx.ts <step> [chain]
//   steps: preflight-ns | keyset | namespace | deploy-token | deploy-claim |
//          deploy-station | set-ops-guard | mint | fund-station | open-claims |
//          create-round | grant | rotate | rotate-ops | upgrade | freeze
//
// `upgrade` and `freeze` are the two that redeploy code. Both refuse to write
// anything unless the deployed hash is blessed: unblessed, an in-flight
// cross-chain transfer can never resume and every dependent module pin breaks.
// `freeze` additionally verifies the chain first (see freeze-preflight.ts) and
// REWRITES contracts/<module>.pact, which must then be committed.
//
// NOTHING here signs or submits. PCO_NETWORK/PCO_HOST select the target.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Pact, type ChainId } from '@kadena/client';
import { CHAINS, HUB, NETWORK_ID } from './env.js';

type Cfg = {
  ns: string;                    // n_<derived> (from the preflight)
  deviceA: string; deviceB: string; deviceC: string; // 64-hex pubkeys
  gasPayer: { account: string; publicKey: string };  // local softkey, gas only
  totalSupply: number;
};
const cfg: Cfg = JSON.parse(readFileSync(new URL('../mainnet-config.json', import.meta.url), 'utf8'));

// FAIL CLOSED: a devnet config must never build mainnet transactions.
//
// mainnet-config.json is gitignored, so it is whatever was last left on the
// disk — and what is normally left there is a DEVNET config (`ns: "user"`,
// gasPayer `sender00`). Nothing downstream would catch it: build-tx does not
// talk to a chain, so it would emit 20 perfectly well-formed files in a
// namespace that is not ours, paid by an account that does not exist on
// mainnet. The operator would hash-sign all of them on hardware FIRST and
// find out at submit — 40 device approvals and a TTL window spent to learn
// that a JSON file was stale.
//
// Every check below is a property of the CONFIG, not of the chain, so this
// costs nothing and cannot be flaky.
const step = process.argv[2];
if (NETWORK_ID === 'mainnet01') {
  const die = (m: string): never => {
    console.error(`REFUSING TO BUILD FOR mainnet01: ${m}`);
    console.error('ops/mainnet-config.json still looks like a devnet/template config.');
    console.error('Fill it from ops/mainnet-config.template.json (RUNBOOK §B, step 2) and re-run.');
    process.exit(1);
  };
  const raw = JSON.stringify(cfg);
  if (/TO-FILL/i.test(raw)) die('the config still contains TO-FILL placeholders');
  // A mainnet deploy lives in a PRINCIPAL namespace derived from the gov keyset.
  // `free` and `user` are the devnet namespaces and are not ours on mainnet.
  // EXCEPT for preflight-ns, which is the step that DERIVES this value. Its code
  // reads only the gov keyset (`ns.create-principal-namespace (read-keyset 'pco-gov)`)
  // and never touches cfg.ns, so requiring a filled cfg.ns to run it demanded the
  // answer as the price of asking the question — the ceremony's first mainnet step
  // was unbuildable. Measured 2026-07-30, after all three device keys were confirmed:
  //   REFUSING TO BUILD FOR mainnet01: ns "user" is not a principal namespace
  // Same family as the freeze step that could not be built. Every OTHER step does
  // interpolate cfg.ns into its code, so the check still applies to all of them.
  if (step !== 'preflight-ns' && !/^n_[a-z0-9]{40}$/i.test(cfg.ns)) die(`ns "${cfg.ns}" is not a principal namespace (expected n_<40 hex>)`);
  // The gas payer is a local softkey principal. sender00 is the devnet faucet
  // and does not exist on mainnet.
  if (!/^k:[0-9a-f]{64}$/.test(cfg.gasPayer?.account ?? '')) die(`gasPayer.account "${cfg.gasPayer?.account}" is not a k: principal`);
  if (cfg.gasPayer.account !== `k:${cfg.gasPayer.publicKey}`) die('gasPayer.account does not match its own publicKey');
  // Device pubkeys: real, and three DISTINCT seats. A duplicated key silently
  // turns keys-2 of three seats into keys-2 of two, i.e. one device signing twice.
  const devs = [cfg.deviceA, cfg.deviceB, cfg.deviceC];
  devs.forEach((d, i) => { if (!/^[0-9a-f]{64}$/.test(d ?? '')) die(`device${'ABC'[i]} is not a 64-hex pubkey`); });
  if (new Set(devs).size !== 3) die('deviceA/B/C are not three distinct keys');
  // totalSupply feeds BOTH the deploy data (the token's supply constant) and the
  // mint amounts. A typo here mis-parameterises the one irreversible step.
  if (cfg.totalSupply !== 1000000.0) die(`totalSupply is ${cfg.totalSupply}, expected 1000000.0`);
}

const KS = `${cfg.ns}.pco-gov`;
const T = `${cfg.ns}.pco`;
const C = `${cfg.ns}.pco-claim`;
const G = `${cfg.ns}.pco-gas-station`;
const GOV_KEYS = { keys: [cfg.deviceA, cfg.deviceB, cfg.deviceC], pred: 'keys-2' };
// Routine-ops AUTHORITY (module state in `pco`, named by governance - NOT a
// named keyset). 1-of-2 over the two ACTIVE devices: either can operate, so
// losing one never halts operations, and governance can replace it any time
// via set-ops-guard. Device C is the break-glass seat and stays out of the
// routine tier deliberately.
const OPS_KEYS = { keys: [cfg.deviceA, cfg.deviceB], pred: 'keys-any' };
const DEPLOY_DATA = {
  ns: cfg.ns, upgrade: false, symbol: 'PCO', precision: 12,
  'total-supply': cfg.totalSupply,
};
const contract = (f: string) => readFileSync(new URL(`../../contracts/${f}`, import.meta.url), 'utf8');

// signer slots: [gas softkey (coin.GAS only), then each device]
// (2 devices for gov-tier steps; 1 device for ops-tier steps)
// `caps` SCOPES the device signatures to named capabilities. Prefer it wherever
// the step's authority is a single named cap: the device blind-signs a hash, so
// an unscoped signature would be spendable on anything else in a substituted
// tx. Steps whose code touches several caps (deploys, multi-call ceremonies)
// still sign unscoped - there the reviewed code IS the scope.
function ceremonyTx(code: string, chain: string, data: Record<string, any>, gasLimit: number, devices: string[], caps?: string[]) {
  let b: any = Pact.builder.execution(code)
    .addSigner(cfg.gasPayer.publicKey, (wc: any) => [wc('coin.GAS')]);
  for (const d of devices) b = caps ? b.addSigner(d, (wc: any) => caps.map((c) => wc(c))) : b.addSigner(d);
  for (const [k, v] of Object.entries(data)) b = b.addData(k, v);
  return b.setMeta({
    chainId: chain as ChainId, senderAccount: cfg.gasPayer.account,
    gasLimit, gasPrice: 1e-7, ttl: CEREMONY_TTL,
  }).setNetworkId(NETWORK_ID).createTransaction();
}

function emit(name: string, tx: any) {
  // FAIL CLOSED on unsubstituted placeholders. Several steps default their
  // parameters to literal "TO-FILL-…" strings when the operator forgets an env
  // var. Pact 5.4 ACCEPTS those happily — a rotate would permanently define a
  // keyset over a key nobody holds, and a create-round would set a code hash
  // nobody can answer. Neither is recoverable. Catch it here, once, for every
  // step, rather than trusting the operator to notice it on the device screen
  // (which shows only a hash).
  if (JSON.stringify(tx).includes('TO-FILL')) {
    const hits = [...JSON.stringify(tx).matchAll(/TO-FILL[A-Za-z0-9-]*/g)].map((m) => m[0]);
    throw new Error(
      `refusing to write ${name}: unsubstituted placeholder(s) ${[...new Set(hits)].join(', ')}. ` +
      `Set the required PCO_* environment variables for this step and rebuild.`,
    );
  }
  // output is segregated BY NETWORK: a devnet-built file lives in out/recap-development/
  // and can never be mistaken for (or submitted as) a ceremony file — submit.ts
  // additionally refuses any file whose networkId differs from the harness target.
  mkdirSync(new URL(`../out/${NETWORK_ID}/`, import.meta.url), { recursive: true });
  const p = new URL(`../out/${NETWORK_ID}/${name}.json`, import.meta.url);
  writeFileSync(p, JSON.stringify(tx, null, 2));
  console.log(`  wrote ops/out/${NETWORK_ID}/${name}.json  (hash ${tx.hash})`);
}

// Pair map: seats A + B sign EVERYTHING (keys-2 is met without C); seat C is
// the break-glass backup and NEVER signs on-chain — its key control is proven
// off-chain only. Ops tier: A signs alone.
//
// WHICH PHYSICAL DEVICE HOLDS WHICH SEAT IS NOT RECORDED HERE, and must not be.
// This file is published. The seat pubkeys are on chain and are not secrets; the
// MAPPING is what tells someone which object to go after for which seat. It
// lives in the private ceremony repository.
const AB: string[] = [cfg.deviceA, cfg.deviceB];
const A_SOLO: string[] = [cfg.deviceA];

// CEREMONY TTL. Was 7200 (2h), and it EXPIRED MID-CEREMONY on 2026-07-31: the
// gas-station step's 40 device approvals plus the device swap took 126 minutes,
// and submit.ts refused the first transaction with "Tx time outside of valid
// range". Nothing was lost but 40 approvals — the guard did its job — yet the
// operator had to repeat the entire step.
//
// The TTL clock starts at BUILD time, not at signing, so it must cover
// build + N approvals + swap + N approvals + submit. At ~15 KB per deploy that
// is comfortably over two hours for a 20-chain step, and the deploy phase has
// three such steps.
//
// 8h chosen deliberately. Chainweb's ceiling is 48h (measured 2026-07-31 against
// mainnet01: ttl 172800 validates, 259200 is rejected), but a signed transaction
// is submittable by anyone holding the file, so the window is also an exposure
// window. 8h covers any realistic session with 4x margin without leaving signed
// ceremony transactions valid for two days.
const CEREMONY_TTL = Number(process.env.PCO_TTL ?? 28800);
const only = process.argv[3];
const chains = only ? [only] : CHAINS;

switch (step) {
  case 'preflight-ns':
    // PREFER `npx tsx src/derive-ns.ts` — it computes the same value OFFLINE.
    //
    // Posting this to a public node publishes the full governance keyset, which
    // is step 1 of the cold audit's MEDIUM-1 exploit path (2026-07-30): with the
    // keyset in hand anyone derives n_<hash>, and a first-time define-namespace
    // enforces no signature, so they can create it, take the USER guard, and
    // first-define <ns>.pco-gov as their own — which governance can NEVER
    // reclaim. Atomicity in the namespace step is what closes that window; this
    // just avoids handing out the keyset days early for no benefit, since the
    // answer is computable locally against the byte-true mainnet `ns` fixture.
    console.log(JSON.stringify({
      code: `(ns.create-principal-namespace (read-keyset 'pco-gov))`,
      data: { 'pco-gov': GOV_KEYS },
      note: 'PREFER `npx tsx src/derive-ns.ts` (offline, same value, publishes nothing). ' +
            'Only POST this as /local if you must confirm against a live node — it publishes the governance keyset.',
    }, null, 2));
    break;
  // NAMESPACE + KEYSET ARE ONE TRANSACTION. They were two (`namespace` then
  // `keyset`), and the gap between them was exploitable — cold audit 2026-07-30,
  // MEDIUM-1, proved against the byte-true mainnet01 `ns` fixture.
  //
  // `ns.validate` constrains only the namespace ADMIN guard, and a first-time
  // `define-namespace` enforces NO signature. So anyone who learns the governance
  // keyset can derive `n_<hash>`, create it unsigned taking the USER guard, and
  // first-define `<ns>.pco-gov` as their own keyset. Governance reclaims the
  // namespace — it holds the admin guard — but can NEVER reclaim the keyset,
  // because keyset redefinition enforces the CURRENT keyset, not the namespace
  // guard. Our step 4 would still succeed and reclaim the user guard, so the
  // RUNBOOK's own §4 verification showed a clean namespace and detected nothing;
  // step 5 then failed with `Keyset failure` on that chain, permanently.
  //
  // SECRECY CANNOT CLOSE THIS. This very transaction carries the full governance
  // keyset in `addData`, so the keyset is public the moment the first namespace
  // transaction enters a mempool — while the other 19 chains are still unclaimed.
  // Only atomicity closes it: with both calls in one `exec`, there is no instant
  // at which the namespace exists and the keyset does not.
  //
  // Kept under the old `namespace` step name so RUNBOOK muscle memory still works;
  // `keyset` is an explicit alias that now builds the same artifact.
  case 'namespace':
  case 'keyset':
    for (const ch of chains) emit(`10-namespace-keyset-c${ch}`, ceremonyTx(
      `(define-namespace "${cfg.ns}" (read-keyset 'pco-gov) (read-keyset 'pco-gov)) ` +
      `(namespace "${cfg.ns}") (define-keyset "${KS}" (read-keyset 'pco-gov))`,
      ch, { 'pco-gov': GOV_KEYS }, 4500, AB));
    break;
  // DEPLOY GAS LIMITS — set from MEASURED MAINNET receipts, not devnet ones.
  //
  // The mainnet dry run (2026-07-29, evidence/MAINNET-DRY-RUN.md) measured the
  // real cost on chains 0 and 2, identically on both:
  //     token 44,778   claim 24,523   station not measured (excluded from that run)
  // The previous limits here were derived from devnet receipts of token 22,871 /
  // claim 17,337 and described as carrying ">=2x margin". Against the real
  // figures that was FALSE for the token: a 50,000 limit left 5,222 of headroom,
  // about 12%, on a module that has grown since. Mainnet costs roughly twice
  // devnet for the same code, so devnet receipts must never be used to set a
  // mainnet ceiling again.
  //
  // A too-HIGH limit costs nothing (gas is charged on use, and 150,000 is the
  // per-transaction ceiling); a too-LOW one fails the deploy partway through a
  // 20-chain fan-out, which is the expensive direction. Limits below are ~2x the
  // measured cost. The station keeps a proportionally larger margin because it
  // is the one module with no mainnet measurement yet.
  case 'deploy-token':
    for (const ch of chains) emit(`30-token-c${ch}`, ceremonyTx(contract('pco.pact'), ch, DEPLOY_DATA, 90000, AB));
    break;
  case 'deploy-claim':
    for (const ch of chains) emit(`31-claim-c${ch}`, ceremonyTx(contract('pco-claim.pact'), ch, DEPLOY_DATA, 60000, AB));
    break;
  case 'deploy-station':
    for (const ch of chains) emit(`32-station-c${ch}`, ceremonyTx(contract('pco-gas-station.pact'), ch, DEPLOY_DATA, 40000, AB));
    break;
  case 'mint':
    emit(`40-mint-c${HUB}`, ceremonyTx(
      `(${T}.init-mint [
        { "account": (${C}.pool-account), "guard": (${C}.pool-guard), "amount": ${(cfg.totalSupply * 0.9).toFixed(1)} },
        { "account": "r:${KS}", "guard": (keyset-ref-guard "${KS}"), "amount": ${(cfg.totalSupply * 0.1).toFixed(1)} } ])`,
      HUB, {}, 4000, AB));
    break;
  case 'fund-station': {
    // gas softkey both pays gas AND funds the station. The station account is
    // deterministic, so we ask the caller for it via env (PCO_STATION_ACCOUNT,
    // from the /local read at deploy verification) rather than editing the
    // pinned source.
    //
    // FLOAT POLICY (founder decision 2026-07-29): keep it SMALL. The known drain
    // is closed - the account guard binds the transaction's gas payer to the
    // station, and ALLOW_GAS is single-use - but the float is the only real
    // value this otherwise-valueless system holds, so it is sized to be losable
    // rather than sized to a forecast. A small float bounds anything we have not
    // thought of, and costs nothing: the epoch cap is 0.5 KDA/day,
    // so 1.0 KDA is two full days at the MAXIMUM sponsored rate and months at
    // the realistic one (~30 claims/day is roughly 0.02 KDA). Refill on demand
    // rather than pre-funding against a busy month that may never come.
    const station = process.env.PCO_STATION_ACCOUNT ?? 'TO-FILL-station-account-from-local';
    const float = process.env.PCO_STATION_FLOAT ?? '1.0';
    // A fat-fingered float is a silent, irreversible over-exposure: the KDA is
    // spendable only through the station guard, so recovering it needs a
    // governance withdraw. Refuse rather than emit.
    if (Number(float) > 2.0 || !(Number(float) > 0)) {
      console.error(`ABORT: station float ${float} KDA is outside the sanctioned range (0, 2.0]`);
      console.error('       policy: keep the float small and refill on demand — see RUNBOOK §D.0');
      process.exit(1);
    }
    const tx = Pact.builder
      .execution(`(coin.transfer-create "${cfg.gasPayer.account}" "${station}" (${G}.create-gas-payer-guard) ${float})`)
      .addSigner(cfg.gasPayer.publicKey, (wc: any) => [
        wc('coin.GAS'),
        wc('coin.TRANSFER', cfg.gasPayer.account, station, { decimal: float }),
      ])
      .setMeta({ chainId: HUB as ChainId, senderAccount: cfg.gasPayer.account, gasLimit: 2500, gasPrice: 1e-7, ttl: CEREMONY_TTL })
      .setNetworkId(NETWORK_ID).createTransaction();
    emit(`41-fund-station-c${HUB}`, tx);
    break;
  }
  case 'open-claims': {
    // launch: the GENESIS round + the master switch, ops device ALONE.
    // Pass the PRE-COMPUTED BLAKE2b hash, never the plaintext code: tx code
    // is permanently public on-chain, so `(hash "code")` in the payload
    // would publish the quest answer to every tx reader (audit LOW).
    // Compute off-chain:  pact ->  (hash "the-code")
    // Parameterize via env (no mid-ceremony source edit of the pinned clone):
    //   PCO_CODE_HASH PCO_OPENS PCO_CLOSES  (times UTC ISO; genesis = 30 days)
    const gh = process.env.PCO_CODE_HASH ?? 'TO-FILL-CODE-HASH-computed-offchain';
    const go = process.env.PCO_OPENS ?? 'TO-FILL-OPENS-Z';
    const gc = process.env.PCO_CLOSES ?? 'TO-FILL-CLOSES-Z';
    emit(`50-open-claims-c${HUB}`, ceremonyTx(
      `(${C}.create-round "genesis" "${gh}" 100.0 30000.0 (time "${go}") (time "${gc}")) (${C}.set-open true)`,
      HUB, {}, 3000, A_SOLO));
    break;
  }
  case 'reserve-seed': {
    // seed a receiver from the community reserve (r:<ns>.pco-gov). Gov pair
    // (A+B), scoped TRANSFER.
    //
    // This used to say the primary use was a "bootstrap-proposer" account so
    // governance could open from week 1. That was false: create-proposal is
    // PROPOSAL-OPS-gated, so a balance buys no right to open a question, and the
    // ops tier opens them directly. Governance needs no seeded account.
    //
    // The reserve IS vote-barred (pco.pact hardcodes the enforce), so seeding out
    // of it turns barred weight into VOTABLE weight. If the receiver is meant to
    // be non-voting, call pco.register-non-voting on it - a note in a document
    // does not bar a vote.
    // env: PCO_SEED_ACCOUNT PCO_SEED_PUBKEY [PCO_SEED_AMOUNT=1000.0]
    const acct = process.env.PCO_SEED_ACCOUNT ?? 'TO-FILL-k-ACCOUNT';
    const pub = process.env.PCO_SEED_PUBKEY ?? 'TO-FILL-PUBKEY';
    const amt = process.env.PCO_SEED_AMOUNT ?? '1000.0';
    let b: any = Pact.builder
      .execution(`(${T}.transfer-create "r:${KS}" "${acct}" (read-keyset 'sg) ${amt})`)
      .addSigner(cfg.gasPayer.publicKey, (wc: any) => [wc('coin.GAS')]);
    for (const d of AB) b = b.addSigner(d, (wc: any) => [wc(`${T}.TRANSFER`, `r:${KS}`, acct, { decimal: amt })]);
    b = b.addData('sg', { keys: [pub], pred: 'keys-all' });
    emit(`42-reserve-seed-c${HUB}`, b.setMeta({ chainId: HUB as ChainId, senderAccount: cfg.gasPayer.account, gasLimit: 4000, gasPrice: 1e-7, ttl: CEREMONY_TTL }).setNetworkId(NETWORK_ID).createTransaction());
    break;
  }
  case 'set-open': {
    // master kill switch / reopen. Ops solo. env: PCO_OPEN=true|false
    const open = (process.env.PCO_OPEN ?? 'false') === 'true';
    emit(`53-set-open-${open}-c${HUB}`, ceremonyTx(`(${C}.set-open ${open})`, HUB, {}, 2000, A_SOLO));
    break;
  }
  case 'set-round-code': {
    // rotate a round's engagement code. Ops solo. env: PCO_ROUND_ID PCO_CODE_HASH
    const rid = process.env.PCO_ROUND_ID ?? 'TO-FILL-ROUND-ID';
    const rh = process.env.PCO_CODE_HASH ?? 'TO-FILL-CODE-HASH';
    emit(`54-set-round-code-${rid}-c${HUB}`, ceremonyTx(`(${C}.set-round-code "${rid}" "${rh}")`, HUB, {}, 3000, A_SOLO));
    break;
  }
  case 'set-round-active': {
    // pause / reactivate a round. Ops solo. env: PCO_ROUND_ID PCO_ACTIVE=true|false
    const rid = process.env.PCO_ROUND_ID ?? 'TO-FILL-ROUND-ID';
    const active = (process.env.PCO_ACTIVE ?? 'false') === 'true';
    emit(`55-set-round-active-${rid}-${active}-c${HUB}`, ceremonyTx(`(${C}.set-round-active "${rid}" ${active})`, HUB, {}, 3000, A_SOLO));
    break;
  }
  case 'create-round': {
    // recurring cadence op (Pact Quests / governance reading-quests /
    // community-call codes): ops device signs ALONE. Parameterize via env:
    //   PCO_ROUND_ID PCO_CODE_HASH PCO_OPENS PCO_CLOSES [PCO_AMOUNT PCO_BUDGET]
    // (hash computed OFF-CHAIN: pact> (hash "the-code") — never plaintext in tx)
    const rid = process.env.PCO_ROUND_ID ?? 'TO-FILL-ROUND-ID';
    const rhash = process.env.PCO_CODE_HASH ?? 'TO-FILL-CODE-HASH-computed-offchain';
    const opens = process.env.PCO_OPENS ?? 'TO-FILL-OPENS-Z';
    const closes = process.env.PCO_CLOSES ?? 'TO-FILL-CLOSES-Z';
    const amount = process.env.PCO_AMOUNT ?? '100.0';
    const budget = process.env.PCO_BUDGET ?? '2500.0';
    emit(`51-create-round-${rid}-c${HUB}`, ceremonyTx(
      `(${C}.create-round "${rid}" "${rhash}" ${amount} ${budget} (time "${opens}") (time "${closes}"))`,
      HUB, {}, 3000, A_SOLO));
    break;
  }
  case 'grant': {
    // single judged award. Ops solo. env: PCO_GRANT_ACCOUNT PCO_GRANT_PUBKEY
    // PCO_GRANT_AMOUNT PCO_GRANT_REASON.
    const ga = process.env.PCO_GRANT_ACCOUNT ?? 'TO-FILL-k-ACCOUNT';
    const gp = process.env.PCO_GRANT_PUBKEY ?? 'TO-FILL-PUBKEY';
    const gamt = process.env.PCO_GRANT_AMOUNT ?? 'TO-FILL-AMOUNT';
    const gr = (process.env.PCO_GRANT_REASON ?? 'TO-FILL-PUBLIC-REASON').replace(/"/g, '');
    emit(`56-grant-c${HUB}`, ceremonyTx(
      `(${C}.grant "${ga}" (read-keyset 'g) ${gamt} "${gr}")`,
      HUB, { g: { keys: [gp], pred: 'keys-all' } }, 4000, A_SOLO));
    break;
  }
  case 'grant-batch': {
    // several judged awards under ONE signature (the monthly batch shape).
    // env PCO_BATCH_FILE points at a JSON array of {account,pubkey,amount,reason}
    // (<= 20 distinct receivers). Ops solo. One batch per tx.
    const path = process.env.PCO_BATCH_FILE ?? '';
    if (!path) { console.error('set PCO_BATCH_FILE to a JSON array of {account,pubkey,amount,reason}'); process.exit(2); }
    const items: { account: string; pubkey: string; amount: string | number; reason: string }[] =
      JSON.parse(readFileSync(path, 'utf8'));
    const data: Record<string, any> = {};
    const itemCode = items.map((it, i) => {
      data[`g${i}`] = { keys: [it.pubkey], pred: 'keys-all' };
      const reason = String(it.reason).replace(/"/g, '');
      return `{ "account": "${it.account}", "guard": (read-keyset 'g${i}), "amount": ${Number(it.amount).toFixed(1)}, "reason": "${reason}" }`;
    }).join(' ');
    // GAS LIMIT 20,000, raised from 6,000 (2026-07-29).
    //
    // The 6,000 was unmeasured and too low. MEASURED at MAX-BATCH=20 with 20
    // fresh receiver accounts (tests/lifecycle.repl, "GAS grant-batch
    // (MAX-BATCH=20)"): 4,706 in the REPL. This repo's own mainnet dry run
    // established that mainnet costs roughly TWICE the REPL/devnet figure for
    // identical code (token 22,871 devnet -> 44,778 mainnet), so a full batch
    // lands near 9,400 on mainnet - over the old ceiling, and it would have
    // failed the monthly batch out of gas after burning the fee.
    //
    // Nothing detected this because lifecycle.repl printed gas for 14 operations
    // and asserted NONE of them, and grant-batch at MAX-BATCH was not measured at
    // all. Both are fixed: every figure is now an assertion.
    //
    // A too-HIGH limit costs nothing - gas is charged on USE and 150,000 is the
    // per-transaction ceiling - while a too-LOW one fails the transaction. Hence
    // ~2x the projected mainnet worst case rather than a tight fit.
    emit(`57-grant-batch-c${HUB}`, ceremonyTx(
      `(${C}.grant-batch [ ${itemCode} ])`, HUB, data, 20000, A_SOLO));
    break;
  }
  case 'sweep': {
    // program-end pool sweep to the community reserve (or another receiver).
    // ADMIN (gov pair A+B). Must be preceded by set-open false. env:
    // PCO_SWEEP_RECEIVER (default r:<ns>.pco-gov) PCO_SWEEP_GUARD_REF (keyset ref).
    const recv = process.env.PCO_SWEEP_RECEIVER ?? `r:${KS}`;
    const guardRef = process.env.PCO_SWEEP_GUARD_REF ?? KS;
    emit(`80-sweep-c${HUB}`, ceremonyTx(
      `(${C}.sweep-pool "${recv}" (keyset-ref-guard "${guardRef}"))`, HUB, {}, 6000, AB));
    break;
  }
  case 'withdraw': {
    // recover residual station KDA. Gov pair (the station guard enforces the
    // admin keyset on its recovery branch). env: PCO_STATION_ACCOUNT (the c:
    // principal from /local) PCO_WITHDRAW_TO PCO_WITHDRAW_AMOUNT.
    const station = process.env.PCO_STATION_ACCOUNT ?? 'TO-FILL-station-account-from-local';
    const to = process.env.PCO_WITHDRAW_TO ?? 'TO-FILL-receiver';
    const amt = process.env.PCO_WITHDRAW_AMOUNT ?? 'TO-FILL-amount';
    let b: any = Pact.builder
      .execution(`(${G}.withdraw "${to}" ${amt})`)
      .addSigner(cfg.gasPayer.publicKey, (wc: any) => [wc('coin.GAS')]);
    for (const d of AB) b = b.addSigner(d, (wc: any) => [wc('coin.TRANSFER', station, to, { decimal: String(amt) })]);
    emit(`81-withdraw-c${HUB}`, b.setMeta({ chainId: HUB as ChainId, senderAccount: cfg.gasPayer.account, gasLimit: 3000, gasPrice: 1e-7, ttl: CEREMONY_TTL }).setNetworkId(NETWORK_ID).createTransaction());
    break;
  }
  case 'rotate':
    // fill 'pco-gov-v2' with the post-rotation keyset before building
    for (const ch of chains) emit(`90-rotate-c${ch}`, ceremonyTx(
      `(namespace "${cfg.ns}") (define-keyset "${KS}" (read-keyset 'pco-gov-v2))`,
      ch, { 'pco-gov-v2': { keys: ['TO-FILL', 'TO-FILL', 'TO-FILL'], pred: 'keys-2' } }, 2000, AB));
    break;
  case 'set-ops-guard':
    // Name (or RE-name) the routine-ops authority. Governance-only, signed
    // A+B here; ANY governance pair works - including one that excludes a
    // lost or compromised ops device, which is the whole point. Available
    // even after FROZEN-MODULE, so who-operates is recoverable forever.
    // Hub chain carries governance; the claim/ops surface reads it there.
    for (const ch of chains) emit(`21-set-ops-guard-c${ch}`, ceremonyTx(
      `(${T}.set-ops-guard (read-keyset 'ops-authority))`,
      ch, { 'ops-authority': OPS_KEYS }, 2500, AB, [`${T}.OPS-ADMIN`]));
    break;
  case 'rotate-ops':
    // Emergency/rotation variant: fill OPS_ROTATE_KEYS (or edit here) with
    // the replacement authority, then sign with ANY governance pair. The
    // outgoing device does NOT need to participate and cannot block it.
    for (const ch of chains) emit(`91-rotate-ops-c${ch}`, ceremonyTx(
      `(${T}.set-ops-guard (read-keyset 'ops-authority))`,
      ch, { 'ops-authority': { keys: (process.env.PCO_OPS_KEYS ?? 'TO-FILL').split(','), pred: process.env.PCO_OPS_PRED ?? 'keys-any' } }, 2500, AB, [`${T}.OPS-ADMIN`]));
    break;
  // ---------------------------------------------------------------- upgrade
  case 'upgrade': {
    // A redeploy that touches no tables. This step exists because RUNBOOK's
    // rollback said "redeploys with upgrade:true" while DEPLOY_DATA hardcodes
    // upgrade:false — so the documented rollback could not be BUILT, and against
    // a live chain what this tool emitted failed with
    // "Table <ns>.pco_accounts already exists".
    //
    // ANY upgrade MUST bless the currently deployed hash, or in-flight
    // cross-chain defpacts strand and every dependent module's pin breaks. Use
    // `freeze` for the final one; for an ordinary upgrade, add the bless line to
    // the source first and record the pre-upgrade hash in deployed-hashes.json.
    const mod = process.env.PCO_MODULE ?? 'TO-FILL-module-name';
    const file = { pco: 'pco.pact', 'pco-claim': 'pco-claim.pact', 'pco-gas-station': 'pco-gas-station.pact' }[mod];
    if (!file) {
      console.error(`ABORT: set PCO_MODULE to one of pco | pco-claim | pco-gas-station (got "${mod}")`);
      process.exit(2);
    }
    const body = contract(file);
    // THE BLESS REQUIREMENT IS MODULE-SPECIFIC, and requiring it everywhere made
    // the sanctioned freeze order unbuildable. Step 4 of that order redeploys
    // `pco-claim` AFTER `pco` is frozen, to re-pin it — and this gate aborted
    // that step over a hazard `pco-claim` does not have, so the documented
    // procedure could not be executed with the shipped tooling at all.
    //
    // What the bless actually protects: a module hash is pinned by (a) in-flight
    // cross-chain defpacts, which carry the hash they yielded under, and (b) any
    // dependent module that pinned it at ITS deploy. Measured, that is `pco`
    // alone: it owns the only defpact, and both other modules depend on it.
    // Nothing depends on `pco-claim` or `pco-gas-station`, and neither defines a
    // defpact, so an unblessed redeploy of those strands nothing.
    const NEEDS_BLESS = new Set(['pco']);
    if (NEEDS_BLESS.has(mod) && !/\(bless\s/.test(body) && process.env.PCO_UPGRADE_NO_BLESS !== 'i-understand') {
      console.error(`ABORT: ${file} carries no (bless ...) form.`);
      console.error('       An unblessed upgrade permanently strands every in-flight cross-chain');
      console.error('       transfer and breaks every dependent module pin (measured: "hash not');
      console.error('       blessed for module" on set-open, i.e. the master kill switch).');
      console.error(`       Read the deployed hash with:`);
      console.error(`         npx tsx src/local.ts '(at (quote hash) (describe-module "${cfg.ns}.${mod}"))'`);
      console.error('       add (bless "<that hash>") to the module header, then rebuild.');
      console.error('       If you have genuinely decided otherwise: PCO_UPGRADE_NO_BLESS=i-understand');
      process.exit(2);
    }
    if (!NEEDS_BLESS.has(mod) && !/\(bless\s/.test(body)) {
      console.log(`  note: ${file} carries no (bless ...) — correct for this module.`);
      console.log('        Nothing pins its hash: it defines no defpact and no module depends on it.');
      console.log('        (Only `pco` is pinned, by its cross-chain defpact and by both dependents.)');
    }
    for (const ch of chains) emit(`80-upgrade-${mod}-c${ch}`, ceremonyTx(
      body, ch, { ...DEPLOY_DATA, upgrade: true }, 90000, AB));
    break;
  }

  // ------------------------------------------------------------------ freeze
  case 'freeze': {
    // THE ONE DEPLOY THAT CAN NEVER BE REPEATED, CORRECTED, OR ROLLED BACK.
    //
    // Until now it was also the only deploy with no tooling: 21 steps here and
    // not one of them was `freeze`, so the permanent final deploy was a hand
    // edit under ceremony pressure while every reversible step was tooled and
    // deterministic. The only artifact that performed the two edits was a TEST
    // FIXTURE generator, with a placeholder bless hash.
    //
    // This step: checks the chain, applies both edits deterministically, writes
    // the frozen source back into contracts/ so it can be COMMITTED (otherwise
    // verify-deployed reports DIFFERS for pco forever from the moment of the
    // freeze, breaking docs/VERIFYING.md at exactly the moment the system
    // reaches its intended permanent state), and emits the upgrade:true deploys.
    const mod = process.env.PCO_MODULE ?? 'TO-FILL-module-name';
    const file = { pco: 'pco.pact', 'pco-claim': 'pco-claim.pact' }[mod];
    if (!file) {
      console.error(`ABORT: freeze takes PCO_MODULE=pco | pco-claim (got "${mod}").`);
      console.error('       pco-gas-station must NEVER be frozen — it pins coin at runtime,');
      console.error('       and its deploy footer refuses the flag outright.');
      process.exit(2);
    }
    // ORDER MATTERS: freeze `pco` first, then `pco-claim`. Freezing pco changes
    // its hash, which re-pins pco-claim, so pco-claim must be redeployed after
    // (and must bless its own pre-freeze hash). Never freeze pco-claim before
    // close + sweep.
    const { freezePreflight } = await import('./freeze-preflight.js');
    const pre = await freezePreflight(cfg.ns, mod, chains);
    if (!pre.ok) {
      console.error('\nABORT: freeze preconditions are NOT met. Nothing was written.');
      console.error('       These are not advisory — after the flip, create-table is impossible');
      console.error('       forever, module admin is unobtainable forever, and any unblessed hash');
      console.error('       is unreachable forever. Resolve every line above and re-run.');
      process.exit(2);
    }
    const { freezeSource } = await import('./freeze-source.js');
    const frozen = freezeSource(contract(file), pre.hashes);
    const target = new URL(`../../contracts/${file}`, import.meta.url);
    writeFileSync(target, frozen.source);
    console.log(`\n  REWROTE contracts/${file} — FROZEN, blessing ${frozen.blessed.length} hash(es):`);
    for (const h of frozen.blessed) console.log(`    (bless "${h}")`);
    console.log('  COMMIT THIS FILE before submitting, or verify-deployed reports DIFFERS forever.');
    for (const ch of chains) emit(`95-freeze-${mod}-c${ch}`, ceremonyTx(
      frozen.source, ch, { ...DEPLOY_DATA, upgrade: true }, 90000, AB));
    break;
  }
  default:
    console.error('unknown step'); process.exit(2);
}
