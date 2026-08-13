#!/usr/bin/env bash
# preflight-round.sh — everything that must be true before a claim round is built,
# signed on a device, and submitted to mainnet.
#
# WHY THIS EXISTS. Opening a round is a RECURRING op (biweekly Pact Quests, monthly
# governance reading-quests, per-event community calls). The 2026-08-13 pre-flight
# audit that preceded the first standalone `create-round` cost 13 agents and ~40
# minutes, and nearly everything it found was ONE-TIME rot in the surrounding docs
# and tooling, not per-round risk. Those defects are fixed. What genuinely recurs is
# the handful of mechanical state checks below, and a human re-deriving them every
# fortnight is a checklist that eventually gets skipped. So they live here.
#
# It is NECESSARY, NEVER SUFFICIENT. It cannot judge whether the question is any
# good, whether the answer is discoverable, or whether the window suits the calendar.
# And it cannot do the one irreducible control: comparing the hash on the device
# screen against a second machine. See ROUNDS.md for the human half.
#
# READ-ONLY. Runs no transaction, writes no file, touches no device, never submits.
#
# Usage — NOTE THE PLACEHOLDERS. Never commit a real round id beside its real answer:
# that pairing is the one thing about a round that must not be public, and a usage
# example in a published file is exactly where it would hide. (A previous round's
# answer was burned by the same class of mistake, via a different file.)
#   PCO_NETWORK=mainnet01 PCO_HOST=https://api.chainweb-community.org \
#   PCO_ROUND_ID='<round-id>' PCO_QUEST_ANSWER='<normalized answer>' \
#   PCO_OPENS=2026-01-01T12:00:00Z PCO_CLOSES=2026-01-15T12:00:00Z \
#     ./preflight-round.sh
#
# Optional: PCO_AMOUNT (default 100.0) · PCO_BUDGET (default 2500.0)
#           PCO_CODE_HASH (cross-checked against the answer if given)
#           PCO_SKIP_PUBLIC_SCAN=1 (offline; the scan is then reported UNKNOWN, not passed)
set -uo pipefail
cd "$(dirname "$0")"

