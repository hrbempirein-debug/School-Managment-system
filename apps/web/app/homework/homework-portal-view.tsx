import type { HomeworkContext } from '@sms/contracts';
import { Card } from '@sms/ui';
import { formatDateTime } from '@/lib/format';
import { homeworkBodyPreview, isPortalRole, portalEmptyMessage, type PortalClassView } from '@/lib/homework-portal';

/**
 * Read-only portal renderer (Phase 4.4). Shared by the /parent/homework and
 * /student/homework pages. It NEVER links to staff endpoints: the class list and
 * homework come entirely from the self-scoped context + per-class homework lists,
 * so a portal role with only homework.read sees exactly what the API allows.
 */
export function HomeworkPortalView({
  heading,
  expectedRole,
  context,
  views,
}: {
  heading: string;
  expectedRole: 'parent' | 'student';
  context: HomeworkContext;
  views: PortalClassView[];
}) {
  if (!isPortalRole(context.role)) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-gray-600">
          This is the {heading.toLowerCase()} view. Your account is a{' '}
          <span className="font-medium">“{context.role}”</span> in this school — switch to the matching portal.
        </p>
      </main>
    );
  }
  if (context.role !== expectedRole) {
    const other = context.role === 'student' ? '/student/homework' : '/parent/homework';
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-gray-600">
          This is the {heading.toLowerCase()} portal. Your account is a <span className="font-medium">{context.role}</span>{' '}
          here — use the <a className="text-blue-600 underline" href={other}>{context.role} portal</a>.
        </p>
      </main>
    );
  }
  if (views.length === 0) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">{heading}</h1>
        <Card className="mt-6 p-4">
          <p className="text-sm text-gray-600">{portalEmptyMessage(context.role)}</p>
        </Card>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">{heading}</h1>
      <p className="mt-1 text-sm text-gray-600">
        Read-only view of homework for your {context.role === 'student' ? 'own classes' : 'children’s classes'}.
      </p>
      {views.map((view) => (
        <Card key={view.class.id} className="mt-6 p-4">
          <p className="font-medium">
            {view.class.code}
            {view.class.name ? ` — ${view.class.name}` : ''}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {view.total} assignment{view.total === 1 ? '' : 's'}
          </p>
          {view.homework.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No homework has been assigned to this class yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-gray-100">
              {view.homework.map((hw) => (
                <li key={hw.id} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-medium">{hw.title}</p>
                    <p className="shrink-0 text-xs text-gray-500">due {formatDateTime(hw.dueAt)}</p>
                  </div>
                  {homeworkBodyPreview(hw.body) ? (
                    <p className="mt-1 text-sm text-gray-600">{homeworkBodyPreview(hw.body)}</p>
                  ) : null}
                  {hw.attachments.length > 0 && (
                    <p className="mt-1 text-xs text-gray-400">{hw.attachments.length} attachment(s)</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </main>
  );
}