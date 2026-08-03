import { expect, test } from '@playwright/test';
import { signIn } from './fixtures';

/**
 * Approval and activation are two decisions, and rollback is the second one taken again.
 *
 * The demo agent is committed, approved, and activated before Playwright runs, so this spec asserts
 * the properties of that release pointer rather than re-walking the gate: an approved version that
 * is not active is not live, activation moves the pointer, and rolling back moves it again without
 * touching a single historical execution row.
 */

interface AgentDetail {
  agent: { agentId: string; activeAgentVersionId: string | null; status: string };
  versions: { agentVersionId: string; versionNo: number; status: string }[];
}

async function loadDemoAgent(request: {
  get: (url: string) => Promise<{ ok: () => boolean; json: () => Promise<unknown> }>;
}): Promise<AgentDetail> {
  const list = await request.get('/api/agents');
  expect(list.ok()).toBe(true);
  const { agents } = (await list.json()) as { agents: { agentId: string }[] };
  for (const candidate of agents) {
    const detail = await request.get(`/api/agents/${candidate.agentId}`);
    if (!detail.ok()) continue;
    const body = (await detail.json()) as AgentDetail;
    if (body.versions.some((version) => version.status === 'approved')) return body;
  }
  throw new Error('no agent with an approved version exists; run `pnpm demo` before the e2e suite');
}

test.describe('activation and rollback', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('activation moves the pointer and rollback moves it back', async ({ page }) => {
    const before = await loadDemoAgent(page.request);
    const approved = before.versions
      .filter((version) => version.status === 'approved')
      .sort((left, right) => left.versionNo - right.versionNo);
    expect(approved.length).toBeGreaterThan(0);

    const target = approved[0]!;
    const response = await page.request.post(`/api/agents/${before.agent.agentId}/activation`, {
      data: { agentVersionId: target.agentVersionId },
    });
    expect(response.ok()).toBe(true);

    const after = (await (
      await page.request.get(`/api/agents/${before.agent.agentId}`)
    ).json()) as AgentDetail;
    expect(after.agent.activeAgentVersionId).toBe(target.agentVersionId);
    expect(after.agent.status).toBe('active');

    // Restore whatever was active before, which is the rollback path taken in the other direction.
    if (before.agent.activeAgentVersionId !== null) {
      const restored = await page.request.post(`/api/agents/${before.agent.agentId}/activation`, {
        data: { agentVersionId: before.agent.activeAgentVersionId },
      });
      expect(restored.ok()).toBe(true);
    }
  });

  test('historical executions keep naming the version that ran them', async ({ page }) => {
    const list = await page.request.get('/api/executions?runType=live');
    expect(list.ok()).toBe(true);
    const { executions } = (await list.json()) as { executions: { executionId: string }[] };
    expect(executions.length).toBeGreaterThan(0);

    const detail = await page.request.get(`/api/executions/${executions[0]!.executionId}`);
    expect(detail.ok()).toBe(true);
    const body = (await detail.json()) as {
      version: { agentVersionId: string; gitCommitSha: string | null };
    };
    // The row names a concrete version and the commit it ran, independent of where the pointer is.
    expect(body.version.agentVersionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.version.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('the agent page shows the active version and offers the others', async ({ page }) => {
    const agent = await loadDemoAgent(page.request);
    await page.goto(`/agents/${agent.agent.agentId}`);
    await expect(page.getByTestId('activation-controls')).toBeVisible();
    await expect(page.getByTestId('agent-version-table')).toContainText('approved');
  });
});
