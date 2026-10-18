import { Pool } from 'pg';
import dotenv from 'dotenv';
import { seed } from './seed.js';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 
  `postgres://${process.env.DB_USER || 'pressuredesk'}:${process.env.DB_PASSWORD || 'pressuredesk123'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'pressuredesk'}`;

const pool = new Pool({ connectionString });

async function seedIfEmpty() {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT count(*) FROM users;');
    const count = parseInt(res.rows[0].count, 10);
    if (count === 0) {
      console.log('[AUTO-SEED] Users table is empty. Executing initial database seed...');
      client.release();
      await pool.end();
      await seed(false);
    } else {
      console.log(`[AUTO-SEED] Database already contains ${count} users. Skipping seed.`);
    }
  } finally {
    try {
      client.release();
    } catch (_) {}
    try {
      await pool.end();
    } catch (_) {}
  }
}

seedIfEmpty().catch(err => {
  console.error('Auto-seed execution failed:', err);
  process.exit(1);
});
