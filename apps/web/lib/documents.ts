import type { StudentDocument } from '@sms/contracts';

type ScanStatus = StudentDocument['scanStatus'];

/** Human labels for the document scan lifecycle the worker hook owns. */
export const SCAN_STATUS_LABELS: Record<ScanStatus, string> = {
  pending: 'Scanning',
  clean: 'Clean',
  blocked: 'Blocked',
};

export const DOCUMENT_TYPES = [
  'birth_certificate',
  'report_card',
  'id_copy',
  'medical_record',
  'other',
] as const;

export function scanStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in SCAN_STATUS_LABELS) {
    return SCAN_STATUS_LABELS[status as ScanStatus];
  }
  return String(status ?? '—');
}

/**
 * Download is only safe after the worker scan hook cleared the file to 'clean'.
 * pending/blocked files are never downloadable (API enforces the same rule with
 * 403 scan_incomplete) — the UI mirrors it so users are not offered dead links.
 */
export function canDownloadDocument(scanStatus: unknown): boolean {
  return scanStatus === 'clean';
}