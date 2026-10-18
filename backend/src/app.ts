import express from 'express';
import cors from 'cors';
import { authRouter } from './modules/auth/auth.routes.js';
import { workItemsRouter } from './modules/work-items/work-items.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'pressuredesk-api' });
  });

  // Mount API modules
  app.use('/auth', authRouter);
  app.use('/items', workItemsRouter);
  app.use('/dashboard', dashboardRouter);

  // Global Central Error Handler
  app.use(errorHandler);

  return app;
}

export const app = createApp();
