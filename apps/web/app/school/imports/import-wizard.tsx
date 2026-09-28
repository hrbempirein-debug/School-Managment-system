'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { StudentImport, StudentImportDetailResponse, StudentImportListResponse, StudentImportResponse } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch, uploadStudentCsv } from '@/lib/http';
import {
  canonicalImportColumns,
  isAcceptedImportFile,
  MAX_IMPORT_UPLOAD_BYTES,
  previewImportHeader,
  requiredImportColumns,
} from '@/lib/csv';
import { importStatusLabel, importRowStatusLabel, importOutcomeSummary, isImportProcessed, isImportTerminal } from '@/lib/imports';
import { formatBytes, formatDateTime } from '@/lib/format';

interface ImportWizardProps {
  initial: StudentImport[];
  initialTotal: number;
  canRead: boolean;
  canCreate: boolean;
}

export function ImportWizard({ initial, initialTotal, canRead, canCreate }: ImportWizardProps) {
  const [history, setHistory] = useState<StudentImport[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // upload state
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewImportHeader>> | null>(null);
  const [converting, setConverting] = useState(false);

  // active import detail
  const [detail, setDetail] = useState<StudentImportDetailResponse | null>(null);
  const [polling, setPolling] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPolling(false);
  }

  useEffect(() => stopPolling, []);

  async function selectFile(next: File | null) {
    setFile(next);
    setPreview(null);
    setError(null);
    setMessage(null);
    if (!next) return;
    if (!isAcceptedImportFile(next)) {
      setError('Only .csv files are accepted.');
      return;
    }
    if (next.size > MAX_IMPORT_UPLOAD_BYTES) {
      setError('CSV is larger than the 5 MiB upload limit.');
      return;
    }
    setConverting(true);
    try {
      setPreview(await previewImportHeader(next));
    } catch {
      setError('Could not read the file header.');
    } finally {
      setConverting(false);
    }
  }

  async function submit() {
    setError(null);
    setMessage(null);
    if (!file) {
      setError('Choose a CSV file first.');
      return;
    }
    if (!isAcceptedImportFile(file)) {
      setError('Only .csv files are accepted.');
      return;
    }
    if (file.size > MAX_IMPORT_UPLOAD_BYTES) {
      setError('CSV is larger than the 5 MiB upload limit.');
      return;
    }
    setBusy(true);
    try {
      const res = await uploadStudentCsv(file);
      setDetail({ import: res.import, rows: [] });
      setHistory((prev) => {
        const next = [res.import, ...prev.filter((i) => i.id !== res.import.id)];
        return next;
      });
      setTotal((t) => t + (history.some((h) => h.id === res.import.id) ? 0 : 1));
      setFile(null);
      setPreview(null);
      setMessage('Upload accepted. Import is being processed — tracking progress below.');
      void poll(res.import.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function poll(id: string) {
    stopPolling();
    setPolling(true);
    const tick = async () => {
      try {
        const res = await clientFetch<StudentImportDetailResponse>(`/api/v1/students/imports/${encodeURIComponent(id)}`);
        setDetail(res);
        setHistory((prev) => prev.map((i) => (i.id === id ? res.import : i)));
        if (isImportTerminal(res.import.status)) {
          stopPolling();
          if (res.import.status === 'failed') {
            setError(res.import.errorSummary ?? 'Import failed.');
          } else {
            setMessage(`Import finished: ${importOutcomeSummary(res.import)}.`);
          }
        }
      } catch {
        // transient failure — keep polling a little longer
      }
    };
    void tick();
    timerRef.current = setInterval(() => void tick(), 2000);
  }

  async function openDetail(id: string) {
    setError(null);
    setMessage(null);
    setDetail(null);
    try {
      const res = await clientFetch<StudentImportDetailResponse>(`/api/v1/students/imports/${encodeURIComponent(id)}`);
      setDetail(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open import');
    }
  }

  function groupRows() {
    if (!detail) return [];
    return detail.rows;
  }

  if (!canRead) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <Link href="/school" className="text-sm text-blue-600 hover:underline">
          ← School
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Student imports</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view student imports.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Bulk import wizard</h1>
      {!canCreate && <p className="mt-2 text-sm text-amber-600">You can review previous imports, but your role cannot upload new ones.</p>}

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canCreate && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">Step 1 · Choose your CSV</h2>
          <p className="mt-1 text-xs text-gray-500">
            Accepted columns:{' '}
            <span className="font-mono">{canonicalImportColumns().join(', ')}</span>. Required:{' '}
            <span className="font-mono">{requiredImportColumns().join(', ')}</span>. Max {formatBytes(MAX_IMPORT_UPLOAD_BYTES)}.
          </p>
          <input
            type="file"
            accept=".csv"
            className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            onChange={(e) => void selectFile(e.target.files?.[0] ?? null)}
          />

          {converting && <p className="mt-3 text-xs text-gray-500">Reading header…</p>}
          {preview && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Step 2 · Header preview</h3>
              {!preview.hasHeader ? (
                <p className="mt-2 text-sm text-amber-600">This file has no readable header line.</p>
              ) : (
                <p className="mt-2 text-sm text-gray-600">{preview.headerRaw}</p>
              )}
              {preview.missing.length > 0 && (
                <p className="mt-2 text-sm text-amber-600">Missing required columns: {preview.missing.join(', ')}.</p>
              )}
              {preview.unknown.length > 0 && (
                <p className="mt-2 text-sm text-gray-500">Unmapped columns will be ignored: {preview.unknown.join(', ')}.</p>
              )}
              <p className="mt-2 text-xs text-gray-500">
                The file is still accepted as-is if the header can be mapped — the API and the import worker do the final
                validation and may reject individual rows.
              </p>
              <div className="mt-3">
                <Button type="button" disabled={busy} onClick={() => void submit()}>
                  Upload &amp; start import
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {detail && (
        <Card className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Active import</h2>
            {polling && <span className="text-xs text-blue-600">processing…</span>}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {detail.import.filename} · {importStatusLabel(detail.import.status)} · created {formatDateTime(detail.import.createdAt)}
          </p>
          <p className="mt-2 text-sm">
            {isImportProcessed(detail.import) ? importOutcomeSummary(detail.import) : 'Not finalised yet.'}
          </p>
          {detail.import.errorSummary && <p className="mt-2 text-sm text-amber-700">{detail.import.errorSummary}</p>}

          {groupRows().length > 0 && (
            <ul className="mt-4 divide-y divide-gray-100">
              {groupRows().map((row) => (
                <li key={row.rowNumber} className="py-2 text-sm">
                  <span className="font-medium">Row {row.rowNumber}</span> · {importRowStatusLabel(row.status)}
                  {row.field && <span className="text-gray-500"> · {row.field}</span>}
                  {row.message && <span className="block text-xs text-gray-500">{row.message}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Import history <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <ul className="mt-4 divide-y divide-gray-100">
          {history.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {item.filename} · {importStatusLabel(item.status)}
                </p>
                <p className="text-xs text-gray-500">
                  {importOutcomeSummary(item)} · {formatDateTime(item.createdAt)}
                </p>
              </div>
              <Button type="button" size="small" variant="secondary" onClick={() => void openDetail(item.id)}>
                View
              </Button>
            </li>
          ))}
          {history.length === 0 && <li className="py-3 text-sm text-gray-500">No imports yet.</li>}
        </ul>
      </Card>
    </main>
  );
}