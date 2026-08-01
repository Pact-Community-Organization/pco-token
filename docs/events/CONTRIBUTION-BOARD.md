# Contribution Board — GitHub bounty rules & seed issues

The heart of the event program: PCO recognition for merged work in this organization's
repositories. Full program context: [EVENT-PROGRAM.md](EVENT-PROGRAM.md).

## Labels

| Label | Meaning |
|---|---|
| `pco-award` | this issue carries a PCO award (only maintainers add it) |
| `pco-250` / `pco-500` / `pco-1000` / `pco-2000` | the tier |
| `pco-claimed` | someone has claimed the issue (see rules) |

## Rules

1. **Awards attach only to issues a maintainer labeled.** Unsolicited work is welcome and may
   be merged, but it is not automatically awarded — this is what keeps the board spam-proof.
2. **Comment to claim before working.** First claimant holds the issue for **14 days**
   (maintainer adds `pco-claimed`); if nothing lands, it reopens for anyone.
3. **The award triggers on maintainer merge/acceptance** — never automatically. The on-chain
   grant carries the PR URL as its public reason.
4. **One award per issue.** Larger work (the 2,000 tier) is scoped in the issue *before* work
   starts.
5. No rewarded open bug-intake: report bugs freely, but reports are not awarded — rewarded
   raw intake drowns small teams in noise.
6. Awards land monthly in one on-chain batch (or sooner for larger items).

## Seed issues (posted at launch)

Drafts, one per line: repo · tier · title.

1. `pact-contract-catalog` · 500 · **Add a worked example: choosing a guard for an escrow
   account** — a runnable `.repl` that builds the same escrow three ways (keyset, module guard,
   capability guard) and shows what each one does and does not constrain, so a reader picks by
   reasoning rather than by copying. Should state plainly that the choice depends on who must be
   able to spend and from where, and that `create-module-guard` is deprecated in 5.4.
   (Retargeted 2026-07-29: the earlier draft asked for a worked example OF a capability-guarded
   escrow specifically. Do not reinstate that framing — a single endorsed pattern is the wrong
   deliverable here, and our own escrow does not use it.)
2. `pact-contract-catalog` · 1,000 · **New template: time-locked single-beneficiary vault** —
   smallest-possible vault (deposit, cliff, withdraw) with full positive/negative REPL suite
   in the catalog's house style.
3. `pact-contract-catalog` · 250 · **Catalog docs pass: add "common mistakes" notes to two
   templates** — short, source-anchored gotchas (e.g. precision on external decimal inputs).
4. `website` · 500 · **Contract catalog page: filterable template index** — client-side filter
   by category/interface on the catalog listing page.
5. `pact-kit` · 500 · **Add rule docs pages for the three newest lint rules** — one page per
   rule: what it flags, why, a failing and a fixed example.
6. `pact-mcp` · 500 · **Devnet quickstart doc: from zero to a deployed module in ten minutes**
   — a tested, copy-paste walkthrough using the MCP tooling.
7. `website` · 250 · **Add the event program + claim page links to the site header/footer** —
   small navigation PR once the token page is live.
8. `.github` · 250 · **Org profile README: what PCO is, how earning works, where to start** —
   the org landing page a new contributor sees first.

## For maintainers

- Label only work you would merge without the award existing.
- Fresh, tightly-scoped issues get done; stale wishlist items do not — write the issue you
  would want to pick up.
- Expect roughly half of claimed issues to complete; that is the normal base rate, not a
  failure. Reopen and move on.

## Monthly recognition batch (operator note)

Community Recognition micro-grants (25–100 PCO for helpful acts in the Telegram group and
issue tracker) are collected during the month in a public thread, then settled together with
any pending board awards as **one on-chain `grant-batch` call — one batch per transaction,
each receiver at most once per batch**. Recipients are asked publicly for a `k:` account;
nothing is ever direct-messaged.
