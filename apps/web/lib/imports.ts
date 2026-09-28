import type { StudentImportRow } from '@sms/contracts';
import type { StudentImport } from '@sms/contracts';

type ImportStatus = StudentImport['status'];
type RowStatus = StudentImportRow['status'];

/** Human labels for the async import lifecycle the worker owns. */
export const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = {
  submitted: 'Submitted',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

export const IMPORT_ROW_STATUS_LABELS: Record<RowStatus, string> = {
  created: 'Created',
  duplicate: 'Duplicate',
  conflict: 'Conflict',
  rejected: 'Rejected',
};

export function importStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in IMPORT_STATUS_LABELS) {
    return IMPORT_STATUS_LABELS[status as ImportStatus];
  }
  return String(status ?? '—');
}

export function importRowStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in IMPORT_ROW_STATUS_LABELS) {
    return IMPORT_ROW_STATUS_LABELS[status as RowStatus];
  }
  return String(status ?? '—');
}

/**
 * Terminal states: the worker transitioned the import and detail rows (if any)
 * are final — polling can stop.
 */
export function isImportTerminal(status: unknown): boolean {
  return status === 'completed' || status === 'failed';
}

/** Terminal-AND-processed: row results are reported and displayed. */
export function isImportProcessed(status: unknown): boolean {
  return status === 'completed';
}

/**
 * Safe one-line outcome summary. Plain text only — caller renders it as text so
 * no CSV content can ever become executable markup in the browser.
 */
export function importOutcomeSummary(imp: Pick<StudentImport, 'totalRows' | 'createdCount' | 'duplicateCount' | 'conflictCount' | 'rejectedCount' | 'status'> & { errorSummary?: string | null }): string {
  if (imp.status === 'failed') return imp.errorSummary ?? 'Import failed';
  return `${imp.createdCount} created, ${imp.duplicateCount} duplicate, ${imp.conflictCount} conflict, ${imp.rejectedCount} rejected (${imp.totalRows} rows)`;
}