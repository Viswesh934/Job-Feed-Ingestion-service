import express, { Express } from 'express';
import { eventsRouter } from './routes/events.js';
import { jobsRouter } from './routes/jobs.js';
import { healthRouter } from './routes/health.js';
import { errorHandler } from './middlewares/errorHandler.js';

export function createApp(): Express {
  const app = express();

  // Parse JSON payloads with strict limit
  app.use(express.json({ limit: '1mb' }));

  // Routes
  app.use('/health', healthRouter);
  app.use('/events', eventsRouter);
  app.use('/jobs', jobsRouter);

  // Central error handling
  app.use(errorHandler);

  return app;
}
