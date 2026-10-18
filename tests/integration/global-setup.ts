import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

/**
 * Vitest Global Setup:
 * Ensures the dedicated `pressuredesk_test` database exists and runs all migrations.
 */
export default async function globalSetup() {
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '5432', 10);
  const user = process.env.DB_USER || 'pressuredesk';
  const password = process.env.DB_PASSWORD || 'pressuredesk123';
  const defaultDb = process.env.DB_NAME || 'pressuredesk';
  const testDbName = 'pressuredesk_test';

  // 1. Connect to default database to create pressuredesk_test if missing
  const adminPool = new Pool({
    host,
    port,
    user,
    password,
    database: defaultDb
  });

  try {
    const dbCheck = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1;`,
      [testDbName]
    );
    if ((dbCheck.rowCount ?? 0) === 0) {
      await adminPool.query(`CREATE DATABASE ${testDbName};`);
      console.log(`[TEST SETUP] Created database: ${testDbName}`);
    }
  } catch (err) {
    console.warn(`[TEST SETUP] Notice while checking/creating test database:`, err);
  } finally {
    await adminPool.end();
  }

  // 2. Connect to pressuredesk_test and apply migrations
  const testPool = new Pool({
    host,
    port,
    user,
    password,
    database: testDbName
  });

  try {
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await testPool.query(sql);
    }
    console.log(`[TEST SETUP] Applied ${files.length} migrations to ${testDbName}`);
  } catch (err) {
    console.warn(`[TEST SETUP] Error during test database migration:`, err);
  } finally {
    await testPool.end();
  }
}
