import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';
import { AppError } from '@sms/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the pnpm workspace root so `.env` is loaded from the repository root
 * regardless of the process working directory (pnpm filters run scripts with
 * CWD = the workspace package, so `dotenv/config` alone would miss the root
 * `.env`). Falls back to the config package directory (2 levels up).
 */
function findWorkspaceRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const workspaceRoot = findWorkspaceRoot(path.resolve(__dirname, '..'));
export const envFilePath = path.join(workspaceRoot, '.env');
dotenv.config({
  path: envFilePath,
  quiet: true,
});

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  APP_NAME: z.string().default('School Management SaaS'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  API_PORT: z.coerce.number().positive().default(4100),
  API_HOST: z.string().default('127.0.0.1'),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  API_BASE_URL: z.string().url().default('http://localhost:4100'),

  DATABASE_URL_MIGRATOR: z.string().min(1).describe('DDL role (school_migrator)'),
  DATABASE_URL_APP: z.string().min(1).describe('runtime role (school_app_rw)'),
  DATABASE_URL_TEST: z.string().optional().describe('integration test database'),
  DB_POOL_MAX: z.coerce.number().positive().default(10),

  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

  SESSION_TTL_IDLE_MINUTES: z.coerce.number().positive().default(120),
  SESSION_TTL_ABSOLUTE_MINUTES: z.coerce.number().positive().default(720),
  SESSION_COOKIE_NAME: z.string().min(1).default('sid'),

  APP_ENCRYPTION_KEY: z.string().optional(),
  SESSION_PEPPER: z.string().optional(),

  RATE_LOGIN_POINTS: z.coerce.number().positive().default(10),
  RATE_LOGIN_DURATION_SECONDS: z.coerce.number().positive().default(900),
  RATE_REGISTER_POINTS: z.coerce.number().positive().default(5),
  RATE_REGISTER_DURATION_SECONDS: z.coerce.number().positive().default(900),

  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  STORAGE_FS_ROOT: z.string().default('.data/storage'),

  PLATFORM_ADMIN_EMAIL: z.string().email().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().min(12).optional(),

  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
  DEFAULT_LOCALE: z.string().default('en'),
  DEFAULT_TIMEZONE: z.string().default('UTC'),
});

export type Env = z.infer<typeof envSchema>;

let parsed: Env | null = null;

export function loadEnv(overrides: Partial<Env> = {}): Env {
  if (parsed && Object.keys(overrides).length === 0) return parsed;
  const source = { ...process.env, ...overrides };
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AppError(`Invalid environment configuration — ${issues}`);
  }
  parsed = result.data;
  return parsed;
}

export function getEnv(): Env {
  if (!parsed) return loadEnv();
  return parsed;
}

export function resetEnv(): void {
  parsed = null;
}
