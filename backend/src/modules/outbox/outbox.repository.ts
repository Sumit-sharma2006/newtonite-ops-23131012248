import { pool } from '../../db/pool.js';

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'DEAD_LETTER';

export interface OutboxJob {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: any;
  status: OutboxStatus;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  locked_at: string | Date | null;
  locked_by: string | null;
  scheduled_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
}

export class OutboxRepository {
  /**
   * Atomically claims a batch of ready outbox jobs using FOR UPDATE SKIP LOCKED CTE.
   * Increments attempt, marks status as PROCESSING, and sets lock timestamp and worker ID.
   */
  async claimBatch(workerId: string, limit = 10): Promise<OutboxJob[]> {
    const sql = `
      WITH ready_jobs AS (
          SELECT id
          FROM outbox_jobs
          WHERE status = 'PENDING'
            AND scheduled_at <= NOW()
          ORDER BY scheduled_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_jobs
      SET status = 'PROCESSING'::outbox_status,
          attempt = attempt + 1,
          locked_at = NOW(),
          locked_by = $1,
          updated_at = NOW()
      FROM ready_jobs
      WHERE outbox_jobs.id = ready_jobs.id
      RETURNING outbox_jobs.*;
    `;

    const result = await pool.query(sql, [workerId, limit]);
    return result.rows;
  }

  /**
   * Marks a job as COMPLETED and releases locks.
   */
  async markCompleted(id: string): Promise<void> {
    await pool.query(
      `UPDATE outbox_jobs
       SET status = 'COMPLETED'::outbox_status,
           locked_at = NULL,
           locked_by = NULL,
           updated_at = NOW()
       WHERE id = $1;`,
      [id]
    );
  }

  /**
   * Marks a job as FAILED:
   * - If attempt >= max_attempts: moves status to DEAD_LETTER and keeps last_error.
   * - Else: returns status to PENDING with exponential backoff + jitter up to 1s.
   * Releases worker lock in both cases.
   */
  async markFailed(id: string, error: string): Promise<void> {
    const sql = `
      UPDATE outbox_jobs
      SET status = CASE 
            WHEN attempt >= max_attempts THEN 'DEAD_LETTER'::outbox_status 
            ELSE 'PENDING'::outbox_status 
          END,
          last_error = $2,
          scheduled_at = CASE 
            WHEN attempt >= max_attempts THEN scheduled_at
            ELSE NOW() + (LEAST(300, 2 * POWER(2, GREATEST(0, attempt - 1))) || ' seconds')::INTERVAL 
                       + (RANDOM() * 1000 || ' milliseconds')::INTERVAL
          END,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = NOW()
      WHERE id = $1;
    `;

    await pool.query(sql, [id, error]);
  }

  /**
   * Recovers stuck jobs from crashed workers:
   * Resets jobs in PROCESSING state whose locked_at is older than the threshold back to PENDING.
   * Parameterized threshold allows unit/integration tests to supply small intervals.
   */
  async recoverStuck(olderThanSeconds = 300): Promise<number> {
    const sql = `
      UPDATE outbox_jobs
      SET status = 'PENDING'::outbox_status,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = NOW()
      WHERE status = 'PROCESSING'
        AND locked_at < NOW() - ($1::text || ' seconds')::INTERVAL;
    `;

    const result = await pool.query(sql, [olderThanSeconds]);
    return result.rowCount ?? 0;
  }
}

export const outboxRepository = new OutboxRepository();
