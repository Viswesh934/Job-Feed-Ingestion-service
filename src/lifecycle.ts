import { Server } from 'node:http';
import { createApp } from './api/app';
import { connectToDatabase, closeDatabase } from './db/client';
import { WorkerPool } from './worker/pool';
import { ExternalVerificationProvider } from './worker/provider';
import { config } from './config';
import { logger } from './logger';

export interface RunningApplication {
  server: Server;
  workerPool?: WorkerPool;
}

let runningApp: RunningApplication | null = null;
let isShuttingDown = false;

/**
 * Initializes database connection, starts optional worker pool,
 * mounts HTTP server, and registers shutdown hooks.
 */
export async function startApplication(): Promise<RunningApplication> {
  logger.info({ mongoUri: config.mongoUri }, 'Connecting to MongoDB...');
  const { db } = await connectToDatabase();
  logger.info('Connected to MongoDB successfully.');

  const app = createApp();

  let workerPool: WorkerPool | undefined;
  if (config.workerEnabled) {
    const provider = new ExternalVerificationProvider(config.providerPlanPath);
    workerPool = new WorkerPool(db, {
      concurrency: config.workerConcurrency,
      pollIntervalMs: config.pollIntervalMs,
      lockTimeoutMs: config.lockTimeoutMs,
      maxAttempts: config.maxAttempts,
      backoffBaseMs: config.backoffBaseMs,
      provider,
    });
    logger.info({ concurrency: config.workerConcurrency }, 'Starting in-process background worker pool...');
    workerPool.start();
  }

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'Job Feed Ingestion Service is listening');
  });

  runningApp = { server, workerPool };

  registerProcessHooks();

  return runningApp;
}

/**
 * Gracefully terminates worker pool, HTTP server, and database connection.
 */
export async function stopApplication(signal = 'MANUAL'): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Graceful shutdown initiated');

  if (runningApp?.workerPool) {
    logger.info('Stopping background worker pool...');
    runningApp.workerPool.stop();
  }

  if (runningApp?.server) {
    await new Promise<void>((resolve) => {
      runningApp!.server.close(() => {
        logger.info('HTTP server closed');
        resolve();
      });
    });
  }

  await closeDatabase();
  logger.info('Database connection closed. Shutdown complete.');
  runningApp = null;
}

function registerProcessHooks(): void {
  const handleSignal = (signal: string) => {
    stopApplication(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err }, 'Error during graceful shutdown');
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => handleSignal('SIGTERM'));
  process.once('SIGINT', () => handleSignal('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled Promise Rejection detected');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught Exception detected');
    stopApplication('UNCAUGHT_EXCEPTION').finally(() => process.exit(1));
  });
}
