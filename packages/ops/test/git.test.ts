import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { objectFormat, showFile, treePaths } from '../src/lib/git.js';
import { MERIDIAN_DIR, ensureStateDir } from '../src/lib/state.js';

/**
 * The object-database readers, exercised against a throwaway repository.
 *
 * A scratch repository is used rather than this one because the assertions are about *committed*
 * content, and a test that depends on what happens to be committed here would report a different
 * result on every branch. It is created with `--object-format=sha1` for the same reason production
 * is: `meridian.is_git_sha1` refuses the 64-hex ids a sha256 repository produces.
 */

let repo: string;
let sha: string;

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Meridian Test',
      GIT_AUTHOR_EMAIL: 'test@meridian.local',
      GIT_COMMITTER_NAME: 'Meridian Test',
      GIT_COMMITTER_EMAIL: 'test@meridian.local',
    },
  }).trim();
}

beforeAll(() => {
  // Scratch repositories live under `.meridian/`, which is git-ignored and inside the workspace.
  // The system temp directory is not writable in every environment this suite runs in.
  ensureStateDir();
  repo = mkdtempSync(join(MERIDIAN_DIR, 'git-fixture-'));
  git(['init', '--object-format=sha1', '--initial-branch=main']);
  mkdirSync(join(repo, 'generated-agents/demo/v001'), { recursive: true });
  writeFileSync(join(repo, 'generated-agents/demo/v001/agent.ts'), 'export const agent = 1;\n');
  writeFileSync(join(repo, 'generated-agents/demo/v001/manifest.json'), '{"manifestVersion":1}\n');
  git(['add', '--', 'generated-agents']);
  git(['commit', '-m', 'add demo agent']);
  sha = git(['rev-parse', 'HEAD']);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('git object-database readers', () => {
  it('reports a sha1 object format and a 40-hex commit id', () => {
    expect(objectFormat(repo)).toBe('sha1');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('lists the committed tree, not the working tree', () => {
    writeFileSync(join(repo, 'generated-agents/demo/v001/uncommitted.ts'), 'export const x = 1;\n');
    const paths = treePaths(sha, repo);
    expect(paths).toContain('generated-agents/demo/v001/agent.ts');
    // The uncommitted file is on disk right now and must not appear. This is the whole reason
    // verification reads the object database.
    expect(paths).not.toContain('generated-agents/demo/v001/uncommitted.ts');
  });

  it('reads committed bytes even after the working copy is edited', () => {
    const path = 'generated-agents/demo/v001/agent.ts';
    writeFileSync(join(repo, path), 'export const agent = 999; // tampered\n');
    expect(showFile(sha, path, repo)).toBe('export const agent = 1;\n');
  });

  it('fails loudly for a path that is not in the commit', () => {
    expect(() => showFile(sha, 'generated-agents/demo/v001/absent.ts', repo)).toThrow(/failed/);
  });
});
