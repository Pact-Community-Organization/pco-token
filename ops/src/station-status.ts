// station-status.ts — always-on station health (epoch spend + KDA float).
// Transfer sponsorship makes burn continuous, not round-cadenced, so this is
// meant to run on a schedule. Nonzero exit + loud line when it needs attention.
// Usage:  PCO_NS=user npx tsx src/station-status.ts
//   thresholds via env: PCO_MIN_FLOAT (default 1.0 KDA), PCO_MAX_SPENT (default 0.4)
import { HUB, NS, localCall } from './env.js';
const G = `${NS}.pco-gas-station`;
const minFloat = Number(process.env.PCO_MIN_FLOAT ?? '1.0');
const maxSpent = Number(process.env.PCO_MAX_SPENT ?? '0.4');
const station = await localCall(`(${G}.station-account)`, HUB);
const spent = await localCall(`(${G}.epoch-spent)`, HUB);
const float = await localCall(`(coin.get-balance "${station}")`, HUB).catch(() => 0);
const cap = 0.5;
const warnFloat = float < minFloat, warnSpent = spent > maxSpent;
console.log(`station ${station.slice(0, 20)}…`);
console.log(`  float:  ${float} KDA ${warnFloat ? `⚠ BELOW ${minFloat} — TOP UP` : 'ok'}`);
console.log(`  epoch:  ${spent}/${cap} KDA spent today ${warnSpent ? `⚠ over ${maxSpent} — watch for grief/high load` : 'ok'}`);
if (warnFloat || warnSpent) process.exit(1);
