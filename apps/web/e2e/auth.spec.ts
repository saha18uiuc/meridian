import { expect, test } from '@playwright/test';
import {
  OTHER_EMAIL,
  OTHER_PASSWORD,
  SEEDED_BOARD_TITLE,
  openSeededBoard,
  signIn,
} from './fixtures';

/**
 * Sign-in, and the boundary that sign-in establishes.
 *
 * The ownership assertion expects a 404 rather than a 403. A board you do not own does not exist as
 * far as you are concerned; a 403 would confirm that the identifier is real, which is a small
 * disclosure that costs nothing to avoid.
 */

test.describe('authentication', () => {
  test('an anonymous visitor is sent to the login page', async ({ page }) => {
    await page.goto('/boards');
    await page.waitForURL(/\/login/);
    await expect(page.getByTestId('login-submit')).toBeVisible();
  });

  test('signing in lands on the board list with the seeded board', async ({ page }) => {
    await signIn(page);
    const table = page.getByTestId('boards-table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('link', { name: SEEDED_BOARD_TITLE })).toBeVisible();
    // A board nobody has reviewed says so, rather than showing a blank or an optimistic "ready".
    await expect(table.getByTestId('review-status').first()).toHaveAttribute(
      'data-freshness',
      'never',
    );
  });

  test("a second user cannot read another user's board", async ({ page }) => {
    await signIn(page);
    const whiteboardId = await openSeededBoard(page);

    await page.context().clearCookies();
    await signIn(page, OTHER_EMAIL, OTHER_PASSWORD);

    const response = await page.request.get(`/api/whiteboards/${whiteboardId}`);
    expect(response.status()).toBe(404);
  });
});
