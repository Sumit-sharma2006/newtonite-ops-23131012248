import { UserTeamRole, WorkItemStatus, WorkItemType } from '../../types/domain.js';

export interface TransitionParams {
  from: WorkItemStatus;
  to: WorkItemStatus;
  role: UserTeamRole;
  type: WorkItemType;
  actorId: string;
  createdById: string;
  assigneeId: string | null;
}

export type TransitionValidationResult =
  | { allowed: true }
  | { allowed: false; code: string; message: string };

/**
 * Pure function that validates workflow state transitions against
 * the locked PressureDesk state machine defined in docs/design.md.
 */
export function validateTransition(params: TransitionParams): TransitionValidationResult {
  const { from, to, role, type, actorId, createdById, assigneeId } = params;
  const isLeadOrAdmin = role === 'LEAD' || role === 'ADMIN';
  const isAssignee = actorId === assigneeId;

  // Viewers cannot transition any item
  if (role === 'VIEWER') {
    return {
      allowed: false,
      code: 'INSUFFICIENT_TEAM_ROLE',
      message: 'Viewers cannot transition work items.'
    };
  }

  // Same status transition is a no-op / invalid
  if (from === to) {
    return {
      allowed: false,
      code: 'INVALID_TRANSITION',
      message: `Item is already in ${from} status.`
    };
  }

  // 1. OPEN -> IN_PROGRESS (Claim / Start Work)
  if (from === 'OPEN' && to === 'IN_PROGRESS') {
    return { allowed: true };
  }

  // 2. OPEN -> CLOSED (Invalid / Duplicate / Won't Fix)
  if (from === 'OPEN' && to === 'CLOSED') {
    if (!isLeadOrAdmin) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: 'Discarding or closing open items requires Lead or Admin role.'
      };
    }
    return { allowed: true };
  }

  // 3. IN_PROGRESS -> OPEN (Release / Unassign)
  if (from === 'IN_PROGRESS' && to === 'OPEN') {
    if (!isAssignee && !isLeadOrAdmin) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: 'Only the current assignee or a Lead/Admin can release an in-progress item.'
      };
    }
    return { allowed: true };
  }

  // 4. IN_PROGRESS -> AWAITING_APPROVAL (Submit for Review)
  if (from === 'IN_PROGRESS' && to === 'AWAITING_APPROVAL') {
    if (!isAssignee && !isLeadOrAdmin) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: 'Only the current assignee or a Lead/Admin can submit an item for approval.'
      };
    }
    return { allowed: true };
  }

  // 5. IN_PROGRESS -> RESOLVED (Direct Resolution - TASK type only)
  if (from === 'IN_PROGRESS' && to === 'RESOLVED') {
    if (type !== 'TASK') {
      return {
        allowed: false,
        code: 'APPROVAL_REQUIRED',
        message: `Direct resolution is strictly allowed only for TASK items. Items of type ${type} must go through Awaiting Approval.`
      };
    }
    if (!isLeadOrAdmin) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: 'Direct resolution of tasks requires Lead or Admin role.'
      };
    }
    return { allowed: true };
  }

  // 6. AWAITING_APPROVAL -> RESOLVED (Sign-off / Approve)
  if (from === 'AWAITING_APPROVAL' && to === 'RESOLVED') {
    if (!isLeadOrAdmin) {
      return {
        allowed: false,
        code: 'APPROVAL_REQUIRES_LEAD_ROLE',
        message: 'Approving items requires Lead or Admin role.'
      };
    }
    // Four-eyes principle: Creator cannot approve their own item
    if (actorId === createdById) {
      return {
        allowed: false,
        code: 'CANNOT_APPROVE_OWN_ITEM',
        message: 'Creators cannot approve their own work items under four-eyes compliance rule.'
      };
    }
    return { allowed: true };
  }

  // 7. AWAITING_APPROVAL -> IN_PROGRESS (Reject / Request Rework)
  if (from === 'AWAITING_APPROVAL' && to === 'IN_PROGRESS') {
    return { allowed: true };
  }

  // 8. RESOLVED -> CLOSED (Final Verification / Archive)
  if (from === 'RESOLVED' && to === 'CLOSED') {
    if (!isLeadOrAdmin) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: 'Closing resolved items requires Lead or Admin role.'
      };
    }
    return { allowed: true };
  }

  // 9. RESOLVED -> IN_PROGRESS (Regression / Reopen)
  if (from === 'RESOLVED' && to === 'IN_PROGRESS') {
    return { allowed: true };
  }

  // 10. CLOSED -> OPEN (Reopen Archived Ticket)
  if (from === 'CLOSED' && to === 'OPEN') {
    if (!isLeadOrAdmin) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: 'Reopening closed items requires Lead or Admin role.'
      };
    }
    return { allowed: true };
  }

  // Any other combination is structurally invalid
  return {
    allowed: false,
    code: 'INVALID_TRANSITION',
    message: `Transition from ${from} to ${to} is not permitted.`
  };
}
