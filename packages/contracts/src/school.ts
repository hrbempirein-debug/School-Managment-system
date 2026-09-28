import { z } from 'zod';
import { UuidSchema } from './common.js';

// ------------------------------------------------------------------ domains

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
const IsoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'value must be an ISO-8601 date-time',
});

export const CampusStatusSchema = z.enum(['active', 'inactive']);
export const AcademicYearStatusSchema = z.enum(['draft', 'active', 'closed']);
export const AcademicTermStatusSchema = z.enum(['draft', 'open', 'closed']);
export const HolidayStatusSchema = z.enum(['active', 'inactive']);
export const CalendarTypeSchema = z.enum(['general', 'academic']);
export const CalendarStatusSchema = z.enum(['active', 'archived']);
export const DepartmentStatusSchema = z.enum(['active', 'inactive']);

const StringField = z.string().min(1).max(160);

// ------------------------------------------------------------------ campuses

export const campusSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  status: CampusStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Campus = z.infer<typeof campusSchema>;

export const createCampusRequestSchema = z.object({
  code: StringField,
  name: StringField,
  address: z.string().max(500).optional(),
  city: z.string().max(160).optional(),
  country: z.string().max(120).optional(),
});
export type CreateCampusRequest = z.infer<typeof createCampusRequestSchema>;

