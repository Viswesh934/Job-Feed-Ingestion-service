import express, { Express } from 'express';
import { eventsRouter } from './routes/events';
import { jobsRouter } from './routes/jobs';
import { healthRouter } from './routes/health';
import { errorHandler } from './middlewares/errorHandler';

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
