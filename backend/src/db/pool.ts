import { Pool } from 'pg';
import { env } from '../config/env.js';

const connectionString =
  process.env.NODE_ENV === 'test' || process.env.VITEST
    ? env.TEST_DATABASE_URL
    : env.DATABASE_URL;

// Create a single shared connection pool for the backend service
export const pool = new Pool({
  connectionString,
  max: 20, // default maximum pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// Global pool error handler to prevent crashing process on idle client errors
pool.on('error', (err) => {
  console.error('[DB POOL ERROR] Unexpected error on idle client:', err);
});

// Helper for executing single parameterized queries
export const query = (text: string, params?: unknown[]) => pool.query(text, params);
