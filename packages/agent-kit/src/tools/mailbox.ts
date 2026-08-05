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

/**
 * One mailbox for reading, another for sending.
 *
 * The two halves of a mailbox answer different questions, and a demo wants different answers to
 * each. Reading has to be reproducible — the fixture corpus is what makes a run mean the same thing
 * every time, and what the eval suite asserts against — while sending is the only part an observer
 * can verify from outside the system, and a recorded payload that never left the process is a
 * weaker claim than an email in an inbox.
 *
 * The outbound thread id is dropped, and that is a correction rather than a convenience. A fixture
 * thread id names a conversation that exists only in `examples/`; handing it to Gmail as a reply
 * target asks the provider to append to a thread it has never seen, which fails at the provider
 * rather than here. Sent standalone, the message keeps its subject and its marker footer, so
 * reconciliation still finds it.
 */
export function composeMailbox(read: MailboxTool, send: MailboxTool): MailboxTool {
  return {
    searchMessages: (query, maxResults) => read.searchMessages(query, maxResults),
    fetchThread: (threadId) => read.fetchThread(threadId),
    downloadAttachments: (threadId) => read.downloadAttachments(threadId),
    createDraft: (payload) => send.createDraft(detachFromThread(payload)),
    sendDraft: (draftId) => send.sendDraft(draftId),
    sendMessage: (payload) => send.sendMessage(detachFromThread(payload)),
  };
}

function detachFromThread(payload: OutboundMail): OutboundMail {
  if (payload.threadId === undefined) return payload;
  const { threadId: _dropped, ...rest } = payload;
  return rest;
}
