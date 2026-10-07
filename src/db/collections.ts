import { Collection, Db } from 'mongodb';
import { EventDocument, JobDocument } from '../domain/types.js';

export function getEventsCollection(db: Db): Collection<EventDocument> {
  return db.collection<EventDocument>('events');
}

export function getJobsCollection(db: Db): Collection<JobDocument> {
  return db.collection<JobDocument>('jobs');
}
