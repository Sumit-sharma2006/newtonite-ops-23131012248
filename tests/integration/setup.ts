import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { env } from '../../backend/src/config/env.js';
import { pool } from '../../backend/src/db/pool.js';
import { UserTeamRole, WorkItemPriority, WorkItemStatus, WorkItemType } from '../../backend/src/types/domain.js';

export interface TestUser {
  id: string;
  email: string;
  name: string;
  token: string;
}

export interface TestFixture {
  teamA: { id: string; name: string };
  teamB: { id: string; name: string };
  leadA: TestUser;
  memberA1: TestUser;
  memberA2: TestUser;
  viewerA: TestUser;
  memberB: TestUser;
  dualUser: TestUser;
}

export const signTestToken = (userId: string): string => {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: '1h' });
};

/**
 * Truncates all tables and sets up the standard 2-team test fixture.
 * MUST be run before each integration test file.
 */
export async function cleanAndSeedFixture(): Promise<TestFixture> {
  // Truncate tables with CASCADE (restarting identity, trigger blocks DELETE but allows TRUNCATE)
  await pool.query(`
    TRUNCATE TABLE 
      notifications,
      outbox_jobs,
      idempotency_keys,
      comments,
      activity_events,
      work_items,
      memberships,
      teams,
      users 
    RESTART IDENTITY CASCADE;
  `);

  // 1. Teams
  const teamARes = await pool.query(
    `INSERT INTO teams (name, slug) VALUES ('Team Alpha', 'team-alpha') RETURNING id, name;`
  );
  const teamBRes = await pool.query(
    `INSERT INTO teams (name, slug) VALUES ('Team Beta', 'team-beta') RETURNING id, name;`
  );

  const teamA = teamARes.rows[0];
  const teamB = teamBRes.rows[0];

  // 2. Users
  const passwordHash = await bcrypt.hash('Password123!', 8);
  const userDefs = [
    { key: 'leadA', email: 'lead.a@pressuredesk.io', name: 'Lead Alice' },
    { key: 'memberA1', email: 'member.a1@pressuredesk.io', name: 'Member A1' },
    { key: 'memberA2', email: 'member.a2@pressuredesk.io', name: 'Member A2' },
    { key: 'viewerA', email: 'viewer.a@pressuredesk.io', name: 'Viewer Alan' },
    { key: 'memberB', email: 'member.b@pressuredesk.io', name: 'Member Bob' },
    { key: 'dualUser', email: 'dual.user@pressuredesk.io', name: 'Dual Role User' }
  ];

  const users: Record<string, TestUser> = {};
  for (const u of userDefs) {
    const res = await pool.query(
      `INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name;`,
      [u.email, passwordHash, u.name]
    );
    users[u.key] = {
      id: res.rows[0].id,
      email: res.rows[0].email,
      name: res.rows[0].full_name,
      token: signTestToken(res.rows[0].id)
    };
  }

  // 3. Memberships
  const membershipDefs: [string, string, UserTeamRole][] = [
    [users.leadA.id, teamA.id, 'LEAD'],
    [users.memberA1.id, teamA.id, 'MEMBER'],
    [users.memberA2.id, teamA.id, 'MEMBER'],
    [users.viewerA.id, teamA.id, 'VIEWER'],
    [users.memberB.id, teamB.id, 'MEMBER'],
    [users.dualUser.id, teamA.id, 'VIEWER'], // Viewer in Team A
    [users.dualUser.id, teamB.id, 'LEAD']     // Lead in Team B
  ];

  for (const [userId, teamId, role] of membershipDefs) {
    await pool.query(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3);`,
      [userId, teamId, role]
    );
  }

  return {
    teamA,
    teamB,
    leadA: users.leadA,
    memberA1: users.memberA1,
    memberA2: users.memberA2,
    viewerA: users.viewerA,
    memberB: users.memberB,
    dualUser: users.dualUser
  };
}

/**
 * Direct SQL helper to insert items with explicit overrides
 */
export async function createItemDirect(overrides: {
  team_id: string;
  title?: string;
  description?: string;
  type?: WorkItemType;
  priority?: WorkItemPriority;
  status?: WorkItemStatus;
  assignee_id?: string | null;
  created_by_id: string;
  due_date?: string | null;
  version?: number;
  created_at?: string;
}) {
  const res = await pool.query(
    `INSERT INTO work_items (
       team_id, title, description, type, priority, status,
       assignee_id, created_by_id, due_date, version, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, NOW()), COALESCE($11::timestamptz, NOW()))
     RETURNING id, title, description, type, priority, status, team_id, assignee_id,
               created_by_id, due_date, version, created_at::text AS cursor_ts, created_at, updated_at;`,
    [
      overrides.team_id,
      overrides.title || 'Direct SQL Test Item',
      overrides.description || '',
      overrides.type || 'TASK',
      overrides.priority || 'MEDIUM',
      overrides.status || 'OPEN',
      overrides.assignee_id || null,
      overrides.created_by_id,
      overrides.due_date || null,
      overrides.version || 1,
      overrides.created_at || null
    ]
  );
  return res.rows[0];
}
