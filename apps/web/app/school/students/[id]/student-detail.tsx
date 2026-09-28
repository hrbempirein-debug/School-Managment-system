'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Student } from '@sms/contracts';
import { genderLabel, studentStatusLabel } from '@/lib/students';
import { formatIsoDate } from '@/lib/format';
import { OverviewTab } from './tabs/overview-tab';
import { GuardiansTab } from './tabs/guardians-tab';
import { EnrollmentTab } from './tabs/enrollment-tab';
import { DocumentsTab } from './tabs/documents-tab';
import { AdmissionsTab } from './tabs/admissions-tab';

export interface DetailPermissions {
  canRead: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canManageEnrollment: boolean;
  canReadEnrollment: boolean;
  canReadPlacement: boolean;
  canManagePlacement: boolean;
  canReadGuardians: boolean;
  canCreateGuardian: boolean;
  canReadDocuments: boolean;
  canUploadDocuments: boolean;
  canUpdateDocuments: boolean;
  canDeleteDocuments: boolean;
  canReadAdmissions: boolean;
  canReviewAdmissions: boolean;
  canCreateAdmission: boolean;
  canReadYears: boolean;
}

type TabKey = 'overview' | 'guardians' | 'enrollment' | 'documents' | 'admissions';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'guardians', label: 'Guardians' },
  { key: 'enrollment', label: 'Enrollment' },
  { key: 'documents', label: 'Documents' },
  { key: 'admissions', label: 'Admissions' },
];

interface StudentDetailProps extends DetailPermissions {
  studentId: string;
  initial: Student;
}

export function StudentDetail(props: StudentDetailProps) {
  const { studentId, initial, canRead } = props;
  const [student, setStudent] = useState<Student>(initial);
  const [tab, setTab] = useState<TabKey>('overview');

  if (!canRead) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <Link href="/school/students" className="text-sm text-blue-600 hover:underline">
          ← Students
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Student</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view students.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/school/students" className="text-sm text-blue-600 hover:underline">
        ← Students
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">
        {student.firstName} {student.lastName}
      </h1>
      <p className="mt-1 text-sm text-gray-600">
        {student.studentNo} · {studentStatusLabel(student.status)} · {genderLabel(student.gender)} · born{' '}
        {formatIsoDate(student.dateOfBirth)}
      </p>

      <nav className="mt-6 flex gap-2 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-3 py-2 text-sm ${
              tab === t.key
                ? 'border-blue-600 font-medium text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-6">
        {tab === 'overview' && <OverviewTab student={student} onStudentChange={setStudent} permissions={props} />}
        {tab === 'guardians' && <GuardiansTab studentId={studentId} permissions={props} />}
        {tab === 'enrollment' && <EnrollmentTab studentId={studentId} permissions={props} />}
        {tab === 'documents' && <DocumentsTab studentId={studentId} permissions={props} />}
        {tab === 'admissions' && <AdmissionsTab studentId={studentId} student={student} permissions={props} />}
      </div>
    </main>
  );
}