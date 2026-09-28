import { HttpError } from '@sms/core';
import { paginationQuerySchema, type PaginationQuery } from '@sms/contracts';

const DOMAIN_CONFLICT_MESSAGE = 'The requested operation conflicts with domain rules';

/**
 * Pre-sanctioned mapping of the 0004 DATABASE guardrail to deterministic API
 * errors. DB constraints deliberately reject invalid domain state even if the
 * API layer is bypassed; these entries turn the raw PG errors into stable,
 * documented error codes AND stable client-facing messages. The messages are
 * our canonical copies of the trigger text, never the raw PostgreSQL string,
 * so clients never receive DB-authored error text.
 */
const DOMAIN_ERRORS: ReadonlyArray<{ re: RegExp; code: string; status: number; message: string }> = [
  { re: /cannot close academic year with open terms/i, code: 'academic_year_has_open_terms', status: 409, message: 'Cannot close academic year with open terms' },
  { re: /term dates must fall inside the academic year/i, code: 'term_outside_academic_year', status: 409, message: 'Term dates must fall inside the academic year' },
  { re: /overlapping open terms within academic year/i, code: 'overlapping_open_terms', status: 409, message: 'Overlapping open terms within academic year' },
  { re: /cannot open a term inside a closed academic year/i, code: 'term_in_closed_academic_year', status: 409, message: 'Cannot open a term inside a closed academic year' },
  { re: /invalid academic year status transition/i, code: 'invalid_academic_year_transition', status: 409, message: 'Invalid academic year status transition' },
  { re: /academic year not found for term/i, code: 'academic_year_not_found', status: 404, message: 'Academic year not found for term' },
  // Phase 4.1 placement validation (trg_enrollments_placement_validate)
  { re: /section requires a class/i, code: 'section_requires_class', status: 409, message: 'Section requires a class' },
  { re: /class is not active/i, code: 'class_inactive', status: 409, message: 'Class is not active' },
  { re: /class academic year mismatch/i, code: 'class_academic_year_mismatch', status: 409, message: 'Class academic year mismatch' },
  { re: /section belongs to a different class/i, code: 'section_class_mismatch', status: 409, message: 'Section belongs to a different class' },
  { re: /section academic year mismatch/i, code: 'section_academic_year_mismatch', status: 409, message: 'Section academic year mismatch' },
  { re: /section is not active/i, code: 'section_inactive', status: 409, message: 'Section is not active' },
  { re: /cannot place into a non-active student/i, code: 'student_not_active', status: 409, message: 'Cannot place into a non-active student' },
  { re: /student campus does not match class campus/i, code: 'student_campus_mismatch', status: 409, message: 'Student campus does not match class campus' },
  { re: /cannot place into a non-active enrollment/i, code: 'enrollment_not_active', status: 409, message: 'Cannot place into a non-active enrollment' },
  // Phase 4.1 delete guards (trg_acd_classes_delete_guard / trg_sections_lifecycle_validate)
  { re: /cannot delete class with live sections/i, code: 'class_has_sections', status: 409, message: 'Cannot delete class with live sections' },
  { re: /cannot delete class with live enrollments/i, code: 'class_has_enrollments', status: 409, message: 'Cannot delete class with live enrollments' },
  { re: /cannot delete section with live enrollments/i, code: 'section_has_enrollments', status: 409, message: 'Cannot delete section with live enrollments' },
  // Phase 4.2 delete guards & lifecycle validators
  { re: /cannot delete grade level with live classes/i, code: 'grade_level_has_classes', status: 409, message: 'Cannot delete grade level with live classes' },
  { re: /cannot delete subject attached to a class/i, code: 'subject_has_class_links', status: 409, message: 'Cannot delete subject attached to a class' },
  { re: /cannot delete subject with live teacher assignments/i, code: 'subject_has_teacher_assignments', status: 409, message: 'Cannot delete subject with live teacher assignments' },
  { re: /cannot detach subject with assigned teachers/i, code: 'class_subject_has_teachers', status: 409, message: 'Cannot detach subject with assigned teachers' },
  { re: /cannot assign teacher to a subject not attached to the class/i, code: 'subject_not_in_class', status: 409, message: 'Cannot assign teacher to a subject not attached to the class' },
  { re: /assignment requires an active teacher membership in this tenant/i, code: 'teacher_not_active', status: 409, message: 'Assignment requires an active teacher membership in this tenant' },
  { re: /cannot delete class with live subject links/i, code: 'class_has_subject_links', status: 409, message: 'Cannot delete class with live subject links' },
  { re: /cannot delete class with live teacher assignments/i, code: 'class_has_teacher_assignments', status: 409, message: 'Cannot delete class with live teacher assignments' },
  // Phase 4.3 timetable & homework validators / guards
  { re: /subject is not attached to the class for this timetable entry/i, code: 'timetable_subject_not_in_class', status: 409, message: 'Subject is not attached to the class for this timetable entry' },
  { re: /teacher is not the assigned teacher for this class subject/i, code: 'timetable_teacher_not_assigned', status: 409, message: 'Teacher is not the assigned teacher for this class subject' },
  { re: /teacher is double-booked in the timetable/i, code: 'teacher_double_booked', status: 409, message: 'Teacher is double-booked in the timetable' },
  { re: /cannot delete period with live timetable entries/i, code: 'period_has_entries', status: 409, message: 'Cannot delete period with live timetable entries' },
  { re: /cannot delete section with live timetable entries/i, code: 'section_has_timetable', status: 409, message: 'Cannot delete section with live timetable entries' },
  { re: /cannot delete subject with live timetable entries/i, code: 'subject_has_schedule', status: 409, message: 'Cannot delete subject with live timetable entries' },
  { re: /cannot delete subject with live homework/i, code: 'subject_has_homework', status: 409, message: 'Cannot delete subject with live homework' },
  { re: /cannot delete class with live timetable entries/i, code: 'class_has_timetable', status: 409, message: 'Cannot delete class with live timetable entries' },
  { re: /cannot delete class with live homework/i, code: 'class_has_homework', status: 409, message: 'Cannot delete class with live homework' },
  { re: /cannot unassign a teacher with live timetable entries/i, code: 'assignment_has_schedule', status: 409, message: 'Cannot unassign a teacher with live timetable entries' },
  { re: /subject is not attached to the class for homework/i, code: 'homework_subject_not_in_class', status: 409, message: 'Subject is not attached to the class for homework' },
  { re: /author is not the assigned teacher for this class subject/i, code: 'homework_teacher_not_assigned', status: 409, message: 'Author is not the assigned teacher for this class subject' },
  // Phase 4.4 student portal link (trg_students_user_link_validate, migration 0013)
  { re: /student portal link requires an active membership in this tenant/i, code: 'student_link_requires_membership', status: 409, message: 'Student portal link requires an active membership in this tenant' },
  // Phase 5 attendance & leave validators / guards (migration 0014)
  { re: /attendance cannot be marked for a future date/i, code: 'attendance_future_date', status: 409, message: 'Attendance cannot be marked for a future date' },
  { re: /attendance date is immutable/i, code: 'attendance_date_immutable', status: 409, message: 'Attendance date cannot be changed' },
  { re: /attendance can only be corrected on the same day as the attendance date/i, code: 'attendance_correction_window_closed', status: 409, message: 'Attendance can only be corrected on the same day as the attendance date' },
  { re: /attendance requires an existing student in this school/i, code: 'attendance_student_not_found', status: 404, message: 'Student not found in this school' },
  { re: /attendance requires an active student in this school/i, code: 'attendance_student_not_active', status: 409, message: 'Attendance can only be recorded for an active student' },
  { re: /attendance campus does not match the student campus/i, code: 'attendance_campus_mismatch', status: 409, message: 'Attendance campus does not match the student campus' },
  { re: /attendance must be marked by an active staff membership in this tenant/i, code: 'attendance_marker_not_staff', status: 409, message: 'Attendance must be marked by an active staff membership in this school' },
  { re: /period attendance is bound to its student, section and period/i, code: 'attendance_period_binding_immutable', status: 409, message: 'Period attendance cannot be moved to another student, section or period' },
  { re: /period attendance requires an active section/i, code: 'attendance_section_inactive', status: 409, message: 'Period attendance requires an active section' },
  { re: /period attendance requires an active period/i, code: 'attendance_period_inactive', status: 409, message: 'Period attendance requires an active period' },
  { re: /student is not enrolled in this section/i, code: 'attendance_not_enrolled', status: 409, message: 'Student is not enrolled in this section' },
  { re: /staff attendance is bound to its staff member/i, code: 'staff_attendance_user_immutable', status: 409, message: 'Staff attendance cannot be moved to another staff member' },
  { re: /clock out must not precede clock in/i, code: 'staff_attendance_clock_order', status: 409, message: 'Clock out must not precede clock in' },
  { re: /staff attendance requires an active membership in this tenant/i, code: 'staff_attendance_membership_inactive', status: 409, message: 'Staff attendance requires an active membership in this school' },
  { re: /leave end date must not precede the start date/i, code: 'leave_date_range_invalid', status: 409, message: 'Leave end date must not precede the start date' },
  { re: /a decided leave request cannot be modified/i, code: 'leave_already_decided', status: 409, message: 'A decided leave request cannot be modified' },
  { re: /invalid leave request status/i, code: 'leave_invalid_status', status: 409, message: 'Invalid leave request status' },
  { re: /leave requires an active student in this school/i, code: 'leave_student_not_active', status: 409, message: 'Leave can only be requested for an active student' },
  { re: /leave type not found/i, code: 'leave_type_not_found', status: 404, message: 'Leave type not found' },
  { re: /leave type is not active/i, code: 'leave_type_inactive', status: 409, message: 'Leave type is not active' },
  { re: /leave must be requested by an active membership in this tenant/i, code: 'leave_requester_inactive', status: 409, message: 'Leave must be requested by an active membership in this school' },
  { re: /leave must be decided by an active membership in this tenant/i, code: 'leave_approver_inactive', status: 409, message: 'Leave must be decided by an active membership in this school' },
  { re: /cannot delete leave type with live leave requests/i, code: 'leave_type_has_requests', status: 409, message: 'Cannot delete leave type with live leave requests' },
  { re: /leave type code is immutable/i, code: 'leave_type_code_immutable', status: 409, message: 'Leave type code cannot be changed' },
  // Phase 6 exams + results validators / guards (migration 0015)
  { re: /invalid exam status/i, code: 'exam_invalid_status', status: 409, message: 'Invalid exam status' },
  { re: /a published exam cannot be reconfigured/i, code: 'exam_published_frozen', status: 409, message: 'A published exam cannot be reconfigured' },
  { re: /a published exam cannot be cancelled/i, code: 'exam_published_not_cancellable', status: 409, message: 'A published exam cannot be cancelled' },
  { re: /an exam needs at least one subject before publication/i, code: 'exam_has_no_subjects', status: 409, message: 'An exam needs at least one subject before publication' },
  { re: /exam cannot be published from status/i, code: 'exam_not_publishable', status: 409, message: 'This exam cannot be published from its current status' },
  { re: /exam cannot enter grading from status/i, code: 'exam_cannot_enter_grading', status: 409, message: 'This exam cannot enter grading from its current status' },
  { re: /exam cannot be scheduled from status/i, code: 'exam_cannot_be_scheduled', status: 409, message: 'This exam cannot be scheduled from its current status' },
  { re: /exam cannot return to draft from status/i, code: 'exam_cannot_return_to_draft', status: 409, message: 'This exam cannot return to draft' },
  { re: /cannot delete an exam with results/i, code: 'exam_has_results', status: 409, message: 'Cannot delete an exam that already has results' },
  { re: /exam subjects cannot be removed once grading has started/i, code: 'exam_subjects_frozen', status: 409, message: 'Exam subjects cannot be removed once grading has started' },
  { re: /cannot remove an exam subject with marks/i, code: 'exam_subject_has_marks', status: 409, message: 'Cannot remove an exam subject that already has marks' },
  { re: /max_marks cannot change once marks exist/i, code: 'exam_subject_max_marks_frozen', status: 409, message: 'Maximum marks cannot change once marks exist' },
  { re: /exam subjects cannot be changed in status/i, code: 'exam_subjects_frozen', status: 409, message: 'Exam subjects cannot be changed in this exam status' },
  { re: /exam schedule cannot be changed in status/i, code: 'exam_schedule_frozen', status: 409, message: 'Exam schedule cannot be changed in this exam status' },
  { re: /exam schedule must fall inside the exam term/i, code: 'exam_schedule_outside_term', status: 409, message: 'Exam schedule must fall inside the exam term' },
  { re: /marks cannot be entered while the exam is/i, code: 'exam_not_accepting_marks', status: 409, message: 'Marks cannot be entered while the exam is in this status' },
  { re: /marks cannot be added to a published exam/i, code: 'exam_published_marks_immutable', status: 409, message: 'Marks cannot be added to a published exam' },
  { re: /a published mark can only be changed through the correction workflow/i, code: 'mark_correction_required', status: 409, message: 'A published mark can only be changed through the correction workflow' },
  { re: /a locked mark can only be changed through the correction workflow/i, code: 'mark_correction_required', status: 409, message: 'A locked mark can only be changed through the correction workflow' },
  { re: /mark status is server-derived and cannot be set directly/i, code: 'mark_status_derived', status: 409, message: 'Mark status is server-derived and cannot be set directly' },
  { re: /marks_obtained .* exceeds max_marks/i, code: 'mark_exceeds_max', status: 409, message: 'Marks cannot exceed the maximum marks for this exam subject' },
  { re: /corrected mark .* exceeds max_marks/i, code: 'mark_exceeds_max', status: 409, message: 'Corrected marks cannot exceed the maximum marks for this exam subject' },
  { re: /the correction workflow applies to published results only/i, code: 'mark_correction_not_published', status: 409, message: 'The correction workflow applies to published results only' },
  { re: /mark correction must describe the corrected mark/i, code: 'mark_correction_mismatch', status: 409, message: 'Mark correction does not describe the corrected mark' },
  { re: /mark correction old value does not match the mark/i, code: 'mark_correction_stale', status: 409, message: 'The mark changed since this correction was prepared; reload and retry' },
  { re: /mark corrections are append-only/i, code: 'mark_correction_immutable', status: 409, message: 'Mark corrections are append-only' },
  { re: /marks must be entered by an active membership in this tenant/i, code: 'mark_entry_inactive', status: 409, message: 'Marks must be entered by an active membership in this school' },
  { re: /a correction must be made by an active membership in this tenant/i, code: 'mark_correction_inactive', status: 409, message: 'A correction must be made by an active membership in this school' },
  { re: /mark must match the enrollment|mark student must match the enrollment/i, code: 'mark_enrollment_mismatch', status: 409, message: 'The mark must belong to the enrollment it names' },
  { re: /mark section must match the enrollment/i, code: 'mark_enrollment_mismatch', status: 409, message: 'The mark section must match the enrollment' },
  { re: /enrollment academic year must match the exam/i, code: 'mark_enrollment_year_mismatch', status: 409, message: 'The enrollment academic year must match the exam' },
  { re: /mark academic year must match the exam/i, code: 'mark_year_mismatch', status: 409, message: 'The mark academic year must match the exam' },
  { re: /enrollment not found/i, code: 'enrollment_not_found', status: 404, message: 'Enrollment not found' },
  { re: /grading bands must tile 0\.\.100/i, code: 'grading_bands_gap_or_overlap', status: 409, message: 'Grading bands must tile 0..100 without gaps or overlap' },
  { re: /exam grading scale must be an active grading scale/i, code: 'exam_scale_not_active', status: 409, message: 'The exam grading scale must be an active grading scale' },
  { re: /grading bands must end at 100/i, code: 'grading_bands_not_complete', status: 409, message: 'Grading bands must end at 100' },
  { re: /invalid grading band range/i, code: 'grading_band_invalid', status: 409, message: 'Invalid grading band range' },
  { re: /grading band gradePoint must be within 0\.\.4/i, code: 'grading_band_point_out_of_range', status: 409, message: 'Grading band grade point must be within 0..4' },
  { re: /grading band label must be 1\.\.16 characters/i, code: 'grading_band_label_invalid', status: 409, message: 'Grading band label must be 1 to 16 characters' },
  { re: /grading scale code and version are immutable/i, code: 'grading_scale_identity_immutable', status: 409, message: 'Grading scale code and version cannot be changed' },
  { re: /an active grading scale cannot be edited; create a new version/i, code: 'grading_scale_active_frozen', status: 409, message: 'An active grading scale cannot be edited; create a new version' },
  { re: /another version of this grading scale is already active/i, code: 'grading_scale_already_active', status: 409, message: 'Another version of this grading scale is already active' },
  { re: /cannot delete a grading scale used by an exam/i, code: 'grading_scale_in_use', status: 409, message: 'Cannot delete a grading scale that is used by an exam' },
  { re: /exam type code is immutable/i, code: 'exam_type_code_immutable', status: 409, message: 'Exam type code cannot be changed' },
  { re: /cannot deactivate an exam type used by a live exam/i, code: 'exam_type_in_use', status: 409, message: 'Cannot deactivate an exam type used by a live exam' },
  { re: /a published report card is immutable/i, code: 'report_card_immutable', status: 409, message: 'A published report card is immutable' },
  { re: /a report card artifact cannot be replaced/i, code: 'report_card_artifact_immutable', status: 409, message: 'A report card artifact cannot be replaced' },
  { re: /a report card can only be published with its exam/i, code: 'report_card_exam_not_published', status: 409, message: 'A report card can only be published together with its exam' },
  { re: /report cards are generated while an exam is grading or published/i, code: 'report_card_exam_not_gradable', status: 409, message: 'Report cards are generated while an exam is grading or published' },
  { re: /a published report card cannot be removed/i, code: 'report_card_published_immutable', status: 409, message: 'A published report card cannot be removed' },
  // Phase 6 remediation, migration 0017: publication integrity
  { re: /the publication marker of a mark is immutable/i, code: 'mark_publication_marker_immutable', status: 409, message: 'The publication marker of a mark cannot be changed' },
  { re: /a published mark is frozen/i, code: 'mark_published_frozen', status: 409, message: 'A published mark cannot be moved, re-attributed or hidden; use the correction workflow' },
  { re: /a mark cannot be moved into a published exam/i, code: 'exam_published_closed_to_marks', status: 409, message: 'A published result is closed to new marks' },
  { re: /a published mark cannot be deleted/i, code: 'mark_published_immutable', status: 409, message: 'A published mark cannot be deleted; correct it through the correction workflow' },
  { re: /a published report card cannot be hard-deleted/i, code: 'report_card_published_immutable', status: 409, message: 'A published report card cannot be hard-deleted; supersede it with a new version' },
  { re: /the grading scale of an exam in status .* cannot be changed/i, code: 'exam_scale_frozen_in_status', status: 409, message: 'The grading scale of this exam is frozen in its current status' },
  { re: /the grading scale of an exam cannot be changed once marks exist/i, code: 'exam_scale_frozen_has_marks', status: 409, message: 'The grading scale cannot be changed once the exam has marks' },
  { re: /publication requires published_at/i, code: 'exam_publication_needs_timestamp', status: 409, message: 'Publication requires a publication timestamp' },
  { re: /grading band gradePoint is required/i, code: 'grading_band_point_required', status: 409, message: 'Each grading band requires a grade point' },
  { re: /grading band label .* appears more than once in this scale/i, code: 'grading_band_duplicate_label', status: 409, message: 'Grading band labels must be unique within a scale' },
  { re: /grading bands that produced a result cannot be edited/i, code: 'grading_bands_result_immutable', status: 409, message: 'These grading bands have produced a result and cannot be edited; create a new version' },
];

export interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

/** 23505 conflicts that deserve a stable, documented code instead of the generic `conflict`. */
const UNIQUE_CONFLICTS: ReadonlyArray<{ constraint: string; code: string; message: string }> = [
  {
    constraint: 'students_student_no_uq',
    code: 'student_no_taken',
    message: 'A student with this student number already exists',
  },
  {
    constraint: 'guardians_tenant_user_uq',
    code: 'guardian_user_linked',
    message: 'A guardian for this user already exists',
  },
  {
    constraint: 'student_guardians_relation_uq',
    code: 'guardian_already_linked',
    message: 'This guardian is already linked to the student with this relation',
  },
  {
    constraint: 'enrollments_student_year_uq',
    code: 'student_already_enrolled',
    message: 'Student is already enrolled in this academic year',
  },
  {
    constraint: 'promotion_items_batch_student_uq',
    code: 'student_already_in_batch',
    message: 'Student is already in this promotion batch',
  },
  {
    constraint: 'acd_classes_tenant_code_uq',
    code: 'class_code_taken',
    message: 'A class with this code already exists for this campus and academic year',
  },
  {
    constraint: 'sections_tenant_class_code_uq',
    code: 'section_code_taken',
    message: 'A section with this code already exists for this class',
  },
  {
    constraint: 'enrollments_roll_no_uq',
    code: 'roll_no_taken',
    message: 'This roll number is already taken in this section',
  },
  {
    constraint: 'grade_levels_tenant_code_uq',
    code: 'grade_level_code_taken',
    message: 'A grade level with this code already exists in this school',
  },
  {
    constraint: 'subjects_tenant_code_uq',
    code: 'subject_code_taken',
    message: 'A subject with this code already exists in this school',
  },
  {
    constraint: 'class_subjects_class_subject_live_uq',
    code: 'class_subject_already_linked',
    message: 'This subject is already attached to the class',
  },
  {
    constraint: 'teacher_assignments_class_subject_live_uq',
    code: 'teacher_already_assigned',
    message: 'A teacher is already assigned to this subject in this class',
  },
  {
    constraint: 'periods_tenant_campus_no_uq',
    code: 'period_no_taken',
    message: 'A period with this number already exists for this campus',
  },
  {
    constraint: 'timetable_entries_section_slot_live_uq',
    code: 'timetable_slot_conflict',
    message: 'This section already has a lesson in this slot',
  },
  {
    constraint: 'homework_attachments_hw_file_uq',
    code: 'homework_attachment_duplicate',
    message: 'This file is already attached to the homework',
  },
  {
    constraint: 'students_tenant_user_uq',
    code: 'student_user_already_linked',
    message: 'This portal account is already linked to another student in this school',
  },
  {
    constraint: 'leave_types_tenant_code_uq',
    code: 'leave_type_code_taken',
    message: 'A leave type with this code already exists in this school',
  },
  {
    constraint: 'attendance_days_tenant_student_date_uq',
    code: 'attendance_already_recorded',
    message: 'Attendance is already recorded for this student on this date',
  },
  {
    constraint: 'attendance_periods_tenant_student_date_period_uq',
    code: 'attendance_period_already_recorded',
    message: 'Attendance is already recorded for this student, date and period',
  },
  {
    constraint: 'staff_attendance_unique_day',
    code: 'staff_attendance_already_recorded',
    message: 'Staff attendance is already recorded for this staff member on this date',
  },
  {
    constraint: 'exam_types_tenant_code_uq',
    code: 'exam_type_code_taken',
    message: 'An exam type with this code already exists in this school',
  },
  {
    constraint: 'grading_scales_code_version_uq',
    code: 'grading_scale_version_taken',
    message: 'This grading scale version already exists',
  },
  {
    constraint: 'grading_scales_active_uq',
    code: 'grading_scale_already_active',
    message: 'Another version of this grading scale is already active',
  },
  {
    constraint: 'exams_term_name_uq',
    code: 'exam_name_taken',
    message: 'An exam with this name already exists in this term',
  },
  {
    constraint: 'exam_subjects_exam_subject_uq',
    code: 'exam_subject_already_linked',
    message: 'This class subject is already part of the exam',
  },
  {
    constraint: 'exam_schedules_subject_live_uq',
    code: 'exam_schedule_already_exists',
    message: 'A schedule already exists for this exam subject',
  },
  {
    constraint: 'report_cards_student_exam_version_uq',
    code: 'report_card_version_taken',
    message: 'This report card version already exists',
  },
  {
    constraint: 'report_cards_live_draft_uq',
    code: 'report_card_draft_exists',
    message: 'A draft report card already exists for this exam and student',
  },
];

