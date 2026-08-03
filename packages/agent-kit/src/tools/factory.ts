import { fileURLToPath } from 'node:url';
import type { Database } from '@meridian/core/database';
import type { WorkerEnv } from '@meridian/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HumanHandoffTool, ToolRegistry } from '../contracts.js';
import { ToolUnavailableError } from '../errors.js';
import { createArtifactStore } from '../storage.js';
import { createMockBrowser } from './mock/browser.js';
import { createMockDocumentTool } from './mock/documents.js';
import { createMockMailbox } from './mock/mailbox.js';

export interface ToolFactoryOptions {
  env: WorkerEnv;
  executionId: string;
  capabilities: readonly string[];
  supabase?: SupabaseClient<Database>;
  fixtureRoot?: string;
  humanHandoff?: HumanHandoffTool;
}

/**
 * Mock or live is decided here and nowhere else.
 *
 * Generated agents never learn which implementation they were handed, which is the property that
 * lets the identical agent code run in the eval suite and against a real inbox. `GMAIL_LIVE_MODE`
 * is the single switch; everything else follows from it.
 */
export function createTools(options: ToolFactoryOptions): ToolRegistry {
  const env = options.env;
  const humanHandoff = options.humanHandoff ?? unavailableHandoff();

  if (!env.GMAIL_LIVE_MODE) {
    const root = options.fixtureRoot ?? defaultFixtureRoot();
    return {
      mailbox: createMockMailbox({
        emailDir: `${root}/emails`,
        attachmentDir: `${root}/attachments`,
      }),
      documents: createMockDocumentTool({ attachmentDir: `${root}/attachments` }),
      browser: createMockBrowser({ allowList: env.BROWSER_ALLOWED_DOMAINS }),
      humanHandoff,
    };
  }

  if (options.supabase === undefined) {
    throw new ToolUnavailableError('tools', 'live mode requires a Supabase service client');
  }
  return createLiveTools({ ...options, supabase: options.supabase, humanHandoff });
}

/**
 * The fixture corpus, located from this module rather than from the working directory.
 *
 * The same mock tools are constructed by the eval harness (cwd: the repository root), by the
 * Temporal worker (cwd: `apps/backend`), and by the Next.js server (cwd: `apps/web`). A relative
 * default is correct in exactly one of those three, and the two failures are ugly: the worker's
 * activity throws `ENOENT` deep inside a run, which surfaces as a workflow that failed rather than
 * as a misconfiguration anyone can see.
 */
function defaultFixtureRoot(): string {
  return fileURLToPath(
    new URL('../../../../examples/inbound-import-receiving/fixtures', import.meta.url),
  );
}

function unavailableHandoff(): HumanHandoffTool {
  // Handoff cannot be built outside a workflow: waiting is a `condition` over signal state, not an
  // activity, so a factory-produced stub would be a lie rather than a fallback.
  return {
    async requestDecision() {
      throw new ToolUnavailableError('humanHandoff', 'only available inside a workflow');
    },
    async waitForDecision() {
      throw new ToolUnavailableError('humanHandoff', 'only available inside a workflow');
    },
  };
}

async function loadComposio(apiKey: string, toolkitVersion: string): Promise<unknown> {
  const module = (await import('@composio/core')) as {
    Composio: new (config: { apiKey: string; toolkitVersions?: Record<string, string> }) => unknown;
  };
  return new module.Composio({ apiKey, toolkitVersions: { gmail: toolkitVersion } });
}

function createLiveTools(
  options: ToolFactoryOptions & {
    supabase: SupabaseClient<Database>;
    humanHandoff: HumanHandoffTool;
  },
): ToolRegistry {
  const env = options.env;
  const store = createArtifactStore(options.supabase);

  if (env.COMPOSIO_API_KEY === undefined || env.COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID === undefined) {
    throw new ToolUnavailableError(
      'mailbox',
      'COMPOSIO_API_KEY and COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID are required in live mode',
    );
  }
  if (env.COMPOSIO_GMAIL_TOOLKIT_VERSION === 'latest') {
    throw new ToolUnavailableError(
      'mailbox',
      'the Composio Gmail toolkit version must be resolved to a concrete value before a run (A29)',
    );
  }

  const apiKey = env.COMPOSIO_API_KEY;
  const connectedAccountId = env.COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID;

  // The adapters are constructed lazily so that importing this module never pulls a provider SDK
  // into a bundle that merely needed the mock path.
  const mailboxPromise = (async () => {
    const { createComposioMailbox } = await import('./live/composio-mailbox.js');
    const composio = await loadComposio(apiKey, env.COMPOSIO_GMAIL_TOOLKIT_VERSION);
    return createComposioMailbox(composio as Parameters<typeof createComposioMailbox>[0], {
      apiKey,
      userId: env.COMPOSIO_USER_ID,
      connectedAccountId,
      toolkitVersion: env.COMPOSIO_GMAIL_TOOLKIT_VERSION,
      liveMode: env.GMAIL_LIVE_MODE,
      allowedRecipients: env.GMAIL_ALLOWED_RECIPIENTS,
      maxResults: env.GMAIL_MAX_RESULTS,
      store,
      attachmentBucket: env.STORAGE_BUCKET_ATTACHMENTS,
      executionId: options.executionId,
    });
  })();

  return {
    mailbox: {
      searchMessages: async (query, max) => (await mailboxPromise).searchMessages(query, max),
      fetchThread: async (threadId) => (await mailboxPromise).fetchThread(threadId),
      downloadAttachments: async (threadId) => (await mailboxPromise).downloadAttachments(threadId),
      createDraft: async (payload) => (await mailboxPromise).createDraft(payload),
      sendDraft: async (draftId) => (await mailboxPromise).sendDraft(draftId),
      sendMessage: async (payload) => (await mailboxPromise).sendMessage(payload),
    },
    documents: createLiveDocuments(options),
    browser: createLiveBrowser(options),
    humanHandoff: options.humanHandoff,
  };
}