export const updateCampusRequestSchema = createCampusRequestSchema
  .partial()
  .extend({ status: CampusStatusSchema.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateCampusRequest = z.infer<typeof updateCampusRequestSchema>;

export const campusResponseSchema = z.object({ campus: campusSchema });
export type CampusResponse = z.infer<typeof campusResponseSchema>;

export const campusListResponseSchema = z.object({
  items: z.array(campusSchema),
  total: z.number().int().nonnegative(),
});
export type CampusListResponse = z.infer<typeof campusListResponseSchema>;

// ------------------------------------------------------------------ academic years

export const academicYearSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: z.string(),
  name: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  status: AcademicYearStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AcademicYear = z.infer<typeof academicYearSchema>;

export const createAcademicYearRequestSchema = z.object({
  code: StringField,
  name: StringField,
  startsOn: IsoDate,
  endsOn: IsoDate,
});
export type CreateAcademicYearRequest = z.infer<typeof createAcademicYearRequestSchema>;

export const updateAcademicYearRequestSchema = createAcademicYearRequestSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateAcademicYearRequest = z.infer<typeof updateAcademicYearRequestSchema>;

export const academicYearResponseSchema = z.object({ academicYear: academicYearSchema });
export type AcademicYearResponse = z.infer<typeof academicYearResponseSchema>;

export const academicYearListResponseSchema = z.object({
  items: z.array(academicYearSchema),
  total: z.number().int().nonnegative(),
});
export type AcademicYearListResponse = z.infer<typeof academicYearListResponseSchema>;

// ------------------------------------------------------------------ academic terms

export const academicTermSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  academicYearId: UuidSchema,
  code: z.string(),
  name: z.string(),
  sequence: z.number().int().positive(),
  startsOn: z.string(),
  endsOn: z.string(),
  status: AcademicTermStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AcademicTerm = z.infer<typeof academicTermSchema>;

export const createAcademicTermRequestSchema = z.object({
  code: StringField,
  name: StringField,
  sequence: z.number().int().positive(),
  startsOn: IsoDate,
  endsOn: IsoDate,
});
export type CreateAcademicTermRequest = z.infer<typeof createAcademicTermRequestSchema>;

export const updateAcademicTermRequestSchema = createAcademicTermRequestSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateAcademicTermRequest = z.infer<typeof updateAcademicTermRequestSchema>;

export const academicTermResponseSchema = z.object({ academicTerm: academicTermSchema });
export type AcademicTermResponse = z.infer<typeof academicTermResponseSchema>;

export const academicTermListResponseSchema = z.object({
  items: z.array(academicTermSchema),
  total: z.number().int().nonnegative(),
});
export type AcademicTermListResponse = z.infer<typeof academicTermListResponseSchema>;

// ------------------------------------------------------------------ holidays

export const holidaySchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  campusId: UuidSchema.nullable(),
  name: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  status: HolidayStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Holiday = z.infer<typeof holidaySchema>;

export const createHolidayRequestSchema = z.object({
  campusId: UuidSchema.optional(),
  name: StringField,
  startsOn: IsoDate,
  endsOn: IsoDate,
});
export type CreateHolidayRequest = z.infer<typeof createHolidayRequestSchema>;

export const updateHolidayRequestSchema = createHolidayRequestSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateHolidayRequest = z.infer<typeof updateHolidayRequestSchema>;

export const holidayResponseSchema = z.object({ holiday: holidaySchema });
export type HolidayResponse = z.infer<typeof holidayResponseSchema>;

export const holidayListResponseSchema = z.object({
  items: z.array(holidaySchema),
  total: z.number().int().nonnegative(),
});
export type HolidayListResponse = z.infer<typeof holidayListResponseSchema>;

// ------------------------------------------------------------------ calendars

export const calendarSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: z.string(),
  name: z.string(),
  type: CalendarTypeSchema,
  status: CalendarStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Calendar = z.infer<typeof calendarSchema>;

export const createCalendarRequestSchema = z.object({
  code: StringField,
  name: StringField,
  type: CalendarTypeSchema.default('general'),
});
export type CreateCalendarRequest = z.infer<typeof createCalendarRequestSchema>;

export const updateCalendarRequestSchema = z
  .object({
    code: StringField,
    name: StringField,
    type: CalendarTypeSchema,
    status: CalendarStatusSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateCalendarRequest = z.infer<typeof updateCalendarRequestSchema>;

export const calendarResponseSchema = z.object({ calendar: calendarSchema });
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;

export const calendarListResponseSchema = z.object({
  items: z.array(calendarSchema),
  total: z.number().int().nonnegative(),
});
export type CalendarListResponse = z.infer<typeof calendarListResponseSchema>;

// ------------------------------------------------------------------ calendar events

export const calendarEventSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  calendarId: UuidSchema,
  title: z.string(),
  description: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  allDay: z.boolean(),
  location: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const createCalendarEventRequestSchema = z.object({
  title: StringField,
  description: z.string().max(2000).optional(),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  allDay: z.boolean().default(false),
  location: z.string().max(300).optional(),
});
export type CreateCalendarEventRequest = z.infer<typeof createCalendarEventRequestSchema>;

export const updateCalendarEventRequestSchema = createCalendarEventRequestSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateCalendarEventRequest = z.infer<typeof updateCalendarEventRequestSchema>;

export const calendarEventResponseSchema = z.object({ calendarEvent: calendarEventSchema });
export type CalendarEventResponse = z.infer<typeof calendarEventResponseSchema>;

export const calendarEventListResponseSchema = z.object({
  items: z.array(calendarEventSchema),
  total: z.number().int().nonnegative(),
});
export type CalendarEventListResponse = z.infer<typeof calendarEventListResponseSchema>;

// ------------------------------------------------------------------ departments

export const departmentSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: z.string(),
  name: z.string(),
  status: DepartmentStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Department = z.infer<typeof departmentSchema>;

export const createDepartmentRequestSchema = z.object({
  code: StringField,
  name: StringField,
});
export type CreateDepartmentRequest = z.infer<typeof createDepartmentRequestSchema>;

export const updateDepartmentRequestSchema = createDepartmentRequestSchema
  .partial()
  .extend({ status: DepartmentStatusSchema.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateDepartmentRequest = z.infer<typeof updateDepartmentRequestSchema>;

export const departmentResponseSchema = z.object({ department: departmentSchema });
export type DepartmentResponse = z.infer<typeof departmentResponseSchema>;

export const departmentListResponseSchema = z.object({
  items: z.array(departmentSchema),
  total: z.number().int().nonnegative(),
});
export type DepartmentListResponse = z.infer<typeof departmentListResponseSchema>;

// ------------------------------------------------------------------ students

export const StudentStatusSchema = z.enum(['applicant', 'active', 'transferred', 'graduated', 'alumni']);
export const StudentGenderSchema = z.enum(['male', 'female', 'other']);

export const studentSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  studentNo: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  dateOfBirth: z.string().nullable(),
  gender: StudentGenderSchema.nullable(),
  status: StudentStatusSchema,
  primaryCampusId: UuidSchema.nullable(),
  userId: UuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Student = z.infer<typeof studentSchema>;

/**
 * Writable student fields at creation. Strict: any unknown key (tenantId, id,
 * status, createdAt/updatedAt, photoFileId, ...) is REJECTED as
 * `validation_error` so client-supplied internal fields can never be persisted.
 */
export const createStudentRequestSchema = z
  .object({
    studentNo: StringField,
    firstName: StringField,
    lastName: StringField,
    dateOfBirth: IsoDate.optional(),
    gender: StudentGenderSchema.optional(),
    primaryCampusId: UuidSchema.optional(),
  })
  .strict();
export type CreateStudentRequest = z.infer<typeof createStudentRequestSchema>;

/**
 * PATCH: partial of the explicit writable set only. Lifecycle status is NEVER
 * writable here (Phase 3.3 actions own transitions) and primaryCampusId is NOT
 * patchable (campus ownership would otherwise be movable out from under a
 * campus-scoped actor — creation-time campus assignment only). userId may be a
 * valid UUID (link this student to an existing portal account in this tenant)
 * or null (clear the link); it is enforced by migration 0013's trigger + unique
 * index, and only ever reached through a students.update holder.
 */
export const updateStudentRequestSchema = z
  .object({
    studentNo: StringField,
    firstName: StringField,
    lastName: StringField,
    dateOfBirth: IsoDate.optional(),
    gender: StudentGenderSchema.optional(),
    userId: UuidSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateStudentRequest = z.infer<typeof updateStudentRequestSchema>;

export const studentResponseSchema = z.object({ student: studentSchema });
export type StudentResponse = z.infer<typeof studentResponseSchema>;

export const studentListResponseSchema = z.object({
  items: z.array(studentSchema),
  total: z.number().int().nonnegative(),
});
export type StudentListResponse = z.infer<typeof studentListResponseSchema>;

// ------------------------------------------------------------------ guardians

export const guardianSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  userId: UuidSchema.nullable(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Guardian = z.infer<typeof guardianSchema>;

/**
 * Writable guardian fields at creation. userId is a portal-link concern owned by
 * a later phase and is NOT client-writable; strict rejects it alongside any
 * other unknown/internal key.
 */
export const createGuardianRequestSchema = z
  .object({
    firstName: StringField,
    lastName: StringField,
    email: z.string().email().max(320).optional(),
    phone: z.string().max(40).optional(),
  })
  .strict();
export type CreateGuardianRequest = z.infer<typeof createGuardianRequestSchema>;

export const updateGuardianRequestSchema = z
  .object({
    firstName: StringField,
    lastName: StringField,
    email: z.string().email().max(320).optional(),
    phone: z.string().max(40).optional(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateGuardianRequest = z.infer<typeof updateGuardianRequestSchema>;

export const guardianResponseSchema = z.object({ guardian: guardianSchema });
export type GuardianResponse = z.infer<typeof guardianResponseSchema>;

export const guardianListResponseSchema = z.object({
  items: z.array(guardianSchema),
  total: z.number().int().nonnegative(),
});
export type GuardianListResponse = z.infer<typeof guardianListResponseSchema>;

// ------------------------------------------------------------------ student ↔ guardian links

export const GuardianRelationSchema = z.enum(['father', 'mother', 'parent', 'guardian', 'other']);

export const studentGuardianLinkSchema = z.object({
  id: UuidSchema,
  studentId: UuidSchema,
  guardianId: UuidSchema,
  relation: GuardianRelationSchema,
  isPrimary: z.boolean(),
  canPickup: z.boolean(),
  guardian: guardianSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StudentGuardianLink = z.infer<typeof studentGuardianLinkSchema>;

export const createStudentGuardianRequestSchema = z
  .object({
    guardianId: UuidSchema,
    relation: GuardianRelationSchema,
    isPrimary: z.boolean().optional(),
    canPickup: z.boolean().optional(),
  })
  .strict();
export type CreateStudentGuardianRequest = z.infer<typeof createStudentGuardianRequestSchema>;

export const studentGuardianListResponseSchema = z.object({
  items: z.array(studentGuardianLinkSchema),
  total: z.number().int().nonnegative(),
});
export type StudentGuardianListResponse = z.infer<typeof studentGuardianListResponseSchema>;

export const studentGuardianParamSchema = z.object({
  id: UuidSchema,
  guardianId: UuidSchema,
});

// ------------------------------------------------------------------ enrollments

export const EnrollmentStatusSchema = z.enum(['active', 'withdrawn', 'completed']);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatusSchema>;

export const enrollmentSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  studentId: UuidSchema,
  academicYearId: UuidSchema,
  classId: UuidSchema.nullable(),
  sectionId: UuidSchema.nullable(),
  rollNo: z.string().nullable(),
  status: EnrollmentStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Enrollment = z.infer<typeof enrollmentSchema>;

/**
 * Enroll a student into an academic year. Strict single-field body: tenant_id,
 * student_id, id, status and timestamps are ALL server-derived (the student is
 * taken from the URL and `tenantId` from the signed context). Unknown keys
 * (mass-assignment) are rejected as `validation_error`.
 */
export const enrollStudentRequestSchema = z.object({ academicYearId: UuidSchema }).strict();
export type EnrollStudentRequest = z.infer<typeof enrollStudentRequestSchema>;

export const enrollmentResponseSchema = z.object({ enrollment: enrollmentSchema });
export type EnrollmentResponse = z.infer<typeof enrollmentResponseSchema>;

export const enrollmentListResponseSchema = z.object({
  items: z.array(enrollmentSchema),
  total: z.number().int().nonnegative(),
});
export type EnrollmentListResponse = z.infer<typeof enrollmentListResponseSchema>;

/** Filter set for GET /api/v1/enrollments. */
export const enrollmentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  academicYearId: UuidSchema.optional(),
  studentId: UuidSchema.optional(),
  status: EnrollmentStatusSchema.optional(),
});
export type EnrollmentListQuery = z.infer<typeof enrollmentListQuerySchema>;

// ------------------------------------------------------------------ classes, sections & placement (Phase 4.1)

export const ClassStatusSchema = z.enum(['active', 'inactive']);
export const SectionStatusSchema = z.enum(['active', 'inactive']);

export const acdClassSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  campusId: UuidSchema,
  academicYearId: UuidSchema,
  gradeLevelId: UuidSchema.nullable(),
  code: z.string(),
  name: z.string(),
  status: ClassStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AcdClass = z.infer<typeof acdClassSchema>;

/**
 * Create a class. campusId/academicYearId/gradeLevelId are create-only
 * (immutable): sections pin the first two onto every row via composite FKs, and
 * enrollments validate year alignment against them, so relocating a populated
 * class would cascade-break child rows. gradeLevelId is optional and also
 * create-only — a class may be re-leveled only by deleting the class. status is
 * never set here — classes start 'active'; lifecycle goes through the
 * activate/deactivate action routes.
 */
export const createClassRequestSchema = z
  .object({
    campusId: UuidSchema,
    academicYearId: UuidSchema,
    gradeLevelId: UuidSchema.optional(),
    code: StringField,
    name: StringField,
  })
  .strict();
export type CreateClassRequest = z.infer<typeof createClassRequestSchema>;

/** Update: code/name only. status/campus/academicYear/gradeLevel via actions/immutability. */
export const updateClassRequestSchema = createClassRequestSchema
  .omit({ campusId: true, academicYearId: true, gradeLevelId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateClassRequest = z.infer<typeof updateClassRequestSchema>;

export const classResponseSchema = z.object({ class: acdClassSchema });
export type ClassResponse = z.infer<typeof classResponseSchema>;

export const classListResponseSchema = z.object({
  items: z.array(acdClassSchema),
  total: z.number().int().nonnegative(),
});
export type ClassListResponse = z.infer<typeof classListResponseSchema>;

/** Filter set for GET /api/v1/classes. */
export const classListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  campusId: UuidSchema.optional(),
  academicYearId: UuidSchema.optional(),
  status: ClassStatusSchema.optional(),
});
export type ClassListQuery = z.infer<typeof classListQuerySchema>;

export const sectionSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  classId: UuidSchema,
  campusId: UuidSchema,
  academicYearId: UuidSchema,
  code: z.string(),
  status: SectionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Section = z.infer<typeof sectionSchema>;

/**
 * Create a section under a class (classId comes from the URL). campusId/
 * academicYearId are pinned server-side from the parent class via composite FKs
 * — the request never supplies them (mass-assignment rejected as validation_error).
 */
export const createSectionRequestSchema = z.object({ code: StringField }).strict();
export type CreateSectionRequest = z.infer<typeof createSectionRequestSchema>;

export const updateSectionRequestSchema = createSectionRequestSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateSectionRequest = z.infer<typeof updateSectionRequestSchema>;

export const sectionResponseSchema = z.object({ section: sectionSchema });
export type SectionResponse = z.infer<typeof sectionResponseSchema>;

export const sectionListResponseSchema = z.object({
  items: z.array(sectionSchema),
  total: z.number().int().nonnegative(),
});
export type SectionListResponse = z.infer<typeof sectionListResponseSchema>;

/** Filter set for GET /api/v1/classes/:id/sections. */
export const sectionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: SectionStatusSchema.optional(),
});
export type SectionListQuery = z.infer<typeof sectionListQuerySchema>;

/** Route params: single section nested under its parent class. */
export const classSectionParamSchema = z.object({ id: UuidSchema, sectionId: UuidSchema });
export type ClassSectionParam = z.infer<typeof classSectionParamSchema>;

/**
 * Academic placement view for an enrollment. classId/sectionId/rollNo are all
 * nullable — null class+section means the student is enrolled but unplaced.
 */
export const placementSchema = z.object({
  enrollmentId: UuidSchema,
  studentId: UuidSchema,
  academicYearId: UuidSchema,
  classId: UuidSchema.nullable(),
  sectionId: UuidSchema.nullable(),
  rollNo: z.string().nullable(),
});
export type Placement = z.infer<typeof placementSchema>;

/**
 * Assign or move placement. Strict body: classId + sectionId required and must
 * belong together (DB trigger enforces section→class and year/campus alignment;
 * API maps trigger rejections to 409). rollNo is optional at set-time — when
 * present it must be unique within the section among active enrollments
 * (enrollments_roll_no_uq).
 */
export const setPlacementRequestSchema = z
  .object({
    classId: UuidSchema,
    sectionId: UuidSchema,
    rollNo: z.string().trim().min(1).max(32).optional(),
  })
  .strict();
export type SetPlacementRequest = z.infer<typeof setPlacementRequestSchema>;

export const placementResponseSchema = z.object({ placement: placementSchema });
export type PlacementResponse = z.infer<typeof placementResponseSchema>;

// ------------------------------------------------------------------ grade levels (Phase 4.2)

export const GradeLevelStatusSchema = z.enum(['active', 'inactive']);

export const gradeLevelSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: z.string(),
  name: z.string(),
  status: GradeLevelStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GradeLevel = z.infer<typeof gradeLevelSchema>;

/**
 * Create a grade level (tenant-wide catalog). status is never set here — grade
 * levels start 'active'; lifecycle goes through the activate/deactivate routes.
 * Code uniqueness is tenant-wide among live rows (deleted history may reuse a code).
 */
export const createGradeLevelRequestSchema = z
  .object({ code: StringField, name: StringField })
  .strict();
export type CreateGradeLevelRequest = z.infer<typeof createGradeLevelRequestSchema>;

export const updateGradeLevelRequestSchema = createGradeLevelRequestSchema
  .partial()
  .extend({ status: GradeLevelStatusSchema.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateGradeLevelRequest = z.infer<typeof updateGradeLevelRequestSchema>;

export const gradeLevelResponseSchema = z.object({ gradeLevel: gradeLevelSchema });
export type GradeLevelResponse = z.infer<typeof gradeLevelResponseSchema>;

export const gradeLevelListResponseSchema = z.object({
  items: z.array(gradeLevelSchema),
  total: z.number().int().nonnegative(),
});
export type GradeLevelListResponse = z.infer<typeof gradeLevelListResponseSchema>;

export const gradeLevelListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: GradeLevelStatusSchema.optional(),
});
export type GradeLevelListQuery = z.infer<typeof gradeLevelListQuerySchema>;

// ------------------------------------------------------------------ subjects (Phase 4.2)

export const SubjectStatusSchema = z.enum(['active', 'inactive']);

export const subjectSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: SubjectStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Subject = z.infer<typeof subjectSchema>;

/**
 * Create a subject (tenant-wide catalog). status is never set here — subjects
 * start 'active'; lifecycle goes through the activate/deactivate routes. Code
 * uniqueness is tenant-wide among live rows.
 */
export const createSubjectRequestSchema = z
  .object({
    code: StringField,
    name: StringField,
    description: z.string().max(1000).optional(),
  })
  .strict();
export type CreateSubjectRequest = z.infer<typeof createSubjectRequestSchema>;

export const updateSubjectRequestSchema = createSubjectRequestSchema
  .partial()
  .extend({ status: SubjectStatusSchema.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateSubjectRequest = z.infer<typeof updateSubjectRequestSchema>;

export const subjectResponseSchema = z.object({ subject: subjectSchema });
export type SubjectResponse = z.infer<typeof subjectResponseSchema>;

export const subjectListResponseSchema = z.object({
  items: z.array(subjectSchema),
  total: z.number().int().nonnegative(),
});
export type SubjectListResponse = z.infer<typeof subjectListResponseSchema>;

export const subjectListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: SubjectStatusSchema.optional(),
});
export type SubjectListQuery = z.infer<typeof subjectListQuerySchema>;

// ------------------------------------------------------------------ class subjects (Phase 4.2)

/**
 * Subject taught in a class (DATABASE_DESIGN §5: unique(class_id, subject_id)).
 * campusId/academicYearId are pinned from the parent class server-side and
 * enforced by composite FKs — never client-writable.
 */
export const classSubjectSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  classId: UuidSchema,
  subjectId: UuidSchema,
  campusId: UuidSchema,
  academicYearId: UuidSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClassSubject = z.infer<typeof classSubjectSchema>;

/** Attach a subject to the class in the URL — the body is intentionally empty (strict). */
export const assignClassSubjectRequestSchema = z.object({}).strict();
export type AssignClassSubjectRequest = z.infer<typeof assignClassSubjectRequestSchema>;

export const classSubjectResponseSchema = z.object({ classSubject: classSubjectSchema });
export type ClassSubjectResponse = z.infer<typeof classSubjectResponseSchema>;

export const classSubjectListResponseSchema = z.object({
  items: z.array(classSubjectSchema),
  total: z.number().int().nonnegative(),
});
export type ClassSubjectListResponse = z.infer<typeof classSubjectListResponseSchema>;

export const classSubjectListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ClassSubjectListQuery = z.infer<typeof classSubjectListQuerySchema>;

/** Route params: single class-subject link nested under its parent class. */
export const classSubjectParamSchema = z.object({ id: UuidSchema, subjectId: UuidSchema });
export type ClassSubjectParam = z.infer<typeof classSubjectParamSchema>;

// ------------------------------------------------------------------ teacher assignments (Phase 4.2)

/**
 * One active teacher per (class, subject) (DATABASE_DESIGN §5: "one lead, one
 * class-subject combination"). There is no teachers table: the teacher is an
 * ACTIVE membership carrying the tenant-scoped `teacher` role, re-verified by a
 * SECURITY INVOKER trigger at write time. campusId/academicYearId are pinned
 * from the parent class server-side — never client-writable.
 */
export const teacherAssignmentSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  classId: UuidSchema,
  subjectId: UuidSchema,
  teacherUserId: UuidSchema,
  campusId: UuidSchema,
  academicYearId: UuidSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TeacherAssignment = z.infer<typeof teacherAssignmentSchema>;

/** Strict body: only teacherUserId; the pair (class, subject) comes from the URL. */
export const assignTeacherRequestSchema = z.object({ teacherUserId: UuidSchema }).strict();
export type AssignTeacherRequest = z.infer<typeof assignTeacherRequestSchema>;

export const teacherAssignmentResponseSchema = z.object({
  teacherAssignment: teacherAssignmentSchema,
});
export type TeacherAssignmentResponse = z.infer<typeof teacherAssignmentResponseSchema>;

export const teacherAssignmentListResponseSchema = z.object({
  items: z.array(teacherAssignmentSchema),
  total: z.number().int().nonnegative(),
});
export type TeacherAssignmentListResponse = z.infer<typeof teacherAssignmentListResponseSchema>;

export const teacherAssignmentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TeacherAssignmentListQuery = z.infer<typeof teacherAssignmentListQuerySchema>;

/**
 * Route params for a teacher assignment nested under its parent class-subject
 * link: /classes/:id/subjects/:subjectId/teachers/:teacherId.
 */
export const teacherParamSchema = z.object({
  id: UuidSchema,
  subjectId: UuidSchema,
  teacherId: UuidSchema,
});
export type TeacherParam = z.infer<typeof teacherParamSchema>;

/**
 * Eligible-teacher directory entry (GET /teachers): an ACTIVE membership in the
 * tenant carrying the tenant-local `teacher` role. Only the user identity is
 * exposed — no PII beyond the display name.
 */
export const teacherDirectoryEntrySchema = z.object({
  userId: UuidSchema,
  fullName: z.string(),
});
export type TeacherDirectoryEntry = z.infer<typeof teacherDirectoryEntrySchema>;

export const teacherDirectoryResponseSchema = z.object({
  items: z.array(teacherDirectoryEntrySchema),
  total: z.number().int().nonnegative(),
});
export type TeacherDirectoryResponse = z.infer<typeof teacherDirectoryResponseSchema>;

// ------------------------------------------------------------------ transfers

export const TransferTypeSchema = z.enum(['in', 'out']);
export const TransferStatusSchema = z.enum(['in_progress', 'completed', 'cancelled']);

export const transferSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  studentId: UuidSchema,
  type: TransferTypeSchema,
  status: TransferStatusSchema,
  fromSchoolName: z.string().nullable(),
  toSchoolName: z.string().nullable(),
  reason: z.string().nullable(),
  transferredOn: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Transfer = z.infer<typeof transferSchema>;

/**
 * Transfer action body. Strict: only the outbound transfer's descriptive fields
 * are client-writable; type ('out'), status ('completed'), student and tenant are
 * server-derived. `transferredOn` defaults to the server's calendar date.
 */
export const transferStudentRequestSchema = z
  .object({
    toSchoolName: StringField.optional(),
    reason: StringField.optional(),
    transferredOn: IsoDate.optional(),
  })
  .strict();
export type TransferStudentRequest = z.infer<typeof transferStudentRequestSchema>;

export const transferResponseSchema = z.object({ transfer: transferSchema });
export type TransferResponse = z.infer<typeof transferResponseSchema>;

// ------------------------------------------------------------------ promotions

export const PromotionBatchStatusSchema = z.enum(['draft', 'in_progress', 'completed', 'cancelled']);
export const PromotionItemStatusSchema = z.enum(['pending', 'promoted', 'failed']);

export const promotionBatchSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  fromAcademicYearId: UuidSchema,
  toAcademicYearId: UuidSchema,
  status: PromotionBatchStatusSchema,
  createdBy: UuidSchema.nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromotionBatch = z.infer<typeof promotionBatchSchema>;

export const promotionItemSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  batchId: UuidSchema,
  studentId: UuidSchema,
  fromAcademicYearId: UuidSchema,
  toAcademicYearId: UuidSchema,
  fromSectionId: UuidSchema.nullable(),
  toSectionId: UuidSchema.nullable(),
  status: PromotionItemStatusSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromotionItem = z.infer<typeof promotionItemSchema>;

/** Create a promotion batch linking a from-year to a to-year. Strict (no mass-assignment). */
export const createPromotionBatchRequestSchema = z
  .object({
    fromAcademicYearId: UuidSchema,
    toAcademicYearId: UuidSchema,
  })
  .strict();
export type CreatePromotionBatchRequest = z.infer<typeof createPromotionBatchRequestSchema>;

/** Add students to a batch. Strict: only studentIds; the batch's years are inherited. */
export const addPromotionItemsRequestSchema = z
  .object({ studentIds: z.array(UuidSchema).min(1) })
  .strict();
export type AddPromotionItemsRequest = z.infer<typeof addPromotionItemsRequestSchema>;

export const promotionBatchResponseSchema = z.object({ promotionBatch: promotionBatchSchema });
export type PromotionBatchResponse = z.infer<typeof promotionBatchResponseSchema>;

/** Filter set for GET /api/v1/promotion-batches. */
export const promotionBatchListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: PromotionBatchStatusSchema.optional(),
});
export type PromotionBatchListQuery = z.infer<typeof promotionBatchListQuerySchema>;

export const promotionBatchListResponseSchema = z.object({
  items: z.array(promotionBatchSchema),
  total: z.number().int().nonnegative(),
});
export type PromotionBatchListResponse = z.infer<typeof promotionBatchListResponseSchema>;

export const promotionBatchDetailResponseSchema = z.object({
  promotionBatch: promotionBatchSchema,
  items: z.array(promotionItemSchema),
});
export type PromotionBatchDetailResponse = z.infer<typeof promotionBatchDetailResponseSchema>;

// ------------------------------------------------------------------ school settings

/**
 * Canonical shape of a branding object key as produced by the branding upload
 * route (PUT /api/v1/settings/branding): brand assets live under the `branding/`
 * category, are never tenant-prefixed by hand (the storage provider injects the
 * tenant prefix), and are restricted to raster formats that the serving route
 * maps back to a MIME type from the file extension.
 */
export const BRANDING_KEY_PATTERN =
  /^branding\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:png|jpg|jpeg|webp)$/;

/**
 * Canonical shape of a student-document object key produced by the upload route
 * (POST /api/v1/students/:id/documents): `documents/{uuidv7}.{ext}`. The serving
 * (download) route asserts a stored key matches this before reading the object,
 * so arbitrary server keys can never be streamed through the download endpoint.
 */
export const DOCUMENT_KEY_PATTERN =
  /^documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|jpeg|webp|pdf)$/;

export const schoolSettingsSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  schoolName: z.string(),
  schoolCode: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  brandingColor: z.string().nullable(),
  logoPath: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SchoolSettings = z.infer<typeof schoolSettingsSchema>;

export const updateSchoolSettingsRequestSchema = z
  .object({
    schoolName: StringField,
    schoolCode: z.string().max(40).optional(),
    email: z.string().email().max(320).optional(),
    phone: z.string().max(40).optional(),
    address: z.string().max(500).optional(),
    timezone: z.string().max(80).optional(),
    locale: z.string().max(10).optional(),
    brandingColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB hex color').optional(),
    logoPath: z.union([z.string().regex(BRANDING_KEY_PATTERN, 'logoPath must reference a branding object key'), z.null()]).optional(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateSchoolSettingsRequest = z.infer<typeof updateSchoolSettingsRequestSchema>;

export const schoolSettingsResponseSchema = z.object({ settings: schoolSettingsSchema });
export type SchoolSettingsResponse = z.infer<typeof schoolSettingsResponseSchema>;

// ------------------------------------------------------------------ student documents

/**
 * Free-form, tenant-defined classification of a student document (birth_certificate,
 * report_card, id_copy, ...). The DB has no CHECK on document_type on purpose —
 * schools define their own taxonomy.
 */
export const StudentDocumentTypeSchema = z.string().trim().min(1).max(64);

export const StudentFileScanStatusSchema = z.enum(['pending', 'clean', 'blocked']);

/**
 * A student document as surfaced to clients: the document metadata row joined with
 * the file metadata it references. `storageKey` is deliberately NOT exposed — object
 * keys are server-owned and clients only ever see the document via its authorization
 * contract (metadata/get/download).
 */
export const studentDocumentSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  studentId: UuidSchema,
  documentType: StudentDocumentTypeSchema,
  fileId: UuidSchema,
  originalName: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  scanStatus: StudentFileScanStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StudentDocument = z.infer<typeof studentDocumentSchema>;

/** POST /api/v1/students/:id/documents — file bytes + query-param metadata. */
export const studentDocumentUploadQuerySchema = z.object({
  documentType: StudentDocumentTypeSchema,
  /** Optional display name; sanitized server-side (basename only, no path/control bytes). */
  filename: z.string().trim().min(1).max(255).optional(),
});
export type StudentDocumentUploadQuery = z.infer<typeof studentDocumentUploadQuerySchema>;

/** Filter set for GET /api/v1/students/:id/documents. */
export const studentDocumentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  documentType: StudentDocumentTypeSchema.optional(),
});
export type StudentDocumentListQuery = z.infer<typeof studentDocumentListQuerySchema>;

/** PATCH /api/v1/students/:id/documents/:documentId — metadata only. */
export const updateStudentDocumentRequestSchema = z
  .object({
    documentType: StudentDocumentTypeSchema.optional(),
    originalName: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateStudentDocumentRequest = z.infer<typeof updateStudentDocumentRequestSchema>;

export const studentDocumentResponseSchema = z.object({ document: studentDocumentSchema });
export type StudentDocumentResponse = z.infer<typeof studentDocumentResponseSchema>;

export const studentDocumentListResponseSchema = z.object({
  items: z.array(studentDocumentSchema),
  total: z.number().int().nonnegative(),
});
export type StudentDocumentListResponse = z.infer<typeof studentDocumentListResponseSchema>;

/** GET/PATCH/DELETE under a student: the student is `:id`, the document `:documentId`. */
export const studentDocumentParamSchema = z.object({
  id: UuidSchema,
  documentId: UuidSchema,
});
export type StudentDocumentParam = z.infer<typeof studentDocumentParamSchema>;

// ------------------------------------------------------------------ admission applications (Phase 3.5)

/**
 * Exact status value set pinned by admission_applications_status_ck in migration
 * 0005. Transitions happen only through explicit action routes (submit/review/
 * approve/reject/withdraw) — this is never writable through create/PATCH.
 */
export const AdmissionApplicationStatusSchema = z.enum([
  'draft',
  'submitted',
  'under_review',
  'accepted',
  'rejected',
  'withdrawn',
]);

/**
 * The applicant snapshot carried on admission_applications.snapshot BEFORE a
 * student exists. These are the exact student-row fields an approval materializes
 * (0005 pins no applicant-specific columns, so we never duplicate student PII
 * beyond what this explicit, client-validated object defines). campusCode is the
 * tenants-unique campus code resolved at approval time inside the caller's tenant
 * and campus-authorization boundary — never a raw tenant/campus id.
 */
export const admissionSnapshotSchema = z
  .object({
    studentNo: StringField,
    firstName: StringField,
    lastName: StringField,
    dateOfBirth: IsoDate.optional(),
    gender: StudentGenderSchema.optional(),
    campusCode: z.string().max(80).optional(),
  })
  .strict();
export type AdmissionSnapshot = z.infer<typeof admissionSnapshotSchema>;

export const admissionApplicationSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  studentId: UuidSchema.nullable(),
  status: AdmissionApplicationStatusSchema,
  snapshot: admissionSnapshotSchema,
  appliedOn: IsoDate.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdmissionApplication = z.infer<typeof admissionApplicationSchema>;

/**
 * Create: an application begins in `draft` with a required applicant snapshot and
 * an OPTIONAL link to an existing student (`student_id` on the table). Strict —
 * status, timestamps, internal ids and tenant are never client-writable.
 */
export const createAdmissionApplicationRequestSchema = z
  .object({
    snapshot: admissionSnapshotSchema,
    studentId: UuidSchema.optional(),
    appliedOn: IsoDate.optional(),
  })
  .strict();
export type CreateAdmissionApplicationRequest = z.infer<typeof createAdmissionApplicationRequestSchema>;

/**
 * PATCH: only genuinely mutable metadata is writable. `studentId` and `status` are
 * NEVER patchable — linking happens at approval, status only via action routes.
 */
export const updateAdmissionApplicationRequestSchema = z
  .object({
    snapshot: admissionSnapshotSchema,
    appliedOn: IsoDate.optional(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateAdmissionApplicationRequest = z.infer<typeof updateAdmissionApplicationRequestSchema>;

export const admissionApplicationResponseSchema = z.object({ application: admissionApplicationSchema });
export type AdmissionApplicationResponse = z.infer<typeof admissionApplicationResponseSchema>;

export const admissionApplicationListResponseSchema = z.object({
  items: z.array(admissionApplicationSchema),
  total: z.number().int().nonnegative(),
});
export type AdmissionApplicationListResponse = z.infer<typeof admissionApplicationListResponseSchema>;

/** Filter set for GET /api/v1/admission-applications. No campus column exists on the
 *  table (campus binding happens at approval via snapshot.campusCode), so there is no
 *  campus filter — status and free-text search over the applicant snapshot only. */
export const admissionApplicationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: AdmissionApplicationStatusSchema.optional(),
  q: z.string().max(120).optional(),
});
export type AdmissionApplicationListQuery = z.infer<typeof admissionApplicationListQuerySchema>;

// ------------------------------------------------------------------ student CSV import + export (Phase 3.5)

/**
 * student_imports.status CHECK (migration 0007). The worker owns the transition
 * submitted -> processing -> completed|failed via a single-winner guarded UPDATE.
 */
export const StudentImportStatusSchema = z.enum(['submitted', 'processing', 'completed', 'failed']);
export const StudentImportRowStatusSchema = z.enum(['created', 'duplicate', 'conflict', 'rejected']);

export const studentImportSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  filename: z.string(),
  status: StudentImportStatusSchema,
  totalRows: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  errorSummary: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StudentImport = z.infer<typeof studentImportSchema>;

/** One row's safe, PII-free result (row number + result bucket + offending field/message). */
export const studentImportRowSchema = z.object({
  rowNumber: z.number().int().positive(),
  status: StudentImportRowStatusSchema,
  field: z.string().nullable(),
  message: z.string().nullable(),
});
export type StudentImportRow = z.infer<typeof studentImportRowSchema>;

export const studentImportResponseSchema = z.object({ import: studentImportSchema });
export type StudentImportResponse = z.infer<typeof studentImportResponseSchema>;

/** Upload metadata rides in the query string (raw-buffer body convention, like documents). */
export const studentImportUploadQuerySchema = z.object({
  filename: z.string().max(255).optional(),
});
export type StudentImportUploadQuery = z.infer<typeof studentImportUploadQuerySchema>;

export const studentImportListResponseSchema = z.object({
  items: z.array(studentImportSchema),
  total: z.number().int().nonnegative(),
});
export type StudentImportListResponse = z.infer<typeof studentImportListResponseSchema>;

export const studentImportDetailResponseSchema = z.object({
  import: studentImportSchema,
  rows: z.array(studentImportRowSchema),
});
export type StudentImportDetailResponse = z.infer<typeof studentImportDetailResponseSchema>;

/** Filter set for GET /api/v1/students/imports. */
export const studentImportListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: StudentImportStatusSchema.optional(),
});
export type StudentImportListQuery = z.infer<typeof studentImportListQuerySchema>;

/**
 * Explicit CSV import schema — the ONLY columns the importer may carry. They mirror
 * the 0005 student/guardian/student_guardian columns exactly (no middle_name exists
 * on students). Column names are the normalized canonical form; the worker maps them
 * by the documented aliases. Internal ids, tenant_id, status, timestamps, deleted_at
 * and audit fields are never accepted (worker derives them all).
 */
export const STUDENT_IMPORT_COLUMNS = [
  'student_no',
  'first_name',
  'last_name',
  'date_of_birth',
  'gender',
  'campus',
  'guardian_first_name',
  'guardian_last_name',
  'guardian_email',
  'guardian_phone',
  'relation',
  'is_primary',
] as const;
export const STUDENT_IMPORT_REQUIRED_COLUMNS = ['student_no', 'first_name', 'last_name'] as const;
export type StudentImportColumn = (typeof STUDENT_IMPORT_COLUMNS)[number];

export interface NormalizedImportHeader {
  /** Canonical column name per header cell position (null for empty/unknown cells). */
  positions: (StudentImportColumn | null)[];
  /** Required columns absent from the header. */
  missing: string[];
  /** Non-canonical, non-empty header cells (typos + unsupported columns). */
  unknown: string[];
}

/**
 * Normalizes a CSV header row to the canonical import schema. Both the API upload
 * route and the worker apply the SAME normalization so acceptance (upload) and
 * execution (worker rows) can never disagree on column meaning: trim + lowercase.
 * Positions are returned per header cell so a data row maps by index; unknown
 * non-empty headers are reported (the upload route rejects them; a worker never
 * sees a file the upload route did not accept).
 */
export function normalizeImportHeader(rawHeaders: readonly string[]): NormalizedImportHeader {
  const cells = rawHeaders.map((h) => h.trim().toLowerCase());
  const positions = cells.map((cell) =>
    (STUDENT_IMPORT_COLUMNS as readonly string[]).includes(cell) ? (cell as StudentImportColumn) : null,
  );
  const seen = new Set(positions.filter((p): p is StudentImportColumn => p !== null));
  const missing = STUDENT_IMPORT_REQUIRED_COLUMNS.filter((c) => !seen.has(c));
  const unknown = cells.filter((cell) => cell !== '' && !(STUDENT_IMPORT_COLUMNS as readonly string[]).includes(cell));
  return { positions, missing, unknown };
}

/** Filter set for GET /api/v1/students/export (same filters as the student list, no pagination). */
export const studentExportQuerySchema = z.object({
  q: z.string().max(120).optional(),
  status: StudentStatusSchema.optional(),
  campusId: UuidSchema.optional(),
});
export type StudentExportQuery = z.infer<typeof studentExportQuerySchema>;

// ------------------------------------------------------------------ shared

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Filter set for GET /api/v1/students. */
export const studentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(120).optional(),
  status: StudentStatusSchema.optional(),
  campusId: UuidSchema.optional(),
});
export type StudentListQuery = z.infer<typeof studentListQuerySchema>;

/** Filter set for GET /api/v1/guardians. */
export const guardianListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(120).optional(),
});
export type GuardianListQuery = z.infer<typeof guardianListQuerySchema>;

export const idParamSchema = z.object({ id: UuidSchema });

// ------------------------------------------------------------------ periods / timetable (Phase 4.3)
//
// The weekly bell set plus the grid. Period time fields are "HH:MM" strings (the
// DB columns are `time`); the server passes them through verbatim after a cheap
// regex sanity check — overlap and ordering are enforced by the DB exclusion
// constraint / CHECK, never parseable to a timezone.

export const PeriodTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
export type PeriodTime = z.infer<typeof PeriodTimeSchema>;

export const PeriodStatusSchema = z.enum(['active', 'inactive']);

export const periodSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  campusId: UuidSchema.nullable(), // null = tenant-wide bell set
  name: StringField,
  periodNo: z.number().int().positive(),
  startTime: PeriodTimeSchema,
  endTime: PeriodTimeSchema,
  status: PeriodStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Period = z.infer<typeof periodSchema>;

/** Create a period. campusId optional — null/omitted = the tenant-wide bell set. */
export const createPeriodRequestSchema = z
  .object({
    name: StringField,
    periodNo: z.number().int().positive(),
    startTime: PeriodTimeSchema,
    endTime: PeriodTimeSchema,
    campusId: UuidSchema.nullable().optional(),
  })
  .strict();
export type CreatePeriodRequest = z.infer<typeof createPeriodRequestSchema>;

export const updatePeriodRequestSchema = createPeriodRequestSchema
  .partial()
  .extend({ status: PeriodStatusSchema.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdatePeriodRequest = z.infer<typeof updatePeriodRequestSchema>;

export const periodResponseSchema = z.object({ period: periodSchema });
export type PeriodResponse = z.infer<typeof periodResponseSchema>;

export const periodListResponseSchema = z.object({
  items: z.array(periodSchema),
  total: z.number().int().nonnegative(),
});
export type PeriodListResponse = z.infer<typeof periodListResponseSchema>;

export const periodListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  campusId: UuidSchema.optional(),
  status: PeriodStatusSchema.optional(),
});
export type PeriodListQuery = z.infer<typeof periodListQuerySchema>;

export const periodParamSchema = z.object({ id: UuidSchema });
export type PeriodParam = z.infer<typeof periodParamSchema>;

/** One weekly grid cell. teacherUserId is derived server-side from the LIVE
 * teacher_assignment of the (class, subject) — never client-writable. */
export const timetableEntrySchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  classId: UuidSchema,
  sectionId: UuidSchema,
  subjectId: UuidSchema,
  teacherUserId: UuidSchema,
  periodId: UuidSchema,
  campusId: UuidSchema,
  academicYearId: UuidSchema,
  weekday: z.number().int().min(1).max(7), // 1 = Monday .. 7 = Sunday (ISO)
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TimetableEntry = z.infer<typeof timetableEntrySchema>;

export const createTimetableEntryRequestSchema = z
  .object({
    subjectId: UuidSchema,
    weekday: z.number().int().min(1).max(7),
    periodId: UuidSchema,
  })
  .strict();
export type CreateTimetableEntryRequest = z.infer<typeof createTimetableEntryRequestSchema>;

/** A grid cell may be MOVED (weekday/period) but its subject is immutable — the
 * subject of a slot only changes by deleting the lesson and adding a new one. */
export const updateTimetableEntryRequestSchema = z
  .object({
    weekday: z.number().int().min(1).max(7).optional(),
    periodId: UuidSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateTimetableEntryRequest = z.infer<typeof updateTimetableEntryRequestSchema>;

export const timetableEntryResponseSchema = z.object({
  entry: timetableEntrySchema,
});
export type TimetableEntryResponse = z.infer<typeof timetableEntryResponseSchema>;

export const timetableEntryListResponseSchema = z.object({
  items: z.array(timetableEntrySchema),
  total: z.number().int().nonnegative(),
});
export type TimetableEntryListResponse = z.infer<typeof timetableEntryListResponseSchema>;

export const timetableEntryListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  classId: UuidSchema.optional(),
  sectionId: UuidSchema.optional(),
  subjectId: UuidSchema.optional(),
  weekday: z.coerce.number().int().min(1).max(7).optional(),
});
export type TimetableEntryListQuery = z.infer<typeof timetableEntryListQuerySchema>;

/** Route params for an entry nested under its parent class section:
 * /classes/:id/sections/:sectionId/timetable/:entryId. */
export const timetableEntryParamSchema = z.object({
  id: UuidSchema,
  sectionId: UuidSchema,
  entryId: UuidSchema,
});
export type TimetableEntryParam = z.infer<typeof timetableEntryParamSchema>;

/**
 * Publish validation. The body is intentionally empty — the server re-scans every
 * live entry in the tenant for teacher double-bookings and returns a list of the
 * offending (weekday, teacherUserId, subjectCount) rows when conflicts exist.
 */
export const publishTimetableRequestSchema = z.object({}).strict();
export type PublishTimetableRequest = z.infer<typeof publishTimetableRequestSchema>;

export const timetableConflictSchema = z.object({
  weekday: z.number().int().min(1).max(7),
  teacherUserId: UuidSchema,
  entryCount: z.number().int().positive(),
});
export type TimetableConflict = z.infer<typeof timetableConflictSchema>;

export const publishTimetableResponseSchema = z.object({
  published: z.boolean(),
  conflicts: z.array(timetableConflictSchema).default([]),
});
export type PublishTimetableResponse = z.infer<typeof publishTimetableResponseSchema>;

// ------------------------------------------------------------------ homework / attachments (Phase 4.3)

export const homeworkSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  classId: UuidSchema,
  subjectId: UuidSchema,
  teacherUserId: UuidSchema,
  campusId: UuidSchema,
  academicYearId: UuidSchema,
  title: StringField,
  body: z.string().max(8000).nullable(),
  dueAt: z.string().datetime().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Homework = z.infer<typeof homeworkSchema>;

/** Create homework for the class in the URL. teacherUserId is derived
 * server-side from the calling user; only the assigned teacher may author. */
export const createHomeworkRequestSchema = z
  .object({
    subjectId: UuidSchema,
    title: StringField,
    body: z.string().max(8000).optional(),
    dueAt: z.string().datetime().optional(),
    attachmentFileIds: z.array(UuidSchema).max(10).default([]),
  })
  .strict();
export type CreateHomeworkRequest = z.infer<typeof createHomeworkRequestSchema>;

/** PATCHes the mutable fields only (title/body/dueAt). body/dueAt may be passed
 * as null to clear them; subjectId is immutable — a homework row keeps the
 * subject it was created under. */
export const updateHomeworkRequestSchema = z
  .object({
    title: StringField.optional(),
    body: z.string().max(8000).nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateHomeworkRequest = z.infer<typeof updateHomeworkRequestSchema>;

export const homeworkAttachmentSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  homeworkId: UuidSchema,
  fileId: UuidSchema,
  createdAt: z.string(),
});
export type HomeworkAttachment = z.infer<typeof homeworkAttachmentSchema>;

export const homeworkDetailSchema = homeworkSchema.extend({
  attachments: z.array(homeworkAttachmentSchema).default([]),
});
export type HomeworkDetail = z.infer<typeof homeworkDetailSchema>;

export const homeworkResponseSchema = z.object({ homework: homeworkDetailSchema });
export type HomeworkResponse = z.infer<typeof homeworkResponseSchema>;

export const homeworkListResponseSchema = z.object({
  items: z.array(homeworkDetailSchema),
  total: z.number().int().nonnegative(),
});
export type HomeworkListResponse = z.infer<typeof homeworkListResponseSchema>;

/**
 * Portal self-scoping context (GET /api/v1/me/homework-context, homework.read).
 * Mirrors the per-class read visibility exactly (see AUTHORIZATION.md §...):
 *   * staff   -> owner/principal: every LIVE class in the tenant
 *   * teacher -> the LIVE classes the teacher is assigned to
 *   * parent  -> LIVE classes of the caller's linked (guardianship) students
 *   * student -> LIVE classes of the caller's own link (students.user_id)
 *   * none    -> any other homework.read holder: no classes at all
 * A portal renders an honest empty state for role 'none' and for an un-configured
 * (unlinked) parent/student role that resolves to no classes.
 */
export const homeworkContextClassSchema = z.object({
  id: UuidSchema,
  code: StringField,
  name: z.string().nullable(),
  campusId: UuidSchema.nullable(),
  academicYearId: UuidSchema,
});
export type HomeworkContextClass = z.infer<typeof homeworkContextClassSchema>;

export const homeworkContextRoleSchema = z.enum(['staff', 'teacher', 'parent', 'student', 'none']);

export const homeworkContextSchema = z.object({
  role: homeworkContextRoleSchema,
  classes: z.array(homeworkContextClassSchema),
});
export type HomeworkContext = z.infer<typeof homeworkContextSchema>;

export const homeworkContextResponseSchema = z.object({ context: homeworkContextSchema });
export type HomeworkContextResponse = z.infer<typeof homeworkContextResponseSchema>;

export const homeworkListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  classId: UuidSchema.optional(),
  subjectId: UuidSchema.optional(),
  dueBefore: z.string().datetime().optional(),
});
export type HomeworkListQuery = z.infer<typeof homeworkListQuerySchema>;

/** Route params for homework nested under its parent class:
 * /classes/:id/homework/:homeworkId. */
export const homeworkParamSchema = z.object({
  id: UuidSchema,
  homeworkId: UuidSchema,
});
export type HomeworkParam = z.infer<typeof homeworkParamSchema>;

/** subjectId is required because a subject may be taught in many classes. */
export const homeworkListParamSchema = z.object({ id: UuidSchema });
export type HomeworkListParam = z.infer<typeof homeworkListParamSchema>;

// ------------------------------------------------------------------ attendance & leave (Phase 5)

/** Present | Absent | Late | Excused — the daily and period-level status set. */
export const AttendanceStatusSchema = z.enum(['present', 'absent', 'late', 'excused']);
export type AttendanceStatus = z.infer<typeof AttendanceStatusSchema>;

/** Staff clock adds `on_leave` to the student status vocabulary. */
export const StaffAttendanceStatusSchema = z.enum([
  'present',
  'absent',
  'late',
  'excused',
  'on_leave',
]);
export type StaffAttendanceStatus = z.infer<typeof StaffAttendanceStatusSchema>;

/** `manual` = daily register, `period` = derived/rolled up from period marking. */
export const AttendanceSourceSchema = z.enum(['manual', 'period']);
export type AttendanceSource = z.infer<typeof AttendanceSourceSchema>;

export const LeaveRequestStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type LeaveRequestStatus = z.infer<typeof LeaveRequestStatusSchema>;

// ------------------------------------------------------------------ leave types

export const leaveTypeSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: StringField,
  name: StringField,
  status: z.enum(['active', 'inactive']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LeaveType = z.infer<typeof leaveTypeSchema>;

export const createLeaveTypeRequestSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9_-]+$/, 'code must be lowercase alphanumeric with - or _'),
    name: StringField,
  })
  .strict();
