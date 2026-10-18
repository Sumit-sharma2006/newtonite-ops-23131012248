import { Router, Request, Response, NextFunction } from 'express';
import { loginUser } from './auth.service.js';
import { authenticate } from '../../middleware/auth.js';

export const authRouter = Router();

/**
 * POST /auth/login
 * Public endpoint to authenticate seeded users.
 * Returns JWT token + user profile with current memberships.
 */
authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    const result = await loginUser(email, password);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/me
 * Protected endpoint returning current authenticated user identity and active team memberships.
 */
authRouter.get('/me', authenticate, (req: Request, res: Response) => {
  res.status(200).json({ user: req.user });
});
