import type { AttachmentRef, MailMessage, OutboundMail } from '@meridian/agent-kit/contracts';
import { withFailureMapping } from './failures.js';
import { type ActivityEnvelope, toolsFor } from './runtime.js';

export async function mailSearchMessages(
  envelope: ActivityEnvelope,
  query: string,
  maxResults?: number,
): Promise<MailMessage[]> {
  return withFailureMapping(async () =>
    toolsFor(envelope).mailbox.searchMessages(query, maxResults),
  );
}

export async function mailFetchThread(
  envelope: ActivityEnvelope,
  threadId: string,
): Promise<MailMessage[]> {
  return withFailureMapping(async () => toolsFor(envelope).mailbox.fetchThread(threadId));
}

export async function mailDownloadAttachments(
  envelope: ActivityEnvelope,
  threadId: string,
): Promise<AttachmentRef[]> {
  return withFailureMapping(async () => toolsFor(envelope).mailbox.downloadAttachments(threadId));
}

/**
 * Reads are plain activities. Sends are deliberately absent from this file: every outbound message
 * must go through the reserve/dispatch/complete protocol in `actions.ts`, because a bare
 * `sendMessage` activity would be retried by Temporal and could deliver twice.
 */
export async function mailCreateDraft(
  envelope: ActivityEnvelope,
  payload: OutboundMail,
): Promise<{ draftId: string }> {
  return withFailureMapping(async () => toolsFor(envelope).mailbox.createDraft(payload));
}
