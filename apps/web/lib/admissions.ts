import type { AdmissionApplication } from '@sms/contracts';

type AdmissionStatus = AdmissionApplication['status'];

/**
 * Canonical labels and transition predicates for admission applications.
 * Each predicate mirrors ONE allowed source set from the API lifecycle
 * (admission-applications.ts) so the UI can never offer an action the API
 * would reject with `invalid_admission_transition`.
 */

export const ADMISSION_STATUS_LABELS: Record<AdmissionStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const ADMISSION_STATUS_ORDER: readonly AdmissionStatus[] = [
  'draft',
  'submitted',
  'under_review',
  'accepted',
  'rejected',
  'withdrawn',
];

export function admissionStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in ADMISSION_STATUS_LABELS) {
    return ADMISSION_STATUS_LABELS[status as AdmissionStatus];
  }
  return String(status ?? '—');
}

const EDITABLE: ReadonlySet<AdmissionStatus> = new Set(['draft', 'submitted', 'under_review']);
const APPROVABLE: ReadonlySet<AdmissionStatus> = new Set(['submitted', 'under_review']);
const REVIEWABLE: ReadonlySet<AdmissionStatus> = new Set(['submitted']);
const WITHDRAWABLE: ReadonlySet<AdmissionStatus> = new Set(['draft', 'submitted', 'under_review']);

function isStatus(status: unknown): status is AdmissionStatus {
  return typeof status === 'string' && (status as string) in ADMISSION_STATUS_LABELS;
}

export function canSubmitAdmission(status: unknown): boolean {
  return isStatus(status) && status === 'draft';
}

export function canReviewAdmission(status: unknown): boolean {
  return isStatus(status) && REVIEWABLE.has(status);
}

export function canApproveAdmission(status: unknown): boolean {
  return isStatus(status) && APPROVABLE.has(status);
}

export function canRejectAdmission(status: unknown): boolean {
  return isStatus(status) && APPROVABLE.has(status);
}

export function canWithdrawAdmission(status: unknown): boolean {
  return isStatus(status) && WITHDRAWABLE.has(status);
}

/** Application PATCH is only allowed while the application is still editable. */
export function canEditAdmission(status: unknown): boolean {
  return isStatus(status) && EDITABLE.has(status);
}

/** accepted / rejected / withdrawn are terminal — no further actions. */
export function isAdmissionTerminal(status: unknown): boolean {
  return isStatus(status) && !EDITABLE.has(status);
}