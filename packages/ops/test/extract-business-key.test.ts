import { describe, expect, it } from 'vitest';
import {
  extractBusinessKey,
  isValidContainerNumber,
  isValidMawb,
  normalizeMawb,
} from '../src/intake/extract-business-key.js';
import { isPreAlertSubject } from '../src/intake/pre-alert-trigger.js';

describe('ISO 6346 container validation', () => {
  it('accepts real container numbers', () => {
    // Check digits computed from the published ISO 6346 weighting; CSQU3054383 is the example
    // used in the standard itself.
    for (const value of ['MSKU1234565', 'CSQU3054383', 'TGHU7654320']) {
      expect(isValidContainerNumber(value), value).toBe(true);
    }
  });

  it('rejects a number whose check digit is wrong', () => {
    expect(isValidContainerNumber('MSKU1234567')).toBe(false);
  });

  it('rejects a shape that is not a container number', () => {
    expect(isValidContainerNumber('MSKX1234565')).toBe(false);
    expect(isValidContainerNumber('INVOICE12345')).toBe(false);
  });

  it('ignores separators and case', () => {
    expect(isValidContainerNumber('msku 123456-5')).toBe(true);
  });
});

describe('IATA air waybill validation', () => {
  it('accepts a serial whose modulus-7 remainder matches the check digit', () => {
    expect(isValidMawb('020-12345675')).toBe(true);
    expect(normalizeMawb('020 1234567 5')).toBe('020-12345675');
  });

  it('rejects a wrong check digit', () => {
    expect(isValidMawb('020-12345670')).toBe(false);
  });
});

describe('extractBusinessKey', () => {
  it('finds a container number in the subject', () => {
    const result = extractBusinessKey({ subject: 'Arrival notice MSKU 123456-5', body: '' });
    expect(result).toMatchObject({ kind: 'ok', businessKey: 'MSKU1234565', keyKind: 'container' });
  });

  it('finds a key in already-extracted attachment fields', () => {
    const result = extractBusinessKey({
      subject: 'Documents attached',
      body: 'See attached.',
      attachmentFields: { containerNumber: 'CSQU3054383' },
    });
    expect(result).toMatchObject({ kind: 'ok', businessKey: 'CSQU3054383' });
  });

  it('treats the same key written two ways as one key, not a conflict', () => {
    const result = extractBusinessKey({
      subject: 'MSKU1234565',
      body: 'container msku 123456-5 arriving Tuesday',
    });
    expect(result.kind).toBe('ok');
  });

  it('reports a conflict rather than guessing when two valid keys appear', () => {
    const result = extractBusinessKey({
      subject: 'MSKU1234565 and CSQU3054383',
      body: '',
    });
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.candidates.map((candidate) => candidate.value)).toEqual([
      'CSQU3054383',
      'MSKU1234565',
    ]);
  });

  it('reports none when nothing validates', () => {
    const result = extractBusinessKey({
      subject: 'Invoice 1234567 for your records',
      body: 'Reference ABCD1234567',
    });
    expect(result.kind).toBe('none');
  });

  it('does not accept a check-digit failure that merely looks like a container number', () => {
    expect(extractBusinessKey({ subject: 'MSKU1234567' }).kind).toBe('none');
  });
});

describe('the invoice-number fallback', () => {
  it('correlates on the invoice number when no transport key is present', () => {
    const result = extractBusinessKey({
      subject: 'Pre-Alert Documents',
      body: 'Please find invoice INV-1030 attached.',
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.businessKey).toBe('INV-1030');
    expect(result.keyKind).toBe('invoice');
  });

  it('prefers the container number and does not treat the invoice as a rival key', () => {
    const result = extractBusinessKey({
      subject: 'Pre-Alert Documents - container MSKU1234565',
      body: 'Invoice INV-1024 covers two line items.',
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.businessKey).toBe('MSKU1234565');
    expect(result.keyKind).toBe('container');
  });

  it('still reports a conflict when two invoice numbers disagree', () => {
    expect(extractBusinessKey({ subject: 'INV-1024 and INV-1025' }).kind).toBe('conflict');
  });
});

describe("the SOP's subject-line trigger", () => {
  it('accepts both phrases the SOP names, whatever the surrounding subject does', () => {
    expect(isPreAlertSubject('RE: Pre-Alert Documents - container MSKU1234565')).toBe(true);
    expect(isPreAlertSubject('FW: apl usa // pre-alert documentation - MAWB 020-12345675')).toBe(
      true,
    );
  });

  it('leaves alone a message that only talks about pre-alerts', () => {
    expect(isPreAlertSubject('Question about the pre-alert process')).toBe(false);
    expect(isPreAlertSubject('Arrival notice - container MSKU1234565')).toBe(false);
    expect(isPreAlertSubject(null)).toBe(false);
  });
});
