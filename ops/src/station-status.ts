// station-status.ts — always-on station health (epoch spend + KDA float).
// Transfer sponsorship makes burn continuous, not round-cadenced, so this is
// meant to run on a schedule. Nonzero exit + loud line when it needs attention.
// Usage:  PCO_NS=user npx tsx src/station-status.ts
//   thresholds via env: PCO_MIN_CLAIMS (default 100 sponsored tx of runway),
//   PCO_MIN_FLOAT (KDA — overrides the runway-derived default), PCO_MAX_SPENT
//   (default 0.4 KDA of one epoch's cap).
import { HUB, NS, localCall } from './env.js';
const G = `${NS}.pco-gas-station`;

// FAIL CLOSED ON A MALFORMED THRESHOLD. `Number('0.5 KDA')` is NaN, and every
// comparison against NaN is false — so a typo in one of these env vars did not
// merely loosen the alarm, it switched BOTH alarms off and exited 0. A monitor
// that goes quiet when it is misconfigured is worse than no monitor, because
// quiet is exactly what it reports when everything is fine.
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    console.error(`${name}="${raw}" is not a non-negative number — refusing to run, ` +
                  `because an unparseable threshold silently disables this alarm.`);
    process.exit(2);
  }
  return v;
}

const minClaims = envNum('PCO_MIN_CLAIMS', 100);
const maxSpent = envNum('PCO_MAX_SPENT', 0.4);

const station = await localCall(`(${G}.station-account)`, HUB);
const spent = await localCall(`(${G}.epoch-spent)`, HUB);
const float = await localCall(`(coin.get-balance "${station}")`, HUB).catch(() => 0);
// Read the ceilings from the contract instead of restating them here. `cap` used
// to be a hardcoded 0.5 in this file, which is a constant copied out of a module
// and therefore a constant that drifts.
const cap = Number(await localCall(`${G}.EPOCH-CAP`, HUB));
const perTx = Number(await localCall(`${G}.MAX-GAS-LIMIT`, HUB))
            * Number(await localCall(`${G}.MAX-GAS-PRICE`, HUB));

// THE DEFAULT THRESHOLD IS RUNWAY, NOT A KDA FIGURE. It used to default to
// 1.0 KDA — exactly the amount the station was funded with — so the alarm fired
// on the first sponsored claim and then every run afterwards, and a scheduled
// job that always exits 1 reports nothing at all. Any fixed KDA number has that
// problem at some funding level, and the float is deliberately funded small and
// topped up on demand (docs/LAUNCH-BLOCKERS.md §E), so the figure that stays
// meaningful is "how much work can the station still do".
//
// This is an OPERATIONAL top-up trigger, not a safety bound. It says nothing
// about how much the station could lose: the float is drainable and no module
// code prevents that, which is why it is sized to be losable in the first place.
const minFloat = process.env.PCO_MIN_FLOAT !== undefined && process.env.PCO_MIN_FLOAT !== ''
  ? envNum('PCO_MIN_FLOAT', 0)
  : minClaims * perTx;

const left = Math.floor(float / perTx);
const warnFloat = float < minFloat, warnSpent = spent > maxSpent;
console.log(`station ${station.slice(0, 20)}…`);
console.log(`  float:  ${float} KDA — ~${left.toLocaleString()} more sponsored tx at the contract ceiling ` +
            `(${perTx} KDA each) ` +
            // display only — the comparison above stays exact
            `${warnFloat ? `⚠ under ${Number(minFloat.toFixed(8))} KDA — TOP UP` : 'ok'}`);
console.log(`  epoch:  ${spent}/${cap} KDA spent today ${warnSpent ? `⚠ over ${maxSpent} — watch for grief/high load` : 'ok'}`);
if (warnFloat || warnSpent) process.exit(1);
