import { expect, test } from '@playwright/test';
import { expectRevision, openSeededBoard, readBoard, signIn } from './fixtures';

/**
 * What happens when two writers disagree about which revision they are editing.
 *
 * The stale write is issued through the API with the browser's own session rather than by
 * choreographing two tabs. The behaviour under test belongs to the board lock, and a second tab
 * would only add timing flake to a question the API answers directly and repeatably.
 */

test.describe('whiteboard conflicts', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a stale expected revision is refused with the current revision attached', async ({
    page,
  }) => {
    const whiteboardId = await openSeededBoard(page);
    const before = await readBoard(page, whiteboardId);

    // Move the board forward once so a stale number genuinely exists to send.
    const field = page.getByTestId('rename-board');
    const original = await field.inputValue();
    await field.fill(`${original} (conflict probe)`);
    await field.blur();
    await expectRevision(page, before.revisionNo + 1);
    const current = await readBoard(page, whiteboardId);
    expect(current.revisionNo).toBe(before.revisionNo + 1);

    const stale = await page.request.post(`/api/whiteboards/${whiteboardId}/delta`, {
      data: { expectedRevisionNo: before.revisionNo, nodeUpserts: [], nodeDeletes: [] },
    });
    expect(stale.status()).toBe(409);
    const body = (await stale.json()) as { code: string; currentRevisionNo?: number };
    expect(body.code).toBe('STALE_BOARD_REVISION');
    // The response carries the revision the client should reload to, so recovery is one refresh
    // rather than a guess.
    expect(body.currentRevisionNo).toBe(current.revisionNo);

    const unchanged = await readBoard(page, whiteboardId);
    expect(unchanged.revisionNo).toBe(current.revisionNo);

    // Restore the title, and wait for that write too: a spec that ends with a request in flight
    // hands the next one a board that is still moving.
    await field.fill(original);
    await field.blur();
    await expectRevision(page, current.revisionNo + 1);
  });

  test('the board keeps rendering after a refused write', async ({ page }) => {
    const whiteboardId = await openSeededBoard(page);
    await page.request.post(`/api/whiteboards/${whiteboardId}/delta`, {
      data: { expectedRevisionNo: 1, nodeUpserts: [], nodeDeletes: [] },
    });
    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();
  });
});
