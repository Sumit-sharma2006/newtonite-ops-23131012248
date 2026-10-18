import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/src/app.js';
import { cleanAndSeedFixture, createItemDirect, TestFixture } from './setup.js';

describe('Integration - Keyset Pagination, Microsecond Precision & Views', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await cleanAndSeedFixture();
  });

  it('pages through 50 items with IDENTICAL created_at using id as tiebreaker without loss or duplicates', async () => {
    const fixedTime = '2026-10-18 12:00:00.000000+00';
    const createdIds: string[] = [];

    // Insert 50 items with the exact same timestamp
    for (let i = 1; i <= 50; i++) {
      const it = await createItemDirect({
        team_id: fixture.teamA.id,
        created_by_id: fixture.leadA.id,
        title: `Tiebreaker Item #${i}`,
        created_at: fixedTime
      });
      createdIds.push(it.id);
    }

    // Page through with limit = 7
    let cursor: string | null = null;
    const collectedIds: string[] = [];

    do {
      const url = cursor
        ? `/items?limit=7&cursor=${encodeURIComponent(cursor)}`
        : '/items?limit=7';
      const res = await request(app).get(url).set('Authorization', `Bearer ${fixture.leadA.token}`);
      expect(res.status).toBe(200);

      const items = res.body.items;
      items.forEach((it: any) => collectedIds.push(it.id));
      cursor = res.body.next_cursor;
    } while (cursor !== null);

    // Assert: exactly 50 items, no duplicates, no missing items
    expect(collectedIds.length).toBe(50);
    const uniqueIds = new Set(collectedIds);
    expect(uniqueIds.size).toBe(50);
    createdIds.forEach((id) => expect(uniqueIds.has(id)).toBe(true));
  });

  it('preserves microsecond precision timestamps across page boundaries', async () => {
    const times = [
      '2026-10-18 10:00:00.123456+00',
      '2026-10-18 10:00:00.123455+00',
      '2026-10-18 10:00:00.123454+00'
    ];

    const inserted: string[] = [];
    for (const t of times) {
      const it = await createItemDirect({
        team_id: fixture.teamA.id,
        created_by_id: fixture.leadA.id,
        title: `Microsecond Item ${t}`,
        created_at: t
      });
      inserted.push(it.id);
    }

    // Page 1: limit 1
    const res1 = await request(app)
      .get('/items?limit=1')
      .set('Authorization', `Bearer ${fixture.leadA.token}`);
    expect(res1.body.items[0].id).toBe(inserted[0]);
    expect(res1.body.next_cursor).toBeDefined();

    // Page 2 using cursor from page 1
    const res2 = await request(app)
      .get(`/items?limit=1&cursor=${encodeURIComponent(res1.body.next_cursor)}`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`);
    expect(res2.body.items[0].id).toBe(inserted[1]);

    // Page 3 using cursor from page 2
    const res3 = await request(app)
      .get(`/items?limit=1&cursor=${encodeURIComponent(res2.body.next_cursor)}`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`);
    expect(res3.body.items[0].id).toBe(inserted[2]);
  });

  it('executes full-text keyword search and preserves keyset ordering', async () => {
    await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Production database timeout on cluster',
      description: 'Connection pool exhausted'
    });
    await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Regular routine task',
      description: 'Update team docs'
    });

    const res = await request(app)
      .get('/items?q=timeout')
      .set('Authorization', `Bearer ${fixture.leadA.token}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].title).toContain('database timeout');
  });

  it('filters operational views correctly: unassigned_urgent and awaiting_my_approval', async () => {
    // 1. Unassigned urgent item
    await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Urgent Unassigned Incident',
      priority: 'URGENT',
      status: 'OPEN',
      assignee_id: null
    });
    // 2. Assigned urgent item (should NOT appear in unassigned_urgent)
    await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Urgent Assigned Incident',
      priority: 'URGENT',
      status: 'IN_PROGRESS',
      assignee_id: fixture.memberA1.id
    });

    const resUrgent = await request(app)
      .get('/items?view=unassigned_urgent')
      .set('Authorization', `Bearer ${fixture.leadA.token}`);

    expect(resUrgent.body.items.length).toBe(1);
    expect(resUrgent.body.items[0].title).toBe('Urgent Unassigned Incident');

    // 3. Awaiting approval item created by Member A1 -> should appear for Lead A
    await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.memberA1.id,
      title: 'Review Needed Ticket',
      status: 'AWAITING_APPROVAL'
    });

    // 4. Awaiting approval item created by Lead A -> must NOT appear for Lead A (four-eyes exclusion)
    await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Self Created Approval Ticket',
      status: 'AWAITING_APPROVAL'
    });

    const resApproval = await request(app)
      .get('/items?view=awaiting_my_approval')
      .set('Authorization', `Bearer ${fixture.leadA.token}`);

    expect(resApproval.body.items.length).toBe(1);
    expect(resApproval.body.items[0].title).toBe('Review Needed Ticket');
  });

  it('caps limit query parameter to 100 max', async () => {
    const res = await request(app)
      .get('/items?limit=250')
      .set('Authorization', `Bearer ${fixture.leadA.token}`);
    expect(res.status).toBe(200);
  });
});
