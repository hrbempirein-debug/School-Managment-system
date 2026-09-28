'use client';

import { useState } from 'react';
import Link from 'next/link';
import type {
  AcademicTerm,
  AcademicTermListResponse,
  AcademicYear,
  AcademicYearResponse,
  AcademicTermResponse,
} from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import { isDateWithinRange, todayIsoDate } from '@/lib/academic';

interface AcademicYearWizardProps {
  initialYears: AcademicYear[];
  initialTotal: number;
  canReadYears: boolean;
  canWriteYears: boolean;
  canWriteTerms: boolean;
}

/** Pure term-state predicates mirrored from the API (unit-testable). */
export function canOpenTerm(term: Pick<AcademicTerm, 'status'>): boolean {
  return term.status === 'draft' || term.status === 'closed';
}

export function canCloseTerm(term: Pick<AcademicTerm, 'status'>): boolean {
  return term.status === 'open';
}

export function AcademicYearWizard({
  initialYears,
  initialTotal,
  canReadYears,
  canWriteYears,
  canWriteTerms,
}: AcademicYearWizardProps) {
  const [years, setYears] = useState<AcademicYear[]>(initialYears);
  const [total, setTotal] = useState(initialTotal);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [terms, setTerms] = useState<AcademicTerm[]>([]);
  const [termsLoadedFor, setTermsLoadedFor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // new-year form
  const [yrCode, setYrCode] = useState('');
  const [yrName, setYrName] = useState('');
  const [yrStart, setYrStart] = useState(todayIsoDate());
  const [yrEnd, setYrEnd] = useState('');

  // new-term form
  const [tmCode, setTmCode] = useState('');
  const [tmName, setTmName] = useState('');
  const [tmSeq, setTmSeq] = useState(1);
  const [tmStart, setTmStart] = useState('');
  const [tmEnd, setTmEnd] = useState('');

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : 'Request failed');
    setMessage(null);
  }

  async function createYear() {
    setError(null);
    setMessage(null);
    if (!yrCode.trim() || !yrName.trim() || !yrStart || !yrEnd) {
      setError('Code, name, start and end dates are required');
      return;
    }
    try {
      const res = await clientFetch<AcademicYearResponse>('/api/v1/academic-years', {
        method: 'POST',
        body: { code: yrCode.trim(), name: yrName.trim(), startsOn: yrStart, endsOn: yrEnd },
        includeCsrf: true,
      });
      setYears((prev) => [...prev, res.academicYear]);
      setTotal((t) => t + 1);
      setSelectedId(res.academicYear.id);
      setTerms([]);
      setTermsLoadedFor(null);
      setYrCode('');
      setYrName('');
      setYrEnd('');
      setMessage(`Academic year "${res.academicYear.name}" created.`);
    } catch (err) {
      fail(err);
    }
  }

  async function openYear(year: AcademicYear) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<AcademicYearResponse>(`/api/v1/academic-years/${year.id}/open`, {
        method: 'POST',
        includeCsrf: true,
      });
      setYears((prev) => prev.map((y) => (y.id === year.id ? res.academicYear : y)));
      setMessage('Academic year opened.');
    } catch (err) {
      fail(err);
    }
  }

  async function closeYear(year: AcademicYear) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<AcademicYearResponse>(`/api/v1/academic-years/${year.id}/close`, {
        method: 'POST',
        includeCsrf: true,
      });
      setYears((prev) => prev.map((y) => (y.id === year.id ? res.academicYear : y)));
      setMessage('Academic year closed.');
    } catch (err) {
      fail(err);
    }
  }

  async function selectYear(yearId: string) {
    setSelectedId(yearId);
    setError(null);
    setMessage(null);
    if (termsLoadedFor === yearId) return;
    try {
      const res = await clientFetch<AcademicTermListResponse>(
        `/api/v1/academic-years/${yearId}/terms?limit=100&offset=0`,
      );
      setTerms(res.items);
      setTermsLoadedFor(yearId);
    } catch (err) {
      fail(err);
    }
  }

  async function createTerm(year: AcademicYear) {
    setError(null);
    setMessage(null);
    if (!tmCode.trim() || !tmName.trim() || !tmStart || !tmEnd) {
      setError('Code, name, start and end dates are required');
      return;
    }
    if (!isDateWithinRange(tmStart, tmEnd, year.startsOn, year.endsOn)) {
      setError('Term dates must fall inside the academic year and be ordered.');
      return;
    }
    try {
      const res = await clientFetch<AcademicTermResponse>(`/api/v1/academic-years/${year.id}/terms`, {
        method: 'POST',
        body: {
          code: tmCode.trim(),
          name: tmName.trim(),
          sequence: tmSeq,
          startsOn: tmStart,
          endsOn: tmEnd,
        },
        includeCsrf: true,
      });
      setTerms((prev) => [...prev, res.academicTerm].sort((a, b) => a.sequence - b.sequence));
      setTmCode('');
      setTmName('');
      setTmStart('');
      setTmEnd('');
      setTmSeq((s) => s + 1);
      setMessage(`Term "${res.academicTerm.name}" added.`);
    } catch (err) {
      fail(err);
    }
  }

  async function openTerm(termId: string) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<AcademicTermResponse>(`/api/v1/academic-terms/${termId}/open`, {
        method: 'POST',
        includeCsrf: true,
      });
      setTerms((prev) => prev.map((t) => (t.id === termId ? res.academicTerm : t)));
      setMessage('Term opened.');
    } catch (err) {
      fail(err);
    }
  }

  async function closeTerm(termId: string) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<AcademicTermResponse>(`/api/v1/academic-terms/${termId}/close`, {
        method: 'POST',
        includeCsrf: true,
      });
      setTerms((prev) => prev.map((t) => (t.id === termId ? res.academicTerm : t)));
      setMessage('Term closed.');
    } catch (err) {
      fail(err);
    }
  }

  if (!canReadYears) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <Link href="/school" className="text-sm text-blue-600 hover:underline">
          ← School
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Academic Year</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view academic years.</p>
      </main>
    );
  }

  const selected = years.find((y) => y.id === selectedId) ?? null;

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Academic Year</h1>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canWriteYears && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">New academic year</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-5">
            <label className="block">
              <span className="text-sm text-gray-600">Code</span>
              <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={yrCode} onChange={(e) => setYrCode(e.target.value)} />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-sm text-gray-600">Name</span>
              <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={yrName} onChange={(e) => setYrName(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Starts</span>
              <input type="date" className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={yrStart} onChange={(e) => setYrStart(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Ends</span>
              <input type="date" className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={yrEnd} onChange={(e) => setYrEnd(e.target.value)} />
            </label>
          </div>
          <div className="mt-4">
            <Button type="button" onClick={() => void createYear()}>
              Create year
            </Button>
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Years <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <ul className="mt-4 space-y-3">
          {years.map((year) => (
            <li key={year.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between">
                <button type="button" className="text-left" onClick={() => void selectYear(year.id)}>
                  <p className="text-sm font-medium">
                    {year.name} <span className="text-gray-400">({year.code})</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {year.startsOn} → {year.endsOn} · {year.status}
                  </p>
                </button>
                <div className="flex gap-2">
                  {canWriteYears && year.status === 'draft' && (
                    <Button type="button" size="small" onClick={() => void openYear(year)}>
                      Open
                    </Button>
                  )}
                  {canWriteYears && year.status === 'active' && (
                    <Button type="button" size="small" onClick={() => void closeYear(year)}>
                      Close
                    </Button>
                  )}
                </div>
              </div>

              {selectedId === year.id && (
                <div className="mt-3 border-t pt-3">
                  {selected === null ? (
                    <p className="text-xs text-gray-500">Terms for this year will load below.</p>
                  ) : terms.length === 0 ? (
                    <p className="text-xs text-gray-500">
                      No terms yet{canWriteTerms && year.status !== 'closed' ? ' — add the first term below.' : '.'}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {terms.map((term) => (
                        <li
                          key={term.id}
                          className="flex items-center justify-between rounded border border-gray-100 bg-gray-50 px-2 py-1 text-sm"
                        >
                          <span>
                            {term.name} <span className="text-gray-400">({term.code}, seq {term.sequence})</span> ·{' '}
                            {term.startsOn} → {term.endsOn} · {term.status}
                          </span>
                          <span className="flex gap-2">
                            {canWriteTerms && canOpenTerm(term) && (
                              <button type="button" className="text-blue-600 hover:underline" onClick={() => void openTerm(term.id)}>
                                Open
                              </button>
                            )}
                            {canWriteTerms && canCloseTerm(term) && (
                              <button type="button" className="text-gray-600 hover:underline" onClick={() => void closeTerm(term.id)}>
                                Close
                              </button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {canWriteTerms && selected !== null && selected.status !== 'closed' && (
                    <div className="mt-3 grid gap-3 sm:grid-cols-6">
                      <label className="block">
                        <span className="text-xs text-gray-600">Code</span>
                        <input className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" value={tmCode} onChange={(e) => setTmCode(e.target.value)} />
                      </label>
                      <label className="block sm:col-span-2">
                        <span className="text-xs text-gray-600">Name</span>
                        <input className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" value={tmName} onChange={(e) => setTmName(e.target.value)} />
                      </label>
                      <label className="block">
                        <span className="text-xs text-gray-600">Seq</span>
                        <input type="number" min={1} className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" value={tmSeq} onChange={(e) => setTmSeq(Number(e.target.value) || 1)} />
                      </label>
                      <label className="block">
                        <span className="text-xs text-gray-600">Starts</span>
                        <input type="date" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" value={tmStart} onChange={(e) => setTmStart(e.target.value)} />
                      </label>
                      <label className="block">
                        <span className="text-xs text-gray-600">Ends</span>
                        <input type="date" className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" value={tmEnd} onChange={(e) => setTmEnd(e.target.value)} />
                      </label>
                      <div className="sm:col-span-6">
                        <Button type="button" size="small" onClick={() => void createTerm(selected)}>
                          Add term
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
          {years.length === 0 && <li className="text-sm text-gray-500">No academic years yet.</li>}
        </ul>
      </Card>
    </main>
  );
}