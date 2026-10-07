import { Db, Collection } from 'mongodb';
import { EventDocument } from '../domain/types';
import { getEventsCollection } from '../db/collections';
import { ExternalVerificationProvider } from './provider';
import { applyJobProjection, isEventStale } from './projection';
import { logger } from '../logger';

export interface WorkerOptions {
  workerId: string;
  pollIntervalMs?: number;
  lockTimeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  provider?: ExternalVerificationProvider;
  testHookCrashBeforeAck?: () => Promise<void> | void;
}

export class Worker {
  readonly workerId: string;
  private readonly db: Db;
  private readonly eventsCollection: Collection<EventDocument>;
  private readonly provider: ExternalVerificationProvider;
  private readonly pollIntervalMs: number;
  private readonly lockTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private isRunning = false;
  private pollTimeout?: NodeJS.Timeout;
  testHookCrashBeforeAck?: () => Promise<void> | void;

  constructor(db: Db, options: WorkerOptions) {
    this.db = db;
    this.workerId = options.workerId;
    this.eventsCollection = getEventsCollection(db);
    this.provider = options.provider ?? new ExternalVerificationProvider();
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.testHookCrashBeforeAck = options.testHookCrashBeforeAck;
  }

  /**
   * Reaps orphaned / abandoned in-progress locks whose leases have expired.
   * Resets them to 'pending' so surviving workers can recover them safely.
   */
  async reapAbandonedLocks(): Promise<number> {
    const expiredCutoff = new Date(Date.now() - this.lockTimeoutMs);
    const result = await this.eventsCollection.updateMany(
      {
        status: 'processing',
        lockedAt: { $lte: expiredCutoff },
      },
      {
        $set: {
          status: 'pending',
          updatedAt: new Date(),
        },
        $unset: {
          lockedAt: '',
          lockedBy: '',
        },
      }
    );
    return result.modifiedCount;
  }

  /**
   * Attempts to claim and process a single pending event.
   * Returns true if work was claimed and processed, false if no work was available.
   */
  async processNextItem(): Promise<boolean> {
    // 1. Recover any abandoned locks
    await this.reapAbandonedLocks();

    // 2. Atomically claim next available pending event
    const now = new Date();
    const claimed = await this.eventsCollection.findOneAndUpdate(
      {
        status: 'pending',
        nextRunAt: { $lte: now },
      },
      {
        $set: {
          status: 'processing',
          lockedAt: now,
          lockedBy: this.workerId,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );

    if (!claimed) {
      return false;
    }

    try {
      await this.handleEvent(claimed);
    } catch (err) {
      logger.error({ err, workerId: this.workerId, eventId: claimed.eventId }, 'Worker error processing event');
      // If error is not deliberate simulated crash, let lock timeout or rethrow
      throw err;
    }

    return true;
  }

  /**
   * Processes the claimed event: stale check, provider verification, and projection update.
   */
  private async handleEvent(event: EventDocument): Promise<void> {
    const now = new Date();

    // 1. Stale check: lower or equal versions skip verification and complete as a no-op
    const stale = await isEventStale(this.db, event);
    if (stale) {
      await this.eventsCollection.updateOne(
        { _id: event._id },
        {
          $set: {
            status: 'completed',
            updatedAt: now,
          },
          $unset: {
            lockedAt: '',
            lockedBy: '',
          },
        }
      );
      return;
    }

    // 2. Non-stale event: run external verification
    const currentAttempt = (event.attempts ?? 0) + 1;
    const verification = await this.provider.verify(event, currentAttempt);

    const attemptRecord = {
      attempt: currentAttempt,
      executedAt: now,
      responseCode: verification.status,
      error: verification.error,
    };

    // Case A: Verification successful (HTTP < 400)
    if (verification.status < 400) {
      // Apply projection update to jobs collection
      await applyJobProjection(this.db, event);

      // Crash-stop test hook simulation (if configured)
      if (this.testHookCrashBeforeAck) {
        await this.testHookCrashBeforeAck();
        return;
      }

      // Mark event as completed
      await this.eventsCollection.updateOne(
        { _id: event._id },
        {
          $set: {
            status: 'completed',
            attempts: currentAttempt,
            updatedAt: new Date(),
          },
          $push: {
            attemptHistory: attemptRecord,
          },
          $unset: {
            lockedAt: '',
            lockedBy: '',
            lastError: '',
          },
        }
      );
      return;
    }

    // Case B: Permanent failure (HTTP 422)
    if (verification.isPermanent || verification.status === 422) {
      await this.eventsCollection.updateOne(
        { _id: event._id },
        {
          $set: {
            status: 'failed',
            attempts: currentAttempt,
            lastError: verification.error ?? 'Permanent verification failure (422)',
            updatedAt: new Date(),
          },
          $push: {
            attemptHistory: attemptRecord,
          },
          $unset: {
            lockedAt: '',
            lockedBy: '',
          },
        }
      );
      return;
    }

    // Case C: Retryable failure (HTTP 429, 503, etc.)
    if (currentAttempt >= this.maxAttempts) {
      // Exhausted retries: mark as terminal failed
      await this.eventsCollection.updateOne(
        { _id: event._id },
        {
          $set: {
            status: 'failed',
            attempts: currentAttempt,
            lastError: `Exhausted maximum retry attempts (${this.maxAttempts}): ${verification.error}`,
            updatedAt: new Date(),
          },
          $push: {
            attemptHistory: attemptRecord,
          },
          $unset: {
            lockedAt: '',
            lockedBy: '',
          },
        }
      );
      return;
    }

    // Schedule next attempt with exponential backoff
    const backoffMs = this.backoffBaseMs * Math.pow(2, currentAttempt - 1);
    const nextRunAt = new Date(Date.now() + backoffMs);

    await this.eventsCollection.updateOne(
      { _id: event._id },
      {
        $set: {
          status: 'pending',
          attempts: currentAttempt,
          nextRunAt,
          lastError: verification.error,
          updatedAt: new Date(),
        },
        $push: {
          attemptHistory: attemptRecord,
        },
        $unset: {
          lockedAt: '',
          lockedBy: '',
        },
      }
    );
  }

  /**
   * Starts the continuous background polling loop.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const runLoop = async () => {
      if (!this.isRunning) return;

      try {
        const hadWork = await this.processNextItem();
        // If there was work, immediately try next item; otherwise wait for poll interval
        const delay = hadWork ? 10 : this.pollIntervalMs;
        if (this.isRunning) {
          this.pollTimeout = setTimeout(runLoop, delay);
        }
      } catch {
        if (this.isRunning) {
          this.pollTimeout = setTimeout(runLoop, this.pollIntervalMs);
        }
      }
    };

    void runLoop();
  }

  /**
   * Stops the background worker gracefully.
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = undefined;
    }
  }
}
