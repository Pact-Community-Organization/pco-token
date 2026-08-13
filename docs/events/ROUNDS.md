# Claim rounds — schedule & briefs

> **Publication policy (revised 2026-07-31):** **no round's answer is pre-published, including
> genesis.** Questions publish when their round opens; answers never publish here at all.
>
> This reverses the earlier rule that the genesis answer was "public by design as the launch
> warm-up". That made sense when the answer was a generic fact anyone in the ecosystem already
> knew. The genesis quest now asks the reader to go and look at something we built — so printing
> the answer in the same repository the question sends them to would defeat the round entirely.
>
> Answers stop being secret anyway the moment the first claim lands: the quest code rides in
> cleartext inside the claim transaction, which is permanent public chain data. That is fine and
> intended — codes are engagement devices, not secrets, and budgets plus one-claim-per-account are
> what keep a round fair. The point of not pre-publishing is simply that the first person through
> should have looked.
>
> This is the public-safe version; operators keep the fully-answered version in the private ops repo.

Operational briefs for the first claim rounds. Each round exists on-chain as a row in PCO's
claim contract: round id, code hash, per-claim amount, budget, [opens, closes)
window. The **question** publishes on the PCO channels with the round id when the round opens;
the **code** is the normalized answer — lowercase, trimmed, exactly as written in the source
material. Only the BLAKE2b hash of the code goes on-chain (computed off-chain:
`(hash "the-code")` in a Pact REPL).

Codes are engagement devices, not secrets: after the first claim lands, the code is public
chain data. Budgets and one-claim-per-account-per-round keep rounds fair.

## Round 1 — `genesis` (launch)

| Field | Value |
|---|---|
| Round id | `genesis` |
| Question | *PCO is three separate contracts, not one: the token, the gas station, and the one that runs these quests. What is that third module called?* **(module name only — lowercase, no namespace prefix, no file extension)** |
| Answer / code | *not published — the round is answerable from what we built* |
| Amount / budget | 100 PCO / 30,000 PCO |
| Window | opens at launch, closes +30 days (exact UTC times fixed at launch) |
| Announce | site + X + Telegram + GitHub org README, all carrying the round id |

The answer is findable in three independent places, and finding it is the round: the contracts in
the token repository, that repository's README, and the deployed modules on chain. Any one of them
is enough.

## Round 2 — `quest-2`

| Field | Value |
|---|---|
| Round id | `quest-2` |
| Question | *published when the round opens* |
| Answer / code | *not published* |
| Amount / budget | 100 PCO / 2,500 PCO |
| Window | 14 days |

Answerable two independent ways — from this repository's contracts, and from the deployed modules
on chain. Either one is enough, and looking is the round.

## Governance reading-quests — `gov-YYYY-MM` (monthly)

One per Governance Round. The code is a short phrase **embedded inside the proposal body
on-chain** — reading the proposal IS the quest. Never pre-published anywhere else.

| Field | Value |
|---|---|
| Round id | `gov-2026-MM` (month of the proposal) |
| Amount / budget | 100 PCO / 2,500 PCO |
| Window | matches the proposal's voting window |

**Governance Round #1 proposal draft** (opened by the disclosed bootstrap account, which never
votes):

> **Title:** What should the community prioritize first?
> **Body:** An advisory signal to order the first quarter of community work. Options discussed
> on the channels; vote yes to endorse the posted priority list, no to ask for a rework,
> abstain to be counted as present. This proposal executes nothing — it is a signal.
> Reading code for round `gov-2026-MM`: `<embedded-here-at-creation>`.
> Results are published as distinct-account turnout alongside weight.

## Community calls — `call-YYYY-MM-DD`

Code spoken live during the call, never posted in text. Amount 50 PCO, budget 1,000, window
48 hours from the call's start.

## Round checklist (operator)

Every round goes through a scripted preflight before anything is built or signed. It checks, among
other things, that the ceremony tooling matches its reviewed pin, that the round id is still free,
that the answer matches its published hash, that the window's time literals parse against the
deployed engine, that the award fits the contract's bounds and the pool, and — because a
pre-published answer would hand the round's whole budget to whoever read it — **that the answer is
not already public**. Any failing check stops the round.

1. Pick id + question + answer; normalize the answer (lowercase, trim). The claim page lowercases
   and trims what the claimant types, so an answer carrying capitals would be unclaimable — the
   hash is always computed over the normalized form.
2. Run the preflight. It is a gate, not a report: a red check means the round is not opened.
3. Compute the hash off-chain; never put the plaintext code in tx code.
4. `build-tx.ts create-round` (ops key signs alone). The transaction hash is compared on a second
   machine against the device screen before it is approved.
5. Submit, then verify `get-round` on-chain **before** announcing.
6. Announce on all four channels **with the round id**.
7. At close (+ a day), post honest participation numbers (distinct accounts).
