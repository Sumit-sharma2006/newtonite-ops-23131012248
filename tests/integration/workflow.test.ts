import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/src/app.js';
import { cleanAndSeedFixture, createItemDirect, TestFixture } from './setup.js';

describe('Integration - Workflow State Machine & Four-Eyes Enforcement', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await cleanAndSeedFixture();
  });

  it('rejects Member from closing an OPEN item (requires Lead/Admin) and rejects invalid transitions', async () => {
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      status: 'OPEN',
      version: 1
    });

    // Member closing open item -> 403
    const resMemberClose = await request(app)
      .post(`/items/${item.id}/transition`)
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .send({ version: 1, to_status: 'CLOSED', reason: 'Invalid test item' });

    expect(resMemberClose.status).toBe(403);
    expect(resMemberClose.body.error.code).toBe('INSUFFICIENT_TEAM_ROLE');

    // Invalid transition OPEN -> RESOLVED -> 403 with INVALID_TRANSITION
    const resInvalid = await request(app)
      .post(`/items/${item.id}/transition`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, to_status: 'RESOLVED' });

    expect(resInvalid.status).toBe(403);
    expect(resInvalid.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('forbids direct resolution on INCIDENT but allows direct resolution on TASK by Lead', async () => {
    // 1. INCIDENT: IN_PROGRESS -> RESOLVED directly is rejected
    const incident = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      type: 'INCIDENT',
      status: 'IN_PROGRESS',
      assignee_id: fixture.leadA.id,
      version: 1
    });

    const resIncident = await request(app)
      .post(`/items/${incident.id}/transition`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, to_status: 'RESOLVED' });

    expect(resIncident.status).toBe(403);
    expect(resIncident.body.error.code).toBe('APPROVAL_REQUIRED');

    // 2. TASK: IN_PROGRESS -> RESOLVED by Lead is allowed
    const task = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      type: 'TASK',
      status: 'IN_PROGRESS',
      assignee_id: fixture.leadA.id,
      version: 1
    });

    const resTask = await request(app)
      .post(`/items/${task.id}/transition`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, to_status: 'RESOLVED' });

    expect(resTask.status).toBe(200);
    expect(resTask.body.item.status).toBe('RESOLVED');
  });

  it('enforces FOUR-EYES PRINCIPLE: creator cannot approve own item, different Lead can approve', async () => {
    // Lead Alice creates an item and submits it to AWAITING_APPROVAL
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.leadA.id,
      type: 'COMPLIANCE',
      status: 'AWAITING_APPROVAL',
      assignee_id: fixture.memberA1.id,
      version: 1
    });

    // 1. Member tries to approve -> 403 APPROVAL_REQUIRES_LEAD_ROLE
    const resMember = await request(app)
      .post(`/items/${item.id}/transition`)
      .set('Authorization', `Bearer ${fixture.memberA1.token}`)
      .send({ version: 1, to_status: 'RESOLVED' });

    expect(resMember.status).toBe(403);
    expect(resMember.body.error.code).toBe('APPROVAL_REQUIRES_LEAD_ROLE');

    // 2. Creator (Lead Alice) tries to approve her own item -> 403 CANNOT_APPROVE_OWN_ITEM
    const resCreator = await request(app)
      .post(`/items/${item.id}/transition`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, to_status: 'RESOLVED' });

    expect(resCreator.status).toBe(403);
    expect(resCreator.body.error.code).toBe('CANNOT_APPROVE_OWN_ITEM');

    // 3. DualUser is a Lead in Team B, but Viewer in Team A.
    // Let's create an item created by memberA1, so Lead Alice can approve it!
    const memberItem = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.memberA1.id, // Member created
      type: 'PAYMENT',
      status: 'AWAITING_APPROVAL',
      assignee_id: fixture.memberA1.id,
      version: 1
    });

    // Lead Alice approves member's item -> 200 OK
    const resDiffLead = await request(app)
      .post(`/items/${memberItem.id}/transition`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, to_status: 'RESOLVED' });

    expect(resDiffLead.status).toBe(200);
    expect(resDiffLead.body.item.status).toBe('RESOLVED');
  });

  it('requires a mandatory reason when rejecting an item (AWAITING_APPROVAL -> IN_PROGRESS)', async () => {
    const item = await createItemDirect({
      team_id: fixture.teamA.id,
      created_by_id: fixture.memberA1.id,
      status: 'AWAITING_APPROVAL',
      assignee_id: fixture.memberA1.id,
      version: 1
    });

    // Reject without reason -> 400 REASON_REQUIRED
    const resNoReason = await request(app)
      .post(`/items/${item.id}/transition`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, to_status: 'IN_PROGRESS' });

    expect(resNoReason.status).toBe(400);
    expect(resNoReason.body.error.code).toBe('REASON_REQUIRED');

    // Reject with reason -> 200 OK
    const resWithReason = await request(app)
      .post(`/items/${item.id}/transition`)
      .set('Authorization', `Bearer ${fixture.leadA.token}`)
      .send({ version: 1, to_status: 'IN_PROGRESS', reason: 'Missing unit test coverage' });

    expect(resWithReason.status).toBe(200);
    expect(resWithReason.body.item.status).toBe('IN_PROGRESS');
  });
});
