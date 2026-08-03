import { expect, test } from '@playwright/test';
import { openSeededBoard, readBoard, signIn } from './fixtures';

/**
 * A review describes one revision of a board, and the UI has to say so once the board moves on.
 *
 * The rename is used as the edit because it is the case most likely to be treated as "just
 * metadata". It is not: a renamed process is a changed process as far as the reviewed snapshot is
 * concerned, and the badge has to go stale for it like any other write.
 */

test.describe('stale review indicator', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a rename after a review flips the badge to changed', async ({ page }) => {
    const whiteboardId = await openSeededBoard(page);

    await page.getByTestId('review-process').click();
    await expect(page.getByTestId('review-process')).toBeEnabled({ timeout: 120_000 });

    const badge = page.getByTestId('review-status');
    await expect(badge).toHaveAttribute('data-freshness', 'current');
    const reviewed = await readBoard(page, whiteboardId);
    expect(reviewed.lastReviewedRevisionNo).toBe(reviewed.revisionNo);

    const field = page.getByTestId('rename-board');
    const original = await field.inputValue();
    await field.fill(`${original} (stale probe)`);
    await field.blur();

    await expect(badge).toHaveAttribute('data-freshness', 'stale');
    const renamed = await readBoard(page, whiteboardId);
    // The marker does not move with the board: that gap is exactly what "stale" means.
    expect(renamed.lastReviewedRevisionNo).toBe(reviewed.lastReviewedRevisionNo);
    expect(renamed.revisionNo).toBeGreaterThan(renamed.lastReviewedRevisionNo!);

    await field.fill(original);
    await field.blur();
  });
});
