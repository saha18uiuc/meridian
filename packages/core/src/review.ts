import {
  canReachAny,
  deriveInitialNodeIds,
  deriveTerminalNodeIds,
  reachableFrom,
  validateGraphIntegrity,
} from './graph.js';
import { canonicalJson } from './hashing.js';
import { deriveDeterministicIssueKey, deriveModelIssueKey } from './issue-key.js';
import type { CanonicalGraph } from './schemas/board.js';
import type { Comment } from './schemas/comment.js';
import { parseCommentMetadata } from './schemas/comment-metadata.js';
import type { WhiteboardNode } from './schemas/node.js';
import { safeParseNodeData } from './schemas/primitives.js';
import { isKnownCapability, KNOWN_CAPABILITIES, looksLikeCapability } from './schemas/spec.js';
import type { AnchorType, CheckCode, Finding, ModelFinding, Severity } from './schemas/review.js';

/**
 * The fifteen deterministic checks (§5.5.2).
 *
 * Every check is a pure function of the immutable snapshot, and the whole set runs *before* the
 * model call, so an OpenAI outage still produces a complete deterministic finding set rather
 * than an empty review.
 *
 * The PRD specified fourteen. The fifteenth, `RULE_BRANCH_EDGE_DIVERGENCE`, was added when the
 * authoring UI grew a view of both halves of a decision at once and made it obvious that the board
 * stores the ways out of a Rule twice with nothing keeping them equal. See DECISIONS.md.
 */

type RawData = Record<string, unknown>;

