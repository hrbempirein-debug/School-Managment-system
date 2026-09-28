import type { MeResponse, Student, StudentResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { StudentDetail } from './student-detail';

export const dynamic = 'force-dynamic';

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let me: MeResponse | null = null;
  let student: Student | null = null;
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('students.read')) {
      const res = await serverFetch<StudentResponse>(`/api/v1/students/${encodeURIComponent(id)}`);
      student = res.student;
    }
  } catch {
    // fall through to unauthenticated / permission / not-found UI
  }

  if (!me) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-red-600">Please sign in first.</p>
      </main>
    );
  }

  if (!student) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-red-600">Student not found or you do not have access to it.</p>
      </main>
    );
  }

  return (
    <StudentDetail
      studentId={id}
      initial={student}
      canRead={me.permissions.includes('students.read')}
      canUpdate={me.permissions.includes('students.update')}
      canDelete={me.permissions.includes('students.delete')}
      canManageEnrollment={me.permissions.includes('enrollment.manage')}
      canReadEnrollment={me.permissions.includes('enrollment.read')}
      canReadPlacement={me.permissions.includes('placement.read')}
      canManagePlacement={me.permissions.includes('placement.manage')}
      canReadGuardians={me.permissions.includes('guardians.read')}
      canCreateGuardian={me.permissions.includes('guardians.create')}
      canReadDocuments={me.permissions.includes('student.documents.read')}
      canUploadDocuments={me.permissions.includes('student.documents.create')}
      canUpdateDocuments={me.permissions.includes('student.documents.update')}
      canDeleteDocuments={me.permissions.includes('student.documents.delete')}
      canReadAdmissions={me.permissions.includes('admission.read')}
      canReviewAdmissions={me.permissions.includes('admission.review')}
      canCreateAdmission={me.permissions.includes('admission.create')}
      canReadYears={me.permissions.includes('academic.years.read')}
    />
  );
}