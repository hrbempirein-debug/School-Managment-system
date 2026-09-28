import type {
  HomeworkContext,
  HomeworkContextClass,
  HomeworkDetail,
  HomeworkListResponse,
} from '@sms/contracts';

/**
 * Read-only homework portal helpers (Phase 4.4). The parent and student portals
 * are self-scoped views: they never call classes/subjects endpoints (portal roles
 * lack those permissions) and rely exclusively on /api/v1/me/homework-context +
 * the existing per-class homework list. Everything here is a pure/closed function
 * so the portal logic stays unit-testable without a browser or API.
 */

export type PortalRole = HomeworkContext['role'];

export function isPortalRole(role: PortalRole): boolean {
  return role === 'parent' || role === 'student';
}

/** Honest messaging for each portal state — never a fake success screen. */
export function portalEmptyMessage(role: PortalRole): string {
  if (role === 'student') {
    return 'No classes are linked to this student account yet. Ask the school to link your portal account, or you may not be enrolled yet.';
  }
  if (role === 'parent') {
    return 'You are not linked to any enrolled children yet. Parents can see homework for students they are a guardian of.';
  }
  return 'This account does not have homework access in this school.';
}

export interface PortalClassView {
  class: HomeworkContextClass;
  homework: HomeworkDetail[];
  total: number;
}

/**
 * Stable portal ordering: soonest due first, then most recently created, then id.
 * Null due dates sort LAST (open-ended assignments are less time-urgent).
 */
export function sortPortalHomework(items: readonly HomeworkDetail[]): HomeworkDetail[] {
  return [...items].sort((a, b) => {
    const aKey = a.dueAt ?? '9999-12-31T00:00:00.000Z';
    const bKey = b.dueAt ?? '9999-12-31T00:00:00.000Z';
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}

/** Collapse whitespace and truncate long bodies for a card preview. */
export function homeworkBodyPreview(body: string | null, max = 160): string | null {
  if (!body) return null;
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

/**
 * Load every class in a portal context (server-side, sequentially per class) and
 * build the ordered view structure. The fetchList is injected so callers decide
 * the transport (serverFetch) and tests can stub it.
 */
export async function loadPortalViews(
  classes: readonly HomeworkContextClass[],
  fetchList: (classId: string) => Promise<HomeworkListResponse>,
): Promise<PortalClassView[]> {
  const views: PortalClassView[] = [];
  for (const klass of classes) {
    const res = await fetchList(klass.id);
    views.push({
      class: klass,
      homework: sortPortalHomework(res.items),
      total: res.total,
    });
  }
  return views;
}