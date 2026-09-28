'use client';

import { useEffect, useState } from 'react';
import type { StudentDocument, StudentDocumentListResponse, StudentDocumentResponse } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch, downloadViaCredentials, uploadStudentDocument } from '@/lib/http';
import { canDownloadDocument, scanStatusLabel } from '@/lib/documents';
import { MAX_DOCUMENT_UPLOAD_BYTES } from '@/lib/csv';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { DetailPermissions } from '../student-detail';

interface DocumentsTabProps {
  studentId: string;
  permissions: DetailPermissions;
}

export function DocumentsTab({ studentId, permissions }: DocumentsTabProps) {
  const { canReadDocuments, canUploadDocuments, canUpdateDocuments, canDeleteDocuments } = permissions;

  const [documents, setDocuments] = useState<StudentDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // upload form
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState('');

  // rename form per document
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('');

  async function load() {
    setError(null);
    try {
      const res = await clientFetch<StudentDocumentListResponse>(`/api/v1/students/${encodeURIComponent(studentId)}/documents?limit=100&offset=0`);
      setDocuments(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load documents');
    }
  }

  useEffect(() => {
    if (canReadDocuments) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, canReadDocuments]);

  async function upload() {
    setError(null);
    setMessage(null);
    if (!file) {
      setError('Choose a file first');
      return;
    }
    if (documentType.trim() === '') {
      setError('Enter a document type (e.g. birth-certificate, report-card)');
      return;
    }
    if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      setError('Document is larger than the 10 MiB upload limit');
      return;
    }
    setBusy(true);
    try {
      const res = await uploadStudentDocument(studentId, file, documentType.trim());
      setDocuments((prev) => [res.document, ...(prev ?? [])]);
      setFile(null);
      setDocumentType('');
      setMessage(`"${res.document.originalName}" uploaded. It will be available to download once the virus scan clears.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function saveRename(id: string) {
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, string> = {};
      if (editName.trim() !== '') body.originalName = editName.trim();
      if (editType.trim() !== '') body.documentType = editType.trim();
      const res = await clientFetch<StudentDocumentResponse>(`/api/v1/students/${encodeURIComponent(studentId)}/documents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body,
        includeCsrf: true,
      });
      setDocuments((prev) => (prev ? prev.map((d) => (d.id === id ? res.document : d)) : prev));
      setEditingId(null);
      setMessage('Document updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this document? The stored file and its record are removed for this student (audited).')) return;
    setError(null);
    setMessage(null);
    try {
      await clientFetch<void>(`/api/v1/students/${encodeURIComponent(studentId)}/documents/${encodeURIComponent(id)}`, { method: 'DELETE', includeCsrf: true });
      setDocuments((prev) => (prev ? prev.filter((d) => d.id !== id) : prev));
      setMessage('Document deleted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function download(doc: StudentDocument) {
    setError(null);
    setMessage(null);
    try {
      await downloadViaCredentials(
        `/api/v1/students/${encodeURIComponent(studentId)}/documents/${encodeURIComponent(doc.id)}/download`,
        doc.originalName || `${doc.documentType}.pdf`,
      );
      setMessage(`Downloaded "${doc.originalName}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  }

  if (!canReadDocuments) {
    return <Card><p className="text-sm text-gray-500">Your role cannot view documents.</p></Card>;
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Documents</h2>
      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canUploadDocuments && (
        <div className="mt-4 border-b border-gray-100 pb-4">
          <h3 className="text-sm font-semibold">Upload new document</h3>
          <p className="mt-1 text-xs text-gray-500">
            PNG, JPEG, WebP or PDF up to 10 MiB. Type is a free-form label (lowercase letters, digits, dashes).
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs text-gray-600">Type</span>
              <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={documentType} onChange={(e) => setDocumentType(e.target.value)} />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs text-gray-600">File</span>
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.pdf"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          <div className="mt-3">
            <Button type="button" size="small" disabled={busy} onClick={() => void upload()}>
              Upload
            </Button>
          </div>
        </div>
      )}

      {documents === null ? (
        <p className="mt-3 text-sm text-gray-500">Loading…</p>
      ) : documents.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">No documents uploaded yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-gray-100">
          {documents.map((doc) => (
            <li key={doc.id} className="py-3">
              {editingId === doc.id ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-xs text-gray-600">Name</span>
                    <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-600">Type</span>
                    <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={editType} onChange={(e) => setEditType(e.target.value)} />
                  </label>
                  <div className="flex items-end gap-3">
                    <Button type="button" size="small" disabled={busy} onClick={() => void saveRename(doc.id)}>
                      Save
                    </Button>
                    <Button type="button" size="small" variant="secondary" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{doc.originalName}</p>
                    <p className="text-xs text-gray-500">
                      {doc.documentType} · {formatBytes(doc.sizeBytes)} · {scanStatusLabel(doc.scanStatus)} · {formatDateTime(doc.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {canDownloadDocument(doc.scanStatus) ? (
                      <Button type="button" size="small" onClick={() => void download(doc)}>
                        Download
                      </Button>
                    ) : (
                      <span className="text-xs text-gray-400" title="Available to download once the virus scan is clean">
                        scan pending
                      </span>
                    )}
                    {canUpdateDocuments && (
                      <Button
                        type="button"
                        size="small"
                        variant="secondary"
                        onClick={() => {
                          setEditingId(doc.id);
                          setEditName(doc.originalName ?? '');
                          setEditType(doc.documentType);
                        }}
                      >
                        Rename
                      </Button>
                    )}
                    {canDeleteDocuments && (
                      <Button type="button" size="small" variant="danger" onClick={() => void remove(doc.id)}>
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}