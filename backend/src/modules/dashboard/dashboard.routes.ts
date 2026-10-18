import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { workItemsService } from '../work-items/work-items.service.js';

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

/**
 * GET /dashboard/summary
 * Returns counts for the 3 core operational queues:
 * - assigned_to_me
 * - unassigned_urgent
 * - awaiting_my_approval
 */
dashboardRouter.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await workItemsService.getDashboardSummary(
      req.user!,
      req.query.team_id as string
    );
    res.status(200).json(summary);
  } catch (err) {
    next(err);
  }
});
