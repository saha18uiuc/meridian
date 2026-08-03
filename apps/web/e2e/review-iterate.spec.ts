import { expect, test, type Locator, type Page } from '@playwright/test';
import { openSeededBoard, readBoard, signIn } from './fixtures';

/**
 * Review, and the three things an author can do with a finding.
 *
 * The most important assertion in this file is the smallest one: replying to a finding makes it
 * `answered`, not `resolved`. Answering a question and fixing the thing it asks about are different
 * events, and a system that conflates them lets a board be frozen on the strength of a conversation.
 */

/**
 * Only open and answered roots carry reply, reject and assumption controls; a rejected or resolved
 * root is history. Selecting on the rendered status rather than on position keeps these specs
 * honest when a previous round has already dismissed something.
 */
function actionableThreads(page: Page): Locator {
  return page
    .getByTestId('thread-list')
    .locator(
      '[data-testid^="thread-"][data-status="open"], [data-testid^="thread-"][data-status="answered"]',
    );
}

test.describe('review iteration', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('review is one awaited request that returns findings', async ({ page }) => {
    const whiteboardId = await openSeededBoard(page);
    const before = await readBoard(page, whiteboardId);

    const button = page.getByTestId('review-process');
    await button.click();
    // The button holds its loading state for the whole request: there is no job id and no polling.
    await expect(button).toBeDisabled();
    await expect(button).toBeEnabled({ timeout: 120_000 });
    await expect(page.getByTestId('review-error')).toHaveCount(0);

    await expect(page.getByTestId('thread-list')).toBeVisible();
    await expect(page.getByTestId('unresolved-counter')).toBeVisible();

    // Finalizing the round advances the last-reviewed marker to the revision that was reviewed.
    const after = await readBoard(page, whiteboardId);
    expect(after.lastReviewedRevisionNo).toBe(before.revisionNo);
  });

  test('a reply marks the root answered, and a rejection stays rejected and uncounted', async ({
    page,
  }) => {
    await openSeededBoard(page);
    await page.getByTestId('review-process').click();
    await expect(page.getByTestId('review-process')).toBeEnabled({ timeout: 120_000 });

    const threads = actionableThreads(page);
    await expect(threads.first()).toBeVisible();
    expect(await threads.count()).toBeGreaterThan(1);

    const firstId = (await threads.nth(0).getAttribute('data-testid'))?.replace('thread-', '');
    const secondId = (await threads.nth(1).getAttribute('data-testid'))?.replace('thread-', '');
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();

    await page
      .getByTestId(`reply-input-${firstId!}`)
      .fill('The forwarder always sends this field.');
    await page.getByTestId(`reply-submit-${firstId!}`).click();
    await expect(page.getByTestId(`status-${firstId!}`)).toHaveText('answered');

    await page.getByTestId(`reject-open-${secondId!}`).click();
    await page.getByTestId(`reject-reason-${secondId!}`).fill('Out of scope for this process.');
    await page.getByTestId(`reject-submit-${secondId!}`).click();
    await expect(page.getByTestId(`status-${secondId!}`)).toHaveText('rejected');

    // A rejected root is dismissed, not unresolved: it is listed separately and does not count.
    await expect(page.getByTestId('dismissed-counter')).toBeVisible();
  });

  test('an answer can be promoted to an explicit assumption', async ({ page }) => {
    const whiteboardId = await openSeededBoard(page);
    await page.getByTestId('review-process').click();
    await expect(page.getByTestId('review-process')).toBeEnabled({ timeout: 120_000 });

    const threads = actionableThreads(page);
    await expect(threads.first()).toBeVisible();
    const threadId = (await threads.nth(0).getAttribute('data-testid'))?.replace('thread-', '');
    expect(threadId).toBeDefined();

    await page.getByTestId(`reply-input-${threadId!}`).fill('Treat a missing CoA as blocking.');
    await page.getByTestId(`reply-submit-${threadId!}`).click();
    await expect(page.getByTestId(`status-${threadId!}`)).toHaveText('answered');

    await page.getByTestId(`assumption-open-${threadId!}`).click();
    await page
      .getByTestId(`assumption-text-${threadId!}`)
      .fill('A batch without a matching CoA blocks receipt.');
    await page.getByTestId(`assumption-submit-${threadId!}`).click();

    // An assumption is a first-class record that survives into the frozen spec, so it is read back
    // from the assumptions endpoint rather than from whatever the thread happens to render.
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/whiteboards/${whiteboardId}/assumptions`);
        if (!response.ok()) return [];
        const body = (await response.json()) as { assumptions: { text: string }[] };
        return body.assumptions.map((assumption) => assumption.text);
      })
      .toContainEqual(expect.stringContaining('matching CoA'));
  });
});
