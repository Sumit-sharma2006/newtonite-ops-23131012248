import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { workItemsService } from './work-items.service.js';

export const workItemsRouter = Router();

// Enforce authentication on all work item routes
workItemsRouter.use(authenticate);

/**
 * GET /items
 * Query list of work items filtered by team, status, priority, view, and keyword search with keyset cursor pagination.
 */
workItemsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await workItemsService.getItems(req.user!, req.query as any);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /items
 * Create a new work item.
 * Requires Idempotency-Key header.
 */
workItemsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'] as string;
    const result = await workItemsService.createItem(req.user!, idempotencyKey, req.body);
    if (result.replayed) {
      res.setHeader('Idempotency-Replay', 'true');
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /items/team-members/:teamId
 * Retrieve list of members for a team.
 */
workItemsRouter.get('/team-members/:teamId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await workItemsService.getTeamMembers(req.user!, req.params.teamId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /items/:id
 * Retrieve a single work item. Returns 404 for non-team members.
 */
workItemsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await workItemsService.getItemById(req.user!, req.params.id);
    res.status(200).json({ item });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /items/:id/activity
 * Retrieve the append-only activity timeline for an item using keyset cursor pagination.
 */
workItemsRouter.get('/:id/activity', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cursor, limit } = req.query;
    const result = await workItemsService.getActivity(
      req.user!,
      req.params.id,
      cursor as string,
      limit as string
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /items/:id/comments
 * Post a comment. Viewers in team are permitted.
 */
workItemsRouter.post('/:id/comments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const comment = await workItemsService.addComment(req.user!, req.params.id, req.body.body);
    res.status(201).json({ comment });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /items/:id
 * Optimistic locking update of title, description, due_date, or priority (Lead/Admin only).
 */
workItemsRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await workItemsService.updateItem(req.user!, req.params.id, req.body);
    res.status(200).json({ item });
  } catch (err) {
    next(err);
  }
});

workItemsRouter.post('/:id/edit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await workItemsService.updateItem(req.user!, req.params.id, req.body);
    res.status(200).json({ item });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /items/:id/claim
 * Atomically claim an open, unassigned item for the current user.
 */
workItemsRouter.post('/:id/claim', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await workItemsService.claimItem(req.user!, req.params.id);
    res.status(200).json({ item });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /items/:id/transition
 * Transition item status validated against the locked state machine and four-eyes rule.
 */
workItemsRouter.post('/:id/transition', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await workItemsService.transitionItem(req.user!, req.params.id, req.body);
    res.status(200).json({ item });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /items/:id/assign
 * Assign, reassign, or unassign an item with team membership validation and optimistic locking.
 */
workItemsRouter.post('/:id/assign', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await workItemsService.assignItem(req.user!, req.params.id, req.body);
    res.status(200).json({ item });
  } catch (err) {
    next(err);
  }
});
