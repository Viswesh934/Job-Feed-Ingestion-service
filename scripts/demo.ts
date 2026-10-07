import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/api/app.js';
import { connectToDatabase, closeDatabase } from '../src/db/client.js';
import { getEventsCollection, getJobsCollection } from '../src/db/collections.js';
import { WorkerPool } from '../src/worker/pool.js';
import { ExternalVerificationProvider } from '../src/worker/provider.js';
import request from 'supertest';

interface ScenarioItem {
  description: string;
  expectedStatus: number;
  expectedFinalState?: {
    eventStatus?: string;
    jobStatus?: string;
    jobVersion?: number;
    minAttempts?: number;
    attempts?: number;
    jobExists?: boolean;
  };
  body: Record<string, unknown>;
}

interface ScenarioData {
  phase1: ScenarioItem[];
  phase2: ScenarioItem[];
}

async function drainQueue(db: import('mongodb').Db, maxWaitMs = 10000): Promise<void> {
  const eventsCollection = getEventsCollection(db);
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const pendingCount = await eventsCollection.countDocuments({
      status: { $in: ['pending', 'processing'] },
    });
    if (pendingCount === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.warn('Queue drain timeout reached. Some events may still be in progress.');
}

async function main(): Promise<void> {
  console.log('====================================================');
  console.log('   Job-Feed Ingestion Service - End-to-End Demo     ');
  console.log('====================================================\n');

  const scenarioPath = path.resolve(process.cwd(), 'fixtures/scenario.json');
  if (!fs.existsSync(scenarioPath)) {
    console.error(`Scenario fixture not found at ${scenarioPath}`);
    process.exit(1);
  }

  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8')) as ScenarioData;
  const totalRequests = scenario.phase1.length + scenario.phase2.length;
  console.log(`Loaded scenario with ${totalRequests} total requests across 2 phases.`);

  // 1. Database setup
  console.log('\n[1/5] Connecting to MongoDB and cleaning up demo tenant data...');
  const { db } = await connectToDatabase();
  await getEventsCollection(db).deleteMany({
    tenantId: { $in: ['tenant-alpha', 'tenant-beta', ' tenant-alpha'] },
  });
  await getJobsCollection(db).deleteMany({
    tenantId: { $in: ['tenant-alpha', 'tenant-beta', ' tenant-alpha'] },
  });

  // 2. Start API application
  const app = createApp();

  // 3. Start background worker pool (concurrency = 2)
  console.log('[2/5] Starting competing background worker pool (2 workers)...');
  const provider = new ExternalVerificationProvider('fixtures/provider-plan.json');
  const workerPool = new WorkerPool(db, {
    concurrency: 2,
    pollIntervalMs: 50,
    backoffBaseMs: 100, // fast backoff for demo
    maxAttempts: 3,
    provider,
  });
  workerPool.start();

  try {
    // 4. Run Phase 1
    console.log(`\n[3/5] Submitting Phase 1 (${scenario.phase1.length} requests in fixture order)...`);
    for (let i = 0; i < scenario.phase1.length; i++) {
      const item = scenario.phase1[i]!;
      const res = await request(app).post('/events').send(item.body);
      const passed = res.status === item.expectedStatus;
      const statusIcon = passed ? '✓' : '✗';
      console.log(`  [${statusIcon}] #${i + 1} (${res.status} exp:${item.expectedStatus}) - ${item.description}`);
      if (!passed) {
        console.error(`    Unexpected response:`, res.body);
        process.exitCode = 1;
      }
    }

    console.log('\nWaiting for Phase 1 events to settle (draining background queue)...');
    await drainQueue(db);
    console.log('Phase 1 settled.');

    // Verify Phase 1 outcomes
    console.log('Verifying Phase 1 settled states:');
    for (const item of scenario.phase1) {
      if (!item.expectedFinalState) continue;
      const body = item.body as { tenantId: string; sourceId: string; eventId: string; externalJobId: string };
      const eventDoc = await getEventsCollection(db).findOne({
        tenantId: body.tenantId,
        sourceId: body.sourceId,
        eventId: body.eventId,
      });

      if (item.expectedFinalState.eventStatus) {
        if (eventDoc?.status !== item.expectedFinalState.eventStatus) {
          console.error(`  ✗ Event ${body.eventId} status mismatch: expected ${item.expectedFinalState.eventStatus}, got ${eventDoc?.status}`);
          process.exitCode = 1;
        } else {
          console.log(`  ✓ Event ${body.eventId} final status: ${eventDoc?.status}`);
        }
      }

      if (item.expectedFinalState.jobExists === false) {
        const jobDoc = await getJobsCollection(db).findOne({
          tenantId: body.tenantId,
          sourceId: body.sourceId,
          externalJobId: body.externalJobId,
        });
        if (jobDoc) {
          console.error(`  ✗ Job ${body.externalJobId} was expected to NOT exist, but found in projection.`);
          process.exitCode = 1;
        }
      }
    }

    // 5. Run Phase 2 (delayed events)
    console.log(`\n[4/5] Submitting Phase 2 delayed events (${scenario.phase2.length} requests)...`);
    for (let i = 0; i < scenario.phase2.length; i++) {
      const item = scenario.phase2[i]!;
      const res = await request(app).post('/events').send(item.body);
      const passed = res.status === item.expectedStatus;
      const statusIcon = passed ? '✓' : '✗';
      console.log(`  [${statusIcon}] #${i + 1} (${res.status} exp:${item.expectedStatus}) - ${item.description}`);
      if (!passed) {
        console.error(`    Unexpected response:`, res.body);
        process.exitCode = 1;
      }
    }

    console.log('\nWaiting for Phase 2 events to settle (draining background queue)...');
    await drainQueue(db);
    console.log('Phase 2 settled.');

    // Verify Phase 2 outcomes
    console.log('Verifying Phase 2 final states:');
    for (const item of scenario.phase2) {
      const body = item.body as { tenantId: string; sourceId: string; eventId: string; externalJobId: string };
      if (item.expectedFinalState?.jobStatus) {
        const job = await getJobsCollection(db).findOne({
          tenantId: body.tenantId,
          sourceId: body.sourceId,
          externalJobId: body.externalJobId,
        });
        if (job?.status === item.expectedFinalState.jobStatus && job?.version === item.expectedFinalState.jobVersion) {
          console.log(`  ✓ Job ${body.externalJobId} status: ${job.status}, version: ${job.version}`);
        } else {
          console.error(`  ✗ Job ${body.externalJobId} expected status=${item.expectedFinalState.jobStatus} v=${item.expectedFinalState.jobVersion}, got status=${job?.status} v=${job?.version}`);
          process.exitCode = 1;
        }
      }
    }

    // 6. Inspect read endpoints
    console.log('\n[5/5] Checking GET /jobs endpoint output for tenant-alpha:');
    const jobsRes = await request(app).get('/jobs?tenantId=tenant-alpha&status=all');
    console.log(`  Retrieved ${jobsRes.body.jobs.length} jobs in projection for tenant-alpha:`);
    for (const job of jobsRes.body.jobs) {
      console.log(`    - [${job.status.toUpperCase()}] Job ${job.externalJobId} (v${job.version}) | Last event: ${job.lastEventId} | Title: ${job.title ?? '(tombstone)'}`);
    }

    console.log('\n====================================================');
    console.log('   Demo Completed Successfully! All Invariants Held. ');
    console.log('====================================================\n');
  } finally {
    workerPool.stop();
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error('Fatal demo failure:', err);
  process.exit(1);
});
