#!/usr/bin/env bash
# Generate frozen-pco.pact from the REAL contracts/pco.pact.
#
# Why generated and not committed-by-hand: this fixture is what the
# post-freeze ops-recovery proof loads. A hand-maintained copy silently goes
# stale the moment pco.pact changes, and then the freeze leg proves recovery
# against code we are NOT shipping — which is exactly what happened once
# (audit M-3, 2026-07-25). Regenerating on every run makes that impossible.
#
# Two edits, both mirroring what the real freeze deploy does:
#   1. FROZEN-MODULE false -> true   (the one-way door)
#   2. add a (bless ...) form        (the runbook mandates the freezing deploy
#      blesses the pre-freeze hash; without it a frozen dependent strands)
# The blessed hash is a valid-FORMAT placeholder (Pact rejects malformed ones
# at load): the REPL never has to resolve it, and its only job here is to keep
# the fixture structurally identical to a real freeze deploy.
set -euo pipefail
cd "$(dirname "$0")"

# Both modules get a frozen fixture. pco alone was not enough: the funded
# post-freeze paths (transfer, vote, claim, sweep) need the PAIR frozen, and
# those are the paths that would trap value if a freeze disabled them.
gen () {  # $1 = source contract, $2 = output fixture
src=$1
out=$2

grep -q 'FROZEN-MODULE:bool false' "$src" || {
  echo "make-frozen: '(defconst FROZEN-MODULE:bool false' not found in $src" >&2; exit 1; }

awk '
  /\(defconst FROZEN-MODULE:bool false/ && !done {
    print "  ;; GENERATED FIXTURE - do not edit; see fixtures/make-frozen-pco.sh"
    print "  (bless \"DldRwCblQ7Loqy6wYJnaodHl30d3j3eH-qtFzfEv46g\")"
    print ""
    sub(/FROZEN-MODULE:bool false/, "FROZEN-MODULE:bool true")
    done = 1
  }
  { print }
' "$src" > "$out"

grep -q 'FROZEN-MODULE:bool true' "$out" || { echo "make-frozen: flip failed for $src" >&2; exit 1; }
grep -q '(bless ' "$out" || { echo "make-frozen: bless not inserted for $src" >&2; exit 1; }
}

gen ../../contracts/pco.pact       frozen-pco.pact
gen ../../contracts/pco-claim.pact frozen-pco-claim.pact

# The station gets one too, for the OPPOSITE reason: this fixture must REFUSE
# to load. The station pins `coin` at runtime through withdraw, so freezing it
# would strand the float the first time coin is upgraded, and its deploy footer
# now enforces that. frozen.repl asserts the refusal - without this fixture,
# deleting that footer enforce breaks no test, which is exactly the state a
# mutation audit found it in.
gen ../../contracts/pco-gas-station.pact frozen-pco-gas-station.pact

# ---------------------------------------------------------------------------
# frozen-pco-blessed.pact — frozen AND blessing the REAL pre-freeze hash.
#
# frozen-pco.pact blesses a valid-format PLACEHOLDER, which is right for the
# tests that only need a structurally real freeze. It is useless for the one
# property that actually matters about the bless: an in-flight cross-chain
# defpact resumes against the hash it STARTED under, so a freeze that does not
# bless that hash strands the tokens permanently - debited on the source chain,
# uncreditable on the target, with no rollback for step 1.
#
# Proving the RECOVERY half needs the true hash, so it is computed here rather
# than hardcoded (hardcoding it would go stale on the next contract edit and
# quietly turn the recovery assertion into a second copy of the failure one).
PCO_HASH=$(pact hash-probe.repl 2>/dev/null | grep -o 'PCO-HASH=[A-Za-z0-9_-]*' | cut -d= -f2)
if ! printf '%s' "$PCO_HASH" | grep -qE '^[A-Za-z0-9_-]{43}$'; then
  echo "make-frozen: could not read pco's module hash (got '${PCO_HASH}')" >&2; exit 1
fi
awk -v h="$PCO_HASH" '
  /\(defconst FROZEN-MODULE:bool false/ && !done {
    print "  ;; GENERATED FIXTURE - do not edit; see fixtures/make-frozen-pco.sh"
    print "  ;; blesses the REAL pre-freeze hash, so an in-flight cross-chain"
    print "  ;; defpact can still resume across the freeze."
    print "  (bless \"" h "\")"
    print ""
    sub(/FROZEN-MODULE:bool false/, "FROZEN-MODULE:bool true")
    done = 1
  }
  { print }
' ../../contracts/pco.pact > frozen-pco-blessed.pact
grep -q "(bless \"${PCO_HASH}\")" frozen-pco-blessed.pact \
  || { echo "make-frozen: real-hash bless not inserted" >&2; exit 1; }
