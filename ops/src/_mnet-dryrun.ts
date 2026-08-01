// THROWAWAY mainnet01 ceremony dry run (chain 2): create-principal-namespace ->
// define-namespace -> define-keyset -> ROTATE the keyset -> read-back verify.
// Throwaway keys only (ops/out/mnet-dryrun-throwaway.json). No devices, no production
// keys. Gas paid by the throwaway gas account you funded. Delete this file after use.
import { Pact, createClient, createSignWithKeypair } from '@kadena/client';
import { readFileSync } from 'fs';
const HOST = 'https://api.chainweb-community.org', NET = 'mainnet01', CH = '2';
const EXPLORER = 'https://explorer.chainweb-community.org';
// explorer path segment is 'mainnet' (the API network-id is 'mainnet01'). If the direct
// /tx/ path differs, the request key printed below is the definitive value to search.
const txUrl = (rk: string) => `${EXPLORER}/mainnet/tx/${rk}`;
const K = JSON.parse(readFileSync(new URL('../out/mnet-dryrun-throwaway.json', import.meta.url), 'utf8'));
const client = createClient(() => `${HOST}/chainweb/0.0/${NET}/chain/${CH}/pact`);
const gov1 = { keys: [K.govA.publicKey, K.govB.publicKey], pred: 'keys-all' };
const gov2 = { keys: [K.govA.publicKey, K.govB2.publicKey], pred: 'keys-all' }; // rotate: swap govB -> govB2
const log: any[] = [];

// returns the pact DATA on success; null on failure (so callers can probe existence)
async function loc(code: string, data: any = {}) {
  let b: any = Pact.builder.execution(code);
  for (const [k, v] of Object.entries(data)) b = b.addData(k, v);
  const tx = b.setMeta({ chainId: CH as any, senderAccount: K.gas.account, gasLimit: 150000, gasPrice: 1e-8 })
    .setNetworkId(NET).createTransaction();
  const res: any = (await client.local(tx, { preflight: false, signatureVerification: false })).result;
  return res.status === 'success' ? res.data : null;
}
async function mine(label: string, code: string, signers: any[], data: any = {}, gasLimit = 60000) {
  let b: any = Pact.builder.execution(code);
  for (const s of signers) b = s.caps ? b.addSigner(s.kp.publicKey, s.caps) : b.addSigner(s.kp.publicKey);
  for (const [k, v] of Object.entries(data)) b = b.addData(k, v);
  let tx = b.setMeta({ chainId: CH as any, senderAccount: K.gas.account, gasLimit, gasPrice: 1e-8, ttl: 1800 })
    .setNetworkId(NET).createTransaction();
  for (const s of signers) tx = await createSignWithKeypair(s.kp)(tx);
  const d = await client.submit(tx);
  console.log(`  ${label}: submitted, request key = ${d.requestKey}`);
  const r: any = await client.pollOne(d, { timeout: 180000, interval: 3000 });
  const ok = r.result.status === 'success';
  const meta = r.metaData ?? {};
  console.log(`    status=${r.result.status}  block=${meta.blockHeight ?? '?'}  gas=${r.gas ?? '?'}`);
  console.log(`    ${ok ? 'result: ' + JSON.stringify(r.result.data) : 'error: ' + JSON.stringify(r.result.error).slice(0, 260)}`);
  console.log(`    explorer: ${txUrl(d.requestKey)}`);
  log.push({ label, requestKey: d.requestKey, status: r.result.status, blockHeight: meta.blockHeight, blockHash: meta.blockHash, explorer: txUrl(d.requestKey) });
  if (!ok) throw new Error(label + ' failed');
  return r.result.data;
}
const gas = () => ({ kp: K.gas, caps: (w: any) => [w('coin.GAS')] });
const unscoped = (kp: any) => ({ kp });

console.log(`=== mainnet01 ceremony DRY RUN — network=${NET} chain=${CH} ===`);
console.log('gas account   :', K.gas.account);
console.log('gas balance   :', await loc(`(coin.get-balance "${K.gas.account}")`));
const nm: string = await loc(`(ns.create-principal-namespace (read-keyset 'g1))`, { g1: gov1 });
console.log('namespace      :', nm);
const ksName = `${nm}.pco-gov`;

// STEP 1 — create the namespace + keyset (skip if it already exists from a prior run)
const already = await loc(`(describe-namespace "${nm}")`);
if (already) {
  console.log('\nSTEP 1 — namespace already exists (created on a prior run) — skipping creation.');
} else {
  console.log('\nSTEP 1 — create-principal-namespace + define-namespace + define-keyset (gov1 = A+B):');
  await mine('create-ns+keyset',
    `(let ((n (ns.create-principal-namespace (read-keyset 'g1))))
       (define-namespace n (read-keyset 'g1) (read-keyset 'g1))
       (namespace n)
       (define-keyset (format "{}.pco-gov" [n]) (read-keyset 'g1))
       n)`,
    [gas(), unscoped(K.govA), unscoped(K.govB)], { g1: gov1 });
}

// STEP 2 — ROTATE the keyset (skip if already rotated). Authorized by the CURRENT keyset.
const curKs: any = await loc(`(describe-keyset "${ksName}")`);
const alreadyRotated = JSON.stringify(curKs).includes(K.govB2.publicKey);
if (alreadyRotated) {
  console.log(`\nSTEP 2 — ${ksName} already rotated (holds govB2) — skipping.`);
} else {
  console.log(`\nSTEP 2 — ROTATE ${ksName}  (A+B) -> (A+B2), authorized by the current keyset:`);
  await mine('rotate-keyset',
    `(namespace "${nm}") (define-keyset "${ksName}" (read-keyset 'g2))`,
    [gas(), unscoped(K.govA), unscoped(K.govB)], { g2: gov2 });
}

const nsInfo: any = await loc(`(describe-namespace "${nm}")`);
const ks: any = await loc(`(describe-keyset "${nm}.pco-gov")`);
const rotated = JSON.stringify(ks).includes(K.govB2.publicKey) && !JSON.stringify(ks).includes(K.govB.publicKey);

console.log('\n================= VALIDATION SUMMARY (verify in the explorer) =================');
console.log('network            :', NET);
console.log('chain              :', CH);
console.log('explorer base      :', `${EXPLORER}/mainnet`);
console.log('namespace created  :', nm);
console.log('  describe-namespace user-guard.fun:', nsInfo?.['user-guard']?.fun ?? JSON.stringify(nsInfo).slice(0, 80));
console.log('keyset             :', `${nm}.pco-gov`);
console.log('  BEFORE rotation  : keys-all [', K.govA.publicKey, ',', K.govB.publicKey, ']');
console.log('  AFTER  rotation  :', JSON.stringify(ks), rotated ? '  <= B2 present, B gone => ROTATED' : '  <= CHECK');
console.log('throwaway keys     : govA', K.govA.publicKey, '| govB', K.govB.publicKey, '| govB2', K.govB2.publicKey);
console.log('\ntransactions (look each up by request key in the explorer):');
for (const t of log) console.log(`  [${t.label}] ${t.status}  rk=${t.requestKey}  block=${t.blockHeight}\n      ${t.explorer}`);
console.log('\ngas leftover       :', await loc(`(coin.get-balance "${K.gas.account}")`));
console.log(rotated
  ? '\n>>> DRY RUN PASSED: namespace + keyset + key-rotation all mined on mainnet01. Validate the two request keys above in the explorer.'
  : '\n>>> Review the keyset membership above.');
