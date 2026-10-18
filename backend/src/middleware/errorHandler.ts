import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Global Express error handling middleware.
 * Enforces a single consistent error envelope:
 * { "error": { "code": string, "message": string, "details"?: any } }
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // 1. Domain AppErrors
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {})
      }
    });
    return;
  }

  // 2. PostgreSQL Connection Failures (Map to 503 Service Unavailable)
  const isPgConnectionError =
    typeof err === 'object' &&
    err !== null &&
    ('code' in err && ['ECONNREFUSED', '08006', '08001', '08004', '57P01', '57P02', '57P03'].includes((err as { code: string }).code) ||
     'message' in err && typeof (err as { message: string }).message === 'string' &&
     ((err as { message: string }).message.includes('Connection terminated') ||
      (err as { message: string }).message.includes('connect ECONNREFUSED') ||
      (err as { message: string }).message.includes('timeout exceeded when connecting')));

  if (isPgConnectionError) {
    res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database connection failed. Service temporarily unavailable.'
      }
    });
    return;
  }

  // 3. Fallback Internal Server Error
  console.error('[UNHANDLED ERROR]:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: err instanceof Error ? err.message : 'An unexpected error occurred.'
    }
  });
}
