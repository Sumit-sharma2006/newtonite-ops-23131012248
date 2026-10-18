// Domain and API entity types for PressureDesk frontend

export type UserTeamRole = 'VIEWER' | 'MEMBER' | 'LEAD' | 'ADMIN';
export type WorkItemType = 'INCIDENT' | 'CUSTOMER_ISSUE' | 'PAYMENT' | 'COMPLIANCE' | 'TASK';
export type WorkItemPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type WorkItemStatus = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'CLOSED';

export interface TeamMembership {
  team_id: string;
  team_name: string;
  team_slug: string;
  role: UserTeamRole;
}

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  memberships: TeamMembership[];
}

export interface TeamMember {
  id: string;
  full_name: string;
  email: string;
  role: UserTeamRole;
}

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  type: WorkItemType;
  priority: WorkItemPriority;
  status: WorkItemStatus;
  team_id: string;
  assignee_id: string | null;
  created_by_id: string;
  due_date: string | null;
  version: number;
  cursor_ts: string;
  created_at: string;
  updated_at: string;
}

export interface ActivityEvent {
  id: string;
  work_item_id: string;
  actor_id: string;
  event_type: string;
  from_state: any;
  to_state: any;
  metadata: any;
  cursor_ts: string;
  created_at: string;
}

export interface CommentItem {
  id: string;
  work_item_id: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface DashboardSummary {
  assigned_to_me: number;
  unassigned_urgent: number;
  awaiting_my_approval: number;
}

export interface PaginatedItemsResponse {
  items: WorkItem[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface PaginatedActivityResponse {
  events: ActivityEvent[];
  next_cursor: string | null;
  has_more: boolean;
}
