import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { getJobsCollection } from '../../src/db/collections';
import { Db, ObjectId } from 'mongodb';
import { JobDocument } from '../../src/domain/types';

describe('GET /jobs API Integration Tests', () => {
  let app: ReturnType<typeof createApp>;
  let db: Db;

  beforeAll(async () => {
    const conn = await setupTestDb();
    db = conn.db;
    app = createApp();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  describe('Validation', () => {
    it('returns 400 when tenantId is missing', async () => {
      const res = await request(app).get('/jobs');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tenantId');
    });

    it('returns 400 when tenantId has surrounding whitespace', async () => {
      const res = await request(app).get('/jobs?tenantId=%20tenant-a%20');
      expect(res.status).toBe(400);
    });

    it('returns 400 when status is invalid', async () => {
      const res = await request(app).get('/jobs?tenantId=tenant-a&status=deleted');
      expect(res.status).toBe(400);
    });
  });

  describe('Filtering and Scoping', () => {
    beforeEach(async () => {
      const jobs: JobDocument[] = [
        {
          _id: new ObjectId(),
          tenantId: 'tenant-a',
          sourceId: 'main',
          externalJobId: 'job-1',
          version: 1,
          status: 'active',
          title: 'Active Job 1',
          company: 'Acme',
          location: 'Remote',
          lastEventId: 'ev-1',
          createdAt: new Date('2026-01-01T10:00:00Z'),
          updatedAt: new Date('2026-01-01T10:00:00Z'),
        },
        {
          _id: new ObjectId(),
          tenantId: 'tenant-a',
          sourceId: 'main',
          externalJobId: 'job-2',
          version: 2,
          status: 'archived',
          lastEventId: 'ev-2',
          createdAt: new Date('2026-01-01T11:00:00Z'),
          updatedAt: new Date('2026-01-01T11:00:00Z'),
        },
        {
          _id: new ObjectId(),
          tenantId: 'tenant-a',
          sourceId: 'secondary',
          externalJobId: 'job-3',
          version: 1,
          status: 'active',
          title: 'Active Job 3',
          company: 'Acme',
          location: 'Remote',
          lastEventId: 'ev-3',
          createdAt: new Date('2026-01-01T12:00:00Z'),
          updatedAt: new Date('2026-01-01T12:00:00Z'),
        },
        {
          _id: new ObjectId(),
          tenantId: 'tenant-b',
          sourceId: 'main',
          externalJobId: 'job-b-1',
          version: 1,
          status: 'active',
          title: 'Tenant B Job',
          lastEventId: 'ev-b-1',
          createdAt: new Date('2026-01-01T13:00:00Z'),
          updatedAt: new Date('2026-01-01T13:00:00Z'),
        },
      ];
      await getJobsCollection(db).insertMany(jobs);
    });

    it('defaults to status=active and scopes to tenantId', async () => {
      const res = await request(app).get('/jobs?tenantId=tenant-a');
      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(2);
      expect(res.body.jobs.every((j: { status: string }) => j.status === 'active')).toBe(true);
      expect(res.body.jobs.every((j: { tenantId: string }) => j.tenantId === 'tenant-a')).toBe(true);
    });

    it('supports status=archived filter', async () => {
      const res = await request(app).get('/jobs?tenantId=tenant-a&status=archived');
      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(1);
      expect(res.body.jobs[0].externalJobId).toBe('job-2');
    });

    it('supports status=all filter for inspection', async () => {
      const res = await request(app).get('/jobs?tenantId=tenant-a&status=all');
      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(3);
    });

    it('filters by sourceId when provided', async () => {
      const res = await request(app).get('/jobs?tenantId=tenant-a&sourceId=secondary&status=all');
      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(1);
      expect(res.body.jobs[0].externalJobId).toBe('job-3');
    });
  });

  describe('Deterministic Keyset/Cursor Pagination', () => {
    beforeEach(async () => {
      const jobs: JobDocument[] = [];
      for (let i = 1; i <= 5; i++) {
        jobs.push({
          _id: new ObjectId(),
          tenantId: 'tenant-pagination',
          sourceId: 'main',
          externalJobId: `job-p-${i}`,
          version: 1,
          status: 'active',
          title: `Job ${i}`,
          lastEventId: `ev-${i}`,
          createdAt: new Date(`2026-01-01T10:0${i}:00Z`),
          updatedAt: new Date(`2026-01-01T10:0${i}:00Z`),
        });
      }
      await getJobsCollection(db).insertMany(jobs);
    });

    it('paginates deterministically without omissions or duplicate records', async () => {
      // Page 1: limit 2
      const res1 = await request(app).get('/jobs?tenantId=tenant-pagination&limit=2');
      expect(res1.status).toBe(200);
      expect(res1.body.jobs).toHaveLength(2);
      expect(res1.body.pageInfo.hasNextPage).toBe(true);
      expect(res1.body.pageInfo.nextCursor).toBeDefined();

      const page1Ids = res1.body.jobs.map((j: { externalJobId: string }) => j.externalJobId);

      // Page 2: limit 2 with cursor from page 1
      const res2 = await request(app).get(`/jobs?tenantId=tenant-pagination&limit=2&cursor=${res1.body.pageInfo.nextCursor}`);
      expect(res2.status).toBe(200);
      expect(res2.body.jobs).toHaveLength(2);
      expect(res2.body.pageInfo.hasNextPage).toBe(true);
      expect(res2.body.pageInfo.nextCursor).toBeDefined();

      const page2Ids = res2.body.jobs.map((j: { externalJobId: string }) => j.externalJobId);

      // Page 3: limit 2 with cursor from page 2 (should return the final 1 item)
      const res3 = await request(app).get(`/jobs?tenantId=tenant-pagination&limit=2&cursor=${res2.body.pageInfo.nextCursor}`);
      expect(res3.status).toBe(200);
      expect(res3.body.jobs).toHaveLength(1);
      expect(res3.body.pageInfo.hasNextPage).toBe(false);
      expect(res3.body.pageInfo.nextCursor).toBeNull();

      const page3Ids = res3.body.jobs.map((j: { externalJobId: string }) => j.externalJobId);

      // Verify no overlap across pages
      const allFetched = [...page1Ids, ...page2Ids, ...page3Ids];
      const uniqueFetched = new Set(allFetched);
      expect(uniqueFetched.size).toBe(5);
    });
  });
});
