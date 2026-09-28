import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { departments, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createDepartmentRequestSchema,
  updateDepartmentRequestSchema,
  idParamSchema,
  type Department,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, parsePagination, idempotencyKeyFromHeader, notFoundError } from './util.js';

type DepartmentRow = typeof departments.$inferSelect;

export function toDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    status: row.status as Department['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DepartmentWriteInput {
  code?: string;
  name?: string;
  status?: 'active' | 'inactive';
}

export async function insertDepartment(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: DepartmentWriteInput,
  requestId: string,
): Promise<DepartmentRow> {
  try {
    const rows = await tx
      .insert(departments)
      .values({
        tenantId: ctx.tenantId ?? '',
        code: input.code ?? '',
        name: input.name ?? '',
        status: input.status ?? 'active',
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'department.created',
      resourceType: 'department',
      resourceId: row.id,
      newValue: toDepartment(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'department.created',
      aggregateType: 'department',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, departmentId: row.id, code: row.code },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateDepartment(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: DepartmentWriteInput,
  requestId: string,
): Promise<DepartmentRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(departments)
      .where(and(eq(departments.id, id), isNull(departments.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(departments)
      .set(input)
      .where(and(eq(departments.id, id), isNull(departments.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'department.updated',
      resourceType: 'department',
      resourceId: row.id,
      oldValue: beforeRows[0] ? toDepartment(beforeRows[0]) : undefined,
      newValue: toDepartment(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'department.updated',
      aggregateType: 'department',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, departmentId: row.id, code: row.code, status: row.status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function setDepartmentStatus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  status: 'active' | 'inactive',
  requestId: string,
): Promise<DepartmentRow | null> {
  try {
    const rows = await tx
      .update(departments)
      .set({ status })
      .where(and(eq(departments.id, id), isNull(departments.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: status === 'active' ? 'department.activated' : 'department.deactivated',
      resourceType: 'department',
      resourceId: row.id,
      newValue: { status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: status === 'active' ? 'department.activated' : 'department.deactivated',
      aggregateType: 'department',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, departmentId: row.id, status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function departmentsRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/departments',
    {
      config: { authorization: { kind: 'tenant', permission: 'departments.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('departments.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { limit, offset } = parsePagination(request.query);
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(departments)
          .where(and(eq(departments.tenantId, ctx.tenantId ?? ''), isNull(departments.deletedAt)))
          .orderBy(desc(departments.createdAt))
          .limit(limit)
          .offset(offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(departments)
          .where(and(eq(departments.tenantId, ctx.tenantId ?? ''), isNull(departments.deletedAt)))
          .execute(),
      );
      return { items: rows.map(toDepartment), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/departments',
    {
      config: { authorization: { kind: 'tenant', permission: 'departments.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('departments.write'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createDepartmentRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertDepartment(tx, ctx, { ...body, status: 'active' }, request.requestId);
          return { status: 201, body: { department: toDepartment(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/departments/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'departments.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('departments.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(departments)
          .where(and(eq(departments.id, id), isNull(departments.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Department not found');
      return { department: toDepartment(row) };
    },
  );

  app.patch(
    '/api/v1/departments/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'departments.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('departments.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateDepartmentRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateDepartment(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Department not found');
          return { status: 200, body: { department: toDepartment(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/departments/:id/activate',
    {
      config: { authorization: { kind: 'tenant', permission: 'departments.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('departments.write'), requireCsrf()],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setDepartmentStatus(tx, ctx, id, 'active', request.requestId));
      if (!row) throw notFoundError('Department not found');
      return { department: toDepartment(row) };
    },
  );

  app.post(
    '/api/v1/departments/:id/deactivate',
    {
      config: { authorization: { kind: 'tenant', permission: 'departments.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('departments.write'), requireCsrf()],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setDepartmentStatus(tx, ctx, id, 'inactive', request.requestId));
      if (!row) throw notFoundError('Department not found');
      return { department: toDepartment(row) };
    },
  );
}