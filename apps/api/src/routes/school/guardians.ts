import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { guardians, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createGuardianRequestSchema,
  updateGuardianRequestSchema,
  idParamSchema,
  guardianListQuerySchema,
  type Guardian,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, idempotencyKeyFromHeader, notFoundError } from './util.js';

type GuardianRow = typeof guardians.$inferSelect;

const nameExpr = sql`(${guardians.firstName} || ' ' || ${guardians.lastName})`;

export function toGuardian(row: GuardianRow): Guardian {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface GuardianWriteInput {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
}

export interface GuardianCreateInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
}

export async function insertGuardian(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: GuardianCreateInput,
  requestId: string,
): Promise<GuardianRow> {
  try {
    const rows = await tx
      .insert(guardians)
      .values({
        tenantId: ctx.tenantId ?? '',
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone ?? null,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'guardian.created',
      resourceType: 'guardian',
      resourceId: row.id,
      newValue: toGuardian(row),
      requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateGuardian(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: GuardianWriteInput,
  requestId: string,
): Promise<GuardianRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(guardians)
      .where(and(eq(guardians.id, id), isNull(guardians.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(guardians)
      .set(input)
      .where(and(eq(guardians.id, id), isNull(guardians.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'guardian.updated',
      resourceType: 'guardian',
      resourceId: row.id,
      oldValue: beforeRows[0] ? toGuardian(beforeRows[0]) : undefined,
      newValue: toGuardian(row),
      requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function deleteGuardian(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  requestId: string,
): Promise<boolean> {
  try {
    const beforeRows = await tx
      .select()
      .from(guardians)
      .where(and(eq(guardians.id, id), isNull(guardians.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(guardians)
      .set({ deletedAt: new Date() })
      .where(and(eq(guardians.id, id), isNull(guardians.deletedAt)))
      .returning();
    if (rows.length === 0) return false;
    const before = beforeRows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'guardian.deleted',
      resourceType: 'guardian',
      resourceId: id,
      oldValue: toGuardian(before),
      requestId,
    });
    return true;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function guardiansRoutes(app: FastifyInstance) {
  // Guardians are campus-neutral records (no campus column by design): they are
  // tenant-scoped, so campus scope is never asserted here — it is enforced on the
  // STUDENT side whenever a guardian is linked to a student.

  app.get(
    '/api/v1/guardians',
    {
      config: { authorization: { kind: 'tenant', permission: 'guardians.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('guardians.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = guardianListQuerySchema.parse(request.query);
      const conditions = [eq(guardians.tenantId, ctx.tenantId ?? ''), isNull(guardians.deletedAt)];
      if (query.q) {
        conditions.push(sql`${nameExpr} ILIKE ${`%${query.q}%`}`);
      }
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(guardians)
          .where(and(...conditions))
          .orderBy(desc(guardians.createdAt), asc(guardians.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(guardians)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toGuardian), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/guardians',
    {
      config: { authorization: { kind: 'tenant', permission: 'guardians.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('guardians.create'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createGuardianRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertGuardian(tx, ctx, body, request.requestId);
          return { status: 201, body: { guardian: toGuardian(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/guardians/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'guardians.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('guardians.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(guardians)
          .where(and(eq(guardians.id, id), isNull(guardians.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Guardian not found');
      return { guardian: toGuardian(row) };
    },
  );

  app.patch(
    '/api/v1/guardians/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'guardians.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('guardians.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateGuardianRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateGuardian(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Guardian not found');
          return { status: 200, body: { guardian: toGuardian(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/guardians/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'guardians.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('guardians.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const deleted = await withTenant(app.db, ctx, (tx) => deleteGuardian(tx, ctx, id, request.requestId));
      if (!deleted) throw notFoundError('Guardian not found');
      return reply.code(204).send();
    },
  );
}