#!/usr/bin/env bash
# Generate the THROWAWAY dry-run contracts from the real ones.
#
# GENERATED, never hand-edited. A hand-copied variant drifts from the contract
# it is supposed to be measuring, and then the dry run measures something we are
# not shipping — which is exactly the failure that made tests/fixtures/
# frozen-pco.pact stale once already. Re-run this after ANY contract change.
#
# What it changes, and nothing else:
#   * module names          pco -> pco-dryrun, pco-claim -> pco-claim-dryrun
#   * cross-module refs     pco.<fn> -> pco-dryrun.<fn>
#   * keyset name           <ns>.pco-gov -> <ns>.pco-dryrun-gov
#   * a THROWAWAY notice prepended to each module @doc
# The LOGIC is untouched, which is the point: what gets measured on mainnet is
# the code we intend to ship, renamed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=ops/out/dryrun
mkdir -p "$OUT"

gen () {  # $1 = source, $2 = target basename
  sed -e 's/^(module pco-claim GOVERNANCE/(module pco-claim-dryrun GOVERNANCE/' \
      -e 's/^(module pco GOVERNANCE/(module pco-dryrun GOVERNANCE/' \
      -e 's/\bpco-claim\.\([a-zA-Z-]\)/pco-claim-dryrun.\1/g' \
      -e 's/\bpco\.\([a-zA-Z-]\)/pco-dryrun.\1/g' \
      -e 's/{}\.pco-gov/{}.pco-dryrun-gov/g' \
      "$1" > "$OUT/$2"
  # Prepend the throwaway notice INSIDE the existing @doc. Done in python, not
  # awk/sed: the doc is a Pact multi-line string literal held together by
  # trailing backslashes, and a tool that reinterprets escapes silently
  # destroys it (observed).
  python3 - "$OUT/$2" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
marker = '  @doc "'
i = s.index(marker)
notice = (
  '  @doc "THROWAWAY TEST DEPLOYMENT - NOT THE PCO TOKEN. Deployed only to     \\\n'
  '  \\measure deployment cost and mechanics on the real chain. It confers      \\\n'
  '  \\nothing, is worth nothing, will be emptied, and its governance keyset is \\\n'
  '  \\retired at the end of the run so it can never be operated again by       \\\n'
  '  \\anyone, including its authors. Do not interact with it. The real PCO     \\\n'
  '  \\token deploys separately, under a different name, and is announced.      \\\n'
  '  \\                                                                         \\\n'
  '  \\Original module documentation follows.                                   \\\n'
  '  \\                                                                         \\\n'
  '  \\'
)
open(p, 'w').write(s[:i] + notice + s[i + len(marker):])
PYEOF
  echo "  generated $OUT/$2"
}

echo "generating dry-run contracts:"
gen contracts/pco.pact       pco-dryrun.pact
gen contracts/pco-claim.pact pco-claim-dryrun.pact

# Fail loudly if a rename was missed. A leftover bare `pco.` reference would
# bind the dry run to the REAL module name and could not deploy at all — better
# to stop here than to discover it mid-ceremony.
if grep -nE '\(module (pco|pco-claim) ' "$OUT"/*.pact; then
  echo "FAIL: a module declaration was not renamed"; exit 1
fi
if grep -nE '[^-]\bpco\.[a-zA-Z]' "$OUT"/*.pact; then
  echo "FAIL: an un-renamed cross-module reference to the real pco remains"; exit 1
fi
if ! grep -q "THROWAWAY TEST DEPLOYMENT" "$OUT/pco-dryrun.pact"; then
  echo "FAIL: the throwaway notice is missing"; exit 1
fi
echo "OK: renames complete, throwaway notice present"
