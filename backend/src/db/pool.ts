import { Pool } from 'pg';
import { env } from '../config/env.js';

// Create a single shared connection pool for the backend service
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
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
