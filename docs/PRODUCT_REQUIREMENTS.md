# Product Requirements — School Management SaaS

Status: Phase 0 baseline | Owner: Product | Last updated: 2026-09-22

## 1. Vision

A commercial, multi-tenant SaaS platform where each independent school runs its complete administration — academics, finance, HR, library, transport, communication — from one shared codebase with strict data isolation.

## 2. Tenancy & Scale

- Multiple schools (tenants) on one deployment.
- Multiple campuses per school; multiple academic years; multiple terms.
- Target: thousands of schools without per-tenant codebases or forks.
- One user may belong to multiple schools (e.g., a parent with children in two schools, a consultant accountant).

## 3. Personas

| Persona | Portal | Core needs |
|---|---|---|
| Platform operator | `/platform` | Create schools, plans, entitlements, platform audit, billing oversight |
| School admin / principal | `/school` | Configuration, academics, students, approvals, reports |
| Teacher | `/teacher` | Timetable, attendance, gradebook, homework, class messaging |
| Parent | `/parent` | Children's attendance, results, fees, invoices, messaging, calendar |
| Student | `/student` | Schedule, attendance, assignments, results, library |
| Accountant | `/school` (finance scope) | Invoices, payments, refunds, ledgers, reports |
| HR / payroll officer | `/school` (hr scope) | Employees, attendance, leave, payroll |
| Librarian | `/school` (library scope) | Catalog, loans, returns, fines |
| Transport manager | `/school` (transport scope) | Vehicles, routes, assignments, fees |

## 4. Functional Modules (Phase scope overview)

Detailed specifications are produced per phase. This document fixes the module inventory:

1. **Platform/SaaS** — schools, plans, features, entitlements, usage limits, billing, trials, subscription lifecycle, platform audit, platform config.
2. **School Administration** — profile, campuses, academic years, terms, holidays, calendar, departments, configuration, branding, localization.
3. **Identity & Access** — auth, sessions, MFA, password reset, invitations, users, roles, permissions, memberships, audit logs.
4. **Students** — admissions, students, guardians, relationships, enrollment, documents, transfers, promotion, graduation, alumni.
5. **Academics** — grades (levels), classes, sections, subjects, curriculum, teacher assignments, schedules, timetable, homework/assignments.
6. **Attendance** — student, teacher/staff, period-level, leave, late arrivals, reports.
7. **Exams** — exam types, exams, schedules, marks, grading scales, GPA, report cards, transcripts, publishing, correction workflow.
8. **Finance** — fee structures/items, invoices, discounts, scholarships, fines, payments, receipts, refunds, ledgers, balances.
9. **HR** — employees, departments, positions, attendance, leave, salary structures, payroll, payslips, allowances, deductions.
10. **Library** — books, authors, categories, copies, members, loans, returns, fines.
11. **Transport** — vehicles, drivers, conductors, routes, stops, student assignments, transport fees.
12. **Communication** — notifications, announcements, email, SMS, WhatsApp abstraction, messaging, push.
13. **AI** — gateway, school/parent/teacher/admin assistants, academic/attendance/finance analysis, report generation, permission-aware tool access.

## 5. Non-functional Requirements

| Area | Requirement |
|---|---|
| Isolation | Cross-tenant read/write is a security defect (P0). Enforced at API, DB (RLS), job, cache, file, and log layers. |
| Authorization | Every request and AI tool call evaluated against RBAC permissions + tenant scope. Deny by default. |
| Auditability | Security- and finance-relevant mutations produce immutable audit records (who/what/when/tenant/resource/old/new). |
| Financial integrity | Invoices, payments, refunds, receipts immutable after finalization; corrections via append-only adjustments. |
| Idempotency | All non-GET API mutations and all background jobs support idempotency (Idempotency-Key / job dedupe keys). |
| Type safety | End-to-end TypeScript; Zod contracts shared between API, worker, and web. |
| API-first | REST JSON API is the single source of truth; portals are API clients. |
| Observability | Structured logs with request/trace IDs, health/readiness/liveness endpoints, error tracking, worker metrics. |
| Availability target | 99.9% monthly for API (Phase 13 hardening). |
| Performance | p95 API read < 300 ms at 10 RPS per instance baseline; paginate all list endpoints. |
| Data residency / retention | Per DATA_RETENTION.md; GDPR-style subject deletion/export supported via scheduled jobs. |

## 6. Explicit Non-Goals (initial)

- Native mobile apps (responsive web first).
- Microservices — modular monolith with extraction-ready boundaries.
- Real-time video classrooms.
- Payment-provider lock-in (provider abstracted behind interfaces).
- Offline-first client.

## 7. Compliance Assumptions (ASSUMED — confirm with owner)

- Student data treated as sensitive personal data (minors).
- Financial records retained per local statutory periods (configurable; default 7 years).
- Consent tracking for guardian communications where required.

## 8. Open Product Questions

See `DEVELOPMENT_ROADMAP.md` § "User Decisions Required" and final Phase 0 report.
