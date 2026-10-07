import { Router, Request, Response } from 'express';
import { getDb } from '../../db/client';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });

    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      dependencies: {
        mongodb: 'connected',
      },
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      dependencies: {
        mongodb: 'disconnected',
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
});
