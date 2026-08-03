import type { BrowserTool } from '../../contracts.js';
import { assertDomainAllowed } from '../browser.js';

/**
 * The mock browser still enforces the allow-list. A mock that skipped the check would let an
 * agent's disallowed navigation pass every eval and only fail in production, which is the opposite
 * of what a mock is for.
 */
export function createMockBrowser(options: {
  allowList: readonly string[];
  pages?: Record<string, { title: string; text: string }>;
}): BrowserTool {
  const pages = options.pages ?? {};
  let current: string | null = null;

  return {
    async open(url) {
      assertDomainAllowed(url, options.allowList);
      current = url;
      return { url, title: pages[url]?.title ?? 'mock page' };
    },
    async extractText() {
      return current === null ? '' : (pages[current]?.text ?? '');
    },
    async download(url) {
      assertDomainAllowed(url, options.allowList);
      return {
        attachmentId: `mock:${url}`,
        filename: url.split('/').pop() ?? 'download',
        mimeType: 'application/octet-stream',
        sizeBytes: 0,
        storagePath: null,
      };
    },
    async screenshot() {
      return { storagePath: 'screenshots/mock/screenshot.png' };
    },
  };
}
