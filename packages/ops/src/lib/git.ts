import { output, run } from './proc.js';
import { REPO_ROOT } from './state.js';

/**
 * Git access for the finalize path.
 *
 * Every content assertion here reads the **object database** — `git ls-tree`, `git show` — rather
 * than the working tree. The point of recording a commit SHA against an agent version is that the
 * SHA is evidence, and evidence you verify by looking at the worktree is evidence about the
 * worktree, which is exactly the thing that can drift.
 *
 * Nothing in this module rewrites history and nothing pushes. The allowed verbs are the ones
 * listed in `docs/DECISIONS.md`.
 */

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Every reader takes the repository root it should read, defaulting to this one.
 *
 * The default is what production uses and is never passed explicitly. The parameter exists so the
 * readers can be pointed at a scratch repository under test: verifying committed content is the
 * one thing that cannot be asserted against the repository the test itself lives in, because the
 * answer would change with the branch.
 */
function git(args: readonly string[], cwd: string = REPO_ROOT): string {
  const result = run('git', args, { cwd });
  if (result.unavailable) throw new GitError('git is not installed or not on PATH');
  if (result.code !== 0) {
    throw new GitError(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * The repository's object format.
 *
 * A sha256 repository produces 64-hex commit IDs, which `meridian.is_git_sha1` refuses. Detecting
 * that here turns a confusing database constraint violation into a sentence that says what is
 * actually wrong.
 */
export function objectFormat(cwd?: string): string {
  try {
    return git(['rev-parse', '--show-object-format'], cwd).trim();
  } catch {
    return 'unknown';
  }
}

export function assertSha1Repository(cwd?: string): void {
  const format = objectFormat(cwd);
  if (format !== 'sha1') {
    throw new GitError(
      `repository object format is "${format}"; agent_versions.git_commit_sha requires 40-hex sha1 ids`,
    );
  }
}

export interface StatusEntry {
  status: string;
  path: string;
}

export function status(): StatusEntry[] {
  return git(['status', '--porcelain'])
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
}

/** Paths that are dirty and are *not* in the allow-list, i.e. the ones that must block a commit. */
export function unrelatedDirtyPaths(allowed: readonly string[]): string[] {
  const allowSet = new Set(allowed);
  return status()
    .map((entry) => entry.path)
    .filter((path) => !allowSet.has(path));
}

export function add(paths: readonly string[]): void {
  if (paths.length === 0) throw new GitError('refusing to stage an empty path list');
  git(['add', '--', ...paths]);
}

export function stagedPaths(): string[] {
  return git(['diff', '--cached', '--name-only'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function commit(message: string): string {
  git(['commit', '-m', message]);
  return headSha();
}

export function headSha(): string {
  const sha = output('git', ['rev-parse', 'HEAD']);
  if (sha === null) throw new GitError('HEAD does not resolve to a commit');
  return sha;
}

/** Every path in the tree of `sha`. */
export function treePaths(sha: string, cwd?: string): string[] {
  return git(['ls-tree', '-r', '--name-only', sha], cwd)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The committed content of a path, read out of the object database. */
export function showFile(sha: string, path: string, cwd?: string): string {
  return git(['show', `${sha}:${path}`], cwd);
}

export function hasCommits(): boolean {
  return output('git', ['rev-parse', '--verify', 'HEAD']) !== null;
}
