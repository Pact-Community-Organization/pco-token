;; pco-claim.pact — open, permissionless claim of the PCO community token,
;; organized in ROUNDS, plus judged recognition GRANTS.
;;
;; A ROUND is a self-serve claim event: anyone may claim the round's fixed
;; amount ONCE PER ACCOUNT PER ROUND, on the hub chain, inside the round's
;; time window, while the round's budget lasts, by presenting the round's
;; engagement code (published through PCO community channels; only its
;; BLAKE2b hash lives on-chain). There is NO recipient list: eligibility =
;; knowing the current code + a principal account. Rounds expire in-contract
;; at their announced close time; unclaimed budget never leaves the pool.
;;
;; A GRANT is a judged award (contribution bounties, retroactive builder
;; recognition, community micro-recognition): ops-signed, bounded per grant,
;; with a public reason string in the AWARDED event (e.g. the PR URL).
;;
;; Deliberate property — a claim needs NO signature from the claimer:
;; nothing of the claimer's is at risk (the account may not even exist
;; yet), tokens can only land in the account canonically bound to the
;; supplied guard (validate-principal), and a third party "claiming for
;; you" is a gift that consumes the slot exactly as your own claim would.
;; Requiring a signature would add envelope complexity and no security.
;; Sybil claiming (one person, many keys) is accepted by design: the token
;; is valueless and the on-chain invariants are one-claim-per-account-per-
;; round and the round budget — never per-person enforcement, and never
;; code secrecy (the code travels in claim tx code, so it is public chain
;; data as soon as the first claim lands; budgets are the real bound).
(namespace (read-msg 'ns))

(module pco-claim GOVERNANCE

  @doc "Claim distributor for the PCO community token: module-guarded      \
  \pool escrow; self-serve claim ROUNDS (fixed amount, fixed budget, time  \
  \window, engagement-code gate, one claim per account per round); judged  \
  \GRANTS with public reasons; master open/close switch; hub-chain only.   \
  \After the program ends (master switch closed), the community keyset may \
  \sweep the undistributed pool remainder to the community reserve (public \
  \SWEPT event).                                                           \
  \                                                                        \
  \Two privilege tiers, split by what a compromised key could do:          \
  \  * HIGH-CRITICAL (2-of-3 <ns>.pco-gov): module upgrade (GOVERNANCE)    \
  \    and the pool sweep (ADMIN) - the one path that redirects the whole  \
  \    pool remainder to an arbitrary receiver.                            \
  \  * ROUTINE OPS (OPS cap -> the guard in pco.ops-auth, which governance \
  \    names and can re-point at any time; governance itself always        \
  \    satisfies OPS): round creation and management (create-round /       \
  \    set-round-active / set-round-code),                                 \
  \    grants, and the master open/close switch. The ops key is the DRIP   \
  \    THROTTLE, not a vault key: every COMMITMENT it can make is bounded  \
  \    per object (round amount <= MAX-ROUND-AMOUNT, round budget <=      \
  \    MAX-ROUND-BUDGET, grant <= MAX-GRANT) and per day (create-round     \
  \    budgets + grants charge a daily ops meter, OPS-EPOCH-CAP, that      \
  \    fails closed and self-heals next epoch). A lone compromised ops     \
  \    key can at worst commit OPS-EPOCH-CAP per epoch (2x across one      \
  \    epoch boundary) in bounded, publicly evented objects, or hold       \
  \    claiming closed (kill-switch DoS). Every                            \
  \    such act is visible via ROUND-CREATED/ROUND-SET/CODE-SET/OPEN-SET/  \
  \    AWARDED events; governance can always close and sweep through its   \
  \    OPS/ADMIN authority, and the definitive revocation is instant and   \
  \    upgrade-free: governance calls (pco.set-ops-guard) to name a new    \
  \    ops authority - available even after a module freeze. The           \
  \    governance keyset always satisfies OPS too (strictly stronger), so  \
  \    a lost ops key never strands operation."

  ;; -----------------------------
  ;; Governance
  ;; -----------------------------

  (defconst NS:string (read-msg 'ns)
    "Deploy namespace, fixed at deploy.")

  (defconst ADMIN-KS:string (format "{}.pco-gov" [NS])
    "The community governance keyset (2-of-3 hardware keys).")

  (defconst FROZEN-MODULE:bool false
    "Set true and redeploy to permanently freeze upgrades.")

  (defconst FREEZE-RESIDUE-TOLERANCE:decimal 1.0
    "Pool residue the freeze interlock tolerates. The interlock exists to stop \
    \a freeze while the pool is FUNDED - the ~900,000 undistributed community  \
    \tokens, which a freeze before the sweep would strand. A trace balance is  \
    \not that, and the pool account is a public address that anyone may send   \
    \to, so the check is a threshold rather than an equality: an irreversible  \
    \ceremony must not depend on the balance being exactly zero at the moment  \
    \it runs. Residue below this stays recoverable after the freeze, because   \
    \`sweep-pool` is ADMIN-gated rather than gated on the upgrade capability.")

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
         \authority named by governance in `pco` (ONE value governs the    \
         \routine tier for both modules, so a single set-ops-guard call    \
         \rotates ops everywhere), with the 2-of-3 governance keyset as an \
         \always-available fallback tried FIRST - strictly stronger, and   \
         \it means a broken or hostile ops authority can never lock        \
         \governance out. Scoped-signature friendly."
    ;; BRANCH ORDER IS LOAD-BEARING - do not "tidy" it back. Same reasoning as
    ;; pco.PROPOSAL-OPS, and the same measured failure: the ops branch reads
    ;; `pco.ops-auth`, a missing TABLE raises a database error, and that error
    ;; is contained by neither `try` nor `enforce-one`. Hoisting the read into a
    ;; `let` above the enforce-one - which is what this cap used to do - ran it
    ;; before EITHER branch and locked the governance keyset out of create-round,
    ;; grant, grant-batch and set-open on any chain missing that table, with no
    ;; on-chain repair because set-ops-guard writes to it too.
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
    \grants (charged at create-round/grant time, worst-case). Fails closed,\
    \self-heals next epoch. Honest bound (audit INFO): per EPOCH, not per  \
    \sliding day - a key can commit up to 2x the cap inside one 24h window \
    \straddling an epoch boundary; the sustained rate is cap/day and every \
    \commitment is publicly evented. It is a rate limit, NOT a pool-       \
    \solvency guarantee: cumulative commitments are not reconciled against \
    \the pool balance (an over-committed round simply fails late claims    \
    \with insufficient funds, atomically). Sized to admit the genesis      \
    \round (30k) plus slack in one epoch.")

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
    @doc "The guard of the claim pool account: a MODULE GUARD of pco-claim. \
         \The pool is spendable only when this module's own code is on the call \
         \stack (claim / grant / sweep-pool), or by acquiring pco-claim's module \
         \admin (its governance keyset). This ties every pool spend to a genuine \
         \in-module operation, so no other module or bare transaction can move \
         \pool funds. \
         \NEVER RENAME this module: the pool account principal derives from this \
         \guard, and this guard names the module - a rename strands the pool."
    (create-module-guard "pco-claim-pool"))

  (defconst POOL-ACCOUNT:string (create-principal (pool-guard))
    "The claim pool: an m: (MODULE-GUARD) principal account in the pco token, \
    \credited by init-mint, debitable only through this module's            \
    \claim/grant/sweep paths.                                               \
    \                                                                       \
    \WHAT KEEPS THESE ~900,000 TOKENS OUT OF THE TALLY is the by-NAME        \
    \non-voting register in `pco`, written by this module's own deploy       \
    \footer - one row, and removable by governance. It is NOT the `m:` tag.  \
    \An earlier version of this docstring said pco bars contract-controlled  \
    \principals from voting; that principal-TYPE rule was deliberately       \
    \removed (it would also disenfranchise participants who legitimately     \
    \hold through a contract), so relying on the tag would leave the pool    \
    \voting. If this module is ever redeployed on a chain where that footer  \
    \does not re-register the pool, the exclusion is gone - verify           \
    \`(pco.non-voting? (pool-account))` on a live deploy, not the prefix.")

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

  ;; Every event capability carries a real body. An @event cap authorizes
  ;; nothing, but a body that asserts nothing makes the event meaningless - and
  ;; this program publishes participation numbers. House rule: every event cap
  ;; requires the capability that authorized the real action. CLAIMED is emitted
  ;; on the deliberately permissionless claim path where no capability is held,
  ;; so it instead requires the claim ROW to exist with a matching amount. That
  ;; row is written by `claim` and by nothing else.

  (defcap CLAIMED (round-id:string account:string amount:decimal)
    @event
    ;; HONEST LIMIT: a CLAIMED event cannot be invented - there is no row to read
    ;; without a real claim, and a mismatched amount is rejected - but it CAN be
    ;; restated. Participation figures must therefore count DISTINCT ACCOUNTS in
    ;; the claims table, never CLAIMED events.
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
         \acquired OPS capability.                                           \
         \Exactly two callers: create-round (the budget) and grant-internal  \
         \(the award). Nothing else charges it - notably rotating a round's  \
         \code does not, which is why that is forbidden outright once a      \
         \round has claims rather than metered.                              \
         \WHAT THIS BOUNDS: commitment, not outflow. A budget committed in   \
         \one epoch is claimable in later epochs, so same-day extraction can \
         \exceed OPS-EPOCH-CAP. It is a rate limit on new obligations, and   \
         \never a solvency guarantee."
    (require-capability (OPS))
    ;; Self-defending: a negative charge would CREDIT the meter and unbound the
    ;; day's spend. OPS has a real body so this is not reachable by an outsider,
    ;; but a public function must never trust its callers.
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
    @doc "OPS: rotate a round's engagement code, allowed ONLY while the     \
         \round has had no claims yet (hash computed off-chain).            \
         \                                                                  \
         \WHY THE no-claims CONDITION. Re-pointing the code hands a round's \
         \REMAINING budget to whoever knows the new code. Before the first  \
         \claim that is only legitimate incident response - a code leaked   \
         \before anyone used it - and it grants ops nothing it did not      \
         \already have, since it could have opened the round with the new   \
         \code to begin with. AFTER claims have started it is a different   \
         \act: it takes budget the community is already drawing on and      \
         \redirects it to accounts of ops' choosing. The daily ops meter    \
         \does NOT bound that, and cannot: create-round charged this budget \
         \on the day it was opened, so extracting it later is unmetered     \
         \spend against an old commitment. Freezing the code at the first   \
         \claim closes the redirect outright. If a live round's code must   \
         \genuinely change, deactivate it and open a new round - which      \
         \meters its own budget on the day it is opened."
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
         \later keyset enforcement in the same tx (scoped and unscoped     \
         \sigs alike; REPL-verified 5.4) - so a batch must acquire OPS     \
         \ONCE and never re-enforce after the first install."
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



;; NEVER FREEZE THIS MODULE WHILE THE POOL HOLDS TOKENS.
;;
;; This module CALLS pco (get-balance, transfer-create, precision), and a
;; dependent runs the PINNED copy of its dependency. That pinned copy dies the
;; moment it touches the database unless the newer pco blesses the old hash -
;; measured: "Execution aborted, hash not blessed for module <ns>.pco".
;;
;; Compose that with a freeze and the pool is GONE: freeze this module while it
;; holds ~900,000 PCO, then upgrade pco without blessing, and pool-balance,
;; grant, claim AND sweep-pool - the documented recovery path - all die. A frozen
;; module cannot be redeployed to re-pin, so there is no on-chain recovery and no
;; key or quorum that helps. The tokens stay visible in pco.accounts and
;; unspendable forever.
;;
;; pco-gas-station carries a hard footer enforce against its own freeze for
;; exactly this class of hazard, over a 1 KDA float. This module guards 900,000
;; PCO and had only a prose warning. The freeze is now refused unless the pool is
;; empty - which is the precondition the runbook's sanctioned freeze order
;; already states: close claiming, sweep, freeze pco, re-pin, freeze this.
;;
;; OUTSIDE the `if` deliberately: the fresh branch does not run on an upgrade
;; deploy, and a frozen UPGRADE is the only way this could realistically ship.
;; TWO corrections to the first version of this interlock, both measured:
;;
;; 1. It used `pco.get-balance`, which RAISES on a missing row. The pool row is
;;    written by the mint, and the mint is hub-only - so on 19 of 20 chains the
;;    freeze deploy aborted with "No value found in table ... pco_accounts",
;;    refusing the freeze because the pool was EMPTY. `get-balance-default`
;;    reads the same row and returns 0.0 when it does not exist.
;;
;; 2. `= 0.0` required the balance to be EXACTLY zero at the moment the freeze
;;    deploy ran. The pool is a public address anyone may send to, so that made
;;    an irreversible ceremony depend on a condition the operator does not
;;    control. The hazard this interlock exists for is a FUNDED pool - the
;;    ~900,000 that would strand if the code were frozen before the sweep - so
;;    a threshold expresses it and an equality does not. Residue stays
;;    recoverable: `sweep-pool` is ADMIN-gated rather than gated on the upgrade
;;    capability, so it still works after the freeze.
;;
;; `or` is BINARY in Pact 5.4 - a third branch must nest.
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
    ;; Register this module's own escrow with the token as OUTSIDE THE FLOAT.
    ;; The pool holds undistributed community tokens, so it carries no voice.
    ;; Done HERE, at the owner's deploy, rather than as a ceremony step: the
    ;; exclusion then travels with the escrow and cannot be forgotten. It also
    ;; runs in the direction the dependency already goes - this module depends
    ;; on `pco`, so it can name the pool to `pco`, while `pco` naming this
    ;; module would be circular.
    (pco.register-non-voting POOL-ACCOUNT
      "pco-claim pool escrow: undistributed community tokens, outside the float") ])
