import type { ExecutionEvent } from '@meridian/core/schemas';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventFeed } from '@/features/executions/EventFeed';

/**
 * The event feed.
 *
 * Execution events are append-only and their identity column only ever increases, which is what
 * lets the feed poll forward from the last event it showed. The two failures worth guarding are
 * the ones that make a live run's history untrustworthy: showing an event twice, and skipping one.
 * Both would come from the cursor, so every test here is really a test of the cursor.
 */

const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';

function event(eventId: number, overrides: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return {
    eventId,
    executionId: EXECUTION_ID,
    stepExecutionId: null,
    eventType: 'evidence',
    eventKey: `evidence-${String(eventId)}`,
    payloadJson: { note: `event ${String(eventId)}` },
    storagePath: null,
    idempotencyKey: null,
    createdAt: '2026-02-11T00:00:00.000Z',
    ...overrides,
  } as ExecutionEvent;
}

interface Page {
  events: ExecutionEvent[];
  nextCursor: number | null;
  artifactUrls: Record<string, string>;
}

/** Serves pages in order and records the cursor each request asked for. */
function server(pages: Page[], options: { status?: number } = {}) {
  const cursors: number[] = [];
  let index = 0;
  const fetchMock = vi.fn(async (url: string) => {
    cursors.push(Number(new URL(url, 'http://test').searchParams.get('afterEventId')));
    if (options.status !== undefined) {
      return { ok: false, status: options.status } as unknown as Response;
    }
    const page = pages[index] ?? { events: [], nextCursor: null, artifactUrls: {} };
    index = Math.min(index + 1, pages.length);
    return { ok: true, status: 200, json: async () => page } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { cursors, fetchMock };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the first load', () => {
  it('asks from the beginning and renders what came back', async () => {
    const { cursors } = server([{ events: [event(1), event(2)], nextCursor: 2, artifactUrls: {} }]);
    render(<EventFeed executionId={EXECUTION_ID} live={false} />);

    await waitFor(() => expect(screen.getAllByText(/^evidence-/)).toHaveLength(2));
    expect(cursors[0]).toBe(0);
  });

  it('says there is nothing yet rather than rendering an empty list', async () => {
    server([{ events: [], nextCursor: null, artifactUrls: {} }]);
    render(<EventFeed executionId={EXECUTION_ID} live={false} />);
    await waitFor(() => expect(screen.getByText(/no events yet/i)).toBeInTheDocument());
  });

  it('reports a failed request instead of showing a silently empty history', async () => {
    server([], { status: 500 });
    render(<EventFeed executionId={EXECUTION_ID} live={false} />);
    await waitFor(() => expect(screen.getByText('HTTP 500')).toBeInTheDocument());
  });
});

describe('polling a live run', () => {
  it('advances the cursor past what it already showed', async () => {
    const { cursors } = server([
      { events: [event(1), event(2)], nextCursor: 2, artifactUrls: {} },
      { events: [event(3)], nextCursor: 3, artifactUrls: {} },
    ]);
    render(<EventFeed executionId={EXECUTION_ID} live />);

    await waitFor(() => expect(screen.getAllByText(/^evidence-/)).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(2_000);

    await waitFor(() => expect(screen.getAllByText(/^evidence-/)).toHaveLength(3));
    // The second request starts after the highest event already rendered, which is what makes a
    // duplicate structurally impossible rather than merely unlikely.
    expect(cursors).toEqual([0, 2]);
  });

  it('keeps its place when a poll returns nothing new', async () => {
    const { cursors } = server([
      { events: [event(1)], nextCursor: 1, artifactUrls: {} },
      { events: [], nextCursor: 1, artifactUrls: {} },
      { events: [event(2)], nextCursor: 2, artifactUrls: {} },
    ]);
    render(<EventFeed executionId={EXECUTION_ID} live />);

    await waitFor(() => expect(screen.getAllByText(/^evidence-/)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await waitFor(() => expect(screen.getAllByText(/^evidence-/)).toHaveLength(2));
    // An empty page must not reset the cursor to zero and replay the whole history.
    expect(cursors).toEqual([0, 1, 1]);
  });

  it('does not poll a run that has finished', async () => {
    const { fetchMock } = server([{ events: [event(1)], nextCursor: 1, artifactUrls: {} }]);
    render(<EventFeed executionId={EXECUTION_ID} live={false} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('artifacts', () => {
  it('links an event to its signed URL, and only when one was issued', async () => {
    server([
      {
        events: [
          event(1, { storagePath: 'executions/1/mail.eml' }),
          event(2, { storagePath: 'executions/1/missing.pdf' }),
        ],
        nextCursor: 2,
        artifactUrls: { 'executions/1/mail.eml': 'https://signed.example/mail.eml' },
      },
    ]);
    render(<EventFeed executionId={EXECUTION_ID} live={false} />);

    await waitFor(() => expect(screen.getAllByText(/^evidence-/)).toHaveLength(2));
    const links = screen.getAllByRole('link', { name: 'artifact' });
    // The second event has a storage path but no URL, so it renders no link rather than a broken
    // one. Storage is private, and a URL nobody signed would 403 on click.
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://signed.example/mail.eml');
  });
});

describe('event identity', () => {
  it('shows each event’s type and key so an action can be found by name', async () => {
    server([
      {
        events: [
          event(1, { eventType: 'action', eventKey: 'send-email:MSKU1234565' }),
          event(2, { eventType: 'state_transition', eventKey: null }),
        ],
        nextCursor: 2,
        artifactUrls: {},
      },
    ]);
    render(<EventFeed executionId={EXECUTION_ID} live={false} />);

    await waitFor(() => expect(screen.getByText('send-email:MSKU1234565')).toBeInTheDocument());
    expect(screen.getByText('action')).toBeInTheDocument();
    expect(screen.getByText('state_transition')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
