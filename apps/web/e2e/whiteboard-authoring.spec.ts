import { expect, test, type Page } from '@playwright/test';
import {
  connectHandles,
  createBoard,
  currentRevision,
  readBoard,
  savedAbove,
  signIn,
} from './fixtures';

/**
 * Authoring a process from nothing, which is the first thing anyone tries and was untested.
 *
 * The existing specs all start from the seeded board and edit it. Nothing covered creating a board,
 * dropping a card onto the canvas, drawing an arrow between two cards, or deleting either — the
 * whole set of actions the product is named after.
 *
 * These also cover the controls added in this phase, because a control that exists and is not
 * wired to the store is indistinguishable, from the outside, from one that is.
 */

/** Cards are addressed by the kind they are, which is unambiguous on these two-card boards. */
async function connect(page: Page, sourceKind: string, targetKind: string): Promise<void> {
  await connectHandles(
    page,
    `.card-${sourceKind} .card-handle-out`,
    `.card-${targetKind} .card-handle-in`,
  );
}

/** Drag a card by its header, which is the part of it that is not a control. */
async function dragCard(page: Page, kind: string, by: { x: number; y: number }): Promise<void> {
  const header = page.locator(`.card-${kind} .card-title`).first();
  const box = await header.boundingBox();
  if (box === null) throw new Error(`no ${kind} card to drag`);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 12 });
  await page.mouse.up();
}

