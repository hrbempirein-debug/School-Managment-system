import { describe, it, expect } from 'vitest';
import type { HomeworkDetail, HomeworkListResponse } from '@sms/contracts';
import {
  homeworkBodyPreview,
  isPortalRole,
  loadPortalViews,
  portalEmptyMessage,
  sortPortalHomework,
} from './homework-portal';

function hw(over: Partial<HomeworkDetail> & { id: string }): HomeworkDetail {
  return {
    tenantId: 't',
    classId: 'c',
    subjectId: 's',
    teacherUserId: 'u',
    campusId: 'ca',
    academicYearId: 'y',
    title: 'T',
    body: null,
    dueAt: null,
    attachments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('homework chat portal helpers', () => {
  it('isPortalRole accepts only parent and student', () => {
    expect(isPortalRole('parent')).toBe(true);
    expect(isPortalRole('student')).toBe(true);
    expect(isPortalRole('staff')).toBe(false);
    expect(isPortalRole('teacher')).toBe(false);
    expect(isPortalRole('none')).toBe(false);
  });

  it('portalEmptyMessage gives honest role-specific states', () => {
    expect(portalEmptyMessage('student')).toContain('enrolled');
    expect(portalEmptyMessage('parent')).toContain('guardian');
    expect(portalEmptyMessage('none')).toContain('homework access');
  });

  it('sorts soonest due first, then most recently created, then id', () => {
    const late = hw({ id: 'late', dueAt: '2026-12-01T00:00:00.000Z', createdAt: '2026-03-01T00:00:00.000Z' });
    const soon = hw({ id: 'soon', dueAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z' });
    const noDueOld = hw({ id: 'noold', dueAt: null, createdAt: '2026-01-01T00:00:00.000Z' });
    const noDueNew = hw({ id: 'nonew', dueAt: null, createdAt: '2026-02-01T00:00:00.000Z' });
    const result = sortPortalHomework([noDueNew, late, soon, noDueOld]);
    expect(result.map((h) => h.id)).toEqual(['soon', 'late', 'nonew', 'noold']);
  });

  it('previews long bodies without mutating short ones', () => {
    expect(homeworkBodyPreview(null)).toBeNull();
    expect(homeworkBodyPreview('short body')).toBe('short body');
    const long = 'a'.repeat(300);
    expect(homeworkBodyPreview(long, 20)).toBe('a'.repeat(20) + '…');
  });

  it('loadPortalViews builds ordered per-class views with the injected fetcher', async () => {
    const fetchList = async (classId: string): Promise<HomeworkListResponse> => {
      if (classId === 'cA') {
        return {
          items: [hw({ id: 'a2', dueAt: '2026-10-01T00:00:00.000Z' }), hw({ id: 'a1', dueAt: '2026-02-01T00:00:00.000Z' })],
          total: 2,
        };
      }
      return { items: [], total: 0 };
    };
    const classes = [
      { id: 'cA', code: '1A', name: 'One A', campusId: 'ca', academicYearId: 'y' },
      { id: 'cB', code: '1B', name: 'One B', campusId: 'cb', academicYearId: 'y' },
    ];
    const views = await loadPortalViews(classes, fetchList);
    expect(views).toHaveLength(2);
    expect(views[0]!.class.code).toBe('1A');
    expect(views[0]!.homework.map((h) => h.id)).toEqual(['a1', 'a2']);
    expect(views[0]!.total).toBe(2);
    expect(views[1]!.homework).toEqual([]);
    expect(views[1]!.total).toBe(0);
  });
});