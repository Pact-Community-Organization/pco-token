/**
 * dryrun-fund.ts — move a little KDA from chain 2 to the HUB chain (0) so the
 * dry run can exercise the mint, the claim and governance, all of which are
 * hub-chain-only by contract.
 *
 * Why this exists at all: the first dry-run attempt aborted at `init-mint` with
 * "mint happens on the hub chain only" — GOV-CHAIN is 0, the throwaway account
 * was funded on chain 2, and chain 0 was empty. `spread-gas.ts` funds chains
 * 1..19 FROM chain 0, so it does not cover this direction. That is a real
 * ceremony precondition: the hub must be funded before the mint.
 *
 * The cross-chain CONTINUATION has to buy gas on the target chain, where the
 * account holds nothing — so it is paid by Kadena's public `kadena-xchain-gas`
 * station at 1e-8, exactly as spread-gas.ts does. No pre-funding, no new
 * account. This file copies that proven pattern rather than modifying the
 * ceremony tool.
 *
 * THROWAWAY KEYS ONLY.
 *   npm run dryrun-fund              # preflight
 *   npm run dryrun-fund -- --send    # move it
 */
import { readFileSync } from 'node:fs';
import { Pact, createClient, createSignWithKeypair, type ChainId } from '@kadena/client';

const NETWORK = 'mainnet01';
const HOST = 'https://api.chainweb-community.org';
const SRC = '2';                 // where the throwaway KDA is
const DST = '0';                 // GOV-CHAIN: mint, rounds, claims, governance
const AMOUNT = process.env.PCO_FUND_AMOUNT ?? '0.30';
const XGAS = 'kadena-xchain-gas';

const client = createClient(({ chainId, networkId }) => `${HOST}/chainweb/0.0/${networkId}/chain/${chainId}/pact`);

const keys = JSON.parse(readFileSync(new URL('../out/mnet-dryrun-throwaway.json', import.meta.url), 'utf8'));
if (!String(keys.note ?? '').includes('THROWAWAY')) {
  console.error('ABORT: key file is not marked THROWAWAY — refusing to sign');
  process.exit(1);
}
const pub: string = keys.gas.publicKey;
const kp = { publicKey: pub, secretKey: keys.gas.secretKey as string };
const acct = `k:${pub}`;
const doSend = process.argv.includes('--send');

async function main() {
  console.log(`dryrun-fund — ${AMOUNT} KDA, chain ${SRC} -> ${DST} (hub), ${NETWORK}`);
  console.log(`  account ${acct}`);
  console.log(`  continuation paid by ${XGAS} @ 1e-8`);
  console.log(`  mode    ${doSend ? 'SEND' : 'preflight only'}`);
  console.log('---');

  const step0 = Pact.builder
    .execution(`(coin.transfer-crosschain "${acct}" "${acct}" (read-keyset 'k) "${DST}" ${AMOUNT})`)
    .addSigner(pub, (wc: any) => [
      wc('coin.GAS'),
      wc('coin.TRANSFER_XCHAIN', acct, acct, { decimal: AMOUNT }, DST),
    ])
    .addKeyset('k', 'keys-all', pub)
    .setMeta({ chainId: SRC as ChainId, senderAccount: acct, gasLimit: 1500, gasPrice: 1e-7, ttl: 3600 })
    .setNetworkId(NETWORK).createTransaction();

  const signed0 = await createSignWithKeypair(kp)(step0);

  if (!doSend) {
    const pre = await client.local(signed0, { preflight: true, signatureVerification: true });
    console.log(`step0 preflight: ${pre.result.status} ${pre.result.status === 'success'
      ? `(gas ${pre.gas})` : JSON.stringify((pre.result as any).error).slice(0, 160)}`);
    console.log('\npreflight only — re-run with --send to move the funds');
    return;
  }

  const d0 = await client.submit(signed0);
  console.log(`step0 submitted, request key ${d0.requestKey}; polling…`);
  const r0 = await client.pollOne(d0, { timeout: 300_000, interval: 3_000 });
  if (r0.result.status !== 'success') {
    console.error(`step0 FAILED: ${JSON.stringify((r0.result as any).error).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`step0 MINED gas=${r0.gas} — debited on chain ${SRC}, yielded to ${DST}`);

  console.log('fetching SPV proof (this waits for enough confirmations)…');
  const proof = await client.pollCreateSpv(d0, DST as ChainId);
  const cont = Pact.builder
    .continuation({ pactId: d0.requestKey, step: 1, rollback: false, proof })
    .addSigner(pub)
    .setMeta({ chainId: DST as ChainId, senderAccount: XGAS, gasLimit: 850, gasPrice: 1e-8, ttl: 3600 })
    .setNetworkId(NETWORK).createTransaction();
  const d1 = await client.submit(await createSignWithKeypair(kp)(cont));
  console.log(`step1 (continuation) submitted, request key ${d1.requestKey}; polling…`);
  const r1 = await client.pollOne(d1, { timeout: 300_000, interval: 3_000 });
  if (r1.result.status !== 'success') {
    console.error(`step1 FAILED: ${JSON.stringify((r1.result as any).error).slice(0, 200)}`);
    console.error('the funds are in a pending defpact - recoverable by completing step 1, not lost');
    process.exit(1);
  }
  console.log(`step1 MINED gas=${r1.gas} — ${AMOUNT} KDA landed on chain ${DST}`);
}

main().catch((e) => { console.error('fund aborted:', e?.message ?? e); process.exit(1); });
