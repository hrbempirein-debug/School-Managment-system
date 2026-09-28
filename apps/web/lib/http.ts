import { API_BASE_URL } from './api';
import type { StudentDocumentResponse, StudentImportResponse } from '@sms/contracts';

/**
 * Client-side API helpers used by browser components. State-changing calls carry
 * the CSRF double-submit token (read from the non-httpOnly `csrf` cookie the API
 * sets on login) and always send credentials so the `sid` httpOnly cookie is
 * forwarded. Errors are normalized to the API envelope shape
 * `{ error: { code, message } }`.
 */

export class ClientApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}

export function getCsrf(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1] ?? '') : '';
}

interface ClientFetchInit {
  method?: string;
  body?: unknown;
  csrf?: boolean;
  includeCsrf?: boolean;
}

export async function clientFetch<T>(
  path: string,
  { method = 'GET', body, includeCsrf = false }: ClientFetchInit = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (includeCsrf && method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = getCsrf();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) {
    let payload: { error?: { message?: string; code?: string } } = {};
    try {
      payload = await res.json();
    } catch {
      // ignore unparseable bodies
    }
    throw new ClientApiError(
      payload.error?.message ?? `Request failed (${res.status})`,
      res.status,
      payload.error?.code ?? 'unknown',
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface UploadResult {
  error?: { message?: string; code?: string };
  settings?: { logoPath?: string | null; brandingColor?: string | null };
}

/** Upload the branding image bytes to the API (PUT, CSRF-protected). */
export async function uploadBrandingLogo(file: File): Promise<UploadResult> {
  const contentType = file.type && file.type !== 'application/octet-stream' ? file.type : undefined;
  const headers: Record<string, string> = {};
  if (contentType) headers['content-type'] = contentType;
  headers['x-csrf-token'] = getCsrf();
  const res = await fetch(`${API_BASE_URL}/api/v1/settings/branding`, {
    method: 'PUT',
    headers,
    body: file,
    credentials: 'include',
  });
  if (!res.ok) {
    let payload: UploadResult = {};
    try {
      payload = await res.json();
    } catch {
      // ignore
    }
    throw new ClientApiError(
      payload.error?.message ?? `Upload failed (${res.status})`,
      res.status,
      payload.error?.code ?? 'unknown',
    );
  }
  return res.json() as Promise<UploadResult>;
}

export function brandingLogoUrl(): string {
  return `${API_BASE_URL}/api/v1/settings/branding/logo`;
}

// ------------------------------------------------------------------ raw uploads + downloads

/** Document MIME allowlist the API accepts (DOCUMENT_MIME, core/content.ts). */
export const DOCUMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;

/**
 * Upload a student document. The request body IS the file bytes (non-multipart
 * convention); metadata rides in the query string, exactly like the branding
 * upload. `documentType` is a free-form, tenant-defined classification string.
 */
export async function uploadStudentDocument(
  studentId: string,
  file: File,
  documentType: string,
): Promise<StudentDocumentResponse> {
  const query = new URLSearchParams({ documentType });
  if (file.name.trim() !== '') query.set('filename', file.name);
  const contentType =
    (DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type) ? file.type : 'application/octet-stream';
  const res = await fetch(`${API_BASE_URL}/api/v1/students/${encodeURIComponent(studentId)}/documents?${query}`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-csrf-token': getCsrf() },
    body: file,
    credentials: 'include',
  });
  return parseApiResponse<StudentDocumentResponse>(res);
}

/**
 * Submit a student CSV import. Same raw-buffer convention as documents; the API
 * returns 202 with the import row in 'submitted' — completion is asynchronous
 * (the worker owns submitted -> processing -> completed|failed) and must be polled.
 */
export async function uploadStudentCsv(file: File): Promise<StudentImportResponse> {
  const query = new URLSearchParams();
  if (file.name.trim() !== '') query.set('filename', file.name);
  const contentType = file.type === 'text/csv' ? 'text/csv' : 'application/octet-stream';
  const res = await fetch(`${API_BASE_URL}/api/v1/students/import?${query}`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-csrf-token': getCsrf() },
    body: file,
    credentials: 'include',
  });
  return parseApiResponse<StudentImportResponse>(res);
}

/**
 * Download a credentialed resource (CSV export / student document blob) as a
 * browser download. Cross-origin `<a href>` cannot carry the httpOnly session
 * cookie, so we fetch with credentials and drive the save through an object URL.
 */
export async function downloadViaCredentials(
  path: string,
  fallbackFilename: string,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}${path}`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) {
    let payload: { error?: { message?: string; code?: string } } = {};
    try {
      payload = await res.json();
    } catch {
      // ignore unparseable bodies
    }
    throw new ClientApiError(
      payload.error?.message ?? `Download failed (${res.status})`,
      res.status,
      payload.error?.code ?? 'unknown',
    );
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? fallbackFilename;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Shared response unwrapping for raw-upload/download fetch calls. */
async function parseApiResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let payload: { error?: { message?: string; code?: string } } = {};
    try {
      payload = await res.json();
    } catch {
      // ignore unparseable bodies
    }
    throw new ClientApiError(
      payload.error?.message ?? `Request failed (${res.status})`,
      res.status,
      payload.error?.code ?? 'unknown',
    );
  }
  return res.json() as Promise<T>;
}