import type { SessionUser } from '@sms/auth';
import type { MembershipSummary } from '@sms/tenancy';
import type { MeResponse } from '@sms/contracts';

export function buildMeResponse(
  user: SessionUser,
  memberships: MembershipSummary[],
  activeTenantId: string | null,
): MeResponse {
  const explicit = activeTenantId
    ? memberships.find((m) => m.tenantId === activeTenantId && m.status === 'active')
    : undefined;
  const solo = !explicit ? memberships.filter((m) => m.status === 'active') : undefined;
  const active = explicit ?? (solo && solo.length === 1 ? solo[0] : undefined);

  return {
    user: { userId: user.userId, email: user.email, fullName: user.fullName },
    scope: active ? 'tenant' : 'platform',
    activeTenant: active
      ? {
          id: active.tenantId,
          slug: active.tenantSlug,
          name: active.tenantName,
          status: active.tenantStatus,
        }
      : null,
    permissions: [...(active?.permissions ?? [])].sort(),
  };
}