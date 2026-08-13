# PCO mainnet01 deployment record

**Deployed 2026-07-31 on Kadena `mainnet01`, all 20 chains.** This is the audit record of what
was put on chain, how it was verified, and what was deliberately left undone.

Every value below is **re-derivable from the chain by anyone**. Where a claim rests on something
that is not on chain — a device screen, an operator's eye — it is marked as such rather than
presented as measured.

Source tree: tag `mainnet-v1`. Contract bytes are byte-identical to the audited state for `pco`
and `pco-claim`; `pco-gas-station` differs in comments only, with the module hash measured
identical before and after (see "Relation to the audit" below).

---

## 1. What exists on chain

| | |
|---|---|
| Network | `mainnet01` |
| Namespace | `n_57fcd6f7b72e8949af51a8d6f17fe12cc7719d10` |
| Governance keyset | `n_57fcd6f7….pco-gov` — `keys-2` of 3 |
| Chains | 0–19 (all 20) |

### Governance keyset members

```
f6b457c2bf088a273bdbf476115d7ec875272fd14a5ad05b5aa1cdc9d71d7c92   seat A
ef5d47e1a2b4c40d3ceae46057eaca78d7c97722b553427f50cf2d7918bcec54   seat B
eabce4f63d74cc4e7222d1f3dbf6f0c18cb9f7963c603850070cc544be2142f3   seat C (break-glass)
```

Which physical device holds which seat is **deliberately not recorded here** — that mapping is
what tells an attacker which object to go after. It is held in the private ceremony records. The
public keys themselves are not secrets; they are on chain.

### Routine ops authority

```
keys-any over [ f6b457c2… , ef5d47e1… ]      seat C excluded by design
```

Module state in `pco` (`ops-auth`), **not a named keyset**. Verified `keys-any` over exactly
those two keys on all 20 chains. Seat C stays out of the routine tier: a break-glass device that
signs routine work is not a break-glass device.

### Modules

| Module | Module hash (uniform across 20 chains) | Source sha256 |
|---|---|---|
| `pco` | `dhaabVg6xcckPSQjxeE_berIoILRcJb4XKOa6qeClLs` | `279c61dfb3b6ba930e224a21c4990a944c6052449dc5cbf5e0cf60652a041e28` |
| `pco-claim` | `nlskDuK6PzL8YYQ3-EvgxBer72ePBXg1c90r8AqEWgM` | `08d00030d5bdf7dae250e61454510d68bf2594724bd84259c861794bce715e15` |
| `pco-gas-station` | `mOexAK7BRecYDLtkmVc-YZSxB1TxiLawvImoB08QWQc` | `e889b735b920b86f63e82df83a21612b2760200b68178a4f66c813eb94ae4fe2` |

`pco` implements `fungible-v2` and `fungible-xchain-v1`.

### Token state

```
total minted     1,000,000 PCO      one-shot; a second mint is refused with "already minted"
claim pool         900,000 PCO      m:n_57fcd6f7….pco-claim:pco-claim-pool
gov reserve        100,000 PCO      r:n_57fcd6f7….pco-gov
```

The pool is registered **non-voting** in `pco` on all 20 chains — verified per chain, not
inferred from the `m:` prefix. That registration, not the account-type prefix, is what keeps
900,000 tokens out of governance tallies.

### Gas station

```
account   u:n_57fcd6f7….pco-gas-station.station-guard-pred:DldRwCblQ7Loqy6wYJnaodHl30d3j3eH-qtFzfEv46g
float     1 KDA
allowlist pco-claim.claim   — ONE entry; onboarding only
epoch     0.5 KDA/day cap
```

### Gas payer (hot softkey, not in any keyset)

```
k:3235334f4db64469541261ea6ebbbb61db7d0823402cf7c8e85d349cdb5ed8d9
```

Pays gas only, signs nothing of governance significance. Funded 10 KDA on chain 0 and spread
0.15 KDA to each of chains 1–19.

---

## 2. Ceremony log

Each step: built unsigned → preflighted read-only against live mainnet → hash-signed on two
devices (one device per step, all 20 chains, then swap) → every signature ed25519-verified
locally against the expected seat key → submitted **chain 0 alone first** and verified on chain →
remaining 19 released → full sweep verified.

