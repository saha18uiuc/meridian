export * from './actions.js';
export * from './browser.js';
export * from './documents.js';
export * from './execution-recorder.js';
export * from './mail.js';
export * from './model.js';
export { releaseExecution, resetRuntimeForTests, serviceClient } from './runtime.js';
export type { ActivityEnvelope } from './runtime.js';

import * as actions from './actions.js';
import * as browser from './browser.js';
import * as documents from './documents.js';
import * as recorder from './execution-recorder.js';
import * as mail from './mail.js';

/**
 * The activity surface the worker registers and the workflow proxies.
 *
 * `releaseExecution` and the runtime helpers are intentionally excluded: they are process-local
 * housekeeping, not durable operations, and registering them would make them look replayable.
 * `modelExtractStructured` is excluded for the same reason from the other direction — it is real
 * I/O, but the workflow reaches it through `documents.extractFields`, so registering it as well
 * would advertise a durable operation no proxy calls. `workflow-boundary.test.ts` holds the line.
 */
export const activities = {
  ...mail,
  ...documents,
  ...browser,
  ...recorder,
  performMailAction: actions.performMailAction,
  recordHumanDecisionRequest: actions.recordHumanDecisionRequest,
};

export type Activities = typeof activities;
