'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  AcdClass,
  AcademicTerm,
  AcademicYear,
  ClassSubject,
  Exam,
  ExamStatus,
  ExamSubject,
  ExamType,
  GradebookResponse,
  GradingScale,
  GradingScaleBand,
  ReportCard,
  Subject,
} from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import {
  allowedExamTransitions,
  canTransitionExam,
  cellText,
  examStatusLabel,
  formatGpa,
  formatPercent,
  formatTotal,
  gradebookProgress,
  gradeForPercent,
  markEntryGate,
  markStatusLabel,
  publishGate,
  reportCardStatusLabel,
  sortGradebookRows,
  validateBands,
  validateMarkDraft,
} from '@/lib/exams';

type Tab = 'exams' | 'gradebook' | 'scales' | 'report-cards';

interface ExamManagerProps {
  initialExams: Exam[];
  examTypes: ExamType[];
  gradingScales: GradingScale[];
  academicYears: AcademicYear[];
  academicTerms: AcademicTerm[];
  classes: AcdClass[];
  subjectCatalog: Subject[];
  canManage: boolean;
  canMark: boolean;
  canPublish: boolean;
  canCorrect: boolean;
  canReadClassSubjects: boolean;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'exams', label: 'Exams' },
  { id: 'gradebook', label: 'Gradebook' },
  { id: 'scales', label: 'Grading scales' },
  { id: 'report-cards', label: 'Report cards' },
];

const DEFAULT_BANDS: GradingScaleBand[] = [
  { label: 'A', minPercent: 80, maxPercent: 100, gradePoint: 4 },
  { label: 'B', minPercent: 70, maxPercent: 80, gradePoint: 3 },
  { label: 'C', minPercent: 60, maxPercent: 70, gradePoint: 2 },
  { label: 'D', minPercent: 50, maxPercent: 60, gradePoint: 1 },
  { label: 'E', minPercent: 0, maxPercent: 50, gradePoint: 0 },
];