| Step | Scope | Signers | Gas each | Result |
|---|---|---|---|---|
| Namespace + keyset | 20 chains, one tx per chain | A+B | 346 | 20/20 |
| Deploy `pco` | 20 chains | A+B | 44,045 | 20/20 |
| Deploy `pco-claim` | 20 chains | A+B | 23,973 | 20/20 |
| Deploy `pco-gas-station` | 20 chains | A+B | 11,276 | 20/20 |
| `set-ops-guard` | 20 chains | A+B | 153 | 20/20 |
| `mint` | hub chain 0 only | A+B | 329 | minted |
| `fund-station` | hub chain 0 only | gas softkey, capability-scoped | 251 | 1 KDA float |

Deploy request keys for all 60 module deploys: [`DEPLOY-TXHASHES.md`](DEPLOY-TXHASHES.md), recovered
from chain via `(at 'tx_hash (describe-module …))`.

Chain-0 request keys for the steps that have no on-chain `tx_hash` accessor:

```
namespace + keyset   1fsObD-B44TdIuFgPvBw-uCZX_zyL9U0xUHKQT-zNhI
set-ops-guard        Z-7N-vyYJFKSobipT4W3TEJv3jr6WfipNYqHVHj6CbM
mint                 9_PqQw1L7yGLKU10rFWFjawKVFW1jG_Xe4hAbX7I_fU
fund-station         GHxltoBnQx8nzMVzh6klhm7YAlzgMpgHHejhw3UewH8
```

**Gap, stated rather than hidden:** the per-chain request keys for the namespace+keyset and
`set-ops-guard` steps were not preserved for chains 1–19. `describe-namespace` exposes no
`tx_hash`, and the build artifacts for the namespace step were destroyed mid-ceremony by a
defect in this repo's own test suite (`ops-checks` removed the real ceremony output directory
wholesale rather than only its own files; fixed, and the fix is proven with a signature in
place). The resulting STATE is fully verifiable on chain — the namespace, the keyset membership
and the ops guard are all readable per chain — so nothing about the outcome is unverifiable.
What is lost is the transaction-level provenance for those two steps on 19 chains.

---

## 3. How each claim was verified

| Claim | How |
|---|---|
| Deployed code == repository | `verify-deployed --all-chains`: code match + uniform module hash across 20 |
| Namespace + keyset are ours | `describe-namespace` (both guards) **and** `describe-keyset` (3 keys, `keys-2`), per chain |
| Pool cannot vote | `(pco.non-voting? (pco-claim.pool-account))` == `true`, per chain |
| Ops tier correct | `(pco.ops-guard)` == `keys-any` over [A,B], seat C absent, per chain |
| Mint is closed | second `init-mint` **with the governance signers declared** returns `already minted` |
| Signatures genuine | every device signature ed25519-verified against the seat's recorded pubkey before submit |
| Transaction integrity | hash recomputed from `cmd` for every file; `submit.ts` refuses on mismatch |
| Costs reconcile | gas-payer balance deltas match gas used, to the last decimal, at every step |

### One verification that was wrong the first time

The mint-closed check was initially run as an unsigned `/local`, and it was refused by the
**keyset** check before ever reaching the one-shot gate. That would have reported "second mint
refused" on evidence proving nothing about the gate. Re-run with both governance devices
declared as signers, it reached the real check and returned `already minted`.

This is recorded because it is the exact failure mode the 2026-07-30 cold audit was
commissioned to find — a negative test passing for the adjacent reason — and it occurred on the
single most consequential step.

---

## 4. Relation to the audit

The confirming cold audit returned **GO** with 0 CRITICAL
and 0 HIGH, conditional on two items outside the contracts. Both were closed before the ceremony.
(The audit report itself is not published: it records attack paths against a live system, and its
value to a reader here is the verdict and the conditions, which are stated in full below.)

- **C1** — namespace and keyset are claimed in ONE transaction per chain. Split across two
  transactions, the keyset name was takeable in the gap by anyone who knew the governance keyset,
  and the old step-4 verification could not detect it (our `define-namespace` still reclaimed the
  user guard and read clean). Deployed atomically.
- **C2** — the namespace is derived offline against a byte-true mainnet `ns` fixture rather than
  by posting the governance keyset to a public node.

