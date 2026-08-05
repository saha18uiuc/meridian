import type { AttachmentRef, MailboxTool, MailMessage, SentMail } from '../../contracts.js';
import { ExternalActionError, NonRetryableToolError, ToolUnavailableError } from '../../errors.js';
import type { ArtifactStore } from '../../storage.js';
import { withMarker } from '../mailbox.js';

/**
 * Live Gmail over Composio.
 *
 * Two independent switches guard every outbound message, and both are checked **before** the SDK
 * is touched: sending must be authorised (`liveMode`, which the factory derives from
 * `GMAIL_LIVE_MODE` or `GMAIL_SEND_LIVE`), and the recipient must appear in
 * `GMAIL_ALLOWED_RECIPIENTS`. The ordering is the point — a misconfigured demo should fail with a
 * clear local error, not with a real email in a stranger's inbox.
 */

export interface ComposioMailboxOptions {
  apiKey: string;
  userId: string;
  connectedAccountId: string;
  /** Resolved concrete version; the literal `latest` is rejected upstream (A29). */
  toolkitVersion: string;
  liveMode: boolean;
  allowedRecipients: readonly string[];
  maxResults: number;
  store: ArtifactStore;
  attachmentBucket: string;
  executionId: string;
}

interface ComposioExecuteResult {
  successful?: boolean;
  error?: string | null;
  data?: Record<string, unknown>;
}

interface ComposioLike {
  tools: {
    execute(
      slug: string,
      input: { userId: string; connectedAccountId?: string; arguments: Record<string, unknown> },
    ): Promise<ComposioExecuteResult>;
  };
}

