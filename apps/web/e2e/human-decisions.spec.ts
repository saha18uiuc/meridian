import { expect, test, type Page } from '@playwright/test';
import { signIn } from './fixtures';

/**
 * The handoff, seen from the operator's side.
 *
 * The demo step that runs before this suite plays the receiving specialist: one shipment reaches a
 * question the specification does not answer, and the demo signals an answer so the run does not
 * sit out its twenty-four hour timeout. That leaves an answered handoff in the event log rather
 * than a pending one, which is what this file can assert against — that the panel finds a real
 * handoff in real events, names the decision, and reports nothing outstanding.
 *
 * A pending handoff cannot be staged from a browser without leaving a workflow parked for the rest
 * of the run, so the pending branch is covered by the component tests over `deriveDecisionState`
 * and by the service test over the answering endpoint. What only an end-to-end run can show is that
 * the derivation works on events this system actually wrote, which is the gap this closes.
 */

interface EventRow {
  payloadJson: Record<string, unknown>;
}

async function findHandoffExecution(page: Page): Promise<{ id: string; requestId: string } | null> {
  const list = await page.request.get('/api/executions?runType=live');
  expect(list.ok()).toBe(true);
  const { executions } = (await list.json()) as { executions: { executionId: string }[] };
  expect(executions.length).toBeGreaterThan(0);

  for (const execution of executions) {
    const response = await page.request.get(
      `/api/executions/${execution.executionId}/events?limit=500`,
    );
    if (!response.ok()) continue;
    const { events } = (await response.json()) as { events: EventRow[] };
    const asked = events.find((event) => event.payloadJson['phase'] === 'human_handoff_requested');
    const requestId = asked?.payloadJson['requestId'];
    if (typeof requestId === 'string') return { id: execution.executionId, requestId };
  }
  return null;
}

test.describe('human decisions', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('an answered handoff appears in the run history with its decision', async ({ page }) => {
    const handoff = await findHandoffExecution(page);
    // The demo asserts that at least one shipment escalates, so a missing handoff here means the
    // demo's escalation path stopped asking — a real failure, not an empty fixture.
    expect(handoff, 'no execution asked a person anything').not.toBeNull();

    await page.goto(`/executions/${handoff!.id}`);
    const panel = page.getByTestId('human-decision-panel');
    await expect(panel).toBeVisible();

    const history = page.getByTestId('human-decision-history');
    await expect(history).toBeVisible();
    await expect(history).toContainText('escalated');

    // Answered, so no form and nothing outstanding.
    await expect(page.getByTestId('human-decision-none-pending')).toBeVisible();
    await expect(page.getByTestId(`decision-${handoff!.requestId}`)).toHaveCount(0);
  });

  test('a run nobody is waiting on carries no badge in the list', async ({ page }) => {
    const handoff = await findHandoffExecution(page);
    expect(handoff).not.toBeNull();

    await page.goto('/executions');
    await expect(page.getByTestId('execution-list')).toBeVisible();
    // The badge means "asked and unanswered". This one was answered, so its absence is the
    // assertion: a badge that never clears would be worse than no badge at all.
    await expect(page.getByTestId(`awaiting-decision-${handoff!.id}`)).toHaveCount(0);
  });
});
