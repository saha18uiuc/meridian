import type { ReceivingWorkflowInput } from '@meridian/core/temporal-contract';
import type { Client } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSignalWithStartOptions,
  signalWithStartReceiving,
} from '../src/intake/signal-with-start.js';

// The complete workflow argument, not a convenient subset: the wire type is the contract between
// intake and the worker, and a test that passed a partial object would still compile if a field
// were dropped from the real call site.
const input: ReceivingWorkflowInput = {
  executionId: 'e1',
  agentId: 'a1',
  agentVersionId: 'v1',
  deploymentKey: 'inbound-import-receiving',
  versionNo: 1,
  specHash: 'f'.repeat(64),
  gitCommitSha: null,
  businessKey: 'MSKU1234565',
  capabilities: ['mail.read', 'mail.send'],
  toolkitVersion: '20250101_00',
  operatorEmail: 'operator@meridian.local',
  maxConcurrency: 4,
  messageRefs: [],
};
const signalArg = { providerMessageId: 'm1' };

describe('buildSignalWithStartOptions', () => {
  it('sets both workflow-ID policies that the correlation design depends on', () => {
    const options = buildSignalWithStartOptions({
      client: {} as Client,
      workflowId: 'receiving:MSKU1234565',
      input,
      signalArg,
    });
    // USE_EXISTING is what turns a second message into a signal instead of an error;
    // ALLOW_DUPLICATE is what lets a completed key start a fresh run.
    expect(options.workflowIdConflictPolicy).toBe('USE_EXISTING');
    expect(options.workflowIdReusePolicy).toBe('ALLOW_DUPLICATE');
  });

  it('sends the first message as both workflow argument and signal payload', () => {
    const options = buildSignalWithStartOptions({
      client: {} as Client,
      workflowId: 'receiving:MSKU1234565',
      input,
      signalArg,
    });
    expect(options.args).toEqual([input]);
    expect(options.signal).toBe('newMessage');
    expect(options.signalArgs).toEqual([signalArg]);
  });

  it('defaults to the one shared task queue', () => {
    const options = buildSignalWithStartOptions({
      client: {} as Client,
      workflowId: 'receiving:MSKU1234565',
      input,
      signalArg,
    });
    expect(options.taskQueue).toBe('meridian-receiving');
  });
});

describe('signalWithStartReceiving', () => {
  function clientReturning(signaledRunId: string): {
    client: Client;
    signalWithStart: ReturnType<typeof vi.fn>;
  } {
    const signalWithStart = vi.fn().mockResolvedValue({
      workflowId: 'receiving:MSKU1234565',
      signaledRunId,
    });
    return { client: { workflow: { signalWithStart } } as unknown as Client, signalWithStart };
  }

  it('names the workflow by type so intake never imports the workflow module', async () => {
    const { client, signalWithStart } = clientReturning('run-1');
    await signalWithStartReceiving({
      client,
      workflowId: 'receiving:MSKU1234565',
      input,
      signalArg,
    });
    expect(signalWithStart.mock.calls[0]?.[0]).toBe('receivingWorkflow');
  });

  it('reports a fresh run when the returned run ID is new', async () => {
    const { client } = clientReturning('run-2');
    const result = await signalWithStartReceiving({
      client,
      workflowId: 'receiving:MSKU1234565',
      input,
      signalArg,
      knownRunId: 'run-1',
    });
    expect(result).toEqual({
      workflowId: 'receiving:MSKU1234565',
      runId: 'run-2',
      wasAlreadyRunning: false,
    });
  });

  it('reports a signal when the server routed to the recorded run', async () => {
    const { client } = clientReturning('run-1');
    const result = await signalWithStartReceiving({
      client,
      workflowId: 'receiving:MSKU1234565',
      input,
      signalArg,
      knownRunId: 'run-1',
    });
    expect(result.wasAlreadyRunning).toBe(true);
  });

  it('never calls workflow.start', async () => {
    const start = vi.fn();
    const signalWithStart = vi
      .fn()
      .mockResolvedValue({ workflowId: 'receiving:X', signaledRunId: 'r' });
    const client = { workflow: { start, signalWithStart } } as unknown as Client;
    await signalWithStartReceiving({ client, workflowId: 'receiving:X', input, signalArg });
    expect(start).not.toHaveBeenCalled();
  });
});
