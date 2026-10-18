import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/src/app.js';
import { pool } from '../../backend/src/db/pool.js';
import { cleanAndSeedFixture, createItemDirect, TestFixture } from '../integration/setup.js';

describe('Concurrency - Atomic Claim', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await cleanAndSeedFixture();
  });

  it('allows exactly one winner between two parallel claim requests', async () => {
    // 1. Setup OPEN unassigned item
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Contested Incident',
      status: 'OPEN',
      assignee_id: null,
      version: 1
    });

    // 2. Fire 2 claims in parallel
    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/items/${item.id}/claim`)
        .set('Authorization', `Bearer ${fixture.memberA1.token}`),
      request(app)
        .post(`/items/${item.id}/claim`)
        .set('Authorization', `Bearer ${fixture.memberA2.token}`)
    ]);

    // 3. Assert HTTP status codes: one 200 and one 409
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = res1.status === 409 ? res1 : res2;
    const winner = res1.status === 200 ? res1 : res2;
    const winningUserId = res1.status === 200 ? fixture.memberA1.id : fixture.memberA2.id;

    expect(loser.body.error.code).toBe('ALREADY_CLAIMED');
    expect(winner.body.item.assignee_id).toBe(winningUserId);
    expect(winner.body.item.version).toBe(2);

    // 4. Assert Database State
    const dbItem = await pool.query('SELECT assignee_id, status, version FROM work_items WHERE id = $1', [item.id]);
    expect(dbItem.rows[0].assignee_id).toBe(winningUserId);
    expect(dbItem.rows[0].status).toBe('IN_PROGRESS');
    expect(dbItem.rows[0].version).toBe(2);

    // 5. Exactly ONE CLAIMED activity event exists
    const events = await pool.query(
      "SELECT actor_id, event_type FROM activity_events WHERE work_item_id = $1 AND event_type = 'CLAIMED'",
      [item.id]
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].actor_id).toBe(winningUserId);
  });

  it('guarantees exactly one 200 and nine 409 responses under 10 parallel claims', async () => {
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'High-Contention Incident Ticket',
      status: 'OPEN',
      assignee_id: null,
      version: 1
    });

    // 10 concurrent claim requests
    const promises = Array.from({ length: 10 }, (_, i) => {
      const token = i % 2 === 0 ? fixture.memberA1.token : fixture.memberA2.token;
      return request(app)
        .post(`/items/${item.id}/claim`)
        .set('Authorization', `Bearer ${token}`);
    });

    const responses = await Promise.all(promises);
    const successCount = responses.filter((r) => r.status === 200).length;
    const conflictCount = responses.filter((r) => r.status === 409).length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(9);

    // DB state must show version 2 and status IN_PROGRESS
    const dbItem = await pool.query('SELECT version, status FROM work_items WHERE id = $1', [item.id]);
    expect(dbItem.rows[0].version).toBe(2);
    expect(dbItem.rows[0].status).toBe('IN_PROGRESS');
  });
});
