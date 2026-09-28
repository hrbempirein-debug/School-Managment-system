import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { HttpError, uuidv7, detectImageType, DOCUMENT_MIME, type ImageType } from '@sms/core';
import { schoolSettings, withTenant } from '@sms/db';
import { BRANDING_KEY_PATTERN } from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { notFoundError } from './util.js';
import { toSettings, updateSettings } from './settings.js';

/**
 * Branding file rules (DEVELOPMENT_ROADMAP Phase 2 → Security): uploads accept
 * ONLY raster image bytes (png / jpeg / webp), a magic-byte signature must match
 * the declared content-type (no type spoofing), the body is capped at 512 KiB,
 * and the resulting object key is server-generated under the `branding/`
 * category (`branding/{uuidv7}.{ext}`) — clients never supply a path. SVG is
 * deliberately excluded: an SVG can embed scripts and would be a stored-XSS
 * vector when served inline. Objects are stored through the tenant-isolating
 * StorageProvider (`assertSafeKey` injects the tenant prefix, so cross-tenant
 * object reads are structurally impossible), the settings singleton records the
 * key in `logo_path`, the previous object is removed after a successful
 * replacement, and every change lands in audit + the outbox
 * (`school.settings.updated`, reusing the existing event — no new event type).
 */

export const MAX_BRANDING_BYTES = 512 * 1024;

export type BrandingImageType = ImageType;

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const BRANDING_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'];

/**
 * Hard content check: the uploaded bytes must BE one of the allowed raster
 * formats, regardless of what the client claimed. Magic-byte rules live in
 * @sms/core (shared with the document pipeline). Pure so the rule set is
 * unit-testable.
 */
export function detectBrandingImage(data: Buffer): BrandingImageType | null {
  return detectImageType(data);
}

function mimeForBrandingKey(key: string): string {
  const ext = key.split('.').pop() ?? '';
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

export default async function brandingRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    BRANDING_CONTENT_TYPES,
    { parseAs: 'buffer' },
    (_request, body: Buffer, done) => done(null, body),
  );

  app.put(
    '/api/v1/settings/branding',
    {
      config: { authorization: { kind: 'tenant', permission: 'school.branding.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('school.branding.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const ctx = request.ctx!;

      const declaredLength = Number(request.headers['content-length'] ?? '0');
      if (declaredLength > MAX_BRANDING_BYTES) {
        throw new HttpError('Branding image exceeds the 512 KiB limit', {
          status: 413,
          code: 'payload_too_large',
        });
      }

      const body = request.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new HttpError('Branding image is required', {
          status: 400,
          code: 'validation_error',
        });
      }
      if (body.byteLength > MAX_BRANDING_BYTES) {
        throw new HttpError('Branding image exceeds the 512 KiB limit', {
          status: 413,
          code: 'payload_too_large',
        });
      }

      const detected = detectBrandingImage(body);
      if (!detected) {
        throw new HttpError('Unsupported branding image (png, jpeg or webp only)', {
          status: 415,
          code: 'unsupported_media_type',
        });
      }

      const declaredType = headerString(request.headers['content-type']);
      if (declaredType && declaredType !== 'application/octet-stream' && DOCUMENT_MIME[detected] !== declaredType) {
        throw new HttpError('Declared content-type does not match file contents', {
          status: 415,
          code: 'content_type_mismatch',
        });
      }

      const key = `branding/${uuidv7()}.${detected}`;

      // Previous object captured BEFORE the mutation so a failed upload never
      // removes the still-referenced logo.
      const before = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ logoPath: schoolSettings.logoPath })
          .from(schoolSettings)
          .where(eq(schoolSettings.tenantId, ctx.tenantId ?? ''))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );

      const row = await withTenant(app.db, ctx, async (tx) => {
        await app.storage.putObject({
          tenantId: ctx.tenantId ?? '',
          key,
          data: body,
          contentType: DOCUMENT_MIME[detected],
        });
        const settings = await updateSettings(tx, ctx, { logoPath: key }, request.requestId);
        return settings;
      });

      if (before?.logoPath && before.logoPath !== key) {
        app.storage.deleteObject(ctx.tenantId ?? '', before.logoPath).catch((err) => {
          request.log.warn({ err, key: before.logoPath }, 'failed to remove superseded branding object');
        });
      }

      return reply.code(200).send({ settings: toSettings(row) });
    },
  );

  app.get(
    '/api/v1/settings/branding/logo',
    {
      config: { authorization: { kind: 'tenant', permission: 'school.branding.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('school.branding.manage'),
      ],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ logoPath: schoolSettings.logoPath })
          .from(schoolSettings)
          .where(eq(schoolSettings.tenantId, ctx.tenantId ?? ''))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      const logoPath = row?.logoPath;
      if (!logoPath || !BRANDING_KEY_PATTERN.test(logoPath)) {
        throw notFoundError('Branding logo not set');
      }
      const buffer = await app.storage.readObject(ctx.tenantId ?? '', logoPath);
      reply.header('content-type', mimeForBrandingKey(logoPath));
      reply.header('cache-control', 'private, max-age=300');
      return buffer;
    },
  );
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}