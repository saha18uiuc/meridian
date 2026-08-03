import type { Browser, Page } from 'playwright';
import type { AttachmentRef, BrowserTool } from '../../contracts.js';
import { CapabilityDeniedError, ToolUnavailableError } from '../../errors.js';
import type { ArtifactStore } from '../../storage.js';
import { assertDomainAllowed } from '../browser.js';

export interface PlaywrightBrowserOptions {
  allowList: readonly string[];
  writeEnabled: boolean;
  capabilities: readonly string[];
  store: ArtifactStore;
  screenshotBucket: string;
  executionId: string;
}

/**
 * Read-only Chromium behind a domain allow-list.
 *
 * Writing requires two independent grants — the frozen spec's `browser.write` capability *and*
 * `BROWSER_WRITE_ENABLED` — because either one alone is too easy to acquire by accident: a
 * capability can slip through review, and an environment flag can be copied from a colleague's
 * `.env`. Requiring both means an unintended form submission needs two separate mistakes.
 */
export function createPlaywrightBrowser(
  browser: Browser,
  options: PlaywrightBrowserOptions,
): BrowserTool & { click(selector: string): Promise<void>; close(): Promise<void> } {
  let page: Page | null = null;
  let screenshotIndex = 0;

  function currentPage(): Page {
    if (page === null) throw new ToolUnavailableError('browser', 'no page is open');
    return page;
  }

  function assertWriteAllowed(): void {
    if (!options.capabilities.includes('browser.write') || !options.writeEnabled) {
      throw new CapabilityDeniedError('browser.write', options.capabilities);
    }
  }

  return {
    async open(url) {
      assertDomainAllowed(url, options.allowList);
      page ??= await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return { url: page.url(), title: await page.title() };
    },

    async extractText(selector) {
      const active = currentPage();
      if (selector === undefined) return (await active.textContent('body')) ?? '';
      return (await active.textContent(selector)) ?? '';
    },

    async download(url): Promise<AttachmentRef> {
      assertDomainAllowed(url, options.allowList);
      const active = currentPage();
      const response = await active.request.get(url);
      const body = await response.body();
      const filename = url.split('/').pop() ?? 'download';
      const path = `${options.screenshotBucket}/${options.executionId}/downloads/${filename}`;
      await options.store.put(
        path,
        body,
        response.headers()['content-type'] ?? 'application/octet-stream',
      );
      return {
        attachmentId: path,
        filename,
        mimeType: response.headers()['content-type'] ?? 'application/octet-stream',
        sizeBytes: body.byteLength,
        storagePath: path,
      };
    },

    async screenshot() {
      const active = currentPage();
      screenshotIndex += 1;
      const buffer = await active.screenshot({ fullPage: true });
      const path = `${options.screenshotBucket}/${options.executionId}/shot-${String(screenshotIndex).padStart(3, '0')}.png`;
      await options.store.put(path, buffer, 'image/png');
      return { storagePath: path };
    },

    async click(selector) {
      assertWriteAllowed();
      await currentPage().click(selector);
    },

    async close() {
      if (page !== null) await page.close();
      page = null;
    },
  };
}
