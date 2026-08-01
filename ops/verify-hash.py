#!/usr/bin/env python3
"""Independent ceremony hash verifier — Python standard library ONLY.

Recomputes the Kadena transaction hash (= the request key = the base64url
string a Ledger displays in hash-signing mode) from the raw `cmd` bytes of an
unsigned transaction file written by ops/src/build-tx.ts, and — for deploy
transactions ONLY — byte-compares the embedded Pact code against the audited
contract source in this same (paper-SHA-pinned) clone.

WHAT THIS TOOL DOES AND DOES NOT COMPARE (read this before trusting it):
- DEPLOY transactions (the code contains a `(module ...)` form): the embedded
  code IS byte-compared against ../contracts/<name>.pact. A clean result is
  machine evidence.
- EVERY OTHER STEP (mint, keyset, namespace, fund-station, reserve-seed,
  open-claims, create-round, grant, grant-batch, sweep, rotate, withdraw):
  there is NOTHING to compare against, so NO machine comparison happens. For
  those the tool prints the code IN FULL and you must read it yourself. It will
  say so loudly. The Ledger shows only a hash, so this printout is the ONLY
  place a human can see what is about to be signed — and `init-mint` is
  irreversible and distributes 100% of supply.

Why this file is the way it is (do not "improve" it):
- Stdlib only, single file: reviewable line-by-line at ceremony time; runs on
  any machine with Python 3.6+ (a SEPARATE machine is required, not optional).
- Shares NOTHING with the builder (different language, different BLAKE2b
  implementation): agreement between the two is evidence, not circularity.
- The file's own `hash` field is cross-checked but NEVER trusted: the value
  to compare against the device screen is recomputed from `cmd` here.

Usage (run from ops/):
    python3 verify-hash.py out/mainnet/<NN-name-chain>.json             # hash + auto code-diff
    python3 verify-hash.py out/mainnet/<NN-name-chain>.json --show-cmd  # + review small fields

Exit codes:
    0  OK — recomputed hash printed; any embedded-code diff clean.
    1  INCONSISTENT — do NOT sign (embedded hash field disagrees, OR the
       embedded deploy code does not match the audited contract source, OR
       the cmd JSON contains duplicate keys).
    2  usage / read error / malformed file (no hash printed).
"""
import base64
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACTS = os.path.normpath(os.path.join(HERE, "..", "contracts"))


def kadena_hash(cmd_utf8: bytes) -> str:
    digest = hashlib.blake2b(cmd_utf8, digest_size=32).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _reject_dupe_keys(pairs):
    seen = {}
    for k, v in pairs:
        if k in seen:
            raise ValueError(f"duplicate JSON key {k!r} — file is malformed/tampered")
        seen[k] = v
    return seen


def code_matches_contract(code: str):
    """If `code` is a whole-module deploy, byte-compare it against the audited
    source in ../contracts. Returns (module_name, ok) or None if not a deploy."""
    m = re.search(r"\(\s*module\s+(?:[\w-]+\.)?([\w-]+)\b", code)
    if not m:
        return None
    name = m.group(1)
    path = os.path.join(CONTRACTS, f"{name}.pact")
    if not os.path.exists(path):
        return (name, None)  # named a module we can't find — surface it
    with open(path, "r", encoding="utf-8") as f:
        audited = f.read()
    # build-tx.ts embeds the file's bytes verbatim; compare on exact bytes.
    return (name, code == audited)


