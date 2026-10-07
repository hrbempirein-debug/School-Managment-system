import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { HttpError, type RequestContext } from '@sms/core';
import { hashSessionToken } from '@sms/auth';
import { withTenant, type Tx } from '@sms/db';
import {
  approveRefundRequestSchema,
  processRefundRequestSchema,
  rejectRefundRequestSchema,
  idParamSchema,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError } from '../school/util.js';

/**
 * Phase 7 refund command surface.
 *
 * F11 (`postRefundApproval`) and F12 (`postRefundProcess`) PERFORM
 * `app_consume_step_up(..., NULL)` and DISCARD the boolean: at the database
 * layer they are NOT the step-up enforcement point (see
 * finance-refund-state-machine.test.ts T6/T7). This module is that point. Before
 * either handler runs, the caller's OWN session id is resolved from the session
 * cookie, the caller-supplied code is verified with the real
 * `app_consume_step_up(session, action, 'fin_refunds', refund, amount, code)`,
 * and the handler is invoked ONLY when that call returns TRUE.
 *
 * Transaction boundary (§19.8.3): the consumption and the money movement run in
 * the SAME `withTenant` transaction, so a handler that raises rolls the
 * consumption back with it — nobody is charged a step-up for a failed refund.
 * A FALSE verification instead returns a `denied` marker so the transaction
 * COMMITS the attempt decrement (the three-strike lockout must survive); the
 * route then throws the mapped step-up error after commit.
 */

type RefundStatus = 'requested' | 'approved' | 'rejected' | 'processed';
type StepUpAction = 'refund.approve' | 'refund.process';
type StepUpReason = 'required' | 'invalid' | 'locked' | 'expired' | 'binding';

interface RefundRow {
  id: string;
  amount: string;
  status: RefundStatus;
  requested_by: string;
  [key: string]: unknown;
}

type RefundOutcome =
  | { kind: 'done'; status: RefundStatus; replayed: boolean }
  | { kind: 'denied'; reason: StepUpReason };

const STEP_UP_ERRORS: Record<StepUpReason, { status: number; code: string; message: string }> = {
  required: {
    status: 428,
    code: 'step_up_required',
    message: 'A step-up code is required for this action',
  },
  invalid: { status: 401, code: 'step_up_invalid', message: 'The step-up code is invalid' },
  locked: {
    status: 401,
    code: 'step_up_locked',
    message: 'This step-up challenge is locked after too many failed attempts',
  },
  expired: { status: 401, code: 'step_up_expired', message: 'This step-up challenge has expired' },
  binding: {
    status: 409,
    code: 'step_up_binding_mismatch',
    message: 'The step-up challenge is not bound to this refund',
  },
};

function stepUpError(reason: StepUpReason): HttpError {
  const e = STEP_UP_ERRORS[reason];
  return new HttpError(e.message, { status: e.status, code: e.code });
}

/**
 * Resolve the caller's `auth_sessions.id` from the raw session cookie. The
 * session-scoped RLS policy on `auth_sessions` (0002) restricts the read to the
 * calling user, so a token that belongs to somebody else resolves to no row.
 */
async function resolveDbSessionId(
  tx: Tx,
  ctx: RequestContext,
  token: string | undefined,
): Promise<string | null> {
  if (!token) return null;
  const r = await tx.execute<{ id: string }>(sql`
    select id from auth_sessions where token_hash = ${hashSessionToken(token)} limit 1`);
  const row = r.rows[0];
  if (!row) return null;
  void ctx;
  return row.id;
}

async function loadRefund(
  tx: Tx,
  ctx: RequestContext,
  refundId: string,
): Promise<RefundRow | null> {
  const r = await tx.execute<RefundRow>(sql`
    select id, amount::text as amount, status, requested_by
      from fin_refunds
     where tenant_id = ${ctx.tenantId} and id = ${refundId}
     limit 1`);
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, amount: String(row.amount) };
}

/**
 * Invoke `app_consume_step_up` with the caller's real code and, when FALSE,
 * classify WHY using the still-live challenge row (read under the same ticket).
 */
