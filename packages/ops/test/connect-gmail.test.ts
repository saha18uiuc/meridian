import { describe, expect, it, vi } from 'vitest';
import { CONSENT_TIMEOUT_MS, connectGmail } from '../src/connect-gmail.js';

/**
 * The consent command has to survive being run twice.
 *
 * Consent itself is a one-time browser action, but the command around it is not: an operator who
 * loses the printed ID, or who re-runs the script out of caution, must get the ID back rather than
 * an error saying the connection they already hold cannot be created again.
 */

function composio(options: {
  existing?: { id: string }[];
  linkId?: string;
  redirectUrl?: string | null;
}) {
  const link = vi.fn(async () => ({
    redirectUrl:
      options.redirectUrl === undefined ? 'https://consent.example' : options.redirectUrl,
    waitForConnection: async () => ({ id: options.linkId ?? 'ca_new' }),
  }));
  const list = vi.fn(async () => ({ items: options.existing ?? [] }));
  return { composio: { connectedAccounts: { list, link } }, link, list };
}

function collect(): { write: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (line) => lines.push(line), lines };
}

describe('gmail consent', () => {
  it('links and reports the new connection when none exists', async () => {
    const { composio: client, link } = composio({ linkId: 'ca_fresh' });
    const { write, lines } = collect();

    const id = await connectGmail(client, 'meridian-demo', 'ac_1', write);

    expect(id).toBe('ca_fresh');
    expect(link).toHaveBeenCalledWith('meridian-demo', 'ac_1');
    expect(lines.join('\n')).toContain('COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID=ca_fresh');
  });

  it('returns the existing connection without asking for consent again', async () => {
    const { composio: client, link, list } = composio({ existing: [{ id: 'ca_existing' }] });
    const { write, lines } = collect();

    const id = await connectGmail(client, 'meridian-demo', 'ac_1', write);

    expect(id).toBe('ca_existing');
    expect(link).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith({
      userIds: ['meridian-demo'],
      authConfigIds: ['ac_1'],
      statuses: ['ACTIVE'],
    });
    expect(lines.join('\n')).toContain('COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID=ca_existing');
  });

  it('names the auth config when Composio hands back no redirect URL', async () => {
    const { composio: client } = composio({ redirectUrl: null });
    const { write } = collect();

    await expect(connectGmail(client, 'meridian-demo', 'ac_1', write)).rejects.toThrow(
      /COMPOSIO_GMAIL_AUTH_CONFIG_ID/,
    );
  });

  it('gives the browser five minutes, which is the documented consent window', () => {
    expect(CONSENT_TIMEOUT_MS).toBe(300_000);
  });
});
