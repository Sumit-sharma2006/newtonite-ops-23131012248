import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/src/app.js';
import { pool } from '../../backend/src/db/pool.js';
import { cleanAndSeedFixture, TestFixture } from '../integration/setup.js';

describe('Concurrency - Idempotency Keys', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await cleanAndSeedFixture();
  });

  it('replays identical response with Idempotency-Replay header and creates exactly 1 DB row on duplicate key', async () => {
    const key = 'idem-test-key-sequential';
    const body = {
      team_id: fixture.teamA.id,
      title: 'Database Disk Spike',
      description: 'Disk utilization over 85%',
      type: 'INCIDENT',
      priority: 'HIGH'
    };

    // First request
    const res1 = await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res1.status).toBe(201);
    expect(res1.body.item.id).toBeDefined();
    expect(res1.headers['idempotency-replay']).toBeUndefined();

    // Second request with exact same key and body
    const res2 = await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res2.status).toBe(201);
    expect(res2.headers['idempotency-replay']).toBe('true');
    expect(res2.body.item.id).toBe(res1.body.item.id);

    // Database verification: exactly one item was written
    const count = await pool.query(
      'SELECT count(*) FROM work_items WHERE title = $1',
      [body.title]
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('handles two identical keys sent IN PARALLEL safely: exactly 1 DB row and both return same id', async () => {
    const key = 'idem-test-key-parallel';
    const body = {
      team_id: fixture.teamA.id,
      title: 'Payment Gateway Timeout',
      type: 'PAYMENT',
      priority: 'URGENT'
    };

    // Send two requests with the same key simultaneously
    const [res1, res2] = await Promise.all([
      request(app)
        .post('/items')
        .set('Authorization', `Bearer ${fixture.memberA1.token}`)
        .set('Idempotency-Key', key)
        .send(body),
      request(app)
        .post('/items')
        .set('Authorization', `Bearer ${fixture.memberA1.token}`)
        .set('Idempotency-Key', key)
        .send(body)
    ]);

    expect([res1.status, res2.status]).toEqual([201, 201]);
    expect(res1.body.item.id).toBe(res2.body.item.id);

    const count = await pool.query(
      'SELECT count(*) FROM work_items WHERE title = $1',
      [body.title]
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('rejects duplicate key with DIFFERENT payload with 422 IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
    const key = 'idem-test-key-tamper';
    const originalBody = {
      team_id: fixture.teamA.id,
      title: 'Original Incident Title',
      type: 'INCIDENT'
    };
    const tamperedBody = {
      team_id: fixture.teamA.id,
      title: 'Tampered Incident Title',
      type: 'TASK'
    };

    // Original request succeeds
    await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .set('Idempotency-Key', key)
      .send(originalBody)
      .expect(201);

    // Second request with same key but different body fails
    const res = await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .set('Idempotency-Key', key)
      .send(tamperedBody);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('returns 400 IDEMPOTENCY_KEY_REQUIRED if header is missing', async () => {
    const res = await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .send({
        team_id: fixture.teamA.id,
        title: 'Missing Key Item',
        type: 'TASK'
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
