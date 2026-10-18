-- 002_triggers_and_indexes.sql
-- Migration 002: Keyset, Partial, and Full-Text Search Indexes

-- 1. Keyset Pagination Index (Team + Cursor)
CREATE INDEX IF NOT EXISTS idx_work_items_team_pagination 
ON work_items (team_id, created_at DESC, id DESC);

-- 2. Team + Status Keyset Pagination Index
CREATE INDEX IF NOT EXISTS idx_work_items_team_status 
ON work_items (team_id, status, created_at DESC, id DESC);

-- 3. Partial Index: "Assigned to me" Active Queue
CREATE INDEX IF NOT EXISTS idx_work_items_assigned_active
ON work_items (assignee_id, created_at DESC, id DESC)
WHERE status <> 'CLOSED';

-- 4. Partial Index: "Unassigned urgent" Queue
CREATE INDEX IF NOT EXISTS idx_work_items_unassigned_urgent
ON work_items (team_id, created_at DESC, id DESC)
WHERE assignee_id IS NULL 
  AND status = 'OPEN' 
  AND priority = 'URGENT';

-- 5. Partial Index: "Awaiting my approval" Queue
CREATE INDEX IF NOT EXISTS idx_work_items_awaiting_approval
ON work_items (team_id, created_at DESC, id DESC)
WHERE status = 'AWAITING_APPROVAL';

-- 6. Full-Text Search Index (GIN on tsvector)
CREATE INDEX IF NOT EXISTS idx_work_items_tsv 
ON work_items USING GIN (tsv);

-- 7. Outbox Polling Index (Worker Queue)
CREATE INDEX IF NOT EXISTS idx_outbox_jobs_polling
ON outbox_jobs (scheduled_at ASC)
WHERE status = 'PENDING';

-- 8. Idempotency Key Expiry Cleanup Index
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
ON idempotency_keys (expires_at);