function raw(node: WhiteboardNode): RawData {
  return node.data;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nodeFinding(
  checkCode: CheckCode,
  node: WhiteboardNode,
  severity: Severity,
  body: string,
  anchorFieldPath: string | null = null,
): Finding {
  return {
    issueKey: deriveDeterministicIssueKey(checkCode, {
      anchorType: 'node',
      anchorId: node.nodeId,
      anchorFieldPath,
    }),
    checkCode,
    normalizedIssueCode: null,
    origin: 'deterministic',
    anchorType: 'node',
    anchorId: node.nodeId,
    anchorFieldPath,
    severity,
    body,
  };
}

function edgeFinding(
  checkCode: CheckCode,
  edgeId: string,
  severity: Severity,
  body: string,
  anchorFieldPath: string | null = null,
): Finding {
  return {
    issueKey: deriveDeterministicIssueKey(checkCode, {
      anchorType: 'edge',
      anchorId: edgeId,
      anchorFieldPath,
    }),
    checkCode,
    normalizedIssueCode: null,
    origin: 'deterministic',
    anchorType: 'edge',
    anchorId: edgeId,
    anchorFieldPath,
    severity,
    body,
  };
}

function canvasFinding(checkCode: CheckCode, severity: Severity, body: string): Finding {
  return {
    issueKey: deriveDeterministicIssueKey(checkCode, {
      anchorType: 'canvas',
      anchorId: null,
      anchorFieldPath: null,
    }),
    checkCode,
    normalizedIssueCode: null,
    origin: 'deterministic',
    anchorType: 'canvas',
    anchorId: null,
    anchorFieldPath: null,
    severity,
    body,
  };
}

// 1 ------------------------------------------------------------------- disconnected nodes
export function checkDisconnectedNodes(graph: CanonicalGraph): Finding[] {
  if (graph.nodes.length < 2) return [];
  const touched = new Set<string>();
  for (const edge of graph.edges) {
    touched.add(edge.sourceNodeId);
    touched.add(edge.targetNodeId);
  }
  return graph.nodes
    .filter((n) => !touched.has(n.nodeId))
    .map((n) =>
      nodeFinding(
        'DISCONNECTED_NODE',
        n,
        'blocking',
        `"${n.title}" has no incoming or outgoing connections, so nothing in the process can reach it and it can reach nothing.`,
      ),
    );
}

// 2 ------------------------------------------------------------------ unreachable outcomes
export function checkUnreachableOutcomes(graph: CanonicalGraph): Finding[] {
  const initial = deriveInitialNodeIds(graph);
  if (initial.length === 0) return [];
  const reachable = reachableFrom(graph, initial);
  return graph.nodes
    .filter((n) => n.primitiveType === 'outcome' && !reachable.has(n.nodeId))
    .map((n) =>
      nodeFinding(
        'UNREACHABLE_OUTCOME',
        n,
        'blocking',
        `Outcome "${n.title}" cannot be reached from any starting point, so this result can never occur.`,
      ),
    );
}

// 3 ---------------------------------------------------------------- missing initial path
export function checkMissingInitialPath(graph: CanonicalGraph): Finding[] {
  if (graph.nodes.length === 0) return [];
  if (deriveInitialNodeIds(graph).length > 0) return [];
  return [
    canvasFinding(
      'MISSING_INITIAL_PATH',
      'blocking',
      'The process has no starting point: every node has an incoming connection and no Input card is present.',
    ),
  ];
}

// 4 --------------------------------------------------------------- missing terminal path
export function checkMissingTerminalPath(graph: CanonicalGraph): Finding[] {
  if (graph.nodes.length === 0) return [];
  const terminals = deriveTerminalNodeIds(graph);
  if (terminals.length === 0) {
    return [
      canvasFinding(
        'MISSING_TERMINAL_PATH',
        'blocking',
        'The process has no terminal Outcome, so no path is defined as finished.',
      ),
    ];
  }
  const canFinish = canReachAny(graph, terminals);
  return graph.nodes
    .filter((n) => !canFinish.has(n.nodeId))
    .map((n) =>
      nodeFinding(
        'MISSING_TERMINAL_PATH',
        n,
        'blocking',
        `"${n.title}" cannot reach any terminal Outcome, so a run that arrives here never finishes.`,
      ),
    );
}

// 5 -------------------------------------------------------------- unlabeled rule branches
export function checkUnlabeledRuleBranches(graph: CanonicalGraph): Finding[] {
  const ruleIds = new Set(
    graph.nodes.filter((n) => n.primitiveType === 'rule').map((n) => n.nodeId),
  );
  const outgoing = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!ruleIds.has(edge.sourceNodeId)) continue;
    outgoing.set(edge.sourceNodeId, (outgoing.get(edge.sourceNodeId) ?? 0) + 1);
  }
  return graph.edges
    .filter(
      (e) =>
        ruleIds.has(e.sourceNodeId) &&
        (outgoing.get(e.sourceNodeId) ?? 0) > 1 &&
        str(e.label).length === 0,
    )
    .map((e) =>
      edgeFinding(
        'UNLABELED_RULE_BRANCH',
        e.edgeId,
        'blocking',
        'This branch out of a Rule has no label, so the condition that selects it is undefined.',
        'label',
      ),
    );
}

// 6 ------------------------------------------------------ missing required primitive fields
const FIELDS_COVERED_BY_DEDICATED_CHECKS = new Set(['maxAttempts', 'timeoutMinutes', 'actor']);

export function checkMissingRequiredPrimitiveFields(graph: CanonicalGraph): Finding[] {
  const findings: Finding[] = [];
  for (const node of graph.nodes) {
    const parsed = safeParseNodeData(node.primitiveType, node.data);
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      const head = issue.path[0];
      const fieldPath = issue.path.length > 0 ? issue.path.map(String).join('.') : null;
      if (typeof head === 'string' && FIELDS_COVERED_BY_DEDICATED_CHECKS.has(head)) continue;
      findings.push(
        nodeFinding(
          'MISSING_REQUIRED_PRIMITIVE_FIELD',
          node,
          'blocking',
          `"${node.title}" has invalid or missing card data at ${fieldPath ?? '<card>'}: ${issue.message}`,
          fieldPath,
        ),
      );
    }
  }
  return findings;
}

// 7 ------------------------------------------------------------- invalid edge references
export function checkInvalidEdgeReferences(graph: CanonicalGraph): Finding[] {
  return validateGraphIntegrity(graph)
    .filter((issue) => issue.edgeId !== undefined)
    .map((issue) =>
      edgeFinding(
        'INVALID_EDGE_REFERENCE',
        issue.edgeId as string,
        'blocking',
        issue.message,
        issue.code === 'DANGLING_EDGE_SOURCE'
          ? 'sourceNodeId'
          : issue.code === 'DANGLING_EDGE_TARGET'
            ? 'targetNodeId'
            : null,
      ),
    );
}

