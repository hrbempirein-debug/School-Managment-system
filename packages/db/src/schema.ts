import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  boolean,
  integer,
  uuid,
  date,
  check,
  primaryKey,
  foreignKey,
  bigint,
  smallint,
  time,
  numeric,
  unique,
  char,
} from 'drizzle-orm/pg-core';

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('tenants_slug_uq').on(t.slug),
    check('tenants_status_ck', sql`${t.status} IN ('trial','active','past_due','suspended','cancelled','deleting')`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    status: text('status').notNull().default('active'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

export const userProfiles = pgTable(
  'user_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    locale: text('locale').notNull().default('en'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('password'),
    providerKey: text('provider_key').notNull(),
    passwordHash: text('password_hash'),
    secretEnc: text('secret_enc'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_key_uq').on(t.provider, t.providerKey),
    index('auth_identities_user_idx').on(t.userId),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    activeTenantId: uuid('active_tenant_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('auth_sessions_user_idx').on(t.userId),
    index('auth_sessions_expires_idx').on(t.expiresAt),
  ],
);

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenType: text('token_type').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_tokens_user_idx').on(t.userId)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('active'),
    campusId: uuid('campus_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('memberships_user_tenant_uq').on(t.userId, t.tenantId),
    index('memberships_tenant_idx').on(t.tenantId, t.status),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id'),
    scope: text('scope').notNull().default('tenant'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('roles_platform_code_uq')
      .on(t.code)
      .where(sql`${t.scope} = 'platform'`),
    uniqueIndex('roles_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.tenantId} IS NOT NULL`),
    index('roles_tenant_idx').on(t.tenantId),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permission], name: 'role_permissions_pk' }),
    index('role_permissions_role_idx').on(t.roleId),
  ],
);

export const membershipRoles = pgTable(
  'membership_roles',
  {
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('membership_roles_membership_idx').on(t.membershipId),
    index('membership_roles_role_idx').on(t.roleId),
  ],
);

export const platformRoleAssignments = pgTable(
  'platform_role_assignments',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('platform_role_assignments_user_idx').on(t.userId),
    index('platform_role_assignments_role_idx').on(t.roleId),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    scope: text('scope').notNull().default('tenant'),
    tenantId: uuid('tenant_id'),
    actorUserId: uuid('actor_user_id'),
    actorType: text('actor_type').notNull().default('user'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_tenant_time_idx').on(t.tenantId, t.occurredAt),
    index('audit_logs_resource_idx').on(t.resourceType, t.resourceId),
    index('audit_logs_action_idx').on(t.action),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id'),
    eventType: text('event_type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    correlationId: uuid('correlation_id'),
    causationId: uuid('causation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    index('outbox_unprocessed_idx').on(t.createdAt).where(sql`${t.processedAt} IS NULL`),
    index('outbox_created_idx').on(t.createdAt),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id'),
    key: text('key').notNull(),
    requestHash: text('request_hash'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_tenant_key_uq')
      .on(t.tenantId, t.key)
      .where(sql`${t.tenantId} IS NOT NULL`),
    uniqueIndex('idempotency_keys_global_key_uq')
      .on(t.key)
      .where(sql`${t.tenantId} IS NULL`),
  ],
);

export const campuses = pgTable(
  'campuses',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    city: text('city'),
    country: text('country'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('campuses_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('campuses_tenant_status_idx').on(t.tenantId, t.status).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('campuses_tenant_id_uq').on(t.tenantId, t.id),
    check('campuses_status_ck', sql`${t.status} IN ('active','inactive')`),
  ],
);

export const academicYears = pgTable(
  'academic_years',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: text('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('academic_years_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('academic_years_tenant_status_idx').on(t.tenantId, t.status).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('academic_years_tenant_id_uq').on(t.tenantId, t.id),
    check('academic_years_dates_ck', sql`${t.startsOn} < ${t.endsOn}`),
    check('academic_years_status_ck', sql`${t.status} IN ('draft','active','closed')`),
  ],
);

export const academicTerms = pgTable(
  'academic_terms',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sequence: integer('sequence').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: text('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('academic_terms_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('academic_terms_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('academic_terms_year_seq_uq')
      .on(t.academicYearId, t.sequence)
      .where(sql`${t.deletedAt} IS NULL`),
    index('academic_terms_year_status_idx').on(t.academicYearId, t.status).where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'academic_terms_parent_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }).onDelete('cascade'),
    check('academic_terms_dates_ck', sql`${t.startsOn} < ${t.endsOn}`),
    check('academic_terms_sequence_ck', sql`${t.sequence} >= 1`),
    check('academic_terms_status_ck', sql`${t.status} IN ('draft','open','closed')`),
  ],
);

export const holidays = pgTable(
  'holidays',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    campusId: uuid('campus_id'),
    name: text('name').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('holidays_tenant_id_uq').on(t.tenantId, t.id),
    index('holidays_tenant_range_idx').on(t.tenantId, t.startsOn, t.endsOn).where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'holidays_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
    check('holidays_dates_ck', sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);

export const calendars = pgTable(
  'calendars',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull().default('general'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('calendars_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('calendars_tenant_status_idx').on(t.tenantId, t.status).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('calendars_tenant_id_uq').on(t.tenantId, t.id),
    check('calendars_status_ck', sql`${t.status} IN ('active','archived')`),
    check('calendars_type_ck', sql`${t.type} IN ('general','academic')`),
  ],
);

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    calendarId: uuid('calendar_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    allDay: boolean('all_day').notNull().default(false),
    location: text('location'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('calendar_events_tenant_id_uq').on(t.tenantId, t.id),
    index('calendar_events_calendar_range_idx').on(t.calendarId, t.startsAt, t.endsAt).where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'calendar_events_calendar_fk',
      columns: [t.tenantId, t.calendarId],
      foreignColumns: [calendars.tenantId, calendars.id],
    }).onDelete('cascade'),
    check('calendar_events_times_ck', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('departments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('departments_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('departments_tenant_status_idx').on(t.tenantId, t.status).where(sql`${t.deletedAt} IS NULL`),
    check('departments_status_ck', sql`${t.status} IN ('active','inactive')`),
  ],
);

export const schoolSettings = pgTable(
  'school_settings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    schoolName: text('school_name').notNull(),
    schoolCode: text('school_code'),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    timezone: text('timezone').notNull().default('UTC'),
    locale: text('locale').notNull().default('en'),
    brandingColor: text('branding_color'),
    logoPath: text('logo_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('school_settings_tenant_uq').on(t.tenantId),
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('school_settings_tenant_id_uq').on(t.tenantId, t.id),
  ],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull().unique(),
    originalName: text('original_name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    contentHash: text('content_hash'),
    visibility: text('visibility').notNull().default('private'),
    ownerType: text('owner_type'),
    ownerId: uuid('owner_id'),
    scanStatus: text('scan_status').notNull().default('pending'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('files_tenant_id_uq').on(t.tenantId, t.id),
    index('files_owner_idx').on(t.tenantId, t.ownerType, t.ownerId).where(sql`${t.deletedAt} IS NULL`),
    check('files_visibility_ck', sql`${t.visibility} IN ('private','tenant_portal')`),
    check('files_scan_status_ck', sql`${t.scanStatus} IN ('pending','clean','blocked')`),
    check('files_size_ck', sql`${t.sizeBytes} >= 0`),
  ],
);

export const gradeLevels = pgTable(
  'grade_levels',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('grade_levels_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('grade_levels_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('grade_levels_tenant_scope_idx')
      .on(t.tenantId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    check('grade_levels_status_ck', sql`${t.status} IN ('active','inactive')`),
  ],
);

export const subjects = pgTable(
  'subjects',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('subjects_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('subjects_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('subjects_tenant_scope_idx')
      .on(t.tenantId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    check('subjects_status_ck', sql`${t.status} IN ('active','inactive')`),
  ],
);

export const acdClasses = pgTable(
  'acd_classes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    campusId: uuid('campus_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    gradeLevelId: uuid('grade_level_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('acd_classes_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('acd_classes_tenant_campus_id_uq').on(t.tenantId, t.campusId, t.id),
    uniqueIndex('acd_classes_tenant_year_id_uq').on(t.tenantId, t.academicYearId, t.id),
    uniqueIndex('acd_classes_tenant_grade_id_uq')
      .on(t.tenantId, t.gradeLevelId, t.id)
      .where(sql`${t.gradeLevelId} IS NOT NULL`),
    uniqueIndex('acd_classes_tenant_code_uq')
      .on(t.tenantId, t.campusId, t.academicYearId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('acd_classes_tenant_scope_idx')
      .on(t.tenantId, t.campusId, t.academicYearId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('acd_classes_grade_level_idx')
      .on(t.tenantId, t.gradeLevelId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.gradeLevelId} IS NOT NULL`),
    foreignKey({
      name: 'acd_classes_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
    foreignKey({
      name: 'acd_classes_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'acd_classes_grade_level_fk',
      columns: [t.tenantId, t.gradeLevelId],
      foreignColumns: [gradeLevels.tenantId, gradeLevels.id],
    }),
    check('acd_classes_status_ck', sql`${t.status} IN ('active','inactive')`),
  ],
);

export const sections = pgTable(
  'sections',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    classId: uuid('class_id').notNull(),
    campusId: uuid('campus_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    code: text('code').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sections_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('sections_tenant_class_code_uq')
      .on(t.tenantId, t.classId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('sections_class_active_idx')
      .on(t.tenantId, t.classId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'sections_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.id],
    }),
    foreignKey({
      name: 'sections_class_campus_fk',
      columns: [t.tenantId, t.campusId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.campusId, acdClasses.id],
    }),
    foreignKey({
      name: 'sections_class_year_fk',
      columns: [t.tenantId, t.academicYearId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.academicYearId, acdClasses.id],
    }),
    foreignKey({
      name: 'sections_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
    check('sections_status_ck', sql`${t.status} IN ('active','inactive')`),
  ],
);

export const classSubjects = pgTable(
  'class_subjects',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    classId: uuid('class_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    campusId: uuid('campus_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('class_subjects_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('class_subjects_class_subject_live_uq')
      .on(t.tenantId, t.classId, t.subjectId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('class_subjects_class_idx')
      .on(t.tenantId, t.classId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('class_subjects_subject_idx')
      .on(t.tenantId, t.subjectId)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'class_subjects_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.id],
    }),
    foreignKey({
      name: 'class_subjects_class_campus_fk',
      columns: [t.tenantId, t.campusId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.campusId, acdClasses.id],
    }),
    foreignKey({
      name: 'class_subjects_class_year_fk',
      columns: [t.tenantId, t.academicYearId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.academicYearId, acdClasses.id],
    }),
    foreignKey({
      name: 'class_subjects_subject_fk',
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    foreignKey({
      name: 'class_subjects_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
  ],
);

export const teacherAssignments = pgTable(
  'teacher_assignments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    classId: uuid('class_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    teacherUserId: uuid('teacher_user_id').notNull(),
    campusId: uuid('campus_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('teacher_assignments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('teacher_assignments_class_subject_live_uq')
      .on(t.tenantId, t.classId, t.subjectId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('teacher_assignments_class_subject_idx')
      .on(t.tenantId, t.classId, t.subjectId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('teacher_assignments_subject_idx')
      .on(t.tenantId, t.subjectId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('teacher_assignments_teacher_idx')
      .on(t.tenantId, t.teacherUserId)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'teacher_assignments_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.id],
    }),
    foreignKey({
      name: 'teacher_assignments_class_campus_fk',
      columns: [t.tenantId, t.campusId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.campusId, acdClasses.id],
    }),
    foreignKey({
      name: 'teacher_assignments_class_year_fk',
      columns: [t.tenantId, t.academicYearId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.academicYearId, acdClasses.id],
    }),
    foreignKey({
      name: 'teacher_assignments_subject_fk',
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    foreignKey({
      name: 'teacher_assignments_teacher_fk',
      columns: [t.tenantId, t.teacherUserId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    foreignKey({
      name: 'teacher_assignments_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
  ],
);

export const students = pgTable(
  'students',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    studentNo: text('student_no').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    dateOfBirth: date('date_of_birth'),
    gender: text('gender'),
    status: text('status').notNull().default('applicant'),
    primaryCampusId: uuid('primary_campus_id'),
    photoFileId: uuid('photo_file_id'),
    userId: uuid('user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('students_student_no_uq')
      .on(t.tenantId, t.studentNo)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('students_tenant_id_uq').on(t.tenantId, t.id),
    index('students_tenant_status_name_idx')
      .on(t.tenantId, t.status, t.lastName)
      .where(sql`${t.deletedAt} IS NULL`),
    index('students_name_trgm_idx').using('gin', sql`((${t.firstName} || ' ' || ${t.lastName}) gin_trgm_ops)`),
    foreignKey({
      name: 'students_photo_file_fk',
      columns: [t.tenantId, t.photoFileId],
      foreignColumns: [files.tenantId, files.id],
    }),
    foreignKey({
      name: 'students_primary_campus_fk',
      columns: [t.tenantId, t.primaryCampusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
    foreignKey({
      name: 'students_user_membership_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    uniqueIndex('students_tenant_user_uq')
      .on(t.tenantId, t.userId)
      .where(sql`${t.userId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    check('students_status_ck', sql`${t.status} IN ('applicant','active','transferred','graduated','alumni')`),
    check('students_gender_ck', sql`${t.gender} IN ('male','female','other')`),
  ],
);

export const guardians = pgTable(
  'guardians',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('guardians_tenant_id_uq').on(t.tenantId, t.id),
    index('guardians_tenant_name_idx').on(t.tenantId, t.lastName).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('guardians_tenant_user_uq')
      .on(t.tenantId, t.userId)
      .where(sql`${t.userId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

export const studentGuardians = pgTable(
  'student_guardians',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    studentId: uuid('student_id').notNull(),
    guardianId: uuid('guardian_id').notNull(),
    relation: text('relation').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    canPickup: boolean('can_pickup').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('student_guardians_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('student_guardians_relation_uq')
      .on(t.tenantId, t.studentId, t.guardianId, t.relation)
      .where(sql`${t.deletedAt} IS NULL`),
    index('student_guardians_student_idx')
      .on(t.tenantId, t.studentId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('student_guardians_guardian_idx')
      .on(t.tenantId, t.guardianId)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'student_guardians_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'student_guardians_guardian_fk',
      columns: [t.tenantId, t.guardianId],
      foreignColumns: [guardians.tenantId, guardians.id],
    }).onDelete('cascade'),
  ],
);

export const enrollments = pgTable(
  'enrollments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    studentId: uuid('student_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    classId: uuid('class_id'),
    sectionId: uuid('section_id'),
    rollNo: text('roll_no'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('enrollments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('enrollments_student_year_uq')
      .on(t.tenantId, t.studentId, t.academicYearId)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('enrollments_roll_no_uq')
      .on(t.tenantId, t.sectionId, t.rollNo)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} = 'active' AND ${t.sectionId} IS NOT NULL AND ${t.rollNo} IS NOT NULL`),
    index('enrollments_tenant_year_status_idx')
      .on(t.tenantId, t.academicYearId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'enrollments_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'enrollments_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'enrollments_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.id],
    }),
    foreignKey({
      name: 'enrollments_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [sections.tenantId, sections.id],
    }),
    check('enrollments_status_ck', sql`${t.status} IN ('active','withdrawn','completed')`),
  ],
);

export const studentDocuments = pgTable(
  'student_documents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    studentId: uuid('student_id').notNull(),
    documentType: text('document_type').notNull(),
    fileId: uuid('file_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('student_documents_tenant_id_uq').on(t.tenantId, t.id),
    index('student_documents_student_idx').on(t.tenantId, t.studentId).where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'student_documents_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'student_documents_file_fk',
      columns: [t.tenantId, t.fileId],
      foreignColumns: [files.tenantId, files.id],
    }),
  ],
);

export const admissionApplications = pgTable(
  'admission_applications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id'),
    status: text('status').notNull().default('draft'),
    snapshot: jsonb('snapshot').notNull().default(sql`'{}'::jsonb`),
    appliedOn: date('applied_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('admission_applications_tenant_id_uq').on(t.tenantId, t.id),
    index('admission_applications_tenant_status_idx').on(t.tenantId, t.status).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('admission_applications_student_uq')
      .on(t.tenantId, t.studentId)
      .where(sql`${t.studentId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'admission_applications_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    check('admission_applications_status_ck', sql`${t.status} IN ('draft','submitted','under_review','accepted','rejected','withdrawn')`),
  ],
);

export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    studentId: uuid('student_id').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull().default('in_progress'),
    fromSchoolName: text('from_school_name'),
    toSchoolName: text('to_school_name'),
    reason: text('reason'),
    transferredOn: date('transferred_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('transfers_tenant_id_uq').on(t.tenantId, t.id),
    index('transfers_tenant_student_idx').on(t.tenantId, t.studentId).where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'transfers_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    check('transfers_type_ck', sql`${t.type} IN ('in','out')`),
    check('transfers_status_ck', sql`${t.status} IN ('in_progress','completed','cancelled')`),
  ],
);

export const promotionBatches = pgTable(
  'promotion_batches',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    fromAcademicYearId: uuid('from_academic_year_id').notNull(),
    toAcademicYearId: uuid('to_academic_year_id').notNull(),
    status: text('status').notNull().default('draft'),
    createdBy: uuid('created_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('promotion_batches_tenant_id_uq').on(t.tenantId, t.id),
    index('promotion_batches_tenant_status_idx').on(t.tenantId, t.status).where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'promotion_batches_from_year_fk',
      columns: [t.tenantId, t.fromAcademicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'promotion_batches_to_year_fk',
      columns: [t.tenantId, t.toAcademicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    check('promotion_batches_status_ck', sql`${t.status} IN ('draft','in_progress','completed','cancelled')`),
    check('promotion_batches_distinct_years_ck', sql`${t.fromAcademicYearId} <> ${t.toAcademicYearId}`),
  ],
);

export const promotionItems = pgTable(
  'promotion_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    studentId: uuid('student_id').notNull(),
    fromAcademicYearId: uuid('from_academic_year_id').notNull(),
    toAcademicYearId: uuid('to_academic_year_id').notNull(),
    fromSectionId: uuid('from_section_id'),
    toSectionId: uuid('to_section_id'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // §6.3 R1: the (tenant_id, id) anchor, added by migration 0021 purely so every
    // composite FK into this table is legal BY DECLARATION rather than by accident of
    // `id` already being a primary key. It is an index only: no data migration, no
    // behavioural effect. finance-composite-fk.test.ts asserts its presence.
    uniqueIndex('promotion_items_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('promotion_items_batch_student_uq').on(t.tenantId, t.batchId, t.studentId),
    index('promotion_items_batch_idx').on(t.tenantId, t.batchId),
    foreignKey({
      name: 'promotion_items_batch_fk',
      columns: [t.tenantId, t.batchId],
      foreignColumns: [promotionBatches.tenantId, promotionBatches.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'promotion_items_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'promotion_items_from_year_fk',
      columns: [t.tenantId, t.fromAcademicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'promotion_items_to_year_fk',
      columns: [t.tenantId, t.toAcademicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    check('promotion_items_status_ck', sql`${t.status} IN ('pending','promoted','failed')`),
  ],
);

export const studentImports = pgTable(
  'student_imports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    campusId: uuid('campus_id'),
    filename: text('filename').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').notNull().default('submitted'),
    totalRows: integer('total_rows').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    conflictCount: integer('conflict_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    errorSummary: text('error_summary'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('student_imports_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('student_imports_storage_key_uq').on(t.storageKey),
    index('student_imports_tenant_status_idx').on(t.tenantId, t.status, t.createdAt, t.id),
    index('student_imports_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
    foreignKey({
      name: 'student_imports_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
    check('student_imports_status_ck', sql`${t.status} IN ('submitted','processing','completed','failed')`),
    check(
      'student_imports_counts_ck',
      sql`${t.totalRows} >= 0 AND ${t.createdCount} >= 0 AND ${t.duplicateCount} >= 0 AND ${t.conflictCount} >= 0 AND ${t.rejectedCount} >= 0`,
    ),
  ],
);

export const studentImportRows = pgTable(
  'student_import_rows',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    importId: uuid('import_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    status: text('status').notNull(),
    studentId: uuid('student_id'),
    field: text('field'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('student_import_rows_row_uq').on(t.tenantId, t.importId, t.rowNumber),
    index('student_import_rows_import_idx').on(t.tenantId, t.importId),
    foreignKey({
      name: 'student_import_rows_import_fk',
      columns: [t.tenantId, t.importId],
      foreignColumns: [studentImports.tenantId, studentImports.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'student_import_rows_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    check('student_import_rows_status_ck', sql`${t.status} IN ('created','duplicate','conflict','rejected')`),
    check(
      'student_import_rows_bucket_ck',
      sql`(${t.status} = 'created' AND ${t.studentId} IS NOT NULL) OR (${t.status} <> 'created' AND ${t.studentId} IS NULL)`,
    ),
  ],
);

// ================================================================== Phase 4.3 —
// periods, timetable_entries, homework, homework_attachments (0011)
// The DB-level integrity rules live in 0011_timetable_homework.sql triggers and
// constraints; this mapping mirrors the physical schema for typed access only.

export const periods = pgTable(
  'periods',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    campusId: uuid('campus_id'),
    name: text('name').notNull(),
    periodNo: integer('period_no').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('periods_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('periods_tenant_campus_no_uq')
      .on(
        t.tenantId,
        sql`COALESCE(${t.campusId}, '00000000-0000-0000-0000-000000000000')`,
        t.periodNo,
      )
      .where(sql`${t.deletedAt} IS NULL`),
    index('periods_tenant_scope_idx')
      .on(t.tenantId, t.campusId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'periods_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
  ],
);

export const timetableEntries = pgTable(
  'timetable_entries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    classId: uuid('class_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    teacherUserId: uuid('teacher_user_id').notNull(),
    periodId: uuid('period_id').notNull(),
    campusId: uuid('campus_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    weekday: smallint('weekday').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('timetable_entries_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('timetable_entries_section_slot_live_uq')
      .on(t.tenantId, t.sectionId, t.weekday, t.periodId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('timetable_entries_class_week_idx')
      .on(t.tenantId, t.classId, t.weekday)
      .where(sql`${t.deletedAt} IS NULL`),
    index('timetable_entries_teacher_week_idx')
      .on(t.tenantId, t.teacherUserId, t.weekday)
      .where(sql`${t.deletedAt} IS NULL`),
    index('timetable_entries_period_idx')
      .on(t.tenantId, t.periodId)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'timetable_entries_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.id],
    }),
    foreignKey({
      name: 'timetable_entries_class_campus_fk',
      columns: [t.tenantId, t.campusId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.campusId, acdClasses.id],
    }),
    foreignKey({
      name: 'timetable_entries_class_year_fk',
      columns: [t.tenantId, t.academicYearId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.academicYearId, acdClasses.id],
    }),
    foreignKey({
      name: 'timetable_entries_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [sections.tenantId, sections.id],
    }),
    foreignKey({
      name: 'timetable_entries_section_class_fk',
      columns: [t.tenantId, t.classId, t.sectionId],
      foreignColumns: [sections.tenantId, sections.classId, sections.id],
    }),
    foreignKey({
      name: 'timetable_entries_subject_fk',
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    foreignKey({
      name: 'timetable_entries_teacher_fk',
      columns: [t.tenantId, t.teacherUserId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    foreignKey({
      name: 'timetable_entries_period_fk',
      columns: [t.tenantId, t.periodId],
      foreignColumns: [periods.tenantId, periods.id],
    }),
    foreignKey({
      name: 'timetable_entries_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
  ],
);

export const homework = pgTable(
  'homework',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    classId: uuid('class_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    teacherUserId: uuid('teacher_user_id').notNull(),
    campusId: uuid('campus_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('homework_tenant_id_uq').on(t.tenantId, t.id),
    index('homework_class_due_idx')
      .on(t.tenantId, t.classId, t.dueAt)
      .where(sql`${t.deletedAt} IS NULL`),
    index('homework_teacher_idx')
      .on(t.tenantId, t.teacherUserId)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'homework_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.id],
    }),
    foreignKey({
      name: 'homework_class_campus_fk',
      columns: [t.tenantId, t.campusId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.campusId, acdClasses.id],
    }),
    foreignKey({
      name: 'homework_class_year_fk',
      columns: [t.tenantId, t.academicYearId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.academicYearId, acdClasses.id],
    }),
    foreignKey({
      name: 'homework_subject_fk',
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    foreignKey({
      name: 'homework_teacher_fk',
      columns: [t.tenantId, t.teacherUserId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    foreignKey({
      name: 'homework_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
  ],
);

export const homeworkAttachments = pgTable(
  'homework_attachments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    homeworkId: uuid('homework_id').notNull(),
    fileId: uuid('file_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('homework_attachments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('homework_attachments_hw_file_uq').on(t.tenantId, t.homeworkId, t.fileId),
    foreignKey({
      name: 'homework_attachments_homework_fk',
      columns: [t.tenantId, t.homeworkId],
      foreignColumns: [homework.tenantId, homework.id],
    }),
    foreignKey({
      name: 'homework_attachments_file_fk',
      columns: [t.tenantId, t.fileId],
      foreignColumns: [files.tenantId, files.id],
    }),
  ],
);

// leave_types, attendance_days, attendance_periods, staff_attendance, leave_requests (0014)
// Phase 5 attendance + student leave. The DB-level integrity rules live in
// 0014_attendance_leave.sql (triggers + constraints); this mapping mirrors the
// physical schema for typed access only.
//
// `staff_attendance.userId` is anchored on the tenant MEMBERSHIP, not a Phase 10
// `hr_employees` row: `employees` does not exist yet and creating it would pull
// Phase 10 forward. Membership is the same identity pattern Phase 4.2 uses for
// teachers, and the composite FK makes a cross-tenant reference impossible.

export const leaveTypes = pgTable(
  'leave_types',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('leave_types_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('leave_types_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('leave_types_tenant_status_idx')
      .on(t.tenantId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    check('leave_types_status_ck', sql`${t.status} IN ('active','inactive')`),
  ],
);

export const attendanceDays = pgTable(
  'attendance_days',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    studentId: uuid('student_id').notNull(),
    campusId: uuid('campus_id'),
    attendanceDate: date('attendance_date').notNull(),
    status: text('status').notNull(),
    source: text('source').notNull().default('manual'),
    markedBy: uuid('marked_by').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('attendance_days_tenant_id_uq').on(t.tenantId, t.id),
    // Idempotency anchor (DB-enforced, not an application convention).
    uniqueIndex('attendance_days_tenant_student_date_uq').on(
      t.tenantId,
      t.studentId,
      t.attendanceDate,
    ),
    index('attendance_days_tenant_date_idx')
      .on(t.tenantId, t.attendanceDate)
      .where(sql`${t.deletedAt} IS NULL`),
    index('attendance_days_tenant_student_idx')
      .on(t.tenantId, t.studentId, t.attendanceDate)
      .where(sql`${t.deletedAt} IS NULL`),
    index('attendance_days_tenant_status_idx')
      .on(t.tenantId, t.attendanceDate, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('attendance_days_campus_date_idx')
      .on(t.tenantId, t.campusId, t.attendanceDate)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'attendance_days_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'attendance_days_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
    foreignKey({
      name: 'attendance_days_marker_fk',
      columns: [t.tenantId, t.markedBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    check(
      'attendance_days_status_ck',
      sql`${t.status} IN ('present','absent','late','excused')`,
    ),
    check('attendance_days_source_ck', sql`${t.source} IN ('manual','period')`),
  ],
);

export const attendancePeriods = pgTable(
  'attendance_periods',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    studentId: uuid('student_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    periodId: uuid('period_id').notNull(),
    attendanceDate: date('attendance_date').notNull(),
    status: text('status').notNull(),
    markedBy: uuid('marked_by').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('attendance_periods_tenant_id_uq').on(t.tenantId, t.id),
    // Idempotency anchor: one mark per (student, date, period).
    uniqueIndex('attendance_periods_tenant_student_date_period_uq').on(
      t.tenantId,
      t.studentId,
      t.attendanceDate,
      t.periodId,
    ),
    index('attendance_periods_tenant_date_idx')
      .on(t.tenantId, t.attendanceDate)
      .where(sql`${t.deletedAt} IS NULL`),
    index('attendance_periods_section_date_idx')
      .on(t.tenantId, t.sectionId, t.attendanceDate, t.periodId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('attendance_periods_student_date_idx')
      .on(t.tenantId, t.studentId, t.attendanceDate)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'attendance_periods_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'attendance_periods_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [sections.tenantId, sections.id],
    }),
    foreignKey({
      name: 'attendance_periods_period_fk',
      columns: [t.tenantId, t.periodId],
      foreignColumns: [periods.tenantId, periods.id],
    }),
    foreignKey({
      name: 'attendance_periods_marker_fk',
      columns: [t.tenantId, t.markedBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    check(
      'attendance_periods_status_ck',
      sql`${t.status} IN ('present','absent','late','excused')`,
    ),
  ],
);

export const staffAttendance = pgTable(
  'staff_attendance',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    attendanceDate: date('attendance_date').notNull(),
    clockIn: timestamp('clock_in', { withTimezone: true }),
    clockOut: timestamp('clock_out', { withTimezone: true }),
    status: text('status').notNull().default('present'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('staff_attendance_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('staff_attendance_unique_day').on(t.tenantId, t.userId, t.attendanceDate),
    index('staff_attendance_tenant_date_idx')
      .on(t.tenantId, t.attendanceDate)
      .where(sql`${t.deletedAt} IS NULL`),
    index('staff_attendance_user_date_idx')
      .on(t.tenantId, t.userId, t.attendanceDate)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'staff_attendance_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    check(
      'staff_attendance_status_ck',
      sql`${t.status} IN ('present','absent','late','excused','on_leave')`,
    ),
  ],
);

export const leaveRequests = pgTable(
  'leave_requests',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    studentId: uuid('student_id').notNull(),
    leaveTypeId: uuid('leave_type_id').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    reason: text('reason'),
    status: text('status').notNull().default('pending'),
    requestedBy: uuid('requested_by').notNull(),
    approverUserId: uuid('approver_user_id'),
    decisionAt: timestamp('decision_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('leave_requests_tenant_id_uq').on(t.tenantId, t.id),
    index('leave_requests_tenant_student_idx')
      .on(t.tenantId, t.studentId, t.startDate)
      .where(sql`${t.deletedAt} IS NULL`),
    index('leave_requests_tenant_status_idx')
      .on(t.tenantId, t.status, t.startDate)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'leave_requests_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'leave_requests_type_fk',
      columns: [t.tenantId, t.leaveTypeId],
      foreignColumns: [leaveTypes.tenantId, leaveTypes.id],
    }),
    foreignKey({
      name: 'leave_requests_requester_fk',
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    foreignKey({
      name: 'leave_requests_approver_fk',
      columns: [t.tenantId, t.approverUserId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    check('leave_requests_status_ck', sql`${t.status} IN ('pending','approved','rejected')`),
    check(
      'leave_requests_decision_ck',
      sql`(${t.status} = 'pending' AND ${t.approverUserId} IS NULL AND ${t.decisionAt} IS NULL) OR (${t.status} IN ('approved','rejected') AND ${t.approverUserId} IS NOT NULL AND ${t.decisionAt} IS NOT NULL)`,
    ),
  ],
);

// ================================================================== Phase 6 — Exams
// + results (0015)
// `exam_types, grading_scales, exams, exam_subjects, exam_schedules, marks,
// report_cards, mark_corrections` (0015_exams_results.sql). The lifecycle state
// machine, the derived grade columns and the published-mark freeze live in the
// migration's triggers; this mapping mirrors the physical schema for typed access.
//
// Key shapes:
//   * `marks` is anchored on the ENROLLMENT (DATABASE_DESIGN §8), with student /
//     section / year as trigger-verified denormalized copies.
//   * `percentage`, `gradeLabel` and `gradePoint` are DERIVED by the trigger from
//     (marks_obtained, max_marks, active scale) — a writer posts marks only.
//   * `reportCards` is versioned: a correction adds a new version row, and a
//     published snapshot is frozen (the reports worker may only stamp `fileId`).
//   * `exams.gradingScaleId` pins WHICH scale version produced the grades, so a
//     published result stays reproducible after a new scale version is created.

/** One band of a grading scale, as stored in `grading_scales.bands`. */
export interface GradingScaleBandRow {
  label: string;
  minPercent: number;
  maxPercent: number;
  gradePoint: number;
}

export const examTypes = pgTable(
  'exam_types',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('exam_types_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('exam_types_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('exam_types_tenant_active_idx')
      .on(t.tenantId, t.isActive)
      .where(sql`${t.deletedAt} IS NULL`),
    check('exam_types_code_ck', sql`${t.code} ~ '^[a-z0-9_]{1,32}$'`),
    check('exam_types_code_len_ck', sql`length(${t.name}) BETWEEN 1 AND 120`),
  ],
);

export const gradingScales = pgTable(
  'grading_scales',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    bands: jsonb('bands').notNull().$type<GradingScaleBandRow[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('grading_scales_tenant_id_uq').on(t.tenantId, t.id),
    // The version is the history axis of a scale.
    uniqueIndex('grading_scales_code_version_uq')
      .on(t.tenantId, t.code, t.version)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('grading_scales_active_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL AND ${t.isActive}`),
    index('grading_scales_tenant_idx')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    check('grading_scales_code_ck', sql`${t.code} ~ '^[a-z0-9_]{1,32}$'`),
    check('grading_scales_version_ck', sql`${t.version} >= 1`),
    check('grading_scales_bands_array_ck', sql`jsonb_typeof(${t.bands}) = 'array'`),
    check(
      'grading_scales_bands_len_ck',
      sql`jsonb_array_length(${t.bands}) BETWEEN 1 AND 12`,
    ),
  ],
);

export const exams = pgTable(
  'exams',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    academicTermId: uuid('academic_term_id').notNull(),
    // Denormalized from the term and pinned by a composite FK (exams_term_year_fk).
    academicYearId: uuid('academic_year_id').notNull(),
    examTypeId: uuid('exam_type_id').notNull(),
    campusId: uuid('campus_id'),
    gradingScaleId: uuid('grading_scale_id'),
    name: text('name').notNull(),
    status: text('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('exams_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('exams_tenant_year_id_uq').on(t.tenantId, t.academicYearId, t.id),
    uniqueIndex('exams_term_name_uq')
      .on(t.tenantId, t.academicTermId, t.name)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} <> 'cancelled'`),
    index('exams_tenant_term_status_idx')
      .on(t.tenantId, t.academicTermId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('exams_tenant_year_idx')
      .on(t.tenantId, t.academicYearId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('exams_tenant_campus_idx')
      .on(t.tenantId, t.campusId, t.status)
      .where(sql`${t.deletedAt} IS NULL AND ${t.campusId} IS NOT NULL`),
    index('exams_tenant_type_idx')
      .on(t.tenantId, t.examTypeId)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'exams_term_fk',
      columns: [t.tenantId, t.academicTermId],
      foreignColumns: [academicTerms.tenantId, academicTerms.id],
    }),
    foreignKey({
      name: 'exams_term_year_fk',
      columns: [t.tenantId, t.academicYearId, t.academicTermId],
      foreignColumns: [academicTerms.tenantId, academicTerms.academicYearId, academicTerms.id],
    }),
    foreignKey({
      name: 'exams_type_fk',
      columns: [t.tenantId, t.examTypeId],
      foreignColumns: [examTypes.tenantId, examTypes.id],
    }),
    foreignKey({
      name: 'exams_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
    foreignKey({
      name: 'exams_scale_fk',
      columns: [t.tenantId, t.gradingScaleId],
      foreignColumns: [gradingScales.tenantId, gradingScales.id],
    }),
    check('exams_name_ck', sql`length(${t.name}) BETWEEN 1 AND 160`),
    check(
      'exams_status_ck',
      sql`${t.status} IN ('draft','scheduled','grading','published','cancelled')`,
    ),
    // published_at exists iff the exam is published.
    check(
      'exams_published_at_ck',
      sql`(${t.status} = 'published' AND ${t.publishedAt} IS NOT NULL) OR (${t.status} <> 'published' AND ${t.publishedAt} IS NULL)`,
    ),
  ],
);

export const examSubjects = pgTable(
  'exam_subjects',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    examId: uuid('exam_id').notNull(),
    classSubjectId: uuid('class_subject_id').notNull(),
    // CARD-copies of the class subject row, pinned by composite FKs: a subject
    // session can never cross academic years or classes.
    academicYearId: uuid('academic_year_id').notNull(),
    classId: uuid('class_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    maxMarks: numeric('max_marks', { precision: 9, scale: 2 }).notNull(),
    weight: numeric('weight', { precision: 6, scale: 3 }).notNull().default('1'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('exam_subjects_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('exam_subjects_tenant_year_id_uq').on(
      t.tenantId,
      t.academicYearId,
      t.id,
    ),
    // DATABASE_DESIGN §8: unique(exam, class_subject).
    uniqueIndex('exam_subjects_exam_subject_uq').on(t.tenantId, t.examId, t.classSubjectId),
    index('exam_subjects_tenant_exam_idx')
      .on(t.tenantId, t.examId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('exam_subjects_tenant_class_subject_idx')
      .on(t.tenantId, t.classSubjectId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('exam_subjects_tenant_class_idx')
      .on(t.tenantId, t.classId)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'exam_subjects_exam_fk',
      columns: [t.tenantId, t.examId],
      foreignColumns: [exams.tenantId, exams.id],
    }),
    foreignKey({
      name: 'exam_subjects_exam_year_fk',
      columns: [t.tenantId, t.academicYearId, t.examId],
      foreignColumns: [exams.tenantId, exams.academicYearId, exams.id],
    }),
    foreignKey({
      name: 'exam_subjects_class_subject_year_fk',
      columns: [t.tenantId, t.academicYearId, t.classSubjectId],
      foreignColumns: [classSubjects.tenantId, classSubjects.academicYearId, classSubjects.id],
    }),
    foreignKey({
      name: 'exam_subjects_class_subject_class_fk',
      columns: [t.tenantId, t.classId, t.classSubjectId],
      foreignColumns: [classSubjects.tenantId, classSubjects.classId, classSubjects.id],
    }),
    foreignKey({
      name: 'exam_subjects_subject_fk',
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    check('exam_subjects_max_marks_ck', sql`${t.maxMarks} > 0`),
    check('exam_subjects_weight_ck', sql`${t.weight} > 0`),
  ],
);

export const examSchedules = pgTable(
  'exam_schedules',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    examSubjectId: uuid('exam_subject_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    room: text('room'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('exam_schedules_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('exam_schedules_subject_live_uq')
      .on(t.tenantId, t.examSubjectId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('exam_schedules_tenant_starts_idx')
      .on(t.tenantId, t.startsAt)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'exam_schedules_subject_fk',
      columns: [t.tenantId, t.examSubjectId],
      foreignColumns: [examSubjects.tenantId, examSubjects.id],
    }),
    check('exam_schedules_window_ck', sql`${t.startsAt} < ${t.endsAt}`),
    check('exam_schedules_room_ck', sql`${t.room} IS NULL OR length(${t.room}) <= 120`),
  ],
);

export const marks = pgTable(
  'marks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    examSubjectId: uuid('exam_subject_id').notNull(),
    // The anchor of the grade: unique(exam_subject, enrollment).
    enrollmentId: uuid('enrollment_id').notNull(),
    studentId: uuid('student_id').notNull(),
    sectionId: uuid('section_id'),
    academicYearId: uuid('academic_year_id').notNull(),
    marksObtained: numeric('marks_obtained', { precision: 9, scale: 2 }),
    // Derived by the trigger — never posted.
    percentage: numeric('percentage', { precision: 5, scale: 2 }),
    gradeLabel: text('grade_label'),
    gradePoint: numeric('grade_point', { precision: 4, scale: 2 }),
    status: text('status').notNull().default('provisional'),
    enteredBy: uuid('entered_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    // Server-owned publication marker (migration 0017). Set by the trigger when
    // publication freezes this mark, immutable afterwards, and the only basis on
    // which the published-mark freeze and DELETE guard decide - because
    // `examSubjectId` is writable. Never write these from application code.
    publishedExamId: uuid('published_exam_id'),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('marks_tenant_id_uq').on(t.tenantId, t.id),
    // Idempotency anchor: unique(exam_subject, enrollment_id).
    uniqueIndex('marks_exam_subject_enrollment_uq').on(
      t.tenantId,
      t.examSubjectId,
      t.enrollmentId,
    ),
    index('marks_tenant_subject_idx')
      .on(t.tenantId, t.examSubjectId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('marks_tenant_student_idx')
      .on(t.tenantId, t.studentId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('marks_tenant_status_idx')
      .on(t.tenantId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('marks_tenant_published_exam_idx')
      .on(t.tenantId, t.publishedExamId)
      .where(sql`${t.publishedExamId} IS NOT NULL`),
    foreignKey({
      name: 'marks_subject_year_fk',
      columns: [t.tenantId, t.academicYearId, t.examSubjectId],
      foreignColumns: [examSubjects.tenantId, examSubjects.academicYearId, examSubjects.id],
    }),
    foreignKey({
      name: 'marks_enrollment_fk',
      columns: [t.tenantId, t.enrollmentId],
      foreignColumns: [enrollments.tenantId, enrollments.id],
    }),
    foreignKey({
      name: 'marks_enrollment_year_fk',
      columns: [t.tenantId, t.academicYearId, t.enrollmentId],
      foreignColumns: [enrollments.tenantId, enrollments.academicYearId, enrollments.id],
    }),
    foreignKey({
      name: 'marks_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'marks_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [sections.tenantId, sections.id],
    }),
    foreignKey({
      name: 'marks_entered_by_fk',
      columns: [t.tenantId, t.enteredBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    foreignKey({
      name: 'marks_published_exam_fk',
      columns: [t.tenantId, t.publishedExamId],
      foreignColumns: [exams.tenantId, exams.id],
    }),
    check('marks_status_ck', sql`${t.status} IN ('provisional','locked','rechecked')`),
    // A mark is frozen by exactly one publication, or by none.
    check(
      'marks_publication_ck',
      sql`(${t.publishedExamId} IS NULL AND ${t.frozenAt} IS NULL) OR (${t.publishedExamId} IS NOT NULL AND ${t.frozenAt} IS NOT NULL)`,
    ),
    // The upper bound needs exam_subjects.max_marks, so the trigger owns it.
    check('marks_obtained_ck', sql`${t.marksObtained} IS NULL OR ${t.marksObtained} >= 0`),
    check(
      'marks_percentage_ck',
      sql`${t.percentage} IS NULL OR (${t.percentage} >= 0 AND ${t.percentage} <= 100)`,
    ),
    check(
      'marks_grade_point_ck',
      sql`${t.gradePoint} IS NULL OR (${t.gradePoint} >= 0 AND ${t.gradePoint} <= 4)`,
    ),
    check(
      'marks_locked_ck',
      sql`(${t.status} = 'provisional' AND ${t.lockedAt} IS NULL) OR (${t.status} IN ('locked','rechecked') AND ${t.lockedAt} IS NOT NULL)`,
    ),
  ],
);

export const reportCards = pgTable(
  'report_cards',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    examId: uuid('exam_id').notNull(),
    studentId: uuid('student_id').notNull(),
    enrollmentId: uuid('enrollment_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    version: integer('version').notNull().default(1),
    status: text('status').notNull().default('draft'),
    gpa: numeric('gpa', { precision: 4, scale: 2 }),
    totalObtained: numeric('total_obtained', { precision: 10, scale: 2 }),
    totalPossible: numeric('total_possible', { precision: 10, scale: 2 })
      .notNull()
      .default('0'),
    subjectCount: integer('subject_count').notNull().default(0),
    // The generated artifact. A published card may still receive it once; it can
    // never be replaced afterwards.
    fileId: uuid('file_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('report_cards_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('report_cards_student_exam_version_uq')
      .on(t.tenantId, t.examId, t.studentId, t.version)
      .where(sql`${t.deletedAt} IS NULL`),
    // One working draft per (exam, student): a correction supersedes it.
    uniqueIndex('report_cards_live_draft_uq')
      .on(t.tenantId, t.examId, t.studentId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} = 'draft'`),
    index('report_cards_tenant_exam_idx')
      .on(t.tenantId, t.examId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('report_cards_tenant_student_idx')
      .on(t.tenantId, t.studentId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('report_cards_tenant_year_idx')
      .on(t.tenantId, t.academicYearId)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: 'report_cards_exam_fk',
      columns: [t.tenantId, t.examId],
      foreignColumns: [exams.tenantId, exams.id],
    }),
    foreignKey({
      name: 'report_cards_exam_year_fk',
      columns: [t.tenantId, t.academicYearId, t.examId],
      foreignColumns: [exams.tenantId, exams.academicYearId, exams.id],
    }),
    foreignKey({
      name: 'report_cards_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'report_cards_enrollment_fk',
      columns: [t.tenantId, t.enrollmentId],
      foreignColumns: [enrollments.tenantId, enrollments.id],
    }),
    foreignKey({
      name: 'report_cards_file_fk',
      columns: [t.tenantId, t.fileId],
      foreignColumns: [files.tenantId, files.id],
    }),
    check('report_cards_status_ck', sql`${t.status} IN ('draft','published')`),
    check('report_cards_version_ck', sql`${t.version} >= 1`),
    check('report_cards_gpa_ck', sql`${t.gpa} IS NULL OR (${t.gpa} >= 0 AND ${t.gpa} <= 4)`),
    check(
      'report_cards_totals_ck',
      sql`${t.totalObtained} IS NULL OR ${t.totalObtained} >= 0`,
    ),
    check('report_cards_total_possible_ck', sql`${t.totalPossible} >= 0`),
    check('report_cards_subject_count_ck', sql`${t.subjectCount} >= 0`),
    check(
      'report_cards_published_at_ck',
      sql`(${t.status} = 'published' AND ${t.publishedAt} IS NOT NULL) OR (${t.status} = 'draft' AND ${t.publishedAt} IS NULL)`,
    ),
  ],
);

// The frozen per-subject lines of ONE report_cards version (0018). Before this table
// a card stored only its aggregates and every reader re-read the detail from live
// `marks`, so a correction rewrote the lines of already-published versions and a
// sibling exam's lines could be printed on a card. A card's lines are now data: a
// reader of a card reads this table, never `marks`. See reportCards above for the
// version lifecycle this belongs to.
export const reportCardSubjects = pgTable(
  'report_card_subjects',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    // The version that owns this line. A line may never be re-homed to another
    // version: that is what makes a historical version readable at all.
    reportCardId: uuid('report_card_id').notNull(),
    examSubjectId: uuid('exam_subject_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    // Copied, not joined. A published card is a document, and the subject may not be
    // renamed or soft-deleted out from under it.
    subjectName: text('subject_name').notNull(),
    marksObtained: numeric('marks_obtained', { precision: 9, scale: 2 }),
    // Copied from exam_subjects when this version was computed. The card's
    // total_possible is the sum of these, so a later edit of the exam subject must
    // not move a published card's denominator.
    maxMarks: numeric('max_marks', { precision: 9, scale: 2 }).notNull(),
    weight: numeric('weight', { precision: 6, scale: 3 }).notNull(),
    percentage: numeric('percentage', { precision: 5, scale: 2 }),
    gradeLabel: text('grade_label'),
    gradePoint: numeric('grade_point', { precision: 4, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('report_card_subjects_tenant_id_uq').on(t.tenantId, t.id),
    // The only access path a reader has: "this card's lines" - the same read the
    // report-card detail, the portal, the transcript and the PDF all perform.
    index('report_card_subjects_tenant_card_idx').on(t.tenantId, t.reportCardId),
    index('report_card_subjects_tenant_exam_subject_idx').on(t.tenantId, t.examSubjectId),
    index('report_card_subjects_tenant_subject_idx').on(t.tenantId, t.subjectId),
    foreignKey({
      name: 'report_card_subjects_card_fk',
      columns: [t.tenantId, t.reportCardId],
      foreignColumns: [reportCards.tenantId, reportCards.id],
    }),
    foreignKey({
      name: 'report_card_subjects_exam_subject_fk',
      columns: [t.tenantId, t.examSubjectId],
      foreignColumns: [examSubjects.tenantId, examSubjects.id],
    }),
    foreignKey({
      name: 'report_card_subjects_subject_fk',
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    // A subject session appears once on a card.
    unique('report_card_subjects_line_uq').on(t.tenantId, t.reportCardId, t.examSubjectId),
    check('report_card_subjects_name_ck', sql`length(${t.subjectName}) BETWEEN 1 AND 160`),
    check(
      'report_card_subjects_obtained_ck',
      sql`${t.marksObtained} IS NULL OR ${t.marksObtained} >= 0`,
    ),
    check('report_card_subjects_max_marks_ck', sql`${t.maxMarks} > 0`),
    check('report_card_subjects_weight_ck', sql`${t.weight} > 0`),
    check(
      'report_card_subjects_percentage_ck',
      sql`${t.percentage} IS NULL OR (${t.percentage} >= 0 AND ${t.percentage} <= 100)`,
    ),
    check(
      'report_card_subjects_grade_point_ck',
      sql`${t.gradePoint} IS NULL OR (${t.gradePoint} >= 0 AND ${t.gradePoint} <= 4)`,
    ),
    check('report_card_subjects_label_ck', sql`${t.gradeLabel} IS NULL OR length(${t.gradeLabel}) <= 16`),
    // A line is either fully graded or fully blank; a half-derived line would be a
    // line the aggregate could not describe.
    check(
      'report_card_subjects_grade_ck',
      sql`(${t.marksObtained} IS NULL AND ${t.percentage} IS NULL AND ${t.gradeLabel} IS NULL AND ${t.gradePoint} IS NULL) OR (${t.marksObtained} IS NOT NULL AND ${t.percentage} IS NOT NULL)`,
    ),
  ],
);

export const markCorrections = pgTable(
  'mark_corrections',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    markId: uuid('mark_id').notNull(),
    examId: uuid('exam_id').notNull(),
    examSubjectId: uuid('exam_subject_id').notNull(),
    studentId: uuid('student_id').notNull(),
    oldMarksObtained: numeric('old_marks_obtained', { precision: 9, scale: 2 }),
    newMarksObtained: numeric('new_marks_obtained', { precision: 9, scale: 2 }).notNull(),
    reason: text('reason').notNull(),
    correctedBy: uuid('corrected_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mark_corrections_tenant_id_uq').on(t.tenantId, t.id),
    index('mark_corrections_tenant_mark_idx').on(t.tenantId, t.markId),
    // The marks trigger's "is there a pending correction for this value?" lookup.
    index('mark_corrections_lookup_idx').on(t.tenantId, t.markId, t.newMarksObtained),
    index('mark_corrections_tenant_student_idx').on(t.tenantId, t.studentId),
    foreignKey({
      name: 'mark_corrections_mark_fk',
      columns: [t.tenantId, t.markId],
      foreignColumns: [marks.tenantId, marks.id],
    }),
    foreignKey({
      name: 'mark_corrections_exam_fk',
      columns: [t.tenantId, t.examId],
      foreignColumns: [exams.tenantId, exams.id],
    }),
    foreignKey({
      name: 'mark_corrections_subject_fk',
      columns: [t.tenantId, t.examSubjectId],
      foreignColumns: [examSubjects.tenantId, examSubjects.id],
    }),
    foreignKey({
      name: 'mark_corrections_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'mark_corrections_actor_fk',
      columns: [t.tenantId, t.correctedBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    check('mark_corrections_reason_ck', sql`length(${t.reason}) BETWEEN 3 AND 500`),
    check('mark_corrections_new_ck', sql`${t.newMarksObtained} >= 0`),
    // A "correction" that does not change the value is a bug, not a correction.
    check(
      'mark_corrections_changed_ck',
      sql`${t.oldMarksObtained} IS DISTINCT FROM ${t.newMarksObtained}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Phase 7 — finance foundation (0021), fee structures (0022), invoices and
// challans (0023), payments and receipts (0024), refunds (0025).
//
// Source of truth is the migration text, not this file. This module is the
// typed mirror; where the two could disagree, the migration wins and
// packages/db/src/security/finance-composite-fk.test.ts catches it.
//
// 20 finance tables in all: the 5 of 0021, the 7 of 0022, and the 8 of
// 0023–0025 (fin_invoices, fin_invoice_items, fin_invoice_adjustments,
// fin_challans, fin_payments, fin_payment_allocations, fin_receipts,
// fin_refunds).
//
// WHAT IS REPRESENTED EXACTLY
//   Columns (name, type, precision/scale, nullability, default), primary keys,
//   unique CONSTRAINTS, unique INDEXES (including the partial expression index
//   and NULLS NOT DISTINCT), check constraints, and foreign keys with their
//   ON DELETE action. Constraint names are the live catalog's, not invented:
//   WHERE 0021–0025 declared `CONSTRAINT x UNIQUE (...)` this uses `unique()`
//   (a pg_constraint row, as in the database); where the DDL used
//   `CREATE UNIQUE INDEX` this uses `uniqueIndex()` (a pg_index row). The
//   distinction is not cosmetic — the composite-FK suite reads pg_constraint,
//   so declaring an index where the database has a constraint would be a lie.
//
// WHAT DRIZZLE ORM 0.38 CANNOT REPRESENT, AND IS THEREFORE NOT STATED HERE
// These are real parts of 0021–0025. They are absent because the abstraction has
// no construct for them, NOT because they are unimportant, and none is
// approximated by a look-alike that a reader would mistake for the real thing.
// Each is asserted against the live catalog by
// packages/db/src/security/finance-trigger-inventory.test.ts and
// packages/db/src/security/finance-composite-fk.test.ts, so the gap is a
// documented omission rather than a silent one.
//
//   1. TRIGGERS. 26 trg_fin_* functions and 32 bindings across 0022–0025 — the
//      6 functions and 8 bindings of 0022, then 0023's number stamp, header
//      guard, line freeze, line-amount derivation, line/adjustment totals and
//      approval gate, 0024's balance recompute, void stamp, challan status and
//      refresh, the four allocation guards plus bounds and delete guard, the
//      0025 refund provenance and refund ceiling. `pgTable` has no trigger
//      primitive, so the §18 status graph, the §8.7.1 committed-run freeze, the
//      §9.6.0 issue freeze, the §9.6.0 C-8 derived due_date, the §12.1
//      reversal-shape rules and the §6.4 assignment pin are ALL invisible here.
//      Reading this file tells you nothing about any of these tables'
//      BEHAVIOUR. That is why the behavioural suites exist, and why `status`
//      below is a plain text column with nothing stopping a caller writing
//      'published' on a draft or 'paid' on an unpaid invoice.
//   2. FUNCTION DEFINITIONS — the trg_fin_* bodies. Not relations, so not part
//      of a schema module at all.
//   3. GRANTS AND REVOKES. Every one of the 20 tables below is created and then
//      immediately `REVOKE ALL ON <t> FROM school_app_rw` (§35.4, §30.3), so
//      nothing here is app-reachable until 0028. 0025_fin_refunds.sql grants
//      SELECT, INSERT on fin_refunds and fin_payment_allocations and
//      0025_privilege_remediation.sql revokes them again, so the NET state is
//      fail-closed; §16.5.1's COLUMN-level privilege model — which is what
//      actually makes subtotal, total and balance unwritable — is not a relation
//      property at all. Drizzle models no ACL, so none of this appears below.
//      Verified by the two suites above.
//   4. ROW LEVEL SECURITY. 0021–0025 deliberately enable none and create no
//      policy; §30.3 defers the whole RLS block to 0028. A schema module that
//      could express RLS would still be correct to say nothing here.
//   5. `ON DELETE SET NULL (column)`. 0021's
//      fin_tenant_settings_tax_profile_fk uses the PostgreSQL 15+ column-list
//      form, so deleting a tax profile nulls `tax_profile_id` and NOT
//      `tenant_id`. Drizzle's UpdateDeleteAction is the five-value union
//      'cascade' | 'restrict' | 'no action' | 'set null' | 'set default' and
//      cannot say WHICH column is nulled. It is written as `set null` below,
//      which is the nearest action but NOT the same statement, and the
//      difference is precisely whether tenant_id survives. The migration's
//      version is the correct one. Recorded as a deliberate approximation, and
//      the only such case in these 20 tables.
//   6. DEFERRABILITY. fin_payment_allocations' fin_allocations_refund_ceiling is
//      a `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, checked
//      at COMMIT rather than per statement. That is limitation 1 again — it is a
//      trigger — and it is invisible here, so nothing below states that
//      fin_payment_allocations is validated at commit time.
//   7. THE TWO 0024 VIEWS. fin_v_payment_position and fin_v_invoice_balance are
//      `security_invoker = on` relations, and §12.4 makes them the AUTHORITATIVE
//      readers for payment position and invoice balance in preference to the
//      cached columns. A view is not a pgTable, so neither is declared here, and
//      a reader of this file who trusts `balance` alone is trusting a cache.
//
// TWO THINGS THAT LOOK LIKE OVERSIGHTS AND ARE NOT
//   * `structure_ids` is a real `uuid[]`, typed as an array rather than
//     flattened into a join table.
//   * `fin_billing_run_items` has NO `id` column. Its primary key is the triple
//     (tenant_id, run_id, enrollment_id), so one enrollment is billed at most
//     once per run — a correctness property enforced by the PK itself, and the
//     reason it is the only table below declared with `primaryKey({ columns })`.
//
// DECLARATION ORDER IS NOT MIGRATION ORDER
// 0021 creates fin_tenant_settings BEFORE fin_tax_profiles and adds
// fin_tenant_settings_tax_profile_fk afterwards with ALTER TABLE, because a
// forward reference would fail. Drizzle evaluates a foreignKey({...}) reference
// array eagerly, so finTaxProfiles is declared first here and the FK is simply
// stated in place. That is a property of this module's evaluation, not a change
// to the migration, which is untouched.
// ---------------------------------------------------------------------------

/** 0021. Per-tenant money configuration, exactly one row per tenant. */
export const finTaxProfiles = pgTable(
  'fin_tax_profiles',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    taxNumber: text('tax_number'),
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull().default('0'),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Deliberately NO updated_at. Every other finance table has one, and it is
    // tempting to add it here for symmetry; 0021 does not declare it, and a
    // column the database does not have is worse than an asymmetric table.
  },
  (t) => [
    // The FK target for fin_tenant_settings.tax_profile_id. Required, not
    // incidental: the column-list SET NULL is in limitation 5 above.
    unique('fin_tax_profiles_ten_id_uq').on(t.tenantId, t.id),
    unique('fin_tax_profiles_name_uq').on(t.tenantId, t.name),
    foreignKey({
      name: 'fin_tax_profiles_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    check('fin_tax_profiles_rate_check', sql`${t.rate} >= 0 AND ${t.rate} <= 100`),
  ],
);

/** 0021. Per-tenant money configuration, exactly one row per tenant. */
export const finTenantSettings = pgTable(
  'fin_tenant_settings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    currency: text('currency').notNull().default('PKR'),
    // Nullable on purpose: a school with no tax registration has no profile, so
    // a NOT NULL FK here would force every tenant to invent one. Invoice issue
    // reads NULL as "untaxed", not as an error.
    taxProfileId: uuid('tax_profile_id'),
    // 0 means "never store a raw body". The encryption that would make a
    // non-zero value safe is NOT implemented in Phase 7, so 0 is the only
    // legitimate value today — but the declared CHECK is `>= 0`, not `= 0`, and
    // raising it to 0 is an owner decision this migration does not make.
    webhookRawRetentionDays: integer('webhook_raw_retention_days').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Also what makes the 0028 backfill idempotent via ON CONFLICT (tenant_id).
    unique('fin_tenant_settings_tenant_uq').on(t.tenantId),
    unique('fin_tenant_settings_ten_id_uq').on(t.tenantId, t.id),
    // tenants IS the tenant, so the composite anchor would be (id, id). A
    // single-column reference is correct here, not merely permitted, and
    // fin_tenant_settings is on the §6.3 R4 allowlist for that reason.
    foreignKey({
      name: 'fin_tenant_settings_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    // In 0021 this arrives by ALTER TABLE after fin_tax_profiles exists.
    // `set null` is the closest action Drizzle can express and matches the
    // catalog's confdeltype, but the migration uses the PostgreSQL 15+ form
    // `ON DELETE SET NULL (tax_profile_id)`, which additionally says WHICH
    // column is nulled. Drizzle cannot express that, so this declaration
    // cannot distinguish "null tax_profile_id" from "null every referencing
    // column" — and the second reading is the wrong one, because nulling
    // tenant_id would violate NOT NULL. See limitation 5 in the header.
    foreignKey({
      name: 'fin_tenant_settings_tax_profile_fk',
      columns: [t.tenantId, t.taxProfileId],
      foreignColumns: [finTaxProfiles.tenantId, finTaxProfiles.id],
    }).onDelete('set null'),
    check('fin_tenant_settings_currency_check', sql`${t.currency} IN ('PKR')`),
    check(
      'fin_tenant_settings_webhook_raw_retention_days_check',
      sql`${t.webhookRawRetentionDays} >= 0`,
    ),
  ],
);

/**
 * 0021. The fixed nine-account chart of accounts.
 *
 * Seeded rows are system-owned and may not be renamed or recoded. A tenant may
 * NOT add accounts: the chart is fixed, and an extension point is an owner
 * decision, not a per-tenant one.
 */
export const finLedgerAccounts = pgTable(
  'fin_ledger_accounts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    accountClass: text('account_class').notNull(),
    isContra: boolean('is_contra').notNull().default(false),
    normalSide: text('normal_side').notNull(),
    isSystem: boolean('is_system').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The FK target for fin_ledger_entries.account_code. Required, not
    // incidental: 0023's ledger entries reference (tenant_id, account_code).
    unique('fin_ledger_accounts_code_uq').on(t.tenantId, t.code),
    // Anchor uniformity: declared even though nothing FKs on id.
    unique('fin_ledger_accounts_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_ledger_accounts_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    check(
      'fin_ledger_accounts_code_check',
      sql`${t.code} IN ('1000','1100','1200','1300','2200','4000','4100','4200','4900')`,
    ),
    check('fin_ledger_accounts_account_class_check', sql`${t.accountClass} IN ('asset','liability','revenue')`),
    check('fin_ledger_accounts_normal_side_check', sql`${t.normalSide} IN ('debit','credit')`),
    // A class and a normal side that disagree is the defect this column
    // combination exists to catch. Enforced so F4's jsonb validation and this
    // constraint cannot disagree about what an account means.
    check(
      'fin_ledger_accounts_side_ck',
      sql`(
        (${t.accountClass} = 'asset'     AND ${t.normalSide} = 'debit'  AND NOT ${t.isContra})
     OR (${t.accountClass} = 'liability' AND ${t.normalSide} = 'credit' AND NOT ${t.isContra})
     OR (${t.accountClass} = 'revenue'   AND ${t.normalSide} = 'credit' AND NOT ${t.isContra})
     OR (${t.accountClass} = 'revenue'   AND ${t.normalSide} = 'debit'  AND     ${t.isContra})
      )`,
    ),
  ],
);

/** 0021. Per-tenant, per-year, per-kind document counter. */
export const finDocumentCounters = pgTable(
  'fin_document_counters',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    // Closed, so a new document kind is a reviewable schema change rather than
    // a value a route can invent.
    kind: text('kind').notNull(),
    // `mode: 'bigint'` types the default as bigint | SQL, so the migration's
    // literal `DEFAULT 0` is expressed as raw SQL rather than a JS number.
    lastValue: bigint('last_value', { mode: 'bigint' }).notNull().default(sql`0`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_document_counters_uq').on(t.tenantId, t.academicYearId, t.kind),
    unique('fin_document_counters_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_document_counters_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }).onDelete('restrict'),
    check('fin_document_counters_kind_check', sql`${t.kind} IN ('invoice','receipt','challan')`),
    check('fin_document_counters_last_value_check', sql`${t.lastValue} >= 0`),
  ],
);

/** 0021. A billable category; a fee structure item points at one. */
export const finFeeHeads = pgTable(
  'fin_fee_heads',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    // A head-level default a structure item may override, so a mixed invoice
    // does not need a structure per head.
    taxTreatment: text('tax_treatment').notNull().default('none'),
    isWaivable: boolean('is_waivable').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Referenced by fin_fee_structure_items via (tenant_id, fee_head_id).
    unique('fin_fee_heads_ten_id_uq').on(t.tenantId, t.id),
    unique('fin_fee_heads_code_uq').on(t.tenantId, t.code),
    foreignKey({
      name: 'fin_fee_heads_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    check(
      'fin_fee_heads_tax_treatment_check',
      sql`${t.taxTreatment} IN ('none','exclusive','inclusive')`,
    ),
  ],
);

/**
 * 0022. The fee structure document: a versioned, targetable set of fee heads.
 *
 * The §18 status graph is enforced by trg_fin_structure_publish_freeze, which
 * this module cannot express (limitation 1). The two CHECKs that DO appear here
 * are the ones the database enforces as constraints; the transition order
 * draft → published → retired|superseded, and the write-once publication stamp,
 * are not among them.
 */
export const finFeeStructures = pgTable(
  'fin_fee_structures',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    version: integer('version').notNull().default(1),
    status: text('status').notNull().default('draft'),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    supersedesId: uuid('supersedes_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    // §6.3 R4 exception, one of two in 0022: `users` has no tenant_id, so a
    // single-column reference is correct. ON DELETE RESTRICT, not SET NULL:
    // PostgreSQL implements SET NULL as a referential UPDATE, which the
    // write-once publication stamp refuses with 55000 — so a SET NULL action
    // could never fire. RESTRICT makes the consequence explicit (23001) and
    // deactivation is the supported route.
    publishedBy: uuid('published_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    unique('fin_fee_structures_code_uq').on(t.tenantId, t.code, t.version),
    unique('fin_fee_structures_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_fee_structures_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }).onDelete('restrict'),
    // Self-reference: a version may supersede an earlier one, and both sides
    // carry tenant_id so the edge cannot cross tenants.
    foreignKey({
      name: 'fin_fee_structures_supersedes_fk',
      columns: [t.tenantId, t.supersedesId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_fee_structures_publisher_fk',
      columns: [t.publishedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    check(
      'fin_fee_structures_status_ck',
      sql`${t.status} IN ('draft','published','retired','superseded')`,
    ),
    check('fin_fee_structures_version_check', sql`${t.version} >= 1`),
    check(
      'fin_fee_structures_dates_ck',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveFrom} < ${t.effectiveTo}`,
    ),
    // draft ⟺ never published. The reverse half — stamping published_at on the
    // transition — is the trigger's job and is not a constraint.
    check(
      'fin_fee_structures_published_ck',
      sql`(
        (${t.status} = 'draft' AND ${t.publishedAt} IS NULL)
     OR (${t.status} <> 'draft' AND ${t.publishedAt} IS NOT NULL)
      )`,
    ),
  ],
);

/** 0022. One priced line of a structure. Frozen once the structure is published. */
export const finFeeStructureItems = pgTable(
  'fin_fee_structure_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    structureId: uuid('structure_id').notNull(),
    feeHeadId: uuid('fee_head_id').notNull(),
    installmentNo: integer('installment_no').notNull().default(1),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    recurrence: text('recurrence').notNull().default('once'),
  },
  (t) => [
    unique('fin_fee_structure_items_uq').on(t.tenantId, t.structureId, t.feeHeadId, t.installmentNo),
    unique('fin_fee_structure_items_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_fee_structure_items_structure_fk',
      columns: [t.tenantId, t.structureId],
      foreignColumns: [finFeeStructures.tenantId, finFeeStructures.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fin_fee_structure_items_fee_head_fk',
      columns: [t.tenantId, t.feeHeadId],
      foreignColumns: [finFeeHeads.tenantId, finFeeHeads.id],
    }).onDelete('restrict'),
    check('fin_fee_structure_items_installment_no_check', sql`${t.installmentNo} >= 1`),
    check('fin_fee_structure_items_amount_check', sql`${t.amount} >= 0`),
    check(
      'fin_fee_structure_items_recurrence_check',
      sql`${t.recurrence} IN ('once','monthly','termly','annual')`,
    ),
  ],
);

/** 0022. When each installment of a structure falls due. */
export const finFeeInstallmentPlans = pgTable(
  'fin_fee_installment_plans',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    structureId: uuid('structure_id').notNull(),
    installmentNo: integer('installment_no').notNull(),
    dueOn: date('due_on').notNull(),
    label: text('label'),
  },
  (t) => [
    unique('fin_installment_plans_uq').on(t.tenantId, t.structureId, t.installmentNo),
    unique('fin_installment_plans_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_installment_plans_structure_fk',
      columns: [t.tenantId, t.structureId],
      foreignColumns: [finFeeStructures.tenantId, finFeeStructures.id],
    }).onDelete('cascade'),
    check('fin_fee_installment_plans_installment_no_check', sql`${t.installmentNo} >= 1`),
  ],
);

/**
 * 0022. Who a structure applies to: exactly one of five shapes, one row each.
 *
 * fin_targets_shape_ck is the whole point of this table and is reproduced
 * faithfully, including the deliberate asymmetry that only the 'section' row
 * constrains its pointer, letting the other three float.
 */
export const finFeeStructureTargets = pgTable(
  'fin_fee_structure_targets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    structureId: uuid('structure_id').notNull(),
    targetType: text('target_type').notNull(),
    campusId: uuid('campus_id'),
    gradeId: uuid('grade_id'),
    classId: uuid('class_id'),
    sectionId: uuid('section_id'),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT is load-bearing. Without it the pointer columns a
    // 'grade' target leaves NULL would let a byte-identical second row through,
    // and an 'all' target has four NULLs by definition. Representable exactly in
    // Drizzle 0.38, so it is stated rather than approximated.
    unique('fin_targets_uq')
      .on(t.tenantId, t.structureId, t.targetType, t.campusId, t.gradeId, t.classId, t.sectionId)
      .nullsNotDistinct(),
    unique('fin_targets_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_targets_structure_fk',
      columns: [t.tenantId, t.structureId],
      foreignColumns: [finFeeStructures.tenantId, finFeeStructures.id],
    }).onDelete('cascade'),
    // These four are declared with NO ON DELETE clause, which PostgreSQL records
    // as NO ACTION, and that is the migration's declared DDL rather than an
    // omission here. It is also the one place a 0022 table can outlive its
    // target: deleting a campus leaves a target row pointing at nothing instead
    // of refusing the delete. Reproduced as declared, not "fixed".
    foreignKey({
      name: 'fin_targets_campus_fk',
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
    foreignKey({
      name: 'fin_targets_grade_fk',
      columns: [t.tenantId, t.gradeId],
      foreignColumns: [gradeLevels.tenantId, gradeLevels.id],
    }),
    foreignKey({
      name: 'fin_targets_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [acdClasses.tenantId, acdClasses.id],
    }),
    foreignKey({
      name: 'fin_targets_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [sections.tenantId, sections.id],
    }),
    check(
      'fin_fee_structure_targets_target_type_check',
      sql`${t.targetType} IN ('all','campus','grade','class','section')`,
    ),
    check(
      'fin_targets_shape_ck',
      sql`(
        (${t.targetType} = 'all'     AND ${t.campusId} IS NULL     AND ${t.gradeId} IS NULL
                                    AND ${t.classId} IS NULL     AND ${t.sectionId} IS NULL)
     OR (${t.targetType} = 'campus'  AND ${t.campusId} IS NOT NULL AND ${t.gradeId} IS NULL
                                    AND ${t.classId} IS NULL     AND ${t.sectionId} IS NULL)
     OR (${t.targetType} = 'grade'   AND ${t.gradeId} IS NOT NULL AND ${t.classId} IS NULL
                                    AND ${t.sectionId} IS NULL
                                    AND (${t.campusId} IS NOT NULL OR ${t.campusId} IS NULL))
     OR (${t.targetType} = 'class'   AND ${t.classId} IS NOT NULL AND ${t.sectionId} IS NULL
                                    AND (${t.campusId} IS NOT NULL OR ${t.campusId} IS NULL)
                                    AND (${t.gradeId} IS NOT NULL OR ${t.gradeId} IS NULL))
     OR (${t.targetType} = 'section' AND ${t.sectionId} IS NOT NULL)
      )`,
    ),
  ],
);

/**
 * 0022. Which structure an enrollment is charged under, and for which period.
 *
 * §6.4 requires `student_id` and `academic_year_id` to equal the enrollment's,
 * and that is enforced by trg_fin_assignment_validate — which is NOT visible
 * here (limitation 1). Both columns are NOT NULL and both are declared, so a
 * reader can see they are denormalised copies without being able to see that
 * they are pinned. That distinction is the reason the behavioural suite exists.
 */
export const finFeeAssignments = pgTable(
  'fin_fee_assignments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    // Nullable on purpose: NULL means "charge nothing yet", and that row still
    // has to be subject to the dedup index below.
    structureId: uuid('structure_id'),
    enrollmentId: uuid('enrollment_id').notNull(),
    studentId: uuid('student_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    installmentPlanId: uuid('installment_plan_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_fee_assignments_ten_id_uq').on(t.tenantId, t.id),
    // D4. All THREE nullable key columns are COALESCEd, and the middle one is
    // the whole defect: as a bare key column a NULL `structure_id` is a NULL to
    // the index, so two byte-identical "assign nothing" rows both insert. The
    // nil UUID is never produced by gen_random_uuid() and is not minted as a
    // surrogate key by any application, so it cannot collide with a real
    // structure_id. `effective_from` is NOT NULL as a column yet is COALESCEd in
    // the index anyway — that is what the migration writes, reproduced verbatim
    // rather than tidied.
    uniqueIndex('fin_fee_assignments_one_active_uq')
      .on(
        t.tenantId,
        t.enrollmentId,
        sql`coalesce(${t.structureId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${t.effectiveFrom}, date '0001-01-01')`,
        sql`coalesce(${t.effectiveTo}, date '9999-12-31')`,
      )
      .where(sql`${t.isActive}`),
    foreignKey({
      name: 'fin_fee_assignments_structure_fk',
      columns: [t.tenantId, t.structureId],
      foreignColumns: [finFeeStructures.tenantId, finFeeStructures.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_fee_assignments_enrollment_fk',
      columns: [t.tenantId, t.enrollmentId],
      foreignColumns: [enrollments.tenantId, enrollments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_fee_assignments_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_fee_assignments_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_fee_assignments_plan_fk',
      columns: [t.tenantId, t.installmentPlanId],
      foreignColumns: [finFeeInstallmentPlans.tenantId, finFeeInstallmentPlans.id],
    }).onDelete('restrict'),
    check(
      'fin_fee_assignments_range_ck',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * 0022. A recorded, replayable billing pass over one academic year.
 *
 * §8.7.1's freeze — once `status` reaches 'committed' the row is immutable and
 * undeletable — is enforced by trg_fin_billing_run_freeze and is NOT visible
 * here. Note also that there is deliberately NO transition graph: the design
 * constrains the committed_at / cancelled_at pair but never enumerates which of
 * the four statuses may follow which, so none is invented below.
 */
export const finBillingRuns = pgTable(
  'fin_billing_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    status: text('status').notNull().default('draft'),
    // A real uuid[], not a join table: the set of structures a run covered is
    // frozen along with the run.
    structureIds: uuid('structure_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    idempotencyKey: text('idempotency_key').notNull(),
    totalStudents: integer('total_students').notNull().default(0),
    totalInvoices: integer('total_invoices').notNull().default(0),
    totalAmount: numeric('total_amount', { precision: 19, scale: 4 }).notNull().default('0'),
    // §6.3 R4 exception, the other of the two in 0022, and the only SET NULL in
    // it. started_by is who pressed the button on an uncommitted run; losing
    // that on account deletion is acceptable, which is exactly why this one is
    // SET NULL and published_by is RESTRICT.
    startedBy: uuid('started_by'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledReason: text('cancelled_reason'),
  },
  (t) => [
    unique('fin_billing_runs_ten_id_uq').on(t.tenantId, t.id),
    // Tenant-scoped, not global: two tenants may legitimately use the same key.
    unique('fin_billing_runs_idem_uq').on(t.tenantId, t.idempotencyKey),
    foreignKey({
      name: 'fin_billing_runs_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_billing_runs_user_fk',
      columns: [t.startedBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    check(
      'fin_billing_runs_status_check',
      sql`${t.status} IN ('draft','preview','committed','cancelled')`,
    ),
    check('fin_billing_runs_total_students_check', sql`${t.totalStudents} >= 0`),
    check('fin_billing_runs_total_invoices_check', sql`${t.totalInvoices} >= 0`),
    // §8.7's state coupling. cancelled requires a reason and forbids a commit;
    // committed requires committed_at and forbids a cancel; draft and preview
    // carry neither. Stamping the timestamps is the trigger's job.
    check(
      'fin_billing_runs_state_ck',
      sql`(
        (${t.status} = 'cancelled' AND ${t.cancelledAt} IS NOT NULL AND ${t.cancelledReason} IS NOT NULL
                      AND ${t.committedAt} IS NULL)
     OR (${t.status} = 'committed' AND ${t.committedAt} IS NOT NULL AND ${t.cancelledAt} IS NULL)
     OR (${t.status} IN ('draft','preview') AND ${t.committedAt} IS NULL AND ${t.cancelledAt} IS NULL)
      )`,
    ),
  ],
);

/**
 * 0023. THE INVOICE HEADER. One live invoice per (tenant, enrollment,
 * academic_year) — the grain is §9.1.1's and it is enforced by the partial
 * unique index below, not by prose.
 *
 * Read this declaration and you know almost nothing about when money becomes
 * owed. `status` is a plain text column: §9.2's transition graph, §9.6.0 C-8's
 * DERIVED due_date (NOT NULL with no DEFAULT, written by
 * trg_fin_invoice_header_guard), §9.6.0's line freeze on the transition out of
 * 'draft', and C-1/C-9.2's balance and paid_at maintenance are all triggers
 * (limitation 1). `invoice_no` is nullable and the number is assigned by
 * trg_fin_invoice_number, so a caller can write NULL here legitimately only
 * for a draft.
 */
export const finInvoices = pgTable(
  'fin_invoices',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    // NULL exactly in state 'draft', and permitted-but-unexpected in 'void': a
    // draft discarded before issue never burned a counter value (§9.6.1).
    invoiceNo: text('invoice_no'),
    studentId: uuid('student_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    enrollmentId: uuid('enrollment_id').notNull(),
    // The structure that GENERATED this invoice. Nullable because an officer may
    // compose one by hand; NOT NULL for any run-generated invoice, because
    // fin_billing_run_items.structure_id is NOT NULL in applied 0022.
    structureId: uuid('structure_id'),
    status: text('status').notNull().default('draft'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    // §9.6.0 C-8. NOT NULL and NO DEFAULT: the value is derived, never left to
    // chance. Drizzle cannot express "no default", only "not null", so the
    // declaration looks like an ordinary required column and is not one.
    dueDate: date('due_date').notNull(),
    // The three CACHED money columns. subtotal = lines only; total = subtotal +
    // approved adjustments + tax; balance = total - net_applied. All three are
    // trigger-maintained and unwritable by the runtime role (§16.5.1), and
    // fin_v_invoice_balance is the authoritative reader (limitation 7).
    subtotal: numeric('subtotal', { precision: 19, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 19, scale: 4 }).notNull().default('0'),
    // C-1: NO WRITER IN 0023. trg_fin_invoice_balance_recompute is created and
    // bound by 0024, which opens with a backfill, so this is 0 on every row
    // between the two landings. Stated rather than left to be discovered.
    balance: numeric('balance', { precision: 19, scale: 4 }).notNull().default('0'),
    // C-9.2. Written by 0024's balance recompute on entry to 'paid' and cleared
    // on exit. Both directions are constrained below.
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    // C-14. A write-once audit identity, exactly like fin_fee_structures
    // .published_by, so RESTRICT and not SET NULL. §6.3 R4 single column
    // because `users` is platform-global and has no tenant_id.
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_invoices_ten_id_uq').on(t.tenantId, t.id),
    // C-7. Partial, so a VOIDED invoice frees its slot: §9.2.1's replacement
    // draft needs it, and without the WHERE clause a school could never
    // re-invoice a family whose invoice was voided. This is the constraint that
    // makes "billing twice" a unique violation rather than a rounding difference.
    uniqueIndex('fin_invoices_ten_enrollment_year_uq')
      .on(t.tenantId, t.enrollmentId, t.academicYearId)
      .where(sql`${t.status} <> 'void'`),
    // Also partial, because a number is only meaningful once assigned.
    uniqueIndex('fin_invoices_number_uq')
      .on(t.tenantId, t.invoiceNo)
      .where(sql`${t.invoiceNo} is not null`),
    foreignKey({
      name: 'fin_invoices_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_invoices_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }).onDelete('restrict'),
    // Legal only because 0021 adds `enrollments_tenant_id_uq`; 0005 shipped
    // enrollments with no (tenant_id, id) anchor at all (P0-03).
    foreignKey({
      name: 'fin_invoices_enrollment_fk',
      columns: [t.tenantId, t.enrollmentId],
      foreignColumns: [enrollments.tenantId, enrollments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_invoices_structure_fk',
      columns: [t.tenantId, t.structureId],
      foreignColumns: [finFeeStructures.tenantId, finFeeStructures.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_invoices_created_by_fk',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    check(
      'fin_invoices_status_check',
      sql`${t.status} IN ('draft','issued','partially_paid','paid','void')`,
    ),
    // C-13. Stated as a CASE so 'void' is explicitly the one state in which a
    // number is optional: a voided draft must not burn a counter value, while a
    // voided ISSUED invoice keeps the number it was printed with.
    check(
      'fin_invoices_number_ck',
      sql`CASE ${t.status}
            WHEN 'draft' THEN ${t.invoiceNo} IS NULL
            WHEN 'void'  THEN TRUE
            ELSE             ${t.invoiceNo} IS NOT NULL
          END`,
    ),
    check(
      'fin_invoices_void_ck',
      sql`(
        (${t.status} = 'void' AND ${t.voidedAt} IS NOT NULL AND ${t.voidReason} IS NOT NULL
                   AND length(btrim(${t.voidReason})) > 0)
     OR (${t.status} <> 'void' AND ${t.voidedAt} IS NULL)
      )`,
    ),
    // C-9.2. Both directions, deliberately. A one-armed implication would permit
    // paid_at on a draft or a voided invoice — precisely the stale state the
    // void trigger and the balance recompute have to clear.
    check(
      'fin_invoices_paid_at_ck',
      sql`(
        (${t.status} = 'paid'   AND ${t.paidAt} IS NOT NULL)
     OR (${t.status} <> 'paid' AND ${t.paidAt} IS NULL)
      )`,
    ),
  ],
);

/**
 * 0023. One billable line, positive by construction.
 *
 * `installment_no` is NULLABLE, and that is the point: a line from a structure
 * WITH plan rows carries the real installment_no, while a line from a plan-less
 * structure has no installment to point at — applied 0022 says such a structure
 * "bills as a single installment on effective_from", which is a billing
 * convention and not a plan row. NULL lets the composite plan FK skip under
 * MATCH SIMPLE, which is exactly the intended semantics.
 *
 * `amount` is written by trg_fin_invoice_item_amount (quantity x unit_amount),
 * so no route can send a line total that disagrees with its own factors.
 */
export const finInvoiceItems = pgTable(
  'fin_invoice_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    structureId: uuid('structure_id').notNull(),
    installmentNo: integer('installment_no'),
    // COPIED at issue time from the head: a published structure is frozen but a
    // fee HEAD can be re-taxed, and an issued invoice must not change when the
    // head does.
    feeHeadId: uuid('fee_head_id').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull().default('1'),
    unitAmount: numeric('unit_amount', { precision: 19, scale: 4 }).notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    taxAmount: numeric('tax_amount', { precision: 19, scale: 4 }).notNull().default('0'),
    // Stamped by trg_fin_invoice_freeze_lines on the parent leaving 'draft'.
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // C-7. Uniqueness is (invoice, structure, head, installment), NOT
    // (invoice, head): two structures may legitimately charge the same head on
    // one invoice. NULLS NOT DISTINCT is load-bearing rather than stylistic —
    // without it the two NULLs of a plan-less structure never compare equal and
    // the dedup role silently evaporates for exactly the case the nullable
    // installment_no exists to serve.
    unique('fin_invoice_items_uq')
      .on(t.tenantId, t.invoiceId, t.structureId, t.feeHeadId, t.installmentNo)
      .nullsNotDistinct(),
    unique('fin_invoice_items_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_invoice_items_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [finInvoices.tenantId, finInvoices.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_invoice_items_structure_fk',
      columns: [t.tenantId, t.structureId],
      foreignColumns: [finFeeStructures.tenantId, finFeeStructures.id],
    }).onDelete('restrict'),
    // fin_installment_plans_uq (tenant_id, structure_id, installment_no) is
    // already applied in 0022, so this three-column FK needs no new anchor. It
    // makes "this line belongs to an installment of this structure's plan" a
    // database fact rather than an application convention.
    foreignKey({
      name: 'fin_invoice_items_plan_fk',
      columns: [t.tenantId, t.structureId, t.installmentNo],
      foreignColumns: [finFeeInstallmentPlans.tenantId, finFeeInstallmentPlans.structureId, finFeeInstallmentPlans.installmentNo],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_invoice_items_head_fk',
      columns: [t.tenantId, t.feeHeadId],
      foreignColumns: [finFeeHeads.tenantId, finFeeHeads.id],
    }).onDelete('restrict'),
    check('fin_invoice_items_installment_no_check', sql`${t.installmentNo} >= 1`),
    check('fin_invoice_items_quantity_check', sql`${t.quantity} <> 0`),
    check('fin_invoice_items_unit_amount_check', sql`${t.unitAmount} >= 0`),
    check(
      'fin_invoice_items_tax_amount_check',
      sql`${t.taxAmount} >= 0 AND ${t.taxAmount} = round(${t.taxAmount}, 2)`,
    ),
    // C-10 + C-17. The sign is closed at the line: zero is a mistake (delete the
    // line), and a negative line IS an unapproved concession — which is exactly
    // what the adjustment approval gate exists to prevent. Every reduction is an
    // adjustment.
    check(
      'fin_invoice_items_amount_ck',
      sql`${t.amount} > 0 AND ${t.amount} = round(${t.amount}, 2)`,
    ),
    // §16.3's paisa rule on the unit price, stated as DDL here rather than as
    // prose that no migration ever carried.
    check('fin_invoice_items_unit_amount_ck', sql`${t.unitAmount} = round(${t.unitAmount}, 2)`),
  ],
);

/**
 * 0023. A SIGNED adjustment. There is no `direction` column and there is
 * deliberately no `type` column: the type is `adjustment_type` and the sign is
 * the meaning. That is not cosmetic — trg_fin_invoice_item_total computes
 * `total = subtotal + adjustments + tax` with a bare SUM, which is only correct
 * if the sign is already in the column.
 *
 * §9.5's approval axis is four columns and a status rather than a rule, because
 * "the approver is the creator" is not separation of duties.
 */
export const finInvoiceAdjustments = pgTable(
  'fin_invoice_adjustments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    adjustmentType: text('adjustment_type').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    requestedBy: uuid('requested_by').notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    // §16.7 named this and §21.4 carries fee_adjustment_reversal_invalid, but no
    // earlier DDL had it: the one thing that makes a reversal findable.
    reversesAdjustmentId: uuid('reverses_adjustment_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_invoice_adjustments_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_invoice_adjustments_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [finInvoices.tenantId, finInvoices.id],
    }).onDelete('restrict'),
    // Both identities RESTRICT: SET NULL is a referential UPDATE, and the audit
    // identity of who asked for and who approved a money movement must not be
    // erasable by deleting a user row. Deactivating the account is the route.
    foreignKey({
      name: 'fin_invoice_adjustments_user_fk',
      columns: [t.approvedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_invoice_adjustments_requester_fk',
      columns: [t.requestedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    // Self-referential on the ordinary tenant-composite shape. RESTRICT, because
    // an adjustment is never deleted at all — there is no DELETE privilege and no
    // route — so this is about refusing to remove a reversal's target.
    foreignKey({
      name: 'fin_invoice_adjustments_reverses_fk',
      columns: [t.tenantId, t.reversesAdjustmentId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete('restrict'),
    check(
      'fin_invoice_adjustments_adjustment_type_check',
      sql`${t.adjustmentType} IN ('discount','concession','waiver','fine','late_fee','correction')`,
    ),
    check(
      'fin_invoice_adjustments_amount_check',
      sql`${t.amount} <> 0 AND ${t.amount} = round(${t.amount}, 2)`,
    ),
    check('fin_invoice_adjustments_reason_check', sql`length(btrim(${t.reason})) > 0`),
    check(
      'fin_invoice_adjustments_status_check',
      sql`${t.status} IN ('pending','approved','rejected')`,
    ),
    // C-5. Exhaustive over the closed set: every type has exactly the signs it
    // may carry. Without this a 'fine' could be negative — a fine that REDUCES a
    // family's bill, wearing a fine's ledger treatment.
    check(
      'fin_invoice_adjustments_sign_ck',
      sql`CASE ${t.adjustmentType}
            WHEN 'discount'   THEN ${t.amount} < 0
            WHEN 'concession' THEN ${t.amount} < 0
            WHEN 'waiver'     THEN ${t.amount} < 0
            WHEN 'fine'       THEN ${t.amount} > 0
            WHEN 'late_fee'   THEN ${t.amount} > 0
            WHEN 'correction' THEN TRUE
            ELSE FALSE
          END`,
    ),
    // A correction is only a reversal if it says what it reverses.
    check(
      'fin_invoice_adjustments_reverses_ck',
      sql`(${t.adjustmentType} = 'correction') = (${t.reversesAdjustmentId} IS NOT NULL)`,
    ),
    // C-6. Three conjuncts, one per state, so there is no combination of
    // populated and unpopulated columns describing an approval that did not
    // happen.
    check(
      'fin_invoice_adjustments_approval_ck',
      sql`CASE ${t.status}
            WHEN 'pending'  THEN ${t.approvedBy} IS NULL
                              AND ${t.approvedAt} IS NULL
                              AND ${t.rejectedReason} IS NULL
            WHEN 'approved' THEN ${t.approvedBy} IS NOT NULL
                              AND ${t.approvedAt} IS NOT NULL
                              AND ${t.rejectedReason} IS NULL
            WHEN 'rejected' THEN ${t.approvedBy} IS NULL
                              AND ${t.approvedAt} IS NULL
                              AND ${t.rejectedReason} IS NOT NULL
                              AND length(btrim(${t.rejectedReason})) > 0
            ELSE FALSE
          END`,
    ),
    // C-6. FOUR EYES, at the USER level rather than the role level: roles overlap
    // by design, so a role-level separation would be unenforced, while separating
    // the two ACTORS is a constraint the database can check.
    check(
      'fin_invoice_adjustments_no_self_approval_ck',
      sql`${t.approvedBy} IS NULL OR ${t.approvedBy} <> ${t.requestedBy}`,
    ),
    // The FK above is satisfied by the row being inserted, so nothing else stops a
    // row naming itself. IS DISTINCT FROM because the non-correction case leaves
    // the column NULL and NULL must pass.
    check(
      'fin_invoice_adjustments_no_self_reversal_ck',
      sql`${t.reversesAdjustmentId} IS DISTINCT FROM ${t.id}`,
    ),
  ],
);

/**
 * 0023. The collection document, 1:1 with a live invoice.
 *
 * A challan is not a reusable payment instrument: it is a printable bank-deposit
 * slip FOR one invoice, so a second challan against the same invoice would be a
 * second payable document for one debt. Hence a UNIQUE constraint rather than a
 * partial index, and hence UNIQUE (tenant_id, invoice_id).
 *
 * `snapshot` is what the family was actually SHOWN, frozen: recomputing a printed
 * document from live rows means a parent's paper challan and the portal disagree
 * the day a fee structure is corrected. `status` has no derivation in 0023 — it
 * is 0024's trg_fin_challan_status that owns it (limitation 1).
 */
export const finChallans = pgTable(
  'fin_challans',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    // Frozen at issue: the installment plan may be corrected later and a parent's
    // printed challan must keep its date (§10.3).
    dueOn: date('due_on').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    // Terminal and monotonic. The CHECK owns the value set; the trigger owns the
    // half a CHECK cannot express, namely that OLD cannot be referenced at all.
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    snapshot: jsonb('snapshot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_challans_ten_id_uq').on(t.tenantId, t.id),
    unique('fin_challans_1to1_uq').on(t.tenantId, t.invoiceId),
    foreignKey({
      name: 'fin_challans_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [finInvoices.tenantId, finInvoices.id],
    }).onDelete('restrict'),
    check(
      'fin_challans_status_check',
      sql`${t.status} IN ('issued','partially_paid','paid','expired','void')`,
    ),
    // void is never silently representable: it needs a date and a reason, exactly
    // as fin_invoices_void_ck does, so "void" can never be a label with no cause.
    check(
      'fin_challans_void_ck',
      sql`(
        (${t.status} = 'void' AND ${t.voidedAt} IS NOT NULL AND ${t.voidReason} IS NOT NULL)
     OR (${t.status} <> 'void' AND ${t.voidedAt} IS NULL)
      )`,
    ),
    check('fin_challans_snapshot_ck', sql`jsonb_typeof(${t.snapshot}) = 'object'`),
  ],
);

/**
 * 0024. Money actually received.
 *
 * `received_by` is NULL for provider/webhook-initiated money, which is why it is
 * nullable — and it is NOT a foreign key, in either this table or
 * fin_receipts.received_by: an absent identity is a fact, not an unconstrained
 * uuid, so nothing here can name a user that does not exist or has been deleted.
 * `idempotency_key` is what makes a provider retry safe.
 */
export const finPayments = pgTable(
  'fin_payments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    paymentNo: text('payment_no').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('PKR'),
    method: text('method').notNull(),
    channel: text('channel').notNull().default('manual'),
    provider: text('provider'),
    providerRef: text('provider_ref'),
    status: text('status').notNull().default('settled'),
    payerGuardianId: uuid('payer_guardian_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    receivedBy: uuid('received_by'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_payments_no_uq').on(t.tenantId, t.paymentNo),
    unique('fin_payments_idem_uq').on(t.tenantId, t.idempotencyKey),
    unique('fin_payments_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_payments_payer_fk',
      columns: [t.tenantId, t.payerGuardianId],
      foreignColumns: [guardians.tenantId, guardians.id],
    }).onDelete('restrict'),
    check('fin_payments_amount_check', sql`${t.amount} > 0`),
    check(
      'fin_payments_method_check',
      sql`${t.method} IN ('cash','bank_transfer','cheque','card','online','easypaisa','jazzcash','raast','other')`,
    ),
    check(
      'fin_payments_channel_check',
      sql`${t.channel} IN ('manual','portal','provider')`,
    ),
    check('fin_payments_status_check', sql`${t.status} IN ('pending','settled','failed')`),
    // A lifecycle transition, not a financial fact: 'pending' still needs the
    // time it was seen.
    check(
      'fin_payments_transition_ck',
      sql`${t.status} = 'settled' OR ${t.receivedAt} IS NOT NULL`,
    ),
    // A provider reference exists only for provider-originated money. One
    // direction only, deliberately: a manual payment with a provider_ref typed in
    // by a caller is not a fact the database can adjudicate.
    check(
      'fin_payments_provider_ck',
      sql`(
        (${t.channel} = 'provider' AND ${t.provider} IS NOT NULL AND ${t.providerRef} IS NOT NULL)
     OR (${t.channel} <> 'provider')
      )`,
    ),
  ],
);

/**
 * 0025. A refund request and its decision.
 *
 * `proposed_allocations` is the plan and `applied_allocations` is what was
 * actually done; both are jsonb arrays rather than rows, because 0025's whole
 * point is that the allocation that reverses money is a row in ONE signed table
 * and the refund is the AUTHORISATION for it, not a second place money is
 * represented.
 *
 * There is no UNIQUE (tenant_id, id) CONSTRAINT: 0025 ships it as a UNIQUE INDEX,
 * and declaring `unique()` here would invent a pg_constraint row the catalog does
 * not have.
 */
export const finRefunds = pgTable(
  'fin_refunds',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    refundNo: text('refund_no').notNull(),
    paymentId: uuid('payment_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    status: text('status').notNull().default('requested'),
    reason: text('reason').notNull(),
    proposedAllocations: jsonb('proposed_allocations').notNull(),
    appliedAllocations: jsonb('applied_allocations'),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    processedBy: uuid('processed_by'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    disbursementReference: text('disbursement_reference'),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (t) => [
    unique('fin_refunds_no_uq').on(t.tenantId, t.refundNo),
    unique('fin_refunds_idem_uq').on(t.tenantId, t.idempotencyKey),
    // The (tenant_id, id) anchor is an INDEX in 0025, not a constraint, and it
    // exists so 0024's fin_pa_refund_fk has something to enforce against.
    uniqueIndex('fin_refunds_ten_id_uq').on(t.tenantId, t.id),
    index('fin_refunds_tenant_payment_idx').on(t.tenantId, t.paymentId),
    index('fin_refunds_tenant_status_idx').on(t.tenantId, t.status),
    index('fin_refunds_requested_by_idx').on(t.tenantId, t.requestedBy),
    foreignKey({
      name: 'fin_refunds_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [finPayments.tenantId, finPayments.id],
    }).onDelete('restrict'),
    check('fin_refunds_amount_check', sql`${t.amount} > 0`),
    check(
      'fin_refunds_status_check',
      sql`${t.status} IN ('requested','approved','rejected','processed')`,
    ),
    check(
      'fin_refunds_proposed_allocations_check',
      sql`jsonb_typeof(${t.proposedAllocations}) = 'array'`,
    ),
    check(
      'fin_refunds_applied_allocations_check',
      sql`${t.appliedAllocations} IS NULL OR jsonb_typeof(${t.appliedAllocations}) = 'array'`,
    ),
    // Four states, thirteen conjuncts. There is no combination of populated and
    // unpopulated columns here that describes a decision, a disbursement or a
    // rejection that did not happen.
    check(
      'fin_refunds_decision_ck',
      sql`(
        (${t.status} = 'requested'
            AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL
            AND ${t.rejectionReason} IS NULL
            AND ${t.disbursementReference} IS NULL
            AND ${t.appliedAllocations} IS NULL)
     OR (${t.status} = 'approved'
            AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
            AND ${t.rejectionReason} IS NULL
            AND ${t.disbursementReference} IS NULL
            AND ${t.appliedAllocations} IS NOT NULL)
     OR (${t.status} = 'processed'
            AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
            AND ${t.processedBy} IS NOT NULL AND ${t.processedAt} IS NOT NULL
            AND ${t.rejectionReason} IS NULL
            AND ${t.disbursementReference} IS NOT NULL
            AND ${t.appliedAllocations} IS NOT NULL)
     OR (${t.status} = 'rejected'
            AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
            AND ${t.processedBy} IS NULL AND ${t.processedAt} IS NULL
            AND ${t.rejectionReason} IS NOT NULL
            AND ${t.disbursementReference} IS NULL
            AND ${t.appliedAllocations} IS NULL)
      )`,
    ),
  ],
);

/**
 * 0024. ONE signed table, and it is the whole of the reversal mechanism.
 *
 * The naive design — allocations plus reversals plus refund_allocations —
 * represents "money applied to an invoice" three times and guarantees drift.
 * Here the three kinds of row are kept DISTINCT BY `effect` AND `refund_id`,
 * NEVER BY AMOUNT SIGN, which is what makes payment_unallocated a non-negative
 * quantity: both negative rows are excluded from that formula by `effect`, so a
 * full return of a fully-unallocated payment cannot produce a negative on-account
 * balance.
 *
 * All four FKs below are declared with NO ON DELETE clause, which PostgreSQL
 * records as NO ACTION. That is the migration's declared DDL rather than an
 * omission here, and it is the reason §12.1's rows can never be silently removed
 * out from under the balance cache.
 */
export const finPaymentAllocations = pgTable(
  'fin_payment_allocations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    // NULL = an on-account movement, not a mis-typed invoice.
    invoiceId: uuid('invoice_id'),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    effect: text('effect').notNull(),
    reversalOfAllocationId: uuid('reversal_of_allocation_id'),
    // Plain nullable column in 0024 — fin_refunds did not exist yet, so a
    // forward reference would have failed 42P01 at that file's own transaction
    // and stopped every migration after it. 0025 adds fin_pa_refund_fk by ALTER,
    // and that FK is declared here.
    refundId: uuid('refund_id'),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_pa_ten_id_uq').on(t.tenantId, t.id),
    // Two partial uniques that make reversal multiplicity explicit AND bounded:
    // at most one correction reversal per target, at most one refund reversal per
    // target per refund. COALESCE is deliberately avoided — the two predicates
    // read more clearly than a coalesced key would.
    uniqueIndex('fin_pa_one_correction_uq')
      .on(t.tenantId, t.reversalOfAllocationId)
      .where(sql`${t.reversalOfAllocationId} is not null and ${t.refundId} is null`),
    uniqueIndex('fin_pa_one_reversal_per_refund_uq')
      .on(t.tenantId, t.reversalOfAllocationId, t.refundId)
      .where(sql`${t.reversalOfAllocationId} is not null and ${t.refundId} is not null`),
    foreignKey({
      name: 'fin_pa_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [finPayments.tenantId, finPayments.id],
    }),
    foreignKey({
      name: 'fin_pa_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [finInvoices.tenantId, finInvoices.id],
    }),
    foreignKey({
      name: 'fin_pa_reversal_fk',
      columns: [t.tenantId, t.reversalOfAllocationId],
      foreignColumns: [t.tenantId, t.id],
    }),
    // 0025 adds this by ALTER TABLE, and 0025_refund_fk_remediation.sql pins it
    // to ON DELETE NO ACTION NOT DEFERRABLE. Reproduced as declared.
    foreignKey({
      name: 'fin_pa_refund_fk',
      columns: [t.tenantId, t.refundId],
      foreignColumns: [finRefunds.tenantId, finRefunds.id],
    }),
    check('fin_payment_allocations_amount_check', sql`${t.amount} <> 0`),
    check(
      'fin_payment_allocations_effect_check',
      sql`${t.effect} IN ('apply','reverse','on_account_return')`,
    ),
    // Declared EXACTLY ONCE and covering all three effects.
    check(
      'fin_pa_effect_ck',
      sql`(
        (${t.effect} = 'apply'
             AND ${t.amount} > 0
             AND ${t.invoiceId} IS NOT NULL
             AND ${t.reversalOfAllocationId} IS NULL
             AND ${t.refundId} IS NULL)
     OR (${t.effect} = 'reverse'
             AND ${t.amount} < 0
             AND ${t.reversalOfAllocationId} IS NOT NULL)
     OR (${t.effect} = 'on_account_return'
             AND ${t.amount} < 0
             AND ${t.invoiceId} IS NULL
             AND ${t.reversalOfAllocationId} IS NULL
             AND ${t.refundId} IS NULL)
      )`,
    ),
  ],
);

/**
 * 0024. Issued once, immutable for life, provable against its payment.
 *
 * NO status COLUMN AND NO VOID. The brief contradicted itself by calling a
 * receipt immutable AND giving it status = issued | void, and both cannot hold.
 * What would be voided is the INTERPRETATION, not the fact: "we took 50,000 from
 * you on 3 March" did not become untrue because an allocation was a data-entry
 * error. A correction is a NEW receipt with version = 2 and supersedes_id set,
 * and both versions stay retrievable and printable forever.
 *
 * `payer_guardian_id` is DENORMALISED from the payment on purpose: RLS on a
 * portal document must be decidable from the row itself, and a policy that had
 * to walk payment -> student_guardians -> student -> back to the payer on every
 * read would be slow and would depend on a soft-delete column the reader cannot
 * see.
 */
export const finReceipts = pgTable(
  'fin_receipts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    receiptNo: text('receipt_no').notNull(),
    paymentId: uuid('payment_id').notNull(),
    payerGuardianId: uuid('payer_guardian_id').notNull(),
    // The FAMILY-ATTRIBUTABLE portion, frozen at issue. amount = p.amount would
    // be wrong the moment a payment settles two families' invoices, and
    // trg_fin_receipt_freeze makes today's equality a database guarantee rather
    // than an assumption. The column is its own value so a future split-receipt
    // feature need not redefine what a receipt is.
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    // COPIED from the payment, not derived, exactly as the payer is.
    currency: char('currency', { length: 3 }).notNull(),
    method: text('method').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    receivedBy: uuid('received_by'),
    version: integer('version').notNull().default(1),
    supersedesId: uuid('supersedes_id'),
    // The rendered document, frozen.
    snapshot: jsonb('snapshot').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_receipts_no_uq').on(t.tenantId, t.receiptNo),
    unique('fin_receipts_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_receipts_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [finPayments.tenantId, finPayments.id],
    }),
    foreignKey({
      name: 'fin_receipts_payer_fk',
      columns: [t.tenantId, t.payerGuardianId],
      foreignColumns: [guardians.tenantId, guardians.id],
    }),
    foreignKey({
      name: 'fin_receipts_supersedes_fk',
      columns: [t.tenantId, t.supersedesId],
      foreignColumns: [t.tenantId, t.id],
    }),
    check('fin_receipts_amount_check', sql`${t.amount} > 0`),
    check('fin_receipts_version_check', sql`${t.version} >= 1`),
    // v1 has no predecessor; v2+ must have one.
    check(
      'fin_receipts_version_ck',
      sql`(
        (${t.version} = 1 AND ${t.supersedesId} IS NULL)
     OR (${t.version} > 1 AND ${t.supersedesId} IS NOT NULL)
      )`,
    ),
  ],
);

/**
 * 0022. What a billing run actually charged, line by line.
 *
 * TWO properties here are not expressible in this module and are part of why the
 * behavioural suite exists:
 *   * There is NO `id`. The primary key is the triple
 *     (tenant_id, run_id, enrollment_id), so one enrollment is billed at most
 *     once per run. That is a correctness property, not a naming detail: the PK
 *     refuses a duplicate charge before any trigger gets a chance to.
 *   * `invoice_id` is nullable AND has a foreign key, but only because 0023 added
 *     fin_bri_invoice_fk by ALTER once fin_invoices existed. Before that it was a
 *     free uuid column, and §8.7.1's write-once attachment rule — the single legal
 *     write to a committed item — is still not visible here (limitation 1).
 *
 * trg_fin_billing_run_items_freeze freezes these rows once the run is committed,
 * and on UPDATE it reads BOTH the source and the destination run, so run_id is
 * not an exit from a committed run. Neither fact appears below.
 */
export const finBillingRunItems = pgTable(
  'fin_billing_run_items',
  {
    tenantId: uuid('tenant_id').notNull(),
    runId: uuid('run_id').notNull(),
    enrollmentId: uuid('enrollment_id').notNull(),
    studentId: uuid('student_id').notNull(),
    structureId: uuid('structure_id').notNull(),
    assignmentId: uuid('assignment_id'),
    invoiceId: uuid('invoice_id'),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.tenantId, t.runId, t.enrollmentId],
      name: 'fin_billing_run_items_pkey',
    }),
    foreignKey({
      name: 'fin_bri_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [finBillingRuns.tenantId, finBillingRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_bri_enrollment_fk',
      columns: [t.tenantId, t.enrollmentId],
      foreignColumns: [enrollments.tenantId, enrollments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_bri_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_bri_structure_fk',
      columns: [t.tenantId, t.structureId],
      foreignColumns: [finFeeStructures.tenantId, finFeeStructures.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_bri_assignment_fk',
      columns: [t.tenantId, t.assignmentId],
      foreignColumns: [finFeeAssignments.tenantId, finFeeAssignments.id],
    }).onDelete('restrict'),
    // 0023's forward-reference resolution. The dependency stays one-way in the
    // other direction: nothing in 0021 or 0022 points at a 0023 table, which is
    // what keeps 0022 applicable on its own.
    foreignKey({
      name: 'fin_bri_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [finInvoices.tenantId, finInvoices.id],
    }).onDelete('restrict'),
    check('fin_billing_run_items_amount_check', sql`${t.amount} >= 0`),
  ],
);

/**
 * 0026. THE CLOSED PROVENANCE CATALOGUE. `event_type` is the only provenance
 * token a caller supplies; `source_type`, `source_table` and the
 * source-existence rule are all looked up here, so provenance cannot be
 * re-stated by the caller and cannot drift from the taxonomy.
 *
 * Exactly ten rows are seeded, and every one names a table created at or before
 * 0026 — that is what keeps 0026 free of a forward reference to a 0027 relation
 * while still refusing an unverifiable source. Two consequences are worth stating
 * because they are the reason the set has this particular shape:
 *
 *   * there is no `invoice.adjustment` alongside `adjustment.post`. Two
 *     non-reversal origins on the same `fin_invoice_adjustments` row would be
 *     two distinct keys in `fin_leg_groups_origin_uq`, and the same adjustment
 *     could then be posted twice.
 *   * `onaccount.return` names `fin_payment_allocations`, not `fin_payments`:
 *     the effect lives on an allocation row with a NULL invoice.
 *
 * A reversal event is exactly a reversal SOURCE, so the flag and the naming
 * convention are two statements of one fact and neither can drift from the other.
 */
export const finLedgerEventTypes = pgTable(
  'fin_ledger_event_types',
  {
    eventType: text('event_type').primaryKey(),
    sourceType: text('source_type').notNull(),
    sourceTable: text('source_table').notNull(),
    isReversal: boolean('is_reversal').notNull(),
    sourceExists: boolean('source_exists').notNull().default(true),
  },
  (t) => [
    check(
      'fin_ledger_event_types_ck',
      sql`(${t.isReversal} and ${t.sourceType} like '%.reversal') or (not ${t.isReversal} and ${t.sourceType} not like '%.reversal')`,
    ),
  ],
);

/**
 * 0026. One balanced, immutable posting header.
 *
 * `source_type` is deliberately NOT a caller argument and is deliberately ABSENT
 * from the idempotency key: `post_fin_ledger_group` derives it from
 * `finLedgerEventTypes`, so a caller cannot mint a second origin for the same
 * source by relabelling the provenance. Keying on a free-form `source_type`
 * would make duplicate suppression a function of an untrusted string.
 *
 * A group is inserted OPEN (`sealedAt` NULL) and sealed by a later UPDATE, so the
 * legs can be written first — the insert-then-seal order is forced by
 * `trg_fin_ledger_sealed_group_reject`. `postedAt` is deliberately NOT here: a
 * group has no independent posting instant, and a second timestamp on the header
 * could disagree with its legs with no constraint able to say which is right.
 */
export const finLedgerEntryGroups = pgTable(
  'fin_ledger_entry_groups',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    eventType: text('event_type').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    reversalOfGroup: uuid('reversal_of_group'),
    // Cached totals. Never the proof of balance: the deferred trigger recomputes
    // them from the legs, so a miscounted cache cannot validate itself.
    totalDebit: numeric('total_debit', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    totalCredit: numeric('total_credit', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    entryCount: integer('entry_count'),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    correlationId: uuid('correlation_id'),
  },
  (t) => [
    unique('fin_leg_groups_ten_id_uq').on(t.tenantId, t.id),
    // IDEMPOTENCY. One origin per business event per source row. Conditional
    // uniqueness is an INDEX, not a constraint: PostgreSQL does not accept a
    // WHERE clause on a UNIQUE constraint, and the intent is specifically
    // partial.
    uniqueIndex('fin_leg_groups_origin_uq')
      .on(t.tenantId, t.eventType, t.sourceId)
      .where(sql`${t.reversalOfGroup} is null`),
    // ONE REVERSAL PER TARGET. Enforced by the index and not only by the body:
    // two concurrent reversal transactions both pass F4's SELECT ... FOR UPDATE
    // on the target, and the second must lose here.
    uniqueIndex('fin_leg_groups_reversal_uq')
      .on(t.tenantId, t.reversalOfGroup)
      .where(sql`${t.reversalOfGroup} is not null`),
    foreignKey({
      name: 'fin_leg_groups_reversal_fk',
      columns: [t.tenantId, t.reversalOfGroup],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete('restrict'),
    // Only meaningful once sealed: an unsealed group is mid-write and its totals
    // are written by the deferred trigger rather than asserted here.
    check(
      'fin_leg_groups_balanced_ck',
      sql`${t.sealedAt} is null or (${t.totalDebit} = ${t.totalCredit} and ${t.entryCount} is not null)`,
    ),
  ],
);

/**
 * 0026. The legs of a posting.
 *
 * `amount > 0` together with an explicit `direction` is the standard
 * representation, and it is what makes the balanced-group check a plain SUM
 * comparison. `studentId` / `invoiceId` are denormalised so AR aging can read the
 * LEDGER rather than the invoice table; because that is the point, both are
 * FK-backed — an unconstrained denormalised column would be the opposite. Both
 * stay nullable (a leg can be a tenant-level posting with no student) and a
 * composite FK permits NULL.
 *
 * There is deliberately NO FK to `tenants` here. The tenant is anchored by the
 * composite references alone: every leg names an account, a group, a student and
 * an invoice that are all tenant-scoped, and a single-column `tenants(id)`
 * reference would add a dependency without adding a guarantee.
 */
export const finLedgerEntries = pgTable(
  'fin_ledger_entries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    entryGroupId: uuid('entry_group_id').notNull(),
    accountCode: text('account_code').notNull(),
    direction: text('direction').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    studentId: uuid('student_id'),
    invoiceId: uuid('invoice_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_leg_entries_ten_id_uq').on(t.tenantId, t.id),
    // AR aging reads (tenant_id, student_id). Partial, because most legs are
    // tenant-level postings naming no student.
    index('fin_leg_entries_ar_idx')
      .on(t.tenantId, t.studentId, t.accountCode)
      .where(sql`${t.studentId} is not null`),
    foreignKey({
      name: 'fin_leg_entries_group_fk',
      columns: [t.tenantId, t.entryGroupId],
      foreignColumns: [finLedgerEntryGroups.tenantId, finLedgerEntryGroups.id],
    }).onDelete('restrict'),
    // A business-key reference. finLedgerAccounts carries UNIQUE
    // (tenant_id, code) precisely so a leg may name an account by code.
    foreignKey({
      name: 'fin_leg_entries_account_fk',
      columns: [t.tenantId, t.accountCode],
      foreignColumns: [finLedgerAccounts.tenantId, finLedgerAccounts.code],
    }),
    foreignKey({
      name: 'fin_leg_entries_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_leg_entries_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [finInvoices.tenantId, finInvoices.id],
    }).onDelete('restrict'),
    check(
      'fin_leg_entries_direction_ck',
      sql`${t.direction} in ('debit','credit')`,
    ),
    check('fin_leg_entries_amount_positive_ck', sql`${t.amount} > 0`),
    // Redundant against the check above, and named explicitly rather than folded
    // into it: `amount <> 0` is the invariant the ledger relies on when it
    // reasons about single-leg groups, and a constraint the reader can find by
    // name is worth more than one fewer line of DDL.
    check('fin_leg_entries_nonzero_ck', sql`${t.amount} <> 0`),
  ],
);

export const finReconciliationBatches = pgTable(
  'fin_reconciliation_batches',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    batchNo: text('batch_no').notNull(),
    status: text('status').notNull().default('open'),
    statementFileId: uuid('statement_file_id'),
    statementRef: text('statement_ref').notNull(),
    statementPeriodStart: date('statement_period_start').notNull(),
    statementPeriodEnd: date('statement_period_end').notNull(),
    statementTotal: numeric('statement_total', { precision: 19, scale: 4 }),
    matchedTotal: numeric('matched_total', { precision: 19, scale: 4 }),
    varianceAmount: numeric('variance_amount', { precision: 19, scale: 4 }).notNull().default('0'),
    varianceReason: text('variance_reason'),
    varianceTolerance: numeric('variance_tolerance', { precision: 19, scale: 4 }).notNull().default('0'),
    completionHash: text('completion_hash'),
    completionSnapshot: jsonb('completion_snapshot'),
    completedBy: uuid('completed_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_recon_batches_ten_id_uq').on(t.tenantId, t.id),
    unique('fin_recon_batches_no_uq').on(t.tenantId, t.batchNo),
    foreignKey({
      name: 'fin_recon_batches_file_fk',
      columns: [t.tenantId, t.statementFileId],
      foreignColumns: [files.tenantId, files.id],
    }).onDelete('restrict'),
    check('fin_recon_batches_period_ck', sql`${t.statementPeriodEnd} >= ${t.statementPeriodStart}`),
    check('fin_recon_batches_status_ck', sql`${t.status} IN ('open','matching','completed','cancelled')`),
    check(
      'fin_recon_batch_state_ck',
      sql`(${t.status} = 'completed' AND ${t.completionHash} IS NOT NULL AND ${t.completionSnapshot} IS NOT NULL AND ${t.completedAt} IS NOT NULL AND ${t.completedBy} IS NOT NULL)
          OR (${t.status} <> 'completed' AND ${t.completionHash} IS NULL AND ${t.completionSnapshot} IS NULL AND ${t.completedAt} IS NULL AND ${t.completedBy} IS NULL)`,
    ),
    check(
      'fin_recon_batch_variance_ck',
      sql`${t.varianceAmount} = 0 OR ${t.status} <> 'completed' OR (${t.varianceReason} IS NOT NULL AND length(btrim(${t.varianceReason})) > 0)`,
    ),
    check(
      'fin_recon_batch_cancel_ck',
      sql`(${t.status} = 'cancelled' AND ${t.cancelledAt} IS NOT NULL) OR (${t.status} <> 'cancelled' AND ${t.cancelledAt} IS NULL)`,
    ),
  ],
);

export const finReconciliationMatches = pgTable(
  'fin_reconciliation_matches',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    statementLineRef: text('statement_line_ref'),
    matchedAmount: numeric('matched_amount', { precision: 19, scale: 4 }).notNull(),
    isFinal: boolean('is_final').notNull().default(false),
    matchedBy: uuid('matched_by').notNull(),
    matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fin_recon_matches_ten_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'fin_recon_matches_batch_fk',
      columns: [t.tenantId, t.batchId],
      foreignColumns: [finReconciliationBatches.tenantId, finReconciliationBatches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fin_recon_matches_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [finPayments.tenantId, finPayments.id],
    }).onDelete('restrict'),
    unique('fin_recon_tenant_batch_payment_uq').on(t.tenantId, t.batchId, t.paymentId),
    check('fin_recon_matches_amount_ck', sql`${t.matchedAmount} > 0`),
    uniqueIndex('fin_recon_payment_final_uq')
      .on(t.tenantId, t.paymentId)
      .where(sql`${t.isFinal}`),
  ],
);
