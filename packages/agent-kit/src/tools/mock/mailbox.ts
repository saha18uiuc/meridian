import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AttachmentRef,
  MailboxTool,
  MailMessage,
  OutboundMail,
  SentMail,
} from '../../contracts.js';
import { ToolUnavailableError } from '../../errors.js';
import { withMarker } from '../mailbox.js';

/**
 * A mailbox backed by `.eml` fixtures.
 *
 * It reads the clock never and randomizes nothing: message IDs come from the file name, draft and
 * send IDs come from a per-instance counter, and the outbox is returned in insertion order. Two
 * runs over the same fixtures therefore produce byte-identical outboxes, which is what makes the
 * eval suite meaningful as a regression signal rather than a coin flip.
 */

export interface MockMailbox extends MailboxTool {
  outbox(): readonly SentOutboundMail[];
  drafts(): readonly (OutboundMail & { draftId: string })[];
  reset(): void;
}

export interface SentOutboundMail extends OutboundMail {
  providerMessageId: string;
  threadId: string;
}

interface ParsedEml {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  bodyText: string;
  attachments: string[];
}

/**
 * A deliberately small header parser. The fixtures are hand-written and use a fixed set of
 * headers, so a full MIME implementation would add dependencies and failure modes without adding
 * any coverage of the behaviour under test.
 */
export function parseEml(raw: string, fallbackId: string): ParsedEml {
  const normalized = raw.replace(/\r\n/g, '\n');
  const separator = normalized.indexOf('\n\n');
  const headerBlock = separator === -1 ? normalized : normalized.slice(0, separator);
  const body = separator === -1 ? '' : normalized.slice(separator + 2);

  const headers = new Map<string, string>();
  let currentKey: string | null = null;
  for (const line of headerBlock.split('\n')) {
    if (/^\s/.test(line) && currentKey !== null) {
      headers.set(currentKey, `${headers.get(currentKey) ?? ''} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    currentKey = line.slice(0, colon).trim().toLowerCase();
    headers.set(currentKey, line.slice(colon + 1).trim());
  }

  const attachments = (headers.get('x-meridian-attachments') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  return {
    messageId: headers.get('message-id') ?? fallbackId,
    threadId: headers.get('x-meridian-thread') ?? headers.get('message-id') ?? fallbackId,
    subject: headers.get('subject') ?? '',
    from: headers.get('from') ?? '',
    to: (headers.get('to') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
    receivedAt: headers.get('date') ?? '1970-01-01T00:00:00.000Z',
    bodyText: body.trim(),
    attachments,
  };
}

function toMailMessage(parsed: ParsedEml, attachmentDir: string): MailMessage {
  return {
    messageId: parsed.messageId,
    threadId: parsed.threadId,
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    receivedAt: parsed.receivedAt,
    bodyText: parsed.bodyText,
    attachments: parsed.attachments.map<AttachmentRef>((filename) => ({
      attachmentId: `${parsed.messageId}:${filename}`,
      filename,
      mimeType: filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      sizeBytes: 0,
      storagePath: join(attachmentDir, filename),
    })),
  };
}

export function createMockMailbox(options: {
  emailDir: string;
  attachmentDir: string;
  /**
   * Restrict the visible inbox to these provider message IDs. An eval case declares the messages
   * it is about, and a case that could see a neighbouring fixture would pass or fail for a reason
   * its author never wrote down.
   */
  only?: readonly string[];
}): MockMailbox {
  const files = readdirSync(options.emailDir)
    .filter((name) => name.endsWith('.eml'))
    .sort();
  const visible = options.only === undefined ? null : new Set(options.only);
  const messages = files
    .map((name) =>
      toMailMessage(
        parseEml(readFileSync(join(options.emailDir, name), 'utf8'), name),
        options.attachmentDir,
      ),
    )
    .filter((message) => visible === null || visible.has(message.messageId))
    // Oldest first, which is the order Gmail returns a thread in and the order the receiving policy
    // depends on: "has this invoice already been received?" is a question about arrival, so a
    // mailbox that handed messages back in filename order would let an alphabetical accident decide
    // which of two conflicting invoices the shipment is taken to hold. The message ID breaks ties so
    // two messages stamped with the same second still enumerate identically on every run.
    .sort(
      (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId),
    );

  let counter = 0;
  const sent: SentOutboundMail[] = [];
  const drafts: (OutboundMail & { draftId: string })[] = [];

  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}-${String(counter).padStart(4, '0')}`;
  }

  return {
    async searchMessages(query, maxResults = 25) {
      const needle = query.toLowerCase();
      // The mock supports substring matching only; a Gmail query language emulation would give a
      // false sense of parity with the live adapter.
      return messages
        .filter(
          (message) =>
            needle === '' ||
            message.subject.toLowerCase().includes(needle) ||
            message.bodyText.toLowerCase().includes(needle),
        )
        .slice(0, maxResults);
    },

    async fetchThread(threadId) {
      return messages.filter((message) => message.threadId === threadId);
    },

    async downloadAttachments(threadId) {
      return messages
        .filter((message) => message.threadId === threadId)
        .flatMap((message) => message.attachments);
    },

    async createDraft(payload) {
      const draftId = nextId('draft');
      drafts.push({ ...withMarker(payload), draftId });
      return { draftId };
    },

    async sendDraft(draftId) {
      const draft = drafts.find((candidate) => candidate.draftId === draftId);
      if (draft === undefined)
        throw new ToolUnavailableError('mailbox', `unknown draft ${draftId}`);
      const result: SentMail = {
        providerMessageId: nextId('sent'),
        threadId: draft.threadId ?? nextId('thread'),
      };
      sent.push({ ...draft, ...result });
      return result;
    },

    async sendMessage(payload) {
      const marked = withMarker(payload);
      const result: SentMail = {
        providerMessageId: nextId('sent'),
        threadId: marked.threadId ?? nextId('thread'),
      };
      sent.push({ ...marked, ...result });
      return result;
    },

    outbox: () => sent,
    drafts: () => drafts,
    reset: () => {
      counter = 0;
      sent.length = 0;
      drafts.length = 0;
    },
  };
}
