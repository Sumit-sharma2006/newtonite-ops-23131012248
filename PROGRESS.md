# PressureDesk: Project Progress & Implementation Status

## Overview
- **Project**: PressureDesk: Operations Under Pressure
- **Stack**: Node.js + TypeScript + Express, PostgreSQL (plain SQL via `pg`), React + TanStack Query, Docker Compose, Vitest + Supertest
- **Repository Root**: `PressureDesk/`

---

## Phase Status Summary

| Phase | Description | Status | Evidence / Artifacts |
| :--- | :--- | :---: | :--- |
| **Phase 0** | System Architecture & Technical Design | **DONE** | [`docs/design.md`](file:///c:/Users/Sumit/Downloads/PressureDesk/docs/design.md), commit `48d6be4` |
| **Phase 1** | Database Schema, Migrations, Docker & Seed | **DONE** | [`migrations/`](file:///c:/Users/Sumit/Downloads/PressureDesk/migrations), [`docker-compose.yml`](file:///c:/Users/Sumit/Downloads/PressureDesk/docker-compose.yml), [`scripts/seed.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/scripts/seed.ts), commit `97f0c1b`, `a9fd80e` |
| **Phase 2** | Auth, Fresh DB Memberships, Central RBAC & State Machine | **DONE** | [`backend/src/modules/permissions/permissions.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/backend/src/modules/permissions/permissions.ts), [`backend/src/modules/work-items/state-machine.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/backend/src/modules/work-items/state-machine.ts), 51 Vitest tests passing |
| **Phase 3** | Work Items API, Atomic Claim, Optimistic Lock & Idempotency | *Pending* | Route handlers calling `can()`, keyset cursor pagination |
| **Phase 4** | Transactional Outbox Worker & Sweeper | *Pending* | `FOR UPDATE SKIP LOCKED`, exponential backoff, notifications table |
| **Phase 5** | Frontend React Dashboard & Concurrency Tests | *Pending* | TanStack Query tabs, optimistic UI, Supertest concurrency suite |

---

## Phase 1 Verification Checks Summary

1. **Fresh Start & Seed**:
   - `docker-compose.yml` service: `db`
   - Migrations `001_initial_schema.sql` and `002_triggers_and_indexes.sql` applied cleanly
   - `scripts/seed.ts` generates 10 users, 4 teams, 19 memberships, and 5,200 work items
2. **Row Counts**:
   - `items`: 5,200
   - `users`: 10
   - `teams`: 4
   - `memberships`: 19
3. **Append-Only Trigger**:
   - `UPDATE activity_events` raised: `ERROR: Table activity_events is append-only. UPDATE and DELETE operations are forbidden.`
4. **Index Usage**:
   - `EXPLAIN SELECT ... WHERE team_id=... ORDER BY created_at DESC, id DESC LIMIT 20;` uses `Index Scan using idx_work_items_team_pagination on work_items`
5. **Idempotent Migration Runner**:
   - Running `npm run migrate` a second time skips applied migrations with code 0

---

## Phase 2 Implementation Summary

- **Database Connection & Transactions**:
  - [`backend/src/config/env.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/backend/src/config/env.ts): Typed environment variables.
  - [`backend/src/db/pool.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/backend/src/db/pool.ts): Shared pool with error listener.
  - [`backend/src/db/transaction.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/backend/src/db/transaction.ts): `runInTransaction(fn)` managing `BEGIN / COMMIT / ROLLBACK` and `client.release()` in `finally`.
- **Authentication**:
  - `POST /auth/login`: Bcrypt password verification, signed JWT containing **only** `{ userId }` with expiry. Returns `{ token, user: { id, email, full_name, memberships } }`. Identical error for unknown email and wrong password.
  - [`backend/src/middleware/auth.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/backend/src/middleware/auth.ts): Verifies token, loads user's memberships fresh from PostgreSQL on every request.
- **Central Authorization**:
  - [`backend/src/modules/permissions/permissions.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/backend/src/modules/permissions/permissions.ts): Pure function `can(action, ctx)`.
  - Enforces `404 Not Found` for non-team users (prevents ticket existence leakage).
  - Enforces `403 Forbidden` (`INSUFFICIENT_TEAM_ROLE`) when role is inadequate.
- **Locked State Machine**:
  - [`backend/src/modules/work-items/state-machine.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/backend/src/modules/work-items/state-machine.ts): Pure transition validator.
  - Direct resolution (`IN_PROGRESS -> RESOLVED`) permitted **only** for `type = 'TASK'` and `Lead/Admin`.
  - Approval (`AWAITING_APPROVAL -> RESOLVED`) requires `Lead/Admin` and enforces the **four-eyes principle** (`actorId !== createdById`).
- **Error Handling**:
  - [`backend/src/middleware/errorHandler.ts`](file:///c:/Users/Sumit/Downloads/PressureDesk/backend/src/middleware/errorHandler.ts): Consistent `{ error: { code, message, details? } }` envelope. Maps PostgreSQL connection failures to `503 Service Unavailable`.
- **Test Suite**:
  - 51 unit tests passing with zero database dependency (`npm test`).
