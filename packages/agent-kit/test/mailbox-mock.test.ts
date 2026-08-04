import { describe, expect, it } from 'vitest';
import { createMockMailbox, parseEml } from '../src/tools/mock/mailbox.js';
import { markerFooter } from '../src/tools/mailbox.js';

const EMAIL_DIR = new URL(
  '../../../examples/inbound-import-receiving/fixtures/emails',
  import.meta.url,
).pathname;
const ATTACHMENT_DIR = new URL(
  '../../../examples/inbound-import-receiving/fixtures/attachments',
  import.meta.url,
).pathname;

function mailbox() {
  return createMockMailbox({ emailDir: EMAIL_DIR, attachmentDir: ATTACHMENT_DIR });
}

describe('parseEml', () => {
  it('reads headers, folded headers, and the body', () => {
    const parsed = parseEml(
      [
        'Message-ID: <a@b>',
        'Subject: line one',
        ' continued',
        'To: x@y, z@y',
        '',
        'body text',
      ].join('\n'),
      'fallback',
    );
    expect(parsed.messageId).toBe('<a@b>');
    expect(parsed.subject).toBe('line one continued');
    expect(parsed.to).toEqual(['x@y', 'z@y']);
    expect(parsed.bodyText).toBe('body text');
  });

  it('falls back to the supplied id when Message-ID is absent', () => {
    expect(parseEml('Subject: none\n\nbody', 'fallback.eml').messageId).toBe('fallback.eml');
  });
});

describe('mock mailbox', () => {
  it('loads every fixture and exposes the business key in the subject or body', async () => {
    const messages = await mailbox().searchMessages('');
    expect(messages.length).toBe(14);
    expect(messages.some((message) => message.subject.includes('MSKU1234565'))).toBe(true);
  });

  it('groups a thread and returns its attachments', async () => {
    const box = mailbox();
    const thread = await box.fetchThread('thread-happy-path');
    // Four fixtures share the happy-path thread: the arrival notice, the byte-identical resend, the
    // conflicting revision, and the extra invoice carrying a duplicate batch.
    expect(thread.map((message) => message.messageId).sort()).toEqual([
      '<conflicting-invoice@forwarder.example>',
      '<duplicate-batch@forwarder.example>',
      '<duplicate-invoice@forwarder.example>',
      '<happy-path@forwarder.example>',
    ]);
    const attachments = await box.downloadAttachments('thread-happy-path');
    expect(attachments.map((attachment) => attachment.filename)).toContain('coa-B77A.pdf');
  });

  it('keeps the late follow-up out of the original thread', async () => {
    // Correlation is by business key, not by thread. The late follow-up names the same container
    // but arrives on a thread of its own, which is the only way to test that the key does the work.
    const box = mailbox();
    expect(await box.fetchThread('thread-happy-path')).not.toContainEqual(
      expect.objectContaining({ messageId: '<late-followup@forwarder.example>' }),
    );
    const followUp = await box.fetchThread('thread-late-followup');
    expect(followUp.map((message) => message.messageId)).toEqual([
      '<late-followup@forwarder.example>',
    ]);
    expect(followUp[0]?.subject).toContain('MSKU1234565');
  });

  it('restricts the inbox to the declared messages when `only` is given', async () => {
    const box = createMockMailbox({
      emailDir: EMAIL_DIR,
      attachmentDir: ATTACHMENT_DIR,
      only: ['<happy-path@forwarder.example>'],
    });
    const messages = await box.searchMessages('');
    expect(messages.map((message) => message.messageId)).toEqual([
      '<happy-path@forwarder.example>',
    ]);
  });

  it('appends the marker footer to every outbound message', async () => {
    const box = mailbox();
    await box.sendMessage({
      to: 'a@b.c',
      subject: 's',
      body: 'hello',
      markerToken: 'abc123def456',
    });
    expect(box.outbox()[0]?.body).toContain(markerFooter('abc123def456'));
  });

  it('does not append the footer twice when a payload is re-sent', async () => {
    const box = mailbox();
    const body = `hello\n\n${markerFooter('abc123def456')}`;
    await box.sendMessage({ to: 'a@b.c', subject: 's', body, markerToken: 'abc123def456' });
    const sentBody = box.outbox()[0]?.body ?? '';
    expect(sentBody.split('[meridian-ref:').length - 1).toBe(1);
  });

  it('produces byte-identical outboxes across two independent runs', async () => {
    async function run(): Promise<string> {
      const box = mailbox();
      await box.createDraft({ to: 'a@b.c', subject: 'draft', body: 'd' });
      await box.sendMessage({ to: 'a@b.c', subject: 'one', body: '1' });
      await box.sendMessage({ to: 'd@e.f', subject: 'two', body: '2' });
      return JSON.stringify(box.outbox());
    }
    expect(await run()).toBe(await run());
  });

  it('sends a draft by id and rejects an unknown one', async () => {
    const box = mailbox();
    const { draftId } = await box.createDraft({ to: 'a@b.c', subject: 's', body: 'b' });
    const sent = await box.sendDraft(draftId);
    expect(sent.providerMessageId).toMatch(/^sent-\d{4}$/);
    await expect(box.sendDraft('draft-9999')).rejects.toThrow(/unknown draft/);
  });
});
