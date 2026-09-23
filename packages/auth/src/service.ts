import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  authIdentities,
  authSessions,
  userProfiles,
  users,
  type Db,
  withGuc,
} from '@sms/db';
import { HttpError, AppError } from '@sms/core';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { setAccountScope } from '@sms/tenancy';
import { hashPassword, verifyPassword } from './password.js';
import {
  issueSessionToken,
  newCsrfToken,
  absoluteTtlMs,
  hashSessionToken,
  readSession,
  writeSession,
  deleteSession,
  type RedisSession,
} from './sessions.js';

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export interface LoginInput {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export interface LogoutInput {
  token: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export interface SessionUser {
  userId: string;
  email: string;
  fullName: string;
}

export interface LoginResult {
  token: string;
  tokenHash: string;
  session: RedisSession;
  user: SessionUser;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function registerUser(db: Db, input: RegisterInput): Promise<{ userId: string }> {
  const email = input.email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    let userId: string;
    try {
      // The id is generated here (rather than read back via RETURNING) because
      // INSERT ... RETURNING applies the SELECT policy to the returned row, and the
      // account-scope ticket is only minted AFTER the user row exists. No context is
      // active at insert time, so the row would be invisible to the app role and the
      // insert would be rejected by RLS. Supplying the id explicitly sidesteps the
      // read-back entirely.
      userId = randomUUID();
      await tx.insert(users).values({ id: userId, email });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HttpError('Email is already registered', {
          status: 409,
          code: 'user_already_exists',
        });
      }
      throw err;
    }

    // Establish an account-scope (userId-only) context so the profile/identity rows
    // created below pass their self-scoped RLS policies.
    await setAccountScope(tx, userId);

    await tx.insert(userProfiles).values({ userId, fullName: input.fullName });
    await tx.insert(authIdentities).values({
      userId,
      provider: 'password',
      providerKey: email,
      passwordHash: await hashPassword(input.password),
    });

    await writeAudit(tx, {
      scope: 'platform',
      tenantId: null,
      actorUserId: userId,
      actorType: 'user',
      action: 'user.created',
      resourceType: 'user',
      resourceId: userId,
      newValue: { email },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    });

    await enqueueOutbox(tx, {
      tenantId: null,
      eventType: 'user.created',
      aggregateType: 'user',
      aggregateId: userId,
      payload: { userId, email },
      correlationId: input.requestId ?? null,
    });

    return { userId };
  });
}

export async function loginUser({
  db,
  redis,
  input,
}: {
  db: Db;
  redis: Redis;
  input: LoginInput;
}): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  const result = await db.transaction(async (tx) => {
    // Pre-auth identity lookup goes through the narrowed SECURITY DEFINER helper
    // (auth_identities is FORCE RLS and self-visible only, so it cannot be read raw).
    const identityRows = await tx.execute(
      sql`select user_id, password_hash from app_auth_login_lookup('password', ${email})`,
    );
    const row = identityRows.rows[0] as
      | { user_id: string; password_hash: string | null }
      | undefined;
    const identity = row
      ? { userId: row.user_id, passwordHash: row.password_hash }
      : undefined;

    const fail = async () => {
      await writeAudit(tx, {
        scope: 'platform',
        tenantId: null,
        actorUserId: identity?.userId ?? null,
        actorType: 'user',
        action: 'user.login_failed',
        resourceType: 'user',
        resourceId: identity?.userId ?? null,
        newValue: { email },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
      });
      throw new HttpError('Invalid email or password', {
        status: 401,
        code: 'invalid_credentials',
      });
    };

    if (!identity || !identity.passwordHash) {
      await fail();
      throw new Error('unreachable');
    }
    const ok = await verifyPassword(identity.passwordHash, input.password);
    if (!ok) {
      await fail();
      throw new Error('unreachable');
    }

    await setAccountScope(tx, identity.userId);
    const userRows = await tx
      .select()
      .from(users)
      .where(eq(users.id, identity.userId))
      .execute();
    const user = userRows[0];
    if (!user || user.status !== 'active') {
      throw new HttpError('Account is disabled', { status: 403, code: 'account_disabled' });
    }
    const profileRows = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, identity.userId))
      .execute();
    const profile = profileRows[0];

    const now = Date.now();
    const expiresAt = now + absoluteTtlMs();
    const { token, tokenHash } = issueSessionToken();
    const session: RedisSession = {
      userId: identity.userId,
      activeTenantId: null,
      csrfToken: newCsrfToken(),
      createdAt: now,
      expiresAt,
    };

    const sessionId = randomUUID();
    await tx.insert(authSessions).values({
      id: sessionId,
      userId: identity.userId,
      tokenHash,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      activeTenantId: null,
      expiresAt: new Date(expiresAt),
    });

    await writeAudit(tx, {
      scope: 'platform',
      tenantId: null,
      actorUserId: identity.userId,
      actorType: 'user',
      action: 'user.login',
      resourceType: 'user',
      resourceId: identity.userId,
      newValue: { email },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    });
    await writeAudit(tx, {
      scope: 'platform',
      tenantId: null,
      actorUserId: identity.userId,
      actorType: 'user',
      action: 'session.created',
      resourceType: 'session',
      resourceId: sessionId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    });

    await enqueueOutbox(tx, {
      tenantId: null,
      eventType: 'user.login',
      aggregateType: 'user',
      aggregateId: identity.userId,
      payload: { userId: identity.userId, email },
      correlationId: input.requestId ?? null,
    });

    return { user, profile, token, tokenHash, session, sessionId };
  });

  await writeSession(redis, result.token, result.session);

  return {
    token: result.token,
    tokenHash: result.tokenHash,
    session: result.session,
    user: {
      userId: result.user.id,
      email: result.user.email,
      fullName: result.profile?.fullName ?? '',
    },
  };
}

export async function logoutUser({
  db,
  redis,
  input,
}: {
  db: Db;
  redis: Redis;
  input: LogoutInput;
}): Promise<void> {
  const existing = await readSession(redis, input.token);
  await deleteSession(redis, input.token);
  if (!existing) return;

  const tokenHash = hashSessionToken(input.token);
  try {
    await withGuc(db, { userId: existing.userId }, async (tx) => {
      await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(authSessions.tokenHash, tokenHash), eq(authSessions.userId, existing.userId)));
    });
  } catch {
    // revocation is best-effort if the session row was already gone
  }

  await withGuc(db, { userId: existing.userId }, async (tx) => {
    await writeAudit(tx, {
      scope: 'platform',
      tenantId: null,
      actorUserId: existing.userId,
      actorType: 'user',
      action: 'user.logout',
      resourceType: 'user',
      resourceId: existing.userId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    });
    await enqueueOutbox(tx, {
      tenantId: null,
      eventType: 'user.logout',
      aggregateType: 'user',
      aggregateId: existing.userId,
      payload: { userId: existing.userId },
      correlationId: input.requestId ?? null,
    });
  });
}

/** Resolve the current user's identity inside an established session. */
export async function currentUser(db: Db, userId: string): Promise<SessionUser> {
  return withGuc(db, { userId }, async (tx) => {
    const userRows = await tx.select().from(users).where(eq(users.id, userId)).execute();
    const user = userRows[0];
    if (!user) throw new AppError('User not found');
    const profileRows = await tx.select().from(userProfiles).where(eq(userProfiles.userId, userId)).execute();
    const profile = profileRows[0];
    return { userId: user.id, email: user.email, fullName: profile?.fullName ?? '' };
  });
}