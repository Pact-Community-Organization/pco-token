// preupgrade-source.ts — the contracts as they are DEPLOYED, extracted from git.
//
// Both upgrade simulations need the PREVIOUS version of the contracts to deploy
// first, so they can then run the real upgrade over it. They originally read that
// version from a scratch directory a session happened to have created, with an
// absolute /tmp path baked into the committed source.
//
// That made them work exactly once. The path is session-scoped and /tmp is cleared
// on reboot, so the next run — the next morning — failed on a missing file. A
// rehearsal that only runs in the session that wrote it is not a rehearsal; it is
// a transcript.
//
// The previous version is already in git, so it is derived here instead: the merge
// base of this branch against `main` is the last commit before the upgrade work
// began, and `main` is what is deployed (verify-deployed byte-compares it against
// the chain). Extracted fresh into the OS temp directory on every run, so there is
// nothing to stale and nothing to clean up.
//
// Deliberately NOT written under ops/out/: that tree is scanned by the static
// checker, and two more generated pco near-copies inflate the pinned WARN baseline
// by 26 for artifacts nobody reads.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname;
const MODULES = ['pco.pact', 'pco-claim.pact', 'pco-gas-station.pact'] as const;

const git = (args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

/**
 * Extract the pre-upgrade contracts and return the directory holding them.
 *
 * `ref` defaults to the merge base with `main` — the last commit before this
 * branch started, i.e. what mainnet is running. Pass an explicit ref to rehearse
 * an upgrade from some other version.
 */
export function preupgradeSource(ref?: string): { dir: string; ref: string } {
  const base = ref ?? git(['merge-base', 'main', 'HEAD']);
  const dir = mkdtempSync(join(tmpdir(), 'pco-preupgrade-'));
  for (const m of MODULES) {
    const src = execFileSync('git', ['show', `${base}:contracts/${m}`], { cwd: REPO, encoding: 'utf8' });
    writeFileSync(join(dir, m), src);
  }
  // The point of using the PREVIOUS version is that it is genuinely different. If
  // the branch has been merged or rebased away, the merge base is HEAD and the
  // "upgrade" would be a no-op that silently proves nothing.
  const oldPco = execFileSync('git', ['show', `${base}:contracts/pco.pact`], { cwd: REPO, encoding: 'utf8' });
  if (!oldPco.includes('enforce-hub')) {
    throw new Error(
      `refusing to rehearse: the contracts at ${base.slice(0, 8)} do not contain enforce-hub, so they are not ` +
      `the pre-upgrade version. Pass an explicit ref if the branch has been merged.`,
    );
  }
  if (!MODULES.every((m) => existsSync(join(dir, m)))) throw new Error('extraction did not produce all three contracts');
  return { dir, ref: base };
}