// 8 ------------------------------------------------------------ orphaned exception paths
export function checkOrphanedExceptionPaths(graph: CanonicalGraph): Finding[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.nodeId));
  const hasOutgoing = new Set(graph.edges.map((e) => e.sourceNodeId));
  const findings: Finding[] = [];

  for (const node of graph.nodes) {
    if (node.primitiveType !== 'rule') continue;
    const data = raw(node);
    if (str(data['ruleKind']) !== 'exception') continue;

    const fallback = data['fallbackNodeId'];
    const fallbackId = typeof fallback === 'string' ? fallback : null;

    if (fallbackId !== null && !nodeIds.has(fallbackId)) {
      findings.push(
        nodeFinding(
          'ORPHANED_EXCEPTION_PATH',
          node,
          'blocking',
          `Exception Rule "${node.title}" escalates to a node that does not exist on this board.`,
          'fallbackNodeId',
        ),
      );
      continue;
    }
    if (fallbackId === null && !hasOutgoing.has(node.nodeId)) {
      findings.push(
        nodeFinding(
          'ORPHANED_EXCEPTION_PATH',
          node,
          'blocking',
          `Exception Rule "${node.title}" has neither an outgoing path nor a fallback node, so a raised exception goes nowhere.`,
          'fallbackNodeId',
        ),
      );
    }
  }
  return findings;
}

// 9 ------------------------------------------------------------- actions without an actor
export function checkActionsWithoutActor(graph: CanonicalGraph): Finding[] {
  const valid = new Set(['agent', 'human', 'system']);
  return graph.nodes
    .filter((n) => n.primitiveType === 'action' && !valid.has(str(raw(n)['actor'])))
    .map((n) =>
      nodeFinding(
        'ACTION_WITHOUT_ACTOR',
        n,
        'blocking',
        `Action "${n.title}" does not say who performs it (agent, human, or system).`,
        'actor',
      ),
    );
}

// 10 ------------------------------------------- agent/system actions without system information
export function checkActionsWithoutSystem(graph: CanonicalGraph): Finding[] {
  return graph.nodes
    .filter((n) => {
      if (n.primitiveType !== 'action') return false;
      const actor = str(raw(n)['actor']);
      return (actor === 'agent' || actor === 'system') && str(raw(n)['system']).length === 0;
    })
    .map((n) =>
      nodeFinding(
        'ACTION_WITHOUT_SYSTEM',
        n,
        'blocking',
        `Action "${n.title}" is performed automatically but names no system to perform it against.`,
        'system',
      ),
    );
}

// 11 -------------------------------------------------- rules with invalid branch configuration
export function checkRuleBranchConfiguration(graph: CanonicalGraph): Finding[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.nodeId));
  const findings: Finding[] = [];

  for (const node of graph.nodes) {
    if (node.primitiveType !== 'rule') continue;
    const data = raw(node);
    if (str(data['ruleKind']) !== 'decision') continue;

    const branches = Array.isArray(data['branches']) ? data['branches'] : [];

    if (branches.length < 2) {
      findings.push(
        nodeFinding(
          'RULE_INVALID_BRANCH_CONFIG',
          node,
          'blocking',
          `Decision Rule "${node.title}" defines ${branches.length} branch(es); a decision needs at least two.`,
          'branches',
        ),
      );
      continue;
    }

    const labels = new Set<string>();
    let problem: string | null = null;
    for (const branch of branches) {
      const record = (typeof branch === 'object' && branch !== null ? branch : {}) as RawData;
      const label = str(record['label']);
      if (label.length === 0) {
        problem = 'one branch has no label';
        break;
      }
      if (labels.has(label)) {
        problem = `the branch label "${label}" is used twice`;
        break;
      }
      labels.add(label);
      const target = record['targetNodeId'];
      if (typeof target === 'string' && !nodeIds.has(target)) {
        problem = `the branch "${label}" targets a node that does not exist`;
        break;
      }
    }

    if (problem !== null) {
      findings.push(
        nodeFinding(
          'RULE_INVALID_BRANCH_CONFIG',
          node,
          'blocking',
          `Decision Rule "${node.title}" has an invalid branch configuration: ${problem}.`,
          'branches',
        ),
      );
    }
  }
  return findings;
}