async function verifyStepUp(
  tx: Tx,
  ctx: RequestContext,
  sessionId: string | null,
  action: StepUpAction,
  refundId: string,
  amount: string,
  code: string,
): Promise<{ ok: true } | { ok: false; reason: StepUpReason }> {
  if (!sessionId) return { ok: false, reason: 'required' };

  const consumed = await tx.execute<{ ok: boolean }>(sql`
    select app_consume_step_up(
      ${sessionId}::uuid, ${action}, 'fin_refunds', ${refundId}::uuid,
      ${amount}::numeric(19,4), ${code}) as ok`);
  if (String(consumed.rows[0]?.ok) === 'true') return { ok: true };

  const ch = await tx.execute<{ expired: boolean; locked: boolean; binding: boolean }>(sql`
    select (expires_at <= now()) as expired,
           (attempts_left <= 0)  as locked,
           (resource_amount <> ${amount}::numeric(19,4)) as binding
      from auth_step_up_challenges
     where tenant_id = ${ctx.tenantId} and session_id = ${sessionId}::uuid
       and user_id = ${ctx.userId}
       and action = ${action} and resource_type = 'fin_refunds'
       and resource_id = ${refundId}::uuid
       and consumed_at is null
     limit 1`);
  const row = ch.rows[0];
  if (!row) return { ok: false, reason: 'required' };
  if (row.expired) return { ok: false, reason: 'expired' };
  if (row.locked) return { ok: false, reason: 'locked' };
  if (row.binding) return { ok: false, reason: 'binding' };
  return { ok: false, reason: 'invalid' };
}

async function callApprove(tx: Tx, sessionId: string, refundId: string): Promise<void> {
  try {
    await tx.execute(
      sql`select "postRefundApproval"(${sessionId}::uuid, ${refundId}::uuid, 'approve')`,
    );
  } catch (err) {
    throw mapDomainError(err);
  }
}

