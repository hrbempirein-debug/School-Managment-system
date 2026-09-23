import { auditLogs, type Tx } from '@sms/db';

const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'tokenHash',
  'token_hash',
  'secret',
  'secretEnc',
  'secret_enc',
  'totpSecret',
  'apiKey',
  'authorization',
  'csrf',
  'mfaCode',
];

/** Recursively remove sensitive values before persisting anywhere. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (SENSITIVE_KEYS.includes(lower)) {
        out[k] = '[redacted]';
      } else if (typeof v === 'object') {
        out[k] = redactDeep(v, depth + 1);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  scope: 'platform' | 'tenant';
  tenantId: string | null;
  actorUserId: string | null;
  actorType?: 'user' | 'system' | 'job';
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Write an audit record inside the caller's transaction (same commit scope as the
 * business change). Values are deep-redacted before storage; secrets never reach
 * the table.
 */
export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    scope: entry.scope,
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    actorType: entry.actorType ?? 'user',
    action: entry.action,
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    oldValue: entry.oldValue !== undefined ? (redactDeep(entry.oldValue) as object) : null,
    newValue: entry.newValue !== undefined ? (redactDeep(entry.newValue) as object) : null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    requestId: entry.requestId ?? null,
  });
}