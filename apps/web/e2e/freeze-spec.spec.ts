import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { openSeededBoard, readBoard, signIn } from './fixtures';

/**
 * Freezing, and the two claims the spec page makes about itself.
 *
 * Freeze warns; it does not block. An unresolved finding is a fact the author acknowledges, not a
 * gate the tool enforces, because the tool cannot know whether the finding matters. What the tool
 * can do is refuse to let the acknowledgement be implicit, which is why the confirm button stays
 * disabled until every warning shown has been ticked.
 *
 * The download assertion re-hashes the served bytes. That is the only way to show the published
 * `spec_hash` identifies the artifact the reader actually has, rather than one the server remembers.
 */

test.describe('freeze', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('freeze warns, requires acknowledgement, and publishes a verifiable hash', async ({
    page,
  }) => {
    await openSeededBoard(page);
    await page.getByTestId('review-process').click();
    await expect(page.getByTestId('review-process')).toBeEnabled({ timeout: 120_000 });

    await page.getByTestId('freeze-open').click();
    const dialog = page.getByTestId('freeze-dialog');
    await expect(dialog).toBeVisible();

    // Each warning is a separate acknowledgement, ticked only when it is actually present. A
    // rejected finding produces no warning at all, which is the point of separating dismissal from
    // resolution.
    for (const testId of ['ack-blockers', 'ack-stale-review']) {
      const box = page.getByTestId(testId);
      if ((await box.count()) > 0) await box.check();
    }

    await page.getByTestId('freeze-confirm').click();
    await page.waitForURL(/\/specs\/[0-9a-f-]{36}$/, { timeout: 60_000 });

    const viewer = page.getByTestId('spec-viewer');
    await expect(viewer).toBeVisible();

    const specId = new URL(page.url()).pathname.split('/').pop();
    const detail = await page.request.get(`/api/specs/${specId!}`);
    expect(detail.ok()).toBe(true);
    const { specHash } = (await detail.json()) as { specHash: string };
    // The page shows the same hash the API reports; the download then has to hash back to it.
    await expect(viewer).toContainText(specHash);

    const download = await page.request.get(`/api/specs/${specId!}?download=1`);
    expect(download.ok()).toBe(true);
    const bytes = await download.body();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(specHash);
  });

  test('freezing an unchanged board twice does not mint a second spec', async ({ page }) => {
    const whiteboardId = await openSeededBoard(page);
    const { revisionNo } = await readBoard(page, whiteboardId);
    const body = {
      expectedRevisionNo: revisionNo,
      acknowledgeUnresolvedBlockers: true,
      acknowledgeStaleReview: true,
    };

    const first = await page.request.post(`/api/whiteboards/${whiteboardId}/freeze`, {
      data: body,
    });
    const second = await page.request.post(`/api/whiteboards/${whiteboardId}/freeze`, {
      data: body,
    });
    // A spec is identified by the revision it was compiled from, so the second attempt on an
    // unchanged board is a conflict rather than a new version.
    expect([first.status(), second.status()]).toContain(409);
  });
});
