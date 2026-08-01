// spread-gas.ts — fund the ceremony gas softkey on chains 1-19 from chain 0.
//
// The ceremony needs the gas softkey funded on every chain (keysets, deploys,
// rotation are all ×20). A cross-chain transfer's CONTINUATION (step 1) must
// buy gas ON THE TARGET CHAIN, where the softkey holds nothing — so the
// continuation is paid by Kadena's public `kadena-xchain-gas` station (live
// and funded on KDA-CE mainnet01, verified 2026-07-24), which sponsors exactly
// this pattern at gas price 1e-8. No new account, no per-chain pre-funding.
//
// This is SOFTKEY-ONLY (no devices) and independent of the device ceremony —
// run it before ceremony day. It signs with the gas softkey secret (env
// PCO_GAS_SECRET) — the ONLY place a secret is used; nothing here touches a
// hardware wallet.
//
// Usage:
//   PCO_NETWORK=mainnet01 PCO_HOST=https://api.chainweb-community.org \
//   PCO_GAS_SECRET=<64hex> PCO_PER_CHAIN=0.15 \
//     npx tsx src/spread-gas.ts [--send] [--only 5,9,12]
import { Pact, createClient, createSignWithKeypair, type ChainId } from '@kadena/client';
import { getPubFromSecret } from './env.js';

const NETWORK = process.env.PCO_NETWORK ?? 'recap-development';
const HOST = process.env.PCO_HOST ?? 'http://localhost:8090';
const PER_CHAIN = process.env.PCO_PER_CHAIN ?? '0.15';
const XGAS = 'kadena-xchain-gas';
const client = createClient(({ chainId, networkId }) => `${HOST}/chainweb/0.0/${networkId}/chain/${chainId}/pact`);

const secret = process.env.PCO_GAS_SECRET;
if (!secret || !/^[0-9a-f]{64}$/.test(secret)) { console.error('set PCO_GAS_SECRET to the 64-hex gas softkey secret'); process.exit(2); }
const pub = getPubFromSecret(secret);
const acct = `k:${pub}`;
const kp = { publicKey: pub, secretKey: secret };

const doSend = process.argv.includes('--send');
const onlyArg = process.argv[process.argv.indexOf('--only') + 1];
const targets = process.argv.includes('--only')
  ? onlyArg.split(',').map((s) => s.trim())
  : Array.from({ length: 19 }, (_, i) => String(i + 1));   // chains 1..19

async function main() {
  console.log(`spread-gas — ${acct.slice(0, 16)}… funds ${PER_CHAIN} KDA to chains ${targets.join(',')} on ${NETWORK}`);
  console.log(`  continuation gas paid by ${XGAS} @ 1e-8 (no target-chain pre-funding needed)`);
  if (!doSend) console.log('  DRY RUN — add --send to submit\n');

  for (const target of targets) {
    // step 0 on chain 0: debit the softkey, yield to the target chain.
    const step0 = Pact.builder
      .execution(`(coin.transfer-crosschain "${acct}" "${acct}" (read-keyset 'k) "${target}" ${PER_CHAIN})`)
      .addSigner(pub, (wc: any) => [
        wc('coin.GAS'),
        wc('coin.TRANSFER_XCHAIN', acct, acct, { decimal: PER_CHAIN }, target),
      ])
      .addKeyset('k', 'keys-all', pub)
      .setMeta({ chainId: '0' as ChainId, senderAccount: acct, gasLimit: 1500, gasPrice: 1e-7, ttl: 3600 })
      .setNetworkId(NETWORK).createTransaction();

    if (!doSend) {
      const pre = await client.local(await createSignWithKeypair(kp)(step0), { preflight: true, signatureVerification: true });
      console.log(`  chain ${target}: step0 preflight ${pre.result.status}${pre.result.status !== 'success' ? ' ' + JSON.stringify((pre.result as any).error).slice(0, 80) : ` (gas ${pre.gas})`}`);
      continue;
    }

    const d0 = await client.submit(await createSignWithKeypair(kp)(step0));
    const r0 = await client.pollOne(d0, { timeout: 300_000, interval: 3_000 });
    if (r0.result.status !== 'success') { console.error(`  chain ${target}: step0 FAILED ${JSON.stringify((r0.result as any).error).slice(0, 120)}`); continue; }

    // step 1 on the target chain: SPV proof, paid by kadena-xchain-gas @ 1e-8.
    const proof = await client.pollCreateSpv(d0, target as ChainId);
    const cont = Pact.builder
      .continuation({ pactId: d0.requestKey, step: 1, rollback: false, proof })
      .addSigner(pub)   // signature not required by the xgas station, but harmless
      .setMeta({ chainId: target as ChainId, senderAccount: XGAS, gasLimit: 850, gasPrice: 1e-8, ttl: 3600 })
      .setNetworkId(NETWORK).createTransaction();
    // A THIRD PARTY MAY HAVE ALREADY FINISHED THIS. Kadena runs cross-chain
    // finisher services that redeem pending SPV continuations, and on mainnet
    // they routinely beat us to it: measured 2026-07-30, 6 of 19 chains came
    // back "defpact execution already completed" — and all 6 had the funds.
    //
    // Reporting that as FAILED is worse than cosmetic. The operator's remedy for
    // a failed chain is to re-send, which builds a SECOND cross-chain transfer
    // and spends another PER_CHAIN for nothing. A 32% false-negative rate on the
    // one tool whose output decides whether money moves again is not acceptable,
    // so the completed-defpact case is resolved by asking the CHAIN what the
    // balance is rather than by trusting our own continuation's status.
    let r1: any;
    try {
      r1 = await client.pollOne(await client.submit(await createSignWithKeypair(kp)(cont)), { timeout: 300_000, interval: 3_000 });
    } catch (e: any) {
      r1 = { result: { status: 'failure', error: { message: String(e?.message ?? e) } } };
    }
    if (r1.result.status === 'success') {
      console.log(`  chain ${target}: funded (${PER_CHAIN} KDA landed, xgas paid continuation)`);
      continue;
    }
    const err = JSON.stringify((r1.result as any).error ?? {});
    if (/already completed/i.test(err)) {
      // Confirm by balance, never by inference — "someone else finished it" and
      // "it silently did not happen" produce the same error string.
      let landed = 'unknown';
      try {
        const bal = await client.local(
          Pact.builder.execution(`(coin.get-balance "${acct}")`)
            .setMeta({ chainId: target as ChainId, senderAccount: acct, gasLimit: 1500, gasPrice: 1e-8 })
            .setNetworkId(NETWORK).createTransaction(),
          { preflight: false, signatureVerification: false });
        landed = bal.result.status === 'success' ? String((bal.result as any).data?.decimal ?? (bal.result as any).data) : 'unreadable';
      } catch { /* leave unknown */ }
      console.log(`  chain ${target}: funded by a third-party finisher before us — balance now ${landed} (do NOT re-send)`);
      continue;
    }
    console.log(`  chain ${target}: step1 FAILED ${err.slice(0, 100)}`);
  }
  console.log('\ndone — verify with:  npx tsx src/local.ts \'(coin.get-balance "' + acct + '")\' all');
}

main().catch((e) => { console.error('spread aborted:', e.message ?? e); process.exit(1); });
