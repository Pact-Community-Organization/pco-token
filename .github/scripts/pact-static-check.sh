#!/usr/bin/env bash
# Pact 5 static-analysis gate for generic Copilot/Pact customization bundles.

set -euo pipefail

VIOLATIONS=0
WARNINGS=0

emit_violation() { printf 'VIOLATION: %s\n' "$1"; VIOLATIONS=$((VIOLATIONS + 1)); }
emit_warn() { printf 'WARN:      %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }
notice() { printf 'NOTICE:    %s\n' "$1"; }

is_missing_msg_data_error() {
  # Errors that mean "this file needs its deploy/test environment (env-data,
  # namespaces, keysets, or upstream module dependencies), not that the code is
  # wrong" — a bare `pact <file>` load can't verify these; the full .repl
  # harness (which loads deps + env) is authoritative.
  #
  # Includes MISSING-DEPENDENCY errors, but ONLY for known pre-deployed upstream
  # modules (coin, ns, fungible-*, marmalade, kip.*, util.*). A module that calls
  # e.g. `coin` fails a bare load because the standalone CLI has only a stub of it
  # ("Module coin has no such member: get-balance") or none at all ("Cannot find
  # module: coin"). That is an environment gap, not a code defect — the .repl
  # harness loads the real dependency and passes.
  #
  # This is deliberately scoped to that allowlist so that a TYPO against the
  # module's OWN members (e.g. "Module my-mod has no such member: my-typo") still
  # surfaces as a VIOLATION — downgrading those would let real bugs through.
  local deps='(coin|ns|fungible-v2|fungible-xchain-v1|fungible-util|gas-payer-v1|marmalade[-.v0-9]*|kip[-.][a-z0-9-]+|util[-.][a-z0-9-]+|nft-asset-v1|nft-market-v1|nft-xchain-v1)'
  printf '%s' "$1" | grep -qiE \
    'read-(msg|keyset|string|integer|decimal)|no (env-)?data|not (present|found) in (the )?(message|environment|tx)|key .* not found|environment data|namespace not found|cannot find keyset' \
  || printf '%s' "$1" | grep -qiE \
    "cannot find module: *${deps}\b|module ${deps} has no such member"
}

FILES=()
if [ "$#" -gt 0 ]; then
  for arg in "$@"; do
    if [ -f "$arg" ]; then
      FILES+=("$arg")
    else
      notice "skipping non-file argument: $arg"
    fi
  done
else
  while IFS= read -r f; do
    FILES+=("$f")
  done < <(find . \
    \( -path '*/node_modules/*' -o -path '*/.git/*' -o -path '*/dist/*' \) -prune -o \
    \( -name '*.pact' -o -name '*.repl' \) -type f -print | sort)
fi

if [ "${#FILES[@]}" -eq 0 ]; then
  notice "no .pact / .repl files to check"
  exit 0
fi

printf '== pact-static-check :: %d file(s) ==\n' "${#FILES[@]}"

if command -v pact >/dev/null 2>&1; then
  printf -- '-- Tier 1: pact <file> / --check-shadowing --\n'
  for f in "${FILES[@]}"; do
    if ! out="$(pact "$f" 2>&1)"; then
      if is_missing_msg_data_error "$out"; then
        emit_warn "$f: module requires tx message data (read-msg/read-keyset) — bare load can't verify; run full .repl harness"
        printf '%s\n' "$out" | sed 's/^/           /'
      else
        emit_violation "$f: pact load failed"
        printf '%s\n' "$out" | sed 's/^/           /'
      fi
    fi
    if ! out="$(pact --check-shadowing "$f" 2>&1)"; then
      emit_violation "$f: pact --check-shadowing failed (native shadowing)"
      printf '%s\n' "$out" | sed 's/^/           /'
    fi
  done
else
  notice "pact binary not on PATH — Tier 1 (parse/shadowing/type) SKIPPED."
  notice "Install or point to a Pact 5.3 binary for full coverage."
fi

printf -- '-- Tier 2: semantic greps --\n'

scan_file() {
  _file="$1"; _re="$2"; _kind="$3"; _rule="$4"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _ln="${line%%:*}"
    case "$_kind" in
      violation) emit_violation "$_file:$_ln $_rule" ;;
      warn) emit_warn "$_file:$_ln $_rule" ;;
    esac
  done < <(grep -nE "$_re" "$_file" 2>/dev/null || true)
}