/** Slugs are named once so a typo surfaces here rather than as an empty result at runtime. */
export const GMAIL_SLUGS = {
  fetchEmails: 'GMAIL_FETCH_EMAILS',
  fetchByThread: 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
  fetchByMessage: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
  getAttachment: 'GMAIL_GET_ATTACHMENT',
  createDraft: 'GMAIL_CREATE_EMAIL_DRAFT',
  sendDraft: 'GMAIL_SEND_DRAFT',
  sendEmail: 'GMAIL_SEND_EMAIL',
  replyToThread: 'GMAIL_REPLY_TO_THREAD',
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * The attachment's bytes, however the toolkit chose to hand them over.
 *
 * Composio does not return the bytes inline: `GMAIL_GET_ATTACHMENT` uploads the file and answers
 * with a short-lived presigned URL under `file.s3url`. The inline forms are still accepted because
 * smaller payloads have arrived that way.
 *
 * The one thing this must never do is return empty for a shape it does not recognise. The previous
 * version read a single field and skipped the attachment when it was blank, so a change on
 * Composio's side turned every PDF into silence: the run went on to report "no commercial invoice"
 * for a mail that plainly carried one, which is a far more expensive failure than stopping here.
 */
async function attachmentBytes(
  data: Record<string, unknown>,
  filename: string,
): Promise<Uint8Array> {
  const inline = str(data.data) !== '' ? str(data.data) : str(data.file);
  if (inline !== '') return Buffer.from(inline, 'base64url');

  const url = str(asRecord(data.file).s3url);
  if (url === '') {
    throw new NonRetryableToolError(
      GMAIL_SLUGS.getAttachment,
      `no bytes for '${filename}': the response carried neither inline data nor a download URL`,
      { responseKeys: Object.keys(data).sort() },
    );
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new ExternalActionError(
      GMAIL_SLUGS.getAttachment,
      `could not download '${filename}': HTTP ${String(response.status)}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function createComposioMailbox(
  composio: ComposioLike,
  options: ComposioMailboxOptions,
): MailboxTool {
  async function execute(
    slug: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await composio.tools.execute(slug, {
      userId: options.userId,
      connectedAccountId: options.connectedAccountId,
      arguments: args,
    });
    if (result.successful === false) {
      throw new ExternalActionError(slug, result.error ?? 'Composio reported failure');
    }
    return asRecord(result.data);
  }

  function assertSendAllowed(recipient: string): void {
    if (!options.liveMode) {
      throw new ToolUnavailableError(
        'mailbox',
        'neither GMAIL_LIVE_MODE nor GMAIL_SEND_LIVE is set; refusing to send.',
      );
    }
    const normalized = recipient.trim().toLowerCase();
    const allowed = options.allowedRecipients.some(
      (entry) => entry.trim().toLowerCase() === normalized,
    );
    if (!allowed) {
      throw new ToolUnavailableError(
        'mailbox',
        `recipient is not in GMAIL_ALLOWED_RECIPIENTS: ${recipient}`,
      );
    }
  }

  function toMessage(raw: Record<string, unknown>): MailMessage {
    const payload = asRecord(raw.payload);
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const header = (name: string): string => {
      for (const entry of headers) {
        const record = asRecord(entry);
        if (str(record.name).toLowerCase() === name) return str(record.value);
      }
      return '';
    };
    const attachments: AttachmentRef[] = (
      Array.isArray(raw.attachmentList) ? raw.attachmentList : []
    )
      .map((entry) => asRecord(entry))
      .map((entry) => ({
        attachmentId: str(entry.attachmentId ?? entry.attachment_id),
        filename: str(entry.filename),
        mimeType: str(entry.mimeType ?? entry.mime_type, 'application/octet-stream'),
        sizeBytes: typeof entry.size === 'number' ? entry.size : 0,
        storagePath: null,
      }));

    return {
      messageId: str(raw.messageId ?? raw.id),
      threadId: str(raw.threadId ?? raw.thread_id),
      subject: str(raw.subject, header('subject')),
      from: str(raw.sender, header('from')),
      to: header('to')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
      receivedAt: str(raw.messageTimestamp, header('date')),
      bodyText: str(raw.messageText ?? raw.preview ?? ''),
      attachments,
    };
  }

  return {
    async searchMessages(query, maxResults = options.maxResults) {
      const data = await execute(GMAIL_SLUGS.fetchEmails, {
        query,
        max_results: maxResults,
        verbose: true,
      });
      const list = Array.isArray(data.messages) ? data.messages : [];
      return list
        .map((entry) => toMessage(asRecord(entry)))
        .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
    },

    async fetchThread(threadId) {
      const data = await execute(GMAIL_SLUGS.fetchByThread, { thread_id: threadId, user_id: 'me' });
      const list = Array.isArray(data.messages) ? data.messages : [];
      // The thread endpoint returns metadata only, so each message is rehydrated at `full`.
      // Reading attachment IDs from the metadata form yields nulls, which used to look like a
      // message with no attachments at all.
      const hydrated: MailMessage[] = [];
      for (const entry of list) {
        const id = str(asRecord(entry).messageId ?? asRecord(entry).id);
        if (id === '') continue;
        const full = await execute(GMAIL_SLUGS.fetchByMessage, {
          message_id: id,
          user_id: 'me',
          format: 'full',
        });
        hydrated.push(toMessage(full));
      }
      return hydrated;
    },

    async downloadAttachments(threadId) {
      const messages = await this.fetchThread(threadId);
      const stored: AttachmentRef[] = [];
      for (const message of messages) {
        for (const attachment of message.attachments) {
          const data = await execute(GMAIL_SLUGS.getAttachment, {
            message_id: message.messageId,
            attachment_id: attachment.attachmentId,
            user_id: 'me',
            // Required by the toolkit with a non-empty value, even though the bytes are returned
            // inline rather than written to disk. Gmail leaves the filename blank on inline parts,
            // so the attachment ID stands in — it is unique and the stored path uses it anyway.
            file_name: attachment.filename === '' ? attachment.attachmentId : attachment.filename,
          });
          const bytes = await attachmentBytes(data, attachment.filename);
          const path = `${options.attachmentBucket}/${options.executionId}/${message.messageId}/${attachment.filename}`;
          await options.store.put(path, bytes, attachment.mimeType);
          // Gmail's thread listing omits the size, so the transferred length is the honest value.
          stored.push({ ...attachment, sizeBytes: bytes.byteLength, storagePath: path });
        }
      }
      return stored;
    },

    async createDraft(payload) {
      assertSendAllowed(payload.to);
      const marked = withMarker(payload);
      const data = await execute(GMAIL_SLUGS.createDraft, {
        recipient_email: marked.to,
        subject: marked.subject,
        body: marked.body,
        ...(marked.threadId === undefined ? {} : { thread_id: marked.threadId }),
      });
      const draftId = str(asRecord(data.response_data).id, str(data.id));
      if (draftId === '') throw new ExternalActionError('mail.draft', 'no draft id returned');
      return { draftId };
    },

    async sendDraft(draftId) {
      if (!options.liveMode) {
        throw new ToolUnavailableError(
          'mailbox',
          'neither GMAIL_LIVE_MODE nor GMAIL_SEND_LIVE is set; refusing to send.',
        );
      }
      const data = await execute(GMAIL_SLUGS.sendDraft, { draft_id: draftId, user_id: 'me' });
      return {
        providerMessageId: str(data.id ?? asRecord(data.response_data).id),
        threadId: str(data.threadId ?? asRecord(data.response_data).threadId),
      };
    },

    async sendMessage(payload): Promise<SentMail> {
      assertSendAllowed(payload.to);
      const marked = withMarker(payload);
      // A reply must not carry a subject; Gmail derives it from the thread, and supplying one
      // starts a visually separate conversation.
      const slug =
        marked.threadId === undefined ? GMAIL_SLUGS.sendEmail : GMAIL_SLUGS.replyToThread;
      const args: Record<string, unknown> =
        marked.threadId === undefined
          ? { recipient_email: marked.to, subject: marked.subject, body: marked.body }
          : { thread_id: marked.threadId, recipient_email: marked.to, message_body: marked.body };
      const data = await execute(slug, args);
      const response = asRecord(data.response_data);
      const providerMessageId = str(data.id ?? response.id);
      if (providerMessageId === '') {
        throw new ExternalActionError('mail.send', 'provider returned no message id');
      }
      return {
        providerMessageId,
        threadId: str(data.threadId ?? response.threadId, marked.threadId ?? ''),
      };
    },
  };
}
