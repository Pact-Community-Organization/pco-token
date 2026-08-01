# PCO Token — User Guide

> **Plain-language disclosure:** PCO tokens carry **no dividends, no revenue rights, and no
> monetary value** — and they are never sold. Claiming is free; votes are advisory signals that
> execute nothing on-chain. If anyone quotes a PCO price or direct-messages you a claim link,
> it is not us.

This guide covers everything a community member can do with the PCO token. Every action here is
a **community function** — administrative functions (opening rounds, granting awards, sweeping
the pool, upgrading modules) are never exposed on the website and always require the
organization's hardware-held keysets.

## 1. Choose your wallet — one active identity

The token page uses **one active wallet at a time**: claims land there, balances show for it,
votes and transfers come from it. Never two identities at once — switching wallets switches
everything. Four options:

| Option | What it is | Notes |
|---|---|---|
| **In-browser key** | A keypair generated inside your browser (the default) | Zero setup — perfect for a first claim. **Download the key backup**: the key lives only in that browser's storage. |
| **EckoWallet** | Browser extension | Must be on the site's network (see §2 note) |
| **Zelcore** | Desktop app | Log in first; the site talks to its local signing API |
| **Ledger** | Hardware, via WebHID | Chrome/Edge/Brave; Kadena app open. The page asks the device to **display** the transaction so you can check it on-screen. Leave "blind signing" **off** — if the device ever shows only a hash it cannot tell you what you are approving, and the page will warn you before continuing |

## 2. Claim — free, with any wallet

Claiming is the one action whose gas is **sponsored** by the on-chain gas station — and your
wallet never signs for it (claims need no signature from the claimer; tokens can only land in
the account bound to the supplied guard). So even a Ledger claim needs no device interaction.

1. Pick the open claim round and answer its quest. Quests are published on the PCO channels
   together with the round id; the answer, normalized to lowercase, is the claim code.
2. Claim. The gas station pays the fee; tokens land in your **active wallet's** account.

On-chain rules that keep this fair: **one claim per account per round**, a fixed budget per round,
and a time window — when a round's budget is exhausted or its window closes, the round is over.

Everything beyond claiming is **self-paid**: your active wallet signs and pays a little KDA gas.

**EckoWallet network setup (devnet preview):** the preview build points at a local development
network. In EckoWallet: *Settings → Networks → add* — Name `PCO devnet`, URL `http://localhost:8090`,
Network ID `recap-development` — save it and select it as the active network, then reconnect.
(The launch build will point at Kadena mainnet, where no setup is needed.)

## 3. What is sponsored and what you pay

- **Sponsored (free for you):** the claim — the community gas fund exists to onboard newcomers who
  hold no KDA. It is capped at a fixed daily budget that refills each day, so it stays an
  onboarding fund.
- **Self-paid (your wallet pays ordinary gas):** transfers, cross-chain transfers, voting,
  vote-key registration, guard rotation. Fees are tiny fractions of a KDA. (Questions are authored
  by the organization, not by holders — see §5.)

## 4. Transfers

- **Same-chain:** enter a `k:` recipient and an amount. Transfers are irreversible — check the
  recipient twice. If the recipient account does not exist yet it is created bound to the key in
  its name (that is what makes `k:` accounts safe to send to).
- **Cross-chain:** PCO lives on all 20 Kadena chains; governance lives on chain 0 (the hub).
  A cross-chain send is **two steps**: the first debits your account on the source chain, and a
  second one credits the target chain once the SPV proof settles. The token page submits the first
  step only. Until the second lands, your tokens are debited and not yet credited — they are not
  lost, but they are in flight. If you sent *from* the hub chain, that debit has already shrunk any
  open ballots you had, exactly as an ordinary transfer would.

  On Kadena mainnet the second step is normally completed for you by the public cross-chain gas
  relay, so in practice it finishes on its own within a few minutes. That relay is a public service,
  not part of this contract: it is a liveness convenience, not a guarantee. **On the devnet preview
  no such relay exists, so a cross-chain send there stays half-finished until the continuation is
  submitted by hand.** Anyone can submit it — the continuation needs no signature from you, only
  gas on the target chain.

## 5. Governance — ranked-choice voting on admin-authored questions {#voting}

