import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/src/app.js';
import { pool } from '../../backend/src/db/pool.js';
import { cleanAndSeedFixture, createItemDirect, TestFixture } from './setup.js';

describe('Integration - Authorization & Resource-Level Security', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await cleanAndSeedFixture();
  });

  it('masks cross-team access with 404 NOT_FOUND across all item endpoints for users outside the team', async () => {
    // Team A item
    const itemA = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Secret Team A Item',
      status: 'OPEN',
      version: 1
    });

    const bToken = fixture.memberB.token; // Member only in Team B

    // 1. GET /items/:id -> 404
    const resGet = await request(app).get(`/items/${itemA.id}`).set('Authorization', `Bearer ${bToken}`);
    expect(resGet.status).toBe(404);
    expect(resGet.body.error.code).toBe('NOT_FOUND');

    // 2. GET /items/:id/activity -> 404
    const resAct = await request(app).get(`/items/${itemA.id}/activity`).set('Authorization', `Bearer ${bToken}`);
    expect(resAct.status).toBe(404);

    // 3. POST /items/:id/claim -> 404
    const resClaim = await request(app).post(`/items/${itemA.id}/claim`).set('Authorization', `Bearer ${bToken}`);
    expect(resClaim.status).toBe(404);

    // 4. POST /items/:id/transition -> 404
    const resTrans = await request(app)
      .post(`/items/${itemA.id}/transition`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ version: 1, to_status: 'IN_PROGRESS' });
    expect(resTrans.status).toBe(404);

    // 5. POST /items/:id/comments -> 404
    const resComment = await request(app)
      .post(`/items/${itemA.id}/comments`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ body: 'Cross-team eavesdropping' });
    expect(resComment.status).toBe(404);

    // 6. PATCH /items/:id -> 404
    const resPatch = await request(app)
      .patch(`/items/${itemA.id}`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ version: 1, title: 'Hacked Title' });
    expect(resPatch.status).toBe(404);

    // Assert DB was completely unmodified
    const dbItem = await pool.query('SELECT title, status, version FROM work_items WHERE id = $1', [itemA.id]);
    expect(dbItem.rows[0].title).toBe('Secret Team A Item');
    expect(dbItem.rows[0].status).toBe('OPEN');
    expect(dbItem.rows[0].version).toBe(1);
  });

  it('rejects listing foreign team items with 403 NOT_TEAM_MEMBER and isolates un-scoped list to user teams', async () => {
    // 1. Querying explicit foreign team -> 403
    const resForeign = await request(app)
      .get(`/items?team_id=${fixture.teamA.id}`)
      .set('Authorization', `Bearer ${fixture.memberB.token}`);
    expect(resForeign.status).toBe(403);
    expect(resForeign.body.error.code).toBe('NOT_TEAM_MEMBER');

    // 2. Querying without team_id returns ONLY user's team items
    await createItemDirect({ team_id: fixture.teamA.id, created_by_id: fixture.leadA.id, title: 'Item Alpha' });
    await createItemDirect({ team_id: fixture.teamB.id, created_by_id: fixture.memberB.id, title: 'Item Beta' });

    const resBList = await request(app).get('/items').set('Authorization', `Bearer ${fixture.memberB.token}`);
    expect(resBList.status).toBe(200);
    expect(resBList.body.items.every((it: any) => it.team_id === fixture.teamB.id)).toBe(true);
  });

  it('enforces Viewer permissions correctly: read 200, comment 201, mutations 403 INSUFFICIENT_TEAM_ROLE', async () => {
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Viewer Test Item',
      status: 'OPEN',
      version: 1
    });

    const vToken = fixture.viewerA.token;

    // View -> 200 OK
    const resView = await request(app).get(`/items/${item.id}`).set('Authorization', `Bearer ${vToken}`);
    expect(resView.status).toBe(200);

    // Comment -> 201 Created
    const resComment = await request(app)
      .post(`/items/${item.id}/comments`)
      .set('Authorization', `Bearer ${vToken}`)
      .send({ body: 'Auditor review note' });
    expect(resComment.status).toBe(201);

    // Claim -> 403
    const resClaim = await request(app).post(`/items/${item.id}/claim`).set('Authorization', `Bearer ${vToken}`);
    expect(resClaim.status).toBe(403);
    expect(resClaim.body.error.code).toBe('INSUFFICIENT_TEAM_ROLE');

    // Create item -> 403
    const resCreate = await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${vToken}`)
      .set('Idempotency-Key', 'v-key-1')
      .send({ team_id: fixture.teamA.id, title: 'Viewer Create Attempt', type: 'TASK' });
    expect(resCreate.status).toBe(403);
    expect(resCreate.body.error.code).toBe('INSUFFICIENT_TEAM_ROLE');

    // Patch -> 403
    const resPatch = await request(app)
      .patch(`/items/${item.id}`)
      .set('Authorization', `Bearer ${vToken}`)
      .send({ version: 1, title: 'Modified' });
    expect(resPatch.status).toBe(403);
    expect(resPatch.body.error.code).toBe('INSUFFICIENT_TEAM_ROLE');
  });

  it('rejects Member (non-lead) from changing priority with 403 INSUFFICIENT_TEAM_ROLE', async () => {
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      priority: 'LOW',
      version: 1
    });

    const res = await request(app)
      .patch(`/items/${item.id}`)
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .send({ version: 1, priority: 'URGENT' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_TEAM_ROLE');
  });

  it('rejects requests with missing or invalid tokens with 401', async () => {
    // Missing token
    const resMissing = await request(app).get('/items');
    expect(resMissing.status).toBe(401);

    // Invalid token
    const resInvalid = await request(app).get('/items').set('Authorization', 'Bearer invalid.jwt.token');
    expect(resInvalid.status).toBe(401);
  });
});