PASS=0; FAIL=0; RAN=0
ok()   { RAN=$((RAN+1)); PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { RAN=$((RAN+1)); FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; return 0; }
note() { printf '        %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 0. inputs
head_ "0 · inputs"

: "${PCO_ROUND_ID:?set PCO_ROUND_ID}"
: "${PCO_QUEST_ANSWER:?set PCO_QUEST_ANSWER (the plaintext answer; it is never transmitted)}"
: "${PCO_OPENS:?set PCO_OPENS (UTC, e.g. 2026-08-15T12:00:00Z)}"
: "${PCO_CLOSES:?set PCO_CLOSES (UTC)}"
AMOUNT="${PCO_AMOUNT:-100.0}"
BUDGET="${PCO_BUDGET:-2500.0}"

# The network must be chosen DELIBERATELY. env.ts defaults to the local devnet, and a
# preflight that silently measured devnet would clear a mainnet ceremony against the
# wrong chain — the most dangerous possible false green.
if [ "${PCO_NETWORK:-}" != "mainnet01" ]; then
  printf '\033[31mABORT\033[0m  PCO_NETWORK is %s — set it to mainnet01 explicitly.\n' "${PCO_NETWORK:-<unset>}"
  exit 2
fi
: "${PCO_HOST:?set PCO_HOST (https://api.chainweb-community.org)}"
NS="$(python3 -c "import json;print(json.load(open('mainnet-config.json'))['ns'])" 2>/dev/null || true)"
[ -n "$NS" ] || { printf '\033[31mABORT\033[0m  cannot read ns from ops/mainnet-config.json\n'; exit 2; }
note "round=$PCO_ROUND_ID  amount=$AMOUNT  budget=$BUDGET"
note "window=[$PCO_OPENS, $PCO_CLOSES)"
note "ns=$NS  network=$PCO_NETWORK"

local_read() { npx tsx src/local.ts "$1" 0 2>&1 | tail -1; }

# ---------------------------------------------------------------- 1. tooling pin
head_ "1 · ceremony tooling matches its pin"

# The device shows a HASH, never readable code, so the only thing standing between the
# operator and approving something they did not intend is that the tool which BUILT the
# transaction is a known, reviewed version. Scoped to the four files that actually
# construct and submit it — docs and tests move constantly, and a gate that fires on a
# README edit is a gate that gets waved through.
TOOLS=(src/build-tx.ts src/submit.ts src/sign-step.ts verify-hash.py)
PIN="$(git tag -l 'ops-verified-*' | sort -V | tail -1)"
[ -n "$PIN" ] && PIN_KIND="ops-verified" || { PIN="mainnet-v1"; PIN_KIND="deploy tag (no ops-verified-* tag exists yet)"; }
PIN_COMMIT="$(git rev-parse --verify "${PIN}^{}" 2>/dev/null || true)"   # ^{} — annotated tags are their own object
if [ -z "$PIN_COMMIT" ]; then
  bad "the pin tag '$PIN' resolves" "no such tag — cannot establish what the tools should be"
else
  ok "pin resolved: $PIN -> ${PIN_COMMIT:0:12} ($PIN_KIND)"
  drift="$(cd .. && git diff --name-only "${PIN_COMMIT}" HEAD -- $(printf 'ops/%s ' "${TOOLS[@]}") 2>/dev/null)"
  if [ -z "$drift" ]; then ok "the 4 ceremony tools are identical to the pin"
  else bad "the 4 ceremony tools are identical to the pin" "drifted: $(echo "$drift" | tr '\n' ' ')"; fi
  dirty="$(cd .. && git status --porcelain -- $(printf 'ops/%s ' "${TOOLS[@]}") 2>/dev/null)"
  if [ -z "$dirty" ]; then ok "no uncommitted edits to the ceremony tools"
  else bad "no uncommitted edits to the ceremony tools" "$(echo "$dirty" | tr '\n' ' ')"; fi
fi

# ---------------------------------------------------------------- 2. round id
head_ "2 · round id"

len=${#PCO_ROUND_ID}
if [ "$len" -ge 3 ] && [ "$len" -le 64 ]; then ok "id length $len is within 3-64"
else bad "id length $len is within 3-64" "validate-round-id would abort"; fi
case "$PCO_ROUND_ID" in
  *"|"*) bad "id contains no '|'" "'|' is the claims-table key separator" ;;
  *)     ok "id contains no '|'" ;;
esac
if LC_ALL=C printf '%s' "$PCO_ROUND_ID" | grep -qE '^[[:print:]]+$'; then ok "id is printable ASCII"
else bad "id is printable ASCII" "is-charset CHARSET_ASCII would abort"; fi

# `insert` BURNS the id the moment the transaction mines, correct or not. There is no
# delete in Pact and no setter for the window, amount or budget — a wrong round is
# abandoned, not repaired, and the id can never be reused.
existing="$(local_read "(${NS}.pco-claim.get-round \"${PCO_ROUND_ID}\")")"
case "$existing" in
  *ERROR*|*"No value found"*|*failure*) ok "id '$PCO_ROUND_ID' is still free on-chain" ;;
  *) bad "id '$PCO_ROUND_ID' is still free on-chain" "ALREADY EXISTS -> $existing ; pick a NEW id, this is not a retry" ;;
esac

# ---------------------------------------------------------------- 3. answer + hash
head_ "3 · answer and code hash"

# The claim page normalises with trim+lowercase before hashing and before submitting,
# so an answer carrying capitals or edge whitespace is UNCLAIMABLE through the site no
# matter how correct it looks here.
NORM="$(printf '%s' "$PCO_QUEST_ANSWER" | tr '[:upper:]' '[:lower:]' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ "$NORM" = "$PCO_QUEST_ANSWER" ]; then ok "answer is already trim+lowercase (site-normalisable)"
else bad "answer is already trim+lowercase" "the site would submit '$NORM' instead — hash the normalised form"; fi

command -v pact >/dev/null || { bad "pact is on PATH to compute the code hash" "install pact 5.4"; }
COMPUTED=""
if command -v pact >/dev/null; then
  t="$(mktemp -d)"; printf '(print (hash "%s"))\n' "$NORM" > "$t/h.repl"
  COMPUTED="$(pact "$t/h.repl" 2>/dev/null | head -1 | tr -d '"')"; rm -rf "$t"
  if [ -n "$COMPUTED" ]; then ok "code hash computed off-chain: $COMPUTED"
  else bad "code hash computed off-chain" "pact produced no output"; fi
