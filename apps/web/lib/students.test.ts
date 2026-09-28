import { describe, it, expect } from 'vitest';
import {
  STUDENT_STATUS_ORDER,
  STUDENT_STATUS_LABELS,
  genderLabel,
  studentStatusLabel,
  fullName,
} from './students';

describe('student status helpers', () => {
  it('labels every canonical status', () => {
    for (const status of STUDENT_STATUS_ORDER) {
      expect(studentStatusLabel(status)).toBeTruthy();
    }
    expect(Object.keys(STUDENT_STATUS_LABELS)).toHaveLength(5);
  });

  it('falls back to the raw string for unknown values', () => {
    expect(studentStatusLabel('unknown_status')).toBe('unknown_status');
    expect(studentStatusLabel(null)).toBe('—');
  });
});

describe('genderLabel', () => {
  it('labels known genders and blanks', () => {
    expect(genderLabel('male')).toBe('Male');
    expect(genderLabel('other')).toBe('Other');
    expect(genderLabel(null)).toBe('—');
    expect(genderLabel(undefined)).toBe('—');
  });
});

describe('fullName', () => {
  it('joins first and last name, tolerating missing parts', () => {
    expect(fullName('Ali', 'Khan')).toBe('Ali Khan');
    expect(fullName('Ali', '')).toBe('Ali');
    expect(fullName(null, 'Khan')).toBe('Khan');
    expect(fullName('', '')).toBe('—');
  });

  it('never lets a malicious name reach an HTML context', () => {
    expect(fullName('<img src=x onerror=alert(1)>', 'Khan')).toBe(
      '<img src=x onerror=alert(1)> Khan',
    );
  });
});