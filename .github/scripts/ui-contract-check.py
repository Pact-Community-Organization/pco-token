#!/usr/bin/env python3
"""Cross-artifact gate: every contract call a UI makes must resolve to real code.

Every other gate in this repo compares one artifact with itself. static-check
reads .pact; run.sh loads .repl; verify-hash byte-compares the deploy against
the same clone; submit recomputes the hash from the cmd build-tx just wrote.
All of them return green without ever asking whether the UI and the contracts
still agree — which is how a claim app shipped with a governance surface
targeting an API that had been replaced: a `cast-vote` taking a choice string
after the contract moved to ranked ballots, a `create-proposal` under a
capability that no longer existed, and a `get-vote` that was never a function.

Three rules, because name resolution alone is not enough. Two of those defects
had the RIGHT ARITY and still could not type-check:

  1. resolution  - the function/capability must exist in contracts/
  2. arity       - the call must pass as many arguments as the defun declares
  3. literal type - a "string literal" argument must land on a string parameter.
                    This is what catches `cast-vote pid acct "yes"` against
                    `ranking:[integer]`, and `create-proposal acct title body
                    hours` against `(title body options:[string] hours)`.

Deliberate limit, stated so nobody reads more into a green run: this checks
CALLS, not RESULT SHAPES. A UI reading `r.yes` off a function that returns
Borda scores is not caught here. Arguments that are template substitutions
(`${x}`) are unknown at scan time and are checked for count only.

Usage: ui-contract-check.py [--contracts DIR] [PATH ...]
Exit 0 = every call resolves. Exit 1 = at least one mismatch.
"""

import re
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# Pact side: what actually exists
# --------------------------------------------------------------------------

DEF_RE = re.compile(r'\((defun|defcap|defpact)\s+([A-Za-z0-9_:!?<>=+*/-]+)')


def split_group(src: str, start: int) -> tuple[str, int]:
    """Return (inner text, index after close) for the group opening at `start`."""
    pairs = {'(': ')', '[': ']', '{': '}'}
    close = pairs[src[start]]
    depth = 0
    i = start
    while i < len(src):
        c = src[i]
        if c == '"':
            i += 1
            while i < len(src) and src[i] != '"':
                i += 2 if src[i] == '\\' else 1
        elif c in pairs:
            depth += 1
        elif c in ')]}':
            depth -= 1
            if depth == 0:
                return src[start + 1:i], i + 1
        i += 1
    raise ValueError(f'unterminated group at {start}')


def split_args(inner: str) -> list[str]:
    """Split a Pact arg list on top-level whitespace."""
    args, buf, depth = [], '', 0
    i = 0
    while i < len(inner):
        c = inner[i]
        if c == '"':
            buf += c
            i += 1
            while i < len(inner) and inner[i] != '"':
                buf += inner[i]
                i += 1
            buf += '"'
        elif c in '([{':
            depth += 1
            buf += c
        elif c in ')]}':
            depth -= 1
            buf += c
        elif c.isspace() and depth == 0:
            if buf:
                args.append(buf)
                buf = ''
        else:
            buf += c
        i += 1
    if buf:
        args.append(buf)
    return args


def strip_comments(src: str) -> str:
    """Drop ;; comments without disturbing string literals."""
    out, i = [], 0
    while i < len(src):
        c = src[i]
        if c == '"':
            out.append(c)
            i += 1
            while i < len(src) and src[i] != '"':
                if src[i] == '\\':
                    out.append(src[i])
                    i += 1
                if i < len(src):
                    out.append(src[i])
                    i += 1
            if i < len(src):
                out.append('"')
                i += 1
        elif c == ';':
            while i < len(src) and src[i] != '\n':
                i += 1
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def arg_type(arg: str) -> str | None:
    """Declared type of a Pact parameter, or None when untyped."""
    if ':' not in arg:
        return None
    t = arg.split(':', 1)[1]
    return re.sub(r'\{.*\}', '', t) or None


