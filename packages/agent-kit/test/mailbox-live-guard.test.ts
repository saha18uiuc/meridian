import { describe, expect, it, vi } from 'vitest';
import { ToolUnavailableError } from '../src/errors.js';
import { createComposioMailbox } from '../src/tools/live/composio-mailbox.js';
import { composeMailbox } from '../src/tools/mailbox.js';
import type { AttachmentRef } from '../src/contracts.js';
import type { ArtifactStore } from '../src/storage.js';

const store: ArtifactStore = {
  put: async () => '',
  get: async () => new Uint8Array(),
  signedUrl: async () => '',
};

function harness(overrides: { liveMode?: boolean; allowedRecipients?: string[] } = {}) {
  const execute = vi.fn(async () => ({ successful: true, data: { id: 'm1', threadId: 't1' } }));
  const mailbox = createComposioMailbox(
    { tools: { execute } },
    {
      apiKey: 'test-key',
      userId: 'meridian-demo',
      connectedAccountId: 'ca_1',
      toolkitVersion: '20260101_00',
      liveMode: overrides.liveMode ?? false,
      allowedRecipients: overrides.allowedRecipients ?? ['allowed@importer.example'],
      maxResults: 25,
      store,
      attachmentBucket: 'attachments',
      executionId: 'exec-1',
    },
  );
  return { mailbox, execute };
}

/** Runs `downloadAttachments` against a mailbox wired to the supplied Composio stub. */
async function downloadWith(
  execute: (slug: string, input: unknown) => Promise<unknown>,
  put: ArtifactStore['put'],
): Promise<readonly AttachmentRef[]> {
  const mailbox = createComposioMailbox({ tools: { execute } } as never, {
    apiKey: 'k',
    userId: 'u',
    connectedAccountId: 'ca',
    toolkitVersion: '20260101_00',
    liveMode: true,
    allowedRecipients: [],
    maxResults: 5,
    store: { ...store, put },
    attachmentBucket: 'attachments',
    executionId: 'exec-1',
  });
  return mailbox.downloadAttachments('t1');
}

/**
 * Reading the fixtures while sending for real.
 *
 * The two halves are wired from different places, which is the whole point, so what has to be
 * pinned is that each half goes where it was meant to and that the fixture thread id does not
 * follow the message out.
 */
describe('a mailbox composed of fixture reads and live sends', () => {
  function halves() {
    const read = {
      searchMessages: vi.fn(async () => []),
      fetchThread: vi.fn(async () => []),
      downloadAttachments: vi.fn(async () => []),
      createDraft: vi.fn(async () => ({ draftId: 'read-should-never-draft' })),
      sendDraft: vi.fn(async () => ({ providerMessageId: 'x', threadId: 'y' })),
      sendMessage: vi.fn(async () => ({ providerMessageId: 'x', threadId: 'y' })),
    };
    const send = {
      searchMessages: vi.fn(async () => []),
      fetchThread: vi.fn(async () => []),
      downloadAttachments: vi.fn(async () => []),
      createDraft: vi.fn(async () => ({ draftId: 'd1' })),
      sendDraft: vi.fn(async () => ({ providerMessageId: 'sent-1', threadId: 'thread-1' })),
      sendMessage: vi.fn(async () => ({ providerMessageId: 'sent-1', threadId: 'thread-1' })),
    };
    return { read, send, mailbox: composeMailbox(read, send) };
  }

  it('reads from the fixtures and sends through the provider', async () => {
    const { read, send, mailbox } = halves();

    await mailbox.searchMessages('in:inbox');
    await mailbox.fetchThread('thread-missing-coa');
    await mailbox.downloadAttachments('thread-missing-coa');
    await mailbox.sendMessage({ to: 'ops@importer.example', subject: 's', body: 'b' });

    expect(read.searchMessages).toHaveBeenCalledOnce();
    expect(read.fetchThread).toHaveBeenCalledOnce();
    expect(read.downloadAttachments).toHaveBeenCalledOnce();
    expect(read.sendMessage).not.toHaveBeenCalled();
    expect(send.sendMessage).toHaveBeenCalledOnce();
    expect(send.searchMessages).not.toHaveBeenCalled();
  });

  it('drops the thread id, which names a conversation the provider has never seen', async () => {
    // The agent replies onto the thread it read from, and that thread is a file in `examples/`.
    // Asking Gmail to append to it fails at the provider; sent standalone it keeps its subject.
    const { send, mailbox } = halves();

    await mailbox.sendMessage({
      to: 'ops@importer.example',
      subject: 'Information needed - container CMAU9988771',
      body: 'b',
      threadId: 'thread-missing-coa',
      markerToken: 'abc123def456',
    });

    expect(send.sendMessage).toHaveBeenCalledWith({
      to: 'ops@importer.example',
      subject: 'Information needed - container CMAU9988771',
      body: 'b',
      markerToken: 'abc123def456',
    });
  });

  it('sends drafts through the same half that created them', async () => {
    const { read, send, mailbox } = halves();

    const { draftId } = await mailbox.createDraft({
      to: 'ops@importer.example',
      subject: 's',
      body: 'b',
      threadId: 'thread-missing-coa',
    });
    await mailbox.sendDraft(draftId);

    expect(draftId).toBe('d1');
    expect(send.sendDraft).toHaveBeenCalledWith('d1');
    expect(read.createDraft).not.toHaveBeenCalled();
  });
});

