'use client';

import type { ExecutionEvent } from '@meridian/core/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';

interface EventPage {
  events: ExecutionEvent[];
  nextCursor: number | null;
  artifactUrls: Record<string, string>;
}

/**
 * Polls forward from the highest `event_id` already shown. Because events are append-only and the
 * cursor is the identity column, this can never re-render an event twice or skip one.
 */
export function EventFeed({ executionId, live }: { executionId: string; live: boolean }) {
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef(0);

  const poll = useCallback(async (): Promise<void> => {
    const response = await fetch(
      `/api/executions/${executionId}/events?afterEventId=${cursorRef.current}&limit=200`,
    );
    if (!response.ok) {
      setError(`HTTP ${response.status}`);
      return;
    }
    const page = (await response.json()) as EventPage;
    if (page.events.length === 0) return;
    cursorRef.current = page.events[page.events.length - 1]?.eventId ?? cursorRef.current;
    setEvents((previous) => [...previous, ...page.events]);
    setUrls((previous) => ({ ...previous, ...page.artifactUrls }));
  }, [executionId]);

  useEffect(() => {
    void poll();
    if (!live) return;
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, [poll, live]);

  return (
    <div className="stack" data-testid="event-feed">
      {error === null ? null : <p className="banner error">{error}</p>}
      {events.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <ol className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {events.map((event) => (
            <li key={event.eventId} className="panel stack" style={{ gap: 4 }}>
              <div className="row">
                <span className="badge">{event.eventType}</span>
                <code>{event.eventKey ?? '—'}</code>
                <span className="muted">{new Date(event.createdAt).toLocaleTimeString()}</span>
                {event.storagePath !== null && urls[event.storagePath] !== undefined ? (
                  <a href={urls[event.storagePath]} target="_blank" rel="noreferrer">
                    artifact
                  </a>
                ) : null}
              </div>
              <pre>{JSON.stringify(event.payloadJson, null, 2)}</pre>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
