;; pco-claim.pact — open, permissionless claim of the PCO community token:
;; self-serve ROUNDS (fixed amount once per account per round, hub chain,
;; time window, budget, engagement-code hash gate) plus judged recognition
;; GRANTS. A claim needs NO claimer signature: tokens can only land in the
;; account bound to the supplied guard, and a third-party claim is a gift
;; that consumes the slot. Codes are engagement, never security - public
;; chain data after the first claim; budgets and one-claim-per-account-per-
;; round are the invariants (Sybil claiming is accepted by design).
(namespace (read-msg 'ns))

(module pco-claim GOVERNANCE

  @doc "Claim distributor for the PCO community token: module-guarded pool  \
  \escrow; self-serve claim ROUNDS; judged GRANTS with public reasons;      \
  \master open/close switch; hub-chain only; after close the community      \
  \keyset may sweep the pool remainder to the reserve (public SWEPT event). \
  \Two privilege tiers: the 2-of-3 governance keyset holds upgrade and the  \
  \sweep, while ROUTINE OPS (the guard in pco.ops-auth, which governance    \
  \names and always satisfies itself) runs rounds, grants and the switch -  \
  \a drip throttle, not a vault key: every commitment is bounded per object \
  \and per epoch (OPS-EPOCH-CAP, fails closed), every act is publicly       \
  \evented, and governance revokes ops instantly via pco.set-ops-guard,     \
  \available even after a module freeze."

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

  (defconst FREEZE-RESIDUE-TOLERANCE:decimal 1.0
    "Pool residue the freeze interlock tolerates. The interlock stops a       \
    \freeze while the pool is FUNDED; anyone may send to the public pool     \
    \address, so the check is a threshold, not an equality. Residue below    \
    \this stays recoverable after the freeze - `sweep-pool` is ADMIN-gated,  \
    \not gated on the upgrade capability.")

  (defcap GOVERNANCE ()
    @doc "Upgrade gate: the community keyset, unless frozen."
    (enforce (not FROZEN-MODULE) "Module is frozen - no further upgrades")
    (enforce-keyset ADMIN-KS))

  (defcap ADMIN ()
    @doc "High-critical claim administration (pool sweep): the 2-of-3 \
         \community keyset. Scoped-signature friendly."
    (enforce-keyset ADMIN-KS))

  (defcap OPS ()
    @doc "Routine claim operations (rounds, grants, open/close): the ops    \
         \authority named by governance in `pco` (one set-ops-guard call    \
         \rotates ops for both modules), with the 2-of-3 governance keyset  \
         \as an always-available fallback tried FIRST, so a broken or       \
         \hostile ops authority can never lock governance out."
    ;; BRANCH ORDER IS LOAD-BEARING - admin first, do not "tidy" it back.
    ;; The ops branch reads `pco.ops-auth`; on a chain missing that table the
    ;; read raises a database error, which neither `try` nor `enforce-one`
    ;; contains - same shape as pco.PROPOSAL-OPS.
    (enforce-one "ops authorization failed: neither the ops authority nor the governance keyset is satisfied"
      [ (enforce-keyset ADMIN-KS)
        (enforce-guard (pco.ops-guard)) ]))

  ;; -----------------------------
  ;; Bounds (the ops drip-throttle contract)
  ;; -----------------------------

  (defconst MAX-ROUND-AMOUNT:decimal 500.0
    "Largest per-claim award a round may carry.")

  (defconst MAX-ROUND-BUDGET:decimal 30000.0
    "Largest total budget a single round may commit (sized for the genesis \
    \round; recurring rounds use far less).")

  (defconst MAX-GRANT:decimal 2000.0
    "Largest single judged grant.")

  (defconst OPS-EPOCH-CAP:decimal 40000.0
    "Total PCO the ops tier may COMMIT per epoch across round budgets and  \
    \grants; fails closed, self-heals next epoch. Per EPOCH, not per       \
    \sliding day (up to 2x across one boundary), and a rate limit, NOT a   \
    \pool-solvency guarantee: an over-committed round simply fails late    \
    \claims with insufficient funds, atomically.")

  (defconst EPOCH-LEN 86400
    "Ops-meter epoch length in seconds (1 day).")

  (defconst GOV-CHAIN:string "0"
    "Claims and grants live on the hub chain, where the supply was minted.")

  (defconst CONFIG-KEY "config")

  (defconst METER-KEY "meter")

  ;; -----------------------------
  ;; Pool escrow (module-guarded account in the pco token module)
  ;; -----------------------------

  (defun pool-guard:guard ()
    @doc "The guard of the claim pool account: a MODULE GUARD of pco-claim,  \
         \spendable only with this module's own code on the call stack       \
         \(claim / grant / sweep-pool) or under its module admin. NEVER      \
         \RENAME this module or the guard string: the pool account principal \
         \derives from both - a rename strands the pool."
    (create-module-guard "pco-claim-pool"))

  (defconst POOL-ACCOUNT:string (create-principal (pool-guard))
    "The claim pool: an m: (MODULE-GUARD) principal account in the pco token, \
    \credited by init-mint, debitable only through this module's            \
    \claim/grant/sweep paths. What keeps the pool out of the tally is the   \
    \by-NAME non-voting register in `pco`, written by this module's own     \
    \deploy footer - NOT the `m:` tag: verify                               \
    \`(pco.non-voting? (pool-account))` on a live deploy, never the prefix.")

  ;; -----------------------------
  ;; State
  ;; -----------------------------

  (defschema round-row
    @doc "One self-serve claim event. claimed counts distributed tokens;  \
         \the window is [opens, closes) against block-time; active is the \
         \per-round pause/early-close switch."
    code-hash:string                        ; BLAKE2b hash of the round's engagement code
    amount:decimal                          ; award per successful claim
    budget:decimal                          ; total distributable in this round
    claimed:decimal                         ; distributed so far
    opens:time
    closes:time
    active:bool)

  (deftable rounds:{round-row})             ; key = round id (short slug)

  (defschema claim-row
    @doc "One row per successful claim - the insert IS the one-shot gate  \
         \(per round: key = '<round-id>|<account>')."
    amount:decimal
    at:time)

  (deftable claims:{claim-row})

  (defschema config-row
    open:bool)                              ; master kill switch over ALL rounds

  (deftable config:{config-row})            ; singleton

  (defschema meter-row
    epoch-start:time
    spent:decimal)

  (deftable ops-meter:{meter-row})          ; singleton: daily ops commitment meter

  ;; -----------------------------
  ;; Events
  ;; -----------------------------

  ;; Every event capability carries a real body: each requires the capability
  ;; that authorized the real action. CLAIMED is emitted on the permissionless
  ;; claim path where no capability is held, so it instead requires the claim
  ;; ROW to exist with a matching amount - written by `claim` and nothing else.

  (defcap CLAIMED (round-id:string account:string amount:decimal)
    @event
    ;; A CLAIMED event cannot be invented, but it CAN be restated: count
    ;; participation from DISTINCT ACCOUNTS in the claims table, never events.
    (with-read claims (claim-key round-id account) { "amount" := a }
      (enforce (= a amount) "claimed amount does not match the recorded claim")))

  (defcap AWARDED (account:string amount:decimal reason:string)
    @event
    (require-capability (OPS)))

  (defcap ROUND-CREATED (round-id:string code-hash:string amount:decimal budget:decimal opens:time closes:time)
    @event
    (require-capability (OPS)))

  (defcap ROUND-SET (round-id:string active:bool)
    @event
    (require-capability (OPS)))

  (defcap CODE-SET (round-id:string code-hash:string)
    @event
    (require-capability (OPS)))

  (defcap OPEN-SET (open:bool)
    @event
    (require-capability (OPS)))

  (defcap SWEPT (receiver:string amount:decimal)
    @event
    (require-capability (ADMIN)))

  ;; -----------------------------
  ;; Internal helpers
  ;; -----------------------------

  (defun claim-key:string (round-id:string account:string)
    @doc "Claims-table key: one slot per (round, account)."
    (format "{}|{}" [round-id account]))

  (defun validate-round-id:bool (round-id:string)
    @doc "Round ids are short ASCII slugs without the key separator."
    (let ((len (length round-id)))
      (enforce (and (>= len 3) (<= len 64)) "round id must be 3-64 characters"))
    (enforce (is-charset CHARSET_ASCII round-id) "round id must be ASCII")
    (enforce (not (contains "|" round-id)) "round id must not contain '|'")
    true)

  (defun charge-ops-meter:bool (amount:decimal)
    @doc "Charge an ops COMMITMENT against the daily cap; roll the epoch on  \
         \block-time; fail closed at the cap. Callable only inside an        \
         \acquired OPS capability; exactly two callers - create-round (the   \
         \budget) and grant-internal (the award). Bounds commitment, not     \
         \outflow: a rate limit on new obligations, never a solvency         \
         \guarantee."
    (require-capability (OPS))
    ;; Self-defending: a negative charge would CREDIT the meter. A public
    ;; function must never trust its callers.
    (enforce (>= amount 0.0) "meter charge must not be negative")
    (let ((now (at 'block-time (chain-data))))
      (with-read ops-meter METER-KEY { "epoch-start" := es, "spent" := sp }
        (let* ((rolled (>= (diff-time now es) (dec EPOCH-LEN)))
               (base   (if rolled 0.0 sp))
               (start  (if rolled now es))
               (spent* (+ base amount)))
          (enforce (<= spent* OPS-EPOCH-CAP)
            "ops daily cap reached - further rounds/grants wait for the next epoch")
          (update ops-meter METER-KEY { "epoch-start": start, "spent": spent* })
          true))))

  ;; -----------------------------
  ;; Administration — rounds (OPS tier)
  ;; -----------------------------

  (defun create-round:string
      (round-id:string code-hash:string amount:decimal budget:decimal opens:time closes:time)
    @doc "OPS: open a new claim round. The code hash is computed OFF-CHAIN \
         \with (hash \"<code>\") - never put the plaintext code in tx     \
         \code. The budget is committed against the daily ops meter."
    (with-capability (OPS)
      (validate-round-id round-id)
      (enforce (!= "" code-hash) "empty code hash")
      (enforce (> amount 0.0) "amount must be positive")
      (enforce (= (floor amount (pco.precision)) amount)
        "amount must respect the token's precision")
      (enforce (<= amount MAX-ROUND-AMOUNT)
        (format "amount exceeds the per-claim bound of {}" [MAX-ROUND-AMOUNT]))
      (enforce (= (floor budget (pco.precision)) budget)
        "budget must respect the token's precision")
      (enforce (>= budget amount) "budget must cover at least one claim")
      (enforce (<= budget MAX-ROUND-BUDGET)
        (format "budget exceeds the per-round bound of {}" [MAX-ROUND-BUDGET]))
      (enforce (< opens closes) "closes must be after opens")
      (charge-ops-meter budget)
      (insert rounds round-id
        { "code-hash": code-hash, "amount": amount, "budget": budget
        , "claimed": 0.0, "opens": opens, "closes": closes, "active": true })
      (emit-event (ROUND-CREATED round-id code-hash amount budget opens closes))
      (format "round {} created" [round-id])))

  (defun set-round-active:string (round-id:string active:bool)
    @doc "OPS: pause or early-close a round (reactivation only works while \
         \the round's time window is still open - the closes gate is      \
         \absolute). Not metered: pausing and resuming moves no tokens and \
         \cannot raise a round's payout above the budget create-round      \
         \already charged."
    (with-capability (OPS)
      (update rounds round-id { "active": active })   ; fails if the round does not exist
      (emit-event (ROUND-SET round-id active))
      (if active "round activated" "round deactivated")))

  (defun set-round-code:string (round-id:string code-hash:string)
    @doc "OPS: rotate a round's engagement code (hash computed off-chain),  \
         \allowed ONLY while the round has no claims yet. Re-pointing the   \
         \code hands the round's remaining budget to whoever knows the new  \
         \code, and the ops meter cannot bound it (the budget was charged   \
         \at create-round) - so once claims exist the redirect is refused   \
         \outright; deactivate the round and open a new one instead."
    (with-capability (OPS)
      (enforce (!= "" code-hash) "empty code hash")
      (with-read rounds round-id
        { "code-hash" := old, "claimed" := cl }   ; fails if the round does not exist
        (enforce (= cl 0.0) "cannot rotate the code once the round has claims")
        (enforce (!= old code-hash) "code hash unchanged"))
      (update rounds round-id { "code-hash": code-hash })
      (emit-event (CODE-SET round-id code-hash))
      "code rotated"))

  (defun set-open:string (open:bool)
    @doc "OPS: master switch over ALL rounds (close doubles as the kill \
         \switch; sweeping requires it closed)."
    (with-capability (OPS)
      (update config CONFIG-KEY { "open": open })
      (emit-event (OPEN-SET open))
      (if open "claims open" "claims closed")))

  ;; -----------------------------
  ;; Grants (OPS tier — judged awards)
  ;; -----------------------------

  (defschema grant-item
    account:string
    guard:guard
    amount:decimal
    reason:string)

  (defconst MAX-BATCH 20
    "Largest grant batch (bounds the per-element work in one tx).")

  (defun grant-internal:string (account:string guard:guard amount:decimal reason:string)
    @doc "Per-grant checks + payout. Internal: callable only inside an     \
         \acquired OPS capability. Kept separate from the OPS acquisition  \
         \because installing a managed capability in code poisons ALL      \
         \later keyset enforcement in the same tx - a batch must acquire   \
         \OPS ONCE and never re-enforce after the first install."
    (require-capability (OPS))
    (let ((chain (at 'chain-id (chain-data))))
      (enforce (= chain GOV-CHAIN) "grants live on the hub chain only"))
    (enforce (validate-principal guard account)
      "account must be the principal of its guard")
    (enforce (> amount 0.0) "amount must be positive")
    (enforce (= (floor amount (pco.precision)) amount)
      "amount must respect the token's precision")
    (enforce (<= amount MAX-GRANT)
      (format "grant exceeds the per-grant bound of {}" [MAX-GRANT]))
    (enforce (!= "" reason) "a public reason is required")
    (charge-ops-meter amount)
    (install-capability (pco.TRANSFER POOL-ACCOUNT account amount))
    ;; The pool's module guard is satisfied because this spend runs inside pco-claim.
    ;; A caller reaching pco.transfer-create on the pool from outside this module
    ;; fails the pool account's module-guard check.
    (pco.transfer-create POOL-ACCOUNT account guard amount)
    (emit-event (AWARDED account amount reason))
    "granted")

  (defun grant:string (account:string guard:guard amount:decimal reason:string)
    @doc "OPS: judged award from the pool (contribution bounty, builder    \
         \recognition, micro-recognition). Bounded per grant and by the    \
         \daily ops meter; the REASON is published in the AWARDED event    \
         \(e.g. the merged PR URL) - grants exist on-chain or not at all.  \
         \NOTE: after a grant, no further keyset-gated call succeeds in    \
         \the same tx (managed-cap install poisons later keyset checks) -  \
         \use grant-batch for several awards in one signature."
    (with-capability (OPS)
      (grant-internal account guard amount reason)))

  (defun grant-batch:[string] (grants:[object{grant-item}])
    @doc "OPS: several judged awards under ONE signature (the monthly     \
         \batch shape). Atomic: any failing item aborts the whole batch.  \
         \Each receiver may appear at most once per batch (the managed    \
         \TRANSFER install identity ignores the amount, so a duplicate    \
         \receiver fails on its second install)."
    (let ((n (length grants)))
      (enforce (and (> n 0) (<= n MAX-BATCH))
        (format "batch size must be 1-{}" [MAX-BATCH])))
    (with-capability (OPS)
      (map (lambda (g:object{grant-item})
             (bind g { "account" := a, "guard" := gd, "amount" := amt, "reason" := r }
               (grant-internal a gd amt r)))
           grants)))

  ;; -----------------------------
  ;; Sweep (ADMIN tier — program end)
  ;; -----------------------------

  (defun sweep-pool:string (receiver:string receiver-guard:guard)
    @doc "ADMIN: after the master switch is CLOSED, move the pool          \
         \remainder to the receiver (normally the community reserve).      \
         \Public SWEPT event. Must be the LAST keyset-gated call in its    \
         \transaction (the managed-cap install poisons later keyset checks \
         \- close-then-sweep in one tx works only in that order)."
    (with-capability (ADMIN)
      (let ((open (at 'open (read config CONFIG-KEY))))
        (enforce (not open) "close claiming before sweeping"))
      (enforce (validate-principal receiver-guard receiver)
        "receiver must be the principal of its guard")
      (let ((bal (pco.get-balance POOL-ACCOUNT)))
        (enforce (> bal 0.0) "pool is empty")
        (install-capability (pco.TRANSFER POOL-ACCOUNT receiver bal))
        ;; Pool spend authorized by the pool account's module guard (runs inside pco-claim).
        (pco.transfer-create POOL-ACCOUNT receiver receiver-guard bal)
        (emit-event (SWEPT receiver bal))
        (format "swept {}" [bal]))))

  ;; -----------------------------
  ;; The claim
  ;; -----------------------------

  (defun claim:string (round-id:string account:string guard:guard code:string)
    @doc "Claim ROUND-ID's amount once for ACCOUNT (the principal of      \
         \GUARD), presenting the round's engagement CODE. Hub chain,      \
         \master switch open, round active, inside [opens, closes),       \
         \budget permitting. One claim per account per round by           \
         \construction (insert fails on re-claim). Also one claim per     \
         \account per TRANSACTION: a second claim for the same account    \
         \in one tx fails on the managed-cap install identity (which      \
         \ignores the amount) - submit rounds separately."
    (let ((chain (at 'chain-id (chain-data))))
      (enforce (= chain GOV-CHAIN) "claims live on the hub chain only"))
    (enforce (validate-principal guard account)
      "account must be the principal of its guard")
    (let ((open (at 'open (read config CONFIG-KEY))))
      (enforce open "claiming is not open"))
    (with-read rounds round-id
      { "code-hash" := ch, "amount" := amt, "budget" := bud
      , "claimed" := cl, "opens" := op, "closes" := cz, "active" := act }
      (enforce act "round is not active")
      (let ((now (at 'block-time (chain-data))))
        (enforce (>= now op) "round has not opened yet")
        (enforce (< now cz) "round has closed"))
      (enforce (!= "" ch) "no engagement code is set")
      (enforce (= ch (hash code)) "wrong engagement code")
      (let ((claimed* (+ cl amt)))
        (enforce (<= claimed* bud) "round budget exhausted")
        (insert claims (claim-key round-id account)
          { "amount": amt, "at": (at 'block-time (chain-data)) })
        (update rounds round-id { "claimed": claimed* })
        (install-capability (pco.TRANSFER POOL-ACCOUNT account amt))
        ;; Pool spend authorized by the pool account's module guard (runs inside pco-claim).
        (pco.transfer-create POOL-ACCOUNT account guard amt)
        (emit-event (CLAIMED round-id account amt))
        "claimed")))

  ;; -----------------------------
  ;; Reads
  ;; -----------------------------

  (defun claimed:bool (round-id:string account:string)
    @doc "Has ACCOUNT already claimed in ROUND-ID?"
    (with-default-read claims (claim-key round-id account)
      { "amount": -1.0 } { "amount" := a }
      (> a 0.0)))

  (defun get-round:object{round-row} (round-id:string)
    (read rounds round-id))

  (defun round-ids:[string] ()
    @doc "All round ids. Full-table scan - /local reads only."
    (keys rounds))

  (defun get-config:object{config-row} ()
    (read config CONFIG-KEY))

  (defun ops-epoch-spent:decimal ()
    @doc "PCO committed by the ops tier in the current epoch (monitoring)."
    (with-read ops-meter METER-KEY { "epoch-start" := es, "spent" := sp }
      (let ((now (at 'block-time (chain-data))))
        (if (>= (diff-time now es) (dec EPOCH-LEN)) 0.0 sp))))

  (defun pool-account:string ()
    POOL-ACCOUNT)

  (defun pool-balance:decimal ()
    @doc "Remaining claimable tokens in the pool."
    (pco.get-balance POOL-ACCOUNT))
)



;; NEVER FREEZE THIS MODULE WHILE THE POOL HOLDS TOKENS. This module CALLS pco,
;; and a dependent runs the PINNED copy of its dependency: freeze this module,
;; then upgrade pco without blessing the pinned hash, and pool-balance, grant,
;; claim AND sweep-pool all die with no on-chain recovery - the pool stays
;; visible and unspendable forever. The enforce below refuses the freeze while
;; the pool is funded (sanctioned order: close claiming, sweep, freeze pco,
;; re-pin, freeze this).
;;
;; OUTSIDE the `if` deliberately: the fresh branch does not run on an upgrade
;; deploy, and a frozen UPGRADE is the only realistic way the flip ships.
;; `get-balance-default`, not `get-balance`: the pool row exists on the hub
;; only, and a missing row must read as empty rather than abort the freeze on
;; 19 chains. A THRESHOLD, not `= 0.0`: anyone may send to the public pool
;; address, and residue below the tolerance stays recoverable (`sweep-pool` is
;; ADMIN-gated, not upgrade-gated). `or` is BINARY in Pact 5.4.
(enforce (or (not pco-claim.FROZEN-MODULE)
             (<= (pco.get-balance-default pco-claim.POOL-ACCOUNT)
                 pco-claim.FREEZE-RESIDUE-TOLERANCE))
  "pco-claim must not be frozen while the pool holds tokens - close claiming and sweep-pool first")

;; Deploy footer — fresh deploy creates tables and seeds the config CLOSED
;; and the ops meter at zero (epoch anchored at the UNIX epoch so the first
;; charge always rolls); upgrades touch nothing.
(if (read-msg 'upgrade)
  [ "upgrade" ]
  [ (create-table rounds)
    (create-table claims)
    (create-table config)
    (create-table ops-meter)
    (insert config "config" { "open": false })
    (insert ops-meter "meter" { "epoch-start": (time "1970-01-01T00:00:00Z"), "spent": 0.0 })
    ;; Register this module's own escrow with the token as OUTSIDE THE FLOAT,
    ;; here at the owner's deploy so the exclusion travels with the escrow -
    ;; and in the direction the dependency already goes (this module depends
    ;; on `pco`; `pco` naming this module would be circular).
    (pco.register-non-voting POOL-ACCOUNT
      "pco-claim pool escrow: undistributed community tokens, outside the float") ])
