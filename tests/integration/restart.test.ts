import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { closeDatabase } from '../../src/db/client';
import { getEventsCollection } from '../../src/db/collections';
import { WorkerPool } from '../../src/worker/pool';
import { ExternalVerificationProvider } from '../../src/worker/provider';
import { Db } from 'mongodb';

describe('Phase 3: Persistence Across API/Worker Restart Tests', () => {
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

  it('persists accepted events and projection states across complete service and worker restarts', async () => {
    const tenantId = 'tenant-restart-test';
    const sourceId = 'main';

    // 1. Initial State: API server is running, but background worker is completely OFF.
    const app1 = createApp();

    const event1 = {
      tenantId,
      sourceId,
      eventId: 'ev-restart-1',
      externalJobId: 'job-restart-1',
      version: 1,
      operation: 'upsert',
      payload: {
        title: 'Restart Engineer 1',
        company: 'Resilient Inc',
        location: 'Remote',
        experienceMin: 2,
        experienceMax: 4,
        applyUrl: 'https://resilient.test/jobs/1',
        skills: ['TypeScript'],
      },
    };

    const event2 = {
      tenantId,
      sourceId,
      eventId: 'ev-restart-2',
      externalJobId: 'job-restart-2',
      version: 1,
      operation: 'upsert',
      payload: {
        title: 'Restart Engineer 2',
        company: 'Resilient Inc',
        location: 'Remote',
        experienceMin: 3,
        experienceMax: 6,
        applyUrl: 'https://resilient.test/jobs/2',
        skills: ['MongoDB'],
      },
    };

    // Client posts events - accepted with 202
    const res1 = await request(app1).post('/events').send(event1);
    const res2 = await request(app1).post('/events').send(event2);
    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);

    // Verify events are in 'pending' status in MongoDB
    const eventsColl = getEventsCollection(db);
    const pendingBefore = await eventsColl.countDocuments({ tenantId, status: 'pending' });
    expect(pendingBefore).toBe(2);

    // 2. SIMULATE COMPLETE SERVICE RESTART / CRASH
    // Close connections and discard in-memory references
    await closeDatabase();

    // 3. RESTART: Reconnect database and initialize brand new API and WorkerPool instances
    const conn2 = await setupTestDb();
    const restartedDb = conn2.db;
    const app2 = createApp();

    const provider = new ExternalVerificationProvider({ defaultStatus: 200 });
    const restartedWorkerPool = new WorkerPool(restartedDb, {
      concurrency: 2,
      pollIntervalMs: 20,
      provider,
    });

    // Start background processing on restarted worker pool
    restartedWorkerPool.start();

    // Wait until background queue drains
    const restartedEventsColl = getEventsCollection(restartedDb);
    const startTime = Date.now();
    while (Date.now() - startTime < 5000) {
      const pendingCount = await restartedEventsColl.countDocuments({
        tenantId,
        status: { $in: ['pending', 'processing'] },
      });
      if (pendingCount === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    restartedWorkerPool.stop();

    // 4. Verify post-restart outcomes
    const completedAfter = await restartedEventsColl.countDocuments({ tenantId, status: 'completed' });
    expect(completedAfter).toBe(2);

    // Query restarted API GET /jobs
    const jobsRes = await request(app2).get(`/jobs?tenantId=${tenantId}&status=all`);
    expect(jobsRes.status).toBe(200);
    expect(jobsRes.body.jobs).toHaveLength(2);

    const jobIds = jobsRes.body.jobs.map((j: { externalJobId: string }) => j.externalJobId).sort();
    expect(jobIds).toEqual(['job-restart-1', 'job-restart-2']);
  });
});
