import { z } from 'zod';

/**
 * What the frozen specification decides about a vendor's certificate of insurance, as pure
 * functions.
 *
 * Nothing here is shared with the receiving deployment and nothing here belongs in the platform.
 * The contracted minimum, the four fields a certificate must state, and the rule that a lapsed
 * policy is asked about rather than rejected are all this customer's policy, so they live in this
 * customer's generated code.
 *
 * Where the specification is silent, the code does not guess. A certificate with no expiry date is
 * incomplete, not expired; a coverage figure that cannot be read is missing, not zero.
 */

export const CertificateSchema = z
  .object({
    policyNumber: z.string().nullable(),
    insurerName: z.string().nullable(),
    /** USD. Null when the document did not state one, which is not the same as stating zero. */
    coverageAmount: z.number().nullable(),
    /** ISO date. */
    expiryDate: z.string().nullable(),
    additionalInsured: z.string().nullable(),
    sourcePath: z.string(),
  })
  .strict();
export type Certificate = z.infer<typeof CertificateSchema>;

export interface CertificateFinding {
  scope: 'certificate' | 'policy' | 'vendor';
  key: string;
  field: string;
  message: string;
}

/** Rule "Does coverage meet the contracted minimum?" states this figure. */
export const MINIMUM_COVERAGE_USD = 1_000_000;

/** The four the certificate must state. `additionalInsured` is captured and never required. */
export const REQUIRED_CERTIFICATE_FIELDS = [
  'policyNumber',
  'insurerName',
  'coverageAmount',
  'expiryDate',
] as const satisfies readonly (keyof Certificate)[];

const FIELD_LABELS: Record<(typeof REQUIRED_CERTIFICATE_FIELDS)[number], string> = {
  policyNumber: 'policy number',
  insurerName: 'insurer name',
  coverageAmount: 'coverage amount',
  expiryDate: 'expiry date',
};

function stated(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim().length > 0;
}

/** How a certificate is named in a report when its own policy number is the thing that is missing. */
export function certificateKey(certificate: Certificate): string {
  return certificate.policyNumber ?? certificate.sourcePath;
}

export function missingFields(certificate: Certificate): CertificateFinding[] {
  return REQUIRED_CERTIFICATE_FIELDS.filter((field) => !stated(certificate[field])).map(
    (field) => ({
      scope: 'certificate' as const,
      key: certificateKey(certificate),
      field,
      message: `Certificate ${certificateKey(certificate)} does not state a ${FIELD_LABELS[field]}.`,
    }),
  );
}

export function coverageShortfall(certificate: Certificate): CertificateFinding[] {
  const amount = certificate.coverageAmount;
  if (amount === null || amount >= MINIMUM_COVERAGE_USD) return [];
  return [
    {
      scope: 'policy',
      key: certificateKey(certificate),
      field: 'coverageAmount',
      message: `Policy ${certificateKey(certificate)} carries USD ${String(amount)} of general liability cover, below the contracted minimum of USD ${String(MINIMUM_COVERAGE_USD)}.`,
    },
  ];
}

/**
 * Both dates are compared as ISO day strings rather than as `Date` values.
 *
 * A certificate expiring on the renewal date is in force on that date, and parsing to `Date` would
 * put both at midnight UTC and make the comparison depend on the runtime's zone. String comparison
 * on `YYYY-MM-DD` is exact, total, and identical in the workflow sandbox and the eval harness.
 */
export function policyLapsed(certificate: Certificate, renewalDate: string): boolean {
  const expiry = certificate.expiryDate;
  if (expiry === null) return false;
  return expiry.slice(0, 10) < renewalDate.slice(0, 10);
}

export function lapseFinding(certificate: Certificate, renewalDate: string): CertificateFinding[] {
  if (!policyLapsed(certificate, renewalDate)) return [];
  return [
    {
      scope: 'policy',
      key: certificateKey(certificate),
      field: 'expiryDate',
      message: `Policy ${certificateKey(certificate)} expired on ${(certificate.expiryDate ?? '').slice(0, 10)}, before the renewal date ${renewalDate.slice(0, 10)}.`,
    },
  ];
}

export interface CertificateAssessment {
  findings: CertificateFinding[];
  /** Recorded, never a reason to stop. */
  notes: CertificateFinding[];
  incomplete: boolean;
  belowMinimum: boolean;
  lapsed: boolean;
}

export function assessCertificate(
  certificate: Certificate,
  renewalDate: string,
): CertificateAssessment {
  const incomplete = missingFields(certificate);
  // Coverage and expiry are only meaningful once the certificate states them. Reporting "below the
  // minimum" about a figure the document never gave would be the agent inventing a number.
  const shortfall = incomplete.length > 0 ? [] : coverageShortfall(certificate);
  const lapse = incomplete.length > 0 ? [] : lapseFinding(certificate, renewalDate);

  const notes: CertificateFinding[] = stated(certificate.additionalInsured)
    ? []
    : [
        {
          scope: 'certificate',
          key: certificateKey(certificate),
          field: 'additionalInsured',
          message: `Certificate ${certificateKey(certificate)} names no additional insured. This does not hold the renewal.`,
        },
      ];

  return {
    findings: [...incomplete, ...shortfall, ...lapse].sort((a, b) =>
      `${a.key}:${a.field}`.localeCompare(`${b.key}:${b.field}`),
    ),
    notes,
    incomplete: incomplete.length > 0,
    belowMinimum: shortfall.length > 0,
    lapsed: lapse.length > 0,
  };
}

/**
 * The outcome the board assigns.
 *
 * Below the minimum is `rejected` and a lapsed policy is `needs_information`, which is not an
 * inconsistency: too little cover is a decision the vendor has already made, while an out-of-date
 * certificate is usually a document problem the vendor can fix. The board says so on two different
 * arrows, and this function says only what those arrows say.
 */
export function outcomeFor(
  assessment: CertificateAssessment,
): 'ready' | 'needs_information' | 'rejected' {
  if (assessment.belowMinimum) return 'rejected';
  if (assessment.incomplete || assessment.lapsed) return 'needs_information';
  return 'ready';
}
