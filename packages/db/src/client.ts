import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { RequestContext } from '@sms/core';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

// The transaction type drizzle hands to callbacks of `db.transaction`.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface CreateDbOptions {
  url: string;
  max?: number;
}

export function createDb({ url, max = 10 }: CreateDbOptions): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max, allowExitOnIdle: true });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type { NodePgDatabase };

export interface DbContextGuc {
  userId?: string;
  tenantId?: string | null;
  platform?: boolean;
  system?: boolean;
}

/**
 * SQL that establishes the transaction-local RLS context by minting a signed, expiring
 * context ticket via app_ctx_mint(). The ticket (not the old app.* GUCs) is the only
 * input RLS policies trust, so a forged GUC buys nothing. Because the ticket is set with
 * set_config(..., true) (transaction-local), pooled connections can never leak context.
 */
function contextStatements(guc: DbContextGuc) {
  const stmts: ReturnType<typeof sql>[] = [];
  if (guc.system) {
    // Trusted executor connection (school_migrator): policies already pass via app_privileged().
    stmts.push(sql`select set_config('app.rls', '', true)`);
    return stmts;
  }
  let scope: 'account' | 'platform' | 'tenant' | 'none';
  if (guc.platform) scope = 'platform';
  else if (guc.tenantId != null) scope = 'tenant';
  else if (guc.userId != null) scope = 'account';
  else scope = 'none';

  if (scope === 'none') {
    stmts.push(sql`select set_config('app.rls', '', true)`);
    return stmts;
  }
  const userId = guc.userId ?? null;
  const tenantId = scope === 'tenant' ? guc.tenantId : null;
  stmts.push(sql`select app_ctx_mint(${scope}, ${userId}, ${tenantId})`);
  return stmts;
}

/**
 * Run `fn` inside a single DB transaction with a signed context ticket (transaction-local).
 * app_ctx_mint() refuses scopes that do not hold: 'tenant' requires an active membership,
 * 'platform' requires a platform role assignment. Failures yield no ticket, so the RLS
 * policies fail closed.
 */
export async function withGuc<T>(db: Db, guc: DbContextGuc, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    for (const stmt of contextStatements(guc)) await tx.execute(stmt);
    return fn(tx);
  });
}

/** Tenant-scoped unit of work. The only sanctioned way for app code to touch tenant data. */
export function withTenant<T>(
  db: Db,
  ctx: RequestContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withGuc(
    db,
    { userId: ctx.userId, tenantId: ctx.tenantId, platform: ctx.platformAccess, system: ctx.isSystem },
    fn,
  );
}

/** Platform-scoped unit of work. */
export function withPlatform<T>(db: Db, ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withGuc(db, { userId: ctx.userId, platform: true, system: ctx.isSystem }, fn);
}

/** System-level unit of work (workers). */
export function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withGuc(db, { system: true }, fn);
}

export { schema };