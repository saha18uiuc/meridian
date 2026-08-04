import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createMockMailbox, parseEml, type MockMailbox } from '@meridian/agent-kit';
import type { MailMessage, MessageRef } from '@meridian/agent-kit/contracts';

/**
 * A mailbox restricted to the messages one eval case declares.
 *
 * The shared mock reads a whole directory, which is right for the demo and wrong for an eval case:
 * a case that accidentally sees another case's fixture would pass or fail for reasons its author
 * never wrote down. Restricting the visible set is what makes each case an independent statement.
 */

export interface CaseMailbox {
  mailbox: MockMailbox;
  messages: MailMessage[];
  messageRefs: MessageRef[];
}

/**
 * Where a deployment's fixture mail and attachments live. A parameter rather than a constant: the
 * harness runs whichever deployment it is pointed at, and a hard-coded path here would mean the
 * second example could compile and release but never execute a single run.
 */
export const DEFAULT_FIXTURES_ROOT = 'examples/inbound-import-receiving/fixtures';

export function readCaseMessages(
  repoRoot: string,
  emailPaths: readonly string[],
  fixturesRoot: string = DEFAULT_FIXTURES_ROOT,
): MailMessage[] {
  return emailPaths.map((relative) => {
    const absolute = join(repoRoot, relative);
    const parsed = parseEml(readFileSync(absolute, 'utf8'), basename(relative));
    return {
      messageId: parsed.messageId,
      threadId: parsed.threadId,
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      receivedAt: parsed.receivedAt,
      bodyText: parsed.bodyText,
      attachments: parsed.attachments.map((filename) => ({
        attachmentId: `${parsed.messageId}:${filename}`,
        filename,
        mimeType: filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
        sizeBytes: 0,
        storagePath: join(repoRoot, fixturesRoot, 'attachments', filename),
      })),
    };
  });
}

export function createCaseMailbox(
  repoRoot: string,
  emailPaths: readonly string[],
  fixturesRoot: string = DEFAULT_FIXTURES_ROOT,
): CaseMailbox {
  const messages = readCaseMessages(repoRoot, emailPaths, fixturesRoot);
  const mailbox = createMockMailbox({
    emailDir: join(repoRoot, fixturesRoot, 'emails'),
    attachmentDir: join(repoRoot, fixturesRoot, 'attachments'),
    only: messages.map((message) => message.messageId),
  });

  return {
    mailbox,
    messages,
    messageRefs: messages.map((message) => ({
      provider: 'mock' as const,
      providerMessageId: message.messageId,
      threadId: message.threadId,
      subject: message.subject,
      receivedAt: message.receivedAt,
      storagePath: null,
    })),
  };
}
