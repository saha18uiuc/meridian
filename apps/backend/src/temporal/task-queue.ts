import { TEMPORAL_TASK_QUEUE } from '@meridian/core';

/**
 * One task queue for the whole system. Adding a second would only be worth it once different
 * deployments needed different worker capacity or different host capabilities, and neither is true
 * here — every generated version is bundled into the same worker.
 *
 * The literal lives in `@meridian/core` because the intake service names the same queue without
 * being able to import anything from this app.
 */
export const TASK_QUEUE = TEMPORAL_TASK_QUEUE;

export { receivingWorkflowId } from '@meridian/core';
