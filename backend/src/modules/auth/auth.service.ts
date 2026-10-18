import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { AppError } from '../../middleware/errorHandler.js';
import { TeamMembership } from '../../types/domain.js';

export interface LoginResult {
  token: string;
  user: {
    id: string;
    email: string;
    full_name: string;
    memberships: TeamMembership[];
  };
}

/**
 * Validates user credentials, generates a signed JWT containing ONLY userId,
 * and retrieves current memberships for the client application.
 */
export async function loginUser(email: string, password: string): Promise<LoginResult> {
  if (!email || !password) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Email and password are required.');
  }

  // 1. Fetch user by email including associated team memberships
  const result = await pool.query(
    `SELECT u.id, u.email, u.password_hash, u.full_name,
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
     WHERE LOWER(u.email) = LOWER($1)
     GROUP BY u.id, u.email, u.password_hash, u.full_name;`,
    [email.trim()]
  );

  // 2. Consistent error for non-existent email
  if (result.rowCount === 0) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  const user = result.rows[0];

  // 3. Constant-time bcrypt password comparison
  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  // 4. Generate signed JWT containing ONLY user id and expiry (no roles/memberships in token)
  const token = jwt.sign(
    { userId: user.id },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      memberships: (user.memberships as TeamMembership[]) || []
    }
  };
}