for f in "${FILES[@]}"; do
  case "$f" in
    *.pact|*.repl) : ;;
    *) continue ;;
  esac

  scan_file "$f" 'expect-failure[[:space:]]+""([[:space:]]|\))' \
    violation 'empty expect-failure "" — empty substring matches any error (false pass)'

  scan_file "$f" 'expect-failure[[:space:]]+"[^"]+"[[:space:]]+""([[:space:]]|\)|$)' \
    violation 'empty expect-failure substring after doc string — matches any error (false pass)'

  scan_file "$f" '\(\+[[:space:]]+[^()[:space:]]+[[:space:]]+[^()[:space:]]+[[:space:]]+[^()[:space:]]+' \
    violation '3+ argument (+ ...) on one line — + is binary; nest as (+ a (+ b c))'

  scan_file "$f" '\(try\b.*\b(insert|update|write)\b' \
    violation 'DML (insert/update/write) inside try — try is read-only for DML'

  scan_file "$f" '\(enforce[[:space:]][^)]*\((read|with-read|with-default-read|select|fold-db|keys)[[:space:]]' \
    warn 'table read inside an enforce condition — passes in the REPL and on KDA-CE 3.1+ but FAILS on upstream-lineage nodes; house default: let-bind the read before the enforce (same-line matches only; reads via helper fns are not detected)'

  scan_file "$f" '\(defcap[[:space:]]+[A-Z][A-Z0-9_-]*[[:space:]]*\([[:space:]]*\)[[:space:]]+true[[:space:]]*\)' \
    violation 'governance/defcap body is literally `true` — anyone can satisfy it'

  # Tier-2: weak (`true`-bodied) NON-@event defcaps WITH args. A capability body is
  # an authorization decision, so a trivially satisfiable body is never a gate — if
  # such a cap guards a DML/value/state path, the guard is the body and the body
  # decides nothing. WARN (not VIOLATION): weak caps are a legitimate pattern for
  # events and intra-module structure, but each one guarding value or state MUST be
  # proven safe by a negative test written from outside the module, or it is a
  # finding. @event-only caps gate nothing → skipped.
  while IFS='|' read -r wln wname; do
    [ -n "$wln" ] && emit_warn "$f:$wln weak \`true\`-bodied cap $wname — a trivially satisfiable body is not a gate; if it guards value or state, prove it safe with a negative test written from outside the module"
  done < <(awk '
    # state machine: track the open defcap (name/startln), whether it is @event,
    # and whether its body is bare `true`. Flag weak NON-@event caps.
    function flush() { if (inc && weak && !isevent) print startln"|"name }
    /\(defcap[[:space:]]/ {
      flush()
      inc=1; isevent=0; weak=0; startln=NR
      name=$0; sub(/.*\(defcap[[:space:]]+/,"",name); sub(/[[:space:](:].*/,"",name)
      if ($0 ~ /@event/) isevent=1
      if ($0 ~ /(^|[[:space:](])true\)*[[:space:]]*$/) weak=1
      next
    }
    inc==1 {
      # a new top-level def ends the current defcap
      if ($0 ~ /^[[:space:]]*\(def(un|cap|pact|schema|const|table)[[:space:]]/) { flush(); inc=0 }
      if ($0 ~ /@event/) isevent=1
      if ($0 ~ /(^|[[:space:](])true\)*[[:space:]]*$/) weak=1
    }
    END { flush() }
  ' "$f" 2>/dev/null | sort -u)

  scan_file "$f" 'create-pact-guard' \
    violation 'deprecated guard constructor — use keyset / capability / user guards'

  # create-module-guard is DEPRECATED (it will be removed) but is currently the
  # only primitive that makes a PERMISSIONLESS escrow account tamper-proof on this
  # engine line. Downgraded to WARN so a security-justified stopgap can pass the
  # gate rather than being silently dropped. Every use MUST carry an inline
  # justification and an ADR disposition, and MUST be revisited when the primitive
  # is removed. Rationale is recorded in the private engineering notes, not here:
  # this script is published, and a scrubber that explains what it is guarding
  # against tells a reader exactly what to go looking for.
  scan_file "$f" 'create-module-guard' \
    warn 'DEPRECATED create-module-guard — allowed ONLY as a security-justified escrow stopgap on this engine line; require an inline justification + ADR; revisit when the primitive is removed'

  scan_file "$f" '(\(!=[[:space:]]+""[[:space:]]+\(pact-id\)|\(enforce\b[^)]*\(pact-id\))' \
    violation 'pact-id used as an auth guard — gate access on a composed capability instead'

  scan_file "$f" '\b(enforce-guard|enforce-keyset)\b' \
    warn 'enforce-guard/enforce-keyset — confirm it sits inside a defcap (scoped signature), not a bare defun'

  scan_file "$f" '\b(mod|round|floor|ceiling|abs|exp|log|ln|sqrt)[[:space:]]*:=' \
    warn 'binds a native name (:=) — confirm with pact --check-shadowing (load-time error in 5.1+)'
  scan_file "$f" '\([[:space:]]*(mod|round|floor|ceiling|abs|exp|log|ln|sqrt)[[:space:]]*:' \
    warn 'native name used as a typed parameter — confirm with pact --check-shadowing'
done

printf -- '-- summary --\n'
printf 'VIOLATIONs: %d   WARNs: %d   files: %d\n' "$VIOLATIONS" "$WARNINGS" "${#FILES[@]}"

if [ "$VIOLATIONS" -gt 0 ]; then
  printf 'RESULT: FAIL (fix all VIOLATIONs before the edit/deploy is complete)\n'
  exit 1
fi
printf 'RESULT: PASS%s\n' "$( [ "$WARNINGS" -gt 0 ] && printf ' (with %d WARN — review)' "$WARNINGS" )"
exit 0
