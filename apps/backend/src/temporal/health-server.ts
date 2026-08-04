import { createServer, type Server } from 'node:http';
import { registeredVersions } from '@meridian/agent-kit';
import { AGENT_REGISTRY } from '@meridian/generated-agents';
import { TASK_QUEUE } from './task-queue.js';

/**
 * A liveness endpoint that reports which agent versions this worker can actually run.
 *
 * That list is the operationally interesting part: because the registry is static, a worker that
 * was not restarted after a generation run will happily accept tasks it cannot serve, and this is
 * the cheapest way to notice.
 */
export function startHealthServer(port: number): Server {
  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      // `registeredVersions`, not `registeredAgents`: they are versions, and the name has to match
      // what `pnpm health` reads. It did not, so the registry-consistency check silently compared
      // against `undefined` and reported a healthy worker as having nothing registered — which is
      // precisely the condition this endpoint exists to make visible.
      const body = JSON.stringify({
        status: 'ok',
        taskQueue: TASK_QUEUE,
        registeredVersions: registeredVersions(AGENT_REGISTRY),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(port);
  return server;
}
