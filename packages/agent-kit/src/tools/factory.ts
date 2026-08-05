import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@meridian/core/database';
import type { WorkerEnv } from '@meridian/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HumanHandoffTool, MailboxTool, ToolRegistry } from '../contracts.js';
import { ToolUnavailableError } from '../errors.js';
import { createArtifactStore } from '../storage.js';
import { composeMailbox } from './mailbox.js';
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
  /**
   * The model boundary, supplied by the worker.
   *
   * Injected rather than built here for the same reason `createLiveDocumentTool` injects it one
   * level down: this package must be importable without pulling a model SDK into a bundle that
   * only ever wanted the mock path. The worker passes `modelExtractStructured`; the eval harness
   * and every mock run pass nothing and never reach a live document.
   */
  extractStructured?: (text: string, schemaName: string) => Promise<Record<string, unknown>>;
  /**
   * Which messages this caller has actually been handed, for the fixture mailbox.
   *
   * Read on every call rather than fixed at construction, because a run learns about messages one
   * signal at a time and the fixture directory holds them all from the start. `null` — the default
   * — means the whole directory, which is what intake reads.
   */
  visibleMessageIds?: () => readonly string[] | null;
}

/**
 * Mock or live is decided here and nowhere else.
 *
 * Generated agents never learn which implementation they were handed, which is the property that
 * lets the identical agent code run in the eval suite and against a real inbox. `GMAIL_LIVE_MODE`
 * chooses the registry; `GMAIL_SEND_LIVE` splits the mailbox alone, so a run can read the fixtures
 * it can be held to and still put a real email in a real inbox.
 */
export function createTools(options: ToolFactoryOptions): ToolRegistry {
  const env = options.env;
  const humanHandoff = options.humanHandoff ?? unavailableHandoff();

  if (!env.GMAIL_LIVE_MODE) {
    const root = options.fixtureRoot ?? defaultFixtureRoot();
    const fixtures = createMockMailbox({
      emailDir: `${root}/emails`,
      attachmentDir: `${root}/attachments`,
      ...(options.visibleMessageIds === undefined ? {} : { only: options.visibleMessageIds }),
    });
    return {
      mailbox: env.GMAIL_SEND_LIVE
        ? composeMailbox(fixtures, composioMailbox(requireSupabase(options)))
        : fixtures,
      documents: createMockDocumentTool({ attachmentDir: `${root}/attachments` }),
      browser: createMockBrowser({ allowList: env.BROWSER_ALLOWED_DOMAINS }),
      humanHandoff,
    };
  }

  return createLiveTools({ ...requireSupabase(options), humanHandoff });
}

function requireSupabase(
  options: ToolFactoryOptions,
): ToolFactoryOptions & { supabase: SupabaseClient<Database> } {
  if (options.supabase === undefined) {
    throw new ToolUnavailableError('tools', 'live mode requires a Supabase service client');
  }
  return { ...options, supabase: options.supabase };
}

/**
 * The fixture corpus, located from this module rather than from the working directory.
 *
 * The same mock tools are constructed by the eval harness (cwd: the repository root), by the
 * Temporal worker (cwd: `apps/backend`), and by the Next.js server (cwd: `apps/web`). A relative
 * default is correct in exactly one of those three, and the two failures are ugly: the worker's
 * activity throws `ENOENT` deep inside a run, which surfaces as a workflow that failed rather than
 * as a misconfiguration anyone can see.
 *
 * Resolved with `path.resolve` rather than `new URL(literal, import.meta.url)`, because webpack
 * reads the latter as an asset reference and tries to bundle a directory that does not exist inside
 * the Next.js build. The result is identical at runtime; only the bundler's opinion differs.
 */
function defaultFixtureRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', 'examples', 'inbound-import-receiving', 'fixtures');
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
  return {
    mailbox: composioMailbox(options),
    documents: createLiveDocuments(options),
    browser: createLiveBrowser(options),
    humanHandoff: options.humanHandoff,
  };
}

/**
 * Gmail over Composio, behind a facade that builds the adapter on first use.
 *
 * The laziness is not an optimisation: importing this module must never pull a provider SDK into a
 * bundle that only ever wanted the mock path, and the hybrid mailbox builds this eagerly for a run
 * that may well never send anything.
 */
function composioMailbox(
  options: ToolFactoryOptions & { supabase: SupabaseClient<Database> },
): MailboxTool {
  const env = options.env;

  if (env.COMPOSIO_API_KEY === undefined || env.COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID === undefined) {
    throw new ToolUnavailableError(
      'mailbox',
      'COMPOSIO_API_KEY and COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID are required to reach Gmail',
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
  const store = createArtifactStore(options.supabase);

  const adapter = (async () => {
    const { createComposioMailbox } = await import('./live/composio-mailbox.js');
    const composio = await loadComposio(apiKey, env.COMPOSIO_GMAIL_TOOLKIT_VERSION);
    return createComposioMailbox(composio as Parameters<typeof createComposioMailbox>[0], {
      apiKey,
      userId: env.COMPOSIO_USER_ID,
      connectedAccountId,
      toolkitVersion: env.COMPOSIO_GMAIL_TOOLKIT_VERSION,
      // Either switch authorises a send. Reading is what they disagree about.
      liveMode: env.GMAIL_LIVE_MODE || env.GMAIL_SEND_LIVE,
      allowedRecipients: env.GMAIL_ALLOWED_RECIPIENTS,
      maxResults: env.GMAIL_MAX_RESULTS,
      store,
      attachmentBucket: env.STORAGE_BUCKET_ATTACHMENTS,
      executionId: options.executionId,
    });
  })();

  return {
    searchMessages: async (query, max) => (await adapter).searchMessages(query, max),
    fetchThread: async (threadId) => (await adapter).fetchThread(threadId),
    downloadAttachments: async (threadId) => (await adapter).downloadAttachments(threadId),
    createDraft: async (payload) => (await adapter).createDraft(payload),
    sendDraft: async (draftId) => (await adapter).sendDraft(draftId),
    sendMessage: async (payload) => (await adapter).sendMessage(payload),
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
    const extractStructured = options.extractStructured;
    if (extractStructured === undefined) {
      // Reached only by a caller that turned live mode on and then asked a document for its
      // fields without supplying a model. Refusing here is the point: the alternative is a second
      // copy of the call kept alive for a caller that does not exist.
      throw new ToolUnavailableError(
        'documents',
        'live field extraction needs a model boundary; pass extractStructured to createTools',
      );
    }
    return createLiveDocumentTool({
      store,
      ocrEnabled: env.OCR_ENABLED,
      ocrMinTextChars: env.OCR_MIN_TEXT_CHARS,
      extractStructured,
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
