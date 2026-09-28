import { describe, it, expect } from 'vitest';
import { HttpError } from '@sms/core';
import { mapDomainError } from './util.js';

interface PgErrorLike {
  code?: string;
  message?: string;
}

function pgError(code: string, message = 'raw pg detail'): PgErrorLike {
  return { code, message };
}

describe('mapDomainError: API error envelope correctness', () => {
  it('passes an HttpError through unchanged', () => {
    const err = new HttpError('Custom', { status: 402, code: 'custom' });
    expect(mapDomainError(err)).toBe(err);
  });

  it('maps unique-violation 23505 to a generic 409 conflict (no raw PG text)', () => {
    const mapped = mapDomainError(pgError('23505', 'duplicate key value violates unique constraint "campuses_tenant_code_uq"'));
    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('conflict');
    expect(mapped.message).toBe('A record with this unique value already exists');
  });

  it('maps FK-violation 23503 to a 404 not_found', () => {
    const mapped = mapDomainError(pgError('23503'));
    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped.status).toBe(404);
    expect(mapped.code).toBe('not_found');
    expect(mapped.message).toBe('Related record not found');
  });

  it('maps check-violation 23514 to a 400 validation_error', () => {
    const mapped = mapDomainError(pgError('23514'));
    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe('validation_error');
  });

  it.each([
    ['academic_year_has_open_terms', '/cannot close academic year with open terms/i', 409, 'Cannot close academic year with open terms'],
    ['term_outside_academic_year', '/term dates must fall inside the academic year/i', 409, 'Term dates must fall inside the academic year'],
    ['overlapping_open_terms', '/overlapping open terms within academic year/i', 409, 'Overlapping open terms within academic year'],
    ['term_in_closed_academic_year', '/cannot open a term inside a closed academic year/i', 409, 'Cannot open a term inside a closed academic year'],
    ['invalid_academic_year_transition', '/invalid academic year status transition/i', 409, 'Invalid academic year status transition'],
    ['academic_year_not_found', '/academic year not found for term/i', 404, 'Academic year not found for term'],
  ])('maps known 55000 domain guardrail %s to a stable envelope', (code, _re, status, message) => {
    const raw = `controlling INFO: ${message} (passed check#1)`;
    const mapped = mapDomainError({ code: '55000', message: raw });
    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped.status).toBe(status);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toBe(message);
    expect(mapped.message).not.toContain('passed check#1');
  });

  it.each([
    ['mark_publication_marker_immutable', 'the publication marker of a mark is immutable: it records the exam whose publication froze this mark', 'The publication marker of a mark cannot be changed'],
    ['mark_published_frozen', 'a published mark is frozen: it cannot be moved, re-homed, re-attributed or hidden; only the correction workflow may change its value', 'A published mark cannot be moved, re-attributed or hidden; use the correction workflow'],
    ['exam_published_closed_to_marks', 'a mark cannot be moved into a published exam; a published result is closed to new marks', 'A published result is closed to new marks'],
    ['mark_published_immutable', 'a published mark cannot be deleted; correct it through the correction workflow so the change is recorded', 'A published mark cannot be deleted; correct it through the correction workflow'],
    ['report_card_published_immutable', 'a published report card cannot be hard-deleted; supersede it with a new version', 'A published report card cannot be hard-deleted; supersede it with a new version'],
    ['exam_scale_frozen_in_status', 'the grading scale of an exam in status grading cannot be changed', 'The grading scale of this exam is frozen in its current status'],
    ['exam_scale_frozen_has_marks', 'the grading scale of an exam cannot be changed once marks exist', 'The grading scale cannot be changed once the exam has marks'],
    ['exam_publication_needs_timestamp', 'publication requires published_at', 'Publication requires a publication timestamp'],
    ['grading_band_point_required', 'grading band gradePoint is required', 'Each grading band requires a grade point'],
    ['grading_band_duplicate_label', 'grading band label A appears more than once in this scale', 'Grading band labels must be unique within a scale'],
    ['grading_bands_result_immutable', 'grading bands that produced a result cannot be edited; create a new version', 'These grading bands have produced a result and cannot be edited; create a new version'],
  ])('maps migration 0017 trigger message to %s', (code, raw, message) => {
    // The DB interpolates arguments into these messages, so the mapping must key
    // off the stable prefix and strip whatever the server appended.
    const mapped = mapDomainError({ code: '55000', message: `CONTEXT: ${raw}` });
    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toBe(message);
    expect(mapped.message).not.toContain('CONTEXT:');
  });

  it('maps an UNMATCHED 55000 to a generic 409 conflict without leaking the raw PG message', () => {
    const mapped = mapDomainError(pgError('55000', 'some future trigger said something SECRET-42'));
    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('conflict');
    expect(mapped.message).toBe('The requested operation conflicts with domain rules');
    expect(mapped.message).not.toContain('SECRET-42');
  });

  it('rethrows unknown PostgreSQL error codes (global handler masks them)', () => {
    expect(() => mapDomainError(pgError('XX000'))).toThrow();
  });
});