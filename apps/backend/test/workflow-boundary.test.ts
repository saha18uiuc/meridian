import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEW_MESSAGE_SIGNAL,
  RECEIVING_WORKFLOW_TYPE,
  TEMPORAL_TASK_QUEUE,
  taskQueueName,
} from '@meridian/core/temporal-contract';
import { describe, expect, it } from 'vitest';
import { activities } from '../src/temporal/activities/index.js';
import { TASK_QUEUE } from '../src/temporal/task-queue.js';
import * as workflows from '../src/temporal/workflows/index.js';

/**
 * A static guard on the workflow bundle.
 *
 * Temporal's determinism rules are not enforced by the type system: a stray `@supabase/supabase-js`
 * import compiles perfectly and then fails at bundle time, or worse, succeeds and produces a
 * workflow that cannot replay. Reading the source is cheap and catches it at the boundary.
 */

const workflowDir = fileURLToPath(new URL('../src/temporal/workflows', import.meta.url));

function sourcesIn(directory: string): { path: string; text: string }[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return sourcesIn(full);
    if (!full.endsWith('.ts')) return [];
    return [{ path: full, text: readFileSync(full, 'utf8') }];
  });
}

const FORBIDDEN = [
  '@supabase/supabase-js',
  '@composio/core',
  'playwright',
  'pdf-parse',
  'tesseract.js',
  'openai',
  'pino',
  'node:fs',
  'node:crypto',
  'p-limit',
];

const sources = sourcesIn(workflowDir);

describe('the workflow bundle', () => {
  it('contains source files to check', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)('never imports %s', (moduleName) => {
    const offenders = sources
      .filter((source) => new RegExp(`from '${moduleName}(/|')`).test(source.text))
      .map((source) => source.path);
    expect(offenders).toEqual([]);
  });

  it('reads the clock only through the single audited call site', () => {
    const offenders = sources
      .filter((source) => !source.path.endsWith('tool-proxies.ts'))
      .filter((source) => /\bDate\.now\(\)|new Date\(\)|Math\.random\(\)/.test(source.text))
      .map((source) => source.path);
    expect(offenders).toEqual([]);
  });

  it('exports the workflow under the type name the intake service uses', () => {
    expect(typeof workflows.receivingWorkflow).toBe('function');
    expect(workflows.receivingWorkflow.name).toBe(RECEIVING_WORKFLOW_TYPE);
  });
});

describe('the shared Temporal contract', () => {
  // Both sides resolve the name the same way rather than both hardcoding it, which is the property
  // that matters: a worker polling one queue while intake starts work on another is a system that
  // accepts every request and runs nothing, with no error anywhere to say so.
  it('agrees with the worker on the task queue', () => {
    expect(TASK_QUEUE).toBe(taskQueueName());
  });

  it('falls back to the shared constant when the environment names no queue', () => {
    expect(taskQueueName({})).toBe(TEMPORAL_TASK_QUEUE);
    expect(taskQueueName({ TEMPORAL_TASK_QUEUE: '  ' })).toBe(TEMPORAL_TASK_QUEUE);
    expect(taskQueueName({ TEMPORAL_TASK_QUEUE: 'meridian-receiving-local' })).toBe(
      'meridian-receiving-local',
    );
  });

  it('names the intake signal the workflow actually handles', () => {
    const source = readFileSync(join(workflowDir, 'receiving-workflow.ts'), 'utf8');
    expect(source).toContain('newMessageSignal');
    expect(NEW_MESSAGE_SIGNAL).toBe('newMessage');
  });
});

describe('the activity surface', () => {
  it('registers every activity the proxies reference', () => {
    // A missing registration is a runtime "activity type not found" that only shows up mid-run,
    // so it is worth catching as a list comparison here.
    const registered = Object.keys(activities).sort();
    expect(registered).toContain('performMailAction');
    expect(registered).toContain('recorderStartStep');
    expect(registered).toContain('documentExtractFields');
    expect(registered).toContain('browserOpen');
  });

  it('does not register process-local housekeeping as a durable activity', () => {
    expect(Object.keys(activities)).not.toContain('releaseExecution');
    expect(Object.keys(activities)).not.toContain('serviceClient');
  });

  it('registers nothing the workflow never calls', () => {
    // The converse of the check above, and the one that actually finds things. A registration with
    // no caller costs nothing at runtime, so nothing fails and nobody notices; it is discovered
    // later as a second implementation of something that already works, drifted away from the copy
    // being used. `modelExtractStructured` sat here for exactly that reason — it duplicated the
    // extraction the documents activity performs, and had already diverged on reasoning effort.
    const called = sources.map((source) => source.text).join('\n');
    const orphans = Object.keys(activities).filter(
      (name) => !new RegExp(`\\.${name}\\(`).test(called),
    );
    expect(orphans).toEqual([]);
  });
});
