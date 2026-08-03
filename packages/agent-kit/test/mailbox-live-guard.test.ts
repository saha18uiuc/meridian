import { describe, expect, it, vi } from 'vitest';
import { ToolUnavailableError } from '../src/errors.js';
import { createComposioMailbox } from '../src/tools/live/composio-mailbox.js';
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

describe('live Gmail safety switches', () => {
  it('refuses to send when GMAIL_LIVE_MODE is false, before any SDK call', async () => {
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