fi
if [ -n "${PCO_CODE_HASH:-}" ] && [ -n "$COMPUTED" ]; then
  if [ "$PCO_CODE_HASH" = "$COMPUTED" ]; then ok "PCO_CODE_HASH matches the answer"
  else bad "PCO_CODE_HASH matches the answer" "given $PCO_CODE_HASH but the answer hashes to $COMPUTED"; fi
fi
if [ -n "$COMPUTED" ]; then
  if grep -qF "$COMPUTED" ../docs/events/ROUNDS.md 2>/dev/null; then
    ok "the hash is recorded in the private brief (ROUNDS.md)"
  else
    bad "the hash is recorded in the private brief (ROUNDS.md)" "record the round in docs/events/ROUNDS.md before building"
  fi
fi

# ---------------------------------------------------------------- 4. not pre-published
head_ "4 · the answer is not already public"

# A pre-published answer hands the round's entire budget to whoever read it. This is
# not hypothetical: the ORIGINAL quest-2 answer was burned exactly this way, by the
# private brief reaching the public mirror. Note the answer STRING is often public by
# design (the quest sends you to find it) — what must never be public is the
# QUESTION-to-ANSWER PAIRING, and the code hash, which proves a guess without asking.
if [ "${PCO_SKIP_PUBLIC_SCAN:-0}" = "1" ]; then
  bad "public mirror scanned for the code hash" "SKIPPED by PCO_SKIP_PUBLIC_SCAN — unknown is not a pass"
elif ! command -v gh >/dev/null; then
  bad "public mirror scanned for the code hash" "gh not on PATH — cannot determine, so this fails closed"
else
  tb="$(mktemp -d)"
  if gh api repos/Pact-Community-Organization/pco-token/tarball -H "Accept: application/vnd.github+json" > "$tb/t.tar.gz" 2>/dev/null \
     && tar xzf "$tb/t.tar.gz" -C "$tb" 2>/dev/null; then
    files_scanned="$(find "$tb" -type f | wc -l)"
    if [ "$files_scanned" -lt 10 ]; then
      bad "public mirror scanned" "only $files_scanned files extracted — a scan of nothing is not a clean scan"
    else
      hits="$(grep -rlF "$COMPUTED" "$tb" 2>/dev/null | wc -l)"
      if [ "$hits" -eq 0 ]; then ok "code hash absent from all $files_scanned public files"
      else bad "code hash absent from the public mirror" "$hits file(s) contain it — the round is pre-solved, pick a new answer"; fi
    fi
  else
    bad "public mirror scanned for the code hash" "could not fetch the tarball — cannot determine"
  fi
  rm -rf "$tb"
fi
note "the answer STRING may legitimately be public; a human must confirm the QUESTION+ANSWER pairing is not"

# ---------------------------------------------------------------- 5. window
head_ "5 · window"

# Pact 5 parses exactly %Y-%m-%dT%H:%M:%SZ. build-tx interpolates these RAW into
# (time "...") with no parse and no ordering check, and the TO-FILL guard cannot see a
# well-formed-but-wrong value — so a JavaScript toISOString() (which emits
# milliseconds) fails only at submit, after the approval is already spent.
tparse="$(local_read "[(time \"${PCO_OPENS}\") (time \"${PCO_CLOSES}\")]")"
case "$tparse" in
  *ERROR*|*failed*) bad "both time literals parse on the deployed engine" "$tparse" ;;
  *) ok "both time literals parse on the deployed engine" ;;
esac
ordered="$(local_read "(< (time \"${PCO_OPENS}\") (time \"${PCO_CLOSES}\"))")"
case "$ordered" in *true*) ok "opens < closes" ;; *) bad "opens < closes" "$ordered" ;; esac

