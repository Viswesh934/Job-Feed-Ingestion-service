import { createApp } from './api/app.js';
import { connectToDatabase, closeDatabase } from './db/client.js';
import { config } from './config.js';

async function main(): Promise<void> {
  try {
    console.log(`Connecting to MongoDB at ${config.mongoUri}...`);
    await connectToDatabase();
    console.log('Connected to MongoDB.');

    const app = createApp();

    const server = app.listen(config.port, () => {
      console.log(`Job Feed Ingestion Service listening on port ${config.port} (env: ${config.nodeEnv})`);
    });

    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}. Shutting down gracefully...`);
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
