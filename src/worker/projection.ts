import { Db, MongoServerError } from 'mongodb';
import { EventDocument, JobDocument } from '../domain/types';
import { getJobsCollection } from '../db/collections';

export interface ProjectionApplyResult {
  applied: boolean;
  isStale: boolean;
  job?: JobDocument;
}

/**
 * Checks if an event is stale compared to the current job projection.
 * If the job exists and its version is greater than or equal to the event version,
 * the event is considered stale.
 */
export async function isEventStale(db: Db, event: EventDocument): Promise<boolean> {
  const jobsCollection = getJobsCollection(db);
  const existingJob = await jobsCollection.findOne({
    tenantId: event.tenantId,
    sourceId: event.sourceId,
    externalJobId: event.externalJobId,
  });

  if (!existingJob) {
    return false;
  }

  return event.version <= existingJob.version;
}

/**
 * Applies an event to the jobs collection respecting version monotonicity and tombstones.
 * Guarantees that lower or equivalent versions cannot overwrite the projection.
 */
export async function applyJobProjection(db: Db, event: EventDocument): Promise<ProjectionApplyResult> {
  const jobsCollection = getJobsCollection(db);
  const now = new Date();

  // 1. Check if job exists
  const existingJob = await jobsCollection.findOne({
    tenantId: event.tenantId,
    sourceId: event.sourceId,
    externalJobId: event.externalJobId,
  });

  // 2. Stale check
  if (existingJob && event.version <= existingJob.version) {
    return {
      applied: false,
      isStale: true,
      job: existingJob,
    };
  }

  // 3. New job insertion
  if (!existingJob) {
    const isArchive = event.operation === 'archive';
    const newJob: JobDocument = {
      tenantId: event.tenantId,
      sourceId: event.sourceId,
      externalJobId: event.externalJobId,
      version: event.version,
      status: isArchive ? 'archived' : 'active',
      ...(isArchive
        ? {}
        : {
            title: event.payload?.title,
            company: event.payload?.company,
            location: event.payload?.location,
            experienceMin: event.payload?.experienceMin,
            experienceMax: event.payload?.experienceMax,
            applyUrl: event.payload?.applyUrl,
            skills: event.payload?.skills,
          }),
      lastEventId: event.eventId,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await jobsCollection.insertOne(newJob);
      return { applied: true, isStale: false, job: newJob };
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        // Concurrently inserted by another worker, proceed to conditional update below
      } else {
        throw err;
      }
    }
  }

  // 4. Update existing job only if version is strictly greater
  if (event.operation === 'upsert') {
    const updateResult = await jobsCollection.findOneAndUpdate(
      {
        tenantId: event.tenantId,
        sourceId: event.sourceId,
        externalJobId: event.externalJobId,
        version: { $lt: event.version },
      },
      {
        $set: {
          version: event.version,
          status: 'active',
          title: event.payload?.title,
          company: event.payload?.company,
          location: event.payload?.location,
          experienceMin: event.payload?.experienceMin,
          experienceMax: event.payload?.experienceMax,
          applyUrl: event.payload?.applyUrl,
          skills: event.payload?.skills,
          lastEventId: event.eventId,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );

    if (updateResult) {
      return { applied: true, isStale: false, job: updateResult };
    }
  } else if (event.operation === 'archive') {
    const updateResult = await jobsCollection.findOneAndUpdate(
      {
        tenantId: event.tenantId,
        sourceId: event.sourceId,
        externalJobId: event.externalJobId,
        version: { $lt: event.version },
      },
      {
        $set: {
          version: event.version,
          status: 'archived',
          lastEventId: event.eventId,
          updatedAt: now,
        },
        $unset: {
          title: '',
          company: '',
          location: '',
          experienceMin: '',
          experienceMax: '',
          applyUrl: '',
          skills: '',
        },
      },
      { returnDocument: 'after' }
    );

    if (updateResult) {
      return { applied: true, isStale: false, job: updateResult };
    }
  }

  // If no update occurred, another worker or greater version already exists
  const currentJob = await jobsCollection.findOne({
    tenantId: event.tenantId,
    sourceId: event.sourceId,
    externalJobId: event.externalJobId,
  });

  return {
    applied: false,
    isStale: true,
    job: currentJob ?? undefined,
  };
}
