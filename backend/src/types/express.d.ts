import { AuthenticatedUser } from './domain.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
