#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { main as boards } from '@meridian/ops/fixtures/boards';
import { main as coiBoard } from '@meridian/ops/fixtures/coi-board';
import { main as coiDocuments } from '@meridian/ops/fixtures/coi-documents';
import { main as coiEvalCases } from '@meridian/ops/fixtures/coi-eval-cases';
import { main as documents } from '@meridian/ops/fixtures/documents';
import { main as evalCases } from '@meridian/ops/fixtures/eval-cases';
import { main as specSnapshot } from '@meridian/ops/fixtures/spec-snapshot';

// Order matters: the boards feed the spec snapshot, and the documents feed the eval cases.
await boards();
await coiBoard();
await documents();
await evalCases();
await coiDocuments();
await coiEvalCases();
await specSnapshot();

/**
 * The generators write JSON with `JSON.stringify(..., 2)`, which is not always what Prettier would
 * write — long arrays it would keep on one line, mostly. Formatting here rather than expecting the
 * operator to notice: every regeneration used to leave `pnpm format:check` failing, and a gate that
 * routinely fails for a reason nobody cares about is a gate people learn to skip.
 */
execFileSync(
  'pnpm',
  ['exec', 'prettier', '--write', '--log-level', 'warn', 'examples', 'generated-agents'],
  { stdio: 'inherit' },
);
