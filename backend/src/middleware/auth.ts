import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { AuthenticatedUser, TeamMembership } from '../types/domain.js';

interface JwtPayload {
  userId: string;
}

/**
 * Authentication Middleware:
 * 1. Validates the Bearer JWT token from the Authorization header.
 * 2. Loads the user and their memberships fresh from PostgreSQL on EVERY request.
 * 3. Injects req.user so downstream handlers and can() checks immediately reflect role changes.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authorization token required in Bearer format.'
      }
    });
    return;
  }

  const token = authHeader.split(' ')[1];

  let userId: string;
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    userId = decoded.userId;
  } catch (err) {
    res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired authorization token.'
      }
    });
    return;
  }

  try {
    // Fresh DB lookup: load user identity and current memberships
    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name,
              COALESCE(
                json_agg(
                  json_build_object(
                    'team_id', m.team_id,
                    'team_name', t.name,
                    'team_slug', t.slug,
                    'role', m.role
                  )
                ) FILTER (WHERE m.team_id IS NOT NULL),
                '[]'::json
              ) AS memberships
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN teams t ON t.id = m.team_id
       WHERE u.id = $1
       GROUP BY u.id, u.email, u.full_name;`,
      [userId]
    );

    if (result.rowCount === 0) {
      res.status(401).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User account not found.'
        }
      });
      return;
    }

    const row = result.rows[0];
    req.user = {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      memberships: (row.memberships as TeamMembership[]) || []
    };

    next();
  } catch (err) {
    next(err);
  }
}
