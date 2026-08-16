// measure-xchain-window.ts — F7: is the residual cross-chain vote window exploitable?
//
// THE QUESTION THE ADR LEFT OPEN. Voting is chain-local and every copy of a
// question closes at ONE absolute instant, so a ballot cast on chain A stops being
// releasable the moment A's copy closes. If the tokens could then reach chain B
// and vote again BEFORE B's copy closed, the same tokens would count twice.
//
// With a shared absolute `ends-at`, that gap is not operator-sized — it is only
// the spread between the chains' own block clocks. The founder accepted that
// residual on 2026-08-13 on the grounds that a cross-chain transfer takes minutes
// and the spread is seconds. THE ACCEPTANCE WAS NEVER MEASURED. This measures it.
//
// Two numbers decide it, and neither can come from a REPL (no SPV there):
//   1. the spread between chain clocks — the width of the window
//   2. how long a real cross-chain transfer actually takes — what must fit inside
//
// Exploitable only if (2) < (1). Reports the ratio rather than a verdict adjective,
// and measures the transfer SEVERAL times because one sample of a distributed
// system is an anecdote.
//
// Usage: PCO_NETWORK=recap-development PCO_NS=free npx tsx src/measure-xchain-window.ts
import { readFileSync } from 'node:fs';
import { CHAINS, HUB, NS, SENDER00, localCall, newKey, send, xchain, type Keypair } from './env.js';

const T = `${NS}.pco`;
const RUNS = Number(process.env.PCO_XCHAIN_RUNS ?? 3);

async function clockSpread(label: string): Promise<number> {
  // Sample every chain as close to simultaneously as possible; the spread is the
  // span between the earliest and latest block time seen in that instant.
  const times = await Promise.all(CHAINS.map(async (ch) => {
    try { return new Date(String(await localCall("(at 'block-time (chain-data))", ch))).getTime(); }
    catch { return null; }
  }));
  const ok = times.filter((t): t is number => t !== null);
  const spread = (Math.max(...ok) - Math.min(...ok)) / 1000;
  console.log(`  ${label}: ${ok.length}/${CHAINS.length} chains read, spread ${spread.toFixed(1)}s`);
  return spread;
}

async function main() {
  console.log('F7 — is the residual cross-chain vote window exploitable?\n');

  console.log('1. THE WINDOW: spread between chain clocks (three samples)');
  const spreads: number[] = [];
  for (let i = 0; i < 3; i++) { spreads.push(await clockSpread(`sample ${i + 1}`)); await new Promise((r) => setTimeout(r, 4000)); }
  const worstSpread = Math.max(...spreads);
  console.log(`  WIDEST observed window: ${worstSpread.toFixed(1)}s\n`);

  console.log(`2. WHAT MUST FIT INSIDE IT: a real cross-chain transfer, ${RUNS} runs`);
  const K = JSON.parse(readFileSync(new URL('../out/rehearsal-keys.json', import.meta.url), 'utf8')) as Record<string, Keypair>;
  const holder = newKey();
  // fund the mover on the hub with KDA and PCO
  // Gas on BOTH chains: the runs alternate direction, and the return leg pays its
  // own gas on the far chain. Funding only the hub made run 2 fail on buy-gas —
  // a fixture gap that looked like a transfer failure.
  for (const ch of [HUB, '1']) {
    await send({ label: `fund mover KDA @${ch}`, chainId: ch,
      code: `(coin.transfer-create "sender00" "${holder.account}" (read-keyset 'g) 20.0)`,
      signers: [{ kp: SENDER00, caps: (wc: any) => [wc('coin.GAS'), wc('coin.TRANSFER', 'sender00', holder.account, { decimal: '20.0' })] }],
      data: { g: { keys: [holder.publicKey], pred: 'keys-all' } }, gasLimit: 2000 });
  }
  const KS = `${NS}.pco-gov`;
  const gov = [{ kp: K.deviceA }, { kp: K.deviceB }];
  await send({ label: 'fund mover PCO', chainId: HUB,
    code: `(${T}.transfer-create "r:${KS}" "${holder.account}" (read-keyset 'g) 50.0)`,
    data: { g: { keys: [holder.publicKey], pred: 'keys-all' } },
    signers: [{ kp: SENDER00, caps: (wc: any) => [wc('coin.GAS')] },
              ...gov.map((s) => ({ ...s, caps: (wc: any) => [wc(`${T}.TRANSFER`, `r:${KS}`, holder.account, { decimal: '50.0' })] }))],
    gasLimit: 4000 });

  const durations: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const src = i % 2 === 0 ? HUB : '1';
    const dst = i % 2 === 0 ? '1' : HUB;
    const t0 = Date.now();
    await xchain({
      label: `xchain run ${i + 1} (${src} -> ${dst})`, src, target: dst,
      code: `(${T}.transfer-crosschain "${holder.account}" "${holder.account}" (read-keyset 'g) "${dst}" 5.0)`,
      data: { g: { keys: [holder.publicKey], pred: 'keys-all' } },
      signers: [{ kp: holder, caps: (wc: any) => [wc('coin.GAS'), wc(`${T}.TRANSFER_XCHAIN`, holder.account, holder.account, { decimal: '5.0' }, dst)] }],
      contGasPayer: SENDER00,
    });
    const secs = (Date.now() - t0) / 1000;
    durations.push(secs);
    console.log(`  run ${i + 1}: ${src} -> ${dst} completed in ${secs.toFixed(1)}s`);
  }
  const fastest = Math.min(...durations);

  console.log('\n3. THE COMPARISON');
  console.log(`  widest clock window observed : ${worstSpread.toFixed(1)}s`);
  console.log(`  FASTEST transfer observed    : ${fastest.toFixed(1)}s   (the attacker gets the best case)`);
  console.log(`  ratio                        : the transfer is ${(fastest / worstSpread).toFixed(1)}x the window`);
  console.log(`  and a SECOND vote must still be mined after it lands.`);
  console.log(fastest > worstSpread
    ? `\n  => NOT EXPLOITABLE as measured: the fastest transfer does not fit in the widest window.`
    : `\n  => ⚠️ THE TRANSFER FITS INSIDE THE WINDOW. The 2026-08-13 acceptance does not hold; reopen it.`);
  console.log('\n  Caveat stated rather than buried: this is a devnet with a constant-delay miner.');
  console.log('  Mainnet block production is variable, so re-measure the SPREAD against mainnet');
  console.log('  before the freeze; the transfer duration is dominated by SPV and confirmation,');
  console.log('  which is not faster in production.');
}

main().catch((e) => { console.error(e); process.exit(1); });
