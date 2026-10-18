import crypto from 'crypto';
import { runInTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errorHandler.js';
import { AuthenticatedUser, WorkItemPriority, WorkItemStatus, WorkItemType } from '../../types/domain.js';
import { can, ItemContext } from '../permissions/permissions.js';
import { workItemsRepository, WorkItemRow } from './work-items.repository.js';

export class WorkItemsService {
  /**
   * Helper to convert WorkItemRow to ItemContext for can() authorization
   */
  private toItemContext(row: WorkItemRow): ItemContext {
    return {
      team_id: row.team_id,
      created_by_id: row.created_by_id,
      assignee_id: row.assignee_id,
      type: row.type,
      status: row.status
    };
  }

  async getItems(
    user: AuthenticatedUser,
    query: {
      team_id?: string;
      status?: WorkItemStatus;
      priority?: WorkItemPriority;
      assignee_id?: string;
      q?: string;
      view?: 'assigned_to_me' | 'unassigned_urgent' | 'awaiting_my_approval';
      cursor?: string;
      limit?: string;
    }
  ) {
    const userTeamIds = user.memberships.map((m) => m.team_id);
    if (userTeamIds.length === 0) {
      return { items: [], next_cursor: null, has_more: false };
    }

    if (query.team_id && !userTeamIds.includes(query.team_id)) {
      throw new AppError(403, 'NOT_TEAM_MEMBER', 'You are not a member of this team.');
    }

    const leadOrAdminTeamIds = user.memberships
      .filter((m) => m.role === 'LEAD' || m.role === 'ADMIN')
      .map((m) => m.team_id);

    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    let cursorCreatedAt: string | undefined;
    let cursorId: string | undefined;

    if (query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, 'base64').toString('utf8');
        const parts = decoded.split(',');
        if (parts.length === 2) {
          cursorCreatedAt = parts[0];
          cursorId = parts[1];
        }
      } catch {
        throw new AppError(400, 'INVALID_CURSOR', 'Provided pagination cursor is invalid.');
      }
    }

    const rows = await workItemsRepository.findItems({
      userTeamIds,
      teamId: query.team_id,
      status: query.status,
      priority: query.priority,
      assigneeId: query.assignee_id,
      q: query.q,
      view: query.view,
      userId: user.id,
      leadOrAdminTeamIds,
      cursorCreatedAt,
      cursorId,
      limit
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && items.length > 0
        ? Buffer.from(`${items[items.length - 1].cursor_ts},${items[items.length - 1].id}`).toString('base64')
        : null;

    return {
      items,
      next_cursor: nextCursor,
      has_more: hasMore
    };
  }

  async createItem(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    payload: {
      team_id: string;
      title: string;
      description?: string;
      type: WorkItemType;
      priority?: WorkItemPriority;
      due_date?: string | null;
    }
  ) {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required.');
    }

    if (!payload.team_id || !payload.title || !payload.type) {
      throw new AppError(400, 'VALIDATION_ERROR', 'team_id, title, and type are required.');
    }

    // Role check: Caller must have Member+ role in target team
    const authCheck = can(
      { type: 'item.create', targetTeamId: payload.team_id },
      { memberships: user.memberships, userId: user.id }
    );
    if (!authCheck.allowed) {
      throw new AppError(authCheck.status, authCheck.code, authCheck.message);
    }

    // Canonical payload hash (SHA-256)
    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ ...payload, description: payload.description || '' }))
      .digest('hex');

    // Atomic execution in ONE transaction
    return await runInTransaction(async (client) => {
      // 1. Try to reserve idempotency key
      const reserved = await workItemsRepository.reserveIdempotencyKey(
        client,
        idempotencyKey,
        user.id,
        'POST',
        '/items',
        payloadHash
      );

      // 2. If row was not inserted, duplicate request occurred
      if (!reserved) {
        const existing = await workItemsRepository.getIdempotencyRecord(client, idempotencyKey, user.id);
        if (!existing) {
          throw new AppError(409, 'CONCURRENT_REQUEST', 'Request currently in progress.');
        }

        if (existing.request_params_hash !== payloadHash) {
          throw new AppError(
            422,
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
            'Payload does not match original request for this idempotency key.'
          );
        }

        return {
          replayed: true,
          status: existing.response_code || 201,
          body: existing.response_body
        };
      }

      // 3. New request: Insert work item (status OPEN, assignee null)
      const newItem = await workItemsRepository.create(client, {
        team_id: payload.team_id,
        title: payload.title.trim(),
        description: payload.description || '',
        type: payload.type,
        priority: payload.priority || 'MEDIUM',
        due_date: payload.due_date,
        created_by_id: user.id
      });

      // 4. Write activity event CREATED
      await workItemsRepository.insertActivityEvent(client, {
        work_item_id: newItem.id,
        actor_id: user.id,
        event_type: 'CREATED',
        from_state: null,
        to_state: {
          status: newItem.status,
          priority: newItem.priority,
          title: newItem.title
        }
      });

      // 5. Write transactional outbox job
      await workItemsRepository.insertOutboxJob(client, {
        event_type: 'WORK_ITEM_CREATED',
        aggregate_id: newItem.id,
        payload: {
          work_item_id: newItem.id,
          title: newItem.title,
          actor_id: user.id,
          item: newItem
        }
      });

      const responseBody = { item: newItem };

      // 6. Update idempotency record with stored response
      await workItemsRepository.updateIdempotencyResponse(
        client,
        idempotencyKey,
        user.id,
        201,
        responseBody
      );

      return {
        replayed: false,
        status: 201,
        body: responseBody
      };
    });
  }

  async getItemById(user: AuthenticatedUser, itemId: string) {
    const item = await workItemsRepository.findById(itemId);
    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
    }

    const authCheck = can('item.view', {
      memberships: user.memberships,
      item: this.toItemContext(item),
      userId: user.id
    });

    if (!authCheck.allowed) {
      throw new AppError(authCheck.status, authCheck.code, authCheck.message);
    }

    return item;
  }

  async getActivity(
    user: AuthenticatedUser,
    itemId: string,
    cursor?: string,
    limitStr?: string
  ) {
    const item = await this.getItemById(user, itemId);
    const limit = Math.min(100, Math.max(1, parseInt(limitStr || '20', 10)));

    let cursorCreatedAt: string | undefined;
    let cursorId: string | undefined;

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf8');
        const parts = decoded.split(',');
        if (parts.length === 2) {
          cursorCreatedAt = parts[0];
          cursorId = parts[1];
        }
      } catch {
        throw new AppError(400, 'INVALID_CURSOR', 'Provided pagination cursor is invalid.');
      }
    }

    const rows = await workItemsRepository.findActivity(item.id, cursorCreatedAt, cursorId, limit);
    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && events.length > 0
        ? Buffer.from(`${events[events.length - 1].cursor_ts},${events[events.length - 1].id}`).toString('base64')
        : null;

    return {
      events,
      next_cursor: nextCursor,
      has_more: hasMore
    };
  }

  async addComment(user: AuthenticatedUser, itemId: string, body: string) {
    if (!body || !body.trim()) {
      throw new AppError(400, 'EMPTY_COMMENT', 'Comment body cannot be empty.');
    }

    const item = await workItemsRepository.findById(itemId);
    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
    }

    const authCheck = can('item.comment', {
      memberships: user.memberships,
      item: this.toItemContext(item),
      userId: user.id
    });
    if (!authCheck.allowed) {
      throw new AppError(authCheck.status, authCheck.code, authCheck.message);
    }

    return await runInTransaction(async (client) => {
      const comment = await workItemsRepository.createComment(client, {
        work_item_id: item.id,
        author_id: user.id,
        body
      });

      await workItemsRepository.insertActivityEvent(client, {
        work_item_id: item.id,
        actor_id: user.id,
        event_type: 'COMMENT_ADDED',
        from_state: null,
        to_state: { comment_id: comment.id },
        metadata: { body_preview: body.trim().slice(0, 100) }
      });

      return comment;
    });
  }

  async updateItem(
    user: AuthenticatedUser,
    itemId: string,
    payload: {
      version: number;
      title?: string;
      description?: string;
      due_date?: string | null;
      priority?: WorkItemPriority;
    }
  ) {
    if (typeof payload.version !== 'number') {
      throw new AppError(400, 'VERSION_REQUIRED', 'Version number is required for optimistic locking.');
    }

    const item = await workItemsRepository.findById(itemId);
    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
    }

    const itemCtx = this.toItemContext(item);

    // Edit permission check
    const editCheck = can('item.edit', {
      memberships: user.memberships,
      item: itemCtx,
      userId: user.id
    });
    if (!editCheck.allowed) {
      throw new AppError(editCheck.status, editCheck.code, editCheck.message);
    }

    // Priority change permission check (Lead/Admin only)
    if (payload.priority && payload.priority !== item.priority) {
      const priorityCheck = can('item.priority', {
        memberships: user.memberships,
        item: itemCtx,
        userId: user.id
      });
      if (!priorityCheck.allowed) {
        throw new AppError(priorityCheck.status, priorityCheck.code, priorityCheck.message);
      }
    }

    return await runInTransaction(async (client) => {
      const updated = await workItemsRepository.updateMetadata(client, itemId, payload.version, {
        title: payload.title?.trim(),
        description: payload.description,
        due_date: payload.due_date,
        priority: payload.priority
      });

      if (!updated) {
        // Re-read latest state to return informative conflict details
        const latest = await workItemsRepository.findById(itemId, client);
        if (!latest) {
          throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
        }
        throw new AppError(409, 'STALE_VERSION', 'The work item was modified by another user.', {
          latest_item: latest
        });
      }

      // Record activity events in same transaction
      if (payload.priority && payload.priority !== item.priority) {
        await workItemsRepository.insertActivityEvent(client, {
          work_item_id: itemId,
          actor_id: user.id,
          event_type: 'PRIORITY_CHANGED',
          from_state: { priority: item.priority },
          to_state: { priority: updated.priority }
        });
      } else {
        await workItemsRepository.insertActivityEvent(client, {
          work_item_id: itemId,
          actor_id: user.id,
          event_type: 'METADATA_UPDATED',
          from_state: { title: item.title, description: item.description, due_date: item.due_date },
          to_state: { title: updated.title, description: updated.description, due_date: updated.due_date }
        });
      }

      return updated;
    });
  }

  async claimItem(user: AuthenticatedUser, itemId: string) {
    const item = await workItemsRepository.findById(itemId);
    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
    }

    const authCheck = can('item.claim', {
      memberships: user.memberships,
      item: this.toItemContext(item),
      userId: user.id
    });
    if (!authCheck.allowed) {
      throw new AppError(authCheck.status, authCheck.code, authCheck.message);
    }

    return await runInTransaction(async (client) => {
      const claimed = await workItemsRepository.claim(client, itemId, user.id);
      if (!claimed) {
        const latest = await workItemsRepository.findById(itemId, client);
        if (!latest) {
          throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
        }
        throw new AppError(409, 'ALREADY_CLAIMED', 'Work item has already been claimed or is not open.');
      }

      // Activity event in same transaction
      await workItemsRepository.insertActivityEvent(client, {
        work_item_id: itemId,
        actor_id: user.id,
        event_type: 'CLAIMED',
        from_state: { status: 'OPEN', assignee_id: null },
        to_state: { status: 'IN_PROGRESS', assignee_id: user.id }
      });

      // Outbox job in same transaction
      await workItemsRepository.insertOutboxJob(client, {
        event_type: 'CLAIMED',
        aggregate_id: itemId,
        payload: {
          work_item_id: claimed.id,
          assignee_id: claimed.assignee_id,
          title: claimed.title,
          actor_id: user.id
        }
      });

      return claimed;
    });
  }

  async transitionItem(
    user: AuthenticatedUser,
    itemId: string,
    payload: { version: number; to_status: WorkItemStatus; reason?: string }
  ) {
    if (typeof payload.version !== 'number') {
      throw new AppError(400, 'VERSION_REQUIRED', 'Version number is required for optimistic locking.');
    }
    if (!payload.to_status) {
      throw new AppError(400, 'STATUS_REQUIRED', 'Target status to_status is required.');
    }

    const item = await workItemsRepository.findById(itemId);
    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
    }

    // Authorization & state machine check
    const authCheck = can(
      {
        type: 'item.transition',
        transition: { from: item.status, to: payload.to_status }
      },
      {
        memberships: user.memberships,
        item: this.toItemContext(item),
        userId: user.id
      }
    );

    if (!authCheck.allowed) {
      throw new AppError(authCheck.status, authCheck.code, authCheck.message);
    }

    // Reason requirement verification
    const requiresReason =
      (item.status === 'AWAITING_APPROVAL' && payload.to_status === 'IN_PROGRESS') ||
      (item.status === 'RESOLVED' && payload.to_status === 'IN_PROGRESS') ||
      (item.status === 'OPEN' && payload.to_status === 'CLOSED');

    if (requiresReason && (!payload.reason || !payload.reason.trim())) {
      throw new AppError(400, 'REASON_REQUIRED', 'A reason is mandatory for this transition.');
    }

    return await runInTransaction(async (client) => {
      const transitioned = await workItemsRepository.transition(
        client,
        itemId,
        payload.version,
        payload.to_status
      );

      if (!transitioned) {
        const latest = await workItemsRepository.findById(itemId, client);
        if (!latest) {
          throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
        }
        throw new AppError(409, 'STALE_VERSION', 'The work item was modified by another user.', {
          latest_item: latest
        });
      }

      // Record activity event
      await workItemsRepository.insertActivityEvent(client, {
        work_item_id: itemId,
        actor_id: user.id,
        event_type: 'STATUS_CHANGED',
        from_state: { status: item.status, assignee_id: item.assignee_id },
        to_state: { status: transitioned.status, assignee_id: transitioned.assignee_id },
        metadata: { reason: payload.reason?.trim() }
      });

      // Outbox event
      await workItemsRepository.insertOutboxJob(client, {
        event_type: 'STATUS_CHANGED',
        aggregate_id: itemId,
        payload: {
          work_item_id: transitioned.id,
          title: transitioned.title,
          actor_id: user.id,
          from_status: item.status,
          to_status: transitioned.status,
          item: transitioned
        }
      });

      return transitioned;
    });
  }

  async assignItem(
    user: AuthenticatedUser,
    itemId: string,
    payload: { version: number; assignee_id: string | null }
  ) {
    if (typeof payload.version !== 'number') {
      throw new AppError(400, 'VERSION_REQUIRED', 'Version number is required for optimistic locking.');
    }

    const item = await workItemsRepository.findById(itemId);
    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
    }

    const authCheck = can(
      { type: 'item.assign', assign: { targetAssigneeId: payload.assignee_id } },
      { memberships: user.memberships, item: this.toItemContext(item), userId: user.id }
    );
    if (!authCheck.allowed) {
      throw new AppError(authCheck.status, authCheck.code, authCheck.message);
    }

    // If setting an assignee, confirm the assignee is an active member of this item's team
    if (payload.assignee_id) {
      const isMember = await workItemsRepository.isTeamMember(payload.assignee_id, item.team_id);
      if (!isMember) {
        throw new AppError(400, 'ASSIGNEE_NOT_IN_TEAM', 'Assignee must be an active member of this team.');
      }
    }

    return await runInTransaction(async (client) => {
      const assigned = await workItemsRepository.assign(
        client,
        itemId,
        payload.version,
        payload.assignee_id
      );

      if (!assigned) {
        const latest = await workItemsRepository.findById(itemId, client);
        if (!latest) {
          throw new AppError(404, 'NOT_FOUND', 'Work item not found.');
        }
        throw new AppError(409, 'STALE_VERSION', 'The work item was modified by another user.', {
          latest_item: latest
        });
      }

      await workItemsRepository.insertActivityEvent(client, {
        work_item_id: itemId,
        actor_id: user.id,
        event_type: payload.assignee_id ? 'ASSIGNED' : 'UNASSIGNED',
        from_state: { assignee_id: item.assignee_id },
        to_state: { assignee_id: assigned.assignee_id }
      });

      await workItemsRepository.insertOutboxJob(client, {
        event_type: 'ASSIGNED',
        aggregate_id: itemId,
        payload: {
          work_item_id: assigned.id,
          assignee_id: assigned.assignee_id,
          title: assigned.title,
          actor_id: user.id
        }
      });

      return assigned;
    });
  }

  async getDashboardSummary(user: AuthenticatedUser, teamId?: string) {
    const userTeamIds = user.memberships.map((m) => m.team_id);
    if (userTeamIds.length === 0) {
      return { assigned_to_me: 0, unassigned_urgent: 0, awaiting_my_approval: 0 };
    }

    if (teamId && !userTeamIds.includes(teamId)) {
      throw new AppError(403, 'NOT_TEAM_MEMBER', 'You are not a member of this team.');
    }

    const leadOrAdminTeamIds = user.memberships
      .filter((m) => m.role === 'LEAD' || m.role === 'ADMIN')
      .map((m) => m.team_id);

    return await workItemsRepository.getDashboardSummary(
      user.id,
      userTeamIds,
      leadOrAdminTeamIds,
      teamId
    );
  }

  async getTeamMembers(user: AuthenticatedUser, teamId: string) {
    const isMember = user.memberships.some((m) => m.team_id === teamId);
    if (!isMember) {
      throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found or access denied.');
    }
    const members = await workItemsRepository.getTeamMembers(teamId);
    return { members };
  }
}

export const workItemsService = new WorkItemsService();
