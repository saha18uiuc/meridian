import type { Edge } from '@xyflow/react';
import type { LocalEdge } from '@/features/whiteboard/useGraphStore';

export type MeridianEdge = Edge<{ priority: number; condition: Record<string, unknown> | null }>;

/** Edges carry decision semantics, so the label and the priority are both always visible. */
export function toFlowEdge(edge: LocalEdge): MeridianEdge {
  const label = edge.label === null || edge.label === '' ? null : edge.label;
  return {
    id: edge.edgeId,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    ...(label === null ? {} : { label: `${label} · p${edge.priority}` }),
    data: { priority: edge.priority, condition: edge.condition },
    animated: false,
  };
}

export function describeEdge(edge: LocalEdge): string {
  const parts = [edge.label ?? '(unlabelled)', `priority ${edge.priority}`];
  if (edge.condition !== null) parts.push('conditional');
  return parts.join(' · ');
}
