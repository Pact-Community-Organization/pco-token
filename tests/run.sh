#!/usr/bin/env bash
# Test runner: every suite must load green, and the namespace attack file
# must FAIL to load with "Keyset failure" (a passing load = broken guard).
set -u
cd "$(dirname "$0")"
fail=0

# Regenerate the frozen-pco fixture from the real contract before anything
# loads it. A hand-maintained copy goes stale silently, and then the
# post-freeze recovery proof runs against code we are not shipping.
if ! fixtures/make-frozen-pco.sh; then
  echo "FAIL  fixtures/make-frozen-pco.sh (could not regenerate frozen-pco.pact)"; exit 1
fi

# Same reasoning for the missing-table variants that missing-tables.repl loads:
# generated from the real pco.pact so a "chain missing table X" can never be
# simulated against code we are not shipping.
if ! fixtures/make-missing-table-pco.sh; then
  echo "FAIL  fixtures/make-missing-table-pco.sh (could not regenerate the variants)"; exit 1
fi

# Same reasoning for the throwaway dry-run pair: generate it from the current
# contracts before dryrun-smoke.repl loads it, so the variant can never drift
# from the code it exists to measure.
if ! ../ops/make-dryrun.sh >/dev/null; then
  echo "FAIL  ops/make-dryrun.sh (could not regenerate the dry-run contracts)"; exit 1
fi
for f in pco.repl pco-claim.repl pco-gas-station.repl namespace-rehearsal.repl lifecycle.repl negatives.repl regressions.repl ops-recovery.repl pairwise.repl dryrun-smoke.repl xchain.repl frozen.repl missing-tables.repl freeze-inflight.repl freeze-interlock.repl vision-offhub-voting.repl vision-shared-deadline.repl; do
  if pact "$f" >/dev/null 2>&1; then echo "PASS  $f"; else echo "FAIL  $f"; fail=1; fi
done
# The ceremony tooling asserts itself too. A mutation audit found that every
# break to ops/src/*.ts left this suite green, because it ran .repl files only —
# including flipping the default network to mainnet and deleting submit.ts's
# fail-closed guards. That code drives three hardware wallets; it gets a gate.
if (cd ../ops && npm run --silent test-ops >/dev/null 2>&1); then
  echo "PASS  ops/test/ops-checks.ts (ceremony tooling)"
else
  echo "FAIL  ops/test/ops-checks.ts (ceremony tooling)"; fail=1
fi
# The off-chain vote combiner and its self-test (combine-checks.ts) are part of the
# private suite; the public mirror runs a smaller set (see the note in run.sh's
# header comment). The combiner and its checks are not published, so they are not
# gated here.
# The only gate that compares TWO artifacts. Everything above reads one
# artifact and asks whether it agrees with itself: static-check reads .pact,
# the suites load .repl, verify-hash byte-compares the deploy against the same
# clone. All green, and none of them can notice that the UI is calling a
# contract API that no longer exists - which is exactly what shipped: a
# cast-vote sending a choice string to a function taking ranking:[integer], a
# create-proposal under a capability that was never defined, and a get-vote
# that is not a function.
# Second cross-artifact gate: RUNBOOK §A's sha256 table vs the actual contract
# bytes. §A previously recorded three hashes that matched NO commit in the
# repository, and nothing noticed because nothing compared them to anything.
if ../.github/scripts/runbook-hashes.sh >/dev/null 2>&1; then
  echo "PASS  runbook-hashes (RUNBOOK §A sha256 table matches contracts/)"
else
  echo "FAIL  runbook-hashes (§A does not match the contract bytes - run it directly)"; fail=1
fi
# The CANONICAL UI is in a DIFFERENT repository (the website), so this repo's CI
# can never see it. Scan it when its checkout happens to sit beside this one, and
# print which trees were covered either way - the point is that the limit is
# stated on every run instead of being invisible. web/ alone always yields calls,
# so the "examined nothing" floor cannot trip merely because the website is absent.
ui_roots=(../web)
ui_what="web/"
site=${PCO_SITE_SRC:-../../pco-website/src}
if [ -d "$site" ]; then ui_roots+=("$site"); ui_what="web/ + the canonical website UI"; fi
if ui_out=$(python3 ../.github/scripts/ui-contract-check.py --contracts ../contracts "${ui_roots[@]}" 2>&1); then
  # Print the coverage line: it names how many calls were actually checked, which
  # is the whole point of the gate and used to be discarded to /dev/null.
  echo "PASS  ui-contract-check ($ui_what)"
  echo "$ui_out" | sed -n 's/^-- ui-contract-check: /      /p'
else
  echo "FAIL  ui-contract-check ($ui_what):"; echo "$ui_out" | sed 's/^/      /'; fail=1
fi
# A negative test that does not name its expected error passes on ANY error. A
# cold audit found 16 here and proved two hollow by typo-ing a data key - the
# call then failed for an unrelated reason and the suite stayed green.
if ../.github/scripts/no-bare-expect-failure.sh >/dev/null 2>&1; then
  echo "PASS  no-bare-expect-failure (every negative test names its expected error)"
else
  echo "FAIL  no-bare-expect-failure (run it directly for the list)"; fail=1
fi
# must-fail files: the engine has to REFUSE these, and refuse them for the
# stated reason. A file that fails for an unrelated reason is a test that has
# quietly stopped testing anything, so the reason is asserted too.
must_fail () {  # $1 = file, $2 = required substring of the refusal, $3 = what a load would mean
  if pact "$1" >/dev/null 2>&1; then
    echo "FAIL  $1 (LOADED - $3)"; fail=1
  elif pact "$1" 2>&1 | grep -q "$2"; then
    echo "PASS  $1 (refused with '$2', as required)"
  else
    echo "FAIL  $1 (failed for the WRONG reason - expected '$2')"; fail=1
  fi
}
must_fail namespace-attack.repl-must-fail "Keyset failure" \
  "namespace guard broken"
must_fail frozen-station.repl-must-fail "the station must never be frozen" \
  "a FROZEN gas station deployed; the footer enforce is gone and the float can be stranded"
must_fail frozen-pool.repl-must-fail "must not be frozen while the pool holds tokens" \
  "pco-claim froze over a FUNDED pool; one unblessed pco upgrade then makes ~900,000 PCO permanently unrecoverable"
exit $fail