// 12 --------------------------------------------------- retry rules without `maxAttempts`
export function checkRetryRulesWithoutMaxAttempts(graph: CanonicalGraph): Finding[] {
  return graph.nodes
    .filter((n) => {
      if (n.primitiveType !== 'rule') return false;
      const data = raw(n);
      if (str(data['ruleKind']) !== 'retry') return false;
      const attempts = data['maxAttempts'];
      return !(typeof attempts === 'number' && Number.isInteger(attempts) && attempts > 0);
    })
    .map((n) =>
      nodeFinding(
        'RETRY_RULE_WITHOUT_MAX_ATTEMPTS',
        n,
        'blocking',
        `Retry Rule "${n.title}" has no positive maxAttempts, so retrying is unbounded.`,
        'maxAttempts',
      ),
    );
}

// 13 ------------------------------------------------- wait rules without `timeoutMinutes`
export function checkWaitRulesWithoutTimeout(graph: CanonicalGraph): Finding[] {
  return graph.nodes
    .filter((n) => {
      if (n.primitiveType !== 'rule') return false;
      const data = raw(n);
      if (str(data['ruleKind']) !== 'wait') return false;
      const timeout = data['timeoutMinutes'];
      return !(typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0);
    })
    .map((n) =>
      nodeFinding(
        'WAIT_RULE_WITHOUT_TIMEOUT',
        n,
        'blocking',
        `Wait Rule "${n.title}" has no positive timeoutMinutes, so the process can wait forever.`,
        'timeoutMinutes',
      ),
    );
}

// 14 ----------------------------------------------------------------- unknown capabilities
export function checkUnknownCapabilities(graph: CanonicalGraph): Finding[] {
  const findings: Finding[] = [];
  for (const node of graph.nodes) {
    if (node.primitiveType === 'outcome') {
      const action = raw(node)['requiredAction'];
      if (typeof action !== 'object' || action === null) continue;
      const capability = str((action as RawData)['capability']);
      if (capability.length === 0 || isKnownCapability(capability)) continue;
      findings.push(
        nodeFinding(
          'UNKNOWN_CAPABILITY',
          node,
          'blocking',
          `Outcome "${node.title}" requires the capability "${capability}", which the runtime does not provide. Known capabilities: ${KNOWN_CAPABILITIES.join(', ')}.`,
          'requiredAction.capability',
        ),
      );
      continue;
    }

    if (node.primitiveType !== 'action') continue;
    const operation = str(raw(node)['operation']);
    if (!looksLikeCapability(operation) || isKnownCapability(operation)) continue;
    findings.push(
      nodeFinding(
        'UNKNOWN_CAPABILITY',
        node,
        'blocking',
        `Action "${node.title}" declares the capability "${operation}", which the runtime does not provide. Known capabilities: ${KNOWN_CAPABILITIES.join(', ')}.`,
        'operation',
      ),
    );
  }
  return findings;
}

// 15 ------------------------------------------ rule branches that disagree with their edges
/**
 * A decision Rule says the ways out of it twice: once as `branches[].label` on the card, and once
 * as the label on each outgoing edge. Nothing in the schema ties the two together — the reference
 * board keeps them equal by hand — so a board can hold two different answers to "what are the ways
 * out of here" and look completely healthy.
 *
 * That is worth a check rather than a schema constraint because the disagreement is not always an
 * error. A branch may deliberately have no edge while it is being drafted, and an edge may
 * legitimately be unlabelled. What is never intended is a *named* branch and a *named* edge that
 * name different things: the compiler follows the edges, the reader follows the card, and a
 * generated agent then does something other than what the board says.
 *
 * Non-blocking, because the board is still compilable and the author may be mid-edit. It is the
 * kind of finding the operator should answer, not one that should stop a freeze on its own.
 */
