import { taskQueueName } from '@meridian/core';

/**
 * The queue this worker polls, resolved once at startup.
 *
 * One queue per *environment*, not one per deployment: every generated version is bundled into the
 * same worker, so splitting by agent would only fragment capacity. What does need separating is two
 * environments that share a Temporal namespace, which is why the name is configurable at all —
 * `taskQueueName` explains what goes wrong when it is not.
 *
 * The resolution lives in `@meridian/core` because the intake service has to name the same queue
 * without being able to import anything from this app.
 */
export const TASK_QUEUE = taskQueueName();

export { receivingWorkflowId } from '@meridian/core';
