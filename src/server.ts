import { createApp } from './api/app.js';
import { connectToDatabase, closeDatabase } from './db/client.js';
import { config } from './config.js';

async function main(): Promise<void> {
  try {
    console.log(`Connecting to MongoDB at ${config.mongoUri}...`);
    const { db } = await connectToDatabase();
    console.log('Connected to MongoDB.');

    const app = createApp();

    let workerPool: import('./worker/pool.js').WorkerPool | undefined;
    if (config.workerEnabled) {
      const { WorkerPool } = await import('./worker/pool.js');
      const { ExternalVerificationProvider } = await import('./worker/provider.js');
      const provider = new ExternalVerificationProvider(config.providerPlanPath);
      workerPool = new WorkerPool(db, {
        concurrency: config.workerConcurrency,
        pollIntervalMs: config.pollIntervalMs,
        lockTimeoutMs: config.lockTimeoutMs,
        maxAttempts: config.maxAttempts,
        backoffBaseMs: config.backoffBaseMs,
        provider,
      });
      console.log(`Starting in-process worker pool (concurrency: ${config.workerConcurrency})...`);
      workerPool.start();
    }

    const server = app.listen(config.port, () => {
      console.log(`Job Feed Ingestion Service listening on port ${config.port} (env: ${config.nodeEnv})`);
    });

    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}. Shutting down gracefully...`);
      if (workerPool) {
        workerPool.stop();
      }
      server.close(async () => {
        await closeDatabase();
        console.log('Server and database connections closed.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('Fatal error during startup:', err);
    process.exit(1);
  }
}

// Only start when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
