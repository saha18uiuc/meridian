import { expect, test } from '@playwright/test';
import { openSeededBoard, signIn } from './fixtures';

/**
 * Creating a logical agent and reserving a version.
 *
 * The assertion that carries the design is the negative one: reserving a version prints a command
 * for the operator to run. The route allocates a row and a code path; it does not call a model,
 * write a file, or run `git`. Anything else would put code generation inside an HTTP request, where
 * it can neither be reviewed nor reproduced.
 */

test.describe('agent lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a new agent has no release pointer until activation is explicit', async ({ page }) => {
    const whiteboardId = await openSeededBoard(page);
    await page.goto('/agents');

    const deploymentKey = `e2e-agent-${String(Date.now()).slice(-9)}`;
    await page.getByTestId('agent-board').selectOption(whiteboardId);
    await page.getByTestId('agent-deployment-key').fill(deploymentKey);
    await page.getByTestId('agent-name').fill('End-to-end agent');
    await page.getByTestId('agent-create-submit').click();

    const row = page.getByTestId('agent-list').locator('tr', { hasText: deploymentKey });
    await expect(row).toBeVisible();
    // The release pointer starts unset, and the UI says "none" rather than resolving the newest
    // approved version on the operator's behalf.
    await expect(row).toContainText('none');

    await row.getByRole('link', { name: deploymentKey }).click();
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('versions-empty')).toBeVisible();
    await expect(page.getByTestId('activation-empty')).toBeVisible();
  });

  test('reserving a version prints the operator command instead of running it', async ({
    page,
  }) => {
    await page.goto('/agents');
    await expect(page.getByTestId('agent-list')).toBeVisible();
    await page.getByTestId('agent-list').getByRole('link').first().click();
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);

    const panel = page.getByTestId('reserve-version');
    await expect(panel).toBeVisible();
    await panel.getByTestId('reserve-submit').click();

    const command = page.getByTestId('operator-command');
    await expect(command).toBeVisible();
    await expect(command).toContainText('.codex/skills/spec-to-agent');
    await expect(command).toContainText('generated-agents/');

    // A reserved version is `generated` with no commit yet, and the table says so rather than
    // implying the code exists.
    const table = page.getByTestId('agent-version-table');
    await expect(table).toContainText('generated');
  });

  test('an uncommitted version cannot be moved to evaluating', async ({ page }) => {
    await page.goto('/agents');
    await page.getByTestId('agent-list').getByRole('link').first().click();
    await page.waitForURL(/\/agents\/([0-9a-f-]{36})$/);

    const agentId = new URL(page.url()).pathname.split('/').pop();
    const versions = await page.request.get(`/api/agents/${agentId!}`);
    expect(versions.ok()).toBe(true);
    const body = (await versions.json()) as {
      versions: { agentVersionId: string; status: string; gitCommitSha: string | null }[];
    };
    const uncommitted = body.versions.find(
      (version) => version.status === 'generated' && version.gitCommitSha === null,
    );
    expect(uncommitted).toBeDefined();

    const response = await page.request.post(
      `/api/agent-versions/${uncommitted!.agentVersionId}/transition`,
      { data: { status: 'evaluating' } },
    );
    // The gate lives in the database, so it holds no matter which client asks.
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain('GIT_COMMIT_REQUIRED');
  });
});
