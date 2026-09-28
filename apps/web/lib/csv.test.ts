import { describe, it, expect } from 'vitest';
import {
  canonicalImportColumns,
  isAcceptedImportFile,
  previewImportHeader,
  requiredImportColumns,
} from './csv';

describe('import file affordances', () => {
  it('requires a .csv extension', () => {
    expect(isAcceptedImportFile({ name: 'students.csv' } as File)).toBe(true);
    expect(isAcceptedImportFile({ name: 'students.xlsx' } as File)).toBe(false);
  });

  it('exposes the canonical and required column sets', () => {
    expect(canonicalImportColumns()).toContain('student_no');
    expect(canonicalImportColumns()).toContain('guardian_email');
    expect(requiredImportColumns()).toEqual(['student_no', 'first_name', 'last_name']);
  });
});

describe('previewImportHeader', () => {
  async function preview(text: string): Promise<ReturnType<typeof previewImportHeader>> {
    const file = new File([text], 'students.csv', { type: 'text/csv' });
    return previewImportHeader(file);
  }

  it('accepts a canonical header with all required columns', async () => {
    const p = await preview(
      'student_no,first_name,last_name,date_of_birth,gender,campus,guardian_first_name\n',
    );
    expect(p.hasHeader).toBe(true);
    expect(p.missing).toEqual([]);
    expect(p.unknown).toEqual([]);
  });

  it('flags a missing required column', async () => {
    const p = await preview('student_no,last_name\n');
    expect(p.missing).toContain('first_name');
  });

  it('flags an unknown/unsupported column', async () => {
    const p = await preview('student_no,first_name,last_name,middle_name\n');
    expect(p.unknown).toEqual(['middle_name']);
  });

  it('treats empty files as having no header', async () => {
    const p = await preview('');
    expect(p.hasHeader).toBe(false);
    expect(p.missing).toEqual(requiredImportColumns());
  });

  it('reports malicious header cells as inert unknown text (no markup execution)', async () => {
    const maliciousLine = 'student_no,<=cmd|&(\'C1\'!A0)>,"<script>alert(1)</script>"\n';
    const p = await preview(maliciousLine);
    // normalizeImportHeader lowercases cells; the values stay inert text either way.
    expect(p.unknown).toContain('<=cmd|&(\'c1\'!a0)>');
    expect(p.unknown.some((u) => u.includes('<script>alert(1)</script>'))).toBe(true);
    expect(p.missing).toContain('first_name');
    // The raw header is preserved for rendering as TEXT — never parsed as HTML.
    expect(p.headerRaw).toBe('student_no,<=cmd|&(\'C1\'!A0)>,"<script>alert(1)</script>"');
  });
});