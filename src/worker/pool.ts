import { Db } from 'mongodb';
import { Worker, WorkerOptions } from './worker.js';
import { ExternalVerificationProvider } from './provider.js';

export interface WorkerPoolOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  lockTimeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  provider?: ExternalVerificationProvider;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private db: Db;

  constructor(db: Db, options: WorkerPoolOptions = {}) {
    this.db = db;
    const concurrency = options.concurrency ?? 2;

    for (let i = 1; i <= concurrency; i++) {
      const workerOptions: WorkerOptions = {
        workerId: `worker-${i}`,
        pollIntervalMs: options.pollIntervalMs,
        lockTimeoutMs: options.lockTimeoutMs,
        maxAttempts: options.maxAttempts,
        backoffBaseMs: options.backoffBaseMs,
        provider: options.provider,
      };
      this.workers.push(new Worker(this.db, workerOptions));
    }
  }

  getWorker(index: number): Worker | undefined {
    return this.workers[index];
  }

  getWorkers(): Worker[] {
    return this.workers;
  }

  start(): void {
    for (const worker of this.workers) {
      worker.start();
    }
  }

  stop(): void {
    for (const worker of this.workers) {
      worker.stop();
    }
  }
}