export function checkRuleBranchEdgeDivergence(graph: CanonicalGraph): Finding[] {
  const findings: Finding[] = [];

  for (const node of graph.nodes) {
    if (node.primitiveType !== 'rule') continue;
    const data = raw(node);
    if (str(data['ruleKind']) !== 'decision') continue;

    const branches = Array.isArray(data['branches']) ? data['branches'] : [];
    const branchLabels = new Set<string>();
    for (const branch of branches) {
      const record = (typeof branch === 'object' && branch !== null ? branch : {}) as RawData;
      const label = str(record['label']).toLowerCase();
      if (label.length > 0) branchLabels.add(label);
    }

    const edgeLabels = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.sourceNodeId !== node.nodeId) continue;
      const label = str(edge.label).toLowerCase();
      if (label.length > 0) edgeLabels.add(label);
    }

    // Only a board that names both sides is making a claim that can conflict.
    if (branchLabels.size === 0 || edgeLabels.size === 0) continue;

    const branchesWithoutEdge = [...branchLabels].filter((label) => !edgeLabels.has(label)).sort();
    const edgesWithoutBranch = [...edgeLabels].filter((label) => !branchLabels.has(label)).sort();
    if (branchesWithoutEdge.length === 0 && edgesWithoutBranch.length === 0) continue;

    const parts: string[] = [];
    if (branchesWithoutEdge.length > 0) {
      parts.push(`no arrow leaves it for the branch(es) ${quoteList(branchesWithoutEdge)}`);
    }
    if (edgesWithoutBranch.length > 0) {
      parts.push(`no branch describes the arrow(s) ${quoteList(edgesWithoutBranch)}`);
    }

    findings.push(
      nodeFinding(
        'RULE_BRANCH_EDGE_DIVERGENCE',
        node,
        'non_blocking',
        `Decision Rule "${node.title}" and the arrows leaving it describe different ways forward: ${parts.join(', and ')}.`,
        'branches',
      ),
    );
  }
  return findings;
}

function quoteList(labels: readonly string[]): string {
  return labels.map((label) => `"${label}"`).join(', ');
}

export const DETERMINISTIC_CHECKS: ReadonlyArray<{
  code: CheckCode;
  run: (graph: CanonicalGraph) => Finding[];
}> = [
  { code: 'DISCONNECTED_NODE', run: checkDisconnectedNodes },
  { code: 'UNREACHABLE_OUTCOME', run: checkUnreachableOutcomes },
  { code: 'MISSING_INITIAL_PATH', run: checkMissingInitialPath },
  { code: 'MISSING_TERMINAL_PATH', run: checkMissingTerminalPath },
  { code: 'UNLABELED_RULE_BRANCH', run: checkUnlabeledRuleBranches },
  { code: 'MISSING_REQUIRED_PRIMITIVE_FIELD', run: checkMissingRequiredPrimitiveFields },
  { code: 'INVALID_EDGE_REFERENCE', run: checkInvalidEdgeReferences },
  { code: 'ORPHANED_EXCEPTION_PATH', run: checkOrphanedExceptionPaths },
  { code: 'ACTION_WITHOUT_ACTOR', run: checkActionsWithoutActor },
  { code: 'ACTION_WITHOUT_SYSTEM', run: checkActionsWithoutSystem },
  { code: 'RULE_INVALID_BRANCH_CONFIG', run: checkRuleBranchConfiguration },
  { code: 'RETRY_RULE_WITHOUT_MAX_ATTEMPTS', run: checkRetryRulesWithoutMaxAttempts },
  { code: 'WAIT_RULE_WITHOUT_TIMEOUT', run: checkWaitRulesWithoutTimeout },
  { code: 'UNKNOWN_CAPABILITY', run: checkUnknownCapabilities },
  { code: 'RULE_BRANCH_EDGE_DIVERGENCE', run: checkRuleBranchEdgeDivergence },
];

export function runDeterministicChecks(graph: CanonicalGraph): Finding[] {
  return DETERMINISTIC_CHECKS.flatMap((check) => check.run(graph));
}