def parse_contracts(cdir: Path) -> dict[str, dict]:
    """{module: {'defuns': {name: [types]}, 'defcaps': {NAME: [types]}}}"""
    modules: dict[str, dict] = {}
    for path in sorted(cdir.glob('*.pact')):
        src = strip_comments(path.read_text())
        m = re.search(r'\(module\s+([A-Za-z0-9_-]+)', src)
        if not m:
            continue
        mod = modules.setdefault(
            m.group(1), {'defuns': {}, 'defcaps': {}, 'file': path.name})
        for d in DEF_RE.finditer(src):
            kind, raw = d.group(1), d.group(2)
            name = raw.split(':')[0]
            j = src.find('(', d.end())
            if j == -1:
                continue
            # the arg list is the next group; a @doc/@model never precedes it
            inner, _ = split_group(src, j)
            types = [arg_type(a) for a in split_args(inner)]
            bucket = 'defcaps' if kind == 'defcap' else 'defuns'
            mod[bucket][name] = types
    return modules


# --------------------------------------------------------------------------
# UI side: what the page claims exists
# --------------------------------------------------------------------------

# const T = `${CFG.ns}.pco`;  /  const C = `${NS}.pco-claim`;
PREFIX_RE = re.compile(
    r'(?:const|let|var)\s+(\w+)\s*=\s*`\$\{[^}]*\}\.([a-z][a-z0-9-]*)`')


def js_tokens(src: str, start: int) -> tuple[list[str], int]:
    """Tokenize a call's arguments inside a JS template literal."""
    toks, buf, depth = [], '', 0
    i = start
    while i < len(src):
        c = src[i]
        if c == '$' and src[i:i + 2] == '${':
            _, nxt = split_group(src, i + 1)
            buf += src[i:nxt]
            i = nxt
            continue
        if c == '"':
            buf += c
            i += 1
            while i < len(src) and src[i] != '"':
                if src[i] == '$' and src[i:i + 2] == '${':
                    _, nxt = split_group(src, i + 1)
                    buf += src[i:nxt]
                    i = nxt
                    continue
                buf += src[i]
                i += 1
            buf += '"'
            i += 1
            continue
        if c in '([{':
            depth += 1
            buf += c
        elif c in ')]}':
            if depth == 0:          # closes the call itself
                if buf.strip():
                    toks.append(buf.strip())
                return toks, i + 1
            depth -= 1
            buf += c
        elif c.isspace() and depth == 0:
            if buf.strip():
                toks.append(buf.strip())
            buf = ''
        else:
            buf += c
        i += 1
    raise ValueError('unterminated call')


def literal_kind(tok: str) -> str | None:
    """Pact type of a literal argument, or None when it cannot be known."""
    if tok.startswith('"') and tok.endswith('"'):
        return 'string'
    if tok.startswith('['):
        return 'list'
    if re.fullmatch(r'-?\d+', tok):
        return 'integer'
    if re.fullmatch(r'-?\d+\.\d+', tok):
        return 'decimal'
    if tok.startswith('(read-keyset') or tok.startswith('(read-msg'):
        return 'guard'
    return None


COMPATIBLE = {
    'string': {'string'},
    'integer': {'integer', 'decimal'},
    'decimal': {'decimal', 'integer'},
    'guard': {'guard'},
    'list': {'list'},
}


def type_ok(declared: str | None, actual: str | None) -> bool:
    if declared is None or actual is None:
        return True
    if declared.startswith('['):
        return actual == 'list'
    if declared in ('guard', 'keyset'):
        return actual == 'guard'
    if declared == 'time':
        return actual == 'string'      # times cross the wire as strings
    if declared in ('bool', 'object', 'module'):
        return True                    # not decidable from a literal
    return actual in COMPATIBLE.get(declared, {actual})


def line_of(src: str, idx: int) -> int:
    return src.count('\n', 0, idx) + 1


