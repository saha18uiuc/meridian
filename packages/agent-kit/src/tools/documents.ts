import type { DocumentTool } from '../contracts.js';

export type { DocumentTool };

/**
 * Normalization lives here rather than in generated agents so that "HTS 3004.90.9260" and
 * "3004909260" cannot be treated as different values by two deployments that happened to be
 * generated a month apart.
 */
export function normalizeScalar(
  value: string,
  type: 'hts' | 'ndc' | 'date' | 'number' | 'text',
): string {
  const trimmed = value.trim();
  switch (type) {
    case 'hts':
      return trimmed.replace(/[^0-9]/g, '');
    case 'ndc':
      return trimmed.replace(/[^0-9]/g, '');
    case 'number':
      return trimmed.replace(/[^0-9.-]/g, '');
    case 'date': {
      const parsed = parseIsoOrCommonDate(trimmed);
      return parsed ?? trimmed;
    }
    case 'text':
      return trimmed.replace(/\s+/g, ' ');
  }
}

/** Accepts ISO, `DD/MM/YYYY`, and `MM/DD/YYYY` only when the day is unambiguous. */
function parseIsoOrCommonDate(value: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso !== null) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (slash === null) return null;
  const first = Number(slash[1]);
  const second = Number(slash[2]);
  const year = slash[3];
  // Only commit when one component cannot be a month; guessing would silently corrupt dates.
  if (first > 12 && second <= 12) {
    return `${year}-${String(second).padStart(2, '0')}-${String(first).padStart(2, '0')}`;
  }
  if (second > 12 && first <= 12) {
    return `${year}-${String(first).padStart(2, '0')}-${String(second).padStart(2, '0')}`;
  }
  return null;
}
