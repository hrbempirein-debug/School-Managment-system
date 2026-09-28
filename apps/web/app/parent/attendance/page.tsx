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

export default async function ParentAttendancePage() {
  let me: MeResponse | null = null;
  let context: AttendanceContextResponse['context'] | null = null;
  let portal: AttendancePortalResponse = { context: { role: 'none', students: [] }, views: [] };
  let leaveTypes: LeaveTypeListResponse = { items: [], total: 0 };
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('attendance.read')) {
      context = (await serverFetch<AttendanceContextResponse>('/api/v1/me/attendance-context')).context;
      if (context.role === 'parent') {
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

  // A non-parent portal account gets an honest pointer instead of a student's
  // own data rendered under a parent heading.
  if (context.role !== 'parent') {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Parent attendance</h1>
        <p className="mt-3 text-sm text-gray-600">
          Your account is a <span className="font-medium">{context.role}</span> in this school — use the{' '}
          <a className="text-blue-600 underline" href="/student/attendance">
            student attendance portal
          </a>{' '}
          for your own record.
        </p>
      </main>
    );
  }

  return (
    <AttendancePortalView
      heading="Parent attendance"
      expectedRole="parent"
      today={todayIso()}
      initialViews={portal.views}
      leaveTypes={leaveTypes.items}
      canRequestLeave={me.permissions.includes('attendance.request_leave')}
    />
  );
}
