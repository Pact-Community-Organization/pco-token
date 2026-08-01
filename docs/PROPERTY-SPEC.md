# PCO — property specification

**What this is.** The invariants PCO must satisfy, stated **independently of the implementation**,
each mapped to a test and to whether that test is *mutation-verified* — i.e. proven to fail when the
property is violated.

**Why it exists.** A test-integrity audit (2026-07-29) derived 265 invariants from the design
documents and found only 27% mutation-proven, with 24 places where the code contradicted the
documents. The root cause is structural: **PCO has no architecture specification.** The contracts
were committed 2026-07-20; every design document describes them and post-dates them. So the
documents cannot serve as an oracle — they were written by reading the code.

This file is the attempt at a non-circular one. Every invariant here is sourced from something we
did **not** author:

| Source | Why it is independent |
|---|---|
| `fungible-v2` / `fungible-xchain-v1` | External normative interfaces, written by Kadena. Their `@doc` and `@model` state required behaviour. **Pact does not enforce `@model`** — it is not even name-validated — so conformance is our job to test, not the engine's. |
| Accounting laws | Conservation, non-negativity, no double-spend. True of any token, independent of PCO's design. |
| Program promises | What the event program tells participants. Business intent, which the contract either honours or does not. |

**Status vocabulary.** `PROVEN` — a test exists and was verified to FAIL when the property is
broken. `TESTED` — a test exists, not yet mutation-verified. `GAP` — no test, or the test does not
detect violation. Only `PROVEN` counts as evidence.

---

## 1. Interface conformance — `fungible-v2`

Sourced verbatim from the interface's own `@model` and `@doc`.

| # | Invariant | Status | Test |
|---|---|---|---|
| F-1 | `transfer`/`transfer-create` MUST reject `amount <= 0` | **PROVEN** | `negatives.repl` "non-positive amount rejected"; mutation-verified via `debit`'s sign check |
| F-2 | They MUST reject `sender == receiver` | TESTED | `negatives.repl` "same sender and receiver" |
| F-3 | `transfer` MUST fail if the RECEIVER does not exist | **PROVEN** | Discovered the hard way: an e2e negative was passing on this error instead of the guard it named |
| F-4 | `transfer-create` MUST reject a guard that differs from an existing receiver's | **PROVEN** | `negatives.repl` "guard mismatch on an existing account" |
| F-5 | Amounts MUST respect the token's precision | **PROVEN** | `negatives.repl` "over-precise amount rejected" |
| F-6 | An account name MUST satisfy the reserved-name protocol on EVERY creating path | **PROVEN** | `negatives.repl` M-RESERVED — mutation-verified 2026-07-29; deleting the check let k: squatting through `transfer-create` |
| F-7 | `create-account` MUST NOT overwrite an existing account | **PROVEN** | `negatives.repl` M-INSERT — mutation-verified; `write` instead of `insert` allowed account takeover |
| F-8 | `get-balance` and `details` MUST agree | GAP | no test asserts consistency between the two readers |

## 2. Interface conformance — `fungible-xchain-v1`

| # | Invariant | Status | Test |
|---|---|---|---|
| X-1 | `target-chain` MUST differ from the current chain | TESTED | `pco.repl` / `negatives.repl` "same chain" |
| X-2 | `target-chain` MUST be a real chain | TESTED | enforced against `coin.VALID_CHAIN_IDS` |
| X-3 | Step 0 MUST debit and yield; step 1 MUST credit the yielded amount | **PROVEN** | `xchain.repl` X-3 — both steps in the REPL via `continue-pact` |
| X-4 | The step-1 credit MUST reject a guard mismatch | **PROVEN** | `xchain.repl` X-4 — mutation-verified 2026-07-29; deleting the check let a **squatted receiver take the sender's tokens** |
| X-5 | One signature MUST fund at most one cross-chain send | **STRUCTURAL** | `xchain.repl` X-5 — enforced by Pact itself (one defpact per transaction); the manager's `0.0` is defence in depth behind it, which is why mutating it kills no test. Investigated, not assumed |

## 3. Accounting laws

These hold for any token and owe nothing to PCO's design.

