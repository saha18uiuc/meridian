import type { Logger } from '@meridian/core';

export interface KeepAlive {
  close: () => void;
}

/**
 * Requests the worker's own public URL on a timer, so a host that sleeps idle services does not
 * sleep this one.
 *
 * Free tiers measure idleness in *inbound HTTP requests*. That is a reasonable proxy for a web
 * server and a wrong one for a Temporal worker, whose entire working life is outbound long-polls
 * against a task queue: it can be busy running a workflow and still look, to the host, like nothing
 * has touched it in an hour. The service is then suspended, the poll dies with it, and every
 * execution stalls in `running` with no error anywhere — the failure is silence.
 *
 * The URL has to be the public one. A request to `127.0.0.1` never reaches the platform's router
 * and so is not traffic as far as the platform is concerned; that mistake produces a keep-alive
 * that runs perfectly and keeps nothing alive.
 *
 * The alternative is an external cron service pinging `/healthz`, which works but adds a third-party
 * account to the deployment for the sake of one HTTP request. This keeps the deployment's
 * dependencies to the ones that do real work.
 */
export function startKeepAlive(url: string, intervalMs: number, logger: Logger): KeepAlive {
  const timer = setInterval(() => {
    void fetch(`${url}`, { method: 'GET' }).then(
      (response) => {
        if (!response.ok) logger.warn({ url, status: response.status }, 'keep-alive ping refused');
      },
      (error: unknown) => {
        // Worth a line, but not worth stopping for: the next tick is the retry, and a worker that
        // exits because one ping failed is strictly worse than one that sleeps.
        logger.warn({ error, url }, 'keep-alive ping failed');
      },
    );
  }, intervalMs);

  // Nothing should stay running for the sake of this timer. The worker's own run loop is what holds
  // the process open, and once it stops this has no reason to delay exit.
  timer.unref();

  return {
    close: () => {
      clearInterval(timer);
    },
  };
}
