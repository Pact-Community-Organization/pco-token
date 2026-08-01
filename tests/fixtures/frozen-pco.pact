;; pco.pact — the PCO community governance token (PCO).
;;
;; A free, deliberately valueless community token: fixed supply, one-shot
;; mint, live-balance advisory voting. It confers NO dividends, NO revenue
;; rights, NO claim on anyone or anything. Votes EXECUTE NOTHING on-chain:
;; tallies are a permanently recorded advisory signal about PCO tooling
;; direction, nothing more.
;;
;; Derived from the PCO catalog template library/token-fixed-supply-gov
;; (audited), with three deliberate deltas for a 20-chain deployment:
;;   1. GOVERNANCE = the <ns>.pco-gov keyset (a 2-of-3 hardware keyset).
;;      The module is upgradeable under that keyset; flipping FROZEN-MODULE
;;      to true and redeploying freezes it permanently.
;;   2. Cross-chain transfers ENABLED (fungible-xchain-v1, 2-step SPV
;;      defpact). Voting stays sound because every debit — including the
;;      step-0 cross-chain debit — releases the moved weight from open
;;      tallies, and credits always arrive unvoted.
;;   3. Governance is HUB-CHAIN-ONLY (chain 0): proposals and votes exist
;;      only where the deep liquidity is minted, so no cross-chain
;;      double-vote surface exists at all. Tokens may live on any chain;
;;      voting weight is the voter's hub-chain balance.
(namespace (read-msg 'ns))

(module pco GOVERNANCE

  @doc "PCO community governance token: fixed-supply fungible-v2 +          \
  \fungible-xchain-v1 with ADVISORY ranked-choice live-vote governance.      \
  \                                                                          \
  \GOVERNANCE MODEL - admin-authored questions, community-ranked answers:    \
  \  * Proposals are RANKED-CHOICE questions (2..5 named options) created    \
  \    by the org (ops tier; governance keyset always works). The community  \
  \    suggests questions on the public channels; the org puts them          \
  \    on-chain. RATIONALE: with 3 global slots, OPEN proposing needs stake  \
  \    locks + admin cancel/seize backstops to survive funded               \
  \    slot-squatting - admin involvement is structural either way, so v1    \
  \    takes honest full control (the open design is parked for a future     \
  \    version).                                                             \
  \  * Voters RANK options; tallies are live per-option BORDA scores: a      \
  \    ballot ranking option i at position p contributes weight*(K-p)        \
  \    points, maintained incrementally on vote, re-vote and release         \
  \    (instant-runoff can be recomputed off-chain from the public           \
  \    ballots).                                                             \
  \                                                                          \
  \The live-vote discipline, in full:                                        \
  \  * A ballot's weight is the voter's CURRENT hub-chain balance;           \
  \    re-voting replaces the ballot in place.                               \
  \  * Every balance DECREASE (transfer out, cross-chain send)               \
  \    automatically releases the moved weight from the account's ballots on \
  \    every OPEN proposal, so tokens that moved away can never keep voting. \
  \  * Received tokens arrive UNVOTED: credits never touch scores.           \
  \  * release-votes is deliberately PUBLIC: it derives everything from the  \
  \    account's REAL balance, so it can only shrink stale weights.          \
  \  * At most MAX-ACTIVE-PROPOSALS are open at once, bounding the release   \
  \    work added to any debit.                                              \
  \                                                                          \
  \Votes EXECUTE NOTHING. Scores are advisory community signals about PCO    \
  \tooling direction; no quorum is enforced — readers judge turnout.         \
  \                                                                          \
  \Two accounts are barred from voting, and BY NAME. There is no rule about  \
  \principal TYPES here: an earlier design refused every code-held tag       \
  \(`m:`, `c:`, `u:`, `p:`, `r:`) as an allowlist, and that rule is GONE -   \
  \it was deleted, not weakened, and this paragraph described it for 1,000   \
  \lines after the enforcing line stopped existing. What actually holds:     \
  \the community reserve is refused by a hardcoded enforce in                \
  \cast-vote-internal, and every other excluded escrow is refused through    \
  \the `non-voting` register, whose rows are written by the module that OWNS \
  \the escrow, at its own deploy (see register-non-voting). That is how      \
  \`pco` learns the claim pool's principal without naming `pco-claim`, a     \
  \module which depends on this one and so could not be named here. What     \
  \disqualifies the pool is that it holds UNDISTRIBUTED community tokens,    \
  \not that it happens to be module-guarded: a type rule would also          \
  \disenfranchise participants who legitimately hold through a contract,     \
  \and would still miss an escrow held under an ordinary name.               \
  \These are NAME checks, not locks on governance: while this module is      \
  \unfrozen the                                                              \
  \community keyset can move escrowed or reserve tokens to an ordinary       \
  \account and vote them. That route at least emits a public TRANSFER event; \
  \module admin can also write balances and scores directly, emitting        \
  \nothing. FROZEN-MODULE removes only the SILENT route: with both modules   \
  \frozen the ops tier can still grant pool tokens to an account and vote    \
  \them, which is evented and publicly auditable but not prevented. The      \
  \freeze buys detectability, not governance neutrality.                     \
  \                                                                          \
  \An account may register an OPTIONAL dedicated vote key (a hot key that    \
  \can ONLY vote) under its main guard; transfers, rotation, and the         \
  \registration itself always require the main guard.                        \
  \                                                                          \
  \Supply accounting is PER CHAIN: chain-minted describes THIS chain's       \
  \ledger only. The mint happens once, on the hub chain; there is no burn    \
  \path and no second mint through any function. Supply is fixed by          \
  \CONSTRUCTION against every caller — the only balance increases are fused  \
  \to a real debit, or behind the one-shot MINT keyset — but NOT against     \
  \governance itself, which can acquire module admin and write balances      \
  \directly while the module is unfrozen. Fixed supply becomes an enforced   \
  \property, rather than a disclosed intention, only at the FROZEN-MODULE    \
  \flip."

  (implements fungible-v2)
  (implements fungible-xchain-v1)

  ;; -----------------------------
  ;; Governance: the community keyset (rotatable; freezable by upgrade)
  ;; -----------------------------

  (defconst NS:string (read-msg 'ns)
    "Deploy namespace, fixed at deploy (no source edit between networks).")

  (defconst ADMIN-KS:string (format "{}.pco-gov" [NS])
    "The community governance keyset (2-of-3 hardware keys). Rotating the \
    \keyset definition rotates every right this module grants it.")

  ;; GENERATED FIXTURE - do not edit; see fixtures/make-frozen-pco.sh
  (bless "DldRwCblQ7Loqy6wYJnaodHl30d3j3eH-qtFzfEv46g")

  (defconst FROZEN-MODULE:bool true
    "Set true and redeploy to permanently freeze upgrades.")

  (defcap GOVERNANCE ()
    @doc "Upgrade/admin gate: the community keyset, unless frozen."
    (enforce (not FROZEN-MODULE) "Module is frozen - no further upgrades")
    (enforce-keyset ADMIN-KS))

  ;; -----------------------------
  ;; Deploy-time constants
  ;; -----------------------------

  (defconst SYMBOL (read-string 'symbol)
    "Display symbol, fixed at deploy.")

  (defconst PRECISION:integer
    (let ((p (read-integer 'precision)))
      (enforce (and (>= p 0) (<= p 12)) "precision must be in 0..12")
      p)
    "Decimal precision, fixed at deploy (12 matches coin).")

  (defconst TOTAL-SUPPLY:decimal
    (let ((s (read-decimal 'total-supply)))
      (enforce (> s 0.0) "total-supply must be positive")
      (enforce (= (floor s PRECISION) s) "total-supply must respect precision")
      s)
    "The fixed supply: minted exactly once (hub chain), never changed after.")

  (defconst OPS-KEY:string "ops"
    "Singleton row key for the ops-authority table.")

  (defconst EMPTY-KEYSET-PREFIX:string
    "w:DldRwCblQ7Loqy6wYJnaodHl30d3j3eH-qtFzfEv46g"
    "Principal prefix shared by EVERY keyset with an empty key list (the     \
    \key-list hash is a constant, so the predicate is the only thing that   \
    \varies after it). `keys-all` over zero keys is vacuously TRUE, so such \
    \a keyset is satisfied by a caller signing nothing; set-ops-guard       \
    \refuses the whole shape. Verified in tests/ops-recovery.repl.")

  (defconst MAX-OPTIONS 5
    "Most options a ranked-choice question may carry (bounds ballot and     \
    \release work; 2 options = a plain either/or question).")

  (defconst GOV-CHAIN:string "0"
    "The hub chain: the one-shot mint, all proposals and all votes live here.")

  (defconst RESERVE-ACCOUNT:string
    (create-principal (keyset-ref-guard ADMIN-KS))
    "The community reserve account (r: principal of the governance keyset).  \
    \Rotating the keyset re-points this account's control automatically.     \
    \Barred from voting on-chain BY NAME - and that bar is a name check, not \
    \a lock on admin voting power. Governance                                \
    \controls this account, so it can move the reserve to an ordinary        \
    \account in one transaction and vote it; after close+sweep it could do   \
    \the same with the undistributed pool. That ROUTE at least emits a       \
    \public TRANSFER event.                                                  \
    \Do NOT infer a visibility guarantee from that:                          \
    \while this module is unfrozen, governance can also acquire module admin \
    \and write scores, turnout, ballots and balances DIRECTLY, emitting NO   \
    \events at all. Unlike an upgrade - which changes the module hash and is \
    \loudly detectable - that leaves no trace an observer can key on.        \
    \The FROZEN-MODULE flip closes that SILENT route, and only that route:   \
    \verified by execution, a frozen pair still lets the ops tier grant pool \
    \tokens to an ordinary account and vote them. After the freeze every     \
    \such move is evented and auditable; it is not prevented.")

  (defconst MIN-VOTE-HOURS 24
    "Shortest allowed voting window.")

  (defconst MAX-VOTE-HOURS 720
    "Longest allowed voting window (30 days).")

  (defconst MAX-ACTIVE-PROPOSALS 3
    "Open-proposal cap: bounds the release work on every balance decrease.")

  (defconst MINIMUM_ACCOUNT_LENGTH 3
    "Minimum account name length")

  (defconst MAXIMUM_ACCOUNT_LENGTH 256
    "Maximum account name length")

  (defconst SUPPLY-KEY "supply")
  (defconst ACTIVE-KEY "active")
  (defconst COUNT-KEY "n")

  ;; -----------------------------
  ;; Schemas and Tables
  ;; -----------------------------

  (defschema account
    @doc "Account row with balance and guard"
    @model [(invariant (>= balance 0.0))]
    balance:decimal
    guard:guard)

  (deftable accounts:{account})

  (defschema supply-row
    @doc "Singleton per-chain supply ledger, seeded {0.0, 0.0} at deploy on  \
         \every chain. The one-shot mint flips minted from 0.0 exactly once  \
         \(hub chain). The burned field is retained for row-shape stability  \
         \and stays 0.0 forever: the module has NO burn path."
    minted:decimal
    burned:decimal)

  (deftable supply:{supply-row})

  (defschema recipient
    @doc "One initial-distribution entry for init-mint."
    account:string
    guard:guard
    amount:decimal)

  (defschema rcv-proposal
    @doc "An ADMIN-authored ranked-choice question: 2..MAX-OPTIONS named     \
         \options; scores[i] = live Borda points of options[i] (a ballot     \
         \ranking option i at position p contributes weight*(K-p) points,    \
         \updated incrementally on vote, re-vote and weight release);        \
         \turnout = sum of current ballot weights."
    title:string
    body:string
    options:[string]
    created:time
    close-at:time
    scores:[decimal]
    turnout:decimal)

  (deftable rcv-proposals:{rcv-proposal})   ; key = proposal id (counter)

  (defschema rcv-ballot
    @doc "One voter's live ballot on one proposal: the ranking (ordered,     \
         \distinct option indices, best first - partial rankings allowed)    \
         \and the weight it currently carries (shrunk by releases)."
    ranking:[integer]
    weight:decimal)

  (deftable rcv-ballots:{rcv-ballot})       ; key = "<pid>:<account>"

  (defschema rcv-margin
    @doc "The AUTHORITATIVE head-to-head record for one question: a K x K matrix \
         \flattened row-major, where m[i*K + j] is the total ballot weight that   \
         \prefers option i to option j. The diagonal stays 0.0 forever.           \
         \                                                                        \
         \WHY THIS EXISTS (see also the borda-apply docstring). Under the Borda   \
         \scores alone, truncating a ballot is strictly dominant: a ballot of     \
         \length 1 gives its favourite a margin of w*K over the strongest rival,  \
         \while a full ranking gives w*1. That penalises honesty and makes the    \
         \published number a function of ballot DEPTH as much as of preference.   \
         \A pairwise cell has no such lever: a ballot that ranks i first credits  \
         \m[i][j] with its full weight whether or not j is ranked, so [i] and     \
         \[i,j,k] produce IDENTICAL i-vs-j and i-vs-k cells. Only the j-vs-k cell \
         \moves. Truncation therefore costs a voter influence over races they did \
         \not rank and gains them nothing anywhere - a fuller sincere ballot is   \
         \weakly better, which is the exact inverse of the Borda incentive.       \
         \                                                                        \
         \READ THE CELLS, NOT A SUMMARY. Only the individual pairwise cells are   \
         \depth-neutral; every scalar reduction of this matrix (row sums, net     \
         \margins) reintroduces a length bonus and throws the property away.      \
         \Copeland win-counts in get-head-to-head are computed FROM the cells and \
         \are a readout, never the stored quantity."
    m:[decimal])

  (deftable rcv-margins:{rcv-margin})       ; key = proposal id

  (defschema gov-active
    ids:[string])

  (deftable rcv-actives:{gov-active})       ; singleton: open-proposal index

  (defschema gov-count
    n:integer)

  (deftable gov-counts:{gov-count})         ; singleton: id counter

  (defschema vote-delegate
    @doc "An OPTIONAL dedicated voting key for one account: a hot key that   \
         \can ONLY vote, so the main (cold) key never has to come out for    \
         \routine governance. Registered/cleared exclusively under the MAIN  \
         \account guard; consumed ONLY by the VOTE capability."
    guard:guard
    active:bool)

  (deftable vote-delegates:{vote-delegate}) ; key = account

  (defschema ops-authority
    @doc "The routine-operations authority, held as module STATE rather than \
         \as a named keyset. This is deliberate: a named keyset can only be  \
         \redefined by satisfying ITSELF, so a compromised ops device could  \
         \re-point it beyond governance's reach, and a LOST ops device could \
         \never be replaced at all - both recoverable only by a code         \
         \upgrade. Holding the authority here makes it governance-owned:     \
         \ops can never change it, and governance can always replace it."
    guard:guard)

  (deftable ops-auth:{ops-authority})       ; singleton, key = OPS-KEY

  (defschema non-voting-row
    @doc "An account registered as OUTSIDE THE FLOAT: an escrow holding tokens \
         \that are not yet anybody's, so they carry no voice. Keyed by account. \
         \                                                                      \
         \Registered BY NAME, deliberately, rather than inferred from the       \
         \account's guard type. What disqualifies the claim pool is what it     \
         \HOLDS - undistributed community tokens - not how it is guarded, and a \
         \rule about guard types would both disenfranchise participants who     \
         \hold through a contract and miss an escrow kept under an ordinary     \
         \name. The register is public, so anyone can read exactly which        \
         \accounts are excluded and check the list against the supply."
    reason:string)

  (deftable non-voting:{non-voting-row})

  ;; -----------------------------
  ;; Capabilities
  ;; -----------------------------

  (defcap DEBIT (sender:string)
    @doc "Internal debit permission: enforces the sender's account guard."
    (enforce-guard (at 'guard (read accounts sender))))

  ;; NOTE: there is deliberately NO `CREDIT` capability, and no marker
  ;; capability of any kind on the credit side. House rule: a capability body IS
  ;; the authorization decision, so a body that is trivially satisfiable states
  ;; nothing and must never be treated as a gate. A marker that gates nothing is
  ;; worse than no marker, because it reads like protection.
  ;; THE INVARIANT, which is what actually protects supply: a balance may rise
  ;; ONLY inside `transfer-create` (lexically fused with a real DEBIT, so supply
  ;; is conserved by construction), inside `init-mint` (behind the MINT keyset,
  ;; one-shot), or in the cross-chain receive resume (which requires a real SPV
  ;; continuation). Keep every balance increase inside one of those three, and
  ;; do not add a standalone credit path.

  (defcap MINT ()
    @doc "The one-shot initial mint, authorized by the community keyset.  \
         \Powerless after the mint (one-shot by construction)."
    (enforce-keyset ADMIN-KS))

  (defcap VOTE-KEY-ADMIN (account:string vote-authority:string)
    @doc "Owner gate for vote-key registration/clearing: the account's MAIN  \
         \guard, nobody else's — the hot key can never re-point itself. A    \
         \defcap (not a bare enforce) so wallets can SCOPE the signature to  \
         \exactly this action.                                               \
         \VOTE-AUTHORITY is the principal of the key being registered, or    \
         \\"\" when clearing. It is in the capability because the registered \
         \guard itself travels in tx DATA, which no wallet displays: without \
         \it, a compromised page could register an ATTACKER's voting key     \
         \under a signature the user checked and found correct. With it, a   \
         \substituted key changes what the wallet shows."
    (enforce-guard (at 'guard (read accounts account))))

  ;; EVENT CAPABILITIES. Every one of these carries a real body, by house rule:
  ;; an @event cap authorizes nothing - it only stamps the log - but a body that
  ;; asserts nothing makes the event meaningless, so each one requires the
  ;; capability that authorized the underlying action.
  ;;
  ;; HONEST LIMIT: that binds the AUTHORITY, not the PAYLOAD. Holding the right
  ;; to act for an account does not constrain the numbers a caller puts in the
  ;; event it emits. An event therefore proves that someone entitled to act did
  ;; so; it does not prove the figures inside it.
  ;; Anything published from this log must be reconciled against table state.
  ;; (Today nothing consumes these events: ops/src/distinct-voters.ts computes
  ;; turnout by reading the rcv-ballots TABLE, not by scanning blocks.)

  (defcap VOTE-KEY-SET (account:string key:string)
    @event
    (require-capability (VOTE-KEY-ADMIN account key)))

  (defcap VOTE-KEY-CLEARED (account:string)
    @event
    ;; Emitted from BOTH clear-vote-key (under VOTE-KEY-ADMIN) and rotate (under
    ;; ROTATE, which deactivates the hot key). Both hold the account's own guard,
    ;; so that is the common, real requirement.
    (enforce-guard (at 'guard (read accounts account))))

  (defcap ROTATE (account:string new-authority:string)
    @doc "Guard-rotation authorization: the account's CURRENT guard, scoped  \
         \to the account AND to the principal of the guard it is rotating    \
         \TO. Binding the destination matters: the new guard travels in tx   \
         \DATA, which no wallet displays, so a capability naming only the    \
         \account would let a compromised page install an ATTACKER's key     \
         \while the signature the user reviewed looked exactly right. With   \
         \NEW-AUTHORITY in the capability, substituting the key changes what \
         \the wallet shows, and a signature scoped to the intended new owner \
         \cannot be spent on a different one."
    (enforce-guard (at 'guard (read accounts account))))

  (defun ops-guard:guard ()
    @doc "The current ops authority. Defaults to the community keyset       \
         \guard until governance sets one, so a fresh deploy is operable    \
         \immediately and there is never an undefined-keyset abort."
    (with-default-read ops-auth OPS-KEY
      { "guard": (keyset-ref-guard ADMIN-KS) }
      { "guard" := g }
      g))

  (defcap OPS-ADMIN ()
    @doc "Governance re-points the ops authority. Gated on the community    \
         \keyset ALONE - deliberately NOT on FROZEN-MODULE - so that WHO    \
         \OPERATES stays recoverable even after code is frozen forever.     \
         \This is a disclosed governance power that survives a freeze; it   \
         \moves no funds and grants nothing beyond naming the ops tier."
    (enforce-keyset ADMIN-KS))

  (defcap OPS-GUARD-SET (authority:string)
    @event
    (require-capability (OPS-ADMIN)))

  (defcap NON-VOTING-SET (account:string reason:string)
    @event
    (require-capability (NON-VOTING-ADMIN)))

  (defcap NON-VOTING-CLEARED (account:string)
    @event
    (require-capability (NON-VOTING-ADMIN)))

  (defcap PROPOSAL-OPS ()
    @doc "Proposal administration gate: proposals are ADMIN-AUTHORED (the    \
         \community suggests questions on the public channels; the org puts  \
         \them on-chain). Routine tier: the ops authority creates and        \
         \cancels questions; the 2-of-3 governance keyset ALWAYS satisfies   \
         \this too, and is tried FIRST, so a broken or hostile ops authority \
         \can never lock governance out. DESIGN RATIONALE: open community    \
         \proposing was analysed and parked - with 3 global slots, any open  \
         \design needs stake locks plus admin cancel/seize backstops to      \
         \survive funded slot-squatting, at which point admin involvement is \
         \already structural; v1 takes honest full control instead."
    ;; BRANCH ORDER IS LOAD-BEARING - do not "tidy" it back.
    ;;
    ;; The ops branch reads `ops-auth` (inside ops-guard). On a chain where
    ;; that table does not exist - an upgrade-mode deploy that predates it -
    ;; the read raises a DATABASE error, and a database error is NOT
    ;; contained: `try` does not catch it and `enforce-one` does not swallow
    ;; it. Measured both ways on pact 5.4.
    ;;
    ;; This cap used to hoist that read into a `let` ABOVE the enforce-one,
    ;; which meant it ran before EITHER branch. Measured consequence: with the
    ;; full 2-of-3 governance keyset satisfied, create-proposal aborted with
    ;; "Table <ns>.pco_ops-auth not found" - so the governance tier was locked
    ;; out of set-open (the master kill switch), create-round and grant, and
    ;; set-ops-guard could not repair it because its write hits the same table.
    ;; The docstring above promised the opposite of what the code did.
    ;;
    ;; With the keyset branch FIRST and the read INSIDE the second branch,
    ;; enforce-one short-circuits and a satisfied governance keyset returns
    ;; before the read is ever reached. Same shape as
    ;; pco-gas-station.station-guard-pred, which got this right first.
    ;; Cost: one failed keyset check per ops-tier call.
    (enforce-one "governance or ops authority required"
      [ (enforce-keyset ADMIN-KS)
        (enforce-guard (ops-guard)) ]))

  (defcap VOTE (pid:string account:string)
    @doc "Vote authorization: the voter's MAIN account guard OR their ACTIVE \
         \registered vote key, scoped to one proposal so wallets never need  \
         \an unscoped signature to vote. The MAIN guard is tried FIRST, so   \
         \neither a hostile registration NOR a missing vote-delegates table  \
         \can lock an owner out of voting."
    ;; BRANCH ORDER IS LOAD-BEARING - do not "tidy" it back.
    ;;
    ;; The vote-key branch reads `vote-delegates`. This cap used to hoist that
    ;; read into a `let*` ABOVE the enforce-one, so it ran before EITHER branch.
    ;; Measured on pact 5.4: on a chain where that table does not exist (an
    ;; upgrade-mode deploy predating it - the P3b case), a holder could not vote
    ;; with their OWN main account guard; cast-vote aborted with
    ;; "Table <ns>.pco_vote-delegates not found". The docstring promised the
    ;; opposite. A database error is contained by neither `try` nor `enforce-one`,
    ;; so the only fix is to not perform the read until the branch needs it.
    ;;
    ;; Reads are safe HERE, in an enforce-one branch, on BOTH node lineages -
    ;; devnet-verified on KDA-CE 3.1 and upstream 2.29 (enforce-one's condition
    ;; environment is laxer than plain `enforce`'s). The let-bind house rule
    ;; applies to a read inside an `enforce` CONDITION, which this is not.
    ;; `active` is enforced BEFORE the guard, so the default guard below is
    ;; unreachable and exists only to satisfy with-default-read's binding.
    (enforce-one "neither account guard nor registered vote key satisfied"
      [ (enforce-guard (at 'guard (read accounts account)))
        (with-default-read vote-delegates account
          { "guard": (keyset-ref-guard ADMIN-KS), "active": false }
          { "guard" := g, "active" := a }
          (enforce a "no active vote key")
          (enforce-guard g)) ]))

  (defcap GOV-PROPOSED (id:string title:string options:[string] close-at:time)
    @event
    (require-capability (PROPOSAL-OPS)))

  (defcap GOV-VOTED (id:string account:string ranking:[integer] weight:decimal)
    @event
    (require-capability (VOTE id account)))

  (defcap GOV-CANCELLED (id:string reason:string)
    @event
    (require-capability (PROPOSAL-OPS)))

  (defcap TRANSFER:bool (sender:string receiver:string amount:decimal)
    @managed amount TRANSFER-mgr
    (enforce (!= sender receiver) "same sender and receiver")
    (enforce (> amount 0.0) "amount must be positive")
    (enforce-unit amount)
    (compose-capability (DEBIT sender)))

  (defun TRANSFER-mgr:decimal (managed:decimal requested:decimal)
    (let ((newbal (- managed requested)))
      (enforce (>= newbal 0.0) "TRANSFER exceeded for balance")
      newbal))

  (defcap TRANSFER_XCHAIN:bool
      (sender:string receiver:string amount:decimal target-chain:string)
    @managed amount TRANSFER_XCHAIN-mgr
    (enforce (> amount 0.0) "cross-chain amount must be positive")
    (enforce-unit amount)
    ;; a yield to a nonexistent chain would destroy the debited tokens with
    ;; no burn accounting - only real chains may be targeted, via coin's own
    ;; chain set rather than a list retyped here.
    ;; PRECISELY WHAT THAT BUYS, because an earlier version of this comment
    ;; overclaimed it ("coin's own canonical chain set, never a hardcoded copy"):
    ;; a foreign defconst is INLINED AT THIS MODULE'S COMPILE TIME, so what is
    ;; embedded is a COPY frozen at pco's deploy - measured on pact 5.4. Two
    ;; consequences, both worth knowing:
    ;;   * GOOD: a later `coin` upgrade cannot change or break this check, and
    ;;     VALID_CHAIN_IDS is pco's only reference into `coin` at all.
    ;;   * LIMIT: if Kadena ever runs more than these chains, pco must be
    ;;     REDEPLOYED to reach them - impossible once FROZEN-MODULE is set. The
    ;;     error direction is fail-safe (over-restrictive, never permissive).
    (enforce (contains target-chain coin.VALID_CHAIN_IDS)
      "target chain is not a valid chain id")
    (enforce (!= (at 'chain-id (chain-data)) target-chain)
      "cannot cross-chain transfer to the same chain")
    (compose-capability (DEBIT sender)))

  (defun TRANSFER_XCHAIN-mgr:decimal (managed:decimal requested:decimal)
    (enforce (>= managed requested) "cross-chain transfer exceeds installed amount")
    0.0) ; one-shot: a cross-chain signature covers exactly one send

  (defcap TRANSFER_XCHAIN_RECD:bool
      (sender:string receiver:string amount:decimal source-chain:string)
    @event
    ;; Required by fungible-xchain-v1 and emitted from the cross-chain RESUME,
    ;; where by construction no capability is held - the continuation's authority
    ;; IS the SPV proof, which is not expressible as a capability. So unlike the
    ;; other event caps this one cannot require an authorizing capability.
    ;; HONEST LIMIT, and it is stronger than "not proof": A THIRD PARTY CAN
    ;; FABRICATE ONE OF THESE FROM NOTHING. Every check below is satisfiable by
    ;; an uninvolved caller, and this capability - uniquely among ours - has no
    ;; authorizing capability it can require. Measured: a phantom 250,000-PCO
    ;; arrival, stamped with pco's real module hash, for a transfer that never
    ;; existed.
    ;; So NEVER read this event as evidence of anything - reconcile against
    ;; balances, which is the only honest source. Nothing on-chain consumes it,
    ;; and the participation tooling reads tables rather than events.
    ;; This is the ONE exception to the house rule stated above the event block
    ;; ("every event cap requires the capability that authorized the underlying
    ;; action"), and the exception is irreducible: fungible-xchain-v1 mandates the
    ;; capability, and the resume holds no capability to require. A guard inside
    ;; the body would not help - the cap's own frame would satisfy it.
    (enforce (> amount 0.0) "amount must be positive")
    (enforce (!= receiver "") "receiver must be named")
    (enforce (contains source-chain coin.VALID_CHAIN_IDS) "invalid source chain"))

  ;; -----------------------------
  ;; Account name protocol
  ;; -----------------------------

  (defun validate-account (account:string)
    @doc "Enforce account name length bounds and latin-1 charset."
    (enforce (is-charset CHARSET_LATIN1 account)
      (format "Account does not conform to the token contract charset: {}" [account]))
    (let ((account-length (length account)))
      (enforce (>= account-length MINIMUM_ACCOUNT_LENGTH)
        (format "Account name does not conform to the min length requirement: {}" [account]))
      (enforce (<= account-length MAXIMUM_ACCOUNT_LENGTH)
        (format "Account name does not conform to the max length requirement: {}" [account]))))

  (defun check-reserved:string (account:string)
    @doc "Return reserved-name protocol prefix ('k' for 'k:...'), or ''."
    (let ((pfx (take 2 account)))
      (if (= ":" (take -1 pfx)) (take 1 pfx) "")))

  (defun enforce-reserved:bool (account:string guard:guard)
    @doc "Enforce reserved account name protocols: a 'k:'-prefixed account \
         \must be the principal of its guard (prevents account squatting)."
    (if (validate-principal guard account)
      true
      (let ((r (check-reserved account)))
        (if (= r "")
          true
          (if (= r "k")
            (enforce false "Single-key account protocol violation")
            (enforce false
              (format "Reserved protocol guard violation: {}" [r])))))))

  ;; -----------------------------
  ;; fungible-v2 surface
  ;; -----------------------------

  (defun transfer:string (sender:string receiver:string amount:decimal)
    ;; Delegate to transfer-create with the receiver's EXISTING guard, so there is
    ;; exactly ONE credit code path (transfer-create), fused with a real debit.
    ;; with-read requires the receiver to already exist, preserving fungible-v2
    ;; `transfer` semantics (receiver must exist; use transfer-create otherwise).
    (with-read accounts receiver { "guard" := g }
      (transfer-create sender receiver g amount)))

  (defun transfer-create:string
      (sender:string receiver:string receiver-guard:guard amount:decimal)
    (with-capability (TRANSFER sender receiver amount)
      ;; DEBIT IS INLINED, not called. A standalone public `debit` is a BURN
      ;; path: it lowers a balance without raising another, and the supply row
      ;; never sees it, so `chain-minted` would over-report issuance forever.
      ;; Pact has no private functions, so the only way to make the debit
      ;; unreachable on its own is to not give it a name. Both checks below are
      ;; load-bearing - `(<= amount b)` alone admits a NEGATIVE amount, and
      ;; `(- b amount)` would then RAISE the balance.
      (require-capability (DEBIT sender))
      (enforce (> amount 0.0) "debit amount must be positive")
      (enforce-unit amount)
      (with-read accounts sender { "balance" := sb }
        (enforce (<= amount sb) "insufficient funds")
        (update accounts sender { "balance": (- sb amount) }))
      (release-votes sender)
      ;; The receiver credit is INLINED here, lexically fused with the debit above,
      ;; and is deliberately NOT exposed as a standalone balance-increasing function.
      ;; Because this path always performs a real, matching debit first (DEBIT enforces
      ;; the SENDER's own account guard), any caller can only move an account it
      ;; actually controls => supply is conserved, never minted. The writer is inlined
      ;; rather than factored into a shared function. Any change here MUST keep every
      ;; balance increase unreachable except behind a real debit, the MINT keyset, or
      ;; the cross-chain receive resume.
      (validate-account receiver)
      (enforce-reserved receiver receiver-guard)
      (with-default-read accounts receiver
        { "balance": 0.0, "guard": receiver-guard }
        { "balance" := b, "guard" := g }
        (enforce (= g receiver-guard) "account guard mismatch")
        (write accounts receiver { "balance": (+ b amount), "guard": g }))))

  ;; NOTE: there is deliberately NO public `debit`, for the same reason there is
  ;; no public credit: a standalone debit is a BURN, and this token has no burn
  ;; path by design. The balance DECREASE is inlined into exactly two places -
  ;; `transfer-create` (fused with the matching credit) and the cross-chain
  ;; step-0 (fused with the yield that credits on the target chain). Keep it
  ;; that way: every decrease must be paired with a corresponding increase, or
  ;; supply silently drifts away from `chain-minted`.

  ;; NOTE: there is deliberately NO public `credit-minted`. A standalone
  ;; balance-increasing function whose one-shot and exact-supply checks live in
  ;; its CALLER is a wrapper-trust hole: the function is a public entry point in
  ;; its own right, and MINT is satisfiable in any transaction carrying the
  ;; governance signatures - so the checks must not live one level up. The write
  ;; is INLINED into `init-mint`, behind that function's own one-shot supply-row
  ;; gate and its exact-TOTAL-SUPPLY check. Do not factor it back out.

  (defun get-balance:decimal (account:string)
    (at 'balance (read accounts account)))

  (defun get-balance-default:decimal (account:string)
    @doc "Balance of an account that MAY NOT EXIST, as 0.0. Read-only.        \
         \                                                                    \
         \`get-balance` must keep raising on a missing account - fungible-v2   \
         \requires it, and callers rely on it - so this is a separate name     \
         \rather than a relaxation of that one.                               \
         \                                                                    \
         \It exists because `pco-claim`'s freeze interlock asks whether the    \
         \pool still holds tokens, and on 19 of the 20 chains the pool row has \
         \never been written: the mint happens on the hub only. `read` raises  \
         \there, so the interlock aborted the freeze deploy on every non-hub   \
         \chain - refusing a freeze because the pool is EMPTY, which is the    \
         \opposite of what it is for. `with-default-read` covers a missing ROW \
         \(it does NOT cover a missing TABLE, which stays an abort, correctly: \
         \a chain with no `accounts` table is broken, not empty)."
    (with-default-read accounts account
      { "balance": 0.0 } { "balance" := b } b))

  (defun details:object{fungible-v2.account-details} (account:string)
    (with-read accounts account { "balance" := b, "guard" := g }
      { "account": account, "balance": b, "guard": g }))

  (defun precision:integer ()
    PRECISION)

  (defun enforce-unit:bool (amount:decimal)
    (enforce (= (floor amount PRECISION) amount) "precision violation"))

  (defun create-account:string (account:string guard:guard)
    (validate-account account)
    (enforce-reserved account guard)
    (insert accounts account { "balance": 0.0, "guard": guard })
    (format "created {}" [account]))

  (defun rotate:string (account:string new-guard:guard)
    ;; principal accounts must not rotate away from their proper guard -
    ;; a rotated 'k:' account would falsify the reserved-name protocol.
    (enforce (or (not (is-principal account))
                 (validate-principal new-guard account))
      "It is unsafe for principal accounts to rotate their guard")
    (with-capability (ROTATE account (create-principal new-guard))
      (update accounts account { "guard": new-guard })
      ;; a guard hand-over must not leave the PREVIOUS owner's vote key live:
      ;; deactivate any active registration so the new owner starts clean
      (with-default-read vote-delegates account
        { "active": false } { "active" := a }
        (if a
            (let ((_ (update vote-delegates account { "active": false })))
              (emit-event (VOTE-KEY-CLEARED account)))
            true)))
    (format "rotated {}" [account]))

  ;; -----------------------------
  ;; fungible-xchain-v1 — transfer-crosschain (2-step SPV defpact)
  ;; -----------------------------

  (defpact transfer-crosschain:string
      (sender:string receiver:string receiver-guard:guard
       target-chain:string amount:decimal)
    (step
      (with-capability (TRANSFER_XCHAIN sender receiver amount target-chain)
        (validate-account sender)
        (validate-account receiver)
        ;; CROSS-CHAIN RECEIVERS MUST BE PRINCIPALS. Checked HERE, on the source
        ;; chain, before anything is debited, because step 1 has NO rollback: a
        ;; receiver/guard pair that step 1 cannot credit destroys the debited
        ;; tokens outright, with no burn accounting (chain-minted keeps reporting
        ;; full supply). Two distinct ways that happens, and this one enforce
        ;; closes both:
        ;;   1. A mismatched reserved pair ("k:<hex>" with a different key's
        ;;      guard) fails enforce-reserved at credit time. That predicate is
        ;;      pure in (account, guard) and both are frozen into the yield, so
        ;;      it would fail on every chain, forever.
        ;;   2. A VANITY (non-principal) name is squattable. Its guard is not
        ;;      derivable from the name, so ANY observer of the public yield can
        ;;      create that account on the TARGET chain under their own guard
        ;;      before the continuation lands; credit then dies on the "account
        ;;      guard mismatch" check against the row that already exists. That
        ;;      is a permanent third-party griefing kill on someone else's funds.
        ;; validate-principal subsumes enforce-reserved here and closes both.
        ;; It costs nothing real: the pool (m:), the reserve (r:) and every
        ;; holder account (k:) are principals, and a principal's guard IS its
        ;; name, so it cannot be squatted. Vanity names remain fully usable for
        ;; same-chain transfers.
        (enforce (validate-principal receiver-guard receiver)
          "cross-chain receiver must be the principal of its guard")
        ;; Inlined debit (there is no standalone one - see transfer-create).
        ;; It releases the moved weight from every open vote on THIS chain
        ;; before the tokens leave it, and it is fused with the yield below, so
        ;; the decrease is always paired with a credit on the target chain.
        (require-capability (DEBIT sender))
        (enforce (> amount 0.0) "debit amount must be positive")
        (enforce-unit amount)
        (with-read accounts sender { "balance" := sb }
          (enforce (<= amount sb) "insufficient funds")
          (update accounts sender { "balance": (- sb amount) }))
        (release-votes sender)
        (emit-event (TRANSFER sender "" amount))
        (yield
          { "receiver": receiver, "receiver-guard": receiver-guard
          , "amount": amount, "source-chain": (at 'chain-id (chain-data)) }
          target-chain)))
    (step
      (resume
        { "receiver" := receiver, "receiver-guard" := rg
        , "amount" := amount, "source-chain" := source-chain }
        (emit-event (TRANSFER "" receiver amount))
        ;; Inlined credit (no standalone balance-increasing writer — see transfer-create).
        ;; Safe: this step only runs as the SPV/defpact resume of a real cross-chain
        ;; send whose source-chain step already debited `amount` - the resume
        ;; requires a real SPV continuation. receiver was validate-principal'd above.
        (enforce (> amount 0.0) "credit amount must be positive")
        (enforce-unit amount)
        (validate-account receiver)
        (enforce-reserved receiver rg)
        (with-default-read accounts receiver
          { "balance": 0.0, "guard": rg }
          { "balance" := b, "guard" := g }
          (enforce (= g rg) "account guard mismatch")
          (write accounts receiver { "balance": (+ b amount), "guard": g }))
        (emit-event (TRANSFER_XCHAIN_RECD "" receiver amount source-chain))
        "cross-chain credit ok")))

  ;; -----------------------------
  ;; One-shot mint + supply view
  ;; -----------------------------

  (defun init-mint:string (recipients:[object{recipient}])
    @doc "One-shot: mint EXACTLY TOTAL-SUPPLY across the recipients, on the  \
         \hub chain only. One-shot AS A FUNCTION: the supply row is seeded   \
         \{0.0, 0.0} at deploy and this call requires minted = 0.0, so a     \
         \second call through this path is impossible.                       \
         \HONEST LIMIT: that gate binds the                                 \
         \FUNCTION, not the governance keyset. `minted` is an ordinary table \
         \row, and while the module is unfrozen the 2-of-3 keyset can        \
         \acquire module admin, reset the row, and mint again - just as it   \
         \could simply UPGRADE the module to do anything at all. Fixed       \
         \supply is therefore a property of governance restraint plus the    \
         \FROZEN-MODULE flip, NOT a property this function can enforce       \
         \alone. Upgradeability is disclosed in the README; do not read this \
         \gate as making the keyset powerless over supply.                   \
         \Distribute to principal (k:/w:/c:/r:) accounts, or mint in a       \
         \transaction that guarantees the recipient rows: a pre-created      \
         \vanity name under a foreign guard aborts the mint (griefing, not   \
         \theft)."
    (with-capability (MINT)
      (let ((chain (at 'chain-id (chain-data))))
        (enforce (= chain GOV-CHAIN) "mint happens on the hub chain only"))
      (let ((already (at 'minted (read supply SUPPLY-KEY))))
        (enforce (= already 0.0) "already minted"))
      (update supply SUPPLY-KEY { "minted": TOTAL-SUPPLY })
      (let ((total (fold (lambda (acc:decimal r:object{recipient})
                           (+ acc (at 'amount r)))
                         0.0 recipients)))
        (enforce (= total TOTAL-SUPPLY) "mint must distribute exactly TOTAL-SUPPLY"))
      (map (lambda (r:object{recipient})
             (let ((amt:decimal (at 'amount r))
                   (acct:string (at 'account r))
                   (g0:guard (at 'guard r)))
               (enforce (> amt 0.0) "recipient amount must be positive")
               (enforce-unit amt)
               ;; Inlined credit — see the note where `credit-minted` used to be.
               ;; The only balance increase behind the MINT keyset, and it is
               ;; unreachable except through this function's one-shot supply-row
               ;; gate and the exact-TOTAL-SUPPLY check above.
               (validate-account acct)
               (enforce-reserved acct g0)
               (with-default-read accounts acct
                 { "balance": 0.0, "guard": g0 }
                 { "balance" := b, "guard" := g }
                 (enforce (= g g0) "account guard mismatch")
                 (write accounts acct { "balance": (+ b amt), "guard": g }))))
           recipients)
      "minted"))

  (defun chain-minted:decimal ()
    @doc "Amount minted on THIS chain (TOTAL-SUPPLY on the hub after the    \
         \mint; 0.0 everywhere else).                                       \
         \NOT a supply audit. This reads the supply ROW, which only          \
         \init-mint maintains. Credits made by governance through module     \
         \admin do not touch it, so while this module is unfrozen the figure \
         \is a lower bound on issuance, not a measurement of it. Sum the     \
         \account balances if you need ground truth, and treat this number   \
         \as authoritative only once FROZEN-MODULE is set."
    (with-default-read supply SUPPLY-KEY { "minted": 0.0 } { "minted" := m } m))

  ;; -----------------------------
  ;; Advisory governance (hub chain only)
  ;; -----------------------------

  (defun curr-time:time ()
    (at 'block-time (chain-data)))

  (defun enforce-hub:bool ()
    @doc "Proposals and votes exist only on the hub chain."
    (enforce (= (at 'chain-id (chain-data)) GOV-CHAIN)
      "governance lives on the hub chain only"))

  (defun reserve-account:string ()
    @doc "The community reserve account name (cannot vote)."
    RESERVE-ACCOUNT)

  ;; -----------------------------
  ;; Accounts outside the float (non-voting register)
  ;; -----------------------------

  (defun non-voting?:bool (account:string)
    @doc "True if ACCOUNT is registered as an escrow outside the float. The \
         \community reserve is excluded separately, by name, since this      \
         \module derives it itself."
    (with-default-read non-voting account
      { "reason": "" } { "reason" := r }
      (!= r "")))

  (defun non-voting-reason:string (account:string)
    @doc "Why an account is excluded, for anyone auditing the register."
    (with-default-read non-voting account
      { "reason": "" } { "reason" := r }
      r))

  (defcap NON-VOTING-ADMIN ()
    @doc "Register or release an account as outside the float. The community \
         \keyset, and deliberately NOT gated on FROZEN-MODULE - the register  \
         \must stay correctable after the code is frozen, because getting it  \
         \wrong in either direction distorts a published tally.               \
         \                                                                    \
         \BE PRECISE ABOUT WHAT THIS GRANTS. It moves no funds. It is not     \
         \limited to escrows either: there is no on-chain predicate for \"is  \
         \an escrow\", and a principal-TYPE rule was deliberately rejected    \
         \(see cast-vote-internal), so the register accepts ANY account name. \
         \Governance can therefore bar a named, ordinary holder from voting,  \
         \and that power outlives the freeze by design. What bounds it is     \
         \disclosure, not code: every entry carries a mandatory public reason \
         \and emits NON-VOTING-SET, and removal emits NON-VOTING-CLEARED, so  \
         \the register is auditable from chain history at any time."
    (enforce-keyset ADMIN-KS))

  (defun register-non-voting:string (account:string reason:string)
    @doc "Record ACCOUNT as an escrow whose holdings are not part of the      \
         \float and therefore carry no vote.                                  \
         \                                                                    \
         \Called by the module that OWNS the escrow, from its own deploy, so  \
         \the exclusion lands with the escrow rather than depending on a      \
         \ceremony step somebody has to remember. That is also how this       \
         \module learns the claim pool's principal: `pco-claim` depends on    \
         \`pco`, so `pco` naming it directly would be circular - instead the  \
         \owner registers itself, in the direction the dependency already     \
         \runs. Governance may register any other escrow (for example the gas \
         \station's coin account) at any time.                                \
         \REASON is mandatory and public: the register is meant to be read."
    (with-capability (NON-VOTING-ADMIN)
      (validate-account account)
      (enforce (!= "" reason) "a public reason is required")
      (write non-voting account { "reason": reason })
      (emit-event (NON-VOTING-SET account reason))
      (format "{} registered as non-voting" [account])))

  (defun release-non-voting:string (account:string)
    @doc "Remove an account from the register - the correction path if an     \
         \account was excluded in error. Distributed holdings must never be   \
         \silently disenfranchised, so this exists and is evented."
    (with-capability (NON-VOTING-ADMIN)
      (with-read non-voting account { "reason" := r }
        (enforce (!= r "") "account is not registered"))
      (write non-voting account { "reason": "" })
      (emit-event (NON-VOTING-CLEARED account))
      (format "{} released" [account])))

  (defun set-ops-guard:string (g:guard)
    @doc "Governance names the ops authority (routine tier for this module  \
         \AND for pco-claim, which reads this one value - so one call       \
         \rotates ops everywhere). ALWAYS available to the community        \
         \keyset, including after FROZEN-MODULE: a lost or compromised ops  \
         \device is replaced here, with no code upgrade, on any chain,      \
         \forever. Ops itself can never call this. ONLY a plain keyset      \
         \guard is accepted (principal k: or w:) - see the enforce below."
    (with-capability (OPS-ADMIN)
      ;; A guard is not introspectable, but its PRINCIPAL is a faithful,
      ;; total encoding of it - so validate the principal. Three checks,
      ;; each closing a shape that governance could store by mistake and
      ;; then have to notice the hard way.
      (let ((p (create-principal g)))

        ;; 1. TYPE. The first two characters are the guard's type tag:
        ;;      k:/w: literal keyset - inert data, always evaluable   ACCEPT
        ;;      r:    keyset REFERENCE - an undefined name (typo, or a
        ;;            keyset never created on THIS chain) makes every
        ;;            ops call die on a lookup error that enforce-one
        ;;            cannot catch; and it re-opens the redefinition
        ;;            hijack this table exists to remove              REJECT
        ;;      u:    user guard - runs module code at authorization
        ;;            time; a table read in it is a rug-pull surface   REJECT
        ;;      c:/p: capability & pact guards - no signer satisfies   REJECT
        (enforce (or (= "k:" (take 2 p)) (= "w:" (take 2 p)))
          (format "ops authority must be a plain keyset guard, not {}" [(take 2 p)]))

        ;; 2. PREDICATE. A `k:` principal is by construction ONE real key
        ;; under keys-all, so it needs nothing further. A `w:` principal
        ;; carries its predicate verbatim as the suffix, and a keyset may
        ;; name a CUSTOM predicate (`ns.module.fn`) - which runs module
        ;; code at authorization time, exactly the hazard user guards are
        ;; refused for. Such a predicate can be permanently open (any
        ;; stranger holds ops) or abort-prone (ops silently frozen).
        ;; Allow only the three builtins.
        ;; KNOWN GAP: a principal encodes the key-list
        ;; HASH, not the key COUNT, so an UNSATISFIABLE keyset - e.g. keys-2
        ;; over a single key - passes all three checks. Storing one bricks the
        ;; ops tier. It is not a security hole and it is fully recoverable:
        ;; governance is tried FIRST in both enforce-one gates, and OPS-ADMIN
        ;; is governance-only, so governance simply calls this again. Verify
        ;; the key count off-chain before signing; it cannot be checked here.
        (enforce (or (= "k:" (take 2 p))
                 (or (= ":keys-all" (take -9 p))
                 (or (= ":keys-any" (take -9 p))
                     (= ":keys-2"   (take -7 p)))))
          "ops keyset must use a builtin predicate (keys-all, keys-any, keys-2)")

        ;; 3. NON-EMPTY. `keys-all` over ZERO keys is VACUOUSLY TRUE: it
        ;; would hand the routine tier - create-round, set-open, and the
        ;; bounded grant path out of the pool - to anyone signing nothing
        ;; at all. That fails OPEN, so it is strictly worse than any
        ;; shape above. The key-list hash of an empty keyset is a
        ;; constant, so every empty keyset shares one principal prefix
        ;; whatever its predicate; reject all of them.
        (enforce (!= EMPTY-KEYSET-PREFIX (take 45 p))
          "ops keyset must not be empty")

        (write ops-auth OPS-KEY { "guard": g })
        (emit-event (OPS-GUARD-SET p))))
    "ops guard set")

  (defun open-ids:[string] ()
    @doc "Currently OPEN proposal ids (pruned view of the active index)."
    (let ((now (curr-time)))
      (with-default-read rcv-actives ACTIVE-KEY { "ids": [] } { "ids" := ids }
        (filter (lambda (pid:string)
                  (< now (at 'close-at (read rcv-proposals pid))))
                ids))))

  (defun create-proposal:string
      (title:string body:string options:[string] duration-hours:integer)
    @doc "Open an ADMIN-AUTHORED ranked-choice question (ops tier; the       \
         \governance keyset always works too). 2..MAX-OPTIONS distinct named \
         \options; voters rank them. At most MAX-ACTIVE-PROPOSALS open. The  \
         \community suggests questions on the public channels - the org      \
         \makes them official here."
    (enforce-hub)
    (enforce (and (>= duration-hours MIN-VOTE-HOURS) (<= duration-hours MAX-VOTE-HOURS))
      "duration outside [24h, 720h]")
    (enforce (and (> (length title) 0) (<= (length title) 120)) "title 1..120 chars")
    (enforce (<= (length body) 2000) "body <= 2000 chars")
    (let ((k (length options)))
      (enforce (and (>= k 2) (<= k MAX-OPTIONS))
        "2..5 options required")
      (enforce (= k (length (distinct options))) "options must be distinct")
      (map (lambda (o:string)
             (enforce (and (> (length o) 0) (<= (length o) 60))
               "each option 1..60 chars"))
           options))
    (with-capability (PROPOSAL-OPS)
      (let* ((open (open-ids))
             (n (with-default-read gov-counts COUNT-KEY { "n": 0 } { "n" := c } c))
             (pid (int-to-str 10 (+ n 1)))
             (now (curr-time))
             (close (add-time now (hours duration-hours))))
        (enforce (< (length open) MAX-ACTIVE-PROPOSALS) "too many active proposals")
        (write gov-counts COUNT-KEY { "n": (+ n 1) })
        (insert rcv-proposals pid
          { "title": title, "body": body, "options": options
          , "created": now, "close-at": close
          , "scores": (map (lambda (o:string) 0.0) options)
          , "turnout": 0.0 })
        ;; the authoritative pairwise record, K x K zeros. Created HERE so that
        ;; every proposal opened under this module has a complete record from
        ;; its first ballot; a question opened before this existed has no row and
        ;; get-head-to-head says so rather than showing a partial matrix.
        (insert rcv-margins pid
          { "m": (map (lambda (_i:integer) 0.0)
                      (enumerate 0 (- (* (length options) (length options)) 1))) })
        (write rcv-actives ACTIVE-KEY { "ids": (+ open [pid]) })
        (emit-event (GOV-PROPOSED pid title options close))
        pid)))

  (defun admin-cancel-proposal:string (pid:string reason:string)
    @doc "Close PID immediately (ops tier): tallies freeze where they stand  \
         \and the slot frees. A public REASON is mandatory and emitted -     \
         \cancellations are accountable, on-chain, forever."
    (enforce (and (> (length reason) 0) (<= (length reason) 2000))
      "a public reason is required (1..2000 chars)")
    (with-capability (PROPOSAL-OPS)
      (let ((now (curr-time)))
        (with-read rcv-proposals pid { "close-at" := ca }
          (enforce (< now ca) "proposal already closed")
          (update rcv-proposals pid { "close-at": now }))
        (emit-event (GOV-CANCELLED pid reason))))
    "cancelled")

  (defun rank-pos:integer (ranking:[integer] opt:integer)
    @doc "Position of OPT in RANKING (0 = first choice), or -1 if unranked.  \
         \Total on the empty ranking (callers never store one with weight)."
    (if (= 0 (length ranking))
        -1
        (fold (lambda (acc:integer j:integer)
                (if (= (at j ranking) opt) j acc))
              -1
              (enumerate 0 (- (length ranking) 1)))))

  (defun borda-apply:[decimal]
      (scores:[decimal] options:[string] ranking:[integer] delta:decimal)
    @doc "SCORES with DELTA-weighted Borda points of RANKING applied: an     \
         \option ranked at position p (0-based) gains delta*(K-p) points     \
         \(first of K options = K points); unranked options are untouched.   \
         \Negative delta removes a prior contribution exactly.               \
         \                                                                   \
         \THIS IS NOT THE RESULT. These scores are retained and published as \
         \a TRUNCATION DIAGNOSTIC, not as the verdict: under this formula a  \
         \length-1 ballot gives its favourite a margin of delta*K over the   \
         \strongest rival while a full ranking gives delta*1, so truncating  \
         \is strictly dominant and the total moves 2x-3x on identical        \
         \preferences. Compare the score total against turnout*K*(K+1)/2 to  \
         \read how complete the ballots were. The authoritative result is    \
         \the head-to-head matrix (see rcv-margin and get-head-to-head)."
    (let ((k (length options)))
      (map (lambda (i:integer)
             (let ((p (rank-pos ranking i)))
               (if (= p -1)
                   (at i scores)
                   (+ (at i scores) (* delta (- k p))))))
           (enumerate 0 (- k 1)))))

  (defun margins-apply:[decimal]
      (m:[decimal] k:integer ranking:[integer] delta:decimal)
    @doc "M with DELTA applied to every ordered pair RANKING expresses.      \
         \A ballot expresses i > j exactly when i is ranked AND j is either  \
         \unranked or ranked later - ranked options beat unranked ones, and  \
         \two unranked options say nothing about each other. That single     \
         \convention is what makes the cell depth-neutral: whether or not j  \
         \appears, a ballot ranking i first always credits m[i][j].          \
         \Negative delta removes a prior contribution exactly, so the matrix \
         \is reversible to zero (the coefficients are only 0 or 1, so no     \
         \rounding is possible at any precision).                            \
         \Index n is row-major: i = n / k, j = n mod k. The diagonal (i = j) \
         \is never written."
    (let ((pos (map (lambda (i:integer) (rank-pos ranking i))
                    (enumerate 0 (- k 1)))))
      (map (lambda (n:integer)
             (let ((i (/ n k))
                   (j (mod n k)))
               (if (= i j)
                   (at n m)
                   (let ((pi (at i pos))
                         (pj (at j pos)))
                     (if (and (!= pi -1) (or (= pj -1) (< pi pj)))
                         (+ (at n m) delta)
                         (at n m))))))
           (enumerate 0 (- (* k k) 1)))))

  (defun apply-ballot-swap:[decimal]
      (m:[decimal] k:integer old-r:[integer] old-w:decimal
       new-r:[integer] new-w:decimal)
    @doc "PURE math: return M with one ballot's pairwise contribution swapped - \
         \remove OLD-R at OLD-W, then add NEW-R at NEW-W. NO write, NO capability, \
         \NO state read: safe to be public because it cannot mutate anything. The \
         \authoritative `(update rcv-margins ...)` write is INLINED at the two real \
         \callers (cast-vote-internal, release-votes) rather than exposed as its own \
         \function, so the tally can only be written from a genuine vote or release. \
         \K is passed by the in-module caller as the real option count (never a \
         \smaller value, which would truncate the stored row)."
    (let ((cleared (if (> old-w 0.0) (margins-apply m k old-r (- old-w)) m)))
      (if (> new-w 0.0) (margins-apply cleared k new-r new-w) cleared)))

  (defun cast-vote:string (pid:string account:string ranking:[integer])
    @doc "Rank the proposal's options (ordered option indices, best first;   \
         \a partial ranking is allowed - unranked options score nothing).    \
         \Weight = CURRENT hub-chain balance; re-voting replaces the ballot  \
         \in place. Authorized by the account's main guard OR its registered \
         \vote key. The community reserve is barred."
    (with-capability (VOTE pid account)
      (cast-vote-internal pid account ranking)))

  (defun cast-vote-internal:string (pid:string account:string ranking:[integer])
    @doc "The ballot write. EVERY precondition is enforced HERE, behind the VOTE  \
         \capability - never only in the cast-vote wrapper. Pact has no private   \
         \functions, so this function is publicly callable; a caller that holds    \
         \VOTE for an account it controls must still pass every check. If the hub / \
         \close-time / ranking checks lived only in the wrapper, such a caller could \
         \deface the published scores with an oversized ranking or mutate the       \
         \authoritative result after the proposal closed. A public function must    \
         \never trust its wrapper - all invariants are re-asserted here."
    (require-capability (VOTE pid account))
    (enforce-hub)
    (enforce (!= account RESERVE-ACCOUNT) "the community reserve cannot vote")
    ;; Escrows that are NOT part of the float do not vote. This is an explicit
    ;; register of named accounts, not a rule about account TYPES: what
    ;; disqualifies the claim pool is that it holds undistributed community
    ;; tokens, not that it happens to be module-guarded. A type rule would also
    ;; disenfranchise participants who legitimately hold through a contract, and
    ;; would still miss an escrow held under an ordinary (non-principal) name.
    ;; Entries are registered by the module that OWNS the escrow, at its own
    ;; deploy - see register-non-voting - which is how `pco` learns the claim
    ;; pool's principal without referencing `pco-claim` (that module depends on
    ;; this one, so naming it here would be circular).
    ;; Like the reserve bar this is a NAME check, not a lock on governance: while
    ;; this module is unfrozen the keyset can move escrowed tokens into an
    ;; ordinary account and vote them. That route emits a public TRANSFER event;
    ;; module admin can also write scores directly, emitting nothing.
    (enforce (not (non-voting? account))
      "this account is registered as non-voting (an escrow outside the float)")
    (with-read rcv-proposals pid
      { "close-at" := close, "options" := opts, "scores" := ss, "turnout" := tn }
      (enforce (< (curr-time) close) "voting closed")
      (let ((k (length opts))
            (r (length ranking)))
        (enforce (and (>= r 1) (<= r k)) "ranking: 1..K entries")
        (enforce (= r (length (distinct ranking))) "ranking entries must be distinct")
        (map (lambda (o:integer)
               (enforce (and (>= o 0) (< o k)) "ranking entry out of range"))
             ranking))
      (let ((weight (at 'balance (read accounts account)))
            (vkey (format "{}:{}" [pid account])))
        (enforce (> weight 0.0) "no voting weight")
        (with-default-read rcv-ballots vkey { "ranking": [], "weight": 0.0 }
          { "ranking" := old-r, "weight" := old-w }
          ;; remove the previous ballot's contribution, then add the new one
          (let* ((cleared (if (> old-w 0.0)
                              (borda-apply ss opts old-r (- old-w))
                              ss))
                 (applied (borda-apply cleared opts ranking weight)))
            (update rcv-proposals pid
              { "scores": applied, "turnout": (+ (- tn old-w) weight) })
            ;; the authoritative aggregate: swap this ballot's pairwise
            ;; contribution the same way, from the same two (ranking, weight)
            ;; pairs, so the two records can never drift apart. INLINED (no
            ;; standalone tally writer — this call already holds real
            ;; VOTE and derives every value from state; k = real option count).
            ;; A pre-tally proposal has no margin row: no-op on purpose (F2).
            (let ((k (length opts)))
              (with-default-read rcv-margins pid { "m": [] } { "m" := mm }
                (if (> (length mm) 0)
                    (update rcv-margins pid
                      { "m": (apply-ballot-swap mm k old-r old-w ranking weight) })
                    "no pairwise record for this proposal")))
            (write rcv-ballots vkey { "ranking": ranking, "weight": weight })))
        (emit-event (GOV-VOTED pid account ranking weight))
        "vote recorded")))

  (defun release-votes:string (account:string)
    @doc "Permissionless vote-weight sync: shrink the account's recorded    \
         \ballot weight on every OPEN proposal down to its CURRENT balance  \
         \(the live-vote release rule) - the excess Borda points leave the  \
         \scores. Derives everything from real state, so a public call can  \
         \only correct stale weights, never forge ballots. Called           \
         \automatically after every balance decrease."
    (let ((bal (with-default-read accounts account { "balance": 0.0 } { "balance" := b } b)))
      (map (lambda (pid:string)
             (let ((vkey (format "{}:{}" [pid account])))
               (with-default-read rcv-ballots vkey { "ranking": [], "weight": 0.0 }
                 { "ranking" := r, "weight" := w }
                 (if (> w bal)
                   (let ((excess (- w bal)))
                     (with-read rcv-proposals pid
                       { "options" := opts, "scores" := ss, "turnout" := tn }
                       (update rcv-proposals pid
                         { "scores": (borda-apply ss opts r (- excess))
                         , "turnout": (- tn excess) })
                       ;; shrink the pairwise record by the same excess: pass an
                       ;; EMPTY new ranking, so this removes and adds nothing back.
                       ;; INLINED (no standalone tally writer); everything
                       ;; is derived from real state, so a public call can only
                       ;; correct stale weights, never forge. k = real option count.
                       (let ((k (length opts)))
                         (with-default-read rcv-margins pid { "m": [] } { "m" := mm }
                           (if (> (length mm) 0)
                               (update rcv-margins pid
                                 { "m": (apply-ballot-swap mm k r excess [] 0.0) })
                               "no pairwise record for this proposal"))))
                     (update rcv-ballots vkey { "weight": bal })
                     "released")
                   "unchanged"))))
           (open-ids))
      "synced"))

  (defun get-proposal:object{rcv-proposal} (pid:string)
    (read rcv-proposals pid))

  (defun get-ballot:object{rcv-ballot} (pid:string account:string)
    (read rcv-ballots (format "{}:{}" [pid account])))

  (defun get-results:object (pid:string)
    @doc "Options + Borda scores + turnout + closed flag. The SCORES here are \
         \a truncation DIAGNOSTIC, not the result - see borda-apply. For the  \
         \authoritative outcome call get-head-to-head. ADVISORY either way:   \
         \no quorum, nothing executes."
    (with-read rcv-proposals pid
      { "title" := t, "close-at" := ca, "options" := o
      , "scores" := s, "turnout" := tn }
      { "title": t, "options": o, "scores": s, "turnout": tn
      , "close-at": ca, "closed": (>= (curr-time) ca) }))

  (defun h2h-wins:[decimal] (m:[decimal] k:integer)
    @doc "Copeland win-count per option: how many of the other K-1 options it \
         \beats head to head. A strict majority is required to count a win, so \
         \an exact pairwise tie credits neither side."
    (map (lambda (i:integer)
           (fold (lambda (acc:decimal j:integer)
                   (if (or (= i j)
                           (<= (at (+ (* i k) j) m) (at (+ (* j k) i) m)))
                       acc
                       (+ acc 1.0)))
                 0.0
                 (enumerate 0 (- k 1))))
         (enumerate 0 (- k 1))))

  (defun get-head-to-head:object (pid:string)
    @doc "THE AUTHORITATIVE ADVISORY RESULT for PID.                          \
         \  pairs      - the K x K matrix, row-major: pairs[i*K + j] is the   \
         \               ballot weight preferring option i to option j        \
         \  wins       - Copeland count per option (beats this many others)    \
         \  condorcet  - the option that beats EVERY other head to head, or    \
         \               \"\" when none does (a cycle, or an exact tie)        \
         \  available  - false for questions opened before the pairwise record \
         \               existed; their pairs/wins are empty and MUST NOT be   \
         \               presented as a result                                 \
         \Still advisory: nothing executes, there is no quorum, and a cycle is \
         \a real possible outcome that should be reported as one rather than   \
         \broken by an arbitrary rule."
    (with-read rcv-proposals pid
      { "title" := t, "close-at" := ca, "options" := o, "turnout" := tn }
      (let ((k (length o)))
        (with-default-read rcv-margins pid { "m": [] } { "m" := m }
          (if (= 0 (length m))
              { "title": t, "options": o, "turnout": tn
              , "close-at": ca, "closed": (>= (curr-time) ca)
              , "available": false, "pairs": [], "wins": [], "condorcet": "" }
              (let* ((wins (h2h-wins m k))
                     (top (- (dec k) 1.0))
                     (cw (fold (lambda (acc:string i:integer)
                                 (if (= (at i wins) top) (at i o) acc))
                               "" (enumerate 0 (- k 1)))))
                { "title": t, "options": o, "turnout": tn
                , "close-at": ca, "closed": (>= (curr-time) ca)
                , "available": true, "pairs": m, "wins": wins
                , "condorcet": cw }))))))

  ;; ---- dedicated voting key (hot key votes; the main key stays cold) ----

  (defun set-vote-key:string (account:string guard:guard)
    @doc "Register/replace the account's dedicated voting guard. MAIN account \
         \guard only (via VOTE-KEY-ADMIN — scope your signature to it): the   \
         \hot key can never re-point itself. The vote key can ONLY vote —     \
         \transfers, rotation, and this registration stay with the main       \
         \guard. Use a PLAIN keyset for the vote key: a user guard whose      \
         \predicate reads module tables can fail at vote time, and a          \
         \keyset-ref to an UNDEFINED keyset aborts the whole vote (the main   \
         \guard still votes either way — re-register to recover). Rotating    \
         \the account guard deactivates any registered vote key.              \
         \Meaningful on the hub chain, where all voting lives."
    (let ((vk (create-principal guard)))
      (with-capability (VOTE-KEY-ADMIN account vk)
        (write vote-delegates account { "guard": guard, "active": true })
        (emit-event (VOTE-KEY-SET account vk))))
    "vote key set")

  (defun clear-vote-key:string (account:string)
    @doc "Deactivate the account's voting key (MAIN guard via                 \
         \VOTE-KEY-ADMIN). Requires a prior registration; voting falls back   \
         \to the main guard alone."
    (with-capability (VOTE-KEY-ADMIN account "")
      (update vote-delegates account { "active": false })
      (emit-event (VOTE-KEY-CLEARED account)))
    "vote key cleared")

  (defun get-vote-key:object{vote-delegate} (account:string)
    @doc "Read-only: the account's vote-key registration ({guard, active});  \
         \an inactive main-guard default when never registered."
    (with-default-read vote-delegates account
      { "guard": (at 'guard (read accounts account)), "active": false }
      { "guard" := g, "active" := a }
      { "guard": g, "active": a }))
)

;; Deploy footer — two modes via tx data:
;;   upgrade:false  FRESH deploy: create tables + seed the per-chain supply row.
;;   upgrade:true   upgrade: touch nothing (create-table re-runs abort upgrades).
;;                  Adding NEW tables to an already-deployed chain is a
;;                  separate one-off admin tx PER TABLE, for ALL SEVEN of:
;;                    vote-delegates, rcv-proposals, rcv-ballots, rcv-actives,
;;                    ops-auth, rcv-margins, non-voting
;;                  ((acquire-module-admin <ns>.pco) (create-table <ns>.pco.<t>))
;;                  (pco-gas-station has an eighth, station-info, of its own.)
;;                  non-voting was missing from this list: EVERY cast-vote reads
;;                  it, and it cannot be created after the flip.
;;                  A chain missing rcv-actives BRICKS every debit (the release
;;                  path reads it) - INCLUDING pco-claim.sweep-pool, the
;;                  documented recovery path, while pool-balance still reports a
;;                  healthy pool because it only reads `accounts`. Verify table
;;                  existence on all 20 chains BEFORE ever flipping
;;                  FROZEN-MODULE: after the flip, module admin is unobtainable
;;                  forever, so create-table is impossible and every exit from
;;                  the pool is a debit. There is no on-chain recovery.
(if (read-msg 'upgrade)
  [ "upgrade" ]
  [ (create-table accounts)
    (create-table supply)
    (create-table rcv-proposals)
    (create-table rcv-ballots)
    (create-table rcv-actives)
    (create-table gov-counts)
    (create-table vote-delegates)
    (create-table ops-auth)
    (create-table rcv-margins)
    (create-table non-voting)
    (insert supply "supply" { "minted": 0.0, "burned": 0.0 }) ])
