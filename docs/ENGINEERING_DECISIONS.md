# PressureDesk: Architectural & Engineering Decisions

This document records the five foundational architectural decisions underpinning PressureDesk's backend and operational reliability model.

---

### Decision 1: Plain SQL via `pg` Pool over Object-Relational Mappers (ORMs)

- **Context**: PressureDesk enforces database-level concurrency invariants, row-level locking (`FOR UPDATE SKIP LOCKED`), custom append-only integrity triggers, and multi-statement transactional atomicity across relational tables, idempotency logs, and outbox queues.
- **Options Considered**:
  1. *Full ORM (e.g., Prisma, TypeORM)*: Rapid entity modeling and migration tooling, but abstracts transaction control and generates unpredictable joins and subqueries.
  2. *Query Builder (e.g., Knex, Kysely)*: Provides type safety over queries without entity lifecycle management, but adds an abstraction layer over PostgreSQL-native features.
  3. *Plain SQL with `pg`*: Direct parameterized queries executed over a shared connection pool, with transactional boundaries managed via explicit `BEGIN / COMMIT / ROLLBACK` wrappers.
- **Choice**: Plain SQL utilizing the `pg` driver with a single `runInTransaction(client => ...)` helper. Every critical write path (item creation, atomic claim, transition, outbox dispatch) executes as an explicit, reviewable SQL statement.
- **Trade-off**: Requires manual schema-to-domain mapping and typing maintenance in TypeScript, in exchange for zero query generation overhead, transparent query execution plans, and full access to PostgreSQL primitives (CTEs, advisory locks, partial indexes).

---

### Decision 2: Keyset Pagination with `created_at::text` String Cursor

- **Context**: The operational dashboard must page through high-volume event and work item feeds (5,000+ items) without performance degradation at high page offsets or missing/duplicate records caused by concurrent insertions.
- **Options Considered**:
  1. *Offset/Limit Pagination (`OFFSET n LIMIT 20`)*: Simple to implement, but scans and discards $n$ rows, resulting in $O(n)$ query latency at deep offsets and shifting page windows on concurrent writes.
  2. *Standard Cursor Pagination via JavaScript `Date`*: Encodes timestamps converted through JavaScript `Date` instances. However, PostgreSQL stores microsecond precision ($10^{-6}\text{s}$), whereas JavaScript `Date` truncates to milliseconds ($10^{-3}\text{s}$), causing boundary records with identical millisecond timestamps to be skipped or duplicated.
  3. *Keyset Pagination with Exact Database Timestamp String*: Serializes the exact `created_at::text` string representation directly from PostgreSQL alongside the unique primary key `id`.
- **Choice**: Keyset pagination sorting on `(created_at DESC, id DESC)`, encoding `${row.cursor_ts},${row.id}` in base64, and seeking via `WHERE (created_at, id) < ($1::timestamptz, $2::uuid)`. Full-text search filters (`q`) evaluate `tsv @@ websearch_to_tsquery('english', $q)` as a `WHERE` condition without overriding the keyset sort order.
- **Trade-off**: Clients cannot jump directly to arbitrary page numbers (e.g., "Go to page 42"), requiring sequential navigation via "Load more", in exchange for stable $O(1)$ index seek performance and boundary precision across concurrent mutations.

---

### Decision 3: Optimistic Concurrency Control with Integer Versioning and Atomic Claims

- **Context**: In operational triage, multiple operators simultaneously attempt to claim unassigned tickets or update descriptions, priorities, and deadlines during active incidents.
- **Options Considered**:
  1. *Pessimistic Table/Row Locking (`SELECT ... FOR UPDATE`)*: Locks rows while modals remain open or requests wait, risking contention bottlenecks and lock wait timeouts under burst traffic.
  2. *Distributed Locks (e.g., Redis Redlock)*: Introduces external infrastructure dependencies, clock drift vulnerabilities, and coordination overhead.
  3. *Optimistic Locking with Invariant Claims*: Single-statement conditional updates verifying version (`WHERE id = $1 AND version = $2`) or unassigned availability (`WHERE id = $1 AND status = 'OPEN' AND assignee_id IS NULL`), incrementing `version = version + 1`.
- **Choice**: Optimistic locking across all state transitions, metadata edits, and reassignments, paired with conditional single-statement atomic claims. When zero rows are affected, the service re-reads the row to return a structured error envelope: `409 STALE_VERSION` (including the latest record in `details.latest_item`) or `409 ALREADY_CLAIMED`.
- **Trade-off**: The losing caller receives a rejected mutation and must reload the newest state rather than having the server automatically merge conflicting edits. This guarantees deterministic state transitions without distributed locking infrastructure.

---

### Decision 4: Transactional Outbox Pattern for Asynchronous Delivery

- **Context**: Work item events (claims, reassignments) must trigger notifications to assigned operators. Executing side-effects inside API routes creates dual-write vulnerabilities where the database commits but downstream dispatch fails, or vice-versa.
- **Options Considered**:
  1. *Direct External Delivery in Route Handlers*: Sends notifications synchronously during the HTTP request. Network failures or third-party latency block or fail the primary transaction.
  2. *Post-Commit Asynchronous Calls*: Dispatches events in an unmonitored background promise after database commit. If the Node process crashes between commit and dispatch, the event is permanently lost.
  3. *Transactional Outbox Table with Idempotent Consumer*: Inserts outbox events in the same database transaction as the business entity change, polled by an independent worker process using `FOR UPDATE SKIP LOCKED`.
- **Choice**: Transactional Outbox pattern. Events are persisted to `outbox_jobs` in the same transaction, so there is no dual-write risk. The worker claims batches atomically, applies exponential backoff with random jitter on failure, escalates to `DEAD_LETTER` after 5 attempts, and writes notifications to a consumer table constrained by `UNIQUE (outbox_job_id)`.
- **Trade-off**: Introduces a short asynchronous delivery latency (governed by the 1-second worker polling interval) and requires a periodic crash sweeper to recover orphaned processing jobs, in exchange for at-least-once delivery guarantees without distributed queue brokers.

---

### Decision 5: 404 Not Found vs 403 Forbidden Access Control Policy

- **Context**: PressureDesk operates a multi-team operational model where users belong to one or more teams with defined roles (`Viewer`, `Member`, `Lead`, `Admin`). Information regarding incident existence or compliance investigations must not leak across organizational boundaries.
- **Options Considered**:
  1. *Uniform 403 Forbidden*: Return `403 Forbidden` for any request lacking authorization, regardless of whether the target resource exists in the user's teams.
  2. *Uniform 404 Not Found*: Return `404 Not Found` for all authorization failures, masking both resource existence and permission levels.
  3. *Tenant-Boundary 404 with Role-Boundary 403*: Distinguish between cross-team boundary violations and insufficient privilege within a verified team membership.
- **Choice**: Return `404 Not Found` for any item ID that does not belong to the user's active team memberships, and `403 Forbidden` (`INSUFFICIENT_TEAM_ROLE` or `NOT_TEAM_MEMBER`) only when team membership exists but the user's role cannot perform the action.
- **Trade-off**: Requires tenant validation in database lookup queries before evaluating role permissions, in exchange for preventing resource enumeration attacks and information leakage across operational teams.
