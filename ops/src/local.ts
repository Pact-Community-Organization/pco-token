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
  // DO NOT re-truncate. This used to slice at 120 chars, which cut every error off
  // mid-JSON — including the one this tool is most used for during a ceremony:
  // dry-running a built transaction's code, where reaching
  // "ops authorization failed: …" is the GREEN result and a `time` parse failure is
  // the abort. Both live past character 120, so the operator could not tell them
  // apart and had to write a throwaway script to read the message. env.ts already
  // caps the underlying error at 300 chars, so nothing here is unbounded.
  catch (e: any) { console.log(`c${ch}: ERROR ${String(e.message)}`); process.exitCode = 1; }
}
