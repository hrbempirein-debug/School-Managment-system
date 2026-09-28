import {
  normalizeImportHeader,
  STUDENT_IMPORT_COLUMNS,
  STUDENT_IMPORT_REQUIRED_COLUMNS,
} from '@sms/contracts';

/**
 * Client-side CSV upload affordances for the bulk import wizard.
 *
 * The backend is the single authority for import acceptance (header rules, row
 * limits, per-row validation happen in the API upload route and the worker).
 * Everything here is UX-only: a fast feedback loop on file selection, built on
 * the SHARED contract normalizer (normalizeImportHeader) so the client and the
 * API can never disagree about what a header means.
 */

export const MAX_IMPORT_UPLOAD_BYTES = 5 * 1024 * 1024; // config MAX_IMPORT_UPLOAD_BYTES (default 5 MiB)
export const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024; // config MAX_DOCUMENT_UPLOAD_BYTES (default 10 MiB)

export const IMPORT_ACCEPTED_EXTENSIONS = ['.csv'] as const;

export interface ImportHeaderPreview {
  /** Raw text of the first line (trimmed). */
  headerRaw: string;
  /** Canonical columns present in order (Shared normalizer output). */
  positions: ReturnType<typeof normalizeImportHeader>['positions'];
  missing: string[];
  unknown: string[];
  /** False when the file has no header line to inspect. */
  hasHeader: boolean;
}

/**
 * Inspect a CSV blob's first line using the shared contract normalizer. Any
 * header cell is treated as inert text — callers render the preview without
 * HTML so malicious header content cannot execute in the browser.
 */
export async function previewImportHeader(file: File): Promise<ImportHeaderPreview> {
  const text = file.slice(0, 64 * 1024).text();
  const header = (await text).split(/\r?\n/, 1)[0] ?? '';
  if (header.trim() === '') {
    return { headerRaw: '', positions: [], missing: [...STUDENT_IMPORT_REQUIRED_COLUMNS], unknown: [], hasHeader: false };
  }
  const normalized = normalizeImportHeader(header.split(','));
  return {
    headerRaw: header,
    positions: normalized.positions,
    missing: normalized.missing,
    unknown: normalized.unknown,
    hasHeader: true,
  };
}

export function isAcceptedImportFile(file: File): boolean {
  return IMPORT_ACCEPTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
}

/** The canonical column set surfaced in the wizard ("accepted columns" help text). */
export function canonicalImportColumns(): readonly string[] {
  return STUDENT_IMPORT_COLUMNS;
}

/** The required canonical columns surfaced as a hint. */
export function requiredImportColumns(): readonly string[] {
  return STUDENT_IMPORT_REQUIRED_COLUMNS;
}