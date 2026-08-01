/**
 * dryrun.ts — build the THROWAWAY mainnet dry-run transactions.
 *
 * SEPARATE FROM build-tx.ts ON PURPOSE. build-tx.ts drives the real ceremony
 * with three hardware wallets and currently has no tests of its own; adding a
 * second mode to it by hand, to serve a throwaway run, is how you break the
 * thing you were trying to de-risk. This file is standalone and touches
 * nothing the ceremony depends on.
 *
 * It EMITS UNSIGNED transactions and nothing else. It cannot sign and cannot
 * send. Signing and submission are a human action, by standing rule.
 *
 * Run from the ops/ directory (all paths are relative to it):
 *   npm run dryrun -- --list
 *   npm run dryrun -- <step>           -> ops/out/mainnet01-dryrun/<step>.json
 *
 * Then, per transaction, also from ops/:
 *   npx tsx src/submit.ts out/mainnet01-dryrun/<step>.json \
 *     --sig <pub>=<hex> --send
 *
 * Steps 11 and 12 (sweep, retire the keyset) are NOT optional. They are what
 * makes this a dry run rather than a deployment. See docs/mainnet-pilot/
 * the dry-run plan in the private ceremony repository.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { Pact } from '@kadena/client';
import type { ChainId } from '@kadena/client';

const NETWORK = 'mainnet01';
// GOV-CHAIN in the contract is "0": the mint, rounds, claims and governance are
// all hub-chain-only. The first attempt ran on chain 2, where the throwaway KDA
// happened to sit, and aborted at the mint - so the hub is funded first
// (dryrun-fund.ts) and everything runs here.
const HUB = process.env.PCO_DRYRUN_CHAIN ?? '0';
const OUT = new URL('../out/mainnet01-dryrun/', import.meta.url);

type Cfg = { ns: string; account: string; publicKey: string; nsGuardKeys: string[] };

/** Throwaway identity only. This file refuses to build against anything else. */
function loadCfg(): Cfg {
  const p = new URL('../dryrun-config.json', import.meta.url);
  const cfg: Cfg = JSON.parse(readFileSync(p, 'utf8'));
  if (!/^n_[0-9a-f]{40}$/.test(cfg.ns)) {
    throw new Error(`refusing to build: ns "${cfg.ns}" is not a principal namespace`);
  }
  if (!/^[0-9a-f]{64}$/.test(cfg.publicKey)) {
    throw new Error('refusing to build: publicKey is not a 64-hex key');
  }
  if (!Array.isArray(cfg.nsGuardKeys) || !cfg.nsGuardKeys.every((k) => /^[0-9a-f]{64}$/.test(k))) {
    throw new Error('refusing to build: nsGuardKeys must be 64-hex keys');
  }
  if (cfg.account !== `k:${cfg.publicKey}`) {
    throw new Error('refusing to build: account must be the k: principal of publicKey');
  }
  return cfg;
}

const contract = (f: string) =>
  readFileSync(new URL(`../out/dryrun/${f}`, import.meta.url), 'utf8');

/**
 * `nsGuarded` adds the namespace's own guard keys as signers. Defining a keyset
 * or a module INSIDE a principal namespace enforces that namespace's user
 * guard, which here is a 2-key keys-all that does NOT include the gas key —
 * found by preflight, not by reading the plan. The gas key still pays.
 */
function build(code: string, data: Record<string, unknown>, gasLimit: number, cfg: Cfg,
               nsGuarded = false) {
  let b: any = Pact.builder.execution(code).addSigner(cfg.publicKey);
  if (nsGuarded) for (const k of cfg.nsGuardKeys) b = b.addSigner(k);
  for (const [k, v] of Object.entries(data)) b = b.addData(k, v);
  return b
    .setMeta({ chainId: HUB as ChainId, senderAccount: cfg.account, gasLimit, gasPrice: 1e-8, ttl: 3600 })
    .setNetworkId(NETWORK)
    .createTransaction();
}

const KS = (cfg: Cfg) => `${cfg.ns}.pco-dryrun-gov`;
const DEPLOY_DATA = (cfg: Cfg) => ({
  ns: cfg.ns, upgrade: false, symbol: 'PCODRY', precision: 12, 'total-supply': 100.0,
});

