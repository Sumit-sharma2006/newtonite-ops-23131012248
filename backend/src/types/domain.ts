// Domain entity types and enums matching PostgreSQL schema

export type UserTeamRole = 'VIEWER' | 'MEMBER' | 'LEAD' | 'ADMIN';
export type WorkItemType = 'INCIDENT' | 'CUSTOMER_ISSUE' | 'PAYMENT' | 'COMPLIANCE' | 'TASK';
export type WorkItemPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type WorkItemStatus = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'CLOSED';

export interface User {
  id: string;
  email: string;
  full_name: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMembership {
  team_id: string;
  team_name: string;
  team_slug: string;
  role: UserTeamRole;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  full_name: string;
  memberships: TeamMembership[];
}

export interface WorkItemSummary {
  team_id: string;
  created_by_id: string;
  assignee_id: string | null;
  type: WorkItemType;
  status: WorkItemStatus;
}
