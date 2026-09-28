import { describe, it, expect } from 'vitest';
import {
  ADMISSION_STATUS_ORDER,
  canApproveAdmission,
  canEditAdmission,
  canRejectAdmission,
  canReviewAdmission,
  canSubmitAdmission,
  canWithdrawAdmission,
  isAdmissionTerminal,
} from './admissions';

describe('admission transition predicates', () => {
  it('submit is allowed only from draft', () => {
    expect(canSubmitAdmission('draft')).toBe(true);
    for (const s of ['submitted', 'under_review', 'accepted', 'rejected', 'withdrawn']) {
      expect(canSubmitAdmission(s)).toBe(false);
    }
  });

  it('review is allowed only from submitted', () => {
    expect(canReviewAdmission('submitted')).toBe(true);
    expect(canReviewAdmission('draft')).toBe(false);
    expect(canReviewAdmission('under_review')).toBe(false);
  });

  it('approve and reject are allowed from submitted and under_review', () => {
    expect(canApproveAdmission('submitted')).toBe(true);
    expect(canApproveAdmission('under_review')).toBe(true);
    expect(canApproveAdmission('draft')).toBe(false);
    expect(canRejectAdmission('submitted')).toBe(true);
    expect(canRejectAdmission('under_review')).toBe(true);
    expect(canRejectAdmission('accepted')).toBe(false);
  });

  it('withdraw is allowed from draft, submitted and under_review only', () => {
    for (const s of ['draft', 'submitted', 'under_review']) {
      expect(canWithdrawAdmission(s)).toBe(true);
    }
    for (const s of ['accepted', 'rejected', 'withdrawn']) {
      expect(canWithdrawAdmission(s)).toBe(false);
    }
  });

  it('editable only while not terminal', () => {
    expect(canEditAdmission('submitted')).toBe(true);
    expect(isAdmissionTerminal('accepted')).toBe(true);
    expect(isAdmissionTerminal('rejected')).toBe(true);
    expect(isAdmissionTerminal('withdrawn')).toBe(true);
    expect(isAdmissionTerminal('draft')).toBe(false);
  });

  it('guards unknown/garbage status inputs', () => {
    for (const fn of [
      canSubmitAdmission,
      canReviewAdmission,
      canApproveAdmission,
      canRejectAdmission,
      canWithdrawAdmission,
      canEditAdmission,
      isAdmissionTerminal,
    ]) {
      expect(fn('bogus')).toBe(false);
      expect(fn(null)).toBe(false);
    }
  });

  it('covers every canonical status in order', () => {
    expect(ADMISSION_STATUS_ORDER).toEqual([
      'draft',
      'submitted',
      'under_review',
      'accepted',
      'rejected',
      'withdrawn',
    ]);
  });
});