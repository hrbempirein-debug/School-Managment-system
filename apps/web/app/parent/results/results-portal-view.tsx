'use client';

import { useState } from 'react';
import type { ReportCardDetail, ReportCardPreviewResponse, ResultsPortalView } from '@sms/contracts';
import { Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import { formatGpa, formatPercent, formatTotal, reportCardStatusLabel } from '@/lib/exams';

interface ResultsPortalViewProps {
  views: ResultsPortalView[];
}

/**
 * Read-only parent view of published results. The API already filtered to
 * published cards, so this component never needs a "draft" affordance; the only
 * interaction is opening the generated PDF artifact.
 */
export function ResultsPortalView({ views }: ResultsPortalViewProps) {
  const [expanded, setExpanded] = useState<Record<string, string>>({});
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function openPdf(card: ReportCardDetail): Promise<void> {
    if (fileUrls[card.id]) {
      window.open(fileUrls[card.id], '_blank', 'noopener');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await clientFetch<ReportCardPreviewResponse>(
        `/api/v1/report-cards/${card.id}`,
      );
      if (!res.fileUrl) {
        setError('The PDF is still being generated. Try again in a moment.');
        return;
      }
      setFileUrls((u) => ({ ...u, [card.id]: res.fileUrl as string }));
      window.open(res.fileUrl, '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">Results</h1>
      <p className="mt-1 text-sm text-gray-600">
        Published exam results for your children. Marks are shown as released by the school.
      </p>
      {error && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      <div className="mt-4 space-y-4">
        {views.map((view) => (
          <Card key={view.student.id}>
            <h2 className="text-lg font-semibold">
              {view.student.firstName} {view.student.lastName}
              <span className="ml-2 text-sm font-normal text-gray-500">{view.student.studentNo}</span>
            </h2>
            {view.entries.length === 0 ? (
              <p className="text-sm text-gray-600">No published exam results yet.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase text-gray-500">
                    <th className="py-2">Exam</th>
                    <th>Term</th>
                    <th>Year</th>
                    <th>Total</th>
                    <th>GPA</th>
                    <th>Subjects</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {view.entries.map((entry) => {
                    const open = expanded[view.student.id] === entry.examId;
                    const card = view.reportCards.find(
                      (c) => c.exam.id === entry.examId && c.status === 'published',
                    );
                    return (
                      <tr key={`${view.student.id}-${entry.examId}`} className="border-b align-top">
                        <td className="py-2">{entry.examName}</td>
                        <td>{entry.termName}</td>
                        <td>{entry.academicYearName}</td>
                        <td>{formatTotal(entry.totalObtained, entry.totalPossible)}</td>
                        <td>{formatGpa(entry.gpa)}</td>
                        <td>{entry.subjectCount}</td>
                        <td className="space-x-2 whitespace-nowrap">
                          {card && (
                            <button
                              type="button"
                              className="text-xs text-blue-600 underline"
                              onClick={() =>
                                setExpanded((e) => ({
                                  ...e,
                                  [view.student.id]: open ? '' : entry.examId,
                                }))
                              }
                            >
                              {open ? 'hide subjects' : 'subjects'}
                            </button>
                          )}
                          {card && (
                            <button
                              type="button"
                              className="text-xs text-green-700 underline disabled:text-gray-400"
                              disabled={busy}
                              onClick={() => void openPdf(card)}
                            >
                              PDF
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {view.reportCards
              .filter((c) => expanded[view.student.id] === c.exam.id)
              .map((card) => (
                <div key={card.id} className="mt-3 rounded border p-3">
                  <p className="text-sm font-medium">
                    {card.exam.name} — {reportCardStatusLabel(card.status)} · v{card.version} · GPA{' '}
                    {formatGpa(card.gpa)} · {formatTotal(card.totalObtained, card.totalPossible)}
                  </p>
                  <table className="mt-2 w-full text-left text-sm">
                    <thead>
                      <tr className="border-b text-xs uppercase text-gray-500">
                        <th className="py-1">Subject</th>
                        <th>Marks</th>
                        <th>%</th>
                        <th>Grade</th>
                        <th>Point</th>
                        <th>Weight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {card.subjects.map((line) => (
                        <tr key={line.subjectName} className="border-b">
                          <td className="py-1">{line.subjectName}</td>
                          <td>
                            {line.marksObtained ?? '—'} / {line.maxMarks}
                          </td>
                          <td>{formatPercent(line.percentage)}</td>
                          <td>{line.gradeLabel ?? '—'}</td>
                          <td>{line.gradePoint ?? '—'}</td>
                          <td>{line.weight}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
          </Card>
        ))}
      </div>
    </main>
  );
}