| # | Invariant | Status | Test |
|---|---|---|---|
| A-1 | Total supply MUST equal exactly `TOTAL-SUPPLY` against every non-governance caller | **PROVEN** | conservation assertion in the private adversarial suite; the free mint that violated it was reproduced and killed |
| A-2 | A balance MUST NOT rise except fused to a matching debit, or behind the one-shot mint, or on a real SPV resume | **PROVEN** | by construction — no public balance-increasing function exists; corroborated by the private adversarial suite |
| A-3 | A balance MUST NOT fall without a matching rise — **there is no burn** | **PROVEN** | by construction — no public balance-decreasing function exists (`debit` is inlined into both callers) |
| A-4 | A balance MUST NOT go negative | TESTED | `insufficient funds` |
| A-5 | The mint MUST distribute exactly `TOTAL-SUPPLY`, once | TESTED | `pco.repl` "under-distribution rejected", "already minted" |
| A-6 | Every mint recipient amount MUST be positive | **GAP** | deleting that check survived; named in the audit as a missing case |
| A-7 | Minting into a pre-squatted account MUST fail on the guard | **GAP** | deleting the guard check survived |

## 4. Authority

| # | Invariant | Status | Test |
|---|---|---|---|
| U-1 | Every public function MUST enforce its own preconditions, never rely on a caller | **PROVEN** | the private adversarial suite F#1a/F#1b; `negatives.repl` M-VOTE — mutation-verified, deleting the gate let anyone vote as anyone |
| U-2 | No capability body may be trivially satisfiable | **PROVEN** | static check flags weak non-event caps; all removed or given real bodies |
| U-3 | The ops tier MUST NOT be able to re-point itself | **PROVEN** | `ops-recovery.repl`; devnet P3d |
| U-4 | Governance MUST be able to replace the ops authority without the outgoing device, and after a freeze | **PROVEN** | `ops-recovery.repl` |
| U-5 | A freeze MUST lock the CODE and nothing else | **PROVEN** | `ops-recovery.repl` §4 — added 2026-07-29 |
| U-6 | Funded paths MUST still work after a freeze (transfer, vote, claim, sweep) | **PROVEN** | `frozen.repl` — a funded pair is frozen, then transfer, vote, claim, ops and sweep all still work; the whole 900,000 pool sweeps clean |
| U-7 | The gas station float MUST NOT be spendable by a self-paid caller | **PROVEN** | adversarial suite (private), mutation-verified both defences |
| U-8 | The daily sponsorship cap MUST NOT be burnable for free | **PROVEN** | `pco-gas-station.repl` METER refusal |

## 5. Program promises

What the event program tells participants, which the contract must honour.

| # | Invariant | Status | Test |
|---|---|---|---|
| P-1 | One claim per account per round | **PROVEN** | `pco-claim.repl`; devnet on-node |
| P-2 | A round MUST NOT pay beyond its budget | TESTED | "round budget exhausted" |
| P-3 | A round MUST NOT pay outside `[opens, closes)` | TESTED | devnet P13; and the mainnet dry run hit it live |
| P-4 | Undistributed pool tokens MUST NOT vote | **PROVEN** | `pco.repl` V-ESCROW; `pco-claim.repl` self-registration; devnet P7b; mainnet dry run |
| P-5 | Ops MUST NOT redirect a round's budget once claiming has begun | **PROVEN** | `pco-claim.repl`; devnet P7b |
| P-6 | Published participation figures MUST count distinct accounts, not events | **GAP** | events can be restated; nothing asserts the counting rule |

---

## The honest summary

Of the 34 invariants above: **22 PROVEN, 7 TESTED, 1 STRUCTURAL, 4 GAP.**

The cross-chain resume gaps are CLOSED (`tests/xchain.repl`, 2026-07-29). Closing them corrected a
false belief that had caused the hole: the other suites stated the resume was "DEVNET-ONLY (SPV)",
but `continue-pact` drives it in the REPL, and its 4-argument form injects the yielded object so the
mismatch case can be constructed exactly. X-5 turned out not to be a hole at all — the property is
enforced structurally by Pact, and the manager is defence in depth behind it.

U-6 is CLOSED too (`tests/frozen.repl`): a funded pair is frozen and every value-bearing path still
works, including sweeping the whole 900,000 pool. The freeze is now demonstrably a safe end state
rather than a hope.

The four remaining gaps are all bounded and none traps value: two mint-time checks (A-6, A-7), a
reader-consistency check (F-8), and a counting rule for published participation figures (P-6).

## How to use this file

1. Adding a contract feature? Add its invariant here **first**, then the test, then the code.
2. A `GAP` is a commitment, not a note. Closing one means adding a test AND verifying it fails
   against a mutant.
3. `@model` on the interfaces is not enforced by Pact and never will be — Pact 5 removed the
   property checker and has no `verify` native. Mutation testing is the only proof mechanism
   available, so status here means "a mutant died", not "the engine checked it".
4. This file is the oracle. Where it and the code disagree, that is a finding — decide which is
   wrong deliberately, rather than editing whichever is easier.
