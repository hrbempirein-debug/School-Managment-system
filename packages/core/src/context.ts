export type Scope = 'platform' | 'tenant';

export interface RequestContext {
  requestId: string;
  userId: string;
  scope: Scope;
  tenantId: string | null;
  membershipId: string | null;
  campusId: string | null;
  roleIds: string[];
  permissions: ReadonlySet<string>;
  platformAccess: boolean;
  isSystem: boolean;
}

export type NewContext = Omit<
  RequestContext,
  'requestId' | 'platformAccess' | 'isSystem' | 'campusId'
> &
  Partial<Pick<RequestContext, 'campusId'>>;

export function emptyTenantContext(requestId: string): RequestContext {
  return {
    requestId,
    userId: 'system',
    scope: 'tenant',
    tenantId: null,
    membershipId: null,
    campusId: null,
    roleIds: [],
    permissions: new Set(),
    platformAccess: false,
    isSystem: true,
  };
}

export interface SessionRecord {
  userId: string;
  activeTenantId: string | null;
  csrf: string;
  createdAt: number;
  expiresAt: number;
  version: number;
}