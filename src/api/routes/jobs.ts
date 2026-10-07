import { Router, Request, Response } from 'express';
import { ObjectId, Filter } from 'mongodb';
import { getDb } from '../../db/client';
import { getJobsCollection } from '../../db/collections';
import { JobDocument } from '../../domain/types';

export const jobsRouter = Router();

interface CursorPayload {
  updatedAt: string;
  id: string;
}

function encodeCursor(updatedAt: Date, id: ObjectId): string {
  const payload: CursorPayload = {
    updatedAt: updatedAt.toISOString(),
    id: id.toHexString(),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursorStr: string): { updatedAt: Date; id: ObjectId } | null {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf-8');
    const parsed = JSON.parse(raw) as CursorPayload;
    if (!parsed.updatedAt || !parsed.id) return null;
    return {
      updatedAt: new Date(parsed.updatedAt),
      id: new ObjectId(parsed.id),
    };
  } catch {
    return null;
  }
}

/**
 * GET /jobs
 * Scoped by tenantId with optional sourceId, status filter (active, archived, all),
 * capped limit, and deterministic cursor-based pagination.
 */
jobsRouter.get('/', async (req: Request, res: Response) => {
  const { tenantId, sourceId, status = 'active', limit = '20', cursor } = req.query;

  // 1. Validate tenantId (mandatory)
  if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId !== tenantId.trim()) {
    res.status(400).json({ error: 'Valid tenantId query parameter is required without surrounding whitespace' });
    return;
  }

  // 2. Validate optional sourceId
  if (sourceId !== undefined) {
    if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId !== sourceId.trim()) {
      res.status(400).json({ error: 'sourceId query parameter must be nonblank without surrounding whitespace' });
      return;
    }
  }

  // 3. Validate status
  if (typeof status !== 'string' || !['active', 'archived', 'all'].includes(status)) {
    res.status(400).json({ error: 'status parameter must be one of: active, archived, all' });
    return;
  }

  // 4. Validate limit (capped between 1 and 100, default 20)
  const parsedLimit = parseInt(String(limit), 10);
  if (isNaN(parsedLimit) || parsedLimit < 1) {
    res.status(400).json({ error: 'limit parameter must be a positive integer' });
    return;
  }
  const cappedLimit = Math.min(parsedLimit, 100);

  // 5. Decode cursor if provided
  let cursorData: { updatedAt: Date; id: ObjectId } | null = null;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string') {
      res.status(400).json({ error: 'cursor parameter must be a valid string' });
      return;
    }
    cursorData = decodeCursor(cursor);
    if (!cursorData) {
      res.status(400).json({ error: 'Malformed or invalid cursor parameter' });
      return;
    }
  }

  // 6. Build query filter
  const filter: Filter<JobDocument> = {
    tenantId,
  };

  if (sourceId) {
    filter.sourceId = sourceId;
  }

  if (status !== 'all') {
    filter.status = status as 'active' | 'archived';
  }

  if (cursorData) {
    filter.$or = [
      { updatedAt: { $lt: cursorData.updatedAt } },
      { updatedAt: cursorData.updatedAt, _id: { $lt: cursorData.id } },
    ];
  }

  const db = await getDb();
  const jobsCollection = getJobsCollection(db);

  // Fetch limit + 1 to check if there is a next page
  const docs = await jobsCollection
    .find(filter)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(cappedLimit + 1)
    .toArray();

  const hasNextPage = docs.length > cappedLimit;
  const items = hasNextPage ? docs.slice(0, cappedLimit) : docs;

  let nextCursor: string | null = null;
  if (hasNextPage && items.length > 0) {
    const lastItem = items[items.length - 1]!;
    nextCursor = encodeCursor(lastItem.updatedAt, lastItem._id!);
  }

  res.status(200).json({
    jobs: items.map((job) => ({
      tenantId: job.tenantId,
      sourceId: job.sourceId,
      externalJobId: job.externalJobId,
      version: job.version,
      status: job.status,
      title: job.title,
      company: job.company,
      location: job.location,
      experienceMin: job.experienceMin,
      experienceMax: job.experienceMax,
      applyUrl: job.applyUrl,
      skills: job.skills,
      lastEventId: job.lastEventId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })),
    pageInfo: {
      limit: cappedLimit,
      hasNextPage,
      nextCursor,
    },
  });
});
