# PCO Community Event Program

*How the community earns PCO through participation.*

PCO is a **free community governance token with no monetary value**. It is not an investment,
it is not a sale, it carries no rights to revenue or profit, and it never will. Earning PCO is
**recognition of participation** in the Pact Community Organization — nothing more. Voting with
PCO is advisory: votes signal community priorities and execute nothing.

We are a small community and we design for that honestly. An event where twenty people show up
is a good event. Everything below is sized for real numbers, published transparently, and
verifiable on-chain.

---

## 1. How earning works

There are exactly two ways PCO reaches participants from the claim pool, both public on-chain:

1. **Claim rounds** — self-serve, small, flat awards. A round opens with a published question
   (a *quest*); the answer is the claim code. Anyone can claim **once per account per round**
   while the round is open and its budget lasts. Rounds close automatically at their announced
   end time.
2. **Recognition grants** — judged, larger awards for real contributions (merged pull requests,
   documentation, tooling, past work for the ecosystem). Granted individually, each with a
   public reason attached on-chain (for code contributions, typically the pull-request link).

Every round has a **fixed budget** and every grant has a **maximum size**. These bounds are in
the contract, not just in policy — nobody, including us, can exceed them without a governance-
keyset upgrade. The full remaining pool and every award ever made are publicly readable
on-chain (`CLAIMED`, `AWARDED`, and round events). All of this describes the claim contract
that ships with the token launch — rounds, budgets, and grant bounds are readable in
`contracts/pco-claim.pact` in this repository.

**Claims are gasless.** A community gas station sponsors claim transactions, metered at a fixed
daily budget (roughly 800 sponsored operations per day). If a day's budget is ever exhausted,
claims resume the next day — or you can submit the same claim paying your own gas, a
negligible amount of KDA (on the order of 0.00002 KDA). Claim codes are engagement devices,
not secrets: once anyone claims, the
code is visible on-chain. That is fine — budgets and one-claim-per-account-per-round are what
keep rounds fair, not code secrecy.

**What we never do:** no paid referrals, no rewards for posting or replying on social media,
no rewards per vote, no chance-based giveaways (raffles/draws), no points seasons, and no
promises of future value. If you see anyone claiming PCO will be worth money, that is not us.

---

## 2. Event catalog

### Genesis Quest (launch event)
The first claim round, opening with the token launch. One question, **answerable from what we
built** — the contracts, the repository README, or the deployed modules on chain; any one of them
is enough, and finding it is the round. The answer is not printed in the announcement.
**100 PCO**, one claim per account, open ~30 days with a budget of 30,000 PCO. It exists so that
everyone who shows up at the start walks away with a voice in the community's advisory signal —
having looked at the thing they now have a voice in.

### Pact Quests (recurring claim rounds)
A rotating question whose answer lives in public Pact/Kadena community materials — the
contract catalog, the documentation, this organization's repositories. Reading the materials
IS the event. **100 PCO** per claim, budget 2,500 PCO per round — roughly every two weeks for
the first three months, then monthly (the month-3 retrospective can adjust this). If a quest
teaches one person one real thing about Pact, it did its job.

### Contribution Board (GitHub bounties)
The heart of the program, because this is a developer community. Maintainer-written issues in
the organization's repositories carry a `pco-award` label and a tier:

| Tier | Award | Example |
|---|---|---|
| Starter | 250 PCO | docs fix, example correction, small test |
| Standard | 500 PCO | a contract-catalog example, a tooling improvement |
| Substantial | 1,000 PCO | a new catalog template, a significant feature |
| Major | 2,000 PCO | pre-agreed larger work, scoped in the issue first |

Rules, learned from communities that got this right: awards attach **only to issues we
labeled** (unsolicited work is welcome but not automatically awarded); **comment to claim an
issue before working** — first claimant has it for 14 days, then it reopens; the award is
granted **when a maintainer merges/accepts**, never automatically. Monthly awards are capped
at 5,000 PCO. We do not run rewarded open bug-reporting — reports are welcome, but rewarding
raw intake drowns small teams in noise.

