import { describe, it, expect } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { errorHandler, AppError } from '../../backend/src/middleware/errorHandler.js';

describe('Error Handler Middleware', () => {
  const app = express();
  app.use(express.json());

  // Test routes throwing various errors
  app.get('/test/domain-error', () => {
    throw new AppError(403, 'INSUFFICIENT_TEAM_ROLE', 'This action requires Lead or Admin role.', { required: 'LEAD' });
  });

  app.get('/test/pg-connection-error', () => {
    const pgErr = new Error('Connection terminated unexpectedly');
    (pgErr as any).code = 'ECONNREFUSED';
    throw pgErr;
  });

  app.get('/test/generic-error', () => {
    throw new Error('Something broke');
  });

  app.use(errorHandler);

  it('formats AppError into the standard error envelope', async () => {
    const res = await request(app).get('/test/domain-error');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: 'INSUFFICIENT_TEAM_ROLE',
        message: 'This action requires Lead or Admin role.',
        details: { required: 'LEAD' }
      }
    });
  });

  it('maps PostgreSQL connection errors to 503 DATABASE_UNAVAILABLE', async () => {
    const res = await request(app).get('/test/pg-connection-error');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database connection failed. Service temporarily unavailable.'
      }
    });
  });

  it('maps unhandled generic errors to 500 INTERNAL_SERVER_ERROR', async () => {
    const res = await request(app).get('/test/generic-error');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something broke'
      }
    });
  });
});
