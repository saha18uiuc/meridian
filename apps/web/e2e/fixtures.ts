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

/**
 * The whole submit is retried, rather than clicked once.
 *
 * Playwright waits for an element to be *actionable*, and a server-rendered button is actionable
 * before React has attached its handler. A click that lands in that window submits the form
 * natively: the browser leaves for `/login?`, no sign-in is attempted, and the wait for `/boards`
 * times out somewhere that says nothing about the cause. The race is usually won on a warm dev
 * server and reliably lost by the first spec to compile the route, so it reads as a flake.
 *
 * Retrying is used instead of a hydration probe because there is nothing on this page to probe: its
 * inputs hold the same values before and after hydration, so no observable state distinguishes the
 * two. Whether the click was handled by React is only visible in whether it did anything.
 */
export async function signIn(
  page: Page,
  email: string = DEMO_EMAIL,
  password: string = DEMO_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  const refusal = page.getByTestId('login-error');

  for (let attempt = 1; ; attempt += 1) {
    // A native submit reloads the page, so every attempt refills the fields.
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);
    await page.getByTestId('login-submit').click();

    const landed = await page.waitForURL('**/boards', { timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (landed) return;

    // Wrong credentials are an answer, not a race to retry past.
    if (await refusal.isVisible()) {
      throw new Error(`sign-in was refused for ${email}: ${(await refusal.textContent()) ?? ''}`);
    }
    if (attempt === 5) {
      throw new Error(
        `the login form never handled a submit for ${email} after ${String(attempt)} attempts; ` +
          `the page is at ${page.url()}`,
      );
    }
  }
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

/**
 * The revision the toolbar is reporting, or nothing while it is reporting something else.
 *
 * Between an edit and its save the status reads "Unsaved changes" and then "Saving…", neither of
 * which carries a number. That is a normal moment to look, not a failure.
 */
async function shownRevision(page: Page): Promise<number | null> {
  const text = (await page.getByTestId('save-status').textContent()) ?? '';
  const match = /revision (\d+)/i.exec(text);
  return match === null ? null : Number.parseInt(match[1] as string, 10);
}

export async function currentRevision(page: Page): Promise<number> {
  const shown = await shownRevision(page);
  if (shown === null) throw new Error('the board is mid-save; there is no revision to read yet');
  return shown;
}

/**
 * Wait for an edit to land, without saying which number it lands on.
 *
 * Saves are debounced, so two quick edits can arrive as one delta and one revision. A spec that
 * names the number therefore encodes how fast the machine running it happens to be. What every
 * caller needs is "the write I triggered has been accepted", which is the revision having moved.
 *
 * The highest number seen is remembered rather than re-read at the end, because the next edit can
 * begin before the assertion returns and put the status back into a state with no number in it.
 */
export async function savedAbove(page: Page, previous: number): Promise<number> {
  let latest = previous;
  await expect
    .poll(async () => {
      const shown = await shownRevision(page);
      if (shown !== null && shown > latest) latest = shown;
      return latest;
    })
    .toBeGreaterThan(previous);
  return latest;
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
