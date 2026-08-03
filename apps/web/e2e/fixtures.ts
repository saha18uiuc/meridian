import { expect, type Page } from '@playwright/test';

/**
 * Shared sign-in and navigation for the end-to-end specs.
 *
 * The credentials come from the environment with the same defaults `pnpm seed` uses, so a developer
 * who changed `DEMO_USER_PASSWORD` in `.env` does not get a mystifying "Invalid login credentials"
 * from Playwright.
 */

export const DEMO_EMAIL = process.env.DEMO_USER_EMAIL ?? 'demo@meridian.local';
export const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? 'meridian-demo-password';
export const OTHER_EMAIL = process.env.DEMO_OTHER_EMAIL ?? 'other@meridian.local';
export const OTHER_PASSWORD = process.env.DEMO_OTHER_PASSWORD ?? 'meridian-other-password';

export const SEEDED_BOARD_TITLE = 'Inbound Import Receiving';

export async function signIn(
  page: Page,
  email: string = DEMO_EMAIL,
  password: string = DEMO_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/boards');
}

/** Open the seeded board and return its ID, which the specs use for direct API assertions. */
export async function openSeededBoard(page: Page): Promise<string> {
  await page.goto('/boards');
  await expect(page.getByTestId('boards-table')).toBeVisible();
  await page.getByRole('link', { name: SEEDED_BOARD_TITLE }).first().click();
  await page.waitForURL(/\/boards\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('canvas')).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').pop();
  if (id === undefined) throw new Error(`could not read a board id from ${page.url()}`);
  return id;
}

/** Read a board through the API using the browser's own session, so RLS applies exactly as it does to the UI. */
export async function readBoard(
  page: Page,
  whiteboardId: string,
): Promise<{ revisionNo: number; status: string; lastReviewedRevisionNo: number | null }> {
  const response = await page.request.get(`/api/whiteboards/${whiteboardId}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    metadata: { revisionNo: number; status: string; lastReviewedRevisionNo: number | null };
  };
  return body.metadata;
}
