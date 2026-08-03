/**
 * The wire-level names shared by the worker that registers the workflow and the intake service
 * that starts it.
 *
 * These live in `core` rather than in the worker because the intake service must name the workflow
 * type without importing the workflow module — importing it would drag the whole activity graph,
 * and with it the provider SDKs, into the Next.js server bundle. Keeping the strings in one place
 * means a rename cannot silently desynchronise the two sides; `apps/backend/test/registry-bundle`
 * asserts the registered function name still matches.
 */

export const TEMPORAL_TASK_QUEUE = 'meridian-receiving';

export const RECEIVING_WORKFLOW_TYPE = 'receivingWorkflow';

export const NEW_MESSAGE_SIGNAL = 'newMessage';

export const HUMAN_DECISION_SIGNAL = 'humanDecision';

/** `receiving:<normalized business key>`, derived before any Temporal call (§5.11 step 4). */
export function receivingWorkflowId(businessKey: string): string {
  return `receiving:${businessKey}`;
}