export function ExamManager({
  initialExams,
  examTypes,
  gradingScales,
  academicYears,
  academicTerms,
  classes,
  subjectCatalog,
  canManage,
  canMark,
  canPublish,
  canCorrect,
  canReadClassSubjects,
}: ExamManagerProps) {
  const [tab, setTab] = useState<Tab>('exams');
  const [exams, setExams] = useState<Exam[]>(initialExams);
  // Publication readiness per exam. The list endpoint deliberately does not
  // embed these counts, so they are read from the subjects (and, per subject,
  // the gradebook) instead of being guessed: the button must reflect what the
  // server will actually accept, not a placeholder.
  const [readiness, setReadiness] = useState<Record<string, { subjects: number; marksEntered: number }>>({});
  const [scales, setScales] = useState<GradingScale[]>(gradingScales);
  const [reportCards, setReportCards] = useState<ReportCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // create-exam form
  const [examName, setExamName] = useState('');
  const [examTypeId, setExamTypeId] = useState(examTypes[0]?.id ?? '');
  const [examTermId, setExamTermId] = useState(academicTerms[0]?.id ?? '');
  const [examScaleId, setExamScaleId] = useState('');

  // attach-subject form
  const [attachExamId, setAttachExamId] = useState(initialExams[0]?.id ?? '');
  const [attachClassId, setAttachClassId] = useState(classes[0]?.id ?? '');
  const [classSubjects, setClassSubjects] = useState<ClassSubject[]>([]);
  const [attachClassSubjectId, setAttachClassSubjectId] = useState('');
  const [maxMarks, setMaxMarks] = useState('100');
  const [weight, setWeight] = useState('1');

  // gradebook
  const [gradebookExamId, setGradebookExamId] = useState(initialExams[0]?.id ?? '');
  const [examSubjects, setExamSubjects] = useState<ExamSubject[]>([]);
  const [gradebook, setGradebook] = useState<GradebookResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});

  // correction
  const [correctMarkId, setCorrectMarkId] = useState('');
  const [correctValue, setCorrectValue] = useState('');
  const [correctReason, setCorrectReason] = useState('');

  // grading scale form
  const [scaleCode, setScaleCode] = useState('');
  const [scaleName, setScaleName] = useState('');
  const [scaleBands, setScaleBands] = useState<GradingScaleBand[]>(DEFAULT_BANDS);

  const subjectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of subjectCatalog) map.set(s.id, s.name);
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [subjectCatalog]);

  const activeScale = useMemo(() => scales.find((s) => s.isActive) ?? null, [scales]);

  // Only the publish button needs these counts, so nobody without `exams.publish`
  // pays for the extra reads.
  useEffect(() => {
    if (!canPublish) return;
    void loadReadiness(exams);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshes whenever
    // the exam list itself changes; loadReadiness is defined per render.
  }, [canPublish, exams]);

  async function run(action: () => Promise<string>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadExams(): Promise<Exam[]> {
    const res = await clientFetch<ExamListResponseShape>('/api/v1/exams?limit=100');
    return res.items;
  }

  /**
   * Subjects and entered marks for every exam that could still be published.
   * Terminal exams (published/cancelled) are skipped: their numbers cannot
   * change, and a teacher only sees the gradebooks they own, which is exactly
   * the same scoping the API applies.
   */
  async function loadReadiness(list: readonly Exam[]): Promise<void> {
    const pending = list.filter(
      (e) => e.status === 'draft' || e.status === 'scheduled' || e.status === 'grading',
    );
    const next: Record<string, { subjects: number; marksEntered: number }> = {};
    await Promise.all(
      pending.map(async (exam) => {
        let subjects = 0;
        let marksEntered = 0;
        try {
          const res = await clientFetch<{ items: ExamSubject[] }>(`/api/v1/exams/${exam.id}/subjects`);
          subjects = res.items.length;
          const books = await Promise.all(
            res.items.map((es) =>
              clientFetch<GradebookResponse>(`/api/v1/exam-subjects/${es.id}/gradebook`).catch(() => null),
            ),
          );
          for (const book of books) {
            marksEntered += book === null ? 0 : book.rows.filter((r) => r.marksObtained !== null).length;
          }
        } catch {
          // A reader without gradebook access still gets the subject count the
          // subjects endpoint allows, and 0 marks: the server has the last word.
        }
        next[exam.id] = { subjects, marksEntered };
      }),
    );
    setReadiness(next);
  }

  async function createExam(): Promise<void> {
    await run(async () => {
      if (examName.trim() === '') throw new Error('Exam name is required');
      if (!examTermId) throw new Error('Pick an academic term');
      if (!examTypeId) throw new Error('Pick an exam type');
      await clientFetch('/api/v1/exams', {
        method: 'POST',
        includeCsrf: true,
        body: {
          academicTermId: examTermId,
          examTypeId,
          name: examName.trim(),
          gradingScaleId: examScaleId === '' ? null : examScaleId,
        },
      });
      const list = await loadExams();
      setExams(list);
      void loadReadiness(list);
      setExamName('');
      return 'Exam created as a draft.';
    });
  }

  async function transition(examId: string, status: ExamStatus): Promise<void> {
    await run(async () => {
      await clientFetch(`/api/v1/exams/${examId}/status`, {
        method: 'POST',
        includeCsrf: true,
        body: { status },
      });
      const list = await loadExams();
      setExams(list);
      void loadReadiness(list);
      return `Exam moved to ${examStatusLabel(status).toLowerCase()}.`;
    });
  }

  async function publish(examId: string): Promise<void> {
    await run(async () => {
      const res = await clientFetch<{ exam: Exam; publishedReportCards: number }>(
        `/api/v1/exams/${examId}/publish`,
        { method: 'POST', includeCsrf: true, body: {} },
      );
      const list = await loadExams();
      setExams(list);
      void loadReadiness(list);
      return `Published. ${res.publishedReportCards} draft report card(s) published; results are computed by the worker.`;
    });
  }

  async function loadClassSubjects(): Promise<void> {
    if (!attachClassId || !canReadClassSubjects) return;
    await run(async () => {
      const res = await clientFetch<{ items: ClassSubject[] }>(
        `/api/v1/classes/${attachClassId}/subjects`,
      );
      setClassSubjects(res.items);
      setAttachClassSubjectId(res.items[0]?.id ?? '');
      return `${res.items.length} class subject(s) available.`;
    });
  }

  async function attachSubject(): Promise<void> {
    await run(async () => {
      if (!attachExamId) throw new Error('Pick an exam');
      if (!attachClassSubjectId) throw new Error('Pick a class subject');
      const parsedMax = Number(maxMarks);
      const parsedWeight = Number(weight);
      if (!Number.isFinite(parsedMax) || parsedMax <= 0) throw new Error('Max marks must be positive');
      if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) throw new Error('Weight must be positive');
      await clientFetch(`/api/v1/exams/${attachExamId}/subjects`, {
        method: 'POST',
        includeCsrf: true,
        body: {
          examId: attachExamId,
          classSubjectId: attachClassSubjectId,
          maxMarks: parsedMax,
          weight: parsedWeight,
        },
      });
      if (gradebookExamId === attachExamId) await loadExamSubjects(attachExamId);
      return 'Exam subject attached.';
    });
  }

  async function loadExamSubjects(examId: string): Promise<void> {
    const res = await clientFetch<{ items: ExamSubject[] }>(`/api/v1/exams/${examId}/subjects`);
    setExamSubjects(res.items);
  }

  async function openGradebook(examId: string): Promise<void> {
    setGradebookExamId(examId);
    await run(async () => {
      const subjects = await clientFetch<{ items: ExamSubject[] }>(`/api/v1/exams/${examId}/subjects`);
      setExamSubjects(subjects.items);
      const first = subjects.items[0];
      setGradebook(null);
      setDraft({});
      setCellErrors({});
      if (!first) return 'This exam has no subjects yet.';
      const grid = await clientFetch<GradebookResponse>(`/api/v1/exam-subjects/${first.id}/gradebook`);
      setGradebook(grid);
      setDraft(Object.fromEntries(grid.rows.map((r) => [r.enrollmentId, cellText(r)])));
      return `Gradebook: ${grid.subjectName} — ${grid.className}.`;
    });
  }

  async function selectExamSubject(examSubjectId: string): Promise<void> {
    await run(async () => {
      const grid = await clientFetch<GradebookResponse>(`/api/v1/exam-subjects/${examSubjectId}/gradebook`);
      setGradebook(grid);
      setDraft(Object.fromEntries(grid.rows.map((r) => [r.enrollmentId, cellText(r)])));
      setCellErrors({});
      return `Gradebook: ${grid.subjectName} — ${grid.className}.`;
    });
  }

  async function saveMarks(): Promise<void> {
    if (!gradebook) return;
    await run(async () => {
      const { invalid, entries } = validateMarkDraft(gradebook.rows, gradebook.maxMarks, draft);
      setCellErrors(invalid);
      if (Object.keys(invalid).length > 0) {
        throw new Error('Fix the highlighted marks before saving.');
      }
      const res = await clientFetch<{ entered: number; inserted: number; updated: number }>('/api/v1/marks', {
        method: 'POST',
        includeCsrf: true,
        body: { examSubjectId: gradebook.examSubject.id, entries },
      });
      const grid = await clientFetch<GradebookResponse>(`/api/v1/exam-subjects/${gradebook.examSubject.id}/gradebook`);
      setGradebook(grid);
      setDraft(Object.fromEntries(grid.rows.map((r) => [r.enrollmentId, cellText(r)])));
      return `Saved ${res.entered} mark(s): ${res.inserted} new, ${res.updated} updated.`;
    });
  }

  async function submitCorrection(): Promise<void> {
    await run(async () => {
      if (!correctMarkId.trim()) throw new Error('Mark id is required');
      const value = Number(correctValue);
      if (!Number.isFinite(value) || value < 0) throw new Error('Enter the corrected mark');
      if (correctReason.trim().length < 3) throw new Error('A correction needs a reason (3+ characters)');
      await clientFetch(`/api/v1/marks/${correctMarkId.trim()}/corrections`, {
        method: 'POST',
        includeCsrf: true,
        body: { marksObtained: value, reason: correctReason.trim() },
      });
      setCorrectMarkId('');
      setCorrectValue('');
      setCorrectReason('');
      if (gradebook) {
        const grid = await clientFetch<GradebookResponse>(`/api/v1/exam-subjects/${gradebook.examSubject.id}/gradebook`);
        setGradebook(grid);
        setDraft(Object.fromEntries(grid.rows.map((r) => [r.enrollmentId, cellText(r)])));
      }
      return 'Correction recorded and the mark rechecked.';
    });
  }

  async function createScale(): Promise<void> {
    await run(async () => {
      if (!/^[a-z0-9_]{1,32}$/.test(scaleCode.trim())) {
        throw new Error('Scale code must be lowercase letters, digits or underscore');
      }
      if (scaleName.trim() === '') throw new Error('Scale name is required');
      const problem = validateBands(scaleBands);
      if (problem) throw new Error(problem);
      const res = await clientFetch<{ gradingScale: GradingScale }>('/api/v1/grading-scales', {
        method: 'POST',
        includeCsrf: true,
        body: { code: scaleCode.trim(), name: scaleName.trim(), bands: scaleBands },
      });
      const list = await clientFetch<{ items: GradingScale[] }>('/api/v1/grading-scales');
      setScales(list.items);
      setScaleCode('');
      setScaleName('');
      return `Grading scale v${res.gradingScale.version} created. Activate it to use it for new exams.`;
    });
  }

  async function activateScale(id: string): Promise<void> {
    await run(async () => {
      await clientFetch(`/api/v1/grading-scales/${id}`, {
        method: 'PATCH',
        includeCsrf: true,
        body: { isActive: true },
      });
      const list = await clientFetch<{ items: GradingScale[] }>('/api/v1/grading-scales');
      setScales(list.items);
      return 'Grading scale activated.';
    });
  }

  async function loadReportCards(): Promise<void> {
    await run(async () => {
      const res = await clientFetch<{ items: ReportCard[] }>('/api/v1/report-cards?limit=100');
      setReportCards(res.items);
      return `${res.items.length} report card(s).`;
    });
  }

  const progress = gradebook ? gradebookProgress(gradebook.rows) : null;
  const gate = gradebook ? markEntryGate(gradebook.locked, gradebook.canMark) : null;

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-semibold">Exams &amp; results</h1>
      <p className="mt-1 text-sm text-gray-600">
        Exam lifecycle, mark entry, publication, corrections and report cards.
      </p>

      <div className="mt-4 flex gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              if (t.id === 'report-cards') void loadReportCards();
            }}
            className={`px-3 py-2 text-sm ${tab === t.id ? 'border-b-2 border-blue-600 font-medium' : 'text-gray-600'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="mt-3 rounded bg-green-50 p-2 text-sm text-green-700">{notice}</p>}

      {tab === 'exams' && (
        <div className="mt-4 space-y-4">
          {canManage && (
            <Card>
              <h2 className="text-lg font-semibold">New exam</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  Name
                  <input
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={examName}
                    onChange={(e) => setExamName(e.target.value)}
                  />
                </label>
                <label className="text-sm">
                  Exam type
                  <select
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={examTypeId}
                    onChange={(e) => setExamTypeId(e.target.value)}
                  >
                    {examTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Academic term
                  <select
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={examTermId}
                    onChange={(e) => setExamTermId(e.target.value)}
                  >
                    {academicTerms.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.startsOn} → {t.endsOn})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Grading scale (optional)
                  <select
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={examScaleId}
                    onChange={(e) => setExamScaleId(e.target.value)}
                  >
                    <option value="">Use the active scale at compute time</option>
                    {scales.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} v{s.version}
                        {s.isActive ? ' (active)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-3">
                <Button onClick={createExam} disabled={busy}>
                  Create draft exam
                </Button>
              </div>
            </Card>
          )}

          <Card>
            <h2 className="text-lg font-semibold">Exams</h2>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs uppercase text-gray-500">
                  <th className="py-2">Name</th>
                  <th>Status</th>
                  <th>Published</th>
                  <th>Subjects</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {exams.map((exam) => {
                  const stats = readiness[exam.id];
                  const gatePublish = publishGate({
                    status: exam.status,
                    // Unknown (not yet loaded, or no gradebook access) is 0, which
                    // leaves the button disabled rather than falsely enabled.
                    subjects: stats?.subjects ?? 0,
                    marksEntered: stats?.marksEntered ?? 0,
                  });
                  return (
                    <tr key={exam.id} className="border-b">
                      <td className="py-2">{exam.name}</td>
                      <td>{examStatusLabel(exam.status)}</td>
                      <td>{exam.publishedAt ? exam.publishedAt.slice(0, 10) : '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="text-blue-600 underline"
                          onClick={() => {
                            setGradebookExamId(exam.id);
                            setTab('gradebook');
                            void openGradebook(exam.id);
                          }}
                        >
                          manage
                        </button>
                      </td>
                      <td className="space-x-2 py-2">
                        {canManage &&
                          allowedExamTransitions(exam.status).map((target) => (
                            <button
                              key={target}
                              type="button"
                              className="text-xs text-gray-700 underline"
                              disabled={busy}
                              onClick={() => void transition(exam.id, target)}
                            >
                              {examStatusLabel(target).toLowerCase()}
                            </button>
                          ))}
                        {canPublish && (
                          <button
                            type="button"
                            className="text-xs font-medium text-green-700 underline"
                            disabled={busy || !gatePublish.allowed}
                            title={gatePublish.reason ?? undefined}
                            onClick={() => void publish(exam.id)}
                          >
                            publish
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {exams.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-3 text-sm text-gray-500">
                      No exams yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          {canManage && (
            <Card>
              <h2 className="text-lg font-semibold">Attach a subject to an exam</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  Exam
                  <select
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={attachExamId}
                    onChange={(e) => setAttachExamId(e.target.value)}
                  >
                    {exams.map((exam) => (
                      <option key={exam.id} value={exam.id}>
                        {exam.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Class
                  <select
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={attachClassId}
                    onChange={(e) => setAttachClassId(e.target.value)}
                  >
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Class subject
                  <select
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={attachClassSubjectId}
                    onChange={(e) => setAttachClassSubjectId(e.target.value)}
                  >
                    {classSubjects.map((cs) => (
                      <option key={cs.id} value={cs.id}>
                        {subjectName(cs.subjectId)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    Max marks
                    <input
                      className="mt-1 w-full rounded border px-2 py-1"
                      value={maxMarks}
                      onChange={(e) => setMaxMarks(e.target.value)}
                    />
                  </label>
                  <label className="text-sm">
                    Weight
                    <input
                      className="mt-1 w-full rounded border px-2 py-1"
                      value={weight}
                      onChange={(e) => setWeight(e.target.value)}
                    />
                  </label>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button onClick={loadClassSubjects} disabled={busy || !canReadClassSubjects}>
                  Load class subjects
                </Button>
                <Button onClick={attachSubject} disabled={busy || !canReadClassSubjects}>
                  Attach subject
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === 'gradebook' && (
        <div className="mt-4 space-y-4">
          <Card>
            <h2 className="text-lg font-semibold">Exam</h2>
            <select
              className="w-full rounded border px-2 py-1 text-sm"
              value={gradebookExamId}
              onChange={(e) => {
                setGradebookExamId(e.target.value);
                if (e.target.value) void openGradebook(e.target.value);
              }}
            >
              <option value="">Select an exam…</option>
              {exams.map((exam) => (
                <option key={exam.id} value={exam.id}>
                  {exam.name} ({examStatusLabel(exam.status)})
                </option>
              ))}
            </select>
            {examSubjects.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {examSubjects.map((es) => (
                  <button
                    key={es.id}
                    type="button"
                    onClick={() => void selectExamSubject(es.id)}
                    className={`rounded border px-2 py-1 text-xs ${
                      gradebook?.examSubject.id === es.id ? 'border-blue-600 font-medium' : 'text-gray-700'
                    }`}
                  >
                    {subjectName(es.subjectId)} · max {es.maxMarks} · weight {es.weight}
                  </button>
                ))}
              </div>
            )}
          </Card>

          {gradebook && (
            <Card>
              <h2 className="text-lg font-semibold">
                {gradebook.subjectName} — {gradebook.className}
                {gradebook.sectionName ? ` / ${gradebook.sectionName}` : ''}
              </h2>
              <p className="text-xs text-gray-600">
                Max marks {gradebook.maxMarks} · {progress?.entered}/{progress?.total} entered ·{' '}
                {gradebook.locked ? 'PUBLISHED (read-only)' : gradebook.canMark ? 'you can mark' : 'read-only'}
                {activeScale ? ` · scale ${activeScale.name} v${activeScale.version}` : ' · no active grading scale'}
              </p>
              {gate && !gate.allowed && gate.reason && (
                <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{gate.reason}</p>
              )}
              <table className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase text-gray-500">
                    <th className="py-2">Roll</th>
                    <th>Student</th>
                    <th className="w-28">Marks</th>
                    <th>%</th>
                    <th>Grade</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortGradebookRows(gradebook.rows).map((row) => (
                    <tr key={row.enrollmentId} className="border-b">
                      <td className="py-1">{row.rollNo ?? '—'}</td>
                      <td>{row.studentName}</td>
                      <td>
                        <input
                          className={`w-24 rounded border px-2 py-1 ${
                            cellErrors[row.enrollmentId] ? 'border-red-500' : ''
                          }`}
                          disabled={!gate?.allowed}
                          value={draft[row.enrollmentId] ?? ''}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, [row.enrollmentId]: e.target.value }))
                          }
                        />
                        {cellErrors[row.enrollmentId] && (
                          <p className="text-xs text-red-600">{cellErrors[row.enrollmentId]}</p>
                        )}
                      </td>
                      <td>{formatPercent(row.percentage)}</td>
                      <td>
                        {row.gradeLabel ??
                          gradeForPercent(activeScale?.bands ?? [], row.percentage)?.label ??
                          '—'}
                      </td>
                      <td>{markStatusLabel(row.status)}</td>
                    </tr>
                  ))}
                  {gradebook.rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-3 text-sm text-gray-500">
                        No students are enrolled in this class.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {gate?.allowed && (
                <div className="mt-3">
                  <Button onClick={saveMarks} disabled={busy}>
                    Save marks
                  </Button>
                </div>
              )}
            </Card>
          )}

          {canCorrect && (
            <Card>
              <h2 className="text-lg font-semibold">Correct a published mark</h2>
              <p className="text-xs text-gray-600">
                A published or locked mark can only change through the correction workflow: the
                correction is appended to the ledger with your reason and the mark becomes
                &ldquo;rechecked&rdquo;.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="text-sm">
                  Mark id
                  <input
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={correctMarkId}
                    onChange={(e) => setCorrectMarkId(e.target.value)}
                  />
                </label>
                <label className="text-sm">
                  Corrected mark
                  <input
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={correctValue}
                    onChange={(e) => setCorrectValue(e.target.value)}
                  />
                </label>
                <label className="text-sm">
                  Reason
                  <input
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={correctReason}
                    onChange={(e) => setCorrectReason(e.target.value)}
                  />
                </label>
              </div>
              <div className="mt-3">
                <Button onClick={submitCorrection} disabled={busy}>
                  Record correction
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === 'scales' && (
        <div className="mt-4 space-y-4">
          {canManage && (
            <Card>
              <h2 className="text-lg font-semibold">New grading scale version</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  Code
                  <input
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={scaleCode}
                    onChange={(e) => setScaleCode(e.target.value)}
                  />
                </label>
                <label className="text-sm">
                  Name
                  <input
                    className="mt-1 w-full rounded border px-2 py-1"
                    value={scaleName}
                    onChange={(e) => setScaleName(e.target.value)}
                  />
                </label>
              </div>
              <div className="mt-3 space-y-1">
                {scaleBands.map((band, index) => (
                  <div key={index} className="grid grid-cols-4 gap-2 text-sm">
                    <input
                      className="rounded border px-2 py-1"
                      value={band.label}
                      onChange={(e) =>
                        setScaleBands((b) =>
                          b.map((x, i) => (i === index ? { ...x, label: e.target.value } : x)),
                        )
                      }
                    />
                    <input
                      className="rounded border px-2 py-1"
                      value={band.minPercent}
                      onChange={(e) =>
                        setScaleBands((b) =>
                          b.map((x, i) =>
                            i === index ? { ...x, minPercent: Number(e.target.value) } : x,
                          ),
                        )
                      }
                    />
                    <input
                      className="rounded border px-2 py-1"
                      value={band.maxPercent}
                      onChange={(e) =>
                        setScaleBands((b) =>
                          b.map((x, i) =>
                            i === index ? { ...x, maxPercent: Number(e.target.value) } : x,
                          ),
                        )
                      }
                    />
                    <input
                      className="rounded border px-2 py-1"
                      value={band.gradePoint}
                      onChange={(e) =>
                        setScaleBands((b) =>
                          b.map((x, i) => (i === index ? { ...x, gradePoint: Number(e.target.value) } : x)),
                        )
                      }
                    />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Bands are half-open [min, max) and must tile 0–100. The last band ends at 100.
              </p>
              <div className="mt-3">
                <Button onClick={createScale} disabled={busy}>
                  Create version
                </Button>
              </div>
            </Card>
          )}

          <Card>
            <h2 className="text-lg font-semibold">Scales</h2>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs uppercase text-gray-500">
                  <th className="py-2">Code</th>
                  <th>Name</th>
                  <th>Version</th>
                  <th>Active</th>
                  <th>Bands</th>
                  {canManage && <th />}
                </tr>
              </thead>
              <tbody>
                {scales.map((s) => (
                  <tr key={s.id} className="border-b">
                    <td className="py-2">{s.code}</td>
                    <td>{s.name}</td>
                    <td>v{s.version}</td>
                    <td>{s.isActive ? 'yes' : 'no'}</td>
                    <td className="text-xs">
                      {s.bands
                        .map(
                          (b) =>
                            `${b.label} ${b.minPercent}-${b.maxPercent === 100 ? '100' : b.maxPercent} (${b.gradePoint})`,
                        )
                        .join(' · ')}
                    </td>
                    {canManage && (
                      <td>
                        {!s.isActive && (
                          <button
                            type="button"
                            className="text-xs text-blue-600 underline"
                            disabled={busy}
                            onClick={() => void activateScale(s.id)}
                          >
                            activate
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {scales.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-3 text-sm text-gray-500">
                      No grading scales yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {tab === 'report-cards' && (
        <Card>
          <h2 className="text-lg font-semibold">Report cards</h2>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-xs uppercase text-gray-500">
                <th className="py-2">Student</th>
                <th>Total</th>
                <th>GPA</th>
                <th>Subjects</th>
                <th>Version</th>
                <th>Status</th>
                <th>Artifact</th>
              </tr>
            </thead>
            <tbody>
              {reportCards.map((card) => (
                <tr key={card.id} className="border-b">
                  <td className="py-2 font-mono text-xs">{card.studentId.slice(0, 8)}</td>
                  <td>{formatTotal(card.totalObtained, card.totalPossible)}</td>
                  <td>{formatGpa(card.gpa)}</td>
                  <td>{card.subjectCount}</td>
                  <td>v{card.version}</td>
                  <td>{reportCardStatusLabel(card.status)}</td>
                  <td className="text-xs">{card.fileId ? 'PDF ready' : 'pending'}</td>
                </tr>
              ))}
              {reportCards.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-3 text-sm text-gray-500">
                    No report cards yet. Publish an exam to generate them.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </main>
  );
}

interface ExamListResponseShape {
  items: Exam[];
  total: number;
}
