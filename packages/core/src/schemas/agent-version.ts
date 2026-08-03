import { z } from 'zod';

export const AGENT_VERSION_STATUSES = ['generated', 'evaluating', 'approved', 'failed'] as const;
export const AgentVersionStatusSchema = z.enum(AGENT_VERSION_STATUSES);
export type AgentVersionStatus = z.infer<typeof AgentVersionStatusSchema>;

export const GIT_SHA1_PATTERN = /^[0-9a-f]{40}$/;
export const GitSha1Schema = z.string().regex(GIT_SHA1_PATTERN, 'INVALID_GIT_SHA');

/** `generated-agents/<deployment_key>/v<NNN>` with a zero-padded three-digit version. */
export const CODE_PATH_PATTERN = /^generated-agents\/[a-z][a-z0-9-]{2,63}\/v\d{3}$/;

export function buildCodePath(deploymentKey: string, versionNo: number): string {
  return `generated-agents/${deploymentKey}/v${String(versionNo).padStart(3, '0')}`;
}

export const AgentVersionSchema = z
  .object({
    agentVersionId: z.uuid(),
    agentId: z.uuid(),
    specId: z.uuid(),
    versionNo: z.number().int().positive(),
    parentAgentVersionId: z.uuid().nullable(),
    status: AgentVersionStatusSchema,
    codePath: z.string().regex(CODE_PATH_PATTERN),
    gitCommitSha: GitSha1Schema.nullable(),
    buildManifestJson: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
    approvedAt: z.string().nullable(),
  })
  .strict();
export type AgentVersion = z.infer<typeof AgentVersionSchema>;

export const ReserveVersionRequestSchema = z
  .object({ specId: z.uuid(), parentAgentVersionId: z.uuid().optional() })
  .strict();
export type ReserveVersionRequest = z.infer<typeof ReserveVersionRequestSchema>;

export const ReserveVersionResponseSchema = z
  .object({
    agentVersionId: z.uuid(),
    versionNo: z.number().int().positive(),
    codePath: z.string(),
    specHash: z.string().length(64),
    /**
     * The literal `/goal` string the operator runs in Cursor/Codex. This route reserves a row and
     * returns a command; it never invokes a coding agent, writes files, or runs an LLM (A14).
     */
    operatorCommand: z.string(),
  })
  .strict();
export type ReserveVersionResponse = z.infer<typeof ReserveVersionResponseSchema>;

export const TransitionRequestSchema = z
  .object({ status: z.enum(['evaluating', 'approved', 'failed']) })
  .strict();
export type TransitionRequest = z.infer<typeof TransitionRequestSchema>;