**Contract bytes vs the audited state:** `pco` and `pco-claim` are byte-identical. `pco-gas-station`
differs in **comments only** — disclosure was removed that this project's own `PRIVATE-ONLY.md`
rule did not permit shipping — and its **module hash was measured identical before and after**
(`AmOitxfM4mTll1FtOAHAekpr021AM7vcxRFb-NNZu68` in the pre-deploy test harness). Pact excludes
comments and `@doc` from the module hash; that was measured, not assumed.

---

## 5. Accepted risks, carried into production

**The gas-station float is sized to be losable.** That is the operational rule, and it is a rule
rather than a formality: the float is capped at 1 KDA with a 0.5 KDA/day epoch meter, and it is
funded on the assumption that losing all of it is an inconvenience rather than an incident. It is
the only real value this otherwise-valueless system holds. Do not fund it generously. Rationale
and the executable regressions are kept in the private ceremony repository, not here — this
document is public, and a deployed system's public record is not the place to reason about how
its defences might fail.

**Device approvals were blind.** Clear-signing is a stub in the signing tool, so all ~240 ceremony
approvals compared a 32-byte hash rather than a readable recipient and amount. Mitigations used:
every transaction was preflighted read-only against live mainnet **before** any approval was
spent; the expected hash was printed and written to a per-step sheet in both encodings; and every
signature was verified locally against the seat key before submit. The gas-payer funding and
`fund-station` were additionally **capability-scoped** to exact arguments. Deploys and
`define-namespace` cannot be scoped — they are keyset-enforced, with no capability to scope to —
so for those the reviewed code IS the scope.

**Supply is not yet mathematically fixed.** `init-mint` refuses a second call, but that gate binds
the function, not the keyset: while the module is unfrozen a governance quorum could upgrade it.
Fixed supply becomes a property of the code only at the freeze. The contract states this in its
own `@doc`; upgradeability is disclosed in the README.

---

## 6. Status since deployment

> **CORRECTED 2026-08-13.** This section described the state at the close of the deploy ceremony
> and was never updated when the program started, so for twelve days it told readers that claiming
> was closed, that no rounds existed and that the token was "deployed and inert" — while the
> genesis round was live and being claimed. The figures below carry the date they were measured;
> **the chain is the source of truth, not this file.** Re-read it rather than quoting these.

```
open-claims        RUN 2026-08-01 — claiming is OPEN, the genesis round is live
freeze             NOT RUN — modules remain upgradeable by governance
```

Measured on chain 0 at **2026-08-13**:

| Read | Value |
|---|---|
| `(at 'open (pco-claim.get-config))` | `true` |
| `(pco-claim.round-ids)` | `["genesis"]` |
| `(pco-claim.get-round "genesis")` | 100 per claim, budget 30,000, **claimed 3,700**, window `2026-08-01` → `2026-08-31` |
| `(pco-claim.pool-balance)` | 894,375 |

Recognition grants have also been paid from the pool. Every one exists on-chain as an `AWARDED`
event carrying its public reason — **those events are the ledger**, and a total is deliberately not
quoted here while an internal reconciliation of the grant figures is open.

Anyone can re-derive all of the above:

```
(pco-claim.get-config)   (pco-claim.round-ids)   (pco-claim.get-round "genesis")
(pco-claim.pool-balance)
```

---

## 7. Re-verifying this record

Everything above except the ceremony's human steps can be re-derived by a stranger:

```
cd ops/
export PCO_NETWORK=mainnet01 PCO_HOST=https://api.chainweb-community.org
export PCO_NS=n_57fcd6f7b72e8949af51a8d6f17fe12cc7719d10

npx tsx src/verify-deployed.ts --all-chains     # code == repo, uniform hashes, tables present
npx tsx src/local.ts '(describe-namespace "'$PCO_NS'")' all
npx tsx src/local.ts '(describe-keyset "'$PCO_NS'.pco-gov")' all
npx tsx src/local.ts '('$PCO_NS'.pco.ops-guard)' all
npx tsx src/local.ts '('$PCO_NS'.pco.chain-minted)' 0
npx tsx src/local.ts '('$PCO_NS'.pco.non-voting? ('$PCO_NS'.pco-claim.pool-account))' all
```

A fresh clone of `mainnet-v1` must generate its derived sources before the static gate runs, or
it reports a VIOLATION that reads like a contract defect — see RUNBOOK §B item 2.
