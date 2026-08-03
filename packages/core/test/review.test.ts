import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_CHECKS,
  collapseFindings,
  isUnresolvedRoot,
  reanchorToCanvasIfUnknown,
  runDeterministicChecks,
  toModelFinding,
} from '../src/review.js';
import { CHECK_CODES, type CheckCode, type Finding } from '../src/schemas/review.js';
import {
  actionData,
  edge,
  graphOf,
  inputData,
  node,
  outcomeData,
  ruleData,
  uuid,
  validGraph,
} from './helpers/factories.js';
import type { CanonicalGraph } from '../src/schemas/board.js';

function codes(graph: CanonicalGraph): CheckCode[] {
  return runDeterministicChecks(graph).map((f) => f.checkCode as CheckCode);
}

/** Each entry is a graph that must trigger exactly the named check. */
const POSITIVE_FIXTURES: Record<CheckCode, () => CanonicalGraph> = {
  DISCONNECTED_NODE: () => {
    const base = validGraph();
    const orphan = node(uuid(70), 'action', 'Orphan', actionData());
    return graphOf([...base.nodes, orphan], [...base.edges]);
  },
  // An outcome is only unreachable when it sits behind a cycle: a node with no inbound edge is
  // a starting point by definition, so a stranded island still needs an upstream loop.
  UNREACHABLE_OUTCOME: () => {
    const input = node(uuid(71), 'input', 'Start', inputData());
    const reachable = node(uuid(72), 'outcome', 'Done', outcomeData());
    const stranded = node(uuid(73), 'outcome', 'Stranded', outcomeData());
    const loop = node(uuid(78), 'action', 'Detached loop', actionData());
    return graphOf(
      [input, reachable, stranded, loop],
      [
        edge(uuid(74), input.nodeId, reachable.nodeId),
        edge(uuid(79), loop.nodeId, stranded.nodeId),
        edge(uuid(100), stranded.nodeId, loop.nodeId),
      ],
    );
  },
  MISSING_INITIAL_PATH: () => {
    const a = node(uuid(75), 'action', 'A', actionData());
    const b = node(uuid(76), 'outcome', 'B', outcomeData());
    return graphOf(
      [a, b],
      [edge(uuid(77), a.nodeId, b.nodeId), edge(uuid(80), b.nodeId, a.nodeId)],
    );
  },
  MISSING_TERMINAL_PATH: () => {
    const input = node(uuid(81), 'input', 'Start', inputData());
    const action = node(uuid(82), 'action', 'Work', actionData());
    return graphOf([input, action], [edge(uuid(83), input.nodeId, action.nodeId)]);
  },
  UNLABELED_RULE_BRANCH: () => {
    const rule = node(uuid(84), 'rule', 'Branch', ruleData());
    const yes = node(uuid(85), 'outcome', 'Yes', outcomeData());
    const no = node(uuid(86), 'outcome', 'No', outcomeData());
    return graphOf(
      [rule, yes, no],
      [edge(uuid(87), rule.nodeId, yes.nodeId, 'complete'), edge(uuid(88), rule.nodeId, no.nodeId)],
    );
  },
  MISSING_REQUIRED_PRIMITIVE_FIELD: () => {
    const input = node(uuid(89), 'input', 'Bad input', { inputKind: 'telepathy' });
    return graphOf([input], []);
  },
  INVALID_EDGE_REFERENCE: () => {
    const a = node(uuid(90), 'action', 'A', actionData());
    return graphOf([a], [edge(uuid(91), a.nodeId, uuid(999))]);
  },
  ORPHANED_EXCEPTION_PATH: () => {
    const rule = node(
      uuid(92),
      'rule',
      'On failure',
      ruleData({ ruleKind: 'exception', branches: [], fallbackNodeId: null }),
    );
    return graphOf([rule], []);
  },
  ACTION_WITHOUT_ACTOR: () => {
    const action = node(uuid(93), 'action', 'Nobody does this', actionData({ actor: '' }));
    return graphOf([action], []);
  },
  ACTION_WITHOUT_SYSTEM: () => {
    const action = node(uuid(94), 'action', 'Automated', actionData({ system: '   ' }));
    return graphOf([action], []);
  },
  RULE_INVALID_BRANCH_CONFIG: () => {
    const rule = node(
      uuid(95),
      'rule',
      'One-sided decision',
      ruleData({ branches: [{ label: 'only', condition: '', targetNodeId: null }] }),
    );
    return graphOf([rule], []);
  },
  RETRY_RULE_WITHOUT_MAX_ATTEMPTS: () => {
    const rule = node(uuid(96), 'rule', 'Retry', ruleData({ ruleKind: 'retry', branches: [] }));
    return graphOf([rule], []);
  },
  WAIT_RULE_WITHOUT_TIMEOUT: () => {
    const rule = node(uuid(97), 'rule', 'Wait', ruleData({ ruleKind: 'wait', branches: [] }));
    return graphOf([rule], []);
  },
  UNKNOWN_CAPABILITY: () => {
    const outcome = node(
      uuid(98),
      'outcome',
      'Telegraph the broker',
      outcomeData({
        requiredAction: { actionType: 'telegraph', description: '', capability: 'telegraph.send' },
      }),
    );
    return graphOf([outcome], []);
  },
};

