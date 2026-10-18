import { describe, it, expect } from 'vitest';
import { can, ItemContext } from '../../backend/src/modules/permissions/permissions.js';
import { TeamMembership, UserTeamRole } from '../../backend/src/types/domain.js';

describe('Permissions Module - can(action, ctx)', () => {
  const TEAM_ALPHA = 'team-alpha-uuid';
  const TEAM_BETA = 'team-beta-uuid';
  const ALICE_ID = 'user-alice-uuid';
  const BOB_ID = 'user-bob-uuid';

  // Helper to construct mock memberships
  const makeMembership = (teamId: string, role: UserTeamRole): TeamMembership => ({
    team_id: teamId,
    team_name: 'Test Team',
    team_slug: 'test-team',
    role
  });

  // Sample base item
  const sampleItem: ItemContext = {
    team_id: TEAM_ALPHA,
    created_by_id: ALICE_ID,
    assignee_id: ALICE_ID,
    type: 'TASK',
    status: 'IN_PROGRESS'
  };

  describe('Rule: Non-team member handling (404 vs 403)', () => {
    it('returns 404 NOT_FOUND when user is not a member of the item team (prevents ID enumeration)', () => {
      const res = can('item.view', {
        memberships: [makeMembership(TEAM_BETA, 'LEAD')], // User is in Beta, item is in Alpha
        item: sampleItem,
        userId: ALICE_ID
      });

      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.status).toBe(404);
        expect(res.code).toBe('NOT_FOUND');
      }
    });

    it('returns 403 INSUFFICIENT_TEAM_ROLE when user belongs to team but role is too low', () => {
      const res = can('item.priority', {
        memberships: [makeMembership(TEAM_ALPHA, 'VIEWER')],
        item: sampleItem,
        userId: ALICE_ID
      });

      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.status).toBe(403);
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });
  });

  describe('Action: item.view', () => {
    const roles: UserTeamRole[] = ['VIEWER', 'MEMBER', 'LEAD', 'ADMIN'];
    roles.forEach((role) => {
      it(`allows ${role} in team to view item`, () => {
        const res = can('item.view', {
          memberships: [makeMembership(TEAM_ALPHA, role)],
          item: sampleItem,
          userId: ALICE_ID
        });
        expect(res.allowed).toBe(true);
      });
    });
  });

  describe('Action: item.create', () => {
    it('rejects VIEWER from creating item', () => {
      const res = can({ type: 'item.create', targetTeamId: TEAM_ALPHA }, {
        memberships: [makeMembership(TEAM_ALPHA, 'VIEWER')],
        userId: ALICE_ID
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.status).toBe(403);
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });

    const allowedRoles: UserTeamRole[] = ['MEMBER', 'LEAD', 'ADMIN'];
    allowedRoles.forEach((role) => {
      it(`allows ${role} to create item`, () => {
        const res = can({ type: 'item.create', targetTeamId: TEAM_ALPHA }, {
          memberships: [makeMembership(TEAM_ALPHA, role)],
          userId: ALICE_ID
        });
        expect(res.allowed).toBe(true);
      });
    });
  });

  describe('Action: item.edit', () => {
    it('rejects VIEWER from editing item', () => {
      const res = can('item.edit', {
        memberships: [makeMembership(TEAM_ALPHA, 'VIEWER')],
        item: sampleItem,
        userId: ALICE_ID
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.status).toBe(403);
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });

    it('allows MEMBER to edit item ONLY IF assigned to them', () => {
      // Alice is assignee
      const resAllowed = can('item.edit', {
        memberships: [makeMembership(TEAM_ALPHA, 'MEMBER')],
        item: { ...sampleItem, assignee_id: ALICE_ID },
        userId: ALICE_ID
      });
      expect(resAllowed.allowed).toBe(true);

      // Bob is NOT assignee
      const resForbidden = can('item.edit', {
        memberships: [makeMembership(TEAM_ALPHA, 'MEMBER')],
        item: { ...sampleItem, assignee_id: ALICE_ID },
        userId: BOB_ID
      });
      expect(resForbidden.allowed).toBe(false);
      if (!resForbidden.allowed) {
        expect(resForbidden.status).toBe(403);
        expect(resForbidden.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });

    it('allows LEAD and ADMIN to edit any item regardless of assignee', () => {
      ['LEAD', 'ADMIN'].forEach((role) => {
        const res = can('item.edit', {
          memberships: [makeMembership(TEAM_ALPHA, role as UserTeamRole)],
          item: { ...sampleItem, assignee_id: ALICE_ID },
          userId: BOB_ID // Bob is not assignee, but is Lead/Admin
        });
        expect(res.allowed).toBe(true);
      });
    });
  });

  describe('Action: item.claim', () => {
    it('rejects VIEWER from claiming an item', () => {
      const res = can('item.claim', {
        memberships: [makeMembership(TEAM_ALPHA, 'VIEWER')],
        item: sampleItem,
        userId: ALICE_ID
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.status).toBe(403);
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });

    ['MEMBER', 'LEAD', 'ADMIN'].forEach((role) => {
      it(`allows ${role} to claim unassigned item`, () => {
        const res = can('item.claim', {
          memberships: [makeMembership(TEAM_ALPHA, role as UserTeamRole)],
          item: { ...sampleItem, status: 'OPEN', assignee_id: null },
          userId: ALICE_ID
        });
        expect(res.allowed).toBe(true);
      });
    });
  });

  describe('Action: item.comment', () => {
    // Viewers, Members, Leads, Admins can all comment
    ['VIEWER', 'MEMBER', 'LEAD', 'ADMIN'].forEach((role) => {
      it(`allows ${role} to post comment`, () => {
        const res = can('item.comment', {
          memberships: [makeMembership(TEAM_ALPHA, role as UserTeamRole)],
          item: sampleItem,
          userId: ALICE_ID
        });
        expect(res.allowed).toBe(true);
      });
    });
  });

  describe('Action: item.priority', () => {
    it('rejects VIEWER and MEMBER from modifying priority', () => {
      ['VIEWER', 'MEMBER'].forEach((role) => {
        const res = can('item.priority', {
          memberships: [makeMembership(TEAM_ALPHA, role as UserTeamRole)],
          item: sampleItem,
          userId: ALICE_ID
        });
        expect(res.allowed).toBe(false);
        if (!res.allowed) {
          expect(res.status).toBe(403);
          expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
        }
      });
    });

    it('allows LEAD and ADMIN to modify priority', () => {
      ['LEAD', 'ADMIN'].forEach((role) => {
        const res = can('item.priority', {
          memberships: [makeMembership(TEAM_ALPHA, role as UserTeamRole)],
          item: sampleItem,
          userId: ALICE_ID
        });
        expect(res.allowed).toBe(true);
      });
    });
  });

  describe('Action: item.assign', () => {
    it('rejects VIEWER from assigning items', () => {
      const res = can({ type: 'item.assign', assign: { targetAssigneeId: BOB_ID } }, {
        memberships: [makeMembership(TEAM_ALPHA, 'VIEWER')],
        item: sampleItem,
        userId: ALICE_ID
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.status).toBe(403);
        expect(res.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });

    it('allows MEMBER to reassign ONLY IF currently assigned to them', () => {
      // Alice is currently assigned -> can reassign
      const resAllowed = can({ type: 'item.assign', assign: { targetAssigneeId: BOB_ID } }, {
        memberships: [makeMembership(TEAM_ALPHA, 'MEMBER')],
        item: { ...sampleItem, assignee_id: ALICE_ID },
        userId: ALICE_ID
      });
      expect(resAllowed.allowed).toBe(true);

      // Bob is not assigned -> cannot reassign someone else's item
      const resForbidden = can({ type: 'item.assign', assign: { targetAssigneeId: BOB_ID } }, {
        memberships: [makeMembership(TEAM_ALPHA, 'MEMBER')],
        item: { ...sampleItem, assignee_id: ALICE_ID },
        userId: BOB_ID
      });
      expect(resForbidden.allowed).toBe(false);
      if (!resForbidden.allowed) {
        expect(resForbidden.status).toBe(403);
        expect(resForbidden.code).toBe('INSUFFICIENT_TEAM_ROLE');
      }
    });

    it('allows LEAD and ADMIN to reassign any item', () => {
      ['LEAD', 'ADMIN'].forEach((role) => {
        const res = can({ type: 'item.assign', assign: { targetAssigneeId: BOB_ID } }, {
          memberships: [makeMembership(TEAM_ALPHA, role as UserTeamRole)],
          item: { ...sampleItem, assignee_id: ALICE_ID },
          userId: BOB_ID
        });
        expect(res.allowed).toBe(true);
      });
    });
  });
});
