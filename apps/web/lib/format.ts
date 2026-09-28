/**
 * Display helpers shared across the school UI. Pure and locale-independent so
 * every formatter is unit-testable without a browser (vitest, node env).
 */

/** Human-readable byte size ("1.5 MB"). Clamped cost, no dependencies. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[unit]}`;
}

/** "2026-09-24" from an ISO-8601 string; passthrough of already-short values. */
export function formatIsoDate(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1]! : value;
}

/** ISO-8601 date-time rendered as a date + UTC time ("2026-09-24 14:03"). */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}`;
}