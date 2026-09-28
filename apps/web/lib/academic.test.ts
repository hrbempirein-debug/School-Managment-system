import { describe, it, expect } from 'vitest';
import { isDateWithinRange, parseIsoDate, todayIsoDate } from './academic';

describe('academic date helpers', () => {
  it('accepts term dates strictly inside the year', () => {
    expect(isDateWithinRange('2026-02-01', '2026-06-30', '2026-01-01', '2026-12-31')).toBe(true);
  });

  it('accepts term dates equal to the year bounds', () => {
    expect(isDateWithinRange('2026-01-01', '2026-12-31', '2026-01-01', '2026-12-31')).toBe(true);
  });

  it('rejects a term that starts before the year', () => {
    expect(isDateWithinRange('2025-02-01', '2026-06-30', '2026-01-01', '2026-12-31')).toBe(false);
  });

  it('rejects a term that ends after the year', () => {
    expect(isDateWithinRange('2026-02-01', '2027-06-30', '2026-01-01', '2026-12-31')).toBe(false);
  });

  it('rejects inverted dates (start >= end)', () => {
    expect(isDateWithinRange('2026-06-30', '2026-02-01', '2026-01-01', '2026-12-31')).toBe(false);
  });

  it('rejects unparseable values', () => {
    expect(isDateWithinRange('nonsense', '2026-06-30', '2026-01-01', '2026-12-31')).toBe(false);
  });

  it('parses ISO dates but not garbage', () => {
    expect(parseIsoDate('2026-01-01')).toBeTruthy();
    expect(parseIsoDate('garbage')).toBeNull();
  });

  it('todayIsoDate returns YYYY-MM-DD', () => {
    expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});