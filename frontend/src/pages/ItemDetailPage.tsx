import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, ApiError } from '../api/client';
import {
  UserProfile,
  WorkItem,
  WorkItemPriority,
  WorkItemStatus,
  PaginatedActivityResponse,
  TeamMember
} from '../types/api';

interface ItemDetailPageProps {
  itemId: string;
  user: UserProfile;
  onBack: () => void;
}

export const ItemDetailPage: React.FC<ItemDetailPageProps> = ({
  itemId,
  user,
  onBack
}) => {
  const queryClient = useQueryClient();

  // Banners & Notifications
  const [errorBanner, setErrorBanner] = useState<{
    type: 'STALE_VERSION' | 'ALREADY_CLAIMED' | 'FORBIDDEN' | 'GENERAL';
    message: string;
  } | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Edit form state (Kept separate so 409 Reload retains unsaved draft)
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState<WorkItemPriority>('MEDIUM');

  // Transition form state
  const [transitionStatus, setTransitionStatus] = useState<WorkItemStatus>('IN_PROGRESS');
  const [transitionReason, setTransitionReason] = useState('');

  // Assign form state
  const [selectedAssignee, setSelectedAssignee] = useState<string>('');

  // Comment form state
  const [commentBody, setCommentBody] = useState('');

  // Fetch Item Query
  const {
    data: itemData,
    error: itemError,
    isLoading: itemLoading,
    refetch: refetchItem
  } = useQuery<{ item: WorkItem }, ApiError>({
    queryKey: ['item', itemId],
    queryFn: () => apiClient<{ item: WorkItem }>(`/items/${itemId}`),
    retry: false
  });

  const item = itemData?.item;

  // Initialize edit form when item is loaded and not currently being edited
  useEffect(() => {
    if (item && !isEditing) {
      setEditTitle(item.title);
      setEditDescription(item.description || '');
      setEditPriority(item.priority);
      setSelectedAssignee(item.assignee_id || '');
    }
  }, [item, isEditing]);

  // Determine user role in this item's team
  const userTeamMembership = user.memberships.find((m) => m.team_id === item?.team_id);
  const userRole = userTeamMembership?.role;
  const isLeadOrAdmin = userRole === 'LEAD' || userRole === 'ADMIN';
  const isMemberPlus = isLeadOrAdmin || userRole === 'MEMBER';

  // Fetch Team Members for Assign dropdown (Lead/Admin)
  const { data: teamMembersData } = useQuery<{ members: TeamMember[] }>({
    queryKey: ['team-members', item?.team_id],
    queryFn: () => apiClient<{ members: TeamMember[] }>(`/items/team-members/${item!.team_id}`),
    enabled: Boolean(item?.team_id && isLeadOrAdmin)
  });

  // Fetch Activity Timeline
  const {
    data: activityData,
    isLoading: activityLoading,
    isFetchingNextPage: fetchingActivityNext,
    hasNextPage: hasActivityNext,
    fetchNextPage: fetchNextActivity
  } = useInfiniteQuery<PaginatedActivityResponse, ApiError>({
    queryKey: ['activity', itemId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const url = pageParam
        ? `/items/${itemId}/activity?cursor=${encodeURIComponent(pageParam as string)}&limit=15`
        : `/items/${itemId}/activity?limit=15`;
      return apiClient<PaginatedActivityResponse>(url);
    },
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined)
  });

  const allActivity = activityData?.pages.flatMap((p) => p.events) || [];

  const showToast = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => setSuccessToast(null), 4000);
  };

  // 1. Claim Mutation (Optimistic Update)
  const claimMutation = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('Item missing');
      return apiClient<{ item: WorkItem }>(`/items/${itemId}/claim`, {
        method: 'POST'
      });
    },
    onMutate: async () => {
      setErrorBanner(null);
      await queryClient.cancelQueries({ queryKey: ['item', itemId] });
      const previousData = queryClient.getQueryData<{ item: WorkItem }>(['item', itemId]);

      if (previousData?.item) {
        queryClient.setQueryData<{ item: WorkItem }>(['item', itemId], {
          item: {
            ...previousData.item,
            status: 'IN_PROGRESS',
            assignee_id: user.id,
            version: previousData.item.version + 1
          }
        });
      }
      return { previousData };
    },
    onError: (err: any, _vars, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['item', itemId], context.previousData);
      }

      if (err instanceof ApiError) {
        if (err.code === 'ALREADY_CLAIMED') {
          setErrorBanner({
            type: 'ALREADY_CLAIMED',
            message: 'This item has already been claimed by another user.'
          });
          queryClient.invalidateQueries({ queryKey: ['item', itemId] });
        } else if (err.status === 403) {
          setErrorBanner({ type: 'FORBIDDEN', message: err.message });
        } else {
          setErrorBanner({ type: 'GENERAL', message: err.message });
        }
      } else {
        setErrorBanner({ type: 'GENERAL', message: 'Failed to claim item.' });
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['item', itemId], { item: data.item });
      showToast('You successfully claimed this item.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['activity', itemId] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    }
  });

  // 2. Transition Mutation (Optimistic Update)
  const transitionMutation = useMutation({
    mutationFn: (variables: { to_status: WorkItemStatus; reason?: string }) => {
      if (!item) throw new Error('Item missing');
      return apiClient<{ item: WorkItem }>(`/items/${itemId}/transition`, {
        method: 'POST',
        body: JSON.stringify({
          version: item.version,
          to_status: variables.to_status,
          reason: variables.reason?.trim() || undefined
        })
      });
    },
    onMutate: async (vars) => {
      setErrorBanner(null);
      await queryClient.cancelQueries({ queryKey: ['item', itemId] });
      const previousData = queryClient.getQueryData<{ item: WorkItem }>(['item', itemId]);

      if (previousData?.item) {
        queryClient.setQueryData<{ item: WorkItem }>(['item', itemId], {
          item: {
            ...previousData.item,
            status: vars.to_status,
            version: previousData.item.version + 1
          }
        });
      }
      return { previousData };
    },
    onError: (err: any, _vars, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['item', itemId], context.previousData);
      }

      if (err instanceof ApiError) {
        if (err.code === 'STALE_VERSION' || err.status === 409) {
          setErrorBanner({
            type: 'STALE_VERSION',
            message: 'This item was modified by someone else. Reload to see the latest version.'
          });
        } else if (err.status === 403) {
          setErrorBanner({ type: 'FORBIDDEN', message: err.message });
        } else {
          setErrorBanner({ type: 'GENERAL', message: err.message });
        }
      } else {
        setErrorBanner({ type: 'GENERAL', message: 'Failed to transition item.' });
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['item', itemId], { item: data.item });
      setTransitionReason('');
      showToast(`Status changed to ${data.item.status}.`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['activity', itemId] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    }
  });

  // 3. Edit Metadata Mutation
  const editMutation = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('Item missing');
      const payload: any = {
        version: item.version,
        title: editTitle.trim(),
        description: editDescription.trim()
      };
      if (isLeadOrAdmin && editPriority !== item.priority) {
        payload.priority = editPriority;
      }

      return apiClient<{ item: WorkItem }>(`/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
    },
    onSuccess: (data) => {
      setIsEditing(false);
      setErrorBanner(null);
      queryClient.setQueryData(['item', itemId], { item: data.item });
      showToast('Item updated successfully.');
      queryClient.invalidateQueries({ queryKey: ['activity', itemId] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
    },
    onError: (err: any) => {
      if (err instanceof ApiError) {
        if (err.code === 'STALE_VERSION' || err.status === 409) {
          // Rule: Show reload banner WITHOUT losing user's unsaved draft edit inputs!
          setErrorBanner({
            type: 'STALE_VERSION',
            message: 'This item was modified by someone else. Reload to see the latest version.'
          });
        } else if (err.status === 403) {
          setErrorBanner({ type: 'FORBIDDEN', message: err.message });
        } else {
          setErrorBanner({ type: 'GENERAL', message: err.message });
        }
      } else {
        setErrorBanner({ type: 'GENERAL', message: 'Failed to save changes.' });
      }
    }
  });

  // 4. Assign Mutation
  const assignMutation = useMutation({
    mutationFn: (newAssigneeId: string | null) => {
      if (!item) throw new Error('Item missing');
      return apiClient<{ item: WorkItem }>(`/items/${itemId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          version: item.version,
          assignee_id: newAssigneeId || null
        })
      });
    },
    onSuccess: (data) => {
      setErrorBanner(null);
      queryClient.setQueryData(['item', itemId], { item: data.item });
      showToast(data.item.assignee_id ? 'Assignee updated.' : 'Item unassigned.');
      queryClient.invalidateQueries({ queryKey: ['activity', itemId] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (err: any) => {
      if (err instanceof ApiError) {
        if (err.code === 'STALE_VERSION' || err.status === 409) {
          setErrorBanner({
            type: 'STALE_VERSION',
            message: 'This item was modified by someone else. Reload to see the latest version.'
          });
        } else if (err.status === 403) {
          setErrorBanner({ type: 'FORBIDDEN', message: err.message });
        } else {
          setErrorBanner({ type: 'GENERAL', message: err.message });
        }
      } else {
        setErrorBanner({ type: 'GENERAL', message: 'Failed to assign item.' });
      }
    }
  });

  // 5. Add Comment Mutation
  const commentMutation = useMutation({
    mutationFn: () => {
      if (!commentBody.trim()) throw new Error('Comment body required.');
      return apiClient<{ comment: any }>(`/items/${itemId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: commentBody.trim() })
      });
    },
    onSuccess: () => {
      setCommentBody('');
      showToast('Comment posted.');
      queryClient.invalidateQueries({ queryKey: ['activity', itemId] });
    },
    onError: (err: any) => {
      if (err instanceof ApiError) {
        setErrorBanner({ type: 'GENERAL', message: err.message });
      } else {
        setErrorBanner({ type: 'GENERAL', message: 'Failed to post comment.' });
      }
    }
  });

  // Handle reload for stale version: refetches item version without wiping edit state
  const handleReloadLatest = async () => {
    setErrorBanner(null);
    await refetchItem();
    showToast('Latest item state reloaded.');
  };

  // 404 Handler
  if (itemError && itemError.status === 404) {
    return (
      <div className="not-found-container">
        <div className="not-found-card">
          <h2>Item Not Found</h2>
          <p>The requested work item does not exist or you lack permission to view this team's items.</p>
          <button type="button" className="btn btn-primary" onClick={onBack}>
            ← Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (itemLoading) {
    return <div className="loading-state">Loading item details...</div>;
  }

  if (!item) {
    return null;
  }

  const isClaimable = item.status === 'OPEN' && !item.assignee_id && isMemberPlus;

  return (
    <div className="detail-container">
      {/* Detail Header Bar */}
      <div className="detail-topbar">
        <button type="button" className="btn btn-outline btn-sm" onClick={onBack}>
          ← Back to Dashboard
        </button>
        <div className="version-indicator">
          <span>Current Version: <strong>v{item.version}</strong></span>
        </div>
      </div>

      {/* Success Notification */}
      {successToast && (
        <div className="banner banner-success" role="status">
          <span>✓ {successToast}</span>
        </div>
      )}

      {/* Error Banners */}
      {errorBanner && (
        <div className="banner banner-error" role="alert">
          <div className="banner-content">
            <span>⚠️ {errorBanner.message}</span>
            {errorBanner.type === 'STALE_VERSION' && (
              <button
                type="button"
                className="btn btn-sm btn-primary ml-auto"
                onClick={handleReloadLatest}
              >
                Reload Latest Version
              </button>
            )}
          </div>
        </div>
      )}

      <div className="detail-layout">
        {/* Left Column: Item Information & Actions */}
        <section className="detail-main-col">
          <div className="card item-overview-card">
            <div className="item-header-row">
              <div className="badges-group">
                <span className={`badge badge-type badge-type-${item.type.toLowerCase()}`}>
                  {item.type}
                </span>
                <span className={`badge badge-priority badge-priority-${item.priority.toLowerCase()}`}>
                  {item.priority}
                </span>
                <span className={`badge badge-status badge-status-${item.status.toLowerCase()}`}>
                  {item.status}
                </span>
              </div>

              {!isEditing && isMemberPlus && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => setIsEditing(true)}
                >
                  Edit Details
                </button>
              )}
            </div>

            {/* View or Edit Title & Description */}
            {isEditing ? (
              <div className="edit-form-wrap">
                <div className="form-group">
                  <label htmlFor="edit-title">Title</label>
                  <input
                    id="edit-title"
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    disabled={editMutation.isPending}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="edit-desc">Description</label>
                  <textarea
                    id="edit-desc"
                    rows={4}
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    disabled={editMutation.isPending}
                  />
                </div>

                {isLeadOrAdmin && (
                  <div className="form-group">
                    <label htmlFor="edit-priority">Priority (Lead/Admin Only)</label>
                    <select
                      id="edit-priority"
                      value={editPriority}
                      onChange={(e) => setEditPriority(e.target.value as WorkItemPriority)}
                      disabled={editMutation.isPending}
                    >
                      <option value="LOW">LOW</option>
                      <option value="MEDIUM">MEDIUM</option>
                      <option value="HIGH">HIGH</option>
                      <option value="URGENT">URGENT</option>
                    </select>
                  </div>
                )}

                <div className="form-actions-inline">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => {
                      setIsEditing(false);
                      setEditTitle(item.title);
                      setEditDescription(item.description || '');
                      setEditPriority(item.priority);
                    }}
                    disabled={editMutation.isPending}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => editMutation.mutate()}
                    disabled={editMutation.isPending || !editTitle.trim()}
                  >
                    {editMutation.isPending ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="item-content-view">
                <h1 className="item-title-heading">{item.title}</h1>
                <p className="item-description-text">
                  {item.description || <em className="muted">No description provided.</em>}
                </p>
              </div>
            )}
          </div>

          {/* Action Panel */}
          <div className="card actions-card">
            <h3>Operational Actions</h3>

            <div className="actions-grid">
              {/* Claim Action */}
              <div className="action-box">
                <h4>Claim Ownership</h4>
                <p className="action-help">Take responsibility for this open work item.</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => claimMutation.mutate()}
                  disabled={!isClaimable || claimMutation.isPending}
                >
                  {claimMutation.isPending
                    ? 'Claiming...'
                    : item.assignee_id
                    ? 'Already Claimed'
                    : 'Claim Item'}
                </button>
              </div>

              {/* Status Transition Action */}
              <div className="action-box">
                <h4>Status Transition</h4>
                <p className="action-help">Move item according to state machine workflows.</p>
                <div className="transition-form">
                  <select
                    value={transitionStatus}
                    onChange={(e) => setTransitionStatus(e.target.value as WorkItemStatus)}
                    disabled={transitionMutation.isPending || !isMemberPlus}
                    className="select-input"
                  >
                    <option value="OPEN">OPEN</option>
                    <option value="IN_PROGRESS">IN_PROGRESS</option>
                    <option value="AWAITING_APPROVAL">AWAITING_APPROVAL</option>
                    <option value="RESOLVED">RESOLVED</option>
                    <option value="CLOSED">CLOSED</option>
                  </select>

                  <input
                    type="text"
                    placeholder="Reason (required for rejection/cancellation)..."
                    value={transitionReason}
                    onChange={(e) => setTransitionReason(e.target.value)}
                    disabled={transitionMutation.isPending || !isMemberPlus}
                    className="text-input"
                  />

                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() =>
                      transitionMutation.mutate({
                        to_status: transitionStatus,
                        reason: transitionReason
                      })
                    }
                    disabled={
                      transitionMutation.isPending ||
                      transitionStatus === item.status ||
                      !isMemberPlus
                    }
                  >
                    {transitionMutation.isPending ? 'Moving...' : 'Move Status'}
                  </button>
                </div>
              </div>

              {/* Reassign Action (Lead/Admin) */}
              {isLeadOrAdmin && (
                <div className="action-box">
                  <h4>Assignee Control (Lead/Admin)</h4>
                  <p className="action-help">Reassign or unassign member for this item.</p>
                  <div className="reassign-form">
                    <select
                      value={selectedAssignee}
                      onChange={(e) => setSelectedAssignee(e.target.value)}
                      disabled={assignMutation.isPending}
                      className="select-input"
                    >
                      <option value="">Unassigned</option>
                      {teamMembersData?.members.map((tm) => (
                        <option key={tm.id} value={tm.id}>
                          {tm.full_name} ({tm.role})
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => assignMutation.mutate(selectedAssignee || null)}
                      disabled={
                        assignMutation.isPending ||
                        (selectedAssignee || null) === item.assignee_id
                      }
                    >
                      {assignMutation.isPending ? 'Updating...' : 'Assign'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Activity Log & Comments */}
          <div className="card activity-card">
            <h3>Append-Only Activity History</h3>

            {/* Comment Box */}
            <div className="comment-composer">
              <textarea
                rows={2}
                placeholder="Leave an operational note or status comment..."
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                disabled={commentMutation.isPending}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => commentMutation.mutate()}
                disabled={commentMutation.isPending || !commentBody.trim()}
              >
                {commentMutation.isPending ? 'Posting...' : 'Post Comment'}
              </button>
            </div>

            {/* Timeline */}
            <div className="timeline-list">
              {activityLoading ? (
                <div className="loading-state">Loading activity timeline...</div>
              ) : allActivity.length === 0 ? (
                <div className="empty-state">No activity events recorded yet.</div>
              ) : (
                allActivity.map((event) => (
                  <div key={event.id} className="timeline-entry">
                    <div className="timeline-marker"></div>
                    <div className="timeline-body">
                      <div className="timeline-head">
                        <span className="event-badge">{event.event_type}</span>
                        <span className="event-date">
                          {new Date(event.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="event-details">
                        {event.event_type === 'COMMENT_ADDED' && (
                          <p className="comment-text">"{event.metadata?.body_preview}"</p>
                        )}
                        {event.event_type === 'STATUS_TRANSITIONED' && (
                          <p className="transition-desc">
                            Moved from <strong>{event.from_state?.status}</strong> to{' '}
                            <strong>{event.to_state?.status}</strong>
                            {event.metadata?.reason && ` (Reason: ${event.metadata.reason})`}
                          </p>
                        )}
                        {event.event_type === 'CLAIMED' && (
                          <p className="claim-desc">Claimed and moved to IN_PROGRESS.</p>
                        )}
                        {event.event_type === 'ASSIGNED' && (
                          <p className="assign-desc">
                            Assignee updated: {event.to_state?.assignee_id ? 'Assigned' : 'Unassigned'}
                          </p>
                        )}
                        {event.event_type === 'PRIORITY_CHANGED' && (
                          <p className="priority-desc">
                            Priority updated to {event.to_state?.priority}.
                          </p>
                        )}
                        {event.event_type === 'METADATA_UPDATED' && (
                          <p className="metadata-desc">Title or description updated.</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {hasActivityNext && (
              <button
                type="button"
                className="btn btn-outline btn-block mt-3"
                onClick={() => fetchNextActivity()}
                disabled={fetchingActivityNext}
              >
                {fetchingActivityNext ? 'Loading more activity...' : 'Load older activity'}
              </button>
            )}
          </div>
        </section>

        {/* Right Column: Metadata Sidebar */}
        <aside className="detail-sidebar-col">
          <div className="card sidebar-meta-card">
            <h4>Work Item Metadata</h4>
            <dl className="meta-list">
              <div className="meta-item">
                <dt>Item ID</dt>
                <dd className="mono-sub">{item.id}</dd>
              </div>
              <div className="meta-item">
                <dt>Assignee</dt>
                <dd>
                  {item.assignee_id
                    ? item.assignee_id === user.id
                      ? 'Assigned to You'
                      : teamMembersData?.members.find((m) => m.id === item.assignee_id)?.full_name || item.assignee_id
                    : 'Unassigned'}
                </dd>
              </div>
              <div className="meta-item">
                <dt>Created By</dt>
                <dd className="mono-sub">{item.created_by_id}</dd>
              </div>
              <div className="meta-item">
                <dt>Created At</dt>
                <dd>{new Date(item.created_at).toLocaleString()}</dd>
              </div>
              <div className="meta-item">
                <dt>Last Updated</dt>
                <dd>{new Date(item.updated_at).toLocaleString()}</dd>
              </div>
              {item.due_date && (
                <div className="meta-item">
                  <dt>Due Date</dt>
                  <dd>{new Date(item.due_date).toLocaleString()}</dd>
                </div>
              )}
              <div className="meta-item">
                <dt>Optimistic Lock Version</dt>
                <dd>v{item.version}</dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
};