### Builder Recognition (retroactive grants)
Recognition for **work already done** for the Pact/Kadena community — maintaining
infrastructure, publishing tools, writing educational material — without anyone having asked.
Batches are announced with public criteria, named recipients, and public reasons; individual
grants up to 2,000 PCO. The first batch follows the launch (up to 25,000 PCO in total);
afterwards roughly quarterly, up to 10,000 PCO per batch.
Judged by named humans who put their reasoning in public. This is deliberately the opposite
of an application form: we look for the work, the work does not apply to us.

### Governance Rounds (monthly)
A real advisory proposal — what should the community prioritize, adopt, or build — opens
on-chain each month. Embedded in the proposal text is that month's reading-quest code:
claiming it (100 PCO, budget 2,500) requires actually opening and reading the proposal.
Voting is encouraged and never rewarded — we recognize informed presence, never votes.
Questions are **authored by the organisation**, not by holders. Anyone can propose a question
through the public channels and we put the good ones on-chain, but there is no on-chain
proposing right and no token threshold that grants one. Up to three questions can be active at
once, community-wide.

That is a deliberate choice, not a limitation we are working around. With only three global
slots, open proposing needs stake locks plus an admin power to cancel or seize a squatted
slot — which puts the organisation in the loop anyway, while making it look as though it is
not. We would rather hold the authorship openly and be judged on the questions we ask. The
open-proposing design is preserved for a future version.

**What that means for reading this page honestly:** the organisation chooses the questions,
so the value of the signal is in the ranking the community produces, not in who was allowed to
ask. Governance also holds most of the token supply until the pool is distributed — the
denominator is published with every result for that reason.

### Community Calls (live code drops)
Occasional live sessions (X Space or Telegram voice chat) around releases and roadmap
updates. A claim code is spoken during the call — never posted in text — with a 48-hour
claim window and a small award (50 PCO, budget 1,000). Attendance-shaped, so the
window is short and the amount is small by design.

### Community Recognition (monthly micro-grants)
A monthly published batch of small grants (25–100 PCO) for the quiet work that keeps a
community alive: answering questions in the Telegram group, triaging an issue, fixing a typo
nobody else noticed. Capped at 1,000 PCO per month. Inspired by the best precedent in this
ecosystem: tiny, continuous, human-judged recognition beats big, rare, automatic rewards.

---

## 3. First 90 days

| When | What |
|---|---|
| Launch day | Token live · claim page live · **Genesis Quest opens** (30 days) |
| Week 1 | **Contribution Board opens** with the first labeled issues · **Governance Round #1** (advisory: community priorities) + reading quest |
| Week 2 | Pact Quest #2 — the Genesis Quest counts as #1 (contract-catalog theme) |
| Week 3–4 | Builder Recognition criteria published |
| ~Day 30 | Genesis Quest closes · honest participation numbers published · **Builder Recognition batch #1** |
| Month 2 | Pact Quests continue biweekly · Governance Round #2 · first Community Call + live code · first micro-grant batch |
| Month 3 | Governance Round #3 includes a program retrospective (what to keep, drop, change) · cadence review |

After 90 days the community's own advisory votes steer the calendar.

## 4. Budgets and the pool

The claim pool holds **900,000 PCO** (90% of supply; the remaining 10% is the community
reserve). Using the cadences and caps published above, the program has a **worst-case
first-year ceiling of roughly 235,000 PCO** if every round fully claims and every cap is hit —
which would mean participation beyond anything
this ecosystem has seen, and would be a wonderful problem. Realistic first-year distribution
is a fraction of that. Either way the pool sustains **years** of events, and every number is
verifiable against the on-chain pool balance at any time.

Unclaimed round budgets never leave the pool. If the community ever winds the program down,
the remainder moves to the community reserve in a single public, governance-signed sweep.

## 5. Channels

