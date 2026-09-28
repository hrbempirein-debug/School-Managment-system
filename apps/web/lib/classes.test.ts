import { describe, it, expect } from 'vitest';
import type { AcdClass, GradeLevel, Section, Subject } from '@sms/contracts';
import {
  CLASS_STATUS_LABELS,
  SECTION_STATUS_LABELS,
  GRADE_LEVEL_STATUS_LABELS,
  SUBJECT_STATUS_LABELS,
  classStatusLabel,
  sectionStatusLabel,
  gradeLevelStatusLabel,
  subjectStatusLabel,
  gradeLevelName,
  classDescriptor,
} from './classes';

const klass: AcdClass = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000000',
  campusId: '00000000-0000-4000-8000-000000000002',
  academicYearId: '00000000-0000-4000-8000-000000000003',
  gradeLevelId: '00000000-0000-4000-8000-000000000005',
  code: 'GR-9A',
  name: 'Grade Nine A',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const gradeLevel: GradeLevel = {
  id: '00000000-0000-4000-8000-000000000005',
  tenantId: klass.tenantId,
  code: 'GR-9',
  name: 'Grade Nine',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const subject: Subject = {
  id: '00000000-0000-4000-8000-000000000006',
  tenantId: klass.tenantId,
  code: 'MATH',
  name: 'Mathematics',
  description: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const section: Section = {
  id: '00000000-0000-4000-8000-000000000004',
  tenantId: klass.tenantId,
  classId: klass.id,
  campusId: klass.campusId,
  academicYearId: klass.academicYearId,
  code: 'A',
  status: 'inactive',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('class & section status labels', () => {
  it('labels every contract status', () => {
    expect(Object.keys(CLASS_STATUS_LABELS)).toEqual(['active', 'inactive']);
    expect(Object.keys(SECTION_STATUS_LABELS)).toEqual(['active', 'inactive']);
    expect(Object.keys(GRADE_LEVEL_STATUS_LABELS)).toEqual(['active', 'inactive']);
    expect(Object.keys(SUBJECT_STATUS_LABELS)).toEqual(['active', 'inactive']);
    expect(classStatusLabel('active')).toBe('Active');
    expect(classStatusLabel('inactive')).toBe('Inactive');
    expect(sectionStatusLabel('inactive')).toBe('Inactive');
    expect(gradeLevelStatusLabel('active')).toBe('Active');
    expect(subjectStatusLabel('inactive')).toBe('Inactive');
  });

  it('falls back to stringification for unknown values', () => {
    expect(classStatusLabel(undefined)).toBe('—');
    expect(sectionStatusLabel('archived')).toBe('archived');
    expect(gradeLevelStatusLabel('archived')).toBe('archived');
    expect(subjectStatusLabel(undefined)).toBe('—');
  });
});

describe('gradeLevelName', () => {
  it('returns the matching grade code', () => {
    expect(gradeLevelName([gradeLevel], klass.gradeLevelId)).toBe('GR-9');
  });

  it('returns a placeholder for null/undefined/unknown levels', () => {
    expect(gradeLevelName([gradeLevel], null)).toBe('—');
    expect(gradeLevelName([gradeLevel], undefined)).toBe('—');
    expect(gradeLevelName([gradeLevel], '00000000-0000-4000-8000-00000000dead')).toBe('—');
  });

  it('keeps subject catalog display independent of class membership', () => {
    expect(`${subject.code} · ${subject.name}`).toBe('MATH · Mathematics');
  });
});

describe('classDescriptor', () => {
  it('joins class and section codes when both are known', () => {
    expect(classDescriptor(klass, section)).toBe('GR-9A · A');
  });

  it('shows the class code alone when no section is known', () => {
    expect(classDescriptor(klass, undefined)).toBe('GR-9A');
  });

  it('reports unplaced when no class is known', () => {
    expect(classDescriptor(undefined, undefined)).toBe('Unplaced');
    expect(classDescriptor(undefined, section)).toBe('Unplaced');
  });
});