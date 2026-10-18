import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/src/app.js';
import { pool } from '../../backend/src/db/pool.js';
import { workItemsRepository } from '../../backend/src/modules/work-items/work-items.repository.js';
import { cleanAndSeedFixture, createItemDirect, TestFixture } from './setup.js';

describe('Integration - Transactional Atomicity (Rollback on Outbox Failure)', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await cleanAndSeedFixture();
    vi.restoreAllMocks();
  });

  it('rolls back work item creation when outbox insert fails (zero DB writes)', async () => {
    // Spy on insertOutboxJob to simulate an unexpected database / outbox failure
    vi.spyOn(workItemsRepository, 'insertOutboxJob').mockRejectedValueOnce(
      new Error('Simulated Outbox Disk/Network Failure')
    );

    const title = 'Uncommitted Atomicity Item';
    const res = await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .set('Idempotency-Key', 'atomicity-fail-key')
      .send({
        team_id: fixture.teamA.id,
        title,
        type: 'INCIDENT'
      });

    expect(res.status).toBe(500);

    // In DB: Item must NOT exist
    const itemCheck = await pool.query('SELECT count(*) FROM work_items WHERE title = $1', [title]);
    expect(Number(itemCheck.rows[0].count)).toBe(0);

    // In DB: No activity event must exist for this title
    const actCheck = await pool.query(
      "SELECT count(*) FROM activity_events WHERE to_state->>'title' = $1",
      [title]
    );
    expect(Number(actCheck.rows[0].count)).toBe(0);
  });

  it('rolls back atomic claim when outbox insert fails (item remains OPEN and unassigned)', async () => {
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Rollback Claim Item',
      status: 'OPEN',
      assignee_id: null,
      version: 1
    });

    vi.spyOn(workItemsRepository, 'insertOutboxJob').mockRejectedValueOnce(
      new Error('Simulated Outbox Failure during claim')
    );

    const res = await request(app)
      .post(`/items/${item.id}/claim`)
      .set('Authorization', `Bearer ${fixture.memberA1.token}`);

    expect(res.status).toBe(500);

    // In DB: Status and assignee must be unchanged
    const dbItem = await pool.query('SELECT status, assignee_id, version FROM work_items WHERE id = $1', [item.id]);
    expect(dbItem.rows[0].status).toBe('OPEN');
    expect(dbItem.rows[0].assignee_id).toBeNull();
    expect(dbItem.rows[0].version).toBe(1);

    // In DB: No CLAIMED activity event written
    const actCheck = await pool.query(
      "SELECT count(*) FROM activity_events WHERE work_item_id = $1 AND event_type = 'CLAIMED'",
      [item.id]
    );
    expect(Number(actCheck.rows[0].count)).toBe(0);
  });

  it('verifies activity_event and outbox_job are written on successful mutation', async () => {
    const res = await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .set('Idempotency-Key', 'atomicity-success-key')
      .send({
        team_id: fixture.teamA.id,
        title: 'Committed Atomicity Item',
        type: 'TASK'
      });

    expect(res.status).toBe(201);
    const itemId = res.body.item.id;

    // Verify activity event exists
    const act = await pool.query(
      'SELECT event_type, actor_id FROM activity_events WHERE work_item_id = $1',
      [itemId]
    );
    expect(act.rowCount).toBe(1);
    expect(act.rows[0].event_type).toBe('CREATED');
    expect(act.rows[0].actor_id).toBe(fixture.memberA1.id);

    // Verify outbox job exists
    const outbox = await pool.query(
      "SELECT event_type, aggregate_id FROM outbox_jobs WHERE aggregate_id = $1 AND event_type = 'WORK_ITEM_CREATED'",
      [itemId]
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].aggregate_id).toBe(itemId);
  });
});
