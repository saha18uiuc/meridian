import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Component tests render client components in jsdom. Three things they always need: the DOM torn
 * down between cases, `next/navigation`, which throws outside an App Router tree, and the two
 * layout APIs jsdom does not implement.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * React Flow measures its own container on mount, and jsdom has no layout engine and therefore no
 * `ResizeObserver`. The stub reports nothing rather than faking a size: the tests that mount a flow
 * assert on graph coordinates, which are the numbers we compute ourselves and are independent of
 * how large the pane happens to be. A stub that invented a viewport would make them pass for a
 * reason that has nothing to do with the code under test.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {
      // No layout in jsdom, so there is never anything to report.
    }
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (!('DOMMatrixReadOnly' in globalThis)) {
  // React Flow reads the pane's CSS transform to convert between screen and graph space.
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1;
    constructor(_transform?: string) {}
  } as unknown as typeof DOMMatrixReadOnly;
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