async function callProcess(
  tx: Tx,
  sessionId: string | null,
  refundId: string,
  action: 'process' | 'reject',
  reason: string | null,
  disbursementReference: string | null,
): Promise<void> {
  try {
    await tx.execute(
      sql`select "postRefundProcess"(
        ${sessionId}::uuid, ${refundId}::uuid, ${action}, ${reason}, ${disbursementReference})`,
    );
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function approveRefundCommand(
  tx: Tx,
  ctx: RequestContext,
  sessionId: string | null,
  refundId: string,
  code: string,
): Promise<RefundOutcome> {
  const refund = await loadRefund(tx, ctx, refundId);
  if (!refund) throw new HttpError('Refund not found', { status: 404, code: 'refund_not_found' });

  // Idempotent replay: an already-approved (or further) refund needs no step-up
  // and must not burn a challenge.
  if (refund.status === 'approved' || refund.status === 'processed') {
    return { kind: 'done', status: refund.status, replayed: true };
  }
  if (refund.status !== 'requested') {
    throw new HttpError('This refund is not in a requested state', {
      status: 409,
      code: 'refund_not_requested',
    });
  }
  // Checked before consuming so a doomed call never burns a challenge; F11
  // re-checks under its own lock.
  if (refund.requested_by === ctx.userId) {
    throw new HttpError('A refund may not be approved by the actor who requested it', {
      status: 403,
      code: 'refund_self_approval_forbidden',
    });
  }

  const step = await verifyStepUp(
    tx,
    ctx,
    sessionId,
    'refund.approve',
    refundId,
    refund.amount,
    code,
  );
  if (!step.ok) return { kind: 'denied', reason: step.reason };

  await callApprove(tx, sessionId!, refundId);
  return { kind: 'done', status: 'approved', replayed: false };
}

export async function processRefundCommand(
  tx: Tx,
  ctx: RequestContext,
  sessionId: string | null,
  refundId: string,
  code: string,
  disbursementReference: string,
): Promise<RefundOutcome> {
  const refund = await loadRefund(tx, ctx, refundId);
  if (!refund) throw new HttpError('Refund not found', { status: 404, code: 'refund_not_found' });

  if (refund.status === 'processed') {
    return { kind: 'done', status: 'processed', replayed: true };
  }
  if (refund.status !== 'approved') {
    throw new HttpError('This refund has not been approved', {
      status: 409,
      code: 'refund_not_approved',
    });
  }

  const step = await verifyStepUp(
    tx,
    ctx,
    sessionId,
    'refund.process',
    refundId,
    refund.amount,
    code,
  );
  if (!step.ok) return { kind: 'denied', reason: step.reason };

  await callProcess(tx, sessionId!, refundId, 'process', null, disbursementReference);
  return { kind: 'done', status: 'processed', replayed: false };
}

export async function rejectRefundCommand(
  tx: Tx,
  ctx: RequestContext,
  sessionId: string | null,
  refundId: string,
  reason: string,
): Promise<RefundOutcome> {
  const refund = await loadRefund(tx, ctx, refundId);
  if (!refund) throw new HttpError('Refund not found', { status: 404, code: 'refund_not_found' });

  if (refund.status === 'rejected') return { kind: 'done', status: 'rejected', replayed: true };
  if (refund.status !== 'requested') {
    throw new HttpError('This refund is not in a requested state', {
      status: 409,
      code: 'refund_not_requested',
    });
  }
  if (refund.requested_by === ctx.userId) {
    throw new HttpError('A refund may not be rejected by the actor who requested it', {
      status: 403,
      code: 'refund_self_rejection_forbidden',
    });
  }

  // Rejection posts no ledger and consumes no step-up (F12's reject branch); the
  // session id is threaded for signature parity and is unused there.
  await callProcess(tx, sessionId, refundId, 'reject', reason, null);
  return { kind: 'done', status: 'rejected', replayed: false };
}

export async function mintStepUpCommand(
  tx: Tx,
  ctx: RequestContext,
  sessionId: string | null,
  refundId: string,
): Promise<{ code: string; action: StepUpAction }> {
  if (!sessionId) {
    throw new HttpError('A step-up code is required for this action', {
      status: 428,
      code: 'step_up_required',
    });
  }
  const refund = await loadRefund(tx, ctx, refundId);
  if (!refund) throw new HttpError('Refund not found', { status: 404, code: 'refund_not_found' });

  let action: StepUpAction;
  if (refund.status === 'requested') action = 'refund.approve';
  else if (refund.status === 'approved') action = 'refund.process';
  else {
    throw new HttpError('This refund needs no step-up in its current state', {
      status: 409,
      code: 'refund_not_requested',
    });
  }

  try {
    const r = await tx.execute<{ code: string }>(sql`
      select app_mint_step_up_challenge(
        ${sessionId}::uuid, 'fin_refunds', ${refundId}::uuid,
        ${refund.amount}::numeric(19,4), ${action}) as code`);
    return { code: String(r.rows[0]!.code), action };
  } catch (err) {
    throw mapDomainError(err);
  }
}

function sessionToken(request: FastifyRequest): string | undefined {
  return request.auth?.token;
}

export default async function financeRefundsRoutes(app: FastifyInstance) {
  // Mint a single-use challenge bound to the refund + amount. The action is
  // derived from the refund's state (requested -> approve, approved -> process).
  app.post(
    '/api/v1/finance/refunds/:id/step-up',
    {
      config: { authorization: { kind: 'authenticated' } },
      preHandler: [requireSession(), requireTenantContext(), requireCsrf()],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const token = sessionToken(request);
      return withTenant(app.db, ctx, (tx) =>
        resolveDbSessionId(tx, ctx, token).then((sessionId) =>
          mintStepUpCommand(tx, ctx, sessionId, id),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/refunds/:id/approve',
    {
      config: { authorization: { kind: 'tenant', permission: 'fees.refunds.approve' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('fees.refunds.approve'),
        requireCsrf(),
      ],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = approveRefundRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const token = sessionToken(request);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        resolveDbSessionId(tx, ctx, token).then((sessionId) =>
          approveRefundCommand(tx, ctx, sessionId, id, body.code),
        ),
      );
      if (outcome.kind === 'denied') throw stepUpError(outcome.reason);
      return { refund: { id, status: outcome.status } };
    },
  );

  app.post(
    '/api/v1/finance/refunds/:id/reject',
    {
      config: { authorization: { kind: 'tenant', permission: 'fees.refunds.approve' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('fees.refunds.approve'),
        requireCsrf(),
      ],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = rejectRefundRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const token = sessionToken(request);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        resolveDbSessionId(tx, ctx, token).then((sessionId) =>
          rejectRefundCommand(tx, ctx, sessionId, id, body.reason),
        ),
      );
      if (outcome.kind === 'denied') throw stepUpError(outcome.reason);
      return { refund: { id, status: outcome.status } };
    },
  );

  app.post(
    '/api/v1/finance/refunds/:id/process',
    {
      config: { authorization: { kind: 'tenant', permission: 'fees.refunds.process' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('fees.refunds.process'),
        requireCsrf(),
      ],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = processRefundRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const token = sessionToken(request);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        resolveDbSessionId(tx, ctx, token).then((sessionId) =>
          processRefundCommand(tx, ctx, sessionId, id, body.code, body.disbursementReference),
        ),
      );
      if (outcome.kind === 'denied') throw stepUpError(outcome.reason);
      return { refund: { id, status: outcome.status } };
    },
  );
}