import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileSpec, type CompileSpecInput } from '../src/compiler.js';
import { sha256Hex } from '../src/hashing.js';
import { CommentMetadataSchema } from '../src/schemas/comment-metadata.js';
import { uuid, validGraph } from './helpers/factories.js';

const ROOT_A = uuid(300);
const ROOT_B = uuid(301);
const ASSUMPTION_V1 = uuid(310);
const ASSUMPTION_V2 = uuid(311);

function baseInput(overrides: Partial<CompileSpecInput> = {}): CompileSpecInput {
  const graph = validGraph();
  return {
    graph,
    specId: uuid(200),
    specVersion: 1,
    name: 'Inbound Import Receiving',
    canvasHash: sha256Hex(graph),
    reviewSessionIds: [],
    frozenAt: '2026-08-02T00:00:00.000Z',
    acknowledgedUnresolvedBlockers: false,
    acknowledgedStaleReview: false,
    assumptions: [],
    knownGaps: [],
    ...overrides,
  };
}

/**
 * The live-assumption query excludes any assumption that a later one supersedes. The compiler
 * receives that already-filtered list, which is why the exclusion is modelled here as the input
 * the repository would have produced.
 */
function liveAssumptions(
  rows: ReadonlyArray<{
    commentId: string;
    assumptionText: string;
    sourceRootCommentId: string;
    supersedesCommentId: string | null;
  }>,
) {
  const superseded = new Set(
    rows.map((r) => r.supersedesCommentId).filter((id): id is string => id !== null),
  );
  return rows
    .filter((r) => !superseded.has(r.commentId))
    .map((r) => ({ assumptionText: r.assumptionText, sourceRootCommentId: r.sourceRootCommentId }));
}

describe('assumptions in the compiled spec', () => {
  it('uses the root issue id as sourceCommentId, not the assumption reply id', () => {
    const result = compileSpec(
      baseInput({
        assumptions: [
          { assumptionText: 'Partial shipments are accepted.', sourceRootCommentId: ROOT_A },
        ],
      }),
    );
    if (!('specJson' in result)) throw new Error('expected a compiled spec');
    expect(result.specJson.assumptions).toEqual([
      { text: 'Partial shipments are accepted.', sourceCommentId: ROOT_A },
    ]);
  });

  it('excludes a superseded assumption and keeps the replacement', () => {
    const rows = [
      {
        commentId: ASSUMPTION_V1,
        assumptionText: 'Missing CoA blocks entry.',
        sourceRootCommentId: ROOT_A,
        supersedesCommentId: null,
      },
      {
        commentId: ASSUMPTION_V2,
        assumptionText: 'Missing CoA triggers a follow-up email instead.',
        sourceRootCommentId: ROOT_A,
        supersedesCommentId: ASSUMPTION_V1,
      },
    ];
    const result = compileSpec(baseInput({ assumptions: liveAssumptions(rows) }));
    if (!('specJson' in result)) throw new Error('expected a compiled spec');
    expect(result.specJson.assumptions).toEqual([
      { text: 'Missing CoA triggers a follow-up email instead.', sourceCommentId: ROOT_A },
    ]);
  });

  it('sorts assumptions by sourceCommentId so the hash is stable', () => {
    const forward = compileSpec(
      baseInput({
        assumptions: [
          { assumptionText: 'B', sourceRootCommentId: ROOT_B },
          { assumptionText: 'A', sourceRootCommentId: ROOT_A },
        ],
      }),
    );
    const reversed = compileSpec(
      baseInput({
        assumptions: [
          { assumptionText: 'A', sourceRootCommentId: ROOT_A },
          { assumptionText: 'B', sourceRootCommentId: ROOT_B },
        ],
      }),
    );
    if (!('specJson' in forward) || !('specJson' in reversed)) {
      throw new Error('expected compiled specs');
    }
    expect(sha256Hex(forward.specJson)).toBe(sha256Hex(reversed.specJson));
    expect(forward.specJson.assumptions.map((a) => a.sourceCommentId)).toEqual([ROOT_A, ROOT_B]);
  });
});

describe('known gaps in the compiled spec', () => {
  it('includes a policy gap alongside unresolved review issues, sorted by source id', () => {
    const result = compileSpec(
      baseInput({
        knownGaps: [
          {
            text: 'Tariff classification for kits is undecided.',
            severity: 'blocking',
            sourceCommentId: ROOT_B,
          },
          {
            text: 'Eval case-06 has no stated policy.',
            severity: 'non_blocking',
            sourceCommentId: ROOT_A,
          },
        ],
      }),
    );
    if (!('specJson' in result)) throw new Error('expected a compiled spec');
    expect(result.specJson.knownGaps.map((g) => g.sourceCommentId)).toEqual([ROOT_A, ROOT_B]);
    expect(result.specJson.knownGaps[0]?.severity).toBe('non_blocking');
  });
});

describe('classification never reads comment body text', () => {
  it('classifies purely from metadata_json.kind', () => {
    const assumption = CommentMetadataSchema.parse({
      kind: 'assumption',
      assumptionText: 'No prefix convention needed.',
      sourceRootCommentId: ROOT_A,
      supersedesCommentId: null,
    });
    expect(assumption.kind).toBe('assumption');
  });

  it('has no body-prefix parsing in the compiler source', () => {
    const source = readFileSync(new URL('../src/compiler.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/body\s*\.\s*startsWith/);
    expect(source).not.toMatch(/ASSUMPTION:/);
  });
});
