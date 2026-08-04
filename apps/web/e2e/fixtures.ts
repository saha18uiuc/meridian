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

/** Create a board through the form on `/boards` and land on it, returning its ID. */
export async function createBoard(page: Page, title: string): Promise<string> {
  await page.goto('/boards');
  await page.getByTestId('new-board-title').fill(title);
  await page.getByTestId('new-board-submit').click();
  await page.waitForURL(/\/boards\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('canvas')).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').pop();
  if (id === undefined) throw new Error(`could not read a board id from ${page.url()}`);
  return id;
}

/**
 * Draw an arrow between two cards the way a person does, by dragging between their handles.
 *
 * The selectors are CSS rather than test ids because React Flow owns the handle elements; the
 * classes are the ones `CardFrame` puts on them.
 */
export async function connectHandles(page: Page, source: string, target: string): Promise<void> {
  const from = await page.locator(source).first().boundingBox();
  const to = await page.locator(target).first().boundingBox();
  if (from === null || to === null) throw new Error('a connection handle had no box to aim at');

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // React Flow begins a connection on the first move and only then starts looking for a valid
  // target, so a single jump from source to target can land before the connection line exists.
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
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

/**
 * Wait until the toolbar reports a given revision.
 *
 * Every editing control writes asynchronously, so reading the board straight after a `blur()` races
 * the request the blur only started. The toolbar reads `Revision N` when idle and `Saved · revision
 * N` just after a write, so the number is matched and the wording is not — waiting for the word
 * "saved" alone can be satisfied by the canvas persisting its viewport, which changes no revision.
 */
export async function expectRevision(page: Page, revisionNo: number): Promise<void> {
  await expect(page.getByTestId('save-status')).toHaveText(
    new RegExp(`revision ${String(revisionNo)}\\b`, 'i'),
  );
}

/** Read a board through the API using the browser's own session, so RLS applies exactly as it does to the UI. */
export async function readBoard(
  page: Page,
  whiteboardId: string,
): Promise<{ revisionNo: number; status: string; lastReviewedRevisionNo: number | null }> {
  const response = await page.request.get(`/api/whiteboards/${whiteboardId}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    metadata: { revisionNo: number; status: string };
  };

  // The review marker is a property of the board's review history rather than of the graph, so it
  // is published by the list endpoint and not by the snapshot the canvas loads. The board page
  // reads it the same way; asking the snapshot for it would assert a field the API never sends.
  const list = await page.request.get('/api/whiteboards');
  expect(list.ok()).toBe(true);
  const { boards } = (await list.json()) as {
    boards: { whiteboardId: string; lastReviewedRevisionNo: number | null }[];
  };
  const entry = boards.find((board) => board.whiteboardId === whiteboardId);

  return { ...body.metadata, lastReviewedRevisionNo: entry?.lastReviewedRevisionNo ?? null };
}