export type CreateLeaveTypeRequest = z.infer<typeof createLeaveTypeRequestSchema>;

/** `code` is immutable (the DB trigger enforces it too); only the label and the
 * active flag may change. */
export const updateLeaveTypeRequestSchema = z
  .object({
    name: StringField.optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateLeaveTypeRequest = z.infer<typeof updateLeaveTypeRequestSchema>;

export const leaveTypeResponseSchema = z.object({ leaveType: leaveTypeSchema });
export type LeaveTypeResponse = z.infer<typeof leaveTypeResponseSchema>;

export const leaveTypeListResponseSchema = z.object({
  items: z.array(leaveTypeSchema),
  total: z.number().int().nonnegative(),
});
export type LeaveTypeListResponse = z.infer<typeof leaveTypeListResponseSchema>;

// ------------------------------------------------------------------ daily attendance

export const attendanceDaySchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  studentId: UuidSchema,
  campusId: UuidSchema.nullable(),
  attendanceDate: IsoDate,
  status: AttendanceStatusSchema,
  source: AttendanceSourceSchema,
  markedBy: UuidSchema,
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AttendanceDay = z.infer<typeof attendanceDaySchema>;

export const attendanceDayListResponseSchema = z.object({
  items: z.array(attendanceDaySchema),
  total: z.number().int().nonnegative(),
});
export type AttendanceDayListResponse = z.infer<typeof attendanceDayListResponseSchema>;

/**
 * Bulk daily mark. Deliberately `.strict()` and free of tenantId/markedBy/
 * campusId/source-on-the-row: the marker is the caller and the campus is derived
 * from the student, so none of those are client-writable (mass-assignment).
 * A repeated mark for the same (student, date) is resolved by the server as an
 * update of today's record; a past date is a DB-enforced 409.
 */
export const markAttendanceRequestSchema = z
  .object({
    date: IsoDate,
    entries: z
      .array(
        z
          .object({
            studentId: UuidSchema,
            status: AttendanceStatusSchema,
            note: z.string().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type MarkAttendanceRequest = z.infer<typeof markAttendanceRequestSchema>;

/** Same-day correction. `reason` is MANDATORY: the correction audit row is only
 * meaningful with a stated cause (roadmap: "corrections w/ reason (audit)"). */
export const correctAttendanceRequestSchema = z
  .object({
    status: AttendanceStatusSchema,
    reason: z.string().min(3).max(500),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();
export type CorrectAttendanceRequest = z.infer<typeof correctAttendanceRequestSchema>;

// ------------------------------------------------------------------ period attendance

export const attendancePeriodSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  studentId: UuidSchema,
  sectionId: UuidSchema,
  periodId: UuidSchema,
  attendanceDate: IsoDate,
  status: AttendanceStatusSchema,
  markedBy: UuidSchema,
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AttendancePeriod = z.infer<typeof attendancePeriodSchema>;

export const attendancePeriodListResponseSchema = z.object({
  items: z.array(attendancePeriodSchema),
  total: z.number().int().nonnegative(),
});
export type AttendancePeriodListResponse = z.infer<typeof attendancePeriodListResponseSchema>;

/** Period-level bulk mark for one section + one bell period on one date. */
export const markAttendancePeriodsRequestSchema = z
  .object({
    sectionId: UuidSchema,
    periodId: UuidSchema,
    date: IsoDate,
    entries: z
      .array(
        z
          .object({
            studentId: UuidSchema,
            status: AttendanceStatusSchema,
            note: z.string().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type MarkAttendancePeriodsRequest = z.infer<typeof markAttendancePeriodsRequestSchema>;

export const correctAttendancePeriodRequestSchema = z
  .object({
    status: AttendanceStatusSchema,
    reason: z.string().min(3).max(500),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();
export type CorrectAttendancePeriodRequest = z.infer<typeof correctAttendancePeriodRequestSchema>;

// ------------------------------------------------------------------ roster (marking UI)

/**
 * Register view for one section on one date: every actively enrolled student,
 * their current daily status (null = not marked yet) and their roll number.
 * This is the teacher class roster the marking UI writes against.
 */
export const attendanceRosterEntrySchema = z.object({
  studentId: UuidSchema,
  studentNo: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  rollNo: z.string().nullable(),
  status: AttendanceStatusSchema.nullable(),
  attendanceId: UuidSchema.nullable(),
});
export type AttendanceRosterEntry = z.infer<typeof attendanceRosterEntrySchema>;

export const attendanceRosterResponseSchema = z.object({
  sectionId: UuidSchema,
  sectionCode: z.string(),
  classId: UuidSchema,
  className: z.string(),
  campusId: UuidSchema,
  date: IsoDate,
  entries: z.array(attendanceRosterEntrySchema),
});
export type AttendanceRosterResponse = z.infer<typeof attendanceRosterResponseSchema>;

// ------------------------------------------------------------------ staff attendance

export const staffAttendanceSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  userId: UuidSchema,
  attendanceDate: IsoDate,
  clockIn: z.string().nullable(),
  clockOut: z.string().nullable(),
  status: StaffAttendanceStatusSchema,
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StaffAttendanceRow = z.infer<typeof staffAttendanceSchema>;

export const staffAttendanceListResponseSchema = z.object({
  items: z.array(staffAttendanceSchema),
  total: z.number().int().nonnegative(),
});
export type StaffAttendanceListResponse = z.infer<typeof staffAttendanceListResponseSchema>;

export const markStaffAttendanceRequestSchema = z
  .object({
    userId: UuidSchema,
    date: IsoDate,
    status: StaffAttendanceStatusSchema.default('present'),
    clockIn: IsoDateTime.optional(),
    clockOut: IsoDateTime.optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
export type MarkStaffAttendanceRequest = z.infer<typeof markStaffAttendanceRequestSchema>;

// ------------------------------------------------------------------ leave requests

export const leaveRequestSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  studentId: UuidSchema,
  leaveTypeId: UuidSchema,
  startDate: IsoDate,
  endDate: IsoDate,
  reason: z.string().nullable(),
  status: LeaveRequestStatusSchema,
  requestedBy: UuidSchema,
  approverUserId: UuidSchema.nullable(),
  decisionAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LeaveRequest = z.infer<typeof leaveRequestSchema>;

export const leaveRequestListResponseSchema = z.object({
  items: z.array(leaveRequestSchema),
  total: z.number().int().nonnegative(),
});
export type LeaveRequestListResponse = z.infer<typeof leaveRequestListResponseSchema>;

/** Filing a leave request. `studentId` is verified against the caller's
 * relationship (guardian link or own student link) server-side; `status`,
 * `requestedBy`, `approverUserId` and `decisionAt` are never client-writable. */
export const createLeaveRequestSchema = z
  .object({
    studentId: UuidSchema,
    leaveTypeId: UuidSchema,
    startDate: IsoDate,
    endDate: IsoDate,
    reason: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.startDate <= v.endDate, {
    message: 'endDate must not precede startDate',
    path: ['endDate'],
  });
export type CreateLeaveRequest = z.infer<typeof createLeaveRequestSchema>;

export const decideLeaveRequestSchema = z
  .object({
    note: z.string().max(500).optional(),
  })
  .strict();
export type DecideLeaveRequest = z.infer<typeof decideLeaveRequestSchema>;

// ------------------------------------------------------------------ queries & reports

export const attendanceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  date: IsoDate.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  studentId: UuidSchema.optional(),
  status: AttendanceStatusSchema.optional(),
  campusId: UuidSchema.optional(),
});
export type AttendanceListQuery = z.infer<typeof attendanceListQuerySchema>;

export const attendancePeriodListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  date: IsoDate.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  sectionId: UuidSchema.optional(),
  periodId: UuidSchema.optional(),
  studentId: UuidSchema.optional(),
  status: AttendanceStatusSchema.optional(),
});
export type AttendancePeriodListQuery = z.infer<typeof attendancePeriodListQuerySchema>;

export const staffAttendanceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  date: IsoDate.optional(),
  userId: UuidSchema.optional(),
  status: StaffAttendanceStatusSchema.optional(),
});
export type StaffAttendanceListQuery = z.infer<typeof staffAttendanceListQuerySchema>;

export const leaveRequestListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  studentId: UuidSchema.optional(),
  status: LeaveRequestStatusSchema.optional(),
});
export type LeaveRequestListQuery = z.infer<typeof leaveRequestListQuerySchema>;

export const leaveTypeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['active', 'inactive']).optional(),
});
export type LeaveTypeListQuery = z.infer<typeof leaveTypeListQuerySchema>;

export const attendanceRosterQuerySchema = z.object({
  sectionId: UuidSchema,
  date: IsoDate,
});
export type AttendanceRosterQuery = z.infer<typeof attendanceRosterQuerySchema>;

/**
 * Class/day report: the roster plus the day's tally. `counts` is computed from
 * the database, never accumulated in the client, so the report is a snapshot of
 * what is actually recorded (DATABASE_DESIGN §6: "reports read snapshots").
 */
export const attendanceReportCountsSchema = z.object({
  present: z.number().int().nonnegative(),
  absent: z.number().int().nonnegative(),
  late: z.number().int().nonnegative(),
  excused: z.number().int().nonnegative(),
  unmarked: z.number().int().nonnegative(),
});
export type AttendanceReportCounts = z.infer<typeof attendanceReportCountsSchema>;

export const attendanceClassReportResponseSchema = z.object({
  sectionId: UuidSchema,
  sectionCode: z.string(),
  classId: UuidSchema,
  className: z.string(),
  campusId: UuidSchema,
  date: IsoDate,
  counts: attendanceReportCountsSchema,
  entries: z.array(attendanceRosterEntrySchema),
});
export type AttendanceClassReportResponse = z.infer<typeof attendanceClassReportResponseSchema>;

/** Per-student aggregate over a date window (parent/student portal + admin). */
export const attendanceStudentReportResponseSchema = z.object({
  studentId: UuidSchema,
  from: IsoDate,
  to: IsoDate,
  counts: attendanceReportCountsSchema,
});
export type AttendanceStudentReportResponse = z.infer<typeof attendanceStudentReportResponseSchema>;

export const attendanceStudentReportQuerySchema = z
  .object({
    studentId: UuidSchema,
    from: IsoDate,
    to: IsoDate,
  })
  .refine((v) => v.from <= v.to, {
    message: 'from must not be after to',
    path: ['from'],
  });
export type AttendanceStudentReportQuery = z.infer<typeof attendanceStudentReportQuerySchema>;

/**
 * Self-scoped portal context (GET /api/v1/me/attendance-context). Mirrors the
 * per-route visibility exactly: staff see the whole school, a teacher sees their
 * own students, a parent sees the students they are a guardian of, a student sees
 * their own link, and any other attendance.read holder sees nothing. The portal
 * renders `role: 'none'` / an unlinked portal as an honest empty state.
 */
export const attendanceContextRoleSchema = z.enum(['staff', 'teacher', 'parent', 'student', 'none']);
export type AttendanceContextRole = z.infer<typeof attendanceContextRoleSchema>;

export const attendanceContextStudentSchema = z.object({
  id: UuidSchema,
  studentNo: z.string(),
  firstName: z.string(),
  lastName: z.string(),
});
export type AttendanceContextStudent = z.infer<typeof attendanceContextStudentSchema>;

export const attendanceContextSchema = z.object({
  role: attendanceContextRoleSchema,
  students: z.array(attendanceContextStudentSchema),
});
export type AttendanceContext = z.infer<typeof attendanceContextSchema>;

export const attendanceContextResponseSchema = z.object({ context: attendanceContextSchema });
export type AttendanceContextResponse = z.infer<typeof attendanceContextResponseSchema>;

/** Range filter shared by the portal read view (bounded so a portal cannot
 * ask the server for an unbounded scan). */
export const attendanceRangeQuerySchema = z
  .object({
    from: IsoDate.optional(),
    to: IsoDate.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'from must not be after to',
    path: ['from'],
  });
export type AttendanceRangeQuery = z.infer<typeof attendanceRangeQuerySchema>;

/** Self-scoped attendance rows for a portal user: one bucket per visible student. */
export const attendancePortalViewSchema = z.object({
  student: attendanceContextStudentSchema,
  counts: attendanceReportCountsSchema,
  records: z.array(attendanceDaySchema),
});
export type AttendancePortalView = z.infer<typeof attendancePortalViewSchema>;

export const attendancePortalResponseSchema = z.object({
  context: attendanceContextSchema,
  views: z.array(attendancePortalViewSchema),
});
export type AttendancePortalResponse = z.infer<typeof attendancePortalResponseSchema>;

// ==================================================================
// Phase 6 — Exams + Results
//
// State ownership (roadmap Phase 6 + DATABASE_DESIGN §8):
//   * every lifecycle state is SERVER-derived. `status`, `publishedAt`,
//     `enteredBy`, `lockedAt`, `grade*` and `fileId` are never client-writable —
//     the write schemas below are `.strict()`, so an injected field is a 400.
//   * `tenantId`, `campusId` and `academicYearId` are derived from the target
//     records (exam -> term -> year; exam subject -> class subject), never taken
//     from the request body.
//   * the teacher identity for mark entry comes from the session; a
//     client-supplied teacher id is not part of the contract at all.
// ==================================================================

export const ExamStatusSchema = z.enum([
  'draft',
  'scheduled',
  'grading',
  'published',
  'cancelled',
]);
export type ExamStatus = z.infer<typeof ExamStatusSchema>;

export const MarkStatusSchema = z.enum(['provisional', 'locked', 'rechecked']);
export type MarkStatus = z.infer<typeof MarkStatusSchema>;

export const ReportCardStatusSchema = z.enum(['draft', 'published']);
export type ReportCardStatus = z.infer<typeof ReportCardStatusSchema>;

/** One band of a grading scale. Bands of one scale may not overlap and each is a
 * half-open percentage range `[minPercent, maxPercent)`; the top band ends at
 * 100. `gradePoint` is the GPA input, so it is bounded to 0..4. */
export const gradingScaleBandSchema = z
  .object({
    label: z.string().min(1).max(16),
    minPercent: z.number().min(0).max(100),
    maxPercent: z.number().min(0).max(100),
    gradePoint: z.number().min(0).max(4),
  })
  .strict()
  .refine((b) => b.minPercent < b.maxPercent, {
    message: 'minPercent must be less than maxPercent',
    path: ['minPercent'],
  });
export type GradingScaleBand = z.infer<typeof gradingScaleBandSchema>;

export const examTypeSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExamType = z.infer<typeof examTypeSchema>;

export const examTypeListResponseSchema = z.object({
  items: z.array(examTypeSchema),
  total: z.number().int().nonnegative(),
});
export type ExamTypeListResponse = z.infer<typeof examTypeListResponseSchema>;

export const createExamTypeRequestSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_]+$/, 'code must be lowercase alphanumeric/underscore'),
    name: StringField,
  })
  .strict();
export type CreateExamTypeRequest = z.infer<typeof createExamTypeRequestSchema>;

export const updateExamTypeRequestSchema = z
  .object({
    name: StringField.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateExamTypeRequest = z.infer<typeof updateExamTypeRequestSchema>;

export const examSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  academicTermId: UuidSchema,
  academicYearId: UuidSchema,
  examTypeId: UuidSchema,
  campusId: UuidSchema.nullable(),
  name: z.string(),
  status: ExamStatusSchema,
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Exam = z.infer<typeof examSchema>;

export const examListResponseSchema = z.object({
  items: z.array(examSchema),
  total: z.number().int().nonnegative(),
});
export type ExamListResponse = z.infer<typeof examListResponseSchema>;

/** Creating an exam pins it to an academic term; the academic year is derived
 * server-side from the term, so a client cannot pin an exam to another year.
 * `gradingScaleId` is optional and nullable: omitted = the tenant's active scale
 * at compute time, pinned = that version produced this exam's grades. */
export const createExamRequestSchema = z
  .object({
    academicTermId: UuidSchema,
    examTypeId: UuidSchema,
    name: StringField,
    campusId: UuidSchema.nullable().optional(),
    gradingScaleId: UuidSchema.nullable().optional(),
  })
  .strict();
export type CreateExamRequest = z.infer<typeof createExamRequestSchema>;

export const updateExamRequestSchema = z
  .object({
    name: StringField.optional(),
  })
  .strict();
export type UpdateExamRequest = z.infer<typeof updateExamRequestSchema>;

export const examListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  academicYearId: UuidSchema.optional(),
  academicTermId: UuidSchema.optional(),
  status: ExamStatusSchema.optional(),
  campusId: UuidSchema.optional(),
});
export type ExamListQuery = z.infer<typeof examListQuerySchema>;

/**
 * Lifecycle transition target. `published` is deliberately NOT accepted here:
 * publication is a separate permission (`exams.publish`) and a separate
 * endpoint, so holding `exams.manage` can never publish results. The DB
 * lifecycle trigger is the authority on which transition is legal; this schema
 * only narrows the request to the states a client may ever ask for.
 */
export const examStatusTransitionRequestSchema = z
  .object({
    status: z.enum(['scheduled', 'grading', 'draft', 'cancelled']),
  })
  .strict();
export type ExamStatusTransitionRequest = z.infer<typeof examStatusTransitionRequestSchema>;

export const examSubjectSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  examId: UuidSchema,
  classSubjectId: UuidSchema,
  academicYearId: UuidSchema,
  classId: UuidSchema,
  subjectId: UuidSchema,
  maxMarks: z.number(),
  weight: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExamSubject = z.infer<typeof examSubjectSchema>;

export const examSubjectListResponseSchema = z.object({
  items: z.array(examSubjectSchema),
  total: z.number().int().nonnegative(),
});
export type ExamSubjectListResponse = z.infer<typeof examSubjectListResponseSchema>;

/** `maxMarks` is the denominator for every mark of this exam subject, so it is
 * bounded above; `weight` is the GPA weight and may not be zero, otherwise the
 * subject would silently drop out of the weighted average. */
export const createExamSubjectRequestSchema = z
  .object({
    examId: UuidSchema,
    classSubjectId: UuidSchema,
    maxMarks: z.number().positive().max(1000),
    weight: z.number().min(0).max(100),
  })
  .strict()
  .refine((v) => v.weight > 0, {
    message: 'weight must be greater than zero',
    path: ['weight'],
  });
export type CreateExamSubjectRequest = z.infer<typeof createExamSubjectRequestSchema>;

export const updateExamSubjectRequestSchema = z
  .object({
    maxMarks: z.number().positive().max(1000).optional(),
    weight: z.number().min(0).max(100).optional(),
  })
  .strict()
  .refine((v) => v.weight === undefined || v.weight > 0, {
    message: 'weight must be greater than zero',
    path: ['weight'],
  });
export type UpdateExamSubjectRequest = z.infer<typeof updateExamSubjectRequestSchema>;

export const examScheduleSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  examSubjectId: UuidSchema,
  startsAt: z.string(),
  endsAt: z.string(),
  room: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExamSchedule = z.infer<typeof examScheduleSchema>;

export const examScheduleListResponseSchema = z.object({
  items: z.array(examScheduleSchema),
  total: z.number().int().nonnegative(),
});
export type ExamScheduleListResponse = z.infer<typeof examScheduleListResponseSchema>;

export const createExamScheduleRequestSchema = z
  .object({
    examSubjectId: UuidSchema,
    startsAt: IsoDateTime,
    endsAt: IsoDateTime,
    room: z.string().max(120).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.startsAt) < Date.parse(v.endsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });
export type CreateExamScheduleRequest = z.infer<typeof createExamScheduleRequestSchema>;

export const updateExamScheduleRequestSchema = z
  .object({
    startsAt: IsoDateTime.optional(),
    endsAt: IsoDateTime.optional(),
    room: z.string().max(120).nullable().optional(),
  })
  .strict()
  .refine((v) => !v.startsAt || !v.endsAt || Date.parse(v.startsAt) < Date.parse(v.endsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });
export type UpdateExamScheduleRequest = z.infer<typeof updateExamScheduleRequestSchema>;

export const gradingScaleSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: z.string(),
  name: z.string(),
  version: z.number().int(),
  isActive: z.boolean(),
  bands: z.array(gradingScaleBandSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GradingScale = z.infer<typeof gradingScaleSchema>;

export const gradingScaleListResponseSchema = z.object({
  items: z.array(gradingScaleSchema),
  total: z.number().int().nonnegative(),
});
export type GradingScaleListResponse = z.infer<typeof gradingScaleListResponseSchema>;

/** A version of a grading scale: the client sends the bands, the server owns
 * `version` (monotonic per code) and the active flag. Bands must tile 0..100
 * without gaps or overlap. `isActive` defaults to false so publishing a new
 * version never silently displaces the current one. */
export const createGradingScaleRequestSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_]+$/, 'code must be lowercase alphanumeric/underscore'),
    name: StringField,
    bands: z.array(gradingScaleBandSchema).min(1).max(12),
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateGradingScaleRequest = z.infer<typeof createGradingScaleRequestSchema>;

export const updateGradingScaleRequestSchema = z
  .object({
    name: StringField.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateGradingScaleRequest = z.infer<typeof updateGradingScaleRequestSchema>;

export const markSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  examSubjectId: UuidSchema,
  enrollmentId: UuidSchema,
  studentId: UuidSchema,
  sectionId: UuidSchema.nullable(),
  marksObtained: z.number().nullable(),
  percentage: z.number().nullable(),
  gradeLabel: z.string().nullable(),
  gradePoint: z.number().nullable(),
  status: MarkStatusSchema,
  enteredBy: UuidSchema.nullable(),
  lockedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Mark = z.infer<typeof markSchema>;

export const gradebookRowSchema = z.object({
  enrollmentId: UuidSchema,
  studentId: UuidSchema,
  rollNo: z.string().nullable(),
  studentName: z.string(),
  sectionId: UuidSchema.nullable(),
  marksObtained: z.number().nullable(),
  percentage: z.number().nullable(),
  gradeLabel: z.string().nullable(),
  gradePoint: z.number().nullable(),
  status: MarkStatusSchema,
});
export type GradebookRow = z.infer<typeof gradebookRowSchema>;

export const gradebookResponseSchema = z.object({
  exam: examSchema,
  examSubject: examSubjectSchema,
  subjectName: z.string(),
  className: z.string(),
  sectionName: z.string().nullable(),
  maxMarks: z.number(),
  canMark: z.boolean(),
  rows: z.array(gradebookRowSchema),
  locked: z.boolean(),
});
export type GradebookResponse = z.infer<typeof gradebookResponseSchema>;

/** Mark entry. `marksObtained` may be null (not graded yet) or a number; the
 * `maxMarks` ceiling is enforced by a CHECK plus a trigger. No teacher id, no
 * status and no grade: the acting teacher comes from the session and the grade
 * is computed, never posted. */
export const enterMarksRequestSchema = z
  .object({
    examSubjectId: UuidSchema,
    entries: z
      .array(
        z
          .object({
            enrollmentId: UuidSchema,
            marksObtained: z.number().min(0).max(1000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type EnterMarksRequest = z.infer<typeof enterMarksRequestSchema>;

export const markEntryResponseSchema = z.object({
  marks: z.array(markSchema),
  entered: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
});
export type MarkEntryResponse = z.infer<typeof markEntryResponseSchema>;

export const correctMarkRequestSchema = z
  .object({
    marksObtained: z.number().min(0).max(1000),
    reason: z.string().min(3).max(500),
  })
  .strict();
export type CorrectMarkRequest = z.infer<typeof correctMarkRequestSchema>;

export const markCorrectionSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  markId: UuidSchema,
  oldMarksObtained: z.number().nullable(),
  newMarksObtained: z.number(),
  reason: z.string(),
  correctedBy: UuidSchema,
  createdAt: z.string(),
});
export type MarkCorrection = z.infer<typeof markCorrectionSchema>;

export const markCorrectionListResponseSchema = z.object({
  items: z.array(markCorrectionSchema),
  total: z.number().int().nonnegative(),
});
export type MarkCorrectionListResponse = z.infer<typeof markCorrectionListResponseSchema>;

/** Per-student aggregate produced by the result-computation job. It is a
 * server-computed snapshot: the client never posts `gpa` or `totalObtained`. */
export const reportCardSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  examId: UuidSchema,
  studentId: UuidSchema,
  enrollmentId: UuidSchema,
  version: z.number().int(),
  status: ReportCardStatusSchema,
  gpa: z.number().nullable(),
  totalObtained: z.number().nullable(),
  totalPossible: z.number(),
  subjectCount: z.number().int(),
  fileId: UuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReportCard = z.infer<typeof reportCardSchema>;

export const reportCardSubjectLineSchema = z.object({
  subjectName: z.string(),
  marksObtained: z.number().nullable(),
  maxMarks: z.number(),
  percentage: z.number().nullable(),
  gradeLabel: z.string().nullable(),
  gradePoint: z.number().nullable(),
  weight: z.number(),
});
export type ReportCardSubjectLine = z.infer<typeof reportCardSubjectLineSchema>;

export const reportCardDetailSchema = reportCardSchema.extend({
  exam: examSchema,
  studentName: z.string(),
  className: z.string(),
  termName: z.string(),
  subjects: z.array(reportCardSubjectLineSchema),
});
export type ReportCardDetail = z.infer<typeof reportCardDetailSchema>;

export const reportCardListResponseSchema = z.object({
  items: z.array(reportCardSchema),
  total: z.number().int().nonnegative(),
});
export type ReportCardListResponse = z.infer<typeof reportCardListResponseSchema>;

export const reportCardPreviewResponseSchema = z.object({
  reportCard: reportCardDetailSchema,
  fileUrl: z.string().nullable(),
});
export type ReportCardPreviewResponse = z.infer<typeof reportCardPreviewResponseSchema>;

export const reportCardListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  examId: UuidSchema.optional(),
  studentId: UuidSchema.optional(),
  status: ReportCardStatusSchema.optional(),
});
export type ReportCardListQuery = z.infer<typeof reportCardListQuerySchema>;

/** One published result row in a transcript. */
export const transcriptEntrySchema = z.object({
  examId: UuidSchema,
  examName: z.string(),
  termName: z.string(),
  academicYearName: z.string(),
  publishedAt: z.string().nullable(),
  gpa: z.number().nullable(),
  totalObtained: z.number().nullable(),
  totalPossible: z.number(),
  subjectCount: z.number().int(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

export const transcriptResponseSchema = z.object({
  studentId: UuidSchema,
  studentName: z.string(),
  entries: z.array(transcriptEntrySchema),
});
export type TranscriptResponse = z.infer<typeof transcriptResponseSchema>;

/** Self-scoped portal payload: a parent sees every linked child, a student sees
 * themselves, and only PUBLISHED report cards are ever included. */
export const resultsPortalViewSchema = z.object({
  student: attendanceContextStudentSchema,
  entries: z.array(transcriptEntrySchema),
  reportCards: z.array(reportCardDetailSchema),
});
export type ResultsPortalView = z.infer<typeof resultsPortalViewSchema>;

/**
 * Self-scoped portal read. `studentId` may only be OMITTED when the caller has
 * exactly one linked student (a student, or a parent with one child); a parent
 * with several children must name one, so the response is never an accidental
 * "first child wins" pick. The API validates the id against the caller's own
 * relationship either way.
 */
export const resultsPortalQuerySchema = z.object({
  studentId: UuidSchema.optional(),
});
export type ResultsPortalQuery = z.infer<typeof resultsPortalQuerySchema>;

export const resultsPortalResponseSchema = z.object({
  context: attendanceContextSchema,
  views: z.array(resultsPortalViewSchema),
});
export type ResultsPortalResponse = z.infer<typeof resultsPortalResponseSchema>;