- **Questions come from the organization; answers come from you.** Each on-chain question
  carries 2–5 named options. The community **suggests questions on the public channels**
  (Telegram / X) and the organization puts them on-chain — an accountable public step.
- **You vote by ranking the options** in order of preference. A partial ranking is fine, and —
  importantly — it costs you nothing: **ranking more options can never hurt your favourite.**
- **The result is head-to-head.** For every pair of options the contract records how much voting
  weight prefers one to the other, and the published winner is the option that beats every other
  one. If no option beats all the others, that is reported honestly as a split rather than broken
  by an arbitrary rule. There is no quorum and **no vote executes anything on-chain**.
- A **Borda points** row is also published, but only as a *completeness diagnostic*: because
  points reward ranking fewer options, they are not the result. Read the head-to-head.
- Voting weight is your **current hub-chain balance**; re-submitting replaces your ballot, and
  every balance decrease (transfer, cross-chain send) automatically shrinks your open ballots —
  tokens that left can never keep voting. Received tokens arrive unvoted.
- The organization can close a question early only with a **public on-chain reason**.

### Why can't holders create proposals directly? {#governance-design}

With a small global cap on open questions (which bounds gas on every transfer), open proposing
is squattable: one threshold-sized bankroll hopping between fresh accounts can fill every slot
forever, and defending against that requires stake locks plus admin cancel/seizure backstops —
at which point admin involvement is structural anyway. v1 takes honest control of question
authorship instead, keeps voting and suggesting fully open, and preserves the complete
open-proposing design (stake locks, cooldowns, cancel/seize) for a future version. The full
analysis is in the repository: `docs/GOVERNANCE-DESIGN.md`.

## 6. The voting key — vote hot, keep your wallet cold {#voting-key}

If you hold PCO in a wallet you do not want to take out for routine votes, register a
**dedicated vote key**:

- **Register:** your MAIN wallet signs one transaction (`set-vote-key`, scoped to the
  `VOTE-KEY-ADMIN` capability). On the token page, one click registers the browser's own key as
  your vote key.
- **After that:** the hot key can cast and re-cast votes for your account, paying its own tiny
  gas. Your main wallet never has to come out to vote.
- **Safety properties, enforced on-chain:**
  - The hot key can **only vote**. Transfers, rotation, and the registration itself all require
    the main guard. (Claiming is not in that list because a claim requires **no signature at
    all** — see §2. That is deliberate, so a newcomer with no wallet can receive their first
    PCO, and it means anyone can submit a claim naming your account. The tokens still land in
    your account and nobody else can move them; what a stranger can consume is your
    one-claim-per-round slot for that round.)
  - The hot key can never re-point or clear itself — only the main wallet can.
  - Your main wallet **always keeps its own voting power**: the contract checks the main guard
    first, so a registration can never lock you out.
  - **Clear** the key any time with one main-wallet transaction (`clear-vote-key`).

## 7. Rotating an account guard {#rotate}

Accounts with a plain chosen name — one that is **not** a protocol principal — can rotate to a
new guard: connect a wallet satisfying the account's **current** guard and submit the rotation
(scoped `ROTATE` capability).

Protocol note, and the line is drawn at **principals**, not at `k:`: an account whose name begins
`k:`, `w:`, `u:`, `r:`, `m:`, `p:` or `c:` **cannot** rotate its guard. The name is derived from
the guard, so changing the guard would falsify the name — and that binding is exactly what makes
principal accounts safe to send to. It applies to the community reserve (`r:`) and the claim pool
(`m:`) too, not only to `k:` accounts.

## 8. Verifying everything yourself

- **Contracts:** the deployed modules byte-compare against the public repository
  ([Pact-Community-Organization/pco-token](https://github.com/Pact-Community-Organization/pco-token)) —
  the repo's verification guide shows how to run the comparison against any node.
- **Activity:** every claim, grant (with its public reason), round, vote, vote-key registration,
  and transfer emits a public on-chain event. Nothing about the program is off-ledger.

## 9. Fair play and safety

- Official rounds exist on-chain before they are announced anywhere. We never direct-message
  claim links, and there is nothing to buy — ever.
- The claim page never asks for a seed phrase. The in-browser key is generated locally; back it
  up and treat the backup like a password.
- Round budgets bound worst-case abuse; one-claim-per-account-per-round is the on-chain rule.
