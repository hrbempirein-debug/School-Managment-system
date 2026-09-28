import { describe, it, expect } from 'vitest';
import {
  importOutcomeSummary,
  importRowStatusLabel,
  importStatusLabel,
  isImportProcessed,
  isImportTerminal,
} from './imports';

describe('import status helpers', () => {
  it('labels lifecycle statuses', () => {
    expect(importStatusLabel('submitted')).toBe('Submitted');
    expect(importStatusLabel('processing')).toBe('Processing');
    expect(importStatusLabel('completed')).toBe('Completed');
    expect(importStatusLabel('failed')).toBe('Failed');
    expect(importStatusLabel('bogus')).toBe('bogus');
  });

  it('labels row result buckets', () => {
    expect(importRowStatusLabel('created')).toBe('Created');
    expect(importRowStatusLabel('duplicate')).toBe('Duplicate');
    expect(importRowStatusLabel('conflict')).toBe('Conflict');
    expect(importRowStatusLabel('rejected')).toBe('Rejected');
  });

  it('treats completed and failed as terminal (polling stop points)', () => {
    expect(isImportTerminal('completed')).toBe(true);
    expect(isImportTerminal('failed')).toBe(true);
    expect(isImportTerminal('submitted')).toBe(false);
    expect(isImportTerminal('processing')).toBe(false);
  });

  it('only completed imports show processed row results', () => {
    expect(isImportProcessed('completed')).toBe(true);
    expect(isImportProcessed('failed')).toBe(false);
    expect(isImportProcessed('processing')).toBe(false);
  });

  it('builds a plain-text outcome summary that never carries markup', () => {
    const imp = {
      totalRows: 100,
      createdCount: 90,
      duplicateCount: 4,
      conflictCount: 3,
      rejectedCount: 3,
      status: 'completed' as const,
    };
    expect(importOutcomeSummary(imp)).toBe(
      '90 created, 4 duplicate, 3 conflict, 3 rejected (100 rows)',
    );
    expect(importOutcomeSummary(imp)).not.toMatch(/<[^>]+>/);
  });
});

describe('import outcome summary against CSV injection values', () => {
  it('renders database error strings as inert text with no tags', () => {
    const imp = {
      totalRows: 1,
      createdCount: 0,
      duplicateCount: 0,
      conflictCount: 0,
      rejectedCount: 1,
      status: 'completed' as const,
    };
    const malicious = '=HYPERLINK("http://evil.example", "click me")';
    expect(importOutcomeSummary({ ...imp, errorSummary: malicious })).toBe(
      '0 created, 0 duplicate, 0 conflict, 1 rejected (1 rows)',
    );
  });

  it('failed summary echoes only the server-provided plain-text reason', () => {
    const imp = {
      totalRows: 0,
      createdCount: 0,
      duplicateCount: 0,
      conflictCount: 0,
      rejectedCount: 0,
      status: 'failed' as const,
      errorSummary: 'CSV is missing required columns',
    };
    expect(importOutcomeSummary(imp)).toBe('CSV is missing required columns');
    expect(importOutcomeSummary(imp)).not.toMatch(/<[^>]+>/);
  });

  it('defaults an empty failed summary to a safe literal', () => {
    const imp = {
      totalRows: 0,
      createdCount: 0,
      duplicateCount: 0,
      conflictCount: 0,
      rejectedCount: 0,
      status: 'failed' as const,
      errorSummary: null,
    };
    expect(importOutcomeSummary(imp)).toBe('Import failed');
  });
});