import type { AcdClass, GradeLevel, Section, Subject } from '@sms/contracts';

/** Canonical human labels for class/section lifecycle statuses (contract-pinned). */
export const CLASS_STATUS_LABELS: Record<AcdClass['status'], string> = {
  active: 'Active',
  inactive: 'Inactive',
};

export const SECTION_STATUS_LABELS: Record<Section['status'], string> = {
  active: 'Active',
  inactive: 'Inactive',
};

export const GRADE_LEVEL_STATUS_LABELS: Record<GradeLevel['status'], string> = {
  active: 'Active',
  inactive: 'Inactive',
};

export const SUBJECT_STATUS_LABELS: Record<Subject['status'], string> = {
  active: 'Active',
  inactive: 'Inactive',
};

/** "GR-9" style descriptor for a class's grade level. */
export function gradeLevelName(gradeLevels: GradeLevel[], id: string | null | undefined): string {
  if (!id) return '—';
  return gradeLevels.find((g) => g.id === id)?.code ?? '—';
}

export function classStatusLabel(status: unknown): string {
  return typeof status === 'string' && status in CLASS_STATUS_LABELS
    ? CLASS_STATUS_LABELS[status as AcdClass['status']]
    : String(status ?? '—');
}

export function gradeLevelStatusLabel(status: unknown): string {
  return typeof status === 'string' && status in GRADE_LEVEL_STATUS_LABELS
    ? GRADE_LEVEL_STATUS_LABELS[status as GradeLevel['status']]
    : String(status ?? '—');
}

export function subjectStatusLabel(status: unknown): string {
  return typeof status === 'string' && status in SUBJECT_STATUS_LABELS
    ? SUBJECT_STATUS_LABELS[status as Subject['status']]
    : String(status ?? '—');
}

export function sectionStatusLabel(status: unknown): string {
  return typeof status === 'string' && status in SECTION_STATUS_LABELS
    ? SECTION_STATUS_LABELS[status as Section['status']]
    : String(status ?? '—');
}

/** "GR-9A · A" style descriptor for a placed enrollment. */
export function classDescriptor(klass: AcdClass | undefined, section: Section | undefined): string {
  if (!klass) return 'Unplaced';
  const parts = [klass.code];
  if (section) parts.push(section.code);
  return parts.join(' · ');
}