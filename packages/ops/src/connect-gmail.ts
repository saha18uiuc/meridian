import { loadOpsEnv, requireEnv, optionalEnv } from './env.js';

/**
 * The one-time Gmail consent flow.
 *
 * This is a manual gate by nature: OAuth consent happens in a human's browser, and no amount of
 * automation can or should stand in for it. The script's job is to make the gate short and
 * unambiguous — print the URL, wait, print the exact line to paste into `.env` — and to never
 * print the API key while doing it.
 */

interface ConnectionRequest {
  redirectUrl?: string | null;
  waitForConnection(timeoutMs?: number): Promise<{ id: string; status?: string }>;
}

interface ConnectedAccountSummary {
  id: string;
  status?: string;
}

interface ComposioLike {
  connectedAccounts: {
    list(query: {
      userIds: string[];
      authConfigIds: string[];
      statuses: string[];
    }): Promise<{ items: ConnectedAccountSummary[] }>;
    link(userId: string, authConfigId: string): Promise<ConnectionRequest>;
  };
}

export const CONSENT_TIMEOUT_MS = 300_000;

/** The status Composio gives a connection that has completed consent and can execute tools. */
const ACTIVE = 'ACTIVE';

function reportConnected(write: (line: string) => void, id: string): void {
  write('');
  write('Connected. Add this line to your .env:');
  write(`  COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID=${id}`);
  write('');
  write(
    'Then set GMAIL_LIVE_MODE=true and list the recipients you allow in GMAIL_ALLOWED_RECIPIENTS.',
  );
}

export async function connectGmail(
  composio: ComposioLike,
  userId: string,
  authConfigId: string,
  write: (line: string) => void,
): Promise<string> {
  // Asking first is what makes the command safe to re-run. `link` refuses outright when an active
  // account already exists rather than handing back the one it found, so an operator who lost the
  // ID — or who simply ran the script twice — would otherwise be told that having consented is an
  // error, with no way to recover the value except through the dashboard.
  const existing = await composio.connectedAccounts.list({
    userIds: [userId],
    authConfigIds: [authConfigId],
    statuses: [ACTIVE],
  });
  const connected = existing.items[0];
  if (connected !== undefined) {
    write('');
    write(`This user already has an active Gmail connection; consent is not needed again.`);
    reportConnected(write, connected.id);
    return connected.id;
  }

  const request = await composio.connectedAccounts.link(userId, authConfigId);
  const url = request.redirectUrl ?? null;
  if (url === null) {
    throw new Error('Composio returned no redirect URL; check COMPOSIO_GMAIL_AUTH_CONFIG_ID');
  }

  write('');
  write('Open this URL and grant Gmail access:');
  write(`  ${url}`);
  write('');
  write('Waiting for the consent to complete (5 minute timeout)...');

  const connection = await request.waitForConnection(CONSENT_TIMEOUT_MS);
  reportConnected(write, connection.id);
  return connection.id;
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  loadOpsEnv();
  try {
    const apiKey = requireEnv('COMPOSIO_API_KEY');
    const authConfigId = requireEnv('COMPOSIO_GMAIL_AUTH_CONFIG_ID');
    const userId = optionalEnv('COMPOSIO_USER_ID', 'meridian-demo');

    const mod = (await import('@composio/core')) as unknown as {
      Composio: new (options: {
        apiKey: string;
        toolkitVersions?: Record<string, string>;
      }) => ComposioLike;
    };
    const composio = new mod.Composio({
      apiKey,
      toolkitVersions: { gmail: optionalEnv('COMPOSIO_GMAIL_TOOLKIT_VERSION', 'latest') },
    });

    await connectGmail(composio, userId, authConfigId, (line) => process.stdout.write(`${line}\n`));
  } catch (error) {
    // The message is printed as-is, which is safe because nothing above ever puts a credential
    // into one; the API key is read into a local and passed straight to the constructor.
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
