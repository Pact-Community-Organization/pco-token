#!/usr/bin/env bash
# no-bare-expect-failure.sh — every negative test must name the error it expects.
#
# WHY. `(expect-failure "doc" <expr>)` passes on ANY error, including one that has
# nothing to do with the property being tested. A cold audit (2026-07-30) found 16
# of them here and proved two hollow by typo-ing a data key: the call then failed
# with `read-keyset failure` instead of the guard check it was meant to exercise,
# and the suite stayed green. A negative test that cannot tell WHY it failed is
# not evidence that the defence works — it is evidence that something went wrong.
#
# The three-argument form `(expect-failure "doc" "expected message" <expr>)` fixes
# it. To find the message, temporarily pass one that cannot match; the failure
# output reports what was actually raised.
#
# Exit 0 = clean. Exit 1 = at least one bare expectation.
set -euo pipefail
cd "$(dirname "$0")/../.."

python3 - <<'PY'
import re, sys, glob

bare = []
for path in sorted(glob.glob('tests/**/*.repl', recursive=True)) + sorted(glob.glob('tests/**/*.repl-must-fail', recursive=True)):
    src = open(path).read()
    # After the doc string, the next non-space character must open another string
    # literal (the expected message). Anything else means the form is bare.
    for m in re.finditer(r'\(expect-failure\s+"(?:[^"\\]|\\.)*"\s*(.)', src, re.S):
        if m.group(1) != '"':
            line = src[:m.start()].count('\n') + 1
            doc = re.match(r'\(expect-failure\s+"((?:[^"\\]|\\.)*)"', src[m.start():], re.S)
            bare.append((path, line, (doc.group(1) if doc else '')[:70]))

if bare:
    print(f"FAIL: {len(bare)} bare expect-failure(s) — each passes on ANY error:\n")
    for path, line, doc in bare:
        print(f"  {path}:{line}  {doc}")
    print("\nUse (expect-failure \"doc\" \"expected message\" <expr>).")
    sys.exit(1)

print("no bare expect-failure: every negative test names its expected error")
PY
