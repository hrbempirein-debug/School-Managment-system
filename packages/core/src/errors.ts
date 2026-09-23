import type { Scope } from './context.js';

export class AppError extends Error {
  override name = 'AppError';
  constructor(message: string) {
    super(message);
  }
}

export interface HttpErrorOptions {
  code?: string;
  status?: number;
  details?: unknown;
  expose?: boolean;
  meta?: Record<string, unknown>;
}

export class HttpError extends AppError {
  override name = 'HttpError';
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly expose: boolean;
  readonly meta: Record<string, unknown>;

  constructor(message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.status = options.status ?? 500;
    this.code = options.code ?? 'internal';
    this.details = options.details;
    this.expose = options.expose ?? this.status < 500;
    this.meta = options.meta ?? {};
  }
}

export class DomainError extends AppError {
  override name = 'DomainError';
  readonly code: string;
  readonly meta: Record<string, unknown>;

  constructor(code: string, message: string, meta: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export class PermanentJobError extends AppError {
  override name = 'PermanentJobError';
}

export class RetryableJobError extends AppError {
  override name = 'RetryableJobError';
}

export function isAuthzDeny(err: unknown): err is HttpError {
  return err instanceof HttpError && (err.status === 403 || err.status === 401);
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: unknown;
    requestId: string;
    requiredPermission: string | null;
  };
}

export function toApiErrorEnvelope(err: unknown, requestId: string): ApiErrorEnvelope {
  if (err instanceof HttpError) {
    return {
      error: {
        code: err.code,
        message: err.expose ? err.message : 'Internal error',
        details: err.expose ? err.details ?? null : null,
        requestId,
        requiredPermission: err.meta['requiredPermission'] as string | null ?? null,
      },
    };
  }
  if (err instanceof DomainError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        details: err.meta,
        requestId,
        requiredPermission: null,
      },
    };
  }
  return {
    error: {
      code: 'internal',
      message: 'Internal error',
      details: null,
      requestId,
      requiredPermission: null,
    },
  };
}

export function errorCodeForScope(scope: Scope, base: string): string {
  return scope === 'platform' ? `platform.${base}` : base;
}