import { connectToDatabase, closeDatabase } from './db/client.js';
import { WorkerPool } from './worker/pool.js';
import { ExternalVerificationProvider } from './worker/provider.js';
import { config } from './config.js';

async function main(): Promise<void> {
  try {
    console.log(`Worker process connecting to MongoDB at ${config.mongoUri}...`);
    const { db } = await connectToDatabase();
    console.log('Worker process connected to MongoDB.');

    const provider = new ExternalVerificationProvider(config.providerPlanPath);
    const pool = new WorkerPool(db, {
      concurrency: config.workerConcurrency,
      pollIntervalMs: config.pollIntervalMs,
      lockTimeoutMs: config.lockTimeoutMs,
      maxAttempts: config.maxAttempts,
      backoffBaseMs: config.backoffBaseMs,
      provider,
    });

    console.log(`Starting worker pool with concurrency=${config.workerConcurrency}...`);
    pool.start();

    const shutdown = async (signal: string) => {
      console.log(`Worker received ${signal}. Stopping workers...`);
      pool.stop();
      await closeDatabase();
      console.log('Worker pool stopped and database closed.');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('Fatal error in worker runner:', err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
