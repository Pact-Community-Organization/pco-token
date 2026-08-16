# Governance design: admin-authored ranked-choice questions

*Why proposals work the way they do, what attack this prevents, and what was
considered instead.*

## The model (v1)

- **Questions are put on-chain by the organization** (the routine-ops key; the
  2-of-3 governance keyset always works too). Each question carries **2–5 named
  options**, opens **at least 12 hours after it is authored**, and runs for **at
  least 24 hours and at most 30 days**. The community **suggests questions on the
  public channels** (Telegram / X) and the organization makes them official — an
  accountable, public step.
- **A question is published to all 20 chains** and holders vote on whichever
  chains hold their tokens; the 20 tallies are summed off-chain into one result
  (the chain-local voting design). Claims stay on the hub chain.
- **Voting is open to every holder and ranked-choice**: you rank the options in
  order of preference (partial rankings allowed). Tallies are live **Borda
  scores** — with K options, your first choice earns K points per token of
  weight, your second K−1, and so on. Scores update incrementally on every
  vote, re-vote, and balance change, so the standings are always current and
  gas-bounded; instant-runoff can additionally be recomputed off-chain from the
  public ballots at any time.
- **The published result is head-to-head, not the points.** For every pair of
  options the contract records how much voting weight prefers one to the other;
  the winner is the option that beats every other one, and if none does that is
  published as a split rather than resolved by an arbitrary rule.

  This replaced a pure Borda tally in July 2026, after measurement showed the
  points rule penalised honesty. Under it, truncating a ballot was *strictly
  dominant*: a bullet vote gave a voter's favourite a margin of `w*K` over its
  strongest rival while a full sincere ranking gave `w*1`, and across 4,000
  random score boards the profit-maximising ballot was `[favourite]` 100% of the
  time. Holding preferences fixed and varying only how much voters filled in
  flipped the published leader in 32% (K=3) to 54% (K=5) of simulated
  electorates, and the score total moved 2-3x, so no two questions were
  comparable. The defect was realised on our own devnet with no adversary at
  all: one question published `oracle 500, marketplace 480` while marketplace
  beat oracle head-to-head 160-100 *and* beat the third option 160-100.

  A pairwise cell has no such lever. A ballot that ranks an option first credits
  that option's duel against every other, ranked or not, so `[A]` and
  `[A,B,C]` produce identical A-vs-B and A-vs-C records — only the B-vs-C cell
  moves. Ranking more options can therefore never hurt your favourite, which is
  the exact inverse of the old incentive. Full analysis and the rejected
  alternatives (force a full ranking, normalise the residual, approval, single
  choice, instant-runoff) are recorded in the decision document.

  The Borda points row is retained and still published, but explicitly as a
  **ballot-completeness diagnostic**: compare the total against
  `turnout * K(K+1)/2` to see how much of the electorate ranked fully. It is not
  the verdict.
- The **live-weight discipline is unchanged**: your ballot's weight is your
  current balance **on the chain you vote from**; moving tokens away
  automatically shrinks your open ballots; received tokens arrive unvoted;
  re-voting replaces your ballot in place. Votes remain **advisory** — they
  execute nothing on-chain.
- The organization can **cancel a question early** (`admin-cancel-proposal`)
  with a **mandatory public reason** emitted on-chain — freezing the scores and
  freeing the slot, accountably. **Only before voting opens.** Once a question is
  running it cannot be cancelled by anyone, which is deliberate: results are
  readable throughout, so a cancel that reached past the start would let the
  organization watch each chain's tally and void the ones going the wrong way.
  The 30-day maximum window is what bounds the cost of that strictness.

## The risk that shaped this design

The natural first design — *anyone holding a threshold (e.g. 0.1% of supply)
may open a proposal* — has a structural weakness when combined with the small
global cap on open proposals (3 slots, which bounds the vote-release work added
to every transfer):

> **Slot-squatting.** The threshold is checked at creation only, so one
> threshold-sized bankroll can hop between fresh accounts and open a proposal
> from each, filling all 3 slots. A script that re-fills every freed slot makes
> the lockout permanent — for roughly the cost of gas — and no one else can
> ever put a question on-chain.

