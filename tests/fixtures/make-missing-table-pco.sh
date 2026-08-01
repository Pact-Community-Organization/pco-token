#!/usr/bin/env bash
# Generate pco variants with ONE (create-table ...) removed, from the REAL
# contracts/pco.pact.
#
# WHY THIS EXISTS. Three separate findings turn on the same engine fact: a
# read against a table that does not exist raises a DATABASE error, and a
# database error is contained by NEITHER `try` NOR `enforce-one`. So a chain
# deployed in upgrade mode before some table existed (the documented P3b case)
# behaves very differently from a fresh deploy, and no fresh-deploy test can
# see it.
#
# One REPL holds one Pact DB, so a chain that is genuinely missing a table
# cannot be simulated by deleting a row - the table itself has to be absent
# from the deploy. That is what these variants are for. They are GENERATED,
# never committed by hand, for the same reason frozen-pco.pact is: a
# hand-maintained copy goes stale the moment pco.pact changes, and then the
# recovery proof runs against code we are not shipping (audit M-3).
#
# Each variant is loaded into its OWN namespace by missing-tables.repl, because
# a single REPL cannot hold two definitions of the same module with different
# table sets.
set -euo pipefail
cd "$(dirname "$0")"

gen () {  # $1 = table to omit, $2 = output fixture
  local tbl=$1 out=$2 src=../../contracts/pco.pact
  grep -q "    (create-table ${tbl})" "$src" || {
    echo "make-missing-table: '(create-table ${tbl})' not found in $src" >&2
    exit 1; }
  awk -v tbl="$tbl" '
    $0 == "    (create-table " tbl ")" && !done { done = 1; next }
    { print }
  ' "$src" > "$out"
  # the omission must be real, and it must be the ONLY change
  if grep -q "(create-table ${tbl})" "$out"; then
    echo "make-missing-table: ${tbl} still created in $out" >&2; exit 1
  fi
  local before after
  before=$(grep -c "(create-table " "$src")
  after=$(grep -c "(create-table " "$out")
  if [ "$after" -ne "$((before - 1))" ]; then
    echo "make-missing-table: expected one fewer create-table in $out ($before -> $after)" >&2
    exit 1
  fi
}

gen ops-auth       missing-ops-auth-pco.pact
gen vote-delegates missing-vote-delegates-pco.pact
gen rcv-actives    missing-rcv-actives-pco.pact