- **pact-community.org** — canonical calendar, claim page, program updates
- **GitHub (github.com/Pact-Community-Organization)** — Contribution Board, quest source
  materials, this document
- **X (@PactCommOrg)** — announcements and round openings
- **Telegram (t.me/PactCommunityOrg)** — discussion, community calls, help with claiming

Announcements post to all four; the website is the source of truth.

## 6. Fair play

- One claim per account per round is the on-chain rule. We cannot stop one person from
  running several accounts — budgets cap what that is worth in tokens, but advisory vote
  weight does add up across accounts. That is why vote results are always published as
  **distinct-account turnout alongside weight**, read by humans who look at account
  diversity, and treated as advisory input to decisions made in the open — never as
  automatic outcomes. A "majority" made of look-alike accounts convinces nobody, and
  convincing people is the only thing an advisory vote can do.
- Round budgets and grant caps bound every event. When a budget is exhausted, the round is
  over — that is the design working, not failing.
- The daily gas-station budget is shared. If sponsorship is exhausted (rare at our size),
  claim the next day or pay your own gas.
- All awards are public. If something looks wrong — a suspicious claim pattern, an award you
  disagree with — say so, in public, in the Telegram group or a GitHub issue. Community review
  of distribution is itself participation.
- **Authenticity:** official rounds exist on-chain before they exist anywhere else — every
  announcement carries the round id, which you can verify against the claim contract's round
  table, and grants exist only as on-chain `AWARDED` events. Anything else calling itself a
  PCO round or PCO grant is not ours. We will never direct-message you a claim link.

## 7. Why this shape (design notes)

We read the record before designing this, and the record is unambiguous:

- Reward-driven engagement collapses when rewards stop — a peer-reviewed study of a production
  quest platform measured a 93.5% participation collapse after its airdrop snapshot
  ([arXiv 2501.18810](https://arxiv.org/abs/2501.18810)). So the token recognizes
  participation; it does not try to buy it.
- Retroactive recognition of real contributors is the one approach with measured positive
  contributor retention ([Open Source Observer on Optimism's Retro
  Funding](https://docs.oso.xyz/blog/impact-of-retro-funding/)), and small curated groups with
  a real job sustain extraordinary participation
  ([Optimism Citizens' House](https://gov.optimism.io/t/retropgf-rf-rounds-1-7-uncovering-the-trends-in-participation-categories-op-allocation/10208)).
  Hence Builder Recognition and judged grants.
- Automatic or open-intake rewards get farmed and spam small teams to death — npm's tea.xyz
  flood ([postmortem](https://nesbitt.io/2026/06/11/what-happened-to-tea.html)), curl ending
  its bug bounty under AI slop
  ([Daniel Stenberg](https://daniel.haxx.se/blog/2026/01/26/the-end-of-the-curl-bug-bounty/)),
  and Hacktoberfest's spam year fixed by maintainer opt-in
  ([retrospective](https://dev.to/sharkdp/retrospective-hacktoberfest-2020-k91)). Hence
  labeled-issues-only, claim-first, merge-triggered awards.
- Even valueless participation badges get farmed on speculation
  ([POAP](https://decrypt.co/83614/ethereum-badge-app-poap-is-scaling-back-to-move-forward)) —
  so fairness here rests on budgets and per-account rules, never on pretending farming cannot
  happen.
- In this ecosystem's own history, community distribution events sized in the low hundreds of
  people were the norm even at the 2021 peak
  ([KDLaunch's community airdrop had 200 recipients](https://kdlabs.medium.com/kdl-airdrop-lottery-results-5670f8cc8c3a)),
  and paying people to participate in governance did not survive even with real rewards behind
  it ([Kadena Cabinet](https://defillama.com/protocol/kadena-cabinet)). Small, honest,
  continuous recognition is what has actually worked here — so that is what we run.

---

*Everything in this program is advisory-governance and participation recognition for a free,
valueless community token. Parameters (award sizes, budgets, cadence) may be tuned by future
community decisions; bounds are enforced on-chain.*