def check_file(path: Path, modules: dict) -> list[str]:
    src = path.read_text()
    prefixes = {m.group(1): m.group(2) for m in PREFIX_RE.finditer(src)}
    if not prefixes:
        return []
    bad: list[str] = []

    for var, mod in prefixes.items():
        api = modules.get(mod)
        # --- function calls: (${T}.fn a b c) ---
        needle = '(${' + var + '}.'
        for m in re.finditer(re.escape(needle), src):
            at = m.end()
            fm = re.match(r'[A-Za-z0-9_-]+', src[at:])
            if not fm:
                continue
            fn = fm.group(0)
            here = f'{path}:{line_of(src, m.start())}'
            if api is None:
                bad.append(f'{here}: no contract for module `{mod}`')
                continue
            if fn not in api['defuns']:
                near = ', '.join(
                    n for n in api['defuns'] if n.startswith(fn[:4])) or 'none'
                bad.append(
                    f'{here}: `{mod}.{fn}` is not a defun in {api["file"]} '
                    f'(closest: {near})')
                continue
            declared = api['defuns'][fn]
            try:
                toks, _ = js_tokens(src, at + len(fn))
            except ValueError as e:
                bad.append(f'{here}: cannot parse the call to `{fn}`: {e}')
                continue
            if len(toks) != len(declared):
                bad.append(
                    f'{here}: `{mod}.{fn}` takes {len(declared)} argument(s) '
                    f'({" ".join(d or "?" for d in declared)}), called with '
                    f'{len(toks)}')
                continue
            for n, (d, tok) in enumerate(zip(declared, toks), 1):
                a = literal_kind(tok)
                if not type_ok(d, a):
                    bad.append(
                        f'{here}: `{mod}.{fn}` argument {n} is declared '
                        f'`{d}` but the call passes a {a} ({tok[:40]})')

        # --- capabilities: `${T}.CAP` with an adjacent args: [...] ---
        cneedle = '${' + var + '}.'
        for m in re.finditer(re.escape(cneedle), src):
            cm = re.match(r'[A-Z][A-Za-z0-9_-]*', src[m.end():])
            if not cm:
                continue
            cap = cm.group(0)
            here = f'{path}:{line_of(src, m.start())}'
            if api is None:
                bad.append(f'{here}: no contract for module `{mod}`')
                continue
            if cap not in api['defcaps']:
                bad.append(
                    f'{here}: `{mod}.{cap}` is not a defcap in {api["file"]}')
                continue
            window = src[m.end():m.end() + 400]
            am = re.search(r'args\s*:\s*\[', window)
            if not am:
                continue
            inner, _ = split_group(window, am.end() - 1)
            n = len(split_js_list(inner))
            if n != len(api['defcaps'][cap]):
                bad.append(
                    f'{here}: `{mod}.{cap}` takes '
                    f'{len(api["defcaps"][cap])} argument(s), '
                    f'the signed cap lists {n}')
    return bad


def split_js_list(inner: str) -> list[str]:
    """Split a JS array literal on top-level commas."""
    out, buf, depth = [], '', 0
    i = 0
    while i < len(inner):
        c = inner[i]
        if c in '\'"`':
            q = c
            buf += c
            i += 1
            while i < len(inner) and inner[i] != q:
                buf += inner[i]
                i += 1
            buf += q
        elif c in '([{':
            depth += 1
            buf += c
        elif c in ')]}':
            depth -= 1
            buf += c
        elif c == ',' and depth == 0:
            out.append(buf.strip())
            buf = ''
        else:
            buf += c
        i += 1
    if buf.strip():
        out.append(buf.strip())
    return out


def main() -> int:
    args = sys.argv[1:]
    cdir = Path('contracts')
    if '--contracts' in args:
        k = args.index('--contracts')
        cdir = Path(args[k + 1])
        del args[k:k + 2]
    roots = [Path(a) for a in args] or [Path('web')]

    modules = parse_contracts(cdir)
    if not modules:
        print(f'ui-contract-check: no modules found in {cdir}/', file=sys.stderr)
        return 1

    files: list[Path] = []
    for r in roots:
        if r.is_file():
            files.append(r)
        elif r.is_dir():
            # .tsx/.jsx matter: the CANONICAL PCO UI is a Next.js app whose
            # components are .tsx, and this scanner was written against the
            # repo-local .js claim page, so a run over that tree reported PASS
            # having scanned one file. A gate with silent blind spots is worse
            # than no gate, because the green is believed.
            for ext in ('*.js', '*.jsx', '*.ts', '*.tsx'):
                files += [p for p in sorted(r.rglob(ext))
                          if 'node_modules' not in p.parts]

    problems, scanned = [], 0
    for f in files:
        found = check_file(f, modules)
        if found or PREFIX_RE.search(f.read_text()):
            scanned += 1
        problems += found

    print(f'-- ui-contract-check: {len(modules)} module(s) '
          f'({", ".join(sorted(modules))}), {scanned} UI file(s) with '
          f'contract calls --')
    for p in problems:
        print(f'MISMATCH: {p}')
    if problems:
        print(f'\nRESULT: FAIL ({len(problems)} mismatch(es))')
        return 1
    print('RESULT: PASS (every call resolves to a real defun/defcap)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
