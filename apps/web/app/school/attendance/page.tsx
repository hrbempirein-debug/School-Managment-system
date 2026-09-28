import type {
  AcdClass,
  ClassListResponse,
  LeaveType,
  LeaveTypeListResponse,
  MeResponse,
  TeacherDirectoryEntry,
  TeacherDirectoryResponse,
} from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { AttendanceManager } from './attendance-manager';

export const dynamic = 'force-dynamic';

/**
 * Phase 5 attendance module. Every read is permission-gated before it is
 * fetched, so a teacher without classes.read never triggers a catalog request
 * and the client never receives data it may not see.
 */
export default async function SchoolAttendancePage() {
  let me: MeResponse | null = null;
  let classes: AcdClass[] = [];
  let teachers: TeacherDirectoryEntry[] = [];
  let leaveTypes: LeaveType[] = [];
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('attendance.read')) {
      if (me.permissions.includes('classes.read')) {
        classes = (await serverFetch<ClassListResponse>('/api/v1/classes?limit=100&offset=0')).items;
      }
      leaveTypes = (
        await serverFetch<LeaveTypeListResponse>('/api/v1/leave-types?limit=100&offset=0')
      ).items;
    }
    // The staff clock needs a list of staff to mark; only owners/admins reach it.
    if (
      me.permissions.includes('attendance.read') &&
      me.permissions.includes('attendance.mark') &&
      me.permissions.includes('students.read')
    ) {
      teachers = (await serverFetch<TeacherDirectoryResponse>('/api/v1/teachers')).items;
    }
  } catch {
    // fall through to unauthenticated UI
  }

  if (!me) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-red-600">Please sign in first.</p>
      </main>
    );
  }

  const canRead = me.permissions.includes('attendance.read');
  if (!canRead) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Attendance</h1>
        <p className="mt-3 text-sm text-amber-600">
          Your role cannot view attendance. Attendance requires the attendance.read permission.
        </p>
      </main>
    );
  }

  return (
    <AttendanceManager
      initialClasses={classes}
      initialLeaveTypes={leaveTypes}
      teachers={teachers}
      canListClasses={me.permissions.includes('classes.read')}
      canMark={me.permissions.includes('attendance.mark')}
      canApproveLeave={me.permissions.includes('attendance.approve_leave')}
      canManageLeaveTypes={me.permissions.includes('attendance.mark')}
    />
  );
}
