import { describe, it, expect } from 'vitest';
import { formatBytes, formatIsoDate, formatDateTime } from './format';

describe('formatBytes', () => {
  it('renders bytes below 1 KB as plain bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('renders KB/MB/GB with one decimal place', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('integrates the 10 MiB document ceiling as "10.0 MB"', () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });

  it('is safe for negative or NaN inputs', () => {
    expect(formatBytes(-3)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatIsoDate', () => {
  it('truncates ISO date-times to the date part', () => {
    expect(formatIsoDate('2026-09-24T14:03:00.000Z')).toBe('2026-09-24');
  });

  it('passes through plain YYYY-MM-DD and null', () => {
    expect(formatIsoDate('2026-09-24')).toBe('2026-09-24');
    expect(formatIsoDate(null)).toBe('—');
    expect(formatIsoDate(undefined)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('renders UTC date-time deterministically', () => {
    expect(formatDateTime('2026-09-24T14:03:00.000Z')).toBe('2026-09-24 14:03');
  });

  it('returns the raw string for invalid values', () => {
    expect(formatDateTime('garbage')).toBe('garbage');
    expect(formatDateTime(null)).toBe('—');
  });
});