/** Turn one structured-output finding into a `Finding` with a stable `mod:` key. */
export function toModelFinding(finding: ModelFinding): Finding {
  const anchorId = finding.anchorType === 'canvas' ? null : finding.anchorId;
  return {
    issueKey: deriveModelIssueKey(finding.normalizedIssueCode, {
      anchorType: finding.anchorType,
      anchorId,
      anchorFieldPath: finding.anchorFieldPath,
    }),
    checkCode: null,
    normalizedIssueCode: finding.normalizedIssueCode,
    origin: 'model',
    anchorType: finding.anchorType,
    anchorId,
    anchorFieldPath: finding.anchorFieldPath,
    severity: finding.severity,
    body: finding.body,
  };
}

/**
 * A model may anchor to a node or edge that is not in the snapshot it was shown. The comment
 * anchor trigger would reject such a row, so those findings are re-anchored to the canvas
 * instead of being silently dropped.
 */
export function reanchorToCanvasIfUnknown(graph: CanonicalGraph, finding: Finding): Finding {
  if (finding.anchorType === 'canvas' || finding.anchorId === null) return finding;
  const exists =
    finding.anchorType === 'node'
      ? graph.nodes.some((n) => n.nodeId === finding.anchorId)
      : graph.edges.some((e) => e.edgeId === finding.anchorId);
  if (exists) return finding;

  const anchor = { anchorType: 'canvas' as const, anchorId: null, anchorFieldPath: null };
  return {
    ...finding,
    issueKey:
      finding.origin === 'model' && finding.normalizedIssueCode !== null
        ? deriveModelIssueKey(finding.normalizedIssueCode, anchor)
        : deriveDeterministicIssueKey(finding.checkCode as CheckCode, anchor),
    anchorType: 'canvas',
    anchorId: null,
    anchorFieldPath: null,
  };
}

/**
 * Collapse a round's findings by `issue_key`: highest severity wins and the bodies become
 * bullets. `UNIQUE (review_session_id, issue_key)` makes this a database guarantee too, so this
 * function exists to produce a good message rather than to avoid a constraint violation.
 */
export function collapseFindings(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding[]>();
  const order: string[] = [];

  for (const finding of findings) {
    const bucket = byKey.get(finding.issueKey);
    if (bucket) {
      bucket.push(finding);
    } else {
      byKey.set(finding.issueKey, [finding]);
      order.push(finding.issueKey);
    }
  }

  return order.map((key) => {
    const group = byKey.get(key) as Finding[];
    const first = group[0] as Finding;
    if (group.length === 1) return first;
    const severity: Severity = group.some((f) => f.severity === 'blocking')
      ? 'blocking'
      : 'non_blocking';
    const bodies = [...new Set(group.map((f) => f.body.trim()))];
    return {
      ...first,
      severity,
      body: bodies.map((b) => `- ${b}`).join('\n'),
    };
  });
}

/**
 * The single definition of "unresolved" (§5.5.6, A26), mirroring the SQL helper
 * `meridian.is_unresolved_root(p_parent uuid, p_status text)` exactly. A `rejected` root is a
 * finding the operator deliberately dismissed with a recorded rationale; it is not unresolved,
 * never auto-reopens, and never produces a freeze warning.
 */
export function isUnresolvedRoot(
  parentCommentId: string | null,
  status: string | null | undefined,
): boolean {
  return parentCommentId === null && (status === 'open' || status === 'answered');
}

/** One earlier finding and what the operator decided about it. */
export interface SettledDecision {
  /** The finding verbatim, so the model can recognise its own wording rather than a paraphrase. */
  finding: string;
  /** The assumption recorded on it, or the reason it was dismissed. */
  decision: string;
  anchorType: AnchorType;
  anchorId: string | null;
}

export interface SettledContext {
  assumptions: SettledDecision[];
  rejections: SettledDecision[];
}

function isSettledContextEmpty(context: SettledContext): boolean {
  return context.assumptions.length === 0 && context.rejections.length === 0;
}

