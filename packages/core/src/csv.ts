/**
 * Minimal, well-tested CSV utilities shared by the API (import/export) and tests.
 *
 * Scope is deliberately small and RFC 4180-shaped; there is no full-featured CSV
 * library in the workspace and none is warranted here. The parser is a
 * character-level state machine (no regex) so quoting/escaping stay exact; the
 * serializer quotes only when a field needs it. `csvFormulaSafe` is the defense
 * against spreadsheet formula-injection on exports (and on re-export of imported
 * values) — a leading `=`, `+`, `-`, `@` (also after leading whitespace) is
 * neutralized by prefixing a single quote, which spreadsheets render as text.
 */

const CR = '\r';
const LF = '\n';

/**
 * Parses CSV text into rows of fields. Handles embedded CRLF/LF/CR and `""`
 * escapes within quoted fields, strips a trailing BOM from the first field of the
 * first row, and drops blank lines. Never throws on malformed input — a trailing
 * unclosed quote yields the row up to EOF (field content preserved, not lost).
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  if (input.startsWith('\uFEFF')) i = 1;
  const len = input.length;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === CR) {
      if (input[i + 1] === LF) i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === LF) {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (row.length > 0 || field !== '' || inQuotes) {
    pushRow();
  }
  return rows;
}

function needsQuoting(field: string): boolean {
  return field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r');
}

/**
 * Serializes rows to RFC 4180 CSV text (CRLF line endings). Fields containing a
 * comma, quote or line break are quoted with `""` escapes. Never throws.
 */
export function serializeCsv(rows: readonly (readonly string[])[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const cells = row.map((field) => {
      if (!needsQuoting(field)) return field;
      return `"${field.replace(/"/g, '""')}"`;
    });
    lines.push(cells.join(','));
  }
  return lines.join('\r\n') + (lines.length > 0 ? '\r\n' : '');
}

/**
 * Neutralizes spreadsheet formula injection for a single cell value. When the
 * value (after any leading spaces/tabs) begins with `=`, `+`, `-`, `@`, CR or LF,
 * a leading single-quote is prepended so downstream spreadsheets treat it as
 * inert text. Non-matching values pass through untouched.
 */
export function csvFormulaSafe(value: string): string {
  if (value === '') return value;
  const trimmed = value.replace(/^[ \t]*/, '');
  const first = trimmed.charCodeAt(0);
  if (first === 0x3d /* = */ || first === 0x2b /* + */ || first === 0x2d /* - */ || first === 0x40 /* @ */) {
    return `'${value}`;
  }
  if (first === 0x0d /* CR */ || first === 0x0a /* LF */) return `'${value}`;
  return value;
}