We analysed the defenses in depth (including against what production systems
do — Compound/OpenZeppelin Governor thresholds, Cosmos deposit burning,
Polkadot's cancel/kill split):

1. **Locking the threshold stake** in the proposer's account until 24h after
   the proposal closes (so a freed slot belongs to everyone else for a day
   before the same stake can return) raises the cost of a permanent squat to
   multiple stakes *locked continuously* — but a well-funded attacker simply
   rotates additional stakes through fresh accounts.
2. That forces an **administrative backstop** — cancelling squatted proposals
   and ultimately **seizing** squatting stakes into the community reserve.
   Seizure is defensible for a deliberately valueless, earned-only token; it is
   a confiscation power no template intended for tokens *with market value*
   should ship as a default.

The conclusion: **once the defense of open proposing structurally requires
admin intervention, the "no admin involvement" premise is already gone.** v1
therefore takes honest, explicit control of question *authorship* — while
keeping the two things that matter to holders genuinely permissionless:
**voting** (ranked, live-weighted, open to everyone) and **suggesting**
questions in public, where refusing good suggestions is visible and costly for
the organization's credibility.

## What this trades away, honestly

- Holders cannot force a question on-chain. Agenda-setting is the
  organization's, with the public suggestion channel as the accountability
  mechanism. For an advisory system whose execution was always off-chain, this
  changes less than it appears — but it is a real reduction in holder power,
  and we say so plainly.
- The open-proposing design (threshold stake locked until close + 24h, one
  proposal per account, admin cancel, and — for valueless tokens only —
  seizure) is **fully built and preserved** with complete test coverage, and is
  the planned basis for a **future community-proposing version** once the
  community and the tooling mature.


## The ops tier: governance-owned, always recoverable

Routine operations (opening claim rounds, rotating quest codes, judged grants,
and putting governance questions on-chain) sit on a lower tier than the 2-of-3
governance keyset, so day-to-day work needs one signature rather than two.

That tier is **not a keyset**. It is a guard held in module state and named by
governance (`pco.set-ops-guard`), for a specific reason: Pact keyset
*redefinition* is authorized by the keyset **itself**. Had we used a named
`pco-ops` keyset, then

- a **compromised** ops device could re-point that keyset to the attacker's own
  key, beyond governance's reach; and
- a **lost** ops device could never be replaced at all,

and in both cases the only remedy would be a module upgrade across 20 chains —
impossible once the module is frozen. Holding the authority as governance-owned
state inverts that:

- **The ops authority can never change itself.** Only the community keyset can.
- **Any governance quorum can replace it**, including one that excludes a lost
  or compromised device — that device cannot block or reverse it.
- **One call covers both modules**: `pco-claim` reads `pco.ops-guard`.
- **Recovery survives a freeze.** The setter is gated on the community keyset
  alone and deliberately *not* on `FROZEN-MODULE`, so who-operates stays
  changeable even after the code is frozen forever. This is a disclosed
  governance power: it names the operator, and moves no funds.
- Before governance names anyone, the tier **defaults to the governance
  keyset** — a fresh deployment is operable immediately, and there is no
  undefined-keyset failure mode to leave on some chain.

In production the authority is **1-of-2 over the two active devices**, so
losing one device does not halt operations; the third (break-glass) seat stays
out of the routine tier deliberately.

## Notes for template users

This module doubles as a reference for other Kadena projects. If you deploy a
variant for a token that is **sold or has market value**: keep in mind that the
admin here can author and cancel questions (cancel freezes scores and frees a
slot). It does not move *holder* funds — but be precise about what that does
and does not mean: the same tier can grant tokens out of the undistributed
claim pool, and those tokens can then vote. Governance influence over an
advisory tally is therefore bounded by the pool and the ops meter, not by the
proposal mechanism, and that remains true after a module freeze. If you re-enable open
proposing, use the preserved stake-lock design, and do **not** ship stake
seizure for a valuable token — it is a confiscation power that only makes
sense where tokens are free and earned.
