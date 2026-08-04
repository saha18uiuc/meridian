import { z } from 'zod';
import { RESULT_KINDS } from './primitives.js';

/**
 * The envelope every agent's `run()` returns, and nothing more.
 *
 * This file used to describe pharmaceutical import shipments: `Good`, `Invoice`, `Coa`,
 * `ShipmentInput`, and a decision carrying a `shipmentSummary` of container numbers and batch
 * counts. All of that lived in the package every deployment shares, which meant the second customer
 * would have inherited the first customer's nouns as platform types. It now lives in the generated
 * agent that actually has an opinion about shipments.
 *
 * What is left is the part that is true of any process a board can describe. A run ends at one of
 * the outcomes its board declares. It was correlated by some key, or by none. It has a reason a
 * person can read. It summarises whatever it was about, and it lists what it found. Whether a
 * finding concerns a `good` or a `policy_document` or a `candidate` is the deployment's vocabulary,
 * which is why `scope` is a string here and an enum nowhere.
 */

/** One thing the process noticed. Deliberately not named "failure": a finding may be benign. */
export const DecisionFindingSchema = z
  .object({
    /** The deployment's own noun for what this is about. */
    scope: z.string(),
    /** Which one — a line key, an invoice number, a document ID. */
    key: z.string(),
    /** Which attribute of it. */
    field: z.string(),
    /** The sentence a person reads. */
    message: z.string(),
  })
  .strict();
export type DecisionFinding = z.infer<typeof DecisionFindingSchema>;

export const AgentDecisionSchema = z
  .object({
    outcome: z.enum(RESULT_KINDS),
    businessKey: z.string().nullable(),
    reason: z.string(),
    /**
     * The deployment's own summary of the run. Open by construction: the platform records it,
     * hashes it, and shows it, and never needs to understand it.
     */
    summary: z.record(z.string(), z.unknown()),
    findings: z.array(DecisionFindingSchema),
    emailResponse: z
      .object({ subject: z.string(), body: z.string(), recipient: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
