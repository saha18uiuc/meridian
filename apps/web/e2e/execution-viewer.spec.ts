import { expect, test } from '@playwright/test';
import { signIn } from './fixtures';

/**
 * Execution observability.
 *
 * `pnpm verify:e2e` runs the mock demo before Playwright, so live executions exist by the time this
 * file runs. That ordering is deliberate: a spec that tolerates an empty list would pass on a
 * system that records nothing at all.
 */

test.describe('execution viewer', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('the list filters by run type', async ({ page }) => {
    await page.goto('/executions');
    const list = page.getByTestId('execution-list');
    await expect(list).toBeVisible();

    await page.getByTestId('run-type-filter').selectOption('live');
    await expect(list).toBeVisible();
    await page.getByTestId('run-type-filter').selectOption('eval');
    await expect(list.or(page.getByTestId('executions-empty'))).toBeVisible();
  });

  test('a detail page shows pinned lineage, steps, events, and actions', async ({ page }) => {
    const response = await page.request.get('/api/executions?runType=live');
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { executions: { executionId: string }[] };
    expect(body.executions.length).toBeGreaterThan(0);

    await page.goto(`/executions/${body.executions[0]!.executionId}`);

    // Lineage is pinned per execution, not read from whatever happens to be active now.
    const summary = page.getByTestId('execution-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/[0-9a-f]{64}/);

    await expect(page.getByTestId('step-table').or(page.getByTestId('steps-empty'))).toBeVisible();
    await expect(page.getByTestId('event-feed')).toBeVisible();
    await expect(
      page.getByTestId('action-panel').or(page.getByTestId('actions-empty')),
    ).toBeVisible();
  });

  test('an in-flight action reports no completion time', async ({ page }) => {
    const list = await page.request.get('/api/executions?runType=live');
    const { executions } = (await list.json()) as { executions: { executionId: string }[] };
    expect(executions.length).toBeGreaterThan(0);

    for (const execution of executions) {
      const response = await page.request.get(`/api/executions/${execution.executionId}/actions`);
      expect(response.ok()).toBe(true);
      const { actions } = (await response.json()) as {
        actions: { status: string; timings: { completedAt: string | null } }[];
      };
      for (const action of actions) {
        // Only the three terminal states carry a completion time. Inferring one for a dispatched
        // action would let the UI claim a send finished when all we know is that it left.
        const terminal = ['succeeded', 'failed', 'abandoned'].includes(action.status);
        expect(action.timings.completedAt === null).toBe(!terminal);
      }
    }
  });
});
