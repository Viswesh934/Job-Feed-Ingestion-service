import { Db, MongoClient } from 'mongodb';
import { connectToDatabase, closeDatabase } from '../../src/db/client.js';

let testDb: Db;
let testClient: MongoClient;

const TEST_DB_NAME = 'job_feed_service_test';

export async function setupTestDb(): Promise<{ db: Db; client: MongoClient }> {
  const { db, client } = await connectToDatabase(
    process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/job_feed_service_test?replicaSet=rs0&directConnection=true',
    TEST_DB_NAME
  );
  testDb = db;
  testClient = client;
  return { db: testDb, client: testClient };
}

export async function clearTestDb(): Promise<void> {
  if (testDb) {
    const collections = await testDb.collections();
    for (const coll of collections) {
      await coll.deleteMany({});
    }
  }
}

export async function teardownTestDb(): Promise<void> {
  await closeDatabase();
}
