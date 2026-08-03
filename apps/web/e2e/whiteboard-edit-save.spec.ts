import { expect, test } from '@playwright/test';
import { openSeededBoard, readBoard, signIn } from './fixtures';

/**
 * The authoring loop, asserted through the revision counter rather than through pixels.
 *
 * Every claim here is about optimistic concurrency: one edit is one revision, and a no-op writes
 * nothing. Those are the properties a second editor depends on, and they are invisible in a
 * screenshot.
 */

test.describe('whiteboard editing', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('renders all four primitives on the canvas', async ({ page }) => {
    await openSeededBoard(page);
    const canvas = page.getByTestId('canvas');
    for (const primitive of ['input', 'action', 'rule', 'outcome']) {
      await expect(canvas.locator(`[data-primitive="${primitive}"]`).first()).toBeVisible();
    }
  });

  test('one card edit increments the board revision exactly once', async ({ page }) => {
    const whiteboardId = await openSeededBoard(page);
    const before = await readBoard(page, whiteboardId);

    await page.getByTestId('canvas').locator('[data-primitive="action"]').first().click();
    const title = page.getByTestId('node-title');
    await expect(title).toBeVisible();
    await title.fill(`Fetch the thread ${String(Date.now())}`);
    await title.blur();

    await expect(page.getByTestId('save-status')).toHaveText(/saved/i);

    const after = await readBoard(page, whiteboardId);
    expect(after.revisionNo).toBe(before.revisionNo + 1);
  });

  test('renaming is a revisioned write, and renaming back to the same text is not', async ({
    page,
  }) => {
    const whiteboardId = await openSeededBoard(page);
    const before = await readBoard(page, whiteboardId);
    const field = page.getByTestId('rename-board');
    const original = await field.inputValue();

    await field.fill(`${original} (renamed)`);
    await field.blur();
    await expect(field).toHaveValue(`${original} (renamed)`);

    const renamed = await readBoard(page, whiteboardId);
    expect(renamed.revisionNo).toBe(before.revisionNo + 1);
    expect(renamed.status).toBe('draft');

    await field.fill(original);
    await field.blur();
    const restored = await readBoard(page, whiteboardId);
    expect(restored.revisionNo).toBe(renamed.revisionNo + 1);

    // Now the no-op: submitting the identical title must not increment anything.
    await field.fill(original);
    await field.blur();
    const unchanged = await readBoard(page, whiteboardId);
    expect(unchanged.revisionNo).toBe(restored.revisionNo);
  });
});
