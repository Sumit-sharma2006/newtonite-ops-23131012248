import { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { WorkItemPriority, WorkItemStatus, WorkItemType } from '../../types/domain.js';

export interface WorkItemRow {
  id: string;
  title: string;
  description: string;
  type: WorkItemType;
  priority: WorkItemPriority;
  status: WorkItemStatus;
  team_id: string;
  assignee_id: string | null;
  created_by_id: string;
  due_date: string | null;
  version: number;
  cursor_ts: string;
  created_at: string;
  updated_at: string;
}

export interface ActivityEventRow {
  id: string;
  work_item_id: string;
  actor_id: string;
  event_type: string;
  from_state: any;
  to_state: any;
  metadata: any;
  cursor_ts: string;
  created_at: string;
}

export interface CommentRow {
  id: string;
  work_item_id: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface FindItemsFilters {
  userTeamIds: string[];
  teamId?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  assigneeId?: string;
  q?: string;
  view?: 'assigned_to_me' | 'unassigned_urgent' | 'awaiting_my_approval';
  userId: string;
  leadOrAdminTeamIds: string[];
  cursorCreatedAt?: string;
  cursorId?: string;
  limit: number;
}

/**
 * Plain SQL Work Items Repository
 */
export class WorkItemsRepository {
  /**
   * Keyset pagination on (created_at DESC, id DESC) filtered by tenant, status, priority, view, and full-text search.
   */
  async findItems(filters: FindItemsFilters): Promise<WorkItemRow[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    // Constraint: ALWAYS restrict to teams the user belongs to
    if (filters.teamId) {
      conditions.push(`team_id = $${idx++}`);
      values.push(filters.teamId);
    } else {
      conditions.push(`team_id = ANY($${idx++})`);
      values.push(filters.userTeamIds);
    }

    // Explicit Filter: status
    if (filters.status) {
      conditions.push(`status = $${idx++}`);
      values.push(filters.status);
    }

    // Explicit Filter: priority
    if (filters.priority) {
      conditions.push(`priority = $${idx++}`);
      values.push(filters.priority);
    }

    // Explicit Filter: assignee_id
    if (filters.assigneeId) {
      conditions.push(`assignee_id = $${idx++}`);
      values.push(filters.assigneeId);
    }

    // Dedicated Dashboard Views
    if (filters.view === 'assigned_to_me') {
      conditions.push(`assignee_id = $${idx++}`);
      values.push(filters.userId);
      conditions.push(`status <> 'CLOSED'`);
    } else if (filters.view === 'unassigned_urgent') {
      conditions.push(`assignee_id IS NULL`);
      conditions.push(`status = 'OPEN'`);
      conditions.push(`priority = 'URGENT'`);
    } else if (filters.view === 'awaiting_my_approval') {
      conditions.push(`status = 'AWAITING_APPROVAL'`);
      conditions.push(`created_by_id <> $${idx++}`);
      values.push(filters.userId);
      conditions.push(`team_id = ANY($${idx++})`);
      values.push(filters.leadOrAdminTeamIds);
    }

    // Full-Text Search via GIN tsvector - used strictly as a WHERE filter
    if (filters.q && filters.q.trim().length > 0) {
      conditions.push(`tsv @@ websearch_to_tsquery('english', $${idx++})`);
      values.push(filters.q.trim());
    }

    // Keyset pagination cursor comparison: (created_at, id) < ($cursor_ts::timestamptz, $cursor_id::uuid)
    if (filters.cursorCreatedAt && filters.cursorId) {
      conditions.push(`(created_at, id) < ($${idx++}::timestamptz, $${idx++}::uuid)`);
      values.push(filters.cursorCreatedAt, filters.cursorId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Query limit + 1 to detect has_more
    const queryText = `
      SELECT id, title, description, type, priority, status, team_id,
             assignee_id, created_by_id, due_date, version,
             created_at::text AS cursor_ts, created_at, updated_at
      FROM work_items
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${idx};
    `;
    values.push(filters.limit + 1);

    const result = await pool.query(queryText, values);
    return result.rows;
  }

  async findById(id: string, client?: PoolClient): Promise<WorkItemRow | null> {
    const q = client ? client.query.bind(client) : pool.query.bind(pool);
    const result = await q(
      `SELECT id, title, description, type, priority, status, team_id,
              assignee_id, created_by_id, due_date, version,
              created_at::text AS cursor_ts, created_at, updated_at
       FROM work_items
       WHERE id = $1;`,
      [id]
    );
    return result.rows[0] || null;
  }

  async create(
    client: PoolClient,
    data: {
      team_id: string;
      title: string;
      description: string;
      type: WorkItemType;
      priority: WorkItemPriority;
      due_date?: string | null;
      created_by_id: string;
    }
  ): Promise<WorkItemRow> {
    const result = await client.query(
      `INSERT INTO work_items (
         team_id, title, description, type, priority, status,
         assignee_id, created_by_id, due_date, version
       )
       VALUES ($1, $2, $3, $4, $5, 'OPEN', NULL, $6, $7, 1)
       RETURNING id, title, description, type, priority, status, team_id,
                 assignee_id, created_by_id, due_date, version,
                 created_at::text AS cursor_ts, created_at, updated_at;`,
      [
        data.team_id,
        data.title,
        data.description || '',
        data.type,
        data.priority,
        data.created_by_id,
        data.due_date || null
      ]
    );
    return result.rows[0];
  }

  async updateMetadata(
    client: PoolClient,
    itemId: string,
    version: number,
    updates: {
      title?: string;
      description?: string;
      due_date?: string | null;
      priority?: WorkItemPriority;
    }
  ): Promise<WorkItemRow | null> {
    const result = await client.query(
      `UPDATE work_items
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           due_date = CASE WHEN $3::boolean THEN $4::timestamptz ELSE due_date END,
           priority = COALESCE($5, priority),
           version = version + 1,
           updated_at = NOW()
       WHERE id = $6 AND version = $7
       RETURNING id, title, description, type, priority, status, team_id,
                 assignee_id, created_by_id, due_date, version,
                 created_at::text AS cursor_ts, created_at, updated_at;`,
      [
        updates.title !== undefined ? updates.title : null,
        updates.description !== undefined ? updates.description : null,
        updates.due_date !== undefined, // flag to update due_date even if null
        updates.due_date || null,
        updates.priority !== undefined ? updates.priority : null,
        itemId,
        version
      ]
    );
    return result.rows[0] || null;
  }

  async claim(client: PoolClient, itemId: string, userId: string): Promise<WorkItemRow | null> {
    const result = await client.query(
      `UPDATE work_items
       SET assignee_id = $1,
           status = 'IN_PROGRESS',
           version = version + 1,
           updated_at = NOW()
       WHERE id = $2 
         AND status = 'OPEN' 
         AND assignee_id IS NULL
       RETURNING id, title, description, type, priority, status, team_id,
                 assignee_id, created_by_id, due_date, version,
                 created_at::text AS cursor_ts, created_at, updated_at;`,
      [userId, itemId]
    );
    return result.rows[0] || null;
  }

  async transition(
    client: PoolClient,
    itemId: string,
    version: number,
    toStatus: WorkItemStatus
  ): Promise<WorkItemRow | null> {
    const result = await client.query(
      `UPDATE work_items
       SET status = $1,
           assignee_id = CASE WHEN $1 = 'OPEN' THEN NULL ELSE assignee_id END,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $2 AND version = $3
       RETURNING id, title, description, type, priority, status, team_id,
                 assignee_id, created_by_id, due_date, version,
                 created_at::text AS cursor_ts, created_at, updated_at;`,
      [toStatus, itemId, version]
    );
    return result.rows[0] || null;
  }

  async assign(
    client: PoolClient,
    itemId: string,
    version: number,
    assigneeId: string | null
  ): Promise<WorkItemRow | null> {
    const result = await client.query(
      `UPDATE work_items
       SET assignee_id = $1,
           status = CASE WHEN $1 IS NULL AND status = 'IN_PROGRESS' THEN 'OPEN' ELSE status END,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $2 AND version = $3
       RETURNING id, title, description, type, priority, status, team_id,
                 assignee_id, created_by_id, due_date, version,
                 created_at::text AS cursor_ts, created_at, updated_at;`,
      [assigneeId, itemId, version]
    );
    return result.rows[0] || null;
  }

  async isTeamMember(userId: string, teamId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM memberships WHERE user_id = $1 AND team_id = $2;`,
      [userId, teamId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async insertActivityEvent(
    client: PoolClient,
    event: {
      work_item_id: string;
      actor_id: string;
      event_type: string;
      from_state: any;
      to_state: any;
      metadata?: any;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO activity_events (work_item_id, actor_id, event_type, from_state, to_state, metadata)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        event.work_item_id,
        event.actor_id,
        event.event_type,
        event.from_state ? JSON.stringify(event.from_state) : null,
        JSON.stringify(event.to_state),
        JSON.stringify(event.metadata || {})
      ]
    );
  }

  async insertOutboxJob(
    client: PoolClient,
    job: {
      event_type: string;
      aggregate_id: string;
      payload: any;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_jobs (event_type, aggregate_type, aggregate_id, payload, status)
       VALUES ($1, 'WORK_ITEM', $2, $3, 'PENDING');`,
      [job.event_type, job.aggregate_id, JSON.stringify(job.payload)]
    );
  }

  async findActivity(
    itemId: string,
    cursorCreatedAt?: string,
    cursorId?: string,
    limit = 20
  ): Promise<ActivityEventRow[]> {
    const conditions = ['work_item_id = $1'];
    const values: any[] = [itemId];
    let idx = 2;

    if (cursorCreatedAt && cursorId) {
      conditions.push(`(created_at, id) < ($${idx++}::timestamptz, $${idx++}::uuid)`);
      values.push(cursorCreatedAt, cursorId);
    }

    values.push(limit + 1);
    const result = await pool.query(
      `SELECT id, work_item_id, actor_id, event_type, from_state, to_state, metadata,
              created_at::text AS cursor_ts, created_at
       FROM activity_events
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${idx};`,
      values
    );
    return result.rows;
  }

  async createComment(
    client: PoolClient,
    data: { work_item_id: string; author_id: string; body: string }
  ): Promise<CommentRow> {
    const result = await client.query(
      `INSERT INTO comments (work_item_id, author_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, work_item_id, author_id, body, created_at, updated_at;`,
      [data.work_item_id, data.author_id, data.body.trim()]
    );
    return result.rows[0];
  }

  async reserveIdempotencyKey(
    client: PoolClient,
    key: string,
    userId: string,
    method: string,
    path: string,
    hash: string
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO idempotency_keys (
         key, user_id, request_method, request_path, request_params_hash,
         response_code, response_body, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, 0, '{}'::jsonb, NOW() + INTERVAL '24 hours')
       ON CONFLICT (key, user_id) DO NOTHING
       RETURNING key;`,
      [key, userId, method, path, hash]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getIdempotencyRecord(
    client: PoolClient,
    key: string,
    userId: string
  ): Promise<{ request_params_hash: string; response_code: number; response_body: any } | null> {
    const result = await client.query(
      `SELECT request_params_hash, response_code, response_body
       FROM idempotency_keys
       WHERE key = $1 AND user_id = $2;`,
      [key, userId]
    );
    return result.rows[0] || null;
  }

  async updateIdempotencyResponse(
    client: PoolClient,
    key: string,
    userId: string,
    code: number,
    body: any
  ): Promise<void> {
    await client.query(
      `UPDATE idempotency_keys
       SET response_code = $1, response_body = $2
       WHERE key = $3 AND user_id = $4;`,
      [code, JSON.stringify(body), key, userId]
    );
  }

  async getDashboardSummary(
    userId: string,
    teamIds: string[],
    leadOrAdminTeamIds: string[],
    teamId?: string
  ): Promise<{ assigned_to_me: number; unassigned_urgent: number; awaiting_my_approval: number }> {
    const teamFilter = teamId ? `AND team_id = '${teamId}'::uuid` : `AND team_id = ANY($1)`;
    const leadFilter = leadOrAdminTeamIds.length > 0 
      ? `AND team_id = ANY($3)` 
      : `AND false`;

    const sql = `
      SELECT
        COUNT(*) FILTER (WHERE assignee_id = $2 AND status <> 'CLOSED' ${teamFilter}) AS assigned_to_me,
        COUNT(*) FILTER (WHERE assignee_id IS NULL AND status = 'OPEN' AND priority = 'URGENT' ${teamFilter}) AS unassigned_urgent,
        COUNT(*) FILTER (WHERE status = 'AWAITING_APPROVAL' AND created_by_id <> $2 ${leadFilter} ${teamId ? `AND team_id = '${teamId}'::uuid` : ''}) AS awaiting_my_approval
      FROM work_items;
    `;
    const result = await pool.query(sql, [teamIds, userId, leadOrAdminTeamIds]);
    return {
      assigned_to_me: parseInt(result.rows[0].assigned_to_me, 10),
      unassigned_urgent: parseInt(result.rows[0].unassigned_urgent, 10),
      awaiting_my_approval: parseInt(result.rows[0].awaiting_my_approval, 10)
    };
  }

  async getTeamMembers(teamId: string): Promise<{ id: string; full_name: string; email: string; role: string }[]> {
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1
       ORDER BY u.full_name ASC;`,
      [teamId]
    );
    return result.rows;
  }
}

export const workItemsRepository = new WorkItemsRepository();