test.describe('authoring a board from nothing', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a new board starts empty and says what to do about it', async ({ page }) => {
    const whiteboardId = await createBoard(page, `Blank board ${String(Date.now())}`);

    // A board is created at revision 1 and has never been edited, so nothing has moved it.
    const board = await readBoard(page, whiteboardId);
    expect(board.revisionNo).toBe(1);
    expect(board.lastReviewedRevisionNo).toBeNull();
    await expect(page.getByTestId('canvas').locator('.card')).toHaveCount(0);
    await expect(page.getByTestId('board-specs-empty')).toBeVisible();
    await expect(page.getByTestId('assumptions-empty')).toBeVisible();
  });

  test('the palette names what a card is for, not what its type is called', async ({ page }) => {
    await createBoard(page, `Palette ${String(Date.now())}`);

    // The brief's test is that a primitive can be explained to a non-engineer in one sentence.
    await expect(page.getByTestId('add-input')).toContainText('Something arrives');
    await expect(page.getByTestId('add-rule')).toContainText('Decide or wait');
    await expect(page.getByTestId('add-input')).toHaveAttribute(
      'title',
      /something that arrives from outside/i,
    );
  });

  test('adding cards, connecting them, and deleting both', async ({ page }) => {
    const whiteboardId = await createBoard(page, `Authoring ${String(Date.now())}`);
    let revision = await currentRevision(page);

    await page.getByTestId('add-input').click();
    await expect(page.getByTestId('primitive-sentence')).toContainText(/something that arrives/i);
    revision = await savedAbove(page, revision);

    await page.getByTestId('add-outcome').click();
    revision = await savedAbove(page, revision);
    await expect(page.getByTestId('canvas').locator('.card')).toHaveCount(2);

    // Clicking the palette lays cards out in a row, close enough together that the arrow between
    // them would run underneath one of them. Moving a card is an ordinary thing to do and it puts
    // the connection somewhere a person could point at.
    await dragCard(page, 'outcome', { x: 40, y: 300 });
    revision = await savedAbove(page, revision);

    await connect(page, 'input', 'outcome');
    revision = await savedAbove(page, revision);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    // The connection is a real row, not a line drawn on a canvas.
    const withEdge = await page.request.get(`/api/whiteboards/${whiteboardId}`);
    const graph = (await withEdge.json()) as { edges: unknown[]; nodes: unknown[] };
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes).toHaveLength(2);

    await page.locator('.react-flow__edge').first().click();
    await expect(page.getByTestId('edge-endpoints')).toBeVisible();
    await page.getByTestId('edge-delete').click();
    revision = await savedAbove(page, revision);
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);

    await page.getByTestId('canvas').locator('.card').first().click();
    await page.getByTestId('node-delete').click();
    await savedAbove(page, revision);
    await expect(page.getByTestId('canvas').locator('.card')).toHaveCount(1);
  });

  test('a rule points at a card by name, never by identifier', async ({ page }) => {
    await createBoard(page, `Pickers ${String(Date.now())}`);
    let revision = await currentRevision(page);

    await page.getByTestId('add-outcome').click();
    await page.getByTestId('node-title').fill('Held for paperwork');
    await page.getByTestId('node-title').blur();
    revision = await savedAbove(page, revision);

    await page.getByTestId('add-rule').click();
    revision = await savedAbove(page, revision);

    // The fallback used to be unreachable: the field is compiled into `policies.exceptions` and the
    // interface offered no way to set it.
    const fallback = page.getByTestId('rule-fallback');
    await expect(fallback).toContainText('Held for paperwork');
    await fallback.selectOption({ label: 'Held for paperwork (Outcome)' });
    await savedAbove(page, revision);

    await page.getByTestId('rule-branches-add').click();
    await page.getByTestId('rule-branch-target-0').selectOption({
      label: 'Held for paperwork (Outcome)',
    });
    await expect(page.getByTestId('inspector-validation')).toHaveText('Card data is valid.');
  });

  test('an input field can be optional and can say what it is', async ({ page }) => {
    await createBoard(page, `Fields ${String(Date.now())}`);
    const revision = await currentRevision(page);
    await page.getByTestId('add-input').click();
    await savedAbove(page, revision);

    await page.getByTestId('input-fields-add').click();
    await page.getByTestId('input-field-description-0').fill('FDA establishment registration.');
    await page.getByTestId('input-field-required-0').uncheck();
    await page.getByTestId('input-field-description-0').blur();

    await expect(page.getByTestId('inspector-validation')).toHaveText('Card data is valid.');
    await expect(page.getByTestId('input-field-required-0')).not.toBeChecked();

    // The node-level `required` flag is gone: it was read by nothing and contradicted by the graph.
    await expect(page.getByTestId('input-required')).toHaveCount(0);
  });

  test('the connection between a rule and its arrows is shown, and disagreement is called out', async ({
    page,
  }) => {
    await createBoard(page, `Branches ${String(Date.now())}`);
    let revision = await currentRevision(page);
    await page.getByTestId('add-rule').click();
    await page.getByTestId('add-outcome').click();
    revision = await savedAbove(page, revision);
    await expect(page.getByTestId('canvas').locator('.card')).toHaveCount(2);

    await connect(page, 'rule', 'outcome');
    revision = await savedAbove(page, revision);

    await page.locator('.react-flow__edge').first().click();
    await page.getByTestId('edge-label').fill('documents complete');
    await page.getByTestId('edge-label').blur();
    await savedAbove(page, revision);

    await page.getByTestId('canvas').locator('[data-primitive="rule"]').first().click();
    await page.getByTestId('rule-branches-add').click();
    // The default branch label is "new branch"; the arrow says "documents complete".
    await expect(page.getByTestId('branch-edge-divergence')).toContainText('new branch');

    await page.getByLabel('Branch 1 label').fill('documents complete');
    await page.getByLabel('Branch 1 label').blur();
    await expect(page.getByTestId('branch-edge-divergence')).toHaveCount(0);
  });

  test('a connection offers no JSON to write', async ({ page }) => {
    await createBoard(page, `Conditions ${String(Date.now())}`);
    const revision = await currentRevision(page);
    await page.getByTestId('add-rule').click();
    await page.getByTestId('add-outcome').click();
    await expect(page.getByTestId('canvas').locator('.card')).toHaveCount(2);
    await connect(page, 'rule', 'outcome');
    await savedAbove(page, revision);

    await page.locator('.react-flow__edge').first().click();
    await expect(page.getByTestId('edge-condition')).toHaveCount(0);
    await expect(page.getByTestId('edge-condition-empty')).toBeVisible();
  });
});
