import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from 'mongodb';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { getEventsCollection, getJobsCollection } from '../../src/db/collections';
import { Worker } from '../../src/worker/worker';
import { WorkerPool } from '../../src/worker/pool';
import { ExternalVerificationProvider } from '../../src/worker/provider';
import { EventDocument } from '../../src/domain/types';

describe('Phase 2: Worker and Projection Integration Tests', () => {
  let db: Db;

  beforeAll(async () => {
    const conn = await setupTestDb();
    db = conn.db;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  function createTestEvent(overrides: Partial<EventDocument>): EventDocument {
    const now = new Date();
    return {
      tenantId: 'tenant-test',
      sourceId: 'main',
      eventId: `ev-${Math.random().toString(36).substring(7)}`,
      externalJobId: 'job-1',
      version: 1,
      operation: 'upsert',
      payload: {
        title: 'Software Engineer',
        company: 'Tech Corp',
        location: 'Bangalore',
        experienceMin: 2,
        experienceMax: 5,
        applyUrl: 'https://techcorp.test/jobs/1',
        skills: ['typescript', 'mongodb'],
      },
      rawCanonical: '{}',
      canonicalHash: 'dummy-hash',
      status: 'pending',
      attempts: 0,
      attemptHistory: [],
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  describe('Projection Updates and Monotonic Versioning', () => {
    it('applies an upsert event to create a new job projection', async () => {
      const event = createTestEvent({ version: 1 });
      await getEventsCollection(db).insertOne(event);

      const worker = new Worker(db, {
        workerId: 'worker-test',
        provider: new ExternalVerificationProvider({ defaultStatus: 200 }),
      });

      const processed = await worker.processNextItem();
      expect(processed).toBe(true);

      const updatedEvent = await getEventsCollection(db).findOne({ _id: event._id });
      expect(updatedEvent?.status).toBe('completed');
      expect(updatedEvent?.attempts).toBe(1);

      const job = await getJobsCollection(db).findOne({
        tenantId: event.tenantId,
        sourceId: event.sourceId,
        externalJobId: event.externalJobId,
      });

      expect(job).not.toBeNull();
      expect(job?.version).toBe(1);
      expect(job?.status).toBe('active');
      expect(job?.title).toBe('Software Engineer');
      expect(job?.skills).toEqual(['typescript', 'mongodb']);
    });

    it('enforces greatest version rule: out-of-order version delivery', async () => {
      // 1. Process version 2 first
      const eventV2 = createTestEvent({
        eventId: 'ev-v2',
        version: 2,
        payload: {
          title: 'Senior Engineer V2',
          company: 'Tech Corp',
          location: 'Bangalore',
          experienceMin: 4,
          experienceMax: 7,
          applyUrl: 'https://techcorp.test/jobs/1',
          skills: ['typescript', 'mongodb', 'system-design'],
        },
      });
      await getEventsCollection(db).insertOne(eventV2);

      const worker = new Worker(db, {
        workerId: 'worker-test',
        provider: new ExternalVerificationProvider({ defaultStatus: 200 }),
      });

      await worker.processNextItem();

      let job = await getJobsCollection(db).findOne({ externalJobId: 'job-1' });
      expect(job?.version).toBe(2);
      expect(job?.title).toBe('Senior Engineer V2');

      // 2. Submit older version 1 later
      const eventV1 = createTestEvent({
        eventId: 'ev-v1',
        version: 1,
        payload: {
          title: 'Junior Engineer V1',
          company: 'Tech Corp',
          location: 'Bangalore',
          experienceMin: 1,
          experienceMax: 2,
          applyUrl: 'https://techcorp.test/jobs/1',
          skills: ['typescript'],
        },
      });
      await getEventsCollection(db).insertOne(eventV1);

      await worker.processNextItem();

      // Older event should be completed as no-op and NOT overwrite version 2
      const updatedV1 = await getEventsCollection(db).findOne({ eventId: 'ev-v1' });
      expect(updatedV1?.status).toBe('completed');

      job = await getJobsCollection(db).findOne({ externalJobId: 'job-1' });
      expect(job?.version).toBe(2);
      expect(job?.title).toBe('Senior Engineer V2');
    });

    it('preserves versioned tombstone when archive arrives before any upsert', async () => {
      // Archive arrives first as version 1
      const archiveEvent = createTestEvent({
        eventId: 'ev-arch-1',
        version: 1,
        operation: 'archive',
        payload: undefined,
      });
      await getEventsCollection(db).insertOne(archiveEvent);

      const worker = new Worker(db, {
        workerId: 'worker-test',
        provider: new ExternalVerificationProvider({ defaultStatus: 200 }),
      });

      await worker.processNextItem();

      let job = await getJobsCollection(db).findOne({ externalJobId: 'job-1' });
      expect(job?.status).toBe('archived');
      expect(job?.version).toBe(1);

      // Now a delayed upsert with version 1 arrives
      const upsertV1 = createTestEvent({
        eventId: 'ev-upsert-1',
        version: 1,
        operation: 'upsert',
      });
      await getEventsCollection(db).insertOne(upsertV1);

      await worker.processNextItem();

      // Tombstone is preserved: status must remain archived, version 1
      job = await getJobsCollection(db).findOne({ externalJobId: 'job-1' });
      expect(job?.status).toBe('archived');
      expect(job?.version).toBe(1);

      // Later higher upsert (version 2) reactivates the job
      const upsertV2 = createTestEvent({
        eventId: 'ev-upsert-2',
        version: 2,
        operation: 'upsert',
        payload: {
          title: 'Reactivated Role',
          company: 'Tech Corp',
          location: 'Bangalore',
          experienceMin: 3,
          experienceMax: 6,
          applyUrl: 'https://techcorp.test/jobs/1',
          skills: ['typescript'],
        },
      });
      await getEventsCollection(db).insertOne(upsertV2);

      await worker.processNextItem();

      job = await getJobsCollection(db).findOne({ externalJobId: 'job-1' });
      expect(job?.status).toBe('active');
      expect(job?.version).toBe(2);
      expect(job?.title).toBe('Reactivated Role');
    });
  });

  describe('External Provider Failures and Retries', () => {
    it('retries on HTTP 429 with backoff and succeeds on subsequent attempt', async () => {
      const event = createTestEvent({ eventId: 'ev-429-test' });
      await getEventsCollection(db).insertOne(event);

      const mockProvider = new ExternalVerificationProvider({
        rules: [
          {
            eventId: 'ev-429-test',
            responses: [429, 200],
          },
        ],
      });

      const worker = new Worker(db, {
        workerId: 'worker-test',
        provider: mockProvider,
        backoffBaseMs: 50, // Short backoff for test speed
        maxAttempts: 3,
      });

      // Attempt 1: returns 429
      const processed1 = await worker.processNextItem();
      expect(processed1).toBe(true);

      let doc = await getEventsCollection(db).findOne({ eventId: 'ev-429-test' });
      expect(doc?.status).toBe('pending');
      expect(doc?.attempts).toBe(1);
      expect(doc?.attemptHistory).toHaveLength(1);
      expect(doc?.attemptHistory[0]?.responseCode).toBe(429);
      expect(doc?.nextRunAt.getTime()).toBeGreaterThan(Date.now());

      // Fast-forward nextRunAt to simulate backoff elapse
      await getEventsCollection(db).updateOne(
        { eventId: 'ev-429-test' },
        { $set: { nextRunAt: new Date(Date.now() - 1000) } }
      );

      // Attempt 2: returns 200
      const processed2 = await worker.processNextItem();
      expect(processed2).toBe(true);

      doc = await getEventsCollection(db).findOne({ eventId: 'ev-429-test' });
      expect(doc?.status).toBe('completed');
      expect(doc?.attempts).toBe(2);
      expect(doc?.attemptHistory).toHaveLength(2);
      expect(doc?.attemptHistory[1]?.responseCode).toBe(200);

      const job = await getJobsCollection(db).findOne({ externalJobId: 'job-1' });
      expect(job).not.toBeNull();
      expect(job?.version).toBe(1);
    });

    it('treats HTTP 422 as permanent failure without touching projection', async () => {
      const event = createTestEvent({ eventId: 'ev-422-test' });
      await getEventsCollection(db).insertOne(event);

      const mockProvider = new ExternalVerificationProvider({
        rules: [
          {
            eventId: 'ev-422-test',
            responses: [422],
          },
        ],
      });

      const worker = new Worker(db, {
        workerId: 'worker-test',
        provider: mockProvider,
      });

      await worker.processNextItem();

      const doc = await getEventsCollection(db).findOne({ eventId: 'ev-422-test' });
      expect(doc?.status).toBe('failed');
      expect(doc?.attempts).toBe(1);
      expect(doc?.lastError).toContain('422');

      // Job projection must NOT be created
      const job = await getJobsCollection(db).findOne({ externalJobId: 'job-1' });
      expect(job).toBeNull();
    });

    it('exhausts retries after 3 attempts on HTTP 503 and marks event failed', async () => {
      const event = createTestEvent({ eventId: 'ev-503-test' });
      await getEventsCollection(db).insertOne(event);

      const mockProvider = new ExternalVerificationProvider({
        rules: [
          {
            eventId: 'ev-503-test',
            responses: [503, 503, 503],
          },
        ],
      });

      const worker = new Worker(db, {
        workerId: 'worker-test',
        provider: mockProvider,
        backoffBaseMs: 20,
        maxAttempts: 3,
      });

      // Attempt 1
      await worker.processNextItem();
      let doc = await getEventsCollection(db).findOne({ eventId: 'ev-503-test' });
      expect(doc?.status).toBe('pending');
      expect(doc?.attempts).toBe(1);

      // Attempt 2
      await getEventsCollection(db).updateOne(
        { eventId: 'ev-503-test' },
        { $set: { nextRunAt: new Date(Date.now() - 1000) } }
      );
      await worker.processNextItem();
      doc = await getEventsCollection(db).findOne({ eventId: 'ev-503-test' });
      expect(doc?.status).toBe('pending');
      expect(doc?.attempts).toBe(2);

      // Attempt 3 (final attempt allowed)
      await getEventsCollection(db).updateOne(
        { eventId: 'ev-503-test' },
        { $set: { nextRunAt: new Date(Date.now() - 1000) } }
      );
      await worker.processNextItem();
      doc = await getEventsCollection(db).findOne({ eventId: 'ev-503-test' });
      expect(doc?.status).toBe('failed');
      expect(doc?.attempts).toBe(3);
      expect(doc?.lastError).toContain('Exhausted maximum retry attempts');

      // Job projection must NOT be created
      const job = await getJobsCollection(db).findOne({ externalJobId: 'job-1' });
      expect(job).toBeNull();
    });
  });

  describe('Concurrent Workers and Crash Recovery', () => {
    it('allows multiple competing workers to process a batch of events without conflict', async () => {
      // Insert 10 events
      const events: EventDocument[] = [];
      for (let i = 1; i <= 10; i++) {
        events.push(createTestEvent({
          eventId: `batch-ev-${i}`,
          externalJobId: `batch-job-${i}`,
          version: 1,
        }));
      }
      await getEventsCollection(db).insertMany(events);

      const pool = new WorkerPool(db, {
        concurrency: 3,
        pollIntervalMs: 50,
        provider: new ExternalVerificationProvider({ defaultStatus: 200 }),
      });

      pool.start();

      // Wait until all 10 events are completed
      const startTime = Date.now();
      while (Date.now() - startTime < 5000) {
        const completedCount = await getEventsCollection(db).countDocuments({ status: 'completed' });
        if (completedCount === 10) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      pool.stop();

      const finalCompleted = await getEventsCollection(db).countDocuments({ status: 'completed' });
      expect(finalCompleted).toBe(10);

      const jobCount = await getJobsCollection(db).countDocuments({
        tenantId: 'tenant-test',
        sourceId: 'main',
      });
      expect(jobCount).toBe(10);
    });

    it('recovers from deliberate crash after projection update before acknowledgment', async () => {
      const event = createTestEvent({
        eventId: 'crash-event-1',
        externalJobId: 'job-crash',
        version: 1,
      });
      await getEventsCollection(db).insertOne(event);

      // Worker 1 simulates a crash right after applying the projection
      let simulatedCrashHappened = false;
      const crashingWorker = new Worker(db, {
        workerId: 'worker-crasher',
        lockTimeoutMs: 50, // Short lock timeout for test
        provider: new ExternalVerificationProvider({ defaultStatus: 200 }),
        testHookCrashBeforeAck: () => {
          simulatedCrashHappened = true;
          // Simulates immediate process exit / unhandled crash: leaves event in 'processing' status
          throw new Error('Simulated worker process crash');
        },
      });

      // Crashing worker attempts processNextItem and crashes
      try {
        await crashingWorker.processNextItem();
      } catch {
        // Expected crash
      }

      expect(simulatedCrashHappened).toBe(true);

      // Verify the state after crash:
      // 1. The job projection was written to MongoDB
      const jobAfterCrash = await getJobsCollection(db).findOne({ externalJobId: 'job-crash' });
      expect(jobAfterCrash).not.toBeNull();
      expect(jobAfterCrash?.version).toBe(1);

      // 2. The event was NOT acknowledged (still status: 'processing', lockedBy: 'worker-crasher')
      const eventAfterCrash = await getEventsCollection(db).findOne({ eventId: 'crash-event-1' });
      expect(eventAfterCrash?.status).toBe('processing');
      expect(eventAfterCrash?.lockedBy).toBe('worker-crasher');

      // Wait for the lock lease to expire (lockTimeoutMs = 50ms)
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Worker 2 (surviving worker) wakes up and processes work
      const survivingWorker = new Worker(db, {
        workerId: 'worker-survivor',
        lockTimeoutMs: 50,
        provider: new ExternalVerificationProvider({ defaultStatus: 200 }),
      });

      const recovered = await survivingWorker.processNextItem();
      expect(recovered).toBe(true);

      // Final state verification:
      // Event must be marked completed (stale no-op detection prevents duplicate side-effects)
      const finalEvent = await getEventsCollection(db).findOne({ eventId: 'crash-event-1' });
      expect(finalEvent?.status).toBe('completed');

      // Exactly ONE job document exists with correct version 1
      const allJobs = await getJobsCollection(db).find({ externalJobId: 'job-crash' }).toArray();
      expect(allJobs).toHaveLength(1);
      expect(allJobs[0]?.version).toBe(1);
    });
  });
});
