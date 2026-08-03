import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DomainNotAllowedError } from '../src/errors.js';
import { assertDomainAllowed, parseAllowList } from '../src/tools/browser.js';
import { createMockBrowser } from '../src/tools/mock/browser.js';

const ALLOW = ['portal.example', 'docs.carrier.example'];

describe('assertDomainAllowed', () => {
  it('accepts an exact host and a subdomain of an allowed host', () => {
    expect(() => assertDomainAllowed('https://portal.example/x', ALLOW)).not.toThrow();
    expect(() => assertDomainAllowed('https://eu.portal.example/x', ALLOW)).not.toThrow();
  });

  it('rejects a look-alike host that merely ends with the allowed string', () => {
    expect(() => assertDomainAllowed('https://evilportal.example/x', ALLOW)).toThrow(
      DomainNotAllowedError,
    );
    expect(() => assertDomainAllowed('https://portal.example.attacker.test/', ALLOW)).toThrow(
      DomainNotAllowedError,
    );
  });

  it('rejects non-http schemes, including file URLs', () => {
    expect(() => assertDomainAllowed('file:///etc/passwd', ALLOW)).toThrow(DomainNotAllowedError);
    expect(() => assertDomainAllowed('ftp://portal.example/x', ALLOW)).toThrow(
      DomainNotAllowedError,
    );
  });

  it('rejects an unparseable URL rather than passing it through', () => {
    expect(() => assertDomainAllowed('not a url', ALLOW)).toThrow(DomainNotAllowedError);
  });

  it('rejects everything when the allow-list is empty', () => {
    expect(() => assertDomainAllowed('https://portal.example/', [])).toThrow(DomainNotAllowedError);
  });

  it('is case-insensitive on the host', () => {
    expect(() => assertDomainAllowed('https://PORTAL.example/x', ALLOW)).not.toThrow();
  });
});

describe('parseAllowList', () => {
  it('splits, trims, lower-cases, and drops empties', () => {
    expect(parseAllowList(' A.test , b.test ,,')).toEqual(['a.test', 'b.test']);
    expect(parseAllowList(undefined)).toEqual([]);
    expect(parseAllowList('')).toEqual([]);
  });
});

describe('mock browser', () => {
  it('enforces the same allow-list as the live adapter', async () => {
    const browser = createMockBrowser({ allowList: ALLOW });
    await expect(browser.open('https://evil.test/')).rejects.toThrow(DomainNotAllowedError);
    await expect(browser.open('https://portal.example/')).resolves.toMatchObject({
      title: 'mock page',
    });
  });
});

describe('which browser the factory hands out', () => {
  const factorySource = readFileSync(
    fileURLToPath(new URL('../src/tools/factory.ts', import.meta.url)),
    'utf8',
  );
  const code = factorySource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('uses the mock only on the mock path', () => {
    // A live run whose browser is the mock is the worst kind of wrong: it succeeds, records a page
    // title, and the evidence it writes describes a page nobody visited. The two branches are read
    // here directly, because the failure has no runtime symptom to assert against.
    const live = code.slice(code.indexOf('function createLiveTools'));
    expect(live).toContain('createLiveBrowser(options)');
    expect(live).not.toContain('createMockBrowser');
  });

  it('launches Chromium lazily, so a run that never navigates never starts one', () => {
    // The import sits inside `build()`, which `lazy()` calls on first use. Hoisting it to the top of
    // the module would pay a Chromium launch on every live execution, nearly all of which never
    // touch a browser at all.
    expect(code).not.toMatch(/^import .*from 'playwright'/m);
    expect(code).toContain("import('playwright')");
  });
});
