import { ObjectId } from 'mongodb';

export type EventOperation = 'upsert' | 'archive';

export type EventStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type JobStatus = 'active' | 'archived';

export interface RawJobPayload {
  title: string;
  company: string;
  location: string;
  experienceMin: number;
  experienceMax: number;
  applyUrl: string;
  skills: string[];
}

export interface NormalizedJobPayload {
  title: string;
  company: string;
  location: string;
  experienceMin: number;
  experienceMax: number;
  applyUrl: string;
  skills: string[];
}

export interface IngestionEventInput {
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: EventOperation;
  payload?: RawJobPayload;
}

export interface AttemptRecord {
  attempt: number;
  executedAt: Date;
  responseCode?: number;
  error?: string;
}

export interface EventDocument {
  _id?: ObjectId;
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: EventOperation;
  payload?: NormalizedJobPayload;
  rawCanonical: string;
  canonicalHash: string;
  status: EventStatus;
  attempts: number;
  attemptHistory: AttemptRecord[];
  nextRunAt: Date;
  lockedAt?: Date;
  lockedBy?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobDocument {
  _id?: ObjectId;
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  version: number;
  status: JobStatus;
  title?: string;
  company?: string;
  location?: string;
  experienceMin?: number;
  experienceMax?: number;
  applyUrl?: string;
  skills?: string[];
  lastEventId: string;
  createdAt: Date;
  updatedAt: Date;
}
