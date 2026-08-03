import { z } from 'zod';
import { RESULT_KINDS } from './primitives.js';

/** The typed decision an agent's `run()` returns. Mirrors `spec_json.outputs.decisionSchema`. */
export const AgentDecisionSchema = z
  .object({
    outcome: z.enum(RESULT_KINDS),
    businessKey: z.string().nullable(),
    reason: z.string(),
    shipmentSummary: z
      .object({
        containerNumber: z.string().nullable(),
        mawb: z.string().nullable(),
        invoiceNumbers: z.array(z.string()),
        batchNumbers: z.array(z.string()),
        goodsCount: z.number().int().nonnegative(),
        validGoodsCount: z.number().int().nonnegative(),
      })
      .strict(),
    missingInformation: z.array(z.string()),
    validationFailures: z.array(
      z
        .object({
          scope: z.enum(['invoice', 'good', 'batch', 'shipment']),
          key: z.string(),
          field: z.string(),
          message: z.string(),
        })
        .strict(),
    ),
    emailResponse: z
      .object({ subject: z.string(), body: z.string(), recipient: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/** The five regulatory identifiers every good must carry (PRD §4 COMPILER RULES). */
export const REQUIRED_GOOD_FIELDS = [
  'htsCode',
  'fdaProductCode',
  'andaNumber',
  'registrationNumber',
  'ndcNumber',
] as const;
export type RequiredGoodField = (typeof REQUIRED_GOOD_FIELDS)[number];

export const GoodSchema = z
  .object({
    lineKey: z.string().min(1),
    description: z.string(),
    batchNumber: z.string().nullable(),
    htsCode: z.string().nullable(),
    fdaProductCode: z.string().nullable(),
    andaNumber: z.string().nullable(),
    registrationNumber: z.string().nullable(),
    ndcNumber: z.string().nullable(),
  })
  .strict();
export type Good = z.infer<typeof GoodSchema>;

export const InvoiceSchema = z
  .object({
    invoiceNumber: z.string().min(1),
    sourcePath: z.string(),
    goods: z.array(GoodSchema),
  })
  .strict();
export type Invoice = z.infer<typeof InvoiceSchema>;

export const CoaSchema = z
  .object({ batchNumber: z.string().min(1), sourcePath: z.string() })
  .strict();
export type Coa = z.infer<typeof CoaSchema>;

export const ShipmentInputSchema = z
  .object({
    containerNumber: z.string().nullable(),
    mawb: z.string().nullable(),
    invoices: z.array(InvoiceSchema),
    coas: z.array(CoaSchema),
  })
  .strict();
export type ShipmentInput = z.infer<typeof ShipmentInputSchema>;
