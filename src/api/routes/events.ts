import { Router, Request, Response } from 'express';
import { MongoServerError } from 'mongodb';
import { getDb } from '../../db/client';
import { getEventsCollection } from '../../db/collections';
import { validateAndNormalizeEvent } from '../../domain/validation';
import { stringifyCanonicalJson, hashCanonicalJson } from '../../domain/canonical';
import { EventDocument } from '../../domain/types';

export const eventsRouter = Router();

/**
 * POST /events
 * Ingests a single job event with replay safety and durable acceptance.
 */
eventsRouter.post('/', async (req: Request, res: Response) => {
  // 1. Validation and normalization
  const validation = validateAndNormalizeEvent(req.body);
  if (!validation.success) {
    res.status(400).json({
      error: 'Validation failed',
      details: validation.errors,
    });
    return;
  }

  const { data } = validation;
  const rawCanonical = stringifyCanonicalJson(req.body);
  const canonicalHash = hashCanonicalJson(req.body);

  const db = await getDb();
  const eventsCollection = getEventsCollection(db);

  // 2. Check for existing event (replay or conflict)
  const existing = await eventsCollection.findOne({
    tenantId: data.tenantId,
    sourceId: data.sourceId,
    eventId: data.eventId,
  });

  if (existing) {
    if (existing.canonicalHash === canonicalHash) {
      // Replay: exact same identity and parsed JSON content
      res.status(200).json({
        status: 'replayed',
        eventId: data.eventId,
        tenantId: data.tenantId,
        sourceId: data.sourceId,
        message: 'Event already accepted',
      });
      return;
    } else {
      // Conflict: same identity but different content
      res.status(409).json({
        error: 'Conflict: Event identity already exists with different payload',
        eventId: data.eventId,
      });
      return;
    }
  }

  // 3. New event: write durably to MongoDB
  const now = new Date();
  const newEvent: EventDocument = {
    tenantId: data.tenantId,
    sourceId: data.sourceId,
    eventId: data.eventId,
    externalJobId: data.externalJobId,
    version: data.version,
    operation: data.operation,
    payload: data.normalizedPayload,
    rawCanonical,
    canonicalHash,
    status: 'pending',
    attempts: 0,
    attemptHistory: [],
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await eventsCollection.insertOne(newEvent, { writeConcern: { w: 'majority' } });
    res.status(202).json({
      status: 'accepted',
      eventId: data.eventId,
    });
  } catch (err) {
    // Handle concurrent duplicate insertion race
    if (err instanceof MongoServerError && err.code === 11000) {
      const racedExisting = await eventsCollection.findOne({
        tenantId: data.tenantId,
        sourceId: data.sourceId,
        eventId: data.eventId,
      });

      if (racedExisting && racedExisting.canonicalHash === canonicalHash) {
        res.status(200).json({
          status: 'replayed',
          eventId: data.eventId,
          tenantId: data.tenantId,
          sourceId: data.sourceId,
          message: 'Event already accepted',
        });
        return;
      } else {
        res.status(409).json({
          error: 'Conflict: Event identity already exists with different payload',
          eventId: data.eventId,
        });
        return;
      }
    }

    res.status(500).json({
      error: 'Failed to durably record event',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /events/:eventId?tenantId=...&sourceId=...
 * Returns acceptance/processing state, attempt count, and last error.
 */
eventsRouter.get('/:eventId', async (req: Request, res: Response) => {
  const { eventId } = req.params;
  const { tenantId, sourceId } = req.query;

  if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId !== tenantId.trim()) {
    res.status(400).json({ error: 'Valid tenantId query parameter is required' });
    return;
  }

  if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId !== sourceId.trim()) {
    res.status(400).json({ error: 'Valid sourceId query parameter is required' });
    return;
  }

  if (typeof eventId !== 'string' || !eventId.trim() || eventId !== eventId.trim()) {
    res.status(400).json({ error: 'Valid eventId path parameter is required' });
    return;
  }

  const db = await getDb();
  const eventsCollection = getEventsCollection(db);

  const eventDoc = await eventsCollection.findOne({
    tenantId,
    sourceId,
    eventId,
  });

  if (!eventDoc) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  res.status(200).json({
    eventId: eventDoc.eventId,
    tenantId: eventDoc.tenantId,
    sourceId: eventDoc.sourceId,
    externalJobId: eventDoc.externalJobId,
    version: eventDoc.version,
    operation: eventDoc.operation,
    status: eventDoc.status,
    attempts: eventDoc.attempts,
    attemptHistory: eventDoc.attemptHistory ?? [],
    lastError: eventDoc.lastError ?? null,
    createdAt: eventDoc.createdAt,
    updatedAt: eventDoc.updatedAt,
  });
});