describe('live Gmail safety switches', () => {
  it('refuses to send when neither switch authorises it, before any SDK call', async () => {
    const { mailbox, execute } = harness({ liveMode: false });
    await expect(
      mailbox.sendMessage({ to: 'allowed@importer.example', subject: 's', body: 'b' }),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a recipient outside GMAIL_ALLOWED_RECIPIENTS, before any SDK call', async () => {
    const { mailbox, execute } = harness({ liveMode: true });
    await expect(
      mailbox.sendMessage({ to: 'stranger@elsewhere.example', subject: 's', body: 'b' }),
    ).rejects.toThrow(/GMAIL_ALLOWED_RECIPIENTS/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('sends when both switches allow it, and appends the marker footer', async () => {
    const { mailbox, execute } = harness({ liveMode: true });
    await mailbox.sendMessage({
      to: 'allowed@importer.example',
      subject: 's',
      body: 'b',
      markerToken: 'abc123def456',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0] as unknown as [
      string,
      { arguments: Record<string, string> },
    ];
    expect(call[0]).toBe('GMAIL_SEND_EMAIL');
    expect(call[1].arguments.body).toContain('[meridian-ref: abc123def456]');
  });

  it('omits the subject when replying to a thread', async () => {
    const { mailbox, execute } = harness({ liveMode: true });
    await mailbox.sendMessage({
      to: 'allowed@importer.example',
      subject: 'ignored',
      body: 'b',
      threadId: 't1',
    });
    const call = execute.mock.calls[0] as unknown as [
      string,
      { arguments: Record<string, string> },
    ];
    expect(call[0]).toBe('GMAIL_REPLY_TO_THREAD');
    expect(call[1].arguments.subject).toBeUndefined();
  });

  it('guards drafts with the same two switches', async () => {
    const { mailbox, execute } = harness({ liveMode: false });
    await expect(
      mailbox.createDraft({ to: 'allowed@importer.example', subject: 's', body: 'b' }),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('names the file when downloading, which the toolkit requires and rejects the call without', async () => {
    const execute = vi.fn(async (slug: string) => {
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID')
        return { successful: true, data: { messages: [{ id: 'm1' }] } };
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID') {
        return {
          successful: true,
          data: {
            messageId: 'm1',
            attachmentList: [{ attachmentId: 'att-1', filename: 'invoice-1024.pdf' }],
          },
        };
      }
      return { successful: true, data: { data: 'ZmlsZQ' } };
    });

    await downloadWith(
      execute,
      vi.fn(async () => ''),
    );

    const download = execute.mock.calls.find((call) => call[0] === 'GMAIL_GET_ATTACHMENT') as
      [string, { arguments: Record<string, string> }] | undefined;
    expect(download?.[1].arguments.file_name).toBe('invoice-1024.pdf');
    expect(download?.[1].arguments.attachment_id).toBe('att-1');
  });

  it('falls back to the attachment id when Gmail leaves the filename blank', async () => {
    const execute = vi.fn(async (slug: string) => {
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID')
        return { successful: true, data: { messages: [{ id: 'm1' }] } };
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID') {
        return {
          successful: true,
          data: { messageId: 'm1', attachmentList: [{ attachmentId: 'att-2' }] },
        };
      }
      return { successful: true, data: { data: 'ZmlsZQ' } };
    });

    await downloadWith(
      execute,
      vi.fn(async () => ''),
    );

    const download = execute.mock.calls.find((call) => call[0] === 'GMAIL_GET_ATTACHMENT') as
      [string, { arguments: Record<string, string> }] | undefined;
    expect(download?.[1].arguments.file_name).toBe('att-2');
  });

  it('downloads the bytes when the toolkit answers with a presigned URL instead of inline data', async () => {
    const put = vi.fn<ArtifactStore['put']>(async () => '');
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70, 45])));
    vi.stubGlobal('fetch', fetchMock);

    const execute = vi.fn(async (slug: string) => {
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID')
        return { successful: true, data: { messages: [{ id: 'm1' }] } };
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID') {
        return {
          successful: true,
          data: {
            messageId: 'm1',
            attachmentList: [{ attachmentId: 'att-1', filename: 'invoice-1024.pdf' }],
          },
        };
      }
      return {
        successful: true,
        data: { file: { name: 'invoice-1024.pdf', s3url: 'https://temp.example/signed' } },
      };
    });

    const stored = await downloadWith(execute, put);

    expect(fetchMock).toHaveBeenCalledWith('https://temp.example/signed');
    expect(put.mock.calls[0]?.[1]).toEqual(new Uint8Array([37, 80, 68, 70, 45]));
    expect(stored[0]?.sizeBytes).toBe(5);
    vi.unstubAllGlobals();
  });

  it('fails loudly when the response carries no bytes, rather than dropping the attachment', async () => {
    const execute = vi.fn(async (slug: string) => {
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID')
        return { successful: true, data: { messages: [{ id: 'm1' }] } };
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID') {
        return {
          successful: true,
          data: {
            messageId: 'm1',
            attachmentList: [{ attachmentId: 'att-1', filename: 'invoice-1024.pdf' }],
          },
        };
      }
      return { successful: true, data: { display_url: 'https://mail.google.com/x' } };
    });

    await expect(
      downloadWith(
        execute,
        vi.fn(async () => ''),
      ),
    ).rejects.toThrow(/no bytes for 'invoice-1024.pdf'/);
  });

  it('treats an unsuccessful Composio response as an external action failure', async () => {
    const execute = vi.fn(async () => ({ successful: false, error: 'rate limited', data: {} }));
    const mailbox = createComposioMailbox(
      { tools: { execute } },
      {
        apiKey: 'k',
        userId: 'u',
        connectedAccountId: 'ca',
        toolkitVersion: '20260101_00',
        liveMode: true,
        allowedRecipients: ['allowed@importer.example'],
        maxResults: 5,
        store,
        attachmentBucket: 'attachments',
        executionId: 'exec-1',
      },
    );
    await expect(mailbox.searchMessages('in:inbox')).rejects.toThrow(/rate limited/);
  });
});
