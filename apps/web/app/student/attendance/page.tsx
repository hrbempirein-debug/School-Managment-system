import type {
  AttendanceContextResponse,
  AttendancePortalResponse,
  LeaveTypeListResponse,
  MeResponse,
} from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { AttendancePortalView } from '../../attendance/attendance-portal-view';

export const dynamic = 'force-dynamic';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function StudentAttendancePage() {
  let me: MeResponse | null = null;
  let context: AttendanceContextResponse['context'] | null = null;
  let portal: AttendancePortalResponse = { context: { role: 'none', students: [] }, views: [] };
  let leaveTypes: LeaveTypeListResponse = { items: [], total: 0 };
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('attendance.read')) {
      context = (await serverFetch<AttendanceContextResponse>('/api/v1/me/attendance-context')).context;
      if (context.role === 'student') {
        portal = await serverFetch<AttendancePortalResponse>('/api/v1/me/attendance');
      }
      leaveTypes = await serverFetch<LeaveTypeListResponse>('/api/v1/leave-types?status=active');
    }
  } catch {
    // fall through to unauthenticated UI
  }

  if (!me || !context) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-red-600">Please sign in first.</p>
      </main>
    );
  }

  if (context.role !== 'student') {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Student attendance</h1>
        <p className="mt-3 text-sm text-gray-600">
          Your account is a <span className="font-medium">{context.role}</span> in this school — use the{' '}
          <a className="text-blue-600 underline" href="/parent/attendance">
            parent attendance portal
          </a>{' '}
          for the students you are a guardian of.
        </p>
      </main>
    );
  }

  return (
    <AttendancePortalView
      heading="My attendance"
      expectedRole="student"
      today={todayIso()}
      initialViews={portal.views}
      leaveTypes={leaveTypes.items}
      canRequestLeave={me.permissions.includes('attendance.request_leave')}
    />
  );
}