export function parsePagination(query: unknown): PaginationQuery {
  return paginationQuerySchema.parse(query);
}

export function mapDomainError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const pg = err as PgErrorLike;
  if (pg.code === '23505') {
    if (pg.constraint) {
      const entry = UNIQUE_CONFLICTS.find((c) => c.constraint === pg.constraint);
      if (entry) {
        return new HttpError(entry.message, { status: 409, code: entry.code });
      }
    }
    return new HttpError('A record with this unique value already exists', {
      status: 409,
      code: 'conflict',
    });
  }
  if (pg.code === '23503') {
    return new HttpError('Related record not found', { status: 404, code: 'not_found' });
  }
  if (pg.code === '23514') {
    return new HttpError('Value violates a database constraint', {
      status: 400,
      code: 'validation_error',
    });
  }
  if (pg.code === '55000') {
    const source = pg.message ?? '';
    for (const entry of DOMAIN_ERRORS) {
      if (entry.re.test(source)) {
        return new HttpError(entry.message, { status: entry.status, code: entry.code });
      }
    }
    return new HttpError(DOMAIN_CONFLICT_MESSAGE, { status: 409, code: 'conflict' });
  }
  // Exclusion-constraint violation (periods_no_overlap_excl): period time ranges
  // may not overlap within the same tenant + campus. Touching ranges are allowed.
  if (pg.code === '23P01') {
    if (pg.constraint === 'periods_no_overlap_excl') {
      return new HttpError('Period time ranges may not overlap', {
        status: 409,
        code: 'period_time_overlap',
      });
    }
    return new HttpError(DOMAIN_CONFLICT_MESSAGE, { status: 409, code: 'conflict' });
  }
  throw err;
}

export function idempotencyKeyFromHeader(headers: object | undefined): string | null {
  if (!headers) return null;
  const value = (headers as Record<string, unknown>)['x-idempotency-key'];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
  return typeof value === 'string' ? value : null;
}

export function notFoundError(message: string): HttpError {
  return new HttpError(message, { status: 404, code: 'not_found' });
}

/**
 * Campus-scope enforcement (AUTHORIZATION.md §4, service layer; RLS stays at the
 * tenant level). A membership whose `campus_id` is NULL is school-wide and passes
 * any target. A campus-scoped membership may only create/update/delete resources
 * whose `campus_id` matches its own campus — this includes school-wide (NULL)
 * targets, which are not "their" campus. Deny is an explicit 403 instead of the
 * generic permission denial so the two failure modes stay distinguishable.
 */
export function assertCampusScope(
  ctx: { campusId: string | null },
  targetCampusId: string | null,
): void {
  if (ctx.campusId && targetCampusId !== ctx.campusId) {
    throw new HttpError('Campus-scoped membership denied', {
      status: 403,
      code: 'campus_scope_denied',
    });
  }
}