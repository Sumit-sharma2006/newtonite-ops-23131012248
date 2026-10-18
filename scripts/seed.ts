import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 
  `postgres://${process.env.DB_USER || 'pressuredesk'}:${process.env.DB_PASSWORD || 'pressuredesk123'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'pressuredesk'}`;

const pool = new Pool({ connectionString });

const ROLL_NO = process.env.ROLL_NO || '<rollno>';

async function seed() {
  const client = await pool.connect();
  try {
    console.log(`Starting seed process for PressureDesk [Roll No: ${ROLL_NO}]...`);

    // Clean existing data using TRUNCATE (avoids activity_events BEFORE DELETE trigger error)
    console.log('Truncating existing tables...');
    await client.query(`
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
      CASCADE;
    `);

    // 1. Seed Users (10 users with bcrypt hashed passwords)
    console.log('Seeding 10 users...');
    const defaultPassword = 'Password123!';
    const passwordHash = await bcrypt.hash(defaultPassword, 10);

    const userDefinitions = [
      { email: `alice.${ROLL_NO}@pressuredesk.io`, name: 'Alice Walker' },
      { email: `bob.${ROLL_NO}@pressuredesk.io`, name: 'Bob Martinez' },
      { email: `charlie.${ROLL_NO}@pressuredesk.io`, name: 'Charlie Chen' },
      { email: `dave.${ROLL_NO}@pressuredesk.io`, name: 'Dave Patel' },
      { email: `eve.${ROLL_NO}@pressuredesk.io`, name: 'Eve Johnson' },
      { email: `frank.${ROLL_NO}@pressuredesk.io`, name: 'Frank Taylor' },
      { email: `grace.${ROLL_NO}@pressuredesk.io`, name: 'Grace Hopper' },
      { email: `heidi.${ROLL_NO}@pressuredesk.io`, name: 'Heidi Davis' },
      { email: `ivan.${ROLL_NO}@pressuredesk.io`, name: 'Ivan Petrov' },
      { email: `judy.${ROLL_NO}@pressuredesk.io`, name: 'Judy Robinson' }
    ];

    const userIds: string[] = [];
    for (const u of userDefinitions) {
      const res = await client.query(
        `INSERT INTO users (email, password_hash, full_name) 
         VALUES ($1, $2, $3) 
         RETURNING id;`,
        [u.email, passwordHash, u.name]
      );
      userIds.push(res.rows[0].id);
    }
    console.log(`Seeded ${userIds.length} users. (Default password: ${defaultPassword})`);

    // 2. Seed 4 Teams
    console.log('Seeding 4 operational teams...');
    const teamDefinitions = [
      { name: 'Incident Response', slug: 'incident-response' },
      { name: 'Payments & Billing', slug: 'payments-billing' },
      { name: 'Compliance & Risk', slug: 'compliance-risk' },
      { name: 'Core Infrastructure', slug: 'core-infra' }
    ];

    const teamIds: string[] = [];
    for (const t of teamDefinitions) {
      const res = await client.query(
        `INSERT INTO teams (name, slug) 
         VALUES ($1, $2) 
         RETURNING id;`,
        [t.name, t.slug]
      );
      teamIds.push(res.rows[0].id);
    }
    console.log(`Seeded ${teamIds.length} teams.`);

    // 3. Seed Memberships with explicit roles per team
    console.log('Seeding team memberships...');
    // Alice: Admin in Core Infra, Lead in Incident Response, Member in Payments
    // Bob: Lead in Payments, Member in Incident Response
    // Charlie: Lead in Compliance, Member in Core Infra
    // Dave, Eve, Frank, Grace, Heidi: Members across various teams
    // Ivan, Judy: Viewers
    const memberships = [
      // Incident Response (team 0)
      { userId: userIds[0], teamId: teamIds[0], role: 'LEAD' },
      { userId: userIds[1], teamId: teamIds[0], role: 'MEMBER' },
      { userId: userIds[3], teamId: teamIds[0], role: 'MEMBER' },
      { userId: userIds[4], teamId: teamIds[0], role: 'MEMBER' },
      { userId: userIds[8], teamId: teamIds[0], role: 'VIEWER' },

      // Payments & Billing (team 1)
      { userId: userIds[1], teamId: teamIds[1], role: 'LEAD' },
      { userId: userIds[0], teamId: teamIds[1], role: 'MEMBER' },
      { userId: userIds[4], teamId: teamIds[1], role: 'MEMBER' },
      { userId: userIds[5], teamId: teamIds[1], role: 'MEMBER' },
      { userId: userIds[9], teamId: teamIds[1], role: 'VIEWER' },

      // Compliance & Risk (team 2)
      { userId: userIds[2], teamId: teamIds[2], role: 'LEAD' },
      { userId: userIds[6], teamId: teamIds[2], role: 'MEMBER' },
      { userId: userIds[7], teamId: teamIds[2], role: 'MEMBER' },
      { userId: userIds[8], teamId: teamIds[2], role: 'VIEWER' },

      // Core Infrastructure (team 3)
      { userId: userIds[0], teamId: teamIds[3], role: 'ADMIN' },
      { userId: userIds[2], teamId: teamIds[3], role: 'MEMBER' },
      { userId: userIds[5], teamId: teamIds[3], role: 'MEMBER' },
      { userId: userIds[7], teamId: teamIds[3], role: 'MEMBER' },
      { userId: userIds[9], teamId: teamIds[3], role: 'VIEWER' }
    ];

    for (const m of memberships) {
      await client.query(
        `INSERT INTO memberships (user_id, team_id, role) 
         VALUES ($1, $2, $3);`,
        [m.userId, m.teamId, m.role]
      );
    }
    console.log(`Seeded ${memberships.length} memberships.`);

    // 4. Batch Seed 5,200 Work Items using high-performance generate_series in SQL
    console.log('Batch seeding 5,200 work items with realistic statuses and priorities...');
    
    // We construct a single optimized SQL statement that generates rows across all 4 teams:
    // - Unassigned urgent items (priority = 'URGENT', status = 'OPEN', assignee_id = NULL)
    // - Awaiting approval items (status = 'AWAITING_APPROVAL')
    // - Assigned active items for users (status IN ('IN_PROGRESS', 'AWAITING_APPROVAL', 'OPEN'))
    // - Resolved and Closed items
    const seedItemsSql = `
      WITH team_array AS (
        SELECT ARRAY[${teamIds.map(id => `'${id}'::uuid`).join(',')}] AS teams
      ),
      user_array AS (
        SELECT ARRAY[${userIds.map(id => `'${id}'::uuid`).join(',')}] AS users
      ),
      types_array AS (
        SELECT ARRAY['INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'COMPLIANCE', 'TASK']::work_item_type[] AS types
      ),
      priorities_array AS (
        SELECT ARRAY['LOW', 'MEDIUM', 'HIGH', 'URGENT']::work_item_priority[] AS priorities
      ),
      statuses_array AS (
        SELECT ARRAY['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED']::work_item_status[] AS statuses
      ),
      series AS (
        SELECT i FROM generate_series(1, 5200) AS i
      ),
      generated_items AS (
        SELECT
          i,
          CASE (i % 5)
            WHEN 0 THEN 'Production database high latency spike #' || i
            WHEN 1 THEN 'Payment settlement webhook failure for account #' || (10000 + i)
            WHEN 2 THEN 'Annual GDPR subject access verification #' || i
            WHEN 3 THEN 'Customer reported login error on checkout #' || i
            ELSE 'Rotate edge proxy TLS certificates and verify renewal #' || i
          END AS title,
          'Detailed description for operational work item #' || i || '. Investigate logs, metrics, and downstream dependencies under high load conditions.' AS description,
          (SELECT types[1 + (i % 5)] FROM types_array) AS item_type,
          -- Ensure ~15% are explicitly URGENT
          CASE 
            WHEN (i % 7 = 0) THEN 'URGENT'::work_item_priority
            WHEN (i % 4 = 0) THEN 'HIGH'::work_item_priority
            WHEN (i % 3 = 0) THEN 'MEDIUM'::work_item_priority
            ELSE 'LOW'::work_item_priority
          END AS item_priority,
          -- Status distribution
          CASE
            WHEN (i % 8 = 0) THEN 'AWAITING_APPROVAL'::work_item_status
            WHEN (i % 7 = 0 AND i % 2 = 0) THEN 'OPEN'::work_item_status -- unassigned urgent candidate
            WHEN (i % 4 = 0) THEN 'IN_PROGRESS'::work_item_status
            WHEN (i % 5 = 0) THEN 'RESOLVED'::work_item_status
            WHEN (i % 3 = 0) THEN 'CLOSED'::work_item_status
            ELSE 'OPEN'::work_item_status
          END AS item_status,
          (SELECT teams[1 + (i % 4)] FROM team_array) AS item_team_id,
          (SELECT users[1 + (i % 10)] FROM user_array) AS item_creator_id,
          NOW() - (i || ' minutes')::INTERVAL AS item_created_at,
          NOW() + ((i % 14) || ' days')::INTERVAL AS item_due_date
        FROM series
      )
      INSERT INTO work_items (
        title, 
        description, 
        type, 
        priority, 
        status, 
        team_id, 
        created_by_id, 
        assignee_id, 
        due_date, 
        version, 
        created_at, 
        updated_at
      )
      SELECT
        title,
        description,
        item_type,
        item_priority,
        item_status,
        item_team_id,
        item_creator_id,
        -- If status is OPEN, assignee is NULL. If IN_PROGRESS or AWAITING_APPROVAL, assign a team member.
        CASE 
          WHEN item_status = 'OPEN' THEN NULL
          ELSE (SELECT users[1 + ((i + 2) % 10)] FROM user_array)
        END AS assignee_id,
        item_due_date,
        1 AS version,
        item_created_at,
        item_created_at AS updated_at
      FROM generated_items
      RETURNING id, team_id, created_by_id, status, priority, assignee_id, created_at;
    `;

    const itemsResult = await client.query(seedItemsSql);
    console.log(`Successfully seeded ${itemsResult.rowCount} work items!`);

    // 5. Seed Activity Events & Initial Outbox Jobs for a sample of items
    console.log('Seeding activity events and outbox jobs for initial audit logs...');
    await client.query(`
      INSERT INTO activity_events (work_item_id, actor_id, event_type, from_state, to_state, created_at)
      SELECT 
        id, 
        created_by_id, 
        'CREATED', 
        NULL, 
        json_build_object('status', status, 'priority', priority, 'title', title),
        created_at
      FROM work_items
      LIMIT 1000;
    `);

    await client.query(`
      INSERT INTO outbox_jobs (event_type, aggregate_type, aggregate_id, payload, status, created_at)
      SELECT 
        'WORK_ITEM_CREATED',
        'WORK_ITEM',
        id,
        json_build_object('id', id, 'title', title, 'status', status, 'priority', priority),
        'PENDING',
        created_at
      FROM work_items
      WHERE status = 'OPEN' AND priority = 'URGENT'
      LIMIT 100;
    `);

    // Verification summary queries
    const countItems = await client.query('SELECT count(*) FROM work_items;');
    const unassignedUrgent = await client.query(`
      SELECT count(*) FROM work_items 
      WHERE priority = 'URGENT' AND assignee_id IS NULL AND status = 'OPEN';
    `);
    const awaitingApproval = await client.query(`
      SELECT count(*) FROM work_items 
      WHERE status = 'AWAITING_APPROVAL';
    `);

    console.log('\n================ SEED VERIFICATION SUMMARY ================');
    console.log(`Total Work Items:       ${countItems.rows[0].count}`);
    console.log(`Unassigned Urgent Items: ${unassignedUrgent.rows[0].count}`);
    console.log(`Awaiting Approval Items: ${awaitingApproval.rows[0].count}`);
    console.log('Login credentials for testing:');
    console.log(`  Lead User:  alice.${ROLL_NO}@pressuredesk.io  /  Password123!`);
    console.log(`  Member:     bob.${ROLL_NO}@pressuredesk.io    /  Password123!`);
    console.log(`  Viewer:     ivan.${ROLL_NO}@pressuredesk.io   /  Password123!`);
    console.log('===========================================================\n');

  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error('Seed script failed:', err);
  process.exit(1);
});
