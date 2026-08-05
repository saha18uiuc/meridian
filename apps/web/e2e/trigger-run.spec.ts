import { expect, test } from '@playwright/test';
import { signIn } from './fixtures';

/**
 * Starting a run from the browser.
 *
 * Every other way into the runtime is an operator command, which is correct for a real deployment —
 * mail arrives on its own — but meant that a deployed instance had no path from "signed in" to "a
 * workflow ran". This spec covers the one the panel adds, end to end: fixture mail handed to intake,
 * a Temporal workflow started, and an execution reaching a terminal outcome.
 *
 * It asserts the outcome rather than merely that a row appeared. A trigger that reliably creates
 * `queued` executions nobody executes is the failure mode worth catching, and it looks like success
 * from the button's point of view.
 */

test.describe('trigger a run from the agent page', () => {
  test('fixture mail starts a workflow that reaches an outcome', async ({ page }) => {
    /**
     * Longer than the config's 60s, because the wait below asks for 120s and a per-assertion budget
     * cannot outlive the test holding it. Against a local worker the run finishes in seconds and the
     * contradiction never shows; against a deployed one on a shared CPU it fails at 60s reporting
     * the last status it saw, which reads as a stalled workflow rather than as a spec that stopped
     * watching too early.
     */
    test.setTimeout(180_000);

    await signIn(page);

    const agents = await page.request.get('/api/agents');
    expect(agents.ok()).toBe(true);
    const { agents: list } = (await agents.json()) as {
      agents: { agentId: string; deploymentKey: string; status: string }[];
    };
    const agent = list.find((entry) => entry.deploymentKey === 'inbound-import-receiving');
    expect(agent, 'the receiving agent must be seeded').toBeDefined();
    expect(agent!.status, 'the agent must have an active version to run anything').toBe('active');

    await page.goto(`/agents/${agent!.agentId}`);
    const panel = page.getByTestId('trigger-run');
    await expect(panel).toBeVisible();

    // The happy path is chosen deliberately: it exercises correlation, extraction, per-good
    // validation, and certificate matching, and it is the only selection whose success is
    // unambiguous — a `needs_information` case also "works" when the agent is broken in the
    // direction of asking too often.
    await panel.getByTestId('trigger-message').selectOption('happy-path');
    await panel.getByTestId('trigger-submit').click();

    const result = panel.getByTestId('trigger-result');
    await expect(result).toBeVisible({ timeout: 30_000 });
    // `already_processed` is a legitimate answer on a re-run against a seeded database, so both it
    // and a fresh start are accepted; what is not acceptable is an error.
    await expect(result).toContainText(/started|signalled|already_processed/);

    await result.getByRole('link', { name: 'Open the execution' }).click();
    await expect(page.getByTestId('execution-summary')).toBeVisible();

    // Polled rather than awaited once: the workflow runs on a real worker against Temporal Cloud, so
    // the terminal status arrives some seconds after the redirect.
    await expect(page.getByTestId('execution-summary')).toContainText(
      /ready|needs_information|rejected|manual_review|completed/,
      { timeout: 120_000 },
    );
  });
});
