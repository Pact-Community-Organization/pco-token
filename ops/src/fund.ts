// fund.ts — DEVNET-ONLY faucet for website testing.
//
//   PCO_NS=user npx tsx src/fund.ts <k:account> [kdaAmount] [pcoAmount]
//
// Funds the account with KDA from sender00 (gas for self-paid actions) and,
// when pcoAmount is given, with PCO from the community reserve (signed by the
// rehearsal device keys A+B). Refuses to run against anything but devnet.
import { readFileSync } from 'node:fs';
import { HUB, NS, SENDER00, localCall, send, type Keypair } from './env.js';

const T = `${NS}.pco`;
const KS = `${NS}.pco-gov`;

async function main() {
  if (process.env.PCO_NETWORK && process.env.PCO_NETWORK !== 'recap-development') {
    throw new Error('fund.ts is a DEVNET faucet — refusing to run against ' + process.env.PCO_NETWORK);
  }
  const [acct, kdaArg, pcoArg] = process.argv.slice(2);
  if (!acct || !/^k:[0-9a-f]{64}$/.test(acct)) {
    console.error('usage: PCO_NS=user npx tsx src/fund.ts <k:account> [kdaAmount=1] [pcoAmount=0]');
    process.exit(1);
  }
  const kda = Number(kdaArg ?? '1');
  const pco = Number(pcoArg ?? '0');
  const pub = acct.slice(2);

  if (kda > 0) {
    await send({
      label: `fund ${kda} KDA`, chainId: HUB,
      code: `(coin.transfer-create "sender00" "${acct}" (read-keyset 'gk) ${kda.toFixed(1)})`,
      signers: [{ kp: SENDER00, caps: (wc) => [wc('coin.GAS'), wc('coin.TRANSFER', 'sender00', acct, { decimal: kda.toFixed(1) })] }],
      data: { gk: { keys: [pub], pred: 'keys-all' } }, gasLimit: 2500,
    });
  }
  if (pco > 0) {
    const K = JSON.parse(readFileSync(new URL('../out/rehearsal-keys.json', import.meta.url), 'utf8')) as Record<string, Keypair>;
    await send({
      label: `fund ${pco} PCO from the reserve`, chainId: HUB,
      code: `(${T}.transfer-create "r:${KS}" "${acct}" (read-keyset 'pg) ${pco.toFixed(1)})`,
      signers: [
        { kp: SENDER00, caps: (wc) => [wc('coin.GAS')] },
        { kp: K.deviceA, caps: (wc) => [wc(`${T}.TRANSFER`, `r:${KS}`, acct, { decimal: pco.toFixed(1) })] },
        { kp: K.deviceB, caps: (wc) => [wc(`${T}.TRANSFER`, `r:${KS}`, acct, { decimal: pco.toFixed(1) })] },
      ],
      data: { pg: { keys: [pub], pred: 'keys-all' } }, gasLimit: 4000,
    });
  }
  console.log(`${acct.slice(0, 16)}…  KDA: ${await localCall(`(coin.get-balance "${acct}")`, HUB).catch(() => 0)}  PCO: ${await localCall(`(${T}.get-balance "${acct}")`, HUB).catch(() => 0)}`);
}

main().catch((e) => { console.error('FUND FAILED:', e.message ?? e); process.exit(1); });
