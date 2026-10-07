import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  mongoUri: string;
  dbName: string;
  workerEnabled: boolean;
  workerConcurrency: number;
  pollIntervalMs: number;
  lockTimeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  providerPlanPath: string;
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/job_feed_service?replicaSet=rs0&directConnection=true',
  dbName: process.env.DB_NAME || 'job_feed_service',
  workerEnabled: process.env.WORKER_ENABLED === 'true',
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '2', 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '500', 10),
  lockTimeoutMs: parseInt(process.env.LOCK_TIMEOUT_MS || '30000', 10),
  maxAttempts: parseInt(process.env.MAX_ATTEMPTS || '3', 10),
  backoffBaseMs: parseInt(process.env.BACKOFF_BASE_MS || '1000', 10),
  providerPlanPath: process.env.PROVIDER_PLAN_PATH || 'fixtures/provider-plan.json',
};