/**
 * Chromium, launched on first use and not before.
 *
 * Live mode does not imply a browser: most receiving runs never leave the mailbox, and paying a
 * Chromium launch for every one of them would be a cost with no purchase. So the launch is deferred
 * to the first navigation, and a run that never navigates never starts one.
 *
 * There is no mock fallback on this path. Handing back a mock because Playwright failed to launch
 * would let a live run report a page it never actually visited, which is worse than the failure.
 */
function createLiveBrowser(
  options: ToolFactoryOptions & { supabase: SupabaseClient<Database> },
): ToolRegistry['browser'] {
  const env = options.env;
  const store = createArtifactStore(options.supabase);
  let cached: Promise<ToolRegistry['browser']> | null = null;

  async function build(): Promise<ToolRegistry['browser']> {
    const [{ createPlaywrightBrowser }, playwright] = await Promise.all([
      import('./live/playwright-browser.js'),
      import('playwright'),
    ]);
    const browser = await playwright.chromium.launch({ headless: true });
    return createPlaywrightBrowser(browser, {
      allowList: env.BROWSER_ALLOWED_DOMAINS,
      writeEnabled: env.BROWSER_WRITE_ENABLED,
      capabilities: options.capabilities,
      store,
      screenshotBucket: env.STORAGE_BUCKET_SCREENSHOTS,
      executionId: options.executionId,
    });
  }

  function lazy(): Promise<ToolRegistry['browser']> {
    cached ??= build();
    return cached;
  }

  return {
    open: async (url) => (await lazy()).open(url),
    extractText: async (selector) => (await lazy()).extractText(selector),
    download: async (url) => (await lazy()).download(url),
    screenshot: async () => (await lazy()).screenshot(),
  };
}

function createLiveDocuments(
  options: ToolFactoryOptions & { supabase: SupabaseClient<Database> },
): ToolRegistry['documents'] {
  const env = options.env;
  const store = createArtifactStore(options.supabase);
  let cached: Promise<ToolRegistry['documents']> | null = null;

  async function build(): Promise<ToolRegistry['documents']> {
    const { createLiveDocumentTool } = await import('./live/openai-documents.js');
    return createLiveDocumentTool({
      store,
      ocrEnabled: env.OCR_ENABLED,
      ocrMinTextChars: env.OCR_MIN_TEXT_CHARS,
      extractStructured: async (text, schemaName) => {
        if (env.AI_MODE !== 'live' || env.OPENAI_API_KEY === undefined) {
          throw new ToolUnavailableError(
            'documents',
            'structured extraction requires AI_MODE=live',
          );
        }
        const { default: OpenAI } = await import('openai');
        const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
        const response = await client.responses.create({
          model: env.AI_REVIEW_MODEL,
          input: [
            {
              role: 'system',
              content: `Extract the fields for schema "${schemaName}" as strict JSON. Use null for anything absent; never invent a value.`,
            },
            { role: 'user', content: text.slice(0, 100_000) },
          ],
        });
        return JSON.parse(response.output_text) as Record<string, unknown>;
      },
    });
  }

  function lazy(): Promise<ToolRegistry['documents']> {
    cached ??= build();
    return cached;
  }

  return {
    extractText: async (fileRef) => (await lazy()).extractText(fileRef),
    extractFields: async (fileRef, schemaName) => (await lazy()).extractFields(fileRef, schemaName),
    normalizeValue: async (value, type) => (await lazy()).normalizeValue(value, type),
  };
}
