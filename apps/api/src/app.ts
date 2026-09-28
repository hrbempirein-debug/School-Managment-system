import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit, { type RateLimitOptions } from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { getEnv } from '@sms/config';
import { toApiErrorEnvelope, HttpError, isAuthzDeny } from '@sms/core';
import { assertCatalogConsistent } from '@sms/permissions';
import depsPlugin, { type ApiDeps } from './plugins/deps.js';
import requestContextPlugin from './plugins/request-context.js';
import registerAuthorizationGate from './plugins/authorization.js';
import './plugins/types.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import permissionsRoutes from './routes/permissions.js';
import tenantsRoutes from './routes/tenants.js';
import auditRoutes from './routes/audit.js';
import filesRoutes from './routes/files.js';
import campusesRoutes from './routes/school/campuses.js';
import classRoutes from './routes/school/classes.js';
import sectionRoutes from './routes/school/sections.js';
import placementRoutes from './routes/school/placement.js';
import academicYearsRoutes from './routes/school/academic-years.js';
import academicTermsRoutes from './routes/school/academic-terms.js';
import holidaysRoutes from './routes/school/holidays.js';
import calendarsRoutes from './routes/school/calendars.js';
import calendarEventsRoutes from './routes/school/calendar-events.js';
import departmentsRoutes from './routes/school/departments.js';
import studentsRoutes from './routes/school/students.js';
import guardiansRoutes from './routes/school/guardians.js';
import enrollmentRoutes from './routes/school/enrollments.js';
import promotionBatchRoutes from './routes/school/promotion-batches.js';
import settingsRoutes from './routes/school/settings.js';
import brandingRoutes from './routes/school/branding.js';
import studentDocumentRoutes from './routes/school/student-documents.js';
import admissionApplicationRoutes from './routes/school/admission-applications.js';
import studentImportRoutes from './routes/school/student-imports.js';
import studentExportRoutes from './routes/school/student-export.js';
import gradeLevelRoutes from './routes/school/grade-levels.js';
import subjectRoutes from './routes/school/subjects.js';
import classSubjectRoutes from './routes/school/class-subjects.js';
import teacherAssignmentRoutes from './routes/school/teacher-assignments.js';
import teacherDirectoryRoutes from './routes/school/teachers.js';
import periodRoutes from './routes/school/periods.js';
import timetableRoutes from './routes/school/timetable.js';
import homeworkRoutes from './routes/school/homework.js';
import attendanceRoutes from './routes/school/attendance.js';
import leaveRoutes from './routes/school/leave.js';
import examRoutes from './routes/school/exams.js';

export interface BuildAppOptions {
  deps: ApiDeps;
  logger?: boolean | Record<string, unknown>;
}

export async function buildApp({ deps, logger = true }: BuildAppOptions): Promise<FastifyInstance> {
  assertCatalogConsistent();

  const app = Fastify({
    logger,
    trustProxy: true,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
  });

  // NOTE: setErrorHandler/addHook must be installed BEFORE any register() of a
  // route plugin — Fastify child (encapsulation) contexts snapshot the parent's
  // error handler and hooks at creation time, so handlers added later would not
  // reach already-created children (the documented error envelope, including
  // `requiredPermission` for authz denials, must be active on every route).
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          requestId: request.requestId,
          requiredPermission: null,
        },
      });
    }

    const status =
      error instanceof HttpError
        ? error.status
        : (error as { statusCode?: number }).statusCode ?? 500;
    const envelope = toApiErrorEnvelope(error, request.requestId);
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    else if (!isAuthzDeny(error)) request.log.warn({ err: error }, 'request error');
    return reply.code(status).send(envelope);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.requestId);
    return payload;
  });

  await app.register(depsPlugin, deps);
  await app.register(cookie);
  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: getEnv().WEB_BASE_URL,
    credentials: true,
  });
  await app.register(requestContextPlugin);
  await app.register(rateLimit, {
    global: true,
    max: getEnv().RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    redis: deps.redis,
    keyGenerator: (req: { ip?: string }) => String(req.ip ?? 'unknown'),
  } as unknown as RateLimitOptions);

  // Deny-by-default authorization gate. Registers BEFORE route plugins so the
  // onRoute capture sees every route; the onReady validator refuses to boot an
  // app where any route lacks a valid authorization contract or enforcement.
  registerAuthorizationGate(app);

  await app.register(healthRoutes, { prefix: '/' });
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(permissionsRoutes);
  await app.register(tenantsRoutes);
  await app.register(auditRoutes);
  await app.register(filesRoutes);
  await app.register(campusesRoutes);
  await app.register(classRoutes);
  await app.register(sectionRoutes);
  await app.register(placementRoutes);
  await app.register(academicYearsRoutes);
  await app.register(academicTermsRoutes);
  await app.register(holidaysRoutes);
  await app.register(calendarsRoutes);
  await app.register(calendarEventsRoutes);
  await app.register(departmentsRoutes);
  await app.register(studentsRoutes);
  await app.register(guardiansRoutes);
  await app.register(enrollmentRoutes);
  await app.register(promotionBatchRoutes);
  await app.register(settingsRoutes);
  await app.register(brandingRoutes);
  await app.register(studentDocumentRoutes);
  await app.register(admissionApplicationRoutes);
  await app.register(studentImportRoutes);
  await app.register(studentExportRoutes);
  await app.register(gradeLevelRoutes);
  await app.register(subjectRoutes);
  await app.register(classSubjectRoutes);
  await app.register(teacherAssignmentRoutes);
  await app.register(teacherDirectoryRoutes);
  await app.register(periodRoutes);
  await app.register(timetableRoutes);
  await app.register(homeworkRoutes);
  await app.register(attendanceRoutes);
  await app.register(leaveRoutes);
  await app.register(examRoutes);

  // Fail fast: the app must not boot with a broken authorization model
  // (unannotated route, unknown/out-of-scope permission, or a route whose
  // enforcement gates do not match its declared contract).
  await app.ready();

  return app;
}