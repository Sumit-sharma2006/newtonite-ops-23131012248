import React, { useState, useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, ApiError } from '../api/client';
import {
  UserProfile,
  DashboardSummary,
  PaginatedItemsResponse,
  WorkItem,
  WorkItemPriority,
  WorkItemType
} from '../types/api';

interface DashboardPageProps {
  user: UserProfile;
  onSelectItem: (id: string) => void;
  onLogout: () => void;
}

type TabType = 'assigned_to_me' | 'unassigned_urgent' | 'awaiting_my_approval';

export const DashboardPage: React.FC<DashboardPageProps> = ({
  user,
  onSelectItem,
  onLogout
}) => {
  const queryClient = useQueryClient();

  // Selected team state (defaults to user's first team if available)
  const [selectedTeamId, setSelectedTeamId] = useState<string>(
    user.memberships.length > 0 ? user.memberships[0].team_id : ''
  );

  // Active tab state
  const [activeTab, setActiveTab] = useState<TabType>('assigned_to_me');

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [priorityFilter, setPriorityFilter] = useState<string>('');
  const [searchInput, setSearchInput] = useState<string>('');
  const [debouncedQ, setDebouncedQ] = useState<string>('');

  // Modal create item state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');
  const [createTitle, setCreateTitle] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createType, setCreateType] = useState<WorkItemType>('INCIDENT');
  const [createPriority, setCreatePriority] = useState<WorkItemPriority>('MEDIUM');
  const [createDueDate, setCreateDueDate] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  // 300ms debounce on search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQ(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Current user's role in the selected team
  const currentMembership = useMemo(() => {
    return user.memberships.find((m) => m.team_id === selectedTeamId);
  }, [user.memberships, selectedTeamId]);

  const canCreateInTeam = currentMembership && ['MEMBER', 'LEAD', 'ADMIN'].includes(currentMembership.role);

  // Fetch summary counts
  const { data: summary } = useQuery<DashboardSummary>({
    queryKey: ['dashboard-summary', selectedTeamId],
    queryFn: async () => {
      const url = selectedTeamId
        ? `/dashboard/summary?team_id=${encodeURIComponent(selectedTeamId)}`
        : '/dashboard/summary';
      return apiClient<DashboardSummary>(url);
    },
    refetchInterval: 30000
  });

  // Infinite query for items
  const {
    data,
    error,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage
  } = useInfiniteQuery<PaginatedItemsResponse, ApiError>({
    queryKey: ['items', { selectedTeamId, activeTab, statusFilter, priorityFilter, debouncedQ }],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (selectedTeamId) params.set('team_id', selectedTeamId);
      if (activeTab) params.set('view', activeTab);
      if (statusFilter) params.set('status', statusFilter);
      if (priorityFilter) params.set('priority', priorityFilter);
      if (debouncedQ) params.set('q', debouncedQ);
      if (pageParam && typeof pageParam === 'string') {
        params.set('cursor', pageParam);
      }
      params.set('limit', '20');

      return apiClient<PaginatedItemsResponse>(`/items?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => (lastPage.has_more && lastPage.next_cursor ? lastPage.next_cursor : undefined)
  });

  // Open create form: generate UUID once per open
  const handleOpenCreate = () => {
    setIdempotencyKey(crypto.randomUUID());
    setCreateTitle('');
    setCreateDescription('');
    setCreateType('INCIDENT');
    setCreatePriority('MEDIUM');
    setCreateDueDate('');
    setCreateError(null);
    setIsCreateOpen(true);
  };

  // Create item mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTeamId) throw new Error('No team selected.');
      if (!createTitle.trim()) throw new Error('Title is required.');

      return apiClient<{ item: WorkItem }>('/items', {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify({
          team_id: selectedTeamId,
          title: createTitle.trim(),
          description: createDescription.trim(),
          type: createType,
          priority: createPriority,
          due_date: createDueDate ? new Date(createDueDate).toISOString() : null
        })
      });
    },
    onSuccess: (data) => {
      setIsCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      if (data.item?.id) {
        onSelectItem(data.item.id);
      }
    },
    onError: (err: any) => {
      if (err instanceof ApiError) {
        setCreateError(err.message || `Error (${err.code})`);
      } else {
        setCreateError(err.message || 'Failed to create work item.');
      }
      // Note: We DO NOT change idempotencyKey here so retries reuse the same key!
    }
  });

  const allItems: WorkItem[] = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap((page) => page.items);
  }, [data]);

  return (
    <div className="dashboard-container">
      {/* Top Navbar */}
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-logo">⚡</span>
          <span className="brand-name">PressureDesk</span>
          <span className="brand-tag">Ops Under Pressure</span>
        </div>

        <div className="topbar-actions">
          {/* Team selector */}
          <div className="team-selector-wrap">
            <label htmlFor="team-select" className="visually-hidden">Active Team</label>
            <select
              id="team-select"
              className="select-input team-select"
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
            >
              {user.memberships.map((m) => (
                <option key={m.team_id} value={m.team_id}>
                  {m.team_name} ({m.role})
                </option>
              ))}
            </select>
          </div>

          <div className="user-profile-badge">
            <span className="user-name">{user.full_name}</span>
            <span className="user-role-chip">{currentMembership?.role || 'NO ROLE'}</span>
          </div>

          <button type="button" className="btn btn-outline btn-sm" onClick={onLogout}>
            Sign Out
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="dashboard-main">
        {/* Metric Cards */}
        <section className="metrics-grid">
          <div
            className={`metric-card ${activeTab === 'assigned_to_me' ? 'active' : ''}`}
            onClick={() => setActiveTab('assigned_to_me')}
          >
            <div className="metric-label">Assigned to Me</div>
            <div className="metric-val">{summary?.assigned_to_me ?? '...'}</div>
            <div className="metric-sub">Active items in progress</div>
          </div>

          <div
            className={`metric-card metric-urgent ${activeTab === 'unassigned_urgent' ? 'active' : ''}`}
            onClick={() => setActiveTab('unassigned_urgent')}
          >
            <div className="metric-label">Unassigned Urgent</div>
            <div className="metric-val">{summary?.unassigned_urgent ?? '...'}</div>
            <div className="metric-sub">Requires immediate triage</div>
          </div>

          <div
            className={`metric-card metric-approval ${activeTab === 'awaiting_my_approval' ? 'active' : ''}`}
            onClick={() => setActiveTab('awaiting_my_approval')}
          >
            <div className="metric-label">Awaiting Approval</div>
            <div className="metric-val">{summary?.awaiting_my_approval ?? '...'}</div>
            <div className="metric-sub">Pending four-eyes signoff</div>
          </div>
        </section>

        {/* Toolbar & Filters */}
        <section className="dashboard-toolbar">
          <div className="tabs-row">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'assigned_to_me' ? 'active' : ''}`}
              onClick={() => setActiveTab('assigned_to_me')}
            >
              Assigned to me
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'unassigned_urgent' ? 'active' : ''}`}
              onClick={() => setActiveTab('unassigned_urgent')}
            >
              Unassigned urgent
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'awaiting_my_approval' ? 'active' : ''}`}
              onClick={() => setActiveTab('awaiting_my_approval')}
            >
              Awaiting my approval
            </button>
          </div>

          <div className="toolbar-controls">
            <div className="search-wrap">
              <input
                type="text"
                placeholder="Search items (title/desc)..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="search-input"
              />
              {searchInput && (
                <button
                  type="button"
                  className="clear-search-btn"
                  onClick={() => setSearchInput('')}
                >
                  ✕
                </button>
              )}
            </div>

            <select
              className="select-input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All Statuses</option>
              <option value="OPEN">OPEN</option>
              <option value="IN_PROGRESS">IN_PROGRESS</option>
              <option value="AWAITING_APPROVAL">AWAITING_APPROVAL</option>
              <option value="RESOLVED">RESOLVED</option>
              <option value="CLOSED">CLOSED</option>
            </select>

            <select
              className="select-input"
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
            >
              <option value="">All Priorities</option>
              <option value="LOW">LOW</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="HIGH">HIGH</option>
              <option value="URGENT">URGENT</option>
            </select>

            {canCreateInTeam && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleOpenCreate}
              >
                + New Item
              </button>
            )}
          </div>
        </section>

        {/* Work Items Feed */}
        <section className="items-feed">
          {error && (
            <div className="banner banner-error" role="alert">
              <span>⚠️ Failed to load items: {error.message}</span>
            </div>
          )}

          {isLoading ? (
            <div className="loading-state">Loading operational queue...</div>
          ) : allItems.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📂</div>
              <h3>No work items found</h3>
              <p>There are no items matching the selected filters or queue.</p>
            </div>
          ) : (
            <div className="items-list">
              {allItems.map((item) => (
                <article
                  key={item.id}
                  className="item-card"
                  onClick={() => onSelectItem(item.id)}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSelectItem(item.id);
                  }}
                >
                  <div className="item-card-main">
                    <div className="item-badges">
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
                    <h3 className="item-title">{item.title}</h3>
                    {item.description && (
                      <p className="item-desc-snippet">{item.description}</p>
                    )}
                  </div>

                  <div className="item-card-meta">
                    <div className="meta-row">
                      <span className="meta-label">Version:</span>
                      <span className="meta-val">v{item.version}</span>
                    </div>
                    <div className="meta-row">
                      <span className="meta-label">Assignee:</span>
                      <span className="meta-val">
                        {item.assignee_id ? (item.assignee_id === user.id ? 'You' : 'Assigned') : 'Unassigned'}
                      </span>
                    </div>
                    {item.due_date && (
                      <div className="meta-row">
                        <span className="meta-label">Due:</span>
                        <span className="meta-val">{new Date(item.due_date).toLocaleDateString()}</span>
                      </div>
                    )}
                    <div className="meta-row meta-date">
                      {new Date(item.created_at).toLocaleString()}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {/* Load More Button (Never load all at once) */}
          {hasNextPage && (
            <div className="pagination-bar">
              <button
                type="button"
                className="btn btn-outline btn-block"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading more items...' : 'Load more items'}
              </button>
            </div>
          )}
        </section>
      </main>

      {/* Create Item Modal */}
      {isCreateOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-header">
              <h2>Create Operational Work Item</h2>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsCreateOpen(false)}
                disabled={createMutation.isPending}
              >
                ✕
              </button>
            </div>

            {createError && (
              <div className="banner banner-error" role="alert">
                <span>⚠️ {createError}</span>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate();
              }}
              className="form-stack"
            >
              <div className="form-group">
                <label htmlFor="create-title">Title *</label>
                <input
                  id="create-title"
                  type="text"
                  required
                  placeholder="e.g. Critical Gateway Latency Spike"
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                  disabled={createMutation.isPending}
                />
              </div>

              <div className="form-group">
                <label htmlFor="create-desc">Description</label>
                <textarea
                  id="create-desc"
                  rows={3}
                  placeholder="Details, impact, error logs, or replication steps..."
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  disabled={createMutation.isPending}
                />
              </div>

              <div className="form-row-2">
                <div className="form-group">
                  <label htmlFor="create-type">Type</label>
                  <select
                    id="create-type"
                    value={createType}
                    onChange={(e) => setCreateType(e.target.value as WorkItemType)}
                    disabled={createMutation.isPending}
                  >
                    <option value="INCIDENT">INCIDENT</option>
                    <option value="CUSTOMER_ISSUE">CUSTOMER_ISSUE</option>
                    <option value="PAYMENT">PAYMENT</option>
                    <option value="COMPLIANCE">COMPLIANCE</option>
                    <option value="TASK">TASK</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="create-priority">Priority</label>
                  <select
                    id="create-priority"
                    value={createPriority}
                    onChange={(e) => setCreatePriority(e.target.value as WorkItemPriority)}
                    disabled={createMutation.isPending}
                  >
                    <option value="LOW">LOW</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="HIGH">HIGH</option>
                    <option value="URGENT">URGENT</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="create-due">Due Date (Optional)</label>
                <input
                  id="create-due"
                  type="datetime-local"
                  value={createDueDate}
                  onChange={(e) => setCreateDueDate(e.target.value)}
                  disabled={createMutation.isPending}
                />
              </div>

              <div className="idempotency-indicator">
                <span className="mono-sub">Idempotency-Key: {idempotencyKey.slice(0, 13)}...</span>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={createMutation.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={createMutation.isPending || !createTitle.trim()}
                >
                  {createMutation.isPending ? 'Submitting...' : 'Create Item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
