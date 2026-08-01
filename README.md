# PCO Community Token

A **free, deliberately valueless community governance token** for the
[Pact Community Organization](https://pact-community.org) — and the vehicle for
PCO's first real mainnet deployment of its operational machinery (multi-device
keyset custody, principal namespace, 20-chain deploys, gasless claim onboarding, key
rotation, cross-chain transfers).

**Plain-language disclosure, up front:** PCO tokens carry **no dividends, no
revenue rights, no claim on anyone or anything, and no monetary value**. They
are never sold — claiming is free, gated only by a community quest. Votes are
**advisory signals** about PCO tooling direction; they execute nothing
on-chain. This is a community + operations experiment.

**Earning PCO** is participation recognition: answer a claim-round quest (the
question for the interface every catalog token implements is a good warm-up),
pick up a labeled issue on the contribution board, or get recognized for work
you already did for this ecosystem. The whole program — what runs, when, with
what bounds — is in [docs/events/](docs/events/EVENT-PROGRAM.md), and every
award ever made is public on-chain.

## What's here

| Path | Contents |
|---|---|
| `contracts/` | `pco` (fixed-supply fungible-v2 + fungible-xchain-v1 with advisory ranked-choice governance — admin-authored questions, holder-ranked ballots; the published result is the head-to-head/Condorcet reading, with Borda retained only as a completeness diagnostic) · `pco-claim` (claim ROUNDS — per-round quest code, fixed budget, time window, one claim per account per round — plus judged recognition grants with public on-chain reasons) · `pco-gas-station` (onboarding sponsor: the claim is gasless — nothing else) |
| `tests/` | self-contained REPL suites: per-module behaviour + a full-lifecycle run + a large `negatives.repl` (each case proves a guard or bound FAILS as expected; it is broad, not a proof of exhaustiveness — some branches are covered only by the other suites, and mutation testing rather than this file is what establishes a defence is load-bearing) + a principal-namespace rehearsal against the byte-true mainnet `ns` source + a must-fail squatting fixture — `tests/run.sh` runs everything |
| `ops/` | devnet dress-rehearsal harness (`npm run rehearse`) + mainnet ceremony tx builder |
| `web/` | claim + do-more page: gasless claim via an in-browser key (station pays); transfer/vote via a connected wallet (self-paid) |
| `docs/events/` | **how the community earns PCO**: the [event program](docs/events/EVENT-PROGRAM.md) · [claim rounds](docs/events/ROUNDS.md) · [contribution board](docs/events/CONTRIBUTION-BOARD.md) · [builder recognition](docs/events/BUILDER-RECOGNITION.md) · [operations handbook](docs/events/OPERATIONS.md) |
| `docs/GUIDE.md` | **the user guide** — claiming, wallets, transfers, voting, the dedicated voting key, rotation, verification |
| `docs/mainnet-pilot/` | PLAN, RUNBOOK, and evidence (devnet rehearsal, UX verification, audit) |

## Design notes (the short version)

- **Governance of the modules** = a 2-of-3 hardware keyset (`<ns>.pco-gov`).
  Modules are upgradeable under it until a `FROZEN-MODULE` flip — a disclosed
  property: rotating and upgrading under multi-device custody is part of what
  this token exists to exercise in public.
- **Routine claim operations** run on a separate ops authority so weekly rounds
  need one device: quest-code rotation, opening and closing rounds, the master
  switch, and **bounded judged grants out of the community pool** — at most
  2,000 PCO per grant, 20 receivers per batch, a 30,000 PCO round budget, and
  40,000 PCO of new commitments per epoch (a rate limit on new obligations, not
  a solvency check). That authority is not a named keyset but on-chain module
  state the community keyset names and can re-point at any time, so a lost or
  compromised ops device is replaced without a code change and can never replace
  itself. The 2-of-3 keyset always satisfies the ops gate too, and every
  **unbounded** token- or code-moving power (sweep, mint, upgrades, the reserve)
  stays 2-of-3. The tier rationale is documented in the `pco-claim` module doc.
- **Governance questions are admin-authored** (the community suggests them on
  the public channels; the org puts them on-chain with a public, accountable
  step) and **voting is ranked-choice**: holders rank 2-5 options, and the
  published result is **head-to-head** — for every pair the contract records how
  much weight prefers one option to the other, so how much of a ballot a voter
  fills in cannot change their favourite's duels. A Borda points row is retained
  as a ballot-completeness diagnostic, not as the verdict. Weighting is live-balance on the hub chain (chain 0)
  only: every balance decrease releases the moved weight from open ballots,
  and received tokens arrive unvoted — vote-then-move double counting is
  impossible by construction. Design rationale: docs/GOVERNANCE-DESIGN.md.
- **Claims** need no signature from the claimer (nothing of the claimer's is
  at risk; tokens can only land in the account canonically bound to the
  supplied guard) and are one-shot per account per round.
- **The gas station** exists to onboard a newcomer with zero KDA: it sponsors the
  claim. Voting and transferring are the participant's own to pay for (a normal
  wallet holding a little KDA); questions are authored by the organization, not by
  holders. The sponsorship policy is checked against the node-injected transaction
  type and code (not user-suppliable data), under price and gas-limit ceilings.
  What keeps the KDA unspendable by anyone other than the node buying gas for a
  sponsored claim is the pair of checks in `gas-payer-pred` and `ALLOW_GAS`: the
  transaction's own gas payer must BE the station, and that permission can be
  acquired only in the gas-buy phase. The daily epoch meter caps the **rate**
  (0.5 KDA per chain per day) — it bounds how fast the fund can be spent, not how
  much. Griefing with valid-shaped claims that fail is therefore bounded per day
  and self-healing at the epoch roll, but a fund left unattended for long enough
  can still be spent down to nothing; it is refilled deliberately, not
  automatically. An earlier version of this paragraph said the fund "cannot be
  drained", which was not true of the code as written.

## Running the tests

```bash
pact --version   # Pact 5.4+
tests/run.sh
```

## License

Apache-2.0, same as the PCO contract catalog this token's governance template
comes from.
