import type { Student } from '@sms/contracts';

type StudentStatus = Student['status'];
type StudentGender = Exclude<Student['gender'], null>;

/** Canonical human labels for the student lifecycle statuses (contract-pinned). */
export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  applicant: 'Applicant',
  active: 'Active',
  transferred: 'Transferred',
  graduated: 'Graduated',
  alumni: 'Alumni',
};

export const STUDENT_STATUS_ORDER: readonly StudentStatus[] = [
  'applicant',
  'active',
  'transferred',
  'graduated',
  'alumni',
];

export const STUDENT_GENDER_LABELS: Record<StudentGender, string> = {
  male: 'Male',
  female: 'Female',
  other: 'Other',
};

export function studentStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in STUDENT_STATUS_LABELS) {
    return STUDENT_STATUS_LABELS[status as StudentStatus];
  }
  return String(status ?? '—');
}

export function genderLabel(gender: unknown): string {
  if (typeof gender === 'string' && gender in STUDENT_GENDER_LABELS) {
    return STUDENT_GENDER_LABELS[gender as StudentGender];
  }
  if (gender == null) return '—';
  return String(gender);
}

export function fullName(firstName: unknown, lastName: unknown): string {
  return [firstName, lastName].filter((p) => typeof p === 'string' && p.trim() !== '').join(' ') || '—';
}