const STEPS: Record<string, (cfg: Cfg) => any> = {
  // 1 — define the namespace ON THIS CHAIN. Namespaces are per-chain: the same
  // principal namespace existing on chain 2 says nothing about chain 0. The
  // name is derived from the guard keyset, so defining it from the SAME two
  // keys reproduces the same n_ name rather than creating a different one.
  namespace: (cfg) => build(
    `(let ((n (ns.create-principal-namespace (read-keyset 'k))))
       (enforce (= n "${cfg.ns}") "derived namespace does not match the configured one")
       (define-namespace n (read-keyset 'k) (read-keyset 'k)))`,
    { k: { keys: cfg.nsGuardKeys, pred: 'keys-all' } }, 40000, cfg, true),

  // NOTE on reuse: there is no second `namespace` step. The throwaway principal namespace
  // already exists on mainnet01 and is reused deliberately - claiming a second
  // one would leave another permanent namespace behind for no benefit, and the
  // existing one exercises a MULTI-KEY guard, which is closer to the real
  // ceremony's shape than a single key would be.

  // 2 — the throwaway governance keyset, 1-of-1
  keyset: (cfg) => build(
    `(namespace "${cfg.ns}")\n(define-keyset "${KS(cfg)}" (read-keyset 'ks))`,
    { ks: { keys: [cfg.publicKey], pred: 'keys-all' } }, 15000, cfg, true),

  // 3 — token + its tables, in ONE transaction (create-table must ride the deploy)
  'deploy-token': (cfg) => build(
    contract('pco-dryrun.pact'), DEPLOY_DATA(cfg), 140000, cfg, true),

  // 4 — claim distributor; its footer self-registers the pool as non-voting
  'deploy-claim': (cfg) => build(
    contract('pco-claim-dryrun.pact'), DEPLOY_DATA(cfg), 120000, cfg, true),

  // 5 — the one-shot mint: 90 pool / 10 reserve, of a 100 supply
  mint: (cfg) => build(
    `(${cfg.ns}.pco-dryrun.init-mint
       [ { "account": (${cfg.ns}.pco-claim-dryrun.pool-account)
         , "guard":   (${cfg.ns}.pco-claim-dryrun.pool-guard)
         , "amount":  90.0 }
       , { "account": "r:${KS(cfg)}"
         , "guard":   (keyset-ref-guard "${KS(cfg)}")
         , "amount":  10.0 } ])`, {}, 60000, cfg),

  // 6 — name the ops authority (the same throwaway key; no device involved)
  'set-ops': (cfg) => build(
    `(${cfg.ns}.pco-dryrun.set-ops-guard (read-keyset 'ops))`,
    { ops: { keys: [cfg.publicKey], pred: 'keys-all' } }, 30000, cfg),

  // 7 — a round, then open. Code hash computed OFF-CHAIN, never the plaintext.
  // The window is relative to NOW. It was hardcoded to a fixed future date on
  // the first attempt and the claim was refused with "round has not opened
  // yet" - correct behaviour, wrong test data. Rounds are bounded by an
  // in-contract [opens, closes) window and there is no way to move `opens`
  // afterwards, so a round created with the wrong window is simply dead.
  'open-round': (cfg) => {
    const now = Date.now();
    const opens = new Date(now - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const closes = new Date(now + 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return build(
      `(${cfg.ns}.pco-claim-dryrun.create-round "${process.env.PCO_ROUND_ID ?? 'dry-1'}"
          (read-msg 'code-hash) 10.0 50.0
          (time "${opens}") (time "${closes}"))
       (${cfg.ns}.pco-claim-dryrun.set-open true)`,
      { 'code-hash': process.env.PCO_CODE_HASH ?? 'TO-FILL' }, 40000, cfg);
  },

  // 9 — governance, so the pairwise tally is exercised on a real chain
  propose: (cfg) => build(
    `(${cfg.ns}.pco-dryrun.create-proposal "dry"
        "Throwaway question - this deployment is a test and confers nothing."
        ["a" "b"] 72)`, {}, 40000, cfg),

  // 8 — a SELF-PAID claim. No gas station in this run, so the claimant pays its
  // own gas; the claim itself still needs no claimer signature by design.
  claim: (cfg) => build(
    `(${cfg.ns}.pco-claim-dryrun.claim "${process.env.PCO_ROUND_ID ?? 'dry-1'}" "${cfg.account}" (read-keyset 'ck)
        (read-msg 'code))`,
    { ck: { keys: [cfg.publicKey], pred: 'keys-all' },
      code: process.env.PCO_CLAIM_CODE ?? 'dry-code' }, 40000, cfg),

  // 9b — rank the options, so the Borda scores AND the pairwise matrix are
  // exercised on a real chain
  vote: (cfg) => build(
    `(${cfg.ns}.pco-dryrun.cast-vote "1" "${cfg.account}" [0 1])`, {}, 40000, cfg),

  // 11 — TEARDOWN A: close, then sweep the pool back. Not optional.
  'teardown-sweep': (cfg) => build(
    `(${cfg.ns}.pco-claim-dryrun.set-open false)
     (${cfg.ns}.pco-claim-dryrun.sweep-pool "r:${KS(cfg)}"
        (keyset-ref-guard "${KS(cfg)}"))`, {}, 60000, cfg),

  // 12 — TEARDOWN B: retire the governance keyset to one nobody holds, so the
  // modules can never be operated again by anyone, including us. Pact cannot
  // delete a module; this is the closest thing to switching it off.
  'teardown-retire': (cfg) => build(
    `(namespace "${cfg.ns}")\n(define-keyset "${KS(cfg)}" (read-keyset 'retired))`,
    {
      retired: {
        // a well-formed key that is not derived from any seed in existence
        keys: ['0000000000000000000000000000000000000000000000000000000000000000'],
        pred: 'keys-all',
      },
    }, 20000, cfg, true),
};

const arg = process.argv[2];
if (!arg || arg === '--list') {
  console.log('dry-run steps, in order:');
  for (const k of Object.keys(STEPS)) console.log(`  ${k}`);
  console.log('\nteardown-sweep and teardown-retire are REQUIRED - see the dry-run plan');
  process.exit(0);
}
if (!STEPS[arg]) { console.error(`unknown step: ${arg}`); process.exit(1); }

const cfg = loadCfg();
const tx = STEPS[arg](cfg);
mkdirSync(OUT, { recursive: true });
const file = new URL(`${arg}.json`, OUT);
writeFileSync(file, JSON.stringify(tx, null, 2));

console.log(`built  ${arg}`);
console.log(`  ns      ${cfg.ns}`);
console.log(`  network ${NETWORK}  chain ${HUB}`);
console.log(`  payer   ${cfg.account}`);
console.log(`  out     ${file.pathname}`);
console.log(`\nverify, then submit (submission is yours - this tool cannot send).`);
console.log(`Run from the ops/ directory:`);
console.log(`  cd ${new URL('..', import.meta.url).pathname}`);
console.log(`  npx tsx src/submit.ts out/mainnet01-dryrun/${arg}.json \\`);
console.log(`    --sig ${cfg.publicKey}=<signature> --send`);
