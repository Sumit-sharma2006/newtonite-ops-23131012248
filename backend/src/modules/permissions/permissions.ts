import { TeamMembership, UserTeamRole, WorkItemStatus, WorkItemType } from '../../types/domain.js';
import { validateTransition } from '../work-items/state-machine.js';

export type PermissionActionType =
  | 'item.view'
  | 'item.create'
  | 'item.edit'
  | 'item.claim'
  | 'item.comment'
  | 'item.transition'
  | 'item.assign'
  | 'item.priority';

export interface TransitionPayload {
  from: WorkItemStatus;
  to: WorkItemStatus;
}

export interface AssignPayload {
  targetAssigneeId: string | null;
}

export interface PermissionAction {
  type: PermissionActionType;
  targetTeamId?: string; // used when creating an item
  transition?: TransitionPayload;
  assign?: AssignPayload;
}

export interface ItemContext {
  team_id: string;
  created_by_id: string;
  assignee_id: string | null;
  type: WorkItemType;
  status: WorkItemStatus;
}

export interface PermissionContext {
  memberships: TeamMembership[];
  item?: ItemContext;
  userId: string;
}

export type PermissionResult =
  | { allowed: true }
  | { allowed: false; status: 403 | 404; code: string; message: string };

/**
 * Pure authorization function evaluating whether a user can perform an action.
 * Enforces resource-level scoping and role restrictions:
 * 1. If an item is provided and user is NOT a member of item.team_id -> 404 Not Found (prevents enumeration).
 * 2. If user is in the team but role is insufficient -> 403 Forbidden with exact code.
 */
export function can(action: PermissionAction | PermissionActionType, ctx: PermissionContext): PermissionResult {
  const actionObj: PermissionAction = typeof action === 'string' ? { type: action } : action;
  const { memberships, item, userId } = ctx;

  // 1. Team-level action: item.create
  if (actionObj.type === 'item.create') {
    const targetTeamId = actionObj.targetTeamId || item?.team_id;
    if (!targetTeamId) {
      return { allowed: false, status: 403, code: 'TEAM_ID_REQUIRED', message: 'Target team_id is required.' };
    }
    const membership = memberships.find((m) => m.team_id === targetTeamId);
    if (!membership) {
      return { allowed: false, status: 403, code: 'NOT_TEAM_MEMBER', message: 'You are not a member of this team.' };
    }
    if (membership.role === 'VIEWER') {
      return {
        allowed: false,
        status: 403,
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: 'Creating an item requires Member role or higher.'
      };
    }
    return { allowed: true };
  }

  // 2. Resource-level actions: require `item`
  if (!item) {
    return { allowed: false, status: 404, code: 'NOT_FOUND', message: 'Work item not found.' };
  }

  // Rule: user not in item's team -> 404 Not Found (prevents resource existence leakage)
  const membership = memberships.find((m) => m.team_id === item.team_id);
  if (!membership) {
    return { allowed: false, status: 404, code: 'NOT_FOUND', message: 'Work item not found.' };
  }

  const role: UserTeamRole = membership.role;
  const isAssignee = item.assignee_id === userId;
  const isLeadOrAdmin = role === 'LEAD' || role === 'ADMIN';

  switch (actionObj.type) {
    case 'item.view':
      // Viewers, Members, Leads, Admins in the team can view
      return { allowed: true };

    case 'item.comment':
      // Any team role (including Viewer) can post comments
      return { allowed: true };

    case 'item.claim':
      if (role === 'VIEWER') {
        return {
          allowed: false,
          status: 403,
          code: 'INSUFFICIENT_TEAM_ROLE',
          message: 'Claiming an item requires Member role or higher.'
        };
      }
      return { allowed: true };

    case 'item.edit':
      // Lead/Admin can edit any item. Member can edit only if assigned to them.
      if (isLeadOrAdmin) {
        return { allowed: true };
      }
      if (role === 'MEMBER' && isAssignee) {
        return { allowed: true };
      }
      return {
        allowed: false,
        status: 403,
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: role === 'VIEWER' ? 'Viewers cannot edit items.' : 'Members can only edit items assigned to them.'
      };

    case 'item.priority':
      // Only Lead or Admin can change priority
      if (!isLeadOrAdmin) {
        return {
          allowed: false,
          status: 403,
          code: 'INSUFFICIENT_TEAM_ROLE',
          message: 'Changing priority requires Lead or Admin role.'
        };
      }
      return { allowed: true };

    case 'item.assign':
      // Lead/Admin can assign anyone or unassign.
      if (isLeadOrAdmin) {
        return { allowed: true };
      }
      // Member can only reassign tickets currently assigned to them
      if (role === 'MEMBER' && isAssignee) {
        return { allowed: true };
      }
      return {
        allowed: false,
        status: 403,
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: role === 'VIEWER' ? 'Viewers cannot assign items.' : 'Members can only reassign items assigned to them.'
      };

    case 'item.transition': {
      if (!actionObj.transition) {
        return { allowed: false, status: 403, code: 'TRANSITION_PAYLOAD_REQUIRED', message: 'from and to status are required.' };
      }

      // Viewers cannot transition any item
      if (role === 'VIEWER') {
        return {
          allowed: false,
          status: 403,
          code: 'INSUFFICIENT_TEAM_ROLE',
          message: 'Viewers cannot transition work items.'
        };
      }

      const transitionResult = validateTransition({
        from: actionObj.transition.from,
        to: actionObj.transition.to,
        role,
        type: item.type,
        actorId: userId,
        createdById: item.created_by_id,
        assigneeId: item.assignee_id
      });

      if (!transitionResult.allowed) {
        return {
          allowed: false,
          status: 403,
          code: transitionResult.code,
          message: transitionResult.message
        };
      }

      return { allowed: true };
    }

    default:
      return { allowed: false, status: 403, code: 'UNKNOWN_ACTION', message: 'Action not recognized.' };
  }
}