# Measured against BLOCK TIME (the parent block's timestamp), never the host clock:
# the contract enforces [opens, closes) against the chain, and the two differ.
CHAIN_NOW="$(local_read "(at 'block-time (chain-data))")"
note "chain block-time: $CHAIN_NOW"
lead="$(local_read "(/ (diff-time (time \"${PCO_OPENS}\") (at 'block-time (chain-data))) 3600.0)")"
lead_h="$(printf '%s' "$lead" | sed 's/^c0: //')"
if printf '%s' "$lead_h" | grep -qE '^-?[0-9.]+$' && [ "$(printf '%.0f' "$lead_h" 2>/dev/null || echo -1)" -ge 3 ]; then
  ok "opens is ${lead_h}h ahead of block time (covers the TTL and the read-back)"
else
  bad "opens is comfortably ahead of block time" "lead=${lead_h}h — a round that opens before you have read it back and announced it hands the budget to chain-watchers"
fi

# ---------------------------------------------------------------- 6. bounds + solvency
head_ "6 · contract bounds, meter and solvency"

for pair in "MAX-ROUND-AMOUNT:$AMOUNT" "MAX-ROUND-BUDGET:$BUDGET"; do
  k="${pair%%:*}"; v="${pair##*:}"
  r="$(local_read "(<= ${v} ${NS}.pco-claim.${k})")"
  case "$r" in *true*) ok "$v respects $k" ;; *) bad "$v respects $k" "$r" ;; esac
done
r="$(local_read "(>= ${BUDGET} ${AMOUNT})")"
case "$r" in *true*) ok "budget covers at least one claim" ;; *) bad "budget covers at least one claim" "$r" ;; esac
r="$(local_read "(and (= (floor ${AMOUNT} (${NS}.pco.precision)) ${AMOUNT}) (= (floor ${BUDGET} (${NS}.pco.precision)) ${BUDGET}))")"
case "$r" in *true*) ok "amount and budget respect the token precision" ;; *) bad "amount and budget respect the token precision" "$r" ;; esac

# create-round charges the FULL budget against the daily ops meter at creation time.
r="$(local_read "(<= (+ (${NS}.pco-claim.ops-epoch-spent) ${BUDGET}) ${NS}.pco-claim.OPS-EPOCH-CAP)")"
case "$r" in *true*) ok "the budget fits inside today's ops meter" ;; *) bad "the budget fits inside today's ops meter" "$r — wait for the epoch roll"; esac

# The meter is a RATE LIMIT, not a solvency guarantee: the contract never reconciles
# committed budgets against the pool, so an over-committed round simply fails late
# claims. Solvency is the operator's to own.
POOL="$(local_read "(${NS}.pco-claim.pool-balance)" | sed 's/^c0: //')"
note "pool balance: $POOL   (outstanding commitments are yours to track; see ROUNDS.md)"
r="$(local_read "(> (${NS}.pco-claim.pool-balance) ${BUDGET})")"
case "$r" in *true*) ok "pool balance exceeds this round's budget" ;; *) bad "pool balance exceeds this round's budget" "$r" ;; esac

# ---------------------------------------------------------------- 7. claimability
head_ "7 · claims can actually land"

r="$(local_read "(at 'open (${NS}.pco-claim.get-config))")"
case "$r" in *true*) ok "the master claim switch is OPEN" ;; *) bad "the master claim switch is OPEN" "$r — claims would abort"; esac
STATION="$(local_read "(${NS}.pco-gas-station.station-account)" | sed 's/^c0: //' | tr -d '"')"
if [ -n "$STATION" ]; then
  FLOAT="$(local_read "(coin.get-balance \"${STATION}\")" | sed 's/^c0: //')"
  note "gas station float: $FLOAT KDA (sponsors the claims; small by design)"
  ok "gas station account resolved"
else
  bad "gas station account resolved" "cannot read the station account"
fi

# ---------------------------------------------------------------- verdict
head_ "verdict"
# A check that inspected zero items must FAIL, never pass.
if [ "$RAN" -eq 0 ]; then
  printf '\033[31mNO-GO\033[0m  0 checks ran — that is a broken preflight, not a clean one.\n'; exit 2
fi
printf '  %d checks · %d passed · %d failed\n\n' "$RAN" "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mGO\033[0m  mechanical preconditions are met.\n'
  printf '    Still REQUIRED and not automatable: the question is published without the answer,\n'
  printf '    the device hash is compared on a SECOND machine, and the round is read back\n'
  printf '    BEFORE the announcement (set-round-code dies at the first claim).\n'
  exit 0
fi
printf '\033[31mNO-GO\033[0m  %d check(s) failed — do not build or sign.\n' "$FAIL"
exit 1
