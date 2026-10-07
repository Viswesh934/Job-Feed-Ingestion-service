import { connectToDatabase, closeDatabase } from './db/client';
import { WorkerPool } from './worker/pool';
import { ExternalVerificationProvider } from './worker/provider';
import { config } from './config';
import { logger } from './logger';

async function main(): Promise<void> {
  try {
    logger.info({ mongoUri: config.mongoUri }, 'Worker process connecting to MongoDB...');
    const { db } = await connectToDatabase();
    logger.info('Worker process connected to MongoDB.');

    const provider = new ExternalVerificationProvider(config.providerPlanPath);
    const pool = new WorkerPool(db, {
      concurrency: config.workerConcurrency,
      pollIntervalMs: config.pollIntervalMs,
      lockTimeoutMs: config.lockTimeoutMs,
      maxAttempts: config.maxAttempts,
      backoffBaseMs: config.backoffBaseMs,
      provider,
    });

    logger.info({ concurrency: config.workerConcurrency }, 'Starting worker pool...');
    pool.start();

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Worker received signal. Stopping workers...');
      pool.stop();
      await closeDatabase();
      logger.info('Worker pool stopped and database closed.');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Fatal error in worker runner');
    process.exit(1);
  }
}

main();