/**
 * What the operator has already decided, as the reviewer needs to hear it.
 *
 * Rounds after the first were reviewing the board and nothing else, which put the resolution
 * policy at odds with itself: a model finding resolves only when it has a recorded assumption
 * *and* the round does not raise it again (§5.5.3), yet the model deciding whether to raise it was
 * never shown the assumption. Whether an answered question closed therefore came down to whether
 * the model happened to repeat itself, and a board whose ambiguity was settled deliberately — an
 * assumption is precisely the artefact for ambiguity the board is not going to state — looked
 * identical to one where nobody had answered anything.
 *
 * Rejections travel for the same reason. A dismissed finding never reopens (A26), so re-reporting
 * it can only produce a recurrence notice on a thread that is closed to the operator.
 *
 * This is context, not instruction: the round still runs every deterministic check, and a decision
 * cannot suppress one, because those are not matters of opinion.
 */
export function deriveSettledContext(comments: readonly Comment[]): SettledContext {
  const roots = new Map<string, Comment>();
  for (const comment of comments) {
    if (comment.parentCommentId === null) roots.set(comment.commentId, comment);
  }

  const assumptions = assumptionDecisions(comments, roots);
  const rejections = rejectionDecisions(comments, roots);
  assumptions.sort(byRoot);
  rejections.sort(byRoot);

  return {
    assumptions: assumptions.map((entry) => entry.decision),
    rejections: rejections.map((entry) => entry.decision),
  };
}

interface Settled {
  root: Comment;
  decision: SettledDecision;
}

function byRoot(a: Settled, b: Settled): number {
  return a.root.createdAt === b.root.createdAt
    ? a.root.commentId.localeCompare(b.root.commentId)
    : a.root.createdAt.localeCompare(b.root.createdAt);
}

function assumptionDecisions(
  comments: readonly Comment[],
  roots: ReadonlyMap<string, Comment>,
): Settled[] {
  // Superseded assumptions stay on the thread as history. Only the current one is a decision.
  const superseded = new Set<string>();
  for (const comment of comments) {
    const metadata = parseCommentMetadata(comment.metadataJson);
    if (metadata?.kind === 'assumption' && metadata.supersedesCommentId !== null) {
      superseded.add(metadata.supersedesCommentId);
    }
  }

  const settled: Settled[] = [];
  for (const comment of comments) {
    const metadata = parseCommentMetadata(comment.metadataJson);
    if (metadata?.kind !== 'assumption' || superseded.has(comment.commentId)) continue;
    const root = roots.get(metadata.sourceRootCommentId);
    if (root === undefined) continue;
    settled.push({ root, decision: toDecision(root, metadata.assumptionText) });
  }
  return settled;
}

function rejectionDecisions(
  comments: readonly Comment[],
  roots: ReadonlyMap<string, Comment>,
): Settled[] {
  const settled: Settled[] = [];
  for (const comment of comments) {
    const metadata = parseCommentMetadata(comment.metadataJson);
    if (metadata?.kind !== 'rejection' || comment.parentCommentId === null) continue;
    // Only a root the database agrees is rejected. A rationale whose status change was rolled back
    // is not a decision, and presenting it as one would silence a finding that is still live.
    const root = roots.get(comment.parentCommentId);
    if (root?.status !== 'rejected') continue;
    settled.push({ root, decision: toDecision(root, metadata.reason) });
  }
  return settled;
}

function toDecision(root: Comment, decision: string): SettledDecision {
  return {
    finding: root.body,
    decision,
    anchorType: root.anchorType,
    anchorId: root.anchorId,
  };
}

/**
 * The settled context as a message for the model, or `null` when nothing has been settled — which
 * keeps a first round byte-identical to what it sent before this existed.
 */
export function settledContextPrompt(context: SettledContext): string | null {
  if (isSettledContextEmpty(context)) return null;
  return [
    'The process owner has already answered these findings from earlier rounds. An assumption is a',
    'decision that now forms part of the specification; a rejection is a judgement that the point',
    'does not apply here. Both hold even though the board does not restate them, so do not report',
    'an issue that one of them already answers. Report anything they do not cover.',
    canonicalJson(context),
  ].join('\n');
}
