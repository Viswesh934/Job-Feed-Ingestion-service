import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup.js';
import { getEventsCollection } from '../../src/db/collections.js';
import { Db } from 'mongodb';

describe('Phase 1: Ingestion API Integration Tests', () => {
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

  describe('GET /health', () => {
    it('returns 200 with service and mongodb status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies.mongodb).toBe('connected');
    });
  });

  describe('POST /events - Validation', () => {
    it('rejects event with surrounding whitespace in tenantId with 400', async () => {
      const payload = {
        tenantId: ' tenant-a',
        sourceId: 'main',
        eventId: 'event-101',
        externalJobId: 'alpha',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Acme',
          location: 'Remote',
          experienceMin: 1,
          experienceMax: 3,
          applyUrl: 'https://example.com/jobs/1',
          skills: ['ts'],
        },
      };

      const res = await request(app).post('/events').send(payload);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');

      // Verify no document was created
      const count = await getEventsCollection(db).countDocuments();
      expect(count).toBe(0);
    });

    it('rejects archive operation if payload is provided', async () => {
      const payload = {
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-102',
        externalJobId: 'alpha',
        version: 2,
        operation: 'archive',
        payload: {
          title: 'Not allowed here',
        },
      };

      const res = await request(app).post('/events').send(payload);
      expect(res.status).toBe(400);
    });

    it('allows corrected reuse after a rejected request', async () => {
      const invalid = {
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-reuse-1',
        externalJobId: 'alpha',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Acme',
          location: 'Remote',
          experienceMin: 10,
          experienceMax: 5, // invalid: min > max
          applyUrl: 'https://example.com/jobs/1',
          skills: ['ts'],
        },
      };

      // 1. First attempt fails validation with 400
      const res1 = await request(app).post('/events').send(invalid);
      expect(res1.status).toBe(400);

      // 2. Corrected attempt with the same eventId succeeds with 202
      const corrected = {
        ...invalid,
        payload: {
          ...invalid.payload,
          experienceMin: 2,
          experienceMax: 5,
        },
      };

      const res2 = await request(app).post('/events').send(corrected);
      expect(res2.status).toBe(202);
      expect(res2.body.status).toBe('accepted');
      expect(res2.body.eventId).toBe('event-reuse-1');

      const count = await getEventsCollection(db).countDocuments();
      expect(count).toBe(1);
    });
  });

  describe('POST /events - Durable Acceptance and Replay Safety', () => {
    const validEvent = {
      tenantId: 'tenant-a',
      sourceId: 'main',
      eventId: 'event-201',
      externalJobId: 'job-alpha',
      version: 1,
      operation: 'upsert',
      payload: {
        title: 'Senior Engineer',
        company: 'Cloud Corp',
        location: 'Remote',
        experienceMin: 3,
        experienceMax: 6,
        applyUrl: 'https://cloudcorp.test/apply',
        skills: [' TypeScript ', 'Go', 'typescript'],
      },
    };

    it('returns 202 on new valid event and records it in database', async () => {
      const res = await request(app).post('/events').send(validEvent);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        status: 'accepted',
        eventId: 'event-201',
      });

      const doc = await getEventsCollection(db).findOne({
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-201',
      });

      expect(doc).not.toBeNull();
      expect(doc?.status).toBe('pending');
      expect(doc?.attempts).toBe(0);
      expect(doc?.payload?.skills).toEqual(['typescript', 'go']);
    });

    it('returns 200 on exact duplicate replay and creates no second work item', async () => {
      // First submission
      const res1 = await request(app).post('/events').send(validEvent);
      expect(res1.status).toBe(202);

      // Replay with different object-key ordering
      const permutedEvent = {
        payload: {
          skills: [' TypeScript ', 'Go', 'typescript'],
          applyUrl: 'https://cloudcorp.test/apply',
          experienceMax: 6,
          experienceMin: 3,
          location: 'Remote',
          company: 'Cloud Corp',
          title: 'Senior Engineer',
        },
        operation: 'upsert',
        version: 1,
        externalJobId: 'job-alpha',
        eventId: 'event-201',
        sourceId: 'main',
        tenantId: 'tenant-a',
      };

      const res2 = await request(app).post('/events').send(permutedEvent);
      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('replayed');
      expect(res2.body.eventId).toBe('event-201');

      // Exactly 1 document in the collection
      const count = await getEventsCollection(db).countDocuments({
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-201',
      });
      expect(count).toBe(1);
    });

    it('returns 409 Conflict when reusing event identity with different content', async () => {
      // First submission
      await request(app).post('/events').send(validEvent);

      // Conflicting submission (different title)
      const conflictEvent = {
        ...validEvent,
        payload: {
          ...validEvent.payload,
          title: 'Completely Different Role',
        },
      };

      const res = await request(app).post('/events').send(conflictEvent);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('Conflict');
    });
  });

  describe('POST /events - Isolation', () => {
    const baseEvent = {
      externalJobId: 'job-1',
      version: 1,
      operation: 'upsert' as const,
      payload: {
        title: 'Engineer',
        company: 'Corp',
        location: 'Remote',
        experienceMin: 1,
        experienceMax: 2,
        applyUrl: 'https://example.com/apply',
        skills: ['node'],
      },
    };

    it('isolates identical eventId across different tenants', async () => {
      const eventTenantA = {
        ...baseEvent,
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'same-event-id',
      };

      const eventTenantB = {
        ...baseEvent,
        tenantId: 'tenant-b',
        sourceId: 'main',
        eventId: 'same-event-id',
      };

      const resA = await request(app).post('/events').send(eventTenantA);
      const resB = await request(app).post('/events').send(eventTenantB);

      expect(resA.status).toBe(202);
      expect(resB.status).toBe(202);

      const count = await getEventsCollection(db).countDocuments({ eventId: 'same-event-id' });
      expect(count).toBe(2);
    });

    it('isolates identical eventId across different sources within the same tenant', async () => {
      const eventSrc1 = {
        ...baseEvent,
        tenantId: 'tenant-a',
        sourceId: 'source-1',
        eventId: 'shared-id',
      };

      const eventSrc2 = {
        ...baseEvent,
        tenantId: 'tenant-a',
        sourceId: 'source-2',
        eventId: 'shared-id',
      };

      const res1 = await request(app).post('/events').send(eventSrc1);
      const res2 = await request(app).post('/events').send(eventSrc2);

      expect(res1.status).toBe(202);
      expect(res2.status).toBe(202);

      const count = await getEventsCollection(db).countDocuments({
        tenantId: 'tenant-a',
        eventId: 'shared-id',
      });
      expect(count).toBe(2);
    });
  });

  describe('POST /events - Concurrency Race Handling', () => {
    it('handles concurrent duplicate requests safely without 500 error or duplicate items', async () => {
      const concurrentEvent = {
        tenantId: 'tenant-race',
        sourceId: 'main',
        eventId: 'race-event-999',
        externalJobId: 'job-race',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Race Developer',
          company: 'Speedy Inc',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 4,
          applyUrl: 'https://speedy.test/apply',
          skills: ['fast'],
        },
      };

      // Fire 5 identical requests at the exact same moment
      const promises = Array.from({ length: 5 }).map(() =>
        request(app).post('/events').send(concurrentEvent)
      );

      const responses = await Promise.all(promises);

      // Exactly one should be 202 Accepted, and the others should be 200 Replayed
      const statusCodes = responses.map((r) => r.status);
      expect(statusCodes).toContain(202);
      for (const code of statusCodes) {
        expect([200, 202]).toContain(code);
      }

      const count = await getEventsCollection(db).countDocuments({
        tenantId: 'tenant-race',
        eventId: 'race-event-999',
      });
      expect(count).toBe(1);
    });
  });

  describe('GET /events/:eventId', () => {
    it('returns 404 for non-existent event', async () => {
      const res = await request(app).get('/events/non-existent?tenantId=tenant-a&sourceId=main');
      expect(res.status).toBe(404);
    });

    it('returns 400 when tenantId or sourceId query param is missing', async () => {
      const res = await request(app).get('/events/event-101');
      expect(res.status).toBe(400);
    });

    it('returns event metadata for existing event', async () => {
      const event = {
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-query-1',
        externalJobId: 'job-1',
        version: 1,
        operation: 'archive',
      };

      await request(app).post('/events').send(event);

      const res = await request(app).get('/events/event-query-1?tenantId=tenant-a&sourceId=main');
      expect(res.status).toBe(200);
      expect(res.body.eventId).toBe('event-query-1');
      expect(res.body.status).toBe('pending');
      expect(res.body.attempts).toBe(0);
      expect(res.body.lastError).toBeNull();
    });
  });
});
