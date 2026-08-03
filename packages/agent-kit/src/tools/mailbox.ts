import type { MailboxTool, OutboundMail } from '../contracts.js';

export type { MailboxTool };

/** The footer Gmail replaces a missing idempotency header with. */
export const MARKER_PREFIX = '[meridian-ref:';

export function markerFooter(markerToken: string): string {
  return `${MARKER_PREFIX} ${markerToken}]`;
}

/**
 * Gmail's send endpoint accepts no client-supplied idempotency token, so the marker travels in the
 * body. It is the only handle a later reconciliation query has for asking "did this actually go
 * out?", which is why every outbound message carries one and why appending it is centralised here
 * rather than left to each adapter.
 */
export function withMarker(payload: OutboundMail): OutboundMail {
  if (payload.markerToken === undefined) return payload;
  const footer = markerFooter(payload.markerToken);
  if (payload.body.includes(footer)) return payload;
  return { ...payload, body: `${payload.body}\n\n${footer}` };
}

export function reconciliationQuery(markerToken: string): string {
  return `in:sent "${markerToken}" newer_than:1d`;
}

export const RECONCILIATION_MAX_RESULTS = 25;
