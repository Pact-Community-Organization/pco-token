;; pco-gas-station.pact — gasless ONBOARDING for the PCO community token: it
;; funds transactions whose single top-level call is the claim, so a newcomer
;; holding zero KDA can receive their first PCO; everything afterward is the
;; participant's own to pay for. What makes the float safe is the pair of
;; checks in `gas-payer-pred` and `ALLOW_GAS` - the sender binding and the
;; single-use rule; the allowlist constrains call HEADS, never total work,
;; and the epoch meter bounds sponsored GAS SPEND, never a direct transfer.
;; Keep the float small enough that losing all of it is an inconvenience.
(namespace (read-msg 'ns))

(module pco-gas-station GOVERNANCE

  @doc "Onboarding gas station for the PCO community token: funds            \
  \transactions whose single top-level call is the claim (exec-only, ONE     \
  \top-level term, node-injected code check, price/limit ceilings, daily     \
  \epoch cap); voting and transfers are not sponsored. WHAT PROTECTS THE     \
  \FLOAT is the pair of checks in gas-payer-pred and ALLOW_GAS - the         \
  \allowlist tests only the HEAD of the term (argument sub-expressions run   \
  \on station gas), and the meter bounds sponsored gas spend, never a direct \
  \transfer. The station account is a USER-guarded coin account (u:          \
  \principal over station-guard-pred); the community keyset recovers         \
  \residual funds through its second branch."

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
         \FROZEN-MODULE belongs here and nowhere else - freezing must stop   \
         \the CODE changing, never disable an operation. Every admin action  \
         \has its own keyset-gated capability below; do not reuse this        \
         \capability to authorize anything."
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
         \of ALLOW_GAS. tx-type / exec-code are node-injected from the real      \
         \parsed payload during the GAS-BUY phase ONLY - outside it they are     \
         \sender-controlled and authorize NOTHING. The sender binding (signed    \
         \gas-payer metadata, not data-block content) is what makes the rest     \
         \meaningful; it is checked HERE so it also covers `charge-meter`,       \
         \which is public."
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
    @doc "Station-account release permission: acquirable ONLY in the gas-buy   \
         \phase. The phase test closes the PAYLOAD-phase route - necessary,    \
         \not sufficient; what bounds the loss is keeping the float small.     \
         \The transaction hash is the only signal in Pact that distinguishes   \
         \the phases: chainweb runs the gas buy with                           \
         \Hash(cmdHash <> \"-buygas\") (Pact5/TransactionExec.hs), so a        \
         \gas-buy hash is 52 base64url characters ending \"YnV5Z2Fz\" where a  \
         \payload hash is 43. That is a node implementation detail, not a      \
         \documented interface: a changed derivation fails CLOSED (onboarding  \
         \stops, the float stays safe), and it must be proven by the gasless-  \
         \claim leg of the devnet rehearsal on every engine bump."
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
    @doc "Releases the station's KDA only inside a sanctioned gas buy. THE    \
         \SENDER BINDING IS THE LOAD-BEARING CHECK: `(at 'sender (chain-data))` \
         \is signed transaction METADATA, equal to the station account only   \
         \when the node is buying gas FOR this station. The two capabilities  \
         \below are not sufficient alone - coin.GAS is not ours, and the      \
         \envelope keys are trustworthy only during the gas buy."
    ;; The station's own account name is read HERE, inside the gas-payer
    ;; branch, never above the enforce-one (see station-guard-pred). The empty
    ;; sentinel fails this branch closed rather than comparing the sender
    ;; against "", which a transaction could match.
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
    ;; BRANCH ORDER IS LOAD-BEARING - admin first, do not "tidy" it back.
    ;; The gas-payer branch reads `station-info`; a missing table raises a
    ;; database error that neither `try` nor `enforce-one` contains. Admin
    ;; first keeps the float recoverable no matter what happened to the table;
    ;; reversed, one missing table would make that chain's balance unspendable
    ;; by ANYONE, permanently.
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
         \roll the epoch on block-time; fail closed at the cap. GATED ON   \
         \ALLOW_GAS, which is single-use per transaction, so one sponsored \
         \transaction advances the meter exactly once. This function is    \
         \PUBLIC: it must never rest on a weaker gate - in particular not  \
         \on the sponsorship envelope alone, a trust anchor only during    \
         \the gas-buy phase."
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
    ;; ORDER IS LOAD-BEARING: ALLOW_GAS is composed BEFORE the meter is
    ;; charged, because ALLOW_GAS is what makes the charge single-use per
    ;; transaction. Do NOT charge before acquiring it, and do NOT move the
    ;; charge behind a gate whose body is only the sponsorship envelope - the
    ;; envelope alone does not bound how often this path can be reached.
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

;; THE STATION MUST NEVER BE FROZEN, and the enforce below is what makes that
;; true rather than merely advised: `withdraw` calls `coin.transfer`, so this
;; module pins `coin` at RUNTIME, and a frozen station could never bless a
;; coin upgrade's new hash - stranding the float with no recovery path.
;; Freezing also buys nothing: every admin action already has its own
;; keyset-gated capability. OUTSIDE the `if` deliberately: the fresh branch
;; does not run on an upgrade deploy, and a frozen UPGRADE is the only
;; realistic way the flip ships.
(enforce (not pco-gas-station.FROZEN-MODULE)
  "the station must never be frozen - it pins coin at runtime and would strand the float")

;; Deploy footer — fresh deploy creates + seeds; upgrades touch nothing.
(if (read-msg 'upgrade)
  [ "upgrade" ]
  [ (create-table meter)
    (create-table station-info)
    (init) ])
