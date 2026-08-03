# Event operations handbook

The complete operator reference for running the PCO event program: what to sign, with which
key, when, and what to do when something goes wrong. Program rationale lives in
[EVENT-PROGRAM.md](EVENT-PROGRAM.md); round briefs in [ROUNDS.md](ROUNDS.md); board rules in
[CONTRIBUTION-BOARD.md](CONTRIBUTION-BOARD.md); recognition process in
[BUILDER-RECOGNITION.md](BUILDER-RECOGNITION.md).

## 0. The two keys, and what each may do

| Tier | Keyset | Signs | Operations |
|---|---|---|---|
| Routine ops | ops authority in `pco.ops-auth` (either active device) | **alone** | `create-round` · `set-round-code` · `set-round-active` · `set-open` · `grant` · `grant-batch` · `create-proposal` · `admin-cancel-proposal` |
| Governance | `<ns>.pco-gov` (2-of-3 devices) | any 2 | module upgrades · mint (one-shot, done) · `sweep-pool` · reserve transfers · keyset rotation |

The governance keyset also satisfies every ops operation (fallback if the ops device is
unavailable). The reverse is never true.

**Contract-enforced bounds** (nobody can exceed these without a 2-of-3 upgrade): round amount
≤ 500 · round budget ≤ 30,000 · grant ≤ 2,000 · batch ≤ 20 distinct receivers · ops
commitments ≤ 40,000 per epoch (~day; worst case 2× across one epoch boundary; it is a rate
limit, not a solvency check — see §5).

## 1. Iron rules (violating any of these breaks something real)

1. **One `grant` or one `grant-batch` per transaction — never two, never a grant plus another
   keyset-gated call after it.** A managed-capability install made from code disables every
   later keyset check in the same transaction (platform behavior, proven in REPL and on-node).
   `sweep-pool` is likewise always the LAST keyset-gated call in its transaction.
2. **Never put a plaintext quest code in transaction code.** Compute the hash off-chain
   (`pact> (hash "the-code")`) and pass the hash. Transaction code is permanently public.
3. **A duplicate receiver ABORTS THE WHOLE BATCH** — it does not quietly pay once. The managed
   transfer-capability install identity ignores the amount, so the second install for the same
   account fails with `already installed`, and `grant-batch` is atomic: every item is rolled
   back and every device approval in that transaction is wasted. Proven by
   `tests/pco-claim.repl:506` and `tests/negatives.repl:766`. Consolidate a person's awards into
   ONE item before building the batch — the action is the same as the old wording implied, but
   the failure you are avoiding is a lost signing session, not an underpayment.
4. **Every announcement carries the round id**, and codes are never posted before their round
   opens (governance reading-quest codes exist ONLY inside the proposal body; community-call
   codes are spoken, never typed).
5. **Publish honest numbers after every round**: distinct accounts claimed, of what budget.
   Post-event baseline, never the peak.
6. Recipients provide `k:` accounts in public replies. **We never direct-message anyone.**

## 2. Cadence calendar (steady state)

| Rhythm | Op | Tier |
|---|---|---|
| Biweekly (first 90 days, then monthly) | Pact Quest round: pick Q&A → hash → `create-round` → announce with round id | ops solo |
| Monthly | Governance round: draft proposal (embed reading-code) → open from the bootstrap account → `create-round gov-YYYY-MM` (window = voting window) → announce | ops solo (proposal via bootstrap account) |
| Monthly | Awards batch: collect board merges + micro-recognitions → consolidate per receiver → ONE `grant-batch` | ops solo |
| Per event | Community call: schedule → `create-round call-YYYY-MM-DD` (48h window) → speak the code live | ops solo |
| Quarterly | Builder Recognition: publish criteria + window → judge from public evidence → grants (≤ 2,000 each) in one batch → announcement with reasons | ops solo (sizes within bounds) |
| After every round close | Honest-numbers post; verify `get-round` claimed vs budget | none (reads) |

## 3. Op recipes (the exact commands)

All from `ops/` with the network env set deliberately (`PCO_NETWORK=mainnet01
PCO_HOST=https://api.chainweb-community.org` for mainnet; defaults target the local devnet).
Files are emitted to `out/<networkId>/`; the submit tool refuses cross-network files.

**Create a round** (example: quest round, 100 × 2,500, two weeks):
```
pact> (hash "the-normalized-answer")            # off-chain, never in tx code
PCO_ROUND_ID=quest-3 PCO_CODE_HASH=<hash> \
PCO_OPENS=2026-09-01T16:00:00Z PCO_CLOSES=2026-09-15T16:00:00Z \
  npx tsx src/build-tx.ts create-round
# sign the emitted file's hash on the ops device (ledger-signer, hash mode, path .../0/0)
npx tsx src/submit.ts out/<net>/51-create-round-quest-3-c0.json \
  --sig <opsPub>=<sigHex> --sign-with <gasSoftkeySecret> --send
# verify: (get-round "quest-3") shows the row; announce WITH the round id
```

**Rotate a round's code** (compromised/mistyped): build a tx with
`(<ns>.pco-claim.set-round-code "<id>" "<new-hash>")` (ops solo). **Pause a round**:
`(set-round-active "<id>" false)`. Both are ordinary ops-solo txs; no grant in the same tx.

