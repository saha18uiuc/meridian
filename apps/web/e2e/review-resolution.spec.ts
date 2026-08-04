import { expect, test, type Page } from '@playwright/test';
import { connectHandles, createBoard, currentRevision, savedAbove, signIn } from './fixtures';

/**
 * A finding that goes away because the thing it complained about went away.
 *
 * Resolution is the one comment transition an operator cannot perform. There is deliberately no
 * "mark resolved" control: a thread closes only when a later round stops reporting the issue, and
 * since Phase 1 that decision belongs to `finalize_review_session` alone. The policy is tested
 * directly against the database, but nothing asserted that a person driving the interface could
 * actually get a thread to close — which is the part of the loop a reader is least likely to
 * believe without seeing it.
 *
 * The finding is manufactured on a fresh board rather than borrowed from the seeded one, because a
 * deterministic check is the only kind whose disappearance *is* the evidence. A model finding stays
 * open until an assumption is recorded, no matter how quiet the model goes on the next round, so it
 * could never close this loop.
 */

const DISCONNECTED = /has no incoming or outgoing connections/;

async function review(page: Page): Promise<void> {
  const button = page.getByTestId('review-process');
  await button.click();
  await expect(button).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByTestId('review-error')).toHaveCount(0);
}

test.describe('a thread resolving after a later round', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a deterministic finding closes once the board stops triggering it', async ({ page }) => {
    await createBoard(page, `Resolution ${String(Date.now())}`);
    let revision = await currentRevision(page);

    // Two cards and no arrow between them: check one of fifteen, twice over.
    await page.getByTestId('add-input').click();
    await page.getByTestId('add-outcome').click();
    revision = await savedAbove(page, revision);
    await expect(page.getByTestId('canvas').locator('.card')).toHaveCount(2);

    await review(page);

    const thread = page
      .getByTestId('thread-list')
      .locator('[data-testid^="thread-"]')
      .filter({ hasText: DISCONNECTED })
      .first();
    await expect(thread).toBeVisible();
    const threadId = (await thread.getAttribute('data-testid'))?.replace('thread-', '');
    expect(threadId).toBeDefined();
    await expect(page.getByTestId(`status-${threadId!}`)).toHaveText('open');

    // The same finding is a bubble on the canvas, beside the card it is about.
    await expect(page.getByTestId(`comment-pin-${threadId!}`)).toBeVisible();

    // Do exactly what the finding asked for.
    await connectHandles(page, '.card-input .card-handle-out', '.card-outcome .card-handle-in');
    await savedAbove(page, revision);

    await review(page);

    // Resolved, and nobody asserted it was.
    await expect(page.getByTestId(`status-${threadId!}`)).toHaveText('resolved');

    // And off the canvas, because a bubble that never clears is a bubble nobody reads.
    await expect(page.getByTestId(`comment-pin-${threadId!}`)).toHaveCount(0);
  });
});
