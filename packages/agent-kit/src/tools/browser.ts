import type { BrowserTool } from '../contracts.js';
import { DomainNotAllowedError } from '../errors.js';

export type { BrowserTool };

/**
 * The allow-list is matched on the registrable host, including subdomains, and only over http(s).
 * Anything else — a `file:` URL, an IP literal, a look-alike host that merely ends with an allowed
 * string — is refused, because the browser tool is the one place an agent could otherwise reach
 * arbitrary parts of the network.
 */
export function assertDomainAllowed(url: string, allowList: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DomainNotAllowedError(url, allowList);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DomainNotAllowedError(url, allowList);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = allowList.some(
    (entry) => host === entry.toLowerCase() || host.endsWith(`.${entry.toLowerCase()}`),
  );
  if (!allowed) throw new DomainNotAllowedError(url, allowList);
}

export function parseAllowList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}
