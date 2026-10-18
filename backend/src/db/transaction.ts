import { PoolClient } from 'pg';
import { pool } from './pool.js';

/**
 * Executes a callback within a managed PostgreSQL transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK, ensuring
 * that the acquired PoolClient is always released back to the pool.
 */
export async function runInTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[TRANSACTION ROLLBACK FAILED]:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}
