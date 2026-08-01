#!/usr/bin/env bash
# Cross-artifact gate: the sha256 table in RUNBOOK §A must equal the actual
# contract bytes.
#
# WHY. The runbook recorded three source hashes that matched no commit in this
# repository - not the release tag, not HEAD. They were harmless only by luck:
# nothing executable read them, so they could not cause a bad deploy. But §A is
# the record the ceremony operator compares against, and it had silently drifted
# out of existence while every gate stayed green, because every gate compared one
# artifact with itself.
#
# This is the cheapest possible version of the missing check: recompute, compare,
# fail. A paper record nothing verifies is not a control.
set -uo pipefail
cd "$(dirname "$0")/../.."

RUNBOOK=docs/mainnet-pilot/RUNBOOK.md
fail=0

# The RUNBOOK is private-only (it names the devices and their custody), so it is
# NOT present on the public mirror. There is nothing to reconcile there, and this
# check must not fail a tree that legitimately does not contain the file — a
# public suite that goes red on a missing private file gets "fixed" by publishing
# the private file, which is the opposite of what we want.
if [ ! -f "$RUNBOOK" ]; then
  echo "  skip  RUNBOOK §A not present (public mirror) — nothing to reconcile"
  exit 0
fi

for f in contracts/*.pact; do
  mod=$(basename "$f" .pact)
  want=$(sha256sum "$f" | cut -d' ' -f1)
  # the row is: | `<mod>` | `<sha256>` |
  got=$(grep -oE "\| \`${mod}\` \| \`[0-9a-f]{64}\`" "$RUNBOOK" | grep -oE '[0-9a-f]{64}' | head -1)
  if [ -z "$got" ]; then
    echo "FAIL  ${mod}: no sha256 row in ${RUNBOOK} §A"
    fail=1
  elif [ "$got" != "$want" ]; then
    echo "FAIL  ${mod}: §A records ${got:0:16}… but the file hashes to ${want:0:16}…"
    fail=1
  else
    echo "  ok  ${mod}  ${want:0:16}…"
  fi
done

# And the reverse direction: a row naming a module that no longer exists means
# the table is describing a deploy we do not ship.
while read -r mod; do
  [ -f "contracts/${mod}.pact" ] || { echo "FAIL  §A records \`${mod}\`, which is not in contracts/"; fail=1; }
done < <(grep -oE "\| \`[a-z-]+\` \| \`[0-9a-f]{64}\`" "$RUNBOOK" | grep -oE '`[a-z-]+`' | tr -d '`' | sort -u)

exit $fail
