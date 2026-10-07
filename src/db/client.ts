import { MongoClient, Db } from 'mongodb';
import { config } from '../config';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectToDatabase(uri = config.mongoUri, dbName = config.dbName): Promise<{ client: MongoClient; db: Db }> {
  if (client && db) {
    return { client, db };
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);

  await initIndexes(db);

  return { client, db };
}

export async function getDb(): Promise<Db> {
  if (!db) {
    const connected = await connectToDatabase();
    return connected.db;
  }
  return db;
}

export async function getMongoClient(): Promise<MongoClient> {
  if (!client) {
    const connected = await connectToDatabase();
    return connected.client;
  }
  return client;
}

export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export async function initIndexes(database: Db): Promise<void> {
  const eventsCollection = database.collection('events');
  const jobsCollection = database.collection('jobs');

  // 1. Events collection indexes
  // Unique index on (tenantId, sourceId, eventId) for replay safety & isolation
  await eventsCollection.createIndex(
    { tenantId: 1, sourceId: 1, eventId: 1 },
    { unique: true, name: 'uniq_tenant_source_event' }
  );

  // Queue polling index for worker claims and retry backoff
  await eventsCollection.createIndex(
    { status: 1, nextRunAt: 1 },
    { name: 'idx_worker_queue' }
  );

  // Crash recovery / lock timeout reaper index
  await eventsCollection.createIndex(
    { status: 1, lockedAt: 1 },
    { name: 'idx_worker_recovery' }
  );

  // Lookup by job identifier
  await eventsCollection.createIndex(
    { tenantId: 1, sourceId: 1, externalJobId: 1, version: 1 },
    { name: 'idx_event_job_lookup' }
  );

  // 2. Jobs collection indexes
  // Unique index on (tenantId, sourceId, externalJobId) for current projection
  await jobsCollection.createIndex(
    { tenantId: 1, sourceId: 1, externalJobId: 1 },
    { unique: true, name: 'uniq_tenant_source_job' }
  );

  // Deterministic cursor pagination index
  await jobsCollection.createIndex(
    { tenantId: 1, sourceId: 1, status: 1, updatedAt: -1, _id: -1 },
    { name: 'idx_jobs_pagination' }
  );
}
