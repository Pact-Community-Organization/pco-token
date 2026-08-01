// preflight.ts — /local a BUILT but UNSIGNED ceremony transaction against the
// target network. Read-only: nothing is submitted, no signature is spent.
//
// WHY IT EXISTS. submit.ts preflights too, but it (correctly) refuses a file with
// unfilled signature slots — so its preflight only happens AFTER every device
// approval is spent. For a transaction shape that has never run on a chain, that
// is the wrong order: a bad gas limit or a failing call would be discovered after
// 40 blind approvals rather than before the first one.
//
// Used 2026-07-31 to validate the merged namespace+keyset step (cold audit C1),
// which no devnet run covers: rehearse.ts does not exercise build-tx at all, and
// devnet has its own `ns` module rather than mainnet01's. All 20 chains returned
// success at gas 346 against a 4500 limit before any device was touched.
//
// Usage:  npx tsx src/preflight.ts out/mainnet01/10-namespace-keyset-c0.json
import { readFileSync } from 'node:fs';
import { createClient } from '@kadena/client';
const HOST = process.env.PCO_HOST ?? 'https://api.chainweb-community.org';
const client = createClient(({ chainId, networkId }) => `${HOST}/chainweb/0.0/${networkId}/chain/${chainId}/pact`);
const f = process.argv[2];
const tx = JSON.parse(readFileSync(f, 'utf8'));
const cmd = JSON.parse(tx.cmd);
console.log(`  chain ${cmd.meta.chainId}  gasLimit ${cmd.meta.gasLimit}`);
console.log(`  code: ${cmd.payload.exec.code.slice(0, 150)}…`);
const r: any = await client.local({ ...tx, sigs: [] } as any, { preflight: true, signatureVerification: false });
console.log(`  RESULT: ${r.result.status}`);
if (r.result.status === 'success') {
  console.log(`  gas used: ${r.gas}  (limit ${cmd.meta.gasLimit}, headroom ${(cmd.meta.gasLimit / r.gas).toFixed(1)}x)`);
  console.log(`  data: ${JSON.stringify(r.result.data).slice(0, 200)}`);
} else {
  console.log(`  ERROR: ${JSON.stringify(r.result.error).slice(0, 400)}`);
}
