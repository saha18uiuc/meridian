import { z } from 'zod';

export const AGENT_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export const AgentStatusSchema = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Maps directly to `generated-agents/<deployment_key>/`, so the shape is constrained. */
export const DEPLOYMENT_KEY_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
export const DeploymentKeySchema = z
  .string()
  .regex(DEPLOYMENT_KEY_PATTERN, 'INVALID_DEPLOYMENT_KEY');

export const AgentSchema = z
  .object({
    agentId: z.uuid(),
    whiteboardId: z.uuid(),
    deploymentKey: DeploymentKeySchema,
    name: z.string(),
    status: AgentStatusSchema,
    activeAgentVersionId: z.uuid().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;

export const CreateAgentRequestSchema = z
  .object({
    whiteboardId: z.uuid(),
    deploymentKey: DeploymentKeySchema,
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const SetAgentStatusRequestSchema = z
  .object({ status: z.enum(['active', 'paused', 'archived']) })
  .strict();
export type SetAgentStatusRequest = z.infer<typeof SetAgentStatusRequestSchema>;

export const ActivationRequestSchema = z.object({ agentVersionId: z.uuid() }).strict();
export type ActivationRequest = z.infer<typeof ActivationRequestSchema>;

export const ActivationResponseSchema = z
  .object({
    agentId: z.uuid(),
    activeAgentVersionId: z.uuid().nullable(),
    previousActiveAgentVersionId: z.uuid().nullable(),
    status: AgentStatusSchema,
  })
  .strict();
export type ActivationResponse = z.infer<typeof ActivationResponseSchema>;
