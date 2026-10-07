import os from 'node:os';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { connectToDatabase, closeDatabase } from '../src/db/client.js';
import { getEventsCollection, getJobsCollection } from '../src/db/collections.js';
import { WorkerPool } from '../src/worker/pool.js';
import { ExternalVerificationProvider } from '../src/worker/provider.js';

interface RequestTask {
  body: Record<string, unknown>;
  isReplay: boolean;
  jobKey: string;
  version: number;
}

function calculatePercentiles(latencies: number[]): { p50: number; p95: number; p99: number; min: number; max: number; avg: number } {
  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.50)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { p50, p95, p99, min, max, avg };
}

async function main(): Promise<void> {
  console.log('========================================================');
  console.log('       Job-Feed Ingestion Service - Load Test           ');
  console.log('========================================================\n');

  const tenantId = 'tenant-load-test';
  const sourceId = 'main';

  // 1. Environment Info
  console.log('System Configuration:');
  console.log(`  OS: ${os.type()} ${os.release()} (${os.arch()})`);
  console.log(`  CPUs: ${os.cpus().length} cores (${os.cpus()[0]?.model})`);
  console.log(`  Total Memory: ${(os.totalmem() / (1024 ** 3)).toFixed(2)} GB`);
  console.log(`  Node.js: ${process.version}`);

  // 2. Database Connection & Cleanup
  const { db } = await connectToDatabase();
  const eventsCollection = getEventsCollection(db);
  const jobsCollection = getJobsCollection(db);

  console.log('\nCleaning previous load-test data...');
  await eventsCollection.deleteMany({ tenantId });
  await jobsCollection.deleteMany({ tenantId });

  // 3. Prepare Workload:
  // - 1,000 distinct valid events
  // - 200 exact replay requests
  // - At least 50 jobs submitted with out-of-order versions (version 2 first, then version 1)
  console.log('\nGenerating workload...');
  const tasks: RequestTask[] = [];

  // 50 out-of-order jobs (100 events total: 50 v2 followed by 50 v1)
  for (let i = 1; i <= 50; i++) {
    const jobId = `ooo-job-${i}`;
    // Version 2 first
    tasks.push({
      jobKey: jobId,
      version: 2,
      isReplay: false,
      body: {
        tenantId,
        sourceId,
        eventId: `ev-ooo-${i}-v2`,
        externalJobId: jobId,
        version: 2,
        operation: 'upsert',
        payload: {
          title: `Senior Engineer ${i} (v2)`,
          company: 'Load Corp',
          location: 'Bengaluru',
          experienceMin: 4,
          experienceMax: 8,
          applyUrl: `https://load.test/jobs/${jobId}`,
          skills: ['typescript', 'mongodb', 'docker'],
        },
      },
    });

    // Version 1 second (older, should be no-op against v2)
    tasks.push({
      jobKey: jobId,
      version: 1,
      isReplay: false,
      body: {
        tenantId,
        sourceId,
        eventId: `ev-ooo-${i}-v1`,
        externalJobId: jobId,
        version: 1,
        operation: 'upsert',
        payload: {
          title: `Junior Engineer ${i} (v1)`,
          company: 'Load Corp',
          location: 'Bengaluru',
          experienceMin: 1,
          experienceMax: 3,
          applyUrl: `https://load.test/jobs/${jobId}`,
          skills: ['typescript'],
        },
      },
    });
  }

  // 900 standard distinct events to reach 1,000 distinct valid events
  for (let i = 1; i <= 900; i++) {
    const jobId = `std-job-${i}`;
    tasks.push({
      jobKey: jobId,
      version: 1,
      isReplay: false,
      body: {
        tenantId,
        sourceId,
        eventId: `ev-std-${i}`,
        externalJobId: jobId,
        version: 1,
        operation: 'upsert',
        payload: {
          title: `Standard Engineer ${i}`,
          company: 'Load Corp',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          applyUrl: `https://load.test/jobs/${jobId}`,
          skills: ['typescript', 'mongodb'],
        },
      },
    });
  }

  // 200 exact replay requests (reusing 200 of the std-job requests with identical JSON)
  for (let i = 1; i <= 200; i++) {
    const jobId = `std-job-${i}`;
    tasks.push({
      jobKey: jobId,
      version: 1,
      isReplay: true,
      body: {
        tenantId,
        sourceId,
        eventId: `ev-std-${i}`,
        externalJobId: jobId,
        version: 1,
        operation: 'upsert',
        payload: {
          title: `Standard Engineer ${i}`,
          company: 'Load Corp',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          applyUrl: `https://load.test/jobs/${jobId}`,
          skills: ['typescript', 'mongodb'],
        },
      },
    });
  }

  console.log(`Total requests to submit: ${tasks.length} (1,000 distinct valid + 200 exact replays, 50 out-of-order jobs).`);

  // 4. Initialize Express app and Background Worker Pool
  const app = createApp();
  const workerCount = 4;
  console.log(`\nStarting ${workerCount} background workers...`);
  const workerPool = new WorkerPool(db, {
    concurrency: workerCount,
    pollIntervalMs: 20,
    backoffBaseMs: 50,
    provider: new ExternalVerificationProvider({ defaultStatus: 200 }),
  });
  workerPool.start();

  // 5. Ingestion Benchmark Execution
  const clientConcurrency = 20;
  console.log(`\nExecuting ingestion workload with HTTP client concurrency = ${clientConcurrency}...`);

  let acceptedCount = 0;
  let replayedCount = 0;
  let errorCount = 0;
  const latencies: number[] = [];

  const overallStartTime = Date.now();
  let taskIndex = 0;

  async function workerTask(): Promise<void> {
    while (taskIndex < tasks.length) {
      const current = tasks[taskIndex++];
      if (!current) break;

      const t0 = performance.now();
      try {
        const res = await request(app).post('/events').send(current.body);
        const t1 = performance.now();
        latencies.push(t1 - t0);

        if (res.status === 202) {
          acceptedCount++;
        } else if (res.status === 200) {
          replayedCount++;
        } else {
          errorCount++;
          console.error(`Unexpected status ${res.status}:`, res.body);
        }
      } catch (err) {
        errorCount++;
        console.error('Request error:', err);
      }
    }
  }

  const clientWorkers = Array.from({ length: clientConcurrency }, () => workerTask());
  await Promise.all(clientWorkers);
  const ingestionDurationMs = Date.now() - overallStartTime;

  console.log(`Ingestion completed in ${(ingestionDurationMs / 1000).toFixed(2)}s.`);
  console.log(`Ingestion throughput: ${(tasks.length / (ingestionDurationMs / 1000)).toFixed(1)} req/sec.`);

  // 6. Queue Drain Time Measurement
  console.log('\nMeasuring background queue drain time...');
  const drainStartTime = Date.now();
  let drained = false;

  while (Date.now() - drainStartTime < 60000) {
    const pending = await eventsCollection.countDocuments({
      tenantId,
      status: { $in: ['pending', 'processing'] },
    });
    if (pending === 0) {
      drained = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const drainDurationMs = Date.now() - drainStartTime;
  const totalProcessingDurationMs = Date.now() - overallStartTime;

  workerPool.stop();

  // 7. Verify Invariants and Final State
  console.log('\nVerifying database consistency and invariants:');
  const totalEventsInDb = await eventsCollection.countDocuments({ tenantId });
  const completedEventsInDb = await eventsCollection.countDocuments({ tenantId, status: 'completed' });
  const totalJobsInDb = await jobsCollection.countDocuments({ tenantId });

  // Check the 50 out-of-order jobs
  let oooCorrectCount = 0;
  for (let i = 1; i <= 50; i++) {
    const job = await jobsCollection.findOne({ tenantId, externalJobId: `ooo-job-${i}` });
    if (job && job.version === 2 && job.title?.includes('(v2)')) {
      oooCorrectCount++;
    }
  }

  const stats = calculatePercentiles(latencies);

  console.log('\n========================================================');
  console.log('                 LOAD TEST REPORT                       ');
  console.log('========================================================');
  console.log(`Requests Submitted:     ${tasks.length}`);
  console.log(`  - Accepted (202):     ${acceptedCount} (expected 1000)`);
  console.log(`  - Replayed (200):     ${replayedCount} (expected 200)`);
  console.log(`  - Errors:             ${errorCount} (expected 0)`);
  console.log('Latency:');
  console.log(`  - p50:                ${stats.p50.toFixed(2)} ms`);
  console.log(`  - p95:                ${stats.p95.toFixed(2)} ms`);
  console.log(`  - p99:                ${stats.p99.toFixed(2)} ms`);
  console.log(`  - Avg:                ${stats.avg.toFixed(2)} ms`);
  console.log(`  - Min/Max:            ${stats.min.toFixed(2)} ms / ${stats.max.toFixed(2)} ms`);
  console.log('Throughput & Timing:');
  console.log(`  - Ingestion Time:     ${(ingestionDurationMs / 1000).toFixed(2)} s (${(tasks.length / (ingestionDurationMs / 1000)).toFixed(1)} req/s)`);
  console.log(`  - Queue Drain Time:   ${(drainDurationMs / 1000).toFixed(2)} s`);
  console.log(`  - Total End-to-End:   ${(totalProcessingDurationMs / 1000).toFixed(2)} s`);
  console.log('Final State Consistency:');
  console.log(`  - Total Events in DB: ${totalEventsInDb} (expected 1000)`);
  console.log(`  - Completed Events:   ${completedEventsInDb} (expected 1000)`);
  console.log(`  - Total Jobs in DB:   ${totalJobsInDb} (expected 950: 900 std + 50 ooo)`);
  console.log(`  - Out-of-Order Jobs:  ${oooCorrectCount}/50 strictly resolved to version 2`);
  console.log('========================================================\n');

  await closeDatabase();

  if (
    acceptedCount !== 1000 ||
    replayedCount !== 200 ||
    errorCount !== 0 ||
    !drained ||
    totalEventsInDb !== 1000 ||
    completedEventsInDb !== 1000 ||
    totalJobsInDb !== 950 ||
    oooCorrectCount !== 50
  ) {
    console.error('FAILED: One or more load test assertion checks did not meet expectations.');
    process.exit(1);
  } else {
    console.log('SUCCESS: All load test benchmarks and consistency invariants passed!\n');
  }
}

main().catch((err) => {
  console.error('Fatal load test error:', err);
  process.exit(1);
});
