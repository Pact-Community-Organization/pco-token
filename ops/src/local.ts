// local.ts — run a read-only /local call and print the result. The executor
// the RUNBOOK verification battery + the namespace-derivation preflight use.
// Usage:  PCO_NS=user npx tsx src/local.ts '(user.pco-claim.pool-balance)' [chain|all] ['<env-data json>']
// env-data is what makes the namespace preflight runnable:
//   npx tsx src/local.ts "(ns.create-principal-namespace (read-keyset 'pco-gov))" 0 '{"pco-gov":{...}}'
import { CHAINS, HUB, localCall } from './env.js';
const code = process.argv[2];
if (!code) { console.error("usage: local.ts '<pact code>' [chainId|all] ['<env-data json>']  (default: hub chain 0)"); process.exit(2); }
const where = process.argv[3];
let data: Record<string, any> | undefined;
if (process.argv[4]) {
  try { data = JSON.parse(process.argv[4]); }
  catch (e: any) { console.error(`env-data is not valid JSON: ${e.message}`); process.exit(2); }
}
const chains = where === 'all' ? CHAINS : [where ?? HUB];
for (const ch of chains) {
  try { console.log(`c${ch}: ${JSON.stringify(await localCall(code, ch, data))}`); }
  catch (e: any) { console.log(`c${ch}: ERROR ${String(e.message).slice(0, 120)}`); process.exitCode = 1; }
}
