import { describe, expect, it } from 'vitest';
import { BuildManifestSchema } from '../src/schemas/build-manifest.js';
import { CanonicalGraphSchema, RenameBoardRequestSchema } from '../src/schemas/board.js';
import { CommentMetadataSchema } from '../src/schemas/comment-metadata.js';
import { WhiteboardDeltaRequestSchema } from '../src/schemas/delta.js';
import { EvalCaseSchema } from '../src/schemas/eval-case.js';
import { FreezeRequestSchema } from '../src/schemas/spec.js';
import { StartReviewRequestSchema } from '../src/schemas/review.js';
import { isTerminalActionStatus } from '../src/schemas/action.js';
import { uuid, validGraph } from './helpers/factories.js';

const NODE_A = uuid(400);
const NODE_B = uuid(401);
const EDGE_A = uuid(410);

function nodeUpsert(nodeId: string) {
  return {
    nodeId,
    primitiveType: 'action' as const,
    title: 'Do the thing',
    data: {},
    position: { x: 0, y: 0 },
  };
}

describe('delta validation', () => {
  it('accepts a well-formed delta and defaults the empty arrays', () => {
    const parsed = WhiteboardDeltaRequestSchema.parse({ expectedRevisionNo: 3 });
    expect(parsed).toEqual({
      expectedRevisionNo: 3,
      nodeUpserts: [],
      nodeDeletes: [],
      edgeUpserts: [],
      edgeDeletes: [],
    });
  });

  it('rejects duplicate ids inside one collection', () => {
    const result = WhiteboardDeltaRequestSchema.safeParse({
      expectedRevisionNo: 1,
      nodeUpserts: [nodeUpsert(NODE_A), nodeUpsert(NODE_A)],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('DUPLICATE_ID_IN_DELTA');
  });

  it('rejects an id that is both upserted and deleted', () => {
    const result = WhiteboardDeltaRequestSchema.safeParse({
      expectedRevisionNo: 1,
      nodeUpserts: [nodeUpsert(NODE_A)],
      nodeDeletes: [NODE_A],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('ID_IN_UPSERT_AND_DELETE');
  });

  it('applies the same rules to edges', () => {
    const upsert = { edgeId: EDGE_A, sourceNodeId: NODE_A, targetNodeId: NODE_B };
    expect(
      WhiteboardDeltaRequestSchema.safeParse({
        expectedRevisionNo: 1,
        edgeUpserts: [upsert],
        edgeDeletes: [EDGE_A],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(
      WhiteboardDeltaRequestSchema.safeParse({ expectedRevisionNo: 1, sourceCanvasHash: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('requests carry no authoritative artifacts (A21)', () => {
  it('rejects a forged canvas hash on a review request', () => {
    expect(
      StartReviewRequestSchema.safeParse({
        expectedRevisionNo: 1,
        sourceCanvasHash: 'f'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('rejects a forged spec on a freeze request', () => {
    expect(
      FreezeRequestSchema.safeParse({
        expectedRevisionNo: 1,
        acknowledgeUnresolvedBlockers: false,
        acknowledgeStaleReview: false,
        specJson: {},
      }).success,
    ).toBe(false);
  });

  it('accepts the honest freeze request', () => {
    expect(
      FreezeRequestSchema.safeParse({
        expectedRevisionNo: 1,
        acknowledgeUnresolvedBlockers: true,
        acknowledgeStaleReview: true,
      }).success,
    ).toBe(true);
  });
});

describe('canonical snapshot shape', () => {
  it('validates an assembled graph', () => {
    expect(CanonicalGraphSchema.safeParse(validGraph()).success).toBe(true);
  });

  it('refuses a snapshot that smuggles in a viewport', () => {
    const graph = validGraph() as unknown as Record<string, unknown>;
    expect(
      CanonicalGraphSchema.safeParse({ ...graph, viewport: { x: 0, y: 0, zoom: 1 } }).success,
    ).toBe(false);
  });
});

describe('rename request', () => {
  it('requires the revision the client believes it holds', () => {
    expect(RenameBoardRequestSchema.safeParse({ title: 'New' }).success).toBe(false);
    expect(
      RenameBoardRequestSchema.safeParse({ expectedRevisionNo: 2, title: 'New' }).success,
    ).toBe(true);
  });
});

describe('comment metadata union', () => {
  it('accepts each of the seven kinds', () => {
    const samples: unknown[] = [
      {
        kind: 'review_issue',
        issueKey: 'det:X:canvas:canvas:-',
        checkCode: 'X',
        origin: 'deterministic',
      },
      { kind: 'reply' },
      { kind: 'rejection', reason: 'Not applicable to air freight.' },
      { kind: 'graph_patch', patchVersion: 1, appliedRevisionNo: 4 },
      {
        kind: 'assumption',
        assumptionText: 'A',
        sourceRootCommentId: uuid(1),
        supersedesCommentId: null,
      },
      { kind: 'policy_gap', evalRunId: 'run-1', failureKey: 'case-06', agentVersionId: uuid(2) },
      { kind: 'recurrence', issueKey: 'det:X:canvas:canvas:-', reviewSessionId: uuid(3) },
    ];
    for (const sample of samples) {
      expect(CommentMetadataSchema.safeParse(sample).success).toBe(true);
    }
  });

  it('rejects an unknown kind', () => {
    expect(CommentMetadataSchema.safeParse({ kind: 'freeform' }).success).toBe(false);
  });
});

describe('external action status', () => {
  it('treats exactly succeeded, failed, and abandoned as terminal', () => {
    expect(isTerminalActionStatus('succeeded')).toBe(true);
    expect(isTerminalActionStatus('failed')).toBe(true);
    expect(isTerminalActionStatus('abandoned')).toBe(true);
    expect(isTerminalActionStatus('needs_reconciliation')).toBe(false);
    expect(isTerminalActionStatus('dispatched')).toBe(false);
    expect(isTerminalActionStatus('reserved')).toBe(false);
  });
});

describe('build manifest', () => {
  const valid = {
    manifestVersion: 1,
    deploymentKey: 'inbound-import-receiving',
    versionNo: 1,
    codePath: 'generated-agents/inbound-import-receiving/v001',
    specId: uuid(500),
    specHash: 'a'.repeat(64),
    specVersion: 1,
    generatedFiles: ['agent.ts'],
    capabilities: ['mail.read'],
    generatedAt: '2026-08-02T00:00:00.000Z',
    generator: { skill: 'spec-to-agent', model: 'gpt-5.5' },
    toolkitVersions: { composioGmailToolkit: '20250114_00' },
    validation: { commands: ['pnpm lint'], evalCaseKeys: ['case-01'] },
  };

  it('accepts a manifest with concrete toolkit versions', () => {
    expect(BuildManifestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects the literal string latest, because it is not a reproducible record (A29)', () => {
    const result = BuildManifestSchema.safeParse({
      ...valid,
      toolkitVersions: { composioGmailToolkit: 'latest' },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('concrete resolved version');
  });

  it('rejects a code path outside the generated-agents convention', () => {
    expect(BuildManifestSchema.safeParse({ ...valid, codePath: 'src/agents/v1' }).success).toBe(
      false,
    );
  });
});

describe('eval case', () => {
  it('requires a spec trace so no expectation encodes invented policy', () => {
    const base = {
      caseKey: 'case-01',
      description: 'Happy path',
      inputRefs: {
        emailPaths: ['examples/inbound-import-receiving/fixtures/emails/happy-path.eml'],
        attachmentPaths: [],
        expectedPath: 'examples/inbound-import-receiving/fixtures/expected/case-01.expected.json',
      },
      expected: { outcome: 'ready' as const },
    };
    expect(EvalCaseSchema.safeParse(base).success).toBe(false);
    expect(
      EvalCaseSchema.safeParse({ ...base, specTrace: 'spec.process.terminalNodeIds' }).success,
    ).toBe(true);
  });

  it('requires at least one message, because a case with no input asserts nothing', () => {
    const withoutMessages = {
      caseKey: 'case-01',
      description: 'Happy path',
      specTrace: 'spec.process.terminalNodeIds',
      inputRefs: {
        emailPaths: [],
        attachmentPaths: [],
        expectedPath: 'examples/inbound-import-receiving/fixtures/expected/case-01.expected.json',
      },
      expected: { outcome: 'ready' as const },
    };
    expect(EvalCaseSchema.safeParse(withoutMessages).success).toBe(false);
  });
});
