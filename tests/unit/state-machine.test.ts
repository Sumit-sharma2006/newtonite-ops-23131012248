import { describe, it, expect } from 'vitest';
import { validateTransition } from '../../backend/src/modules/work-items/state-machine.js';
import { UserTeamRole, WorkItemStatus, WorkItemType } from '../../backend/src/types/domain.js';

describe('State Machine Module - validateTransition()', () => {
  const ALICE_ID = 'user-alice-creator';
  const BOB_ID = 'user-bob-lead';
  const CHARLIE_ID = 'user-charlie-member';

  describe('Transition: OPEN -> IN_PROGRESS', () => {
    it('allows Member, Lead, and Admin to start work/claim', () => {
      (['MEMBER', 'LEAD', 'ADMIN'] as UserTeamRole[]).forEach((role) => {
        const res = validateTransition({
          from: 'OPEN',
          to: 'IN_PROGRESS',
          role,
          type: 'TASK',
          actorId: CHARLIE_ID,
          createdById: ALICE_ID,
          assigneeId: null
        });
        expect(res.allowed).toBe(true);
      });
    });

    it('rejects Viewer from moving OPEN to IN_PROGRESS', () => {
      const res = validateTransition({
        from: 'OPEN',
        to: 'IN_PROGRESS',
        role: 'VIEWER',
        type: 'TASK',
        actorId: CHARLIE_ID,
        createdById: ALICE_ID,
        assigneeId: null
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });
  });

  describe('Transition: OPEN -> CLOSED', () => {
    it('allows Lead and Admin to discard/close open items', () => {
      (['LEAD', 'ADMIN'] as UserTeamRole[]).forEach((role) => {
        const res = validateTransition({
          from: 'OPEN',
          to: 'CLOSED',
          role,
          type: 'INCIDENT',
          actorId: BOB_ID,
          createdById: ALICE_ID,
          assigneeId: null
        });
        expect(res.allowed).toBe(true);
      });
    });

    it('rejects Member and Viewer from discarding open items', () => {
      (['MEMBER', 'VIEWER'] as UserTeamRole[]).forEach((role) => {
        const res = validateTransition({
          from: 'OPEN',
          to: 'CLOSED',
          role,
          type: 'INCIDENT',
          actorId: CHARLIE_ID,
          createdById: ALICE_ID,
          assigneeId: null
        });
        expect(res.allowed).toBe(false);
        if (!res.allowed) {
          expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
        }
      });
    });
  });

  describe('Transition: IN_PROGRESS -> OPEN', () => {
    it('allows current assignee to release item', () => {
      const res = validateTransition({
        from: 'IN_PROGRESS',
        to: 'OPEN',
        role: 'MEMBER',
        type: 'TASK',
        actorId: CHARLIE_ID,
        createdById: ALICE_ID,
        assigneeId: CHARLIE_ID // actor is assignee
      });
      expect(res.allowed).toBe(true);
    });

    it('allows Lead or Admin to release item even if not assignee', () => {
      const res = validateTransition({
        from: 'IN_PROGRESS',
        to: 'OPEN',
        role: 'LEAD',
        type: 'TASK',
        actorId: BOB_ID,
        createdById: ALICE_ID,
        assigneeId: CHARLIE_ID // Charlie is assignee, Bob is Lead
      });
      expect(res.allowed).toBe(true);
    });

    it('rejects non-assignee Member from releasing item', () => {
      const res = validateTransition({
        from: 'IN_PROGRESS',
        to: 'OPEN',
        role: 'MEMBER',
        type: 'TASK',
        actorId: 'other-user',
        createdById: ALICE_ID,
        assigneeId: CHARLIE_ID
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });
  });

  describe('Transition: IN_PROGRESS -> AWAITING_APPROVAL', () => {
    it('allows current assignee to submit for review', () => {
      const res = validateTransition({
        from: 'IN_PROGRESS',
        to: 'AWAITING_APPROVAL',
        role: 'MEMBER',
        type: 'INCIDENT',
        actorId: CHARLIE_ID,
        createdById: ALICE_ID,
        assigneeId: CHARLIE_ID
      });
      expect(res.allowed).toBe(true);
    });

    it('allows Lead to submit for review on behalf of assignee', () => {
      const res = validateTransition({
        from: 'IN_PROGRESS',
        to: 'AWAITING_APPROVAL',
        role: 'LEAD',
        type: 'COMPLIANCE',
        actorId: BOB_ID,
        createdById: ALICE_ID,
        assigneeId: CHARLIE_ID
      });
      expect(res.allowed).toBe(true);
    });
  });

  describe('Transition: IN_PROGRESS -> RESOLVED (Direct Resolution)', () => {
    it('allows Lead/Admin to directly resolve items ONLY IF type is TASK', () => {
      const res = validateTransition({
        from: 'IN_PROGRESS',
        to: 'RESOLVED',
        role: 'LEAD',
        type: 'TASK',
        actorId: BOB_ID,
        createdById: ALICE_ID,
        assigneeId: BOB_ID
      });
      expect(res.allowed).toBe(true);
    });

    it('strictly FORBIDS direct resolution for INCIDENT, PAYMENT, COMPLIANCE, CUSTOMER_ISSUE', () => {
      const highRiskTypes: WorkItemType[] = ['INCIDENT', 'PAYMENT', 'COMPLIANCE', 'CUSTOMER_ISSUE'];
      highRiskTypes.forEach((type) => {
        const res = validateTransition({
          from: 'IN_PROGRESS',
          to: 'RESOLVED',
          role: 'ADMIN', // Even Admin cannot bypass approval on high-risk types
          type,
          actorId: BOB_ID,
          createdById: ALICE_ID,
          assigneeId: BOB_ID
        });
        expect(res.allowed).toBe(false);
        if (!res.allowed) {
          expect(res.code).toBe('APPROVAL_REQUIRED');
        }
      });
    });

    it('rejects Member from directly resolving TASK (requires Lead/Admin)', () => {
      const res = validateTransition({
        from: 'IN_PROGRESS',
        to: 'RESOLVED',
        role: 'MEMBER',
        type: 'TASK',
        actorId: CHARLIE_ID,
        createdById: ALICE_ID,
        assigneeId: CHARLIE_ID
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });
  });

  describe('Transition: AWAITING_APPROVAL -> RESOLVED (Approval & 4-Eyes Rule)', () => {
    it('allows Lead/Admin to approve when actor != creator', () => {
      const res = validateTransition({
        from: 'AWAITING_APPROVAL',
        to: 'RESOLVED',
        role: 'LEAD',
        type: 'INCIDENT',
        actorId: BOB_ID,
        createdById: ALICE_ID, // Alice created, Bob approves
        assigneeId: CHARLIE_ID
      });
      expect(res.allowed).toBe(true);
    });

    it('enforces FOUR-EYES PRINCIPLE: creator CANNOT approve their own work item', () => {
      const res = validateTransition({
        from: 'AWAITING_APPROVAL',
        to: 'RESOLVED',
        role: 'LEAD',
        type: 'INCIDENT',
        actorId: ALICE_ID, // Alice is creator AND Lead trying to approve
        createdById: ALICE_ID,
        assigneeId: CHARLIE_ID
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('CANNOT_APPROVE_OWN_ITEM');
      }
    });

    it('rejects Member from approving (requires Lead/Admin role)', () => {
      const res = validateTransition({
        from: 'AWAITING_APPROVAL',
        to: 'RESOLVED',
        role: 'MEMBER',
        type: 'INCIDENT',
        actorId: CHARLIE_ID,
        createdById: ALICE_ID,
        assigneeId: 'someone-else'
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('APPROVAL_REQUIRES_LEAD_ROLE');
      }
    });
  });

  describe('Transition: AWAITING_APPROVAL -> IN_PROGRESS (Reject / Rework)', () => {
    it('allows Member, Lead, and Admin to request rework', () => {
      (['MEMBER', 'LEAD', 'ADMIN'] as UserTeamRole[]).forEach((role) => {
        const res = validateTransition({
          from: 'AWAITING_APPROVAL',
          to: 'IN_PROGRESS',
          role,
          type: 'INCIDENT',
          actorId: BOB_ID,
          createdById: ALICE_ID,
          assigneeId: CHARLIE_ID
        });
        expect(res.allowed).toBe(true);
      });
    });
  });

  describe('Transition: RESOLVED -> CLOSED (Archive)', () => {
    it('allows Lead and Admin to close resolved item', () => {
      const res = validateTransition({
        from: 'RESOLVED',
        to: 'CLOSED',
        role: 'LEAD',
        type: 'TASK',
        actorId: BOB_ID,
        createdById: ALICE_ID,
        assigneeId: CHARLIE_ID
      });
      expect(res.allowed).toBe(true);
    });

    it('rejects Member from closing resolved item', () => {
      const res = validateTransition({
        from: 'RESOLVED',
        to: 'CLOSED',
        role: 'MEMBER',
        type: 'TASK',
        actorId: CHARLIE_ID,
        createdById: ALICE_ID,
        assigneeId: CHARLIE_ID
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });
  });

  describe('Transition: RESOLVED -> IN_PROGRESS (Regression / Reopen)', () => {
    it('allows Member and Lead to reopen resolved item on verification failure', () => {
      (['MEMBER', 'LEAD'] as UserTeamRole[]).forEach((role) => {
        const res = validateTransition({
          from: 'RESOLVED',
          to: 'IN_PROGRESS',
          role,
          type: 'CUSTOMER_ISSUE',
          actorId: CHARLIE_ID,
          createdById: ALICE_ID,
          assigneeId: CHARLIE_ID
        });
        expect(res.allowed).toBe(true);
      });
    });
  });

  describe('Transition: CLOSED -> OPEN (Reopen Archived)', () => {
    it('allows Lead and Admin to reopen closed ticket', () => {
      const res = validateTransition({
        from: 'CLOSED',
        to: 'OPEN',
        role: 'ADMIN',
        type: 'INCIDENT',
        actorId: BOB_ID,
        createdById: ALICE_ID,
        assigneeId: null
      });
      expect(res.allowed).toBe(true);
    });

    it('rejects Member from reopening closed ticket', () => {
      const res = validateTransition({
        from: 'CLOSED',
        to: 'OPEN',
        role: 'MEMBER',
        type: 'INCIDENT',
        actorId: CHARLIE_ID,
        createdById: ALICE_ID,
        assigneeId: null
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });
  });

  describe('Structurally Invalid Transitions', () => {
    it('rejects illegal transitions like OPEN -> RESOLVED or RESOLVED -> OPEN', () => {
      const illegalTransitions: [WorkItemStatus, WorkItemStatus][] = [
        ['OPEN', 'RESOLVED'],
        ['OPEN', 'AWAITING_APPROVAL'],
        ['RESOLVED', 'OPEN'],
        ['RESOLVED', 'AWAITING_APPROVAL'],
        ['CLOSED', 'RESOLVED'],
        ['CLOSED', 'IN_PROGRESS'],
        ['OPEN', 'OPEN'] // No-op self transition
      ];

      illegalTransitions.forEach(([from, to]) => {
        const res = validateTransition({
          from,
          to,
          role: 'ADMIN',
          type: 'INCIDENT',
          actorId: BOB_ID,
          createdById: ALICE_ID,
          assigneeId: null
        });
        expect(res.allowed).toBe(false);
        if (!res.allowed) {
          expect(res.code).toBe('INVALID_TRANSITION');
        }
      });
    });
  });
});
