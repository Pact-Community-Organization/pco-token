// event-ops.ts — run the community EVENT PROGRAM against devnet.
//
// The mainnet path for every one of these is the ceremony: `build-tx.ts <step>`
// emits an UNSIGNED transaction, a device signs it, `submit.ts` sends it. That
// path is deliberately slow and reviewable. On DEVNET the ops authority is a
// softkey, so this tool signs and submits directly — same contract calls, same
// bounds, same on-chain events — to rehearse the program itself rather than the
// signing ceremony.
//
//   npm run events -- status
//   npm run events -- round  <round-id> <plaintext-code> [amount] [budget] [days]
//   npm run events -- code   <round-id> <new-plaintext-code>
//   npm run events -- pause  <round-id> true|false
//   npm run events -- grant  <k:account> <amount> <public reason…>
//   npm run events -- batch  <path-to-json>      # [{account,amount,reason}, …] max 20
//
// The quest CODE is passed in plaintext here and hashed LOCALLY: only the hash
// is ever put on chain, so the plaintext never enters transaction code (house
// rule). The hash is byte-identical to Pact's own `(hash "…")` — verified.
//
// DEVNET ONLY by construction: it signs with ops/out/rehearsal-keys.json.
import { readFileSync } from 'node:fs';
import { hash } from '@kadena/cryptography-utils';
import { send, localCall, HUB, NS, SENDER00, type Keypair, type SignerSpec } from './env.js';

const C = `${NS}.pco-claim`;
const T = `${NS}.pco`;
const OPS_EPOCH_CAP = 40000;

const keys = JSON.parse(
  readFileSync(new URL('../out/rehearsal-keys.json', import.meta.url), 'utf8'),
) as Record<string, Keypair>;
// the devnet ops authority is keys-any over devices A+B, so either signs alone
const OPS = keys.deviceA;
// the ops device holds no KDA on devnet: the genesis faucet pays gas, the ops
// key contributes only the OPS capability
const signers = (): SignerSpec[] => [
  { kp: SENDER00, caps: (wc) => [wc('coin.GAS')] },
  { kp: OPS, caps: (wc) => [wc(`${C}.OPS`)] },
];

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

async function meterLeft(): Promise<number> {
  return OPS_EPOCH_CAP - Number(await localCall(`(${C}.ops-epoch-spent)`, HUB));
}

// Every ops outflow is charged against the daily meter AT COMMITMENT TIME, not
// as it is spent: create-round bills its WHOLE budget the moment it opens. Fail
// here with the real headroom rather than letting it abort on-chain.
async function requireBudget(need: number, what: string) {
  const left = await meterLeft();
  if (need > left) {
    throw new Error(
      `${what} needs ${need} PCO but only ${left} is left on this epoch's ops meter ` +
      `(cap ${OPS_EPOCH_CAP}/epoch, charged at commitment). Use a smaller budget or ` +
      `wait for the epoch to roll.`,
    );
  }
}

