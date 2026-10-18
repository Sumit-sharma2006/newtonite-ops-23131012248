import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/src/app.js';
import { pool } from '../../backend/src/db/pool.js';
import { cleanAndSeedFixture, createItemDirect, TestFixture } from './setup.js';
import { outboxRepository } from '../../backend/src/modules/outbox/outbox.repository.js';
import { outboxService, defaultHandlers } from '../../backend/src/modules/outbox/outbox.service.js';

describe('Integration - Transactional Outbox Worker & Retries', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await cleanAndSeedFixture();
  });

  it('a) Successful claim via POST /items/:id/claim creates an outbox job in the same transaction; processBatch completes it and exactly ONE notification exists for the claimer', async () => {
    // 1. Create an open unassigned item
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Claim Outbox Verification Item',
      status: 'OPEN',
      assignee_id: null,
      version: 1
    });

    // 2. Claim the item via API
    const claimRes = await request(app)
      .post(`/items/${item.id}/claim`)
      .set('Authorization', `Bearer ${fixture.memberA1.token}`);

    expect(claimRes.status).toBe(200);

    // 3. Verify outbox job was created in the SAME transaction
    const outboxCheck = await pool.query(
      `SELECT id, event_type, aggregate_id, payload, status, attempt
       FROM outbox_jobs
       WHERE aggregate_id = $1 AND event_type = 'CLAIMED';`,
      [item.id]
    );

    expect(outboxCheck.rowCount).toBe(1);
    const job = outboxCheck.rows[0];
    expect(job.status).toBe('PENDING');
    expect(job.attempt).toBe(0);
    expect(job.payload.work_item_id).toBe(item.id);
    expect(job.payload.assignee_id).toBe(fixture.memberA1.id);
    expect(job.payload.title).toBe('Claim Outbox Verification Item');

    // 4. Run outbox service processBatch
    const batchRes = await outboxService.processBatch('worker-test-a', defaultHandlers, 10);
    expect(batchRes.claimedCount).toBeGreaterThanOrEqual(1);
    expect(batchRes.succeededCount).toBeGreaterThanOrEqual(1);

    // 5. Verify DB state: job is COMPLETED and notification exists
    const completedJob = await pool.query(
      `SELECT status, locked_at, locked_by FROM outbox_jobs WHERE id = $1;`,
      [job.id]
    );
    expect(completedJob.rows[0].status).toBe('COMPLETED');
    expect(completedJob.rows[0].locked_at).toBeNull();
    expect(completedJob.rows[0].locked_by).toBeNull();

    const notifCheck = await pool.query(
      `SELECT id, outbox_job_id, user_id, title, message
       FROM notifications
       WHERE outbox_job_id = $1;`,
      [job.id]
    );
    expect(notifCheck.rowCount).toBe(1);
    expect(notifCheck.rows[0].user_id).toBe(fixture.memberA1.id);
    expect(notifCheck.rows[0].title).toBe('Work item claimed');
  });

  it('b) Same job processed twice (reset status to PENDING manually and run processBatch again) -> still exactly ONE notification', async () => {
    // 1. Insert a CLAIMED outbox job
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      title: 'Idempotent Notification Test Item',
      status: 'IN_PROGRESS',
      assignee_id: fixture.memberA1.id,
      version: 2
    });

    const jobRes = await pool.query(
      `INSERT INTO outbox_jobs (event_type, aggregate_type, aggregate_id, payload, status, scheduled_at)
       VALUES ('CLAIMED', 'WORK_ITEM', $1, $2, 'PENDING', NOW())
       RETURNING id;`,
      [
        item.id,
        JSON.stringify({
          work_item_id: item.id,
          assignee_id: fixture.memberA1.id,
          title: item.title,
          actor_id: fixture.memberA1.id
        })
      ]
    );
    const jobId = jobRes.rows[0].id;

    // 2. First execution of processBatch
    const run1 = await outboxService.processBatch('worker-test-b1');
    expect(run1.succeededCount).toBe(1);

    const notifs1 = await pool.query(
      `SELECT count(*) FROM notifications WHERE outbox_job_id = $1;`,
      [jobId]
    );
    expect(Number(notifs1.rows[0].count)).toBe(1);

    // 3. Manually reset job status back to PENDING (simulating retry or replay)
    await pool.query(
      `UPDATE outbox_jobs SET status = 'PENDING', locked_at = NULL, locked_by = NULL WHERE id = $1;`,
      [jobId]
    );

    // 4. Second execution of processBatch
    const run2 = await outboxService.processBatch('worker-test-b2');
    expect(run2.succeededCount).toBe(1);

    // 5. Must STILL be exactly ONE notification due to UNIQUE(outbox_job_id) and ON CONFLICT DO NOTHING
    const notifs2 = await pool.query(
      `SELECT count(*) FROM notifications WHERE outbox_job_id = $1;`,
      [jobId]
    );
    expect(Number(notifs2.rows[0].count)).toBe(1);
  });

  it('c) Failing handler: job fails, status returns to PENDING, attempt incremented, scheduled_at in the future, last_error set. Then set scheduled_at to NOW() manually and run again, repeat until attempt == max_attempts -> status DEAD_LETTER, last_error kept', async () => {
    // 1. Insert a job with max_attempts = 3 for deterministic testing
    const insertRes = await pool.query(
      `INSERT INTO outbox_jobs (event_type, aggregate_type, aggregate_id, payload, status, max_attempts, scheduled_at)
       VALUES ('CLAIMED', 'WORK_ITEM', gen_random_uuid(), $1, 'PENDING', 3, NOW())
       RETURNING id, max_attempts;`,
      [
        JSON.stringify({
          work_item_id: 'dummy',
          assignee_id: fixture.memberA1.id,
          title: 'Failing Job Test'
        })
      ]
    );
    const jobId = insertRes.rows[0].id;
    const maxAttempts = insertRes.rows[0].max_attempts; // 3

    // Injected failing handler
    const failingHandlers = {
      CLAIMED: async () => {
        throw new Error('External Notification Service Unavailable');
      }
    };

    // Attempt 1: First failure
    const res1 = await outboxService.processBatch('worker-c', failingHandlers);
    expect(res1.failedCount).toBe(1);

    const check1 = await pool.query(
      `SELECT status, attempt, last_error, scheduled_at, locked_at, locked_by,
              scheduled_at > NOW() as in_future
       FROM outbox_jobs WHERE id = $1;`,
      [jobId]
    );
    expect(check1.rows[0].status).toBe('PENDING');
    expect(check1.rows[0].attempt).toBe(1);
    expect(check1.rows[0].last_error).toBe('External Notification Service Unavailable');
    expect(check1.rows[0].in_future).toBe(true);
    expect(check1.rows[0].locked_at).toBeNull();
    expect(check1.rows[0].locked_by).toBeNull();

    // Attempt 2: Manually set scheduled_at = NOW() and run again
    await pool.query(`UPDATE outbox_jobs SET scheduled_at = NOW() WHERE id = $1;`, [jobId]);
    const res2 = await outboxService.processBatch('worker-c', failingHandlers);
    expect(res2.failedCount).toBe(1);

    const check2 = await pool.query(
      `SELECT status, attempt, last_error FROM outbox_jobs WHERE id = $1;`,
      [jobId]
    );
    expect(check2.rows[0].status).toBe('PENDING');
    expect(check2.rows[0].attempt).toBe(2);

    // Attempt 3 (attempt == max_attempts): Final failure moves to DEAD_LETTER
    await pool.query(`UPDATE outbox_jobs SET scheduled_at = NOW() WHERE id = $1;`, [jobId]);
    const res3 = await outboxService.processBatch('worker-c', failingHandlers);
    expect(res3.failedCount).toBe(1);

    const check3 = await pool.query(
      `SELECT status, attempt, last_error, locked_at, locked_by FROM outbox_jobs WHERE id = $1;`,
      [jobId]
    );
    expect(check3.rows[0].status).toBe('DEAD_LETTER');
    expect(check3.rows[0].attempt).toBe(maxAttempts); // 3
    expect(check3.rows[0].last_error).toBe('External Notification Service Unavailable');
    expect(check3.rows[0].locked_at).toBeNull();
    expect(check3.rows[0].locked_by).toBeNull();
  });

  it('d) Two concurrent processBatch calls (Promise.all, different workerIds) over 20 pending jobs: every job is processed exactly once (20 notifications, no duplicates), and no job is claimed by both workers', async () => {
    // 1. Seed 20 pending outbox jobs
    const jobIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await pool.query(
        `INSERT INTO outbox_jobs (event_type, aggregate_type, aggregate_id, payload, status, scheduled_at)
         VALUES ('CLAIMED', 'WORK_ITEM', gen_random_uuid(), $1, 'PENDING', NOW())
         RETURNING id;`,
        [
          JSON.stringify({
            work_item_id: `item-${i}`,
            assignee_id: fixture.memberA1.id,
            title: `Concurrent Batch Item ${i}`
          })
        ]
      );
      jobIds.push(res.rows[0].id);
    }

    // 2. Run two concurrent processBatch calls with different worker IDs
    const [batch1, batch2] = await Promise.all([
      outboxService.processBatch('worker-alpha', defaultHandlers, 20),
      outboxService.processBatch('worker-bravo', defaultHandlers, 20)
    ]);

    // 3. Verify total claimed and processed
    const totalClaimed = batch1.claimedCount + batch2.claimedCount;
    const totalSucceeded = batch1.succeededCount + batch2.succeededCount;
    expect(totalClaimed).toBe(20);
    expect(totalSucceeded).toBe(20);

    // 4. Verify mutually exclusive claim: NO job claimed by both workers
    const batch1JobIds = new Set(batch1.jobs.map((j) => j.id));
    for (const job of batch2.jobs) {
      expect(batch1JobIds.has(job.id)).toBe(false);
    }

    // 5. Verify database state: exactly 20 notifications created
    const notifs = await pool.query(
      `SELECT count(*) FROM notifications WHERE outbox_job_id = ANY($1::uuid[]);`,
      [jobIds]
    );
    expect(Number(notifs.rows[0].count)).toBe(20);

    // All jobs COMPLETED
    const completed = await pool.query(
      `SELECT count(*) FROM outbox_jobs WHERE id = ANY($1::uuid[]) AND status = 'COMPLETED';`,
      [jobIds]
    );
    expect(Number(completed.rows[0].count)).toBe(20);
  });

  it('e) recoverStuck: a PROCESSING job with locked_at older than the threshold goes back to PENDING; a fresh PROCESSING job is untouched', async () => {
    // 1. Job 1: Stuck job (locked 10 minutes ago by crashed worker)
    const stuckRes = await pool.query(
      `INSERT INTO outbox_jobs (event_type, aggregate_type, aggregate_id, payload, status, locked_at, locked_by)
       VALUES ('CLAIMED', 'WORK_ITEM', gen_random_uuid(), '{}', 'PROCESSING', NOW() - INTERVAL '10 minutes', 'crashed-worker-99')
       RETURNING id;`
    );
    const stuckJobId = stuckRes.rows[0].id;

    // 2. Job 2: Fresh active job (locked right now by active worker)
    const freshRes = await pool.query(
      `INSERT INTO outbox_jobs (event_type, aggregate_type, aggregate_id, payload, status, locked_at, locked_by)
       VALUES ('CLAIMED', 'WORK_ITEM', gen_random_uuid(), '{}', 'PROCESSING', NOW(), 'active-worker-101')
       RETURNING id;`
    );
    const freshJobId = freshRes.rows[0].id;

    // 3. Run recoverStuck with 300s threshold
    const recoveredCount = await outboxRepository.recoverStuck(300);
    expect(recoveredCount).toBe(1);

    // 4. Assert stuck job is reset to PENDING and unlocked
    const stuckCheck = await pool.query(
      `SELECT status, locked_at, locked_by FROM outbox_jobs WHERE id = $1;`,
      [stuckJobId]
    );
    expect(stuckCheck.rows[0].status).toBe('PENDING');
    expect(stuckCheck.rows[0].locked_at).toBeNull();
    expect(stuckCheck.rows[0].locked_by).toBeNull();

    // 5. Assert fresh job is untouched
    const freshCheck = await pool.query(
      `SELECT status, locked_at, locked_by FROM outbox_jobs WHERE id = $1;`,
      [freshJobId]
    );
    expect(freshCheck.rows[0].status).toBe('PROCESSING');
    expect(freshCheck.rows[0].locked_by).toBe('active-worker-101');
    expect(freshCheck.rows[0].locked_at).not.toBeNull();
  });

  it('f) A job scheduled in the future (scheduled_at > NOW()) is not claimed', async () => {
    // 1. Insert a job scheduled 1 hour in the future
    const futureRes = await pool.query(
      `INSERT INTO outbox_jobs (event_type, aggregate_type, aggregate_id, payload, status, scheduled_at)
       VALUES ('CLAIMED', 'WORK_ITEM', gen_random_uuid(), '{}', 'PENDING', NOW() + INTERVAL '1 hour')
       RETURNING id;`
    );
    const futureJobId = futureRes.rows[0].id;

    // 2. Run processBatch
    const batch = await outboxService.processBatch('worker-future-test', defaultHandlers, 10);
    expect(batch.claimedCount).toBe(0);

    // 3. Verify job was NOT claimed or touched
    const check = await pool.query(
      `SELECT status, attempt, locked_at, locked_by FROM outbox_jobs WHERE id = $1;`,
      [futureJobId]
    );
    expect(check.rows[0].status).toBe('PENDING');
    expect(check.rows[0].attempt).toBe(0);
    expect(check.rows[0].locked_at).toBeNull();
    expect(check.rows[0].locked_by).toBeNull();
  });
});
