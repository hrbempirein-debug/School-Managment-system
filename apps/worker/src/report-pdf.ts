/**
 * Minimal, dependency-free PDF 1.4 writer for the Phase 6 report-card artifact.
 *
 * Why hand-rolled: the repository has no PDF dependency and Phase 6 needs a real,
 * storable, downloadable artifact — not a placeholder. A single-page text
 * document in the standard-14 Helvetica font needs no embedded font program and
 * no external library, so the whole renderer is the ~100 lines below and the
 * output is a structurally valid PDF (catalog/pages/page/font/content objects with
 * a correct cross-reference table).
 *
 * Scope is deliberately narrow: paginated plain text. If the school later needs
 * branded layouts, logos or RTL text, this is the seam to replace with a real
 * layout engine — the caller only passes `ReportCardLine[]`.
 */
export interface ReportCardLine {
  text: string;
  /** 'title' for the heading, 'normal' otherwise. */
  kind?: 'title' | 'normal';
}

const PAGE_WIDTH = 595; // A4 @ 72dpi
const PAGE_HEIGHT = 842;
const MARGIN_X = 50;
const FIRST_BASELINE = 790;
const TITLE_SIZE = 16;
const BODY_SIZE = 11;
const LINE_HEIGHT = 16;
const LINES_PER_PAGE = Math.floor((FIRST_BASELINE - MARGIN_X) / LINE_HEIGHT);

/** PDF string literals are byte strings: escape the delimiters and drop non-ASCII. */
function escapePdfText(value: string): string {
  const ascii = value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '?');
  return ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One page's content stream: a text object with one line per report line. */
function contentStream(lines: readonly ReportCardLine[]): string {
  const parts: string[] = ['BT'];
  let currentSize: number | null = null;
  let baseline = FIRST_BASELINE;
  lines.forEach((line, index) => {
    const size = line.kind === 'title' ? TITLE_SIZE : BODY_SIZE;
    if (size !== currentSize) {
      parts.push(`/F1 ${size} Tf`);
      currentSize = size;
    }
    const x = MARGIN_X;
    if (index === 0) parts.push(`${x} ${baseline} Td`);
    else parts.push(`T*`);
    parts.push(`(${escapePdfText(line.text)}) Tj`);
  });
  parts.push('ET');
  return parts.join('\n');
}

/**
 * Render `lines` into a paginated PDF. Deterministic for identical input (no
 * timestamps, no ids), so a redelivered job that re-renders produces the same
 * bytes and the artifact is stable.
 */
export function renderReportCardPdf(lines: readonly ReportCardLine[]): Buffer {
  const pages = chunk(lines.length === 0 ? [{ text: '' }] : lines, LINES_PER_PAGE);
  const streams = pages.map((page) => contentStream(page));

  // Object layout: 1 catalog, 2 pages, 3 font, then (page, content) per page.
  const pageCount = pages.length;
  const firstPageObj = 4;
  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((_, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPageObj + i * 2 + 1} 0 R >>`,
    );
    const body = streams[i]!;
    objects.push(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}
