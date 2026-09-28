/**
 * Academic wizard date helpers (pure, unit-testable). The server re-validates all
 * bounds via DB triggers; these helpers give the wizard instant feedback that
 * mirrors the API rules (term dates must fall inside the parent year, and the DB
 * CHECK requires starts < ends).
 */

export function parseIsoDate(value: string): number | null {
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

/** `inner` dates must be strictly inside the `outer` range (<= outer bounds). */
export function isDateWithinRange(
  innerStart: string,
  innerEnd: string,
  outerStart: string,
  outerEnd: string,
): boolean {
  const iS = parseIsoDate(innerStart);
  const iE = parseIsoDate(innerEnd);
  const oS = parseIsoDate(outerStart);
  const oE = parseIsoDate(outerEnd);
  if (iS === null || iE === null || oS === null || oE === null) return false;
  return iS < iE && oS < oE && iS >= oS && iE <= oE;
}

export function todayIsoDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}