import { describe, expect, it } from 'vitest';
import {
  extractBusinessKey,
  isValidContainerNumber,
  isValidMawb,
  normalizeMawb,
} from '../src/intake/extract-business-key.js';

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
