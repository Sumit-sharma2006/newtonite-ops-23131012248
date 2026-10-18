import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/src/app.js';
import { pool } from '../../backend/src/db/pool.js';
import { cleanAndSeedFixture, createItemDirect, TestFixture } from '../integration/setup.js';

describe('Concurrency - Optimistic Locking', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await cleanAndSeedFixture();
  });

  it('rejects stale PATCH update with 409 STALE_VERSION and preserves DB state', async () => {
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Original Title',
      status: 'OPEN',
      version: 1
    });

    // 1. Valid update with version 1
    const res1 = await request(app)
      .patch(`/items/${item.id}`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, title: 'Updated Title' });

    expect(res1.status).toBe(200);
    expect(res1.body.item.version).toBe(2);
    expect(res1.body.item.title).toBe('Updated Title');

    // 2. Stale update with version 1 (current is 2)
    const res2 = await request(app)
      .patch(`/items/${item.id}`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, title: 'Stale Overwrite Attempt' });

    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('STALE_VERSION');
    expect(res2.body.error.details.latest_item.version).toBe(2);
    expect(res2.body.error.details.latest_item.title).toBe('Updated Title');

    // 3. Database title was NOT overwritten
    const dbItem = await pool.query('SELECT title, version FROM work_items WHERE id = $1', [item.id]);
    expect(dbItem.rows[0].title).toBe('Updated Title');
    expect(dbItem.rows[0].version).toBe(2);
  });

  it('rejects stale POST /transition and POST /assign requests with 409 STALE_VERSION', async () => {
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      assignee_id: fixture.memberA1.id,
      status: 'IN_PROGRESS',
      version: 2
    });

    // Stale transition with version 1 (current is 2)
    const transRes = await request(app)
      .post(`/items/${item.id}/transition`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, to_status: 'AWAITING_APPROVAL' });

    expect(transRes.status).toBe(409);
    expect(transRes.body.error.code).toBe('STALE_VERSION');
    expect(transRes.body.error.details.latest_item.version).toBe(2);

    // Stale assign with version 1 (current is 2)
    const assignRes = await request(app)
      .post(`/items/${item.id}/assign`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, assignee_id: fixture.memberA2.id });

    expect(assignRes.status).toBe(409);
    expect(assignRes.body.error.code).toBe('STALE_VERSION');
    expect(assignRes.body.error.details.latest_item.version).toBe(2);
  });

  it('resolves two parallel PATCH requests with same version to exactly one 200 and one 409', async () => {
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Initial Race Condition Title',
      status: 'OPEN',
      version: 1
    });

    // Fire 2 simultaneous updates carrying version 1
    const [res1, res2] = await Promise.all([
      request(app)
        .patch(`/items/${item.id}`)
        .set('Authorization', `Bearer ${fixture.leadA.token}`)
        .send({ version: 1, title: 'Update from Client A' }),
      request(app)
        .patch(`/items/${item.id}`)
        .set('Authorization', `Bearer ${fixture.leadA.token}`)
        .send({ version: 1, title: 'Update from Client B' })
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = res1.status === 409 ? res1 : res2;
    expect(loser.body.error.code).toBe('STALE_VERSION');

    const dbItem = await pool.query('SELECT version FROM work_items WHERE id = $1', [item.id]);
    expect(dbItem.rows[0].version).toBe(2);
  });
});
