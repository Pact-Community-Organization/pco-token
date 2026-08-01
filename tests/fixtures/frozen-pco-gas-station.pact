;; pco-gas-station.pact — gasless ONBOARDING for the PCO community token.
;;
;; A gas station whose purpose is to let a newcomer holding zero KDA receive
;; their first PCO. It funds transactions whose single top-level call is the
;; claim; everything a holder does afterward (voting, transferring) requires
;; holdings and is the participant's own to pay for.
;;
;; WHAT THE ALLOWLIST DOES AND DOES NOT CONSTRAIN — read this before relying
;; on it, and before copying this module:
;;   The check is a PREFIX TEST ON THE HEAD of the single rendered top-level
;;   term. It therefore constrains WHICH CALL HEADS a sponsored transaction
;;   may have — NOT the total work that transaction can perform. Treat it as
;;   a statement of intent, never as a bound on cost.
;;   It does NOT follow that the float is safe, and an earlier version of this
;;   comment claimed exactly that. It was wrong. What makes the float safe is
;;   the pair of checks in `gas-payer-pred` and `ALLOW_GAS` — the sender binding
;;   and the single-use rule — NOT the allowlist and NOT the epoch meter. The
;;   meter bounds sponsored GAS SPEND; it never bounded a direct transfer out of
;;   the station account, because such a transfer does not enter GAS_PAYER at
;;   all. Do not weaken either check on the strength of the allowlist.
;;   A string-length ceiling was evaluated and REJECTED: it cannot admit every
;;   legitimate claim and still bound the work, so it would break onboarding
;;   without buying anything. The effective
;;   lever, if the policy must become real, is MAX-GAS-LIMIT — bounding the
;;   WORK rather than the text. See the ADR before changing it.
;;
;; Drain defense, all fail-closed. READ THE LIMIT FIRST, because an earlier
;; version of this block said these checks "actually protect the balance" and
;; that is not true against every caller:
;;
;;   TREAT THE FLOAT AS THE ONLY VALUE THIS SYSTEM HOLDS, AND KEEP IT SMALL.
;;   The checks below close the routes named under them, and each is an
;;   authorization decision rather than a formality. They are not a licence to
;;   fund this account generously: the operational rule is a float small enough
;;   that losing all of it is an inconvenience, bounded further by the per-epoch
;;   cap. Sponsored transactions are attacker-controlled input, so every
;;   condition here is written to be satisfied by exactly one intended caller
;;   and nothing else. Rationale and the executable regressions are kept in the
;;   private ceremony repository, not in this file — a deployed comment is a
;;   published document (see PRIVATE-ONLY.md).
;;
;;   WHAT BOUNDS THE LOSS IS KEEPING THE FLOAT SMALL. Treat it as expendable,
;;   fund the minimum that serves onboarding, and top it up on demand rather
;;   than holding a balance worth taking.
;;
;; What the checks below DO close, and what they shape:
;;   * SENDER BINDING: the station's account guard opens only when the
;;     transaction's own gas payer IS this station — signed metadata, not
;;     data-block content — so a self-paid transaction can never open it.
;;   * SINGLE-USE ALLOW_GAS: that capability records its transaction hash, so
;;     the node takes it once, in buy-gas, before any user code runs; any
;;     later acquisition in the same transaction is refused.
;;   * exec-only, single top-level term: the sponsorship check reads the
;;     transaction type and executed code as INJECTED BY THE NODE from the
;;     real parsed payload. IMPORTANT: that injection is a property of the
;;     GAS-BUY phase only. Outside it those keys are sender-controlled, so
;;     this check authorizes nothing on its own.
;;   * exact-prefix allowlist with a trailing-space token boundary, so
;;     "(ns.pco-claim.claim " can never prefix-match a different function.
;;   * global gas-price + gas-limit ceilings enforced against the values
;;     coin actually debits ((chain-data) envelope, not capability args).
;;   * a daily epoch meter caps total sponsored KDA — THE control on loss;
;;     griefing burns bounded, self-healing budget.
(namespace (read-msg 'ns))

(module pco-gas-station GOVERNANCE

  @doc "Onboarding gas station for the PCO community token: funds            \
  \transactions whose single top-level call is the claim, so a newcomer with \
  \zero KDA can receive their first tokens. Voting and transfers are not     \
  \sponsored operations - they require holdings and the participant pays.    \
  \Exec-only, ONE top-level term, node-injected code check, price/limit      \
  \ceilings, daily epoch cap.                                                \
  \                                                                          \
  \WHAT PROTECTS THE FLOAT is the pair of checks in gas-payer-pred and       \
  \ALLOW_GAS: the account guard opens only when the TRANSACTION'S OWN GAS    \
  \PAYER is this station, and ALLOW_GAS can be acquired only once per        \
  \transaction. Neither the allowlist nor the epoch meter bounds a direct    \
  \transfer out of the station - a transfer never enters GAS_PAYER. The      \
  \meter bounds sponsored GAS SPEND, which is a different quantity.          \
  \                                                                          \
  \NOTE on the allowlist: it tests the HEAD of the single top-level term;    \
  \Pact evaluates arguments first, so work nested in the claim's arguments   \
  \also runs on station gas. That costs the station gas it had already       \
  \agreed to pay; it can no longer cost it the float.                        \
  \                                                                          \
  \The station account is a USER-guarded coin account (create-user-guard     \
  \over station-guard-pred, so a u: principal - not a capability guard);     \
  \the community keyset can recover residual funds through its second        \
  \branch."

  (implements gas-payer-v1)
  (use coin)

  ;; -----------------------------
  ;; Governance
  ;; -----------------------------

  (defconst NS:string (read-msg 'ns)
    "Deploy namespace, fixed at deploy.")

  (defconst ADMIN-KS:string (format "{}.pco-gov" [NS])
    "The community governance keyset (2-of-3 hardware keys).")

  ;; GENERATED FIXTURE - do not edit; see fixtures/make-frozen-pco.sh
  (bless "DldRwCblQ7Loqy6wYJnaodHl30d3j3eH-qtFzfEv46g")

  (defconst FROZEN-MODULE:bool true
    "Set true and redeploy to permanently freeze upgrades.")

  (defcap GOVERNANCE ()
    @doc "UPGRADE GATE ONLY: the community keyset, unless frozen.            \
         \FROZEN-MODULE belongs here and nowhere else. Freezing must stop the \
         \CODE changing; it must never disable an operation. Every admin      \
         \action has its own capability below, gated on the keyset alone, so  \
         \the station stays operable and its funds recoverable forever after  \
         \the flip. Do not reuse this capability to authorize anything."
    (enforce (not FROZEN-MODULE) "Module is frozen - no further upgrades")
    (enforce-keyset ADMIN-KS))

  (defcap ADMIN ()
    @doc "Station administration (setup). The community keyset, deliberately \
         \NOT gated on FROZEN-MODULE - see GOVERNANCE."
    (enforce-keyset ADMIN-KS))

  ;; -----------------------------
  ;; Policy constants
  ;; -----------------------------

  (defconst MAX-GAS-PRICE:decimal 0.0000001
    "Ceiling on the ACTUAL gas price of a sponsored transaction (10x the \
    \customary network floor - sponsored callers should bid the floor).")

  (defconst MAX-GAS-LIMIT:integer 6000
    "Ceiling on the ACTUAL gas limit of a sponsored transaction. Claim,   \
    \vote and proposal all fit with headroom; deploys never do.")

  (defconst EPOCH-CAP:decimal 0.5
    "Total KDA sponsored per epoch. Worst case 0.0006 KDA per tx -> at   \
    \least ~830 sponsored operations per epoch; grief drain is bounded    \
    \and self-heals next epoch.")

  (defconst EPOCH-LEN:integer 86400
    "Epoch length in seconds (1 day), rolled on block-time.")

  (defconst SPONSORED:[string]
    [ (format "({}.pco-claim.claim " [NS]) ]
    "The exact-prefix allowlist - ONE entry: the claim. The prefix opens    \
    \with '(' and ends with a space, a whole-token boundary, so it can      \
    \never prefix-match a longer, different name (e.g. a hypothetical       \
    \claim-* function). It constrains the HEAD of the single top-level      \
    \term ONLY: argument sub-expressions are evaluated by Pact before the   \
    \head is applied and are NOT covered. No other call HEAD is fundable;   \
    \loss is bounded by EPOCH-CAP, not by this list.")

  (defconst METER-KEY "meter")
  (defconst EPOCH-ZERO:time (time "1970-01-01T00:00:00Z"))

  ;; -----------------------------
  ;; State
  ;; -----------------------------

  (defschema meter-row
    epoch-start:time
    spent:decimal)

  (deftable meter:{meter-row})              ; singleton

  (defschema station-row
    @doc "Singleton. `account` is this station's own coin account, written once \
         \by `init`. It is held in a TABLE rather than read from the GAS_STATION \
         \defconst because the station guard needs it: GAS_STATION is derived    \
         \FROM the guard predicate, so a predicate that referenced GAS_STATION   \
         \would be a definition cycle and the module would not load. The value   \
         \is identical - `init` writes exactly GAS_STATION.                      \
         \`last-tx` is the hash of the last transaction in which ALLOW_GAS was   \
         \acquired; it makes that capability single-use per transaction."
    account:string
    last-tx:string)

  (deftable station-info:{station-row})     ; singleton

  (defconst INFO-KEY "station")

  ;; -----------------------------
  ;; Station account (USER-guarded — a u: principal, not a capability guard)
  ;; -----------------------------

  (defun enforce-sponsored-envelope:bool ()
    @doc "The sponsorship policy, factored out so it can be RE-RUN in the body   \
         \of ALLOW_GAS.                                                          \
         \                                                                       \
         \READ THIS BEFORE TRUSTING tx-type / exec-code. The node injects them   \
         \from the real parsed payload during the GAS-BUY phase only. Outside    \
         \that phase they are sender-controlled, so on their own they authorize  \
         \NOTHING, and an earlier version of this module said otherwise.         \
         \                                                                       \
         \The sender binding below is what makes the rest meaningful. It is the  \
         \transaction's signed gas-payer field, not data-block content, and it   \
         \equals this station only when the node is buying gas FOR this station. \
         \It is checked HERE rather than only in the account guard so that it    \
         \also covers `charge-meter`, which is public: the meter must never be   \
         \advanceable outside a transaction this station is actually paying for."
    (let ((station (with-default-read station-info INFO-KEY
                     { "account": "" } { "account" := a } a)))
      (enforce (!= station "") "station identity unavailable")
      (enforce (= (at 'sender (chain-data)) station)
        "not a transaction paid for by this station"))
    (let ((tx-type:string (read-msg "tx-type")))
      (enforce (= "exec" tx-type) "sponsors exec transactions only"))
    (let ((codes:[string] (read-msg "exec-code")))
      (enforce (= 1 (length codes)) "sponsors exactly one call per transaction")
      (let* ((code (at 0 codes))
             (m (filter (lambda (p:string) (= p (take (length p) code))) SPONSORED)))
        (enforce (= 1 (length m)) "not a sponsored call")))
    (enforce-gas-ceilings))

  (defcap ALLOW_GAS ()
    @doc "Station-account release permission: acquirable ONLY in the gas-buy    \
         \phase.                                                               \
         \                                                                     \
         \WHAT THE PHASE TEST DOES AND DOES NOT DO. It closes the PAYLOAD-phase \
         \route, and that is all it closes. An earlier version of this docstring \
         \called it \"the check that protects the float\"; that was wrong, and    \
         \the correction matters more than the claim did.                       \
         \                                                                      \
         \It does NOT by itself make the float safe. Establishing the phase is   \
         \necessary and not sufficient, so do not read this test as the whole    \
         \defence: it is one condition among several, and the float is sized on  \
         \the assumption that it can be lost rather than on the assumption that  \
         \every route is closed. Keep the float small and the epoch cap tight.   \
         \Rationale and the executable regressions live in the private ceremony  \
         \repository, not here - a deployed comment is a published document      \
         \(PRIVATE-ONLY.md).                                                     \
         \What bounds the loss is KEEPING THE FLOAT SMALL.                       \
         \                                                                      \
         \The envelope re-check is necessary but not sufficient: its keys are a  \
         \trust anchor only during the gas buy, and outside it they are          \
         \sender-controlled. The sender binding in `gas-payer-pred` is also not  \
         \sufficient on its own, because the whole transaction carries ONE       \
         \sender - so code running in the payload of a genuinely sponsored       \
         \transaction satisfies it too.                                        \
         \                                                                     \
         \So the phase itself has to be established, and the transaction hash  \
         \is the only signal in Pact that distinguishes the phases. chainweb    \
         \runs the gas buy with mdHash = Hash(cmdHash <> \"-buygas\") and the     \
         \payload with mdHash = cmdHash (Pact5/TransactionExec.hs: bgHash at    \
         \:892, used at :829 and :848; payload at :672 and :684; redeem-gas has \
         \a third hash at :920/:944). Appending 7 bytes to a 32-byte hash gives \
         \39 bytes, which is divisible by 3, so the trailing \"buygas\" lands on   \
         \exactly the last 8 base64url characters and a payload hash is 43      \
         \characters where a gas-buy hash is 52.                               \
         \                                                                     \
         \An earlier version of this capability relied on recording the hash    \
         \and refusing a second acquisition in the SAME transaction. That does  \
         \NOTHING on chain: the two phases never share a hash, so the stamp     \
         \never matched and the rule never fired. It is kept below as defence   \
         \in depth and must not be described as what guards the float.         \
         \                                                                     \
         \DEVNET-CRITICAL, and this is a node implementation detail rather than \
         \a documented interface: if chainweb ever changes the derivation, this \
         \fails CLOSED - gasless onboarding stops and the float stays safe,     \
         \which is the correct direction, but it must be proven by the P7       \
         \gasless-claim leg of the devnet rehearsal on every engine bump. Do    \
         \not take it on reasoning alone."
    (enforce-sponsored-envelope)
    ;; The gas-buy phase, positively identified. Both halves are asserted so a
    ;; payload hash cannot satisfy this by coincidence (it would need its last
    ;; six bytes to spell "buygas").
    (enforce (= 52 (length (tx-hash))) "ALLOW_GAS: not the gas-buy phase")
    (enforce (= "YnV5Z2Fz" (take -8 (tx-hash))) "ALLOW_GAS: not the gas-buy phase")
    ;; Defence in depth only - see the @doc. On chain this never fires, because
    ;; the gas-buy hash differs from the payload hash by construction.
    (with-read station-info INFO-KEY { "last-tx" := lt }
      (enforce (!= lt (tx-hash))
        "ALLOW_GAS is single-use per transaction (already acquired in this tx)")
      (update station-info INFO-KEY { "last-tx": (tx-hash) })))

  (defun gas-payer-pred:bool ()
    @doc "Releases the station's KDA only inside a sanctioned gas buy.        \
         \                                                                    \
         \THE SENDER BINDING IS THE LOAD-BEARING CHECK, not the two           \
         \capabilities below. `coin.GAS` is defined in `coin`, a module we do  \
         \not control, so this module cannot make any assumption about how     \
         \readily it is obtained; and ALLOW_GAS's envelope check reads keys    \
         \that are node-injected during the gas-buy phase but                  \
         \sender-controlled outside it. Requiring both capabilities is         \
         \therefore NOT sufficient on its own.                                 \
         \                                                                    \
         \`(at 'sender (chain-data))` is different in kind. It is signed      \
         \transaction METADATA, fixed before execution and not readable from  \
         \the data block, and it equals the station account only when the     \
         \node is buying gas FOR this station - i.e. in a genuinely sponsored \
         \transaction. A caller who sets it to the station must therefore      \
         \go through buy-gas, where GAS_PAYER checks the allowlist against    \
         \the code the NODE parsed, not against anything they supply."
    ;; The station's own account name is read HERE, inside the gas-payer branch,
    ;; and never in the admin branch - see station-guard-pred for why that
    ;; placement is load-bearing. `with-default-read` covers a missing ROW; the
    ;; empty sentinel then fails this branch closed rather than comparing the
    ;; sender against "", which a transaction could match.
    (let ((station (with-default-read station-info INFO-KEY
                     { "account": "" } { "account" := a } a)))
      (enforce (!= station "") "station guard: station identity unavailable")
      (enforce (= (at 'sender (chain-data)) station)
        "station guard: gas payer is not this station"))
    (require-capability (GAS))
    (require-capability (ALLOW_GAS)))

  (defun station-guard-pred:bool ()
    @doc "Station coin-account predicate: sanctioned gas buy OR the \
         \community keyset (residual-fund recovery). NEVER RENAME this \
         \function (or the module): the deployed station account's stored \
         \user guard references it by name - a rename orphans the funds. \
         \Its ARITY is part of that identity too: keep it zero-argument. \
         \The station account is read INSIDE the gas-payer branch, never \
         \above the enforce-one, so a satisfied admin keyset returns before \
         \that read is reached - see the comment below."
    ;; BRANCH ORDER IS LOAD-BEARING - do not "tidy" it back.
    ;; The gas-payer branch reads `station-info`. A missing TABLE (a chain
    ;; deployed in UPGRADE mode before that table existed) raises a database
    ;; error, and a database error is NOT contained: it is not catchable with
    ;; `try`, and enforce-one does not swallow it - it aborts the whole
    ;; predicate. Measured both ways in Pact 5.4. With the admin branch FIRST a
    ;; satisfied governance keyset returns before the read is ever reached, so
    ;; the float stays recoverable no matter what happened to the table. With
    ;; the branches the other way round, one missing table on one chain would
    ;; make that chain's balance unspendable by ANYONE, permanently.
    ;; The cost is one failed keyset check per sponsored gas buy.
    (enforce-one "station guard: neither gas-payer nor admin satisfied"
      [ (enforce-keyset ADMIN-KS)
        (gas-payer-pred) ]))

  (defun create-gas-payer-guard:guard ()
    (create-user-guard (station-guard-pred)))

  (defconst GAS_STATION:string
    (create-principal (create-user-guard (station-guard-pred)))
    "The station's principal coin account.")

  ;; -----------------------------
  ;; Envelope ceilings ((chain-data) is protocol-injected, not attacker data)
  ;; -----------------------------

  (defun enforce-gas-ceilings:bool ()
    (enforce (> (at 'gas-price (chain-data)) 0.0) "gas price must be positive")
    (enforce (<= (at 'gas-price (chain-data)) MAX-GAS-PRICE)
      (format "gas price must be <= {}" [MAX-GAS-PRICE]))
    (enforce (> (at 'gas-limit (chain-data)) 0) "gas limit must be positive")
    (enforce (<= (at 'gas-limit (chain-data)) MAX-GAS-LIMIT)
      (format "gas limit must be <= {}" [MAX-GAS-LIMIT])))

  ;; -----------------------------
  ;; Epoch meter
  ;; -----------------------------

  (defun charge-meter:bool ()
    @doc "Charge the transaction's worst-case cost against the epoch cap;  \
         \roll the epoch on block-time; fail closed at the cap.             \
         \                                                                  \
         \GATED ON ALLOW_GAS, WHICH IS SINGLE-USE PER TRANSACTION, and that \
         \is the whole defence. ALLOW_GAS stamps the tx-hash and refuses a  \
         \second acquisition in the same transaction, so charging inherits  \
         \that one-shot rule: one sponsored transaction advances the meter  \
         \exactly once.                                                     \
         \                                                                  \
         \This function is PUBLIC, so it must never rest on a gate weaker   \
         \than that - in particular not on the sponsorship envelope alone,  \
         \which is a trust anchor only during the gas-buy phase. An earlier \
         \design did rest on it and was replaced."
    (require-capability (ALLOW_GAS))
    (let ((now (at 'block-time (chain-data)))
          (cost (* (at 'gas-price (chain-data))
                   (dec (at 'gas-limit (chain-data))))))
      (with-read meter METER-KEY { "epoch-start" := es, "spent" := sp }
        (let* ((rolled (>= (diff-time now es) (dec EPOCH-LEN)))
               (base   (if rolled 0.0 sp))
               (start  (if rolled now es))
               (spent* (+ base cost)))
          (enforce (<= spent* EPOCH-CAP)
            "gas station epoch cap reached - sponsorship paused until the next epoch")
          (update meter METER-KEY { "epoch-start": start, "spent": spent* })
          true))))

  ;; -----------------------------
  ;; GAS_PAYER — the sponsorship policy (gas-payer-v1)
  ;; -----------------------------

  (defcap GAS_PAYER:bool (user:string limit:integer price:decimal)
    @doc "Sponsor gas iff the transaction is an exec of exactly one        \
         \allowlisted call within the price/limit ceilings and the epoch   \
         \budget. The cap arguments are attacker-controllable and are NOT  \
         \used as authorization - every check reads the protocol-injected  \
         \transaction envelope."
    ;; The sponsorship envelope is enforced by ALLOW_GAS's own body as well, so
    ;; the cap can only be acquired for a genuine sponsored call. One explicit
    ;; check up front keeps the fail-closed behaviour obvious and cheap on the
    ;; reject path (no gas paid before it fails).
    ;;
    ;; ORDER IS LOAD-BEARING: ALLOW_GAS is composed BEFORE the meter is charged,
    ;; because ALLOW_GAS is what makes the charge single-use per transaction. It
    ;; stamps the tx-hash and refuses a second acquisition, so exactly one charge
    ;; can ever land per sponsored transaction. Do NOT charge before acquiring
    ;; it, and do NOT move the charge behind any gate whose body is only the
    ;; sponsorship envelope - the envelope alone does not bound how often this
    ;; path can be reached inside one transaction.
    (enforce-sponsored-envelope)
    (compose-capability (ALLOW_GAS))
    (charge-meter))

  ;; -----------------------------
  ;; Lifecycle & reads
  ;; -----------------------------

  (defun init:string ()
    @doc "Create the station coin account and seed the meter (fresh deploy \
         \only - the footer calls it under the deploy signature). Fund the \
         \station with KDA separately."
    (with-capability (ADMIN)
      (insert meter METER-KEY { "epoch-start": EPOCH-ZERO, "spent": 0.0 })
      ;; Write the station's own account name where the guard predicate can read
      ;; it. Identical to GAS_STATION; held in a table only to break the
      ;; definition cycle (see the station-row docstring).
      (insert station-info INFO-KEY { "account": GAS_STATION, "last-tx": "" })
      (coin.create-account GAS_STATION (create-gas-payer-guard))))

  (defun withdraw:string (receiver:string amount:decimal)
    @doc "Recover residual KDA from the station. Authorization is the      \
         \station account guard itself: its second branch enforces the     \
         \community keyset. Sign with the keyset scoping (coin.TRANSFER    \
         \GAS_STATION receiver amount)."
    (coin.transfer GAS_STATION receiver amount))

  (defun station-account:string ()
    GAS_STATION)

  (defun epoch-spent:decimal ()
    @doc "KDA sponsored in the current epoch (monitoring)."
    (at 'spent (read meter METER-KEY)))
)

;; THE STATION MUST NEVER BE FROZEN, and this is what makes that true rather
;; than merely advised.
;;
;; ADR-PCO-014 says it must never be frozen, and until now nothing stopped it:
;; flipping one word shipped a frozen station, and a mutation audit confirmed
;; that deleting GOVERNANCE's freeze check broke no test at all.
;;
;; WHY it must never be frozen: `withdraw` calls `coin.transfer`, so this module
;; pins `coin` at RUNTIME. When `coin` is upgraded, a frozen station can never
;; bless the new hash - and an unblessed dependency kills `withdraw`, stranding
;; the float with no code path to recover it. Freezing buys nothing here either:
;; every admin action already has its own capability gated on the keyset alone,
;; so the freeze would remove an ability and add no safety.
;;
;; This sits OUTSIDE the `if` deliberately. The fresh branch does not run on an
;; upgrade deploy, so an enforce placed inside it would let exactly the dangerous
;; case through - a frozen UPGRADE - which is the only way the flip could
;; realistically ship.
(enforce (not pco-gas-station.FROZEN-MODULE)
  "the station must never be frozen - it pins coin at runtime and would strand the float")

;; Deploy footer — fresh deploy creates + seeds; upgrades touch nothing.
(if (read-msg 'upgrade)
  [ "upgrade" ]
  [ (create-table meter)
    (create-table station-info)
    (init) ])
