# File Storage Design

Status: Phase 0 | Related: ADR-009, MULTI_TENANCY.md, SECURITY.md

## 1. Requirements

- Private by default: student documents, report cards, payslips, receipts, certificates, IDs.
- Strict tenant isolation (object keys + DB metadata + authorization on every access).
- No permanent public URLs; no bucket listing for the app role.
- Handles large uploads without proxying bytes through the API.
- Virus-scan hook; retention/deletion per policy; integrity via content hash.

## 2. Components

```text
Portal ── POST /api/v1/files/init ──► API ── authorize + audit ──► files row (tenant_id, owner)
       ◄── { fileId, uploadUrl (presigned PUT, ≤15min), headers }
Portal ── PUT bytes ─────────────────────────────► S3-compatible bucket (private)
Portal ── POST /files/:id/complete ──► API ── verify size/mime ──► enqueue scan job
Consumer ── GET /api/v1/files/:id ──► API ── permission + owner check ──► presigned GET (≤10min) or stream
```

- **Never** issue presigned URLs without a DB authorization check on that request.
- Presigned URLs scoped to exact key + method + content-length-range where supported.

## 3. Bucket & keys

- Bucket: private, block all public access, versioning optional, SSE-S3 or KMS (ASSUMED available on chosen provider; local dev: MinIO in compose — **not installed in current env**, see env audit).
- Key layout: `tenants/{tenantId}/{category}/{fileId}/{filename}` where category ∈ `students|docs|finance|hr|library|reports|branding|assignments`.
- Platform assets: `platform/...` (plans artwork etc.).
- Filename in key is sanitized (no `..`, no control chars); original name stored in DB metadata.

## 4. DB metadata (`fil_files`)

`id, tenant_id (RLS), storage_key (unique), original_name, mime, size_bytes, content_hash sha256, visibility, owner_type, owner_id, scan_status, created_by, created_at, deleted_at NULL`.

- Downloads and share logic always join through this table → RLS applies.
- Duplicate detection per tenant via `content_hash` (optional dedupe within tenant only — never cross-tenant dedupe sharing).

## 5. Authorization rules

| Action | Permission |
|---|---|
| Upload (init) | module-specific create perm (e.g. `students.update` to attach doc) + ownership of parent entity |
| Download | module read perm + parent entity access (RLS) |
| Replace | new fileId + link swap; old file soft-deleted (kept until retention purge for finance/payslips: immutable — new version instead) |
| Delete | module delete perm; financial receipts/payslips: **not deletable**, only archived |

Campus-scoped roles: enforce campus of parent entity.

## 6. Upload security

- Allowlist MIME by category (images, pdf, office docs); reject mismatched `Content-Type` vs sniffed magic bytes.
- Max sizes per category (config): avatar 2 MB, documents 10 MB, bulk import 25 MB.
- Scan: async job sets `scan_status`; downloads blocked unless `clean` (except image previews generated server-side).
- No SVG served inline (XSS) — force `Content-Disposition: attachment` or rasterize for avatars.
- Presigned PUT only after Zod validation of metadata; key generated server-side (client cannot choose path).

## 7. Immutability classes

| Class | Rule |
|---|---|
| Finance: receipts, issued invoices (PDF render) | Append-only; regenerate + new file_id if layout changes |
| Payslips | Append-only per payroll run version |
| Student records / transcripts (published) | Versioned; correction → new version file |
| Profile photos, drafts | Mutable/replaceable |

## 8. Retention & deletion

- School deletion / student purge jobs delete objects in `maintenance` queue (batch, per-tenant), then null/mark DB rows per DATA_RETENTION.md.
- Soft-deleted files: lifecycle rule aborts incomplete multipart uploads (3 days), expires `deleted_at` objects after 30 days.
- Legal hold flag (`legal_hold bool`) blocks purge.

## 9. Local development

- Infra: MinIO via docker-compose **when Docker is available**; current verified environment has **no Docker** → Phase 1 REQUIRES USER ACTION: either install Docker Desktop/WSL Docker, or use an existing S3-compatible endpoint, or run MinIO binary on Windows. Until then, storage module tests use a filesystem adapter behind the same `ObjectStore` interface (dev-only, still tenant-path isolated).

## 10. Interface (provider abstraction)

```ts
interface ObjectStore {
  signPut(key, opts): Promise<{ url, headers }>
  signGet(key, ttl): Promise<string>
  delete(key): Promise<void>
  exists(key): Promise<boolean>
}
```

Implementations: `S3ObjectStore`, `FsObjectStore` (dev). Selected via config — ADR-009 style abstraction.