describe('the fourteen deterministic checks', () => {
  it('registers exactly fourteen checks, one per code', () => {
    expect(DETERMINISTIC_CHECKS).toHaveLength(14);
    expect(DETERMINISTIC_CHECKS.map((c) => c.code).sort()).toEqual([...CHECK_CODES].sort());
  });

  for (const code of CHECK_CODES) {
    it(`${code} fires on its positive fixture`, () => {
      expect(codes(POSITIVE_FIXTURES[code]())).toContain(code);
    });

    it(`${code} stays silent on a clean board`, () => {
      expect(codes(validGraph())).not.toContain(code);
    });
  }

  it('produces no findings at all for a clean board', () => {
    expect(runDeterministicChecks(validGraph())).toEqual([]);
  });

  it('runs before any model call, so a clean run is fully offline', () => {
    const graph = POSITIVE_FIXTURES.DISCONNECTED_NODE();
    const first = runDeterministicChecks(graph);
    const second = runDeterministicChecks(graph);
    expect(first).toEqual(second);
  });
});

describe('finding collapse', () => {
  const base: Finding = {
    issueKey: 'det:DISCONNECTED_NODE:node:x:-',
    checkCode: 'DISCONNECTED_NODE',
    normalizedIssueCode: null,
    origin: 'deterministic',
    anchorType: 'node',
    anchorId: uuid(3),
    anchorFieldPath: null,
    severity: 'non_blocking',
    body: 'first',
  };

  it('keeps the highest severity and bullets the bodies', () => {
    const collapsed = collapseFindings([
      base,
      { ...base, severity: 'blocking', body: 'second' },
      { ...base, body: 'first' },
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.severity).toBe('blocking');
    expect(collapsed[0]?.body).toBe('- first\n- second');
  });

  it('leaves distinct keys alone', () => {
    const other: Finding = { ...base, issueKey: 'det:UNREACHABLE_OUTCOME:node:x:-' };
    expect(collapseFindings([base, other])).toHaveLength(2);
  });
});

describe('model findings', () => {
  it('derives a mod: key and preserves the normalized code', () => {
    const finding = toModelFinding({
      normalizedIssueCode: 'missing_correlation_key',
      anchorType: 'canvas',
      anchorId: null,
      anchorFieldPath: null,
      severity: 'blocking',
      body: 'No correlation key is defined.',
    });
    expect(finding.issueKey).toBe('mod:missing_correlation_key:canvas:canvas:-');
    expect(finding.origin).toBe('model');
    expect(finding.checkCode).toBeNull();
  });

  it('re-anchors a finding pointing at a node outside the snapshot', () => {
    const graph = validGraph();
    const finding = toModelFinding({
      normalizedIssueCode: 'unbounded_wait',
      anchorType: 'node',
      anchorId: uuid(9999),
      anchorFieldPath: null,
      severity: 'non_blocking',
      body: 'hallucinated anchor',
    });
    const fixed = reanchorToCanvasIfUnknown(graph, finding);
    expect(fixed.anchorType).toBe('canvas');
    expect(fixed.anchorId).toBeNull();
    expect(fixed.issueKey).toBe('mod:unbounded_wait:canvas:canvas:-');
  });

  it('leaves a valid anchor untouched', () => {
    const graph = validGraph();
    const target = graph.nodes[0]?.nodeId as string;
    const finding = toModelFinding({
      normalizedIssueCode: 'unbounded_wait',
      anchorType: 'node',
      anchorId: target,
      anchorFieldPath: null,
      severity: 'non_blocking',
      body: 'real anchor',
    });
    expect(reanchorToCanvasIfUnknown(graph, finding)).toEqual(finding);
  });
});

describe('the single definition of unresolved (A26)', () => {
  const statuses = ['open', 'answered', 'resolved', 'rejected', null];

  it('is true only for parentless open/answered rows', () => {
    for (const status of statuses) {
      expect(isUnresolvedRoot(null, status)).toBe(status === 'open' || status === 'answered');
      expect(isUnresolvedRoot(uuid(5), status)).toBe(false);
    }
  });

  it('treats rejected as dismissed, never unresolved', () => {
    expect(isUnresolvedRoot(null, 'rejected')).toBe(false);
  });
});