async function status() {
  const left = await meterLeft();
  console.log(`pool           : ${await localCall(`(${C}.pool-balance)`, HUB)} PCO`);
  console.log(`claims open    : ${await localCall(`(at 'open (${C}.get-config))`, HUB)}`);
  console.log(`ops meter      : ${OPS_EPOCH_CAP - left} / ${OPS_EPOCH_CAP} committed — ${left} left this epoch`);
  console.log(`rounds         : ${JSON.stringify(await localCall(`(${C}.round-ids)`, HUB))}`);
  console.log(`open questions : ${JSON.stringify(await localCall(`(${T}.open-ids)`, HUB))}`);
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2);

  switch (cmd) {
    case 'status':
      await status();
      return;

    case 'round': {
      const [rid, code, amount = '100', budget = '500', days = '30'] = a;
      if (!rid || !code) throw new Error('usage: round <round-id> <plaintext-code> [amount] [budget] [days]');
      const exists = await localCall(`(${C}.get-round "${rid}")`, HUB).then(() => true).catch(() => false);
      if (exists) throw new Error(`round "${rid}" already exists — round ids are permanent (no row deletion in Pact). Pick a new id.`);
      await requireBudget(Number(budget), `round "${rid}"`);
      const h = hash(code);
      await send({
        label: `create-round ${rid}`, chainId: HUB,
        // opens a minute in the past: the window is [opens, closes) against the
        // PARENT block's timestamp, so "now" can read as slightly behind
        code: `(${C}.create-round "${rid}" "${h}" ${Number(amount).toFixed(1)} ${Number(budget).toFixed(1)} `
            + `(time "${iso(Date.now() - 60_000)}") (time "${iso(Date.now() + Number(days) * 86_400_000)}"))`,
        signers: signers(), gasLimit: 3000, gasPrice: 1e-7,
      });
      console.log(`round "${rid}" is OPEN — ${amount} PCO per claim, budget ${budget}, ${days} days`);
      console.log(`  answer  : "${code}"   (publish this with the round id)`);
      console.log(`  on-chain: ${h}        (only the hash is stored)`);
      break;
    }

    case 'code': {
      const [rid, code] = a;
      if (!rid || !code) throw new Error('usage: code <round-id> <new-plaintext-code>');
      await send({
        label: `set-round-code ${rid}`, chainId: HUB,
        code: `(${C}.set-round-code "${rid}" "${hash(code)}")`,
        signers: signers(), gasLimit: 2500, gasPrice: 1e-7,
      });
      console.log(`round "${rid}" now answers to "${code}" (the budget is NOT re-charged — the meter bills at creation)`);
      break;
    }

    case 'pause': {
      const [rid, active = 'false'] = a;
      if (!rid) throw new Error('usage: pause <round-id> true|false');
      await send({
        label: `set-round-active ${rid} ${active}`, chainId: HUB,
        code: `(${C}.set-round-active "${rid}" ${active === 'true'})`,
        signers: signers(), gasLimit: 2500, gasPrice: 1e-7,
      });
      console.log(`round "${rid}" active=${active}`
        + (active === 'true' ? ' (reopening only works INSIDE the window — closes is absolute)' : ''));
      break;
    }

    case 'grant': {
      const [to, amount, ...reason] = a;
      if (!to?.startsWith('k:') || !amount) throw new Error('usage: grant <k:account> <amount> <public reason…>');
      const why = reason.join(' ') || 'contribution recognition';
      await requireBudget(Number(amount), 'grant');
      await send({
        label: `grant ${amount} -> ${to}`, chainId: HUB,
        // ONE grant per transaction: an in-code managed-cap install poisons every
        // later keyset check in the same tx. Use `batch` for several awards.
        code: `(${C}.grant "${to}" (read-keyset 'g) ${Number(amount).toFixed(1)} "${why.replace(/"/g, "'")}")`,
        data: { g: { keys: [to.slice(2)], pred: 'keys-all' } },
        signers: signers(), gasLimit: 6000, gasPrice: 1e-7,
      });
      console.log(`granted ${amount} PCO to ${to}`);
      console.log(`  reason published on-chain in the AWARDED event: "${why}"`);
      console.log(`  recipient now holds: ${await localCall(`(${T}.get-balance "${to}")`, HUB)} PCO`);
      break;
    }

    case 'batch': {
      const items = JSON.parse(readFileSync(a[0], 'utf8')) as
        { account: string; amount: number | string; reason: string }[];
      if (!items.length || items.length > 20) throw new Error('batch takes 1..20 DISTINCT receivers');
      if (new Set(items.map((i) => i.account)).size !== items.length) {
        throw new Error('duplicate receiver in the batch — the managed-cap install identity ignores the amount, so the second one fails');
      }
      const total = items.reduce((s, i) => s + Number(i.amount), 0);
      await requireBudget(total, `batch of ${items.length}`);
      const data: Record<string, unknown> = {};
      const code = items.map((it, i) => {
        data[`g${i}`] = { keys: [it.account.slice(2)], pred: 'keys-all' };
        return `{ "account": "${it.account}", "guard": (read-keyset 'g${i}), `
             + `"amount": ${Number(it.amount).toFixed(1)}, "reason": "${String(it.reason).replace(/"/g, "'")}" }`;
      }).join(' ');
      await send({
        label: `grant-batch x${items.length}`, chainId: HUB,
        code: `(${C}.grant-batch [ ${code} ])`, data,
        signers: signers(), gasLimit: 12000, gasPrice: 1e-7,
      });
      console.log(`batch of ${items.length} paid under ONE ops signature — ${total} PCO total`);
      for (const it of items) {
        console.log(`  ${it.account.slice(0, 18)}… now holds ${await localCall(`(${T}.get-balance "${it.account}")`, HUB)} PCO`);
      }
      break;
    }

    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n')
        .filter((l) => l.startsWith('//')).slice(0, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(cmd ? 2 : 0);
  }

  console.log('');
  await status();
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