def main() -> int:
    show_cmd = "--show-cmd" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--show-cmd"]
    if len(args) != 1:
        print(__doc__)
        return 2
    try:
        with open(args[0], "rb") as f:
            tx = json.loads(f.read().decode("utf-8"), object_pairs_hook=_reject_dupe_keys)
        cmd = tx["cmd"]
        if not isinstance(cmd, str):
            raise ValueError("`cmd` is not a string")
    except (OSError, ValueError, KeyError) as e:
        print(f"cannot read a valid `cmd` field from {args[0]}: {e}")
        return 2

    try:
        cmd_bytes = cmd.encode("utf-8")
    except UnicodeEncodeError as e:
        print(f"`cmd` is not valid UTF-8 (lone surrogate?) — malformed/tampered file: {e}")
        return 2

    inconsistent = False
    h = kadena_hash(cmd_bytes)
    print(f"file    : {args[0]}")
    print(f"cmd     : {len(cmd_bytes)} bytes (utf-8)")
    print("\nCOMPARE ON THE DEVICE SCREEN — the Ledger shows a trailing '=' padding:\n")
    print(f"    {h}=\n")
    print(f"request key (unpadded, what the chain shows after submit):\n\n    {h}\n")
    print(f"hex     : {hashlib.blake2b(cmd_bytes, digest_size=32).hexdigest()}")

    # Cross-check the file's own hash field (informational — never trusted).
    claimed = tx.get("hash")
    if claimed is None:
        print("note: file has no `hash` field to cross-check (the device compare is the gate).")
    elif claimed == h:
        print(f"embedded hash field agrees: {claimed}")
    else:
        inconsistent = True
        print(f"embedded hash field: {claimed}")
        print("*** MISMATCH: recomputed hash != the file's own hash field — DO NOT SIGN. ***")

    # Deploy txs: machine-compare the embedded module code vs the audited source.
    try:
        payload = json.loads(cmd, object_pairs_hook=_reject_dupe_keys)
        code = payload.get("payload", {}).get("exec", {}).get("code", "")
    except ValueError as e:
        print(f"*** cmd is not parseable JSON ({e}) — DO NOT SIGN. ***")
        return 1
    res = code_matches_contract(code) if isinstance(code, str) else None
    # code_was_machine_compared is the ONLY thing that may license eliding the
    # code from the human-review printout below. It is true ONLY for a deploy
    # whose bytes matched the audited source.
    code_was_machine_compared = False
    if res is None:
        print(
            "\n*** THIS IS NOT A DEPLOY TRANSACTION — ITS CODE WAS **NOT** MACHINE-COMPARED. ***\n"
            "*** Nothing here verifies it. The device will show only a hash. READ THE CODE   ***\n"
            "*** BELOW IN FULL, line by line, against the runbook step you intend to sign.   ***"
        )
    else:
        name, ok = res
        if ok is True:
            code_was_machine_compared = True
            print(f"deploy code: MATCHES audited contracts/{name}.pact (byte-identical).")
        elif ok is None:
            inconsistent = True
            print(f"*** deploy names module '{name}' but contracts/{name}.pact not found — DO NOT SIGN. ***")
        else:
            inconsistent = True
            print(f"*** deploy code DIFFERS from audited contracts/{name}.pact — DO NOT SIGN. ***")

    # The code of a NON-deploy step is the only human-reviewable artifact in the
    # whole ceremony (the device shows a hash), so it is printed ALWAYS and IN
    # FULL — not gated behind --show-cmd and never truncated.
    if not code_was_machine_compared and isinstance(code, str):
        print("\n--- EXECUTED CODE, IN FULL (not machine-compared — this is yours to check) ---")
        print(code)
        print("--- end of executed code ---")

    if show_cmd:
        view = dict(payload)
        exec_ = dict(view.get("payload", {}).get("exec", {}))
        if code_was_machine_compared and isinstance(exec_.get("code"), str):
            # Safe to elide: these exact bytes were just byte-compared above.
            exec_["code"] = (
                f"<{len(exec_['code'])} bytes — byte-compared against the audited "
                f"contract source above, not repeated here>"
            )
            view["payload"] = {**view["payload"], "exec": exec_}
        print("\n--- cmd fields for review (env-data / keyset / chain / signers / networkId) ---")
        print(json.dumps(view, indent=2))

    return 1 if inconsistent else 0


if __name__ == "__main__":
    sys.exit(main())
