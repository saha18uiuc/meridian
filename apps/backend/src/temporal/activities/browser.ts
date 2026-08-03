import type { AttachmentRef } from '@meridian/agent-kit/contracts';
import { withFailureMapping } from './failures.js';
import { type ActivityEnvelope, toolsFor } from './runtime.js';

export async function browserOpen(
  envelope: ActivityEnvelope,
  url: string,
): Promise<{ url: string; title: string }> {
  return withFailureMapping(async () => toolsFor(envelope).browser.open(url));
}

export async function browserExtractText(
  envelope: ActivityEnvelope,
  selector?: string,
): Promise<string> {
  return withFailureMapping(async () => toolsFor(envelope).browser.extractText(selector));
}

export async function browserDownload(
  envelope: ActivityEnvelope,
  url: string,
): Promise<AttachmentRef> {
  return withFailureMapping(async () => toolsFor(envelope).browser.download(url));
}

export async function browserScreenshot(
  envelope: ActivityEnvelope,
): Promise<{ storagePath: string }> {
  return withFailureMapping(async () => toolsFor(envelope).browser.screenshot());
}
