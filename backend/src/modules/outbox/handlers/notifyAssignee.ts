import { pool } from '../../../db/pool.js';
import { OutboxJob } from '../outbox.repository.js';

/**
 * Idempotent outbox event handler for CLAIMED and ASSIGNED events:
 * Inserts a single notification row for the assignee with ON CONFLICT (outbox_job_id) DO NOTHING.
 * Running the same job multiple times guarantees exactly ONE notification record.
 * 
 * Other known event types (CREATED, STATUS_CHANGED) no-op and complete.
 * Unknown event types throw an Error to trigger retry and dead-lettering.
 */
export async function notifyAssigneeHandler(job: OutboxJob): Promise<void> {
  const eventType = job.event_type;

  if (eventType === 'CLAIMED' || eventType === 'WORK_ITEM_CLAIMED') {
    const payload = job.payload || {};
    const assigneeId = payload.assignee_id;
    if (!assigneeId) return;

    const itemTitle = payload.title || 'Work Item';
    await pool.query(
      `INSERT INTO notifications (outbox_job_id, user_id, title, message)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (outbox_job_id) DO NOTHING;`,
      [
        job.id,
        assigneeId,
        'Work item claimed',
        `Item "${itemTitle}" was claimed.`
      ]
    );
    return;
  }

  if (eventType === 'ASSIGNED' || eventType === 'WORK_ITEM_ASSIGNED') {
    const payload = job.payload || {};
    const assigneeId = payload.assignee_id;
    if (!assigneeId) return;

    const itemTitle = payload.title || 'Work Item';
    await pool.query(
      `INSERT INTO notifications (outbox_job_id, user_id, title, message)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (outbox_job_id) DO NOTHING;`,
      [
        job.id,
        assigneeId,
        'Work item assigned',
        `You were assigned to "${itemTitle}".`
      ]
    );
    return;
  }

  // Known harmless events: complete as no-op
  if (
    eventType === 'CREATED' ||
    eventType === 'WORK_ITEM_CREATED' ||
    eventType === 'STATUS_CHANGED' ||
    eventType === 'WORK_ITEM_STATUS_CHANGED'
  ) {
    return;
  }

  // Unknown event_type: throw to initiate retry backoff and eventual dead-letter
  throw new Error(`Unknown or unhandled outbox event_type: ${eventType}`);
}