**Monthly batch**: `npx tsx src/build-tx.ts grant-batch` — the purpose-built step. Do NOT
hand-edit the single-grant template into a batch: that template carries the gas limit
measured for ONE grant, and a full batch needs several times it, so the transaction fails
after it has been signed on the device. Consolidate each receiver to a single item
(≤ 20 items, each receiver once, each ≤ 2,000), then sign ops-solo and submit. The public
reason of every item is what the community sees — write them for the announcement.

**Master kill switch** (incident): `(set-open false)` — ops solo, or any 2 gov devices via the
fallback. Claims stop network-wide; rounds keep their windows; grants still work.

## 4. Monitoring (all free `/local` reads)

- `(pco-claim.ops-epoch-spent)` — today's committed budget+grants vs the 40,000 cap.
- `(pco-claim.pool-balance)` and per-round `(get-round "<id>")` claimed-vs-budget.
- `(pco-gas-station.epoch-spent)` — sponsored-gas meter vs 0.5 KDA/day (~833 ops).
- Station float: `(coin.get-balance "<station-account>")` — top up around 1 KDA remaining.
- Events (`CLAIMED`/`AWARDED`/`ROUND-*`) are the public audit trail — the honest-numbers posts
  read straight from them.

## 5. Failure playbook

| Symptom | What it is | Response |
|---|---|---|
| Sponsored claims fail "epoch cap reached" | The day's ~833 sponsored ops are spent (spam or a genuinely big day) | Nothing is broken: self-heals next epoch. Tell claimants: retry tomorrow or pay own gas (fractions of a cent). Persistent grief: consider a temporary cap raise (contract upgrade — gov). |
| "ops daily cap reached" on create-round/grant | The 40,000/epoch commitment meter | Wait for the epoch roll (next day) or split the batch. The genesis round + slack fits one epoch by design. |
| Wrong quest answer chosen / code leaked early | Round gate is wrong | `set-round-code` with a corrected hash (announce the correction), or `set-round-active false` and open a replacement round. Never re-use a code. |
| Round budget "exhausted" complaints | The design working | Say so, with the numbers. Budgets are the fairness bound. |
| Late claims fail "insufficient funds" though the round shows budget | Rounds collectively over-committed the pool (meter is a rate limit, not solvency) | Check `pool-balance` vs open budgets BEFORE creating rounds; if hit: pause the round, publish the honest state. |
| A grant went to the wrong account | Grants are irreversible transfers | Publish the mistake in the same channel as the award. There is no clawback — this is why per-grant bounds are small. |
| Ops device lost/compromised | Nothing is stranded: governance always satisfies OPS | **Recovery is instant and upgrade-free.** Any governance pair calls `pco.set-ops-guard` with a new authority — including a pair that EXCLUDES the lost/compromised device, which cannot block or reverse it. One call re-points the routine tier for BOTH `pco` and `pco-claim`. Works on any chain, and still works after `FROZEN-MODULE` (the setter is gated on the community keyset alone, deliberately not on the freeze flag). Compromise drill: `set-open false` (gov) → review ROUND-*/AWARDED events → `set-ops-guard` to a fresh authority → reopen. The ops authority can NEVER re-point itself. |
| Suspicious claim pattern / vote-weight clustering | Sybil accrual (expected at the margins) | Don't panic-close. Publish the observation (distinct-account turnout vs weight); advisory results are read by humans — that IS the control. |
| Station float empty | Sponsorship paused until refilled | `npx tsx src/build-tx.ts fund-station` (gas softkey, `PCO_STATION_ACCOUNT` + `PCO_STATION_FLOAT`). Users can self-pay in the meantime (a fraction of a cent). Watch it with `npm run station-status` on a schedule — it exits nonzero below 1 KDA. |
| A governance device is lost | 2-of-3 still signs with the other two; margin gone | Rotate the keyset to a fresh third device (`build-tx.ts rotate`, ×20, A+B sign). Pink is the break-glass third — if it must sign, it runs its untouched app on a trusted host (RUNBOOK §D). Do this promptly: a second loss would strand governance. |
| API host down | Reads/claims fail network-wide | Point the claim page + tooling at the fallback host (`chainweb.eckowallet.com`, same cut) and redeploy the page CFG; both hosts are verified. Chainweb itself keeps running. |
| **FULL STOP** (anything looks wrong) | Need to halt everything fast | 1) `build-tx.ts set-open` `PCO_OPEN=false` (ops solo, 1 device) — all claims stop instantly, rounds keep their windows. 2) If the station is the concern, `build-tx.ts withdraw` the float (gov pair) so nothing more is sponsored. Grants and governance are separately gated and unaffected. Governance can then investigate, rotate, and reopen. |

## 6. Governance rounds — the bootstrap account

The monthly proposal is opened by a small, publicly disclosed bootstrap account (seeded 1,000
PCO from the reserve at launch). Standing policy: **it proposes, it never votes**. The
reading-quest code is embedded in the proposal body at creation; the round
(`gov-YYYY-MM`) opens with the proposal window. Results are announced as distinct-account
turnout AND weight.

## 7. What never happens

No referral rewards, no pay-per-post, no pay-per-vote, no chance-based draws, no rewarded open
bug-intake, no DM'd links, no value talk. If an idea needs one of these, it is out — the
program document explains why, with the receipts.
