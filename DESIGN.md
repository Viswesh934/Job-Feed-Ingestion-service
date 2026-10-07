# DESIGN.md: Architecture and Engineering Rationale

## 1. System Overview and Goals
The Job-Feed Ingestion Service is designed to ingest high-volume job change events with durable acceptance, strict replay safety, tenant/source isolation, and asynchronous processing. Current job states are materialized into a separate read projection that strictly respects monotonic job versioning and tombstone preservation.

---

## 2. Core Invariants

1. **Durable Acceptance Before Response**:
   A `202 Accepted` is returned if and only if the event document has been durably committed to MongoDB (`w: majority`). If the server crashes immediately following the HTTP response, the event is guaranteed to exist in durable storage and will be processed.
2. **Replay Idempotency**:
   An event is uniquely identified by the tuple `(tenantId, sourceId, eventId)`.
   - If an incoming event has the exact same identity and parsed JSON content (canonicalized, independent of object-key ordering), the service returns `200 OK` and creates **no second work item**.
   - If the event identity is reused with differing payload content, the service returns `409 Conflict`.
   - Invalid requests return `400 Bad Request` and never reserve the event identity, allowing corrected submissions to reuse the ID.
3. **Monotonic Job Version Projection**:
   A job is uniquely identified by the tuple `(tenantId, sourceId, externalJobId)`.
   - The greatest successfully processed version determines the visible state of the job.
   - Any event with a version lower than or equal to the current job version cannot overwrite the projection.
   - Archives create or update a versioned tombstone (`status: "archived"`). An archive arriving before an upsert creates a tombstone that prevents earlier upsert versions from resurrecting the job.
4. **Tenant and Source Isolation**:
   Every state partition and query boundary is strictly isolated by `(tenantId, sourceId)`. Data belonging to `tenant-a` cannot bleed into or collide with `tenant-b`.
5. **No Synchronous External Dependencies During Ingestion**:
   The ingestion path (`POST /events`) interacts only with MongoDB. External verification is strictly decoupled and executed asynchronously in background worker loops.

---

## 3. Data Model and Indexes

### Collections

#### `events` Collection
Records raw ingested events, canonical fingerprints, and worker lifecycle state:
```typescript
interface EventDocument {
  _id: ObjectId;
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: 'upsert' | 'archive';
  payload?: NormalizedJobPayload;
  rawCanonical: string;
  canonicalHash: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  attemptHistory: Array<{
    attempt: number;
    executedAt: Date;
    responseCode?: number;
    error?: string;
  }>;
  nextRunAt: Date;
  lockedAt?: Date;
  lockedBy?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes**:
1. `{ tenantId: 1, sourceId: 1, eventId: 1 }` (`unique: true`)
   - Enforces replay safety, conflict detection, and isolation.
2. `{ status: 1, nextRunAt: 1 }`
   - Powers atomic worker claims (`findOneAndUpdate`) and scheduled exponential backoff without full collection scans.
3. `{ status: 1, lockedAt: 1 }`
   - Powers the crashed-worker lease recovery reaper.
4. `{ tenantId: 1, sourceId: 1, externalJobId: 1, version: 1 }`
   - Enables fast inspection of event history for a given job.

#### `jobs` Collection
Stores the current materialized projection for fast, tenant-scoped read queries:
```typescript
interface JobDocument {
  _id: ObjectId;
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  version: number;
  status: 'active' | 'archived';
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
```

**Indexes**:
1. `{ tenantId: 1, sourceId: 1, externalJobId: 1 }` (`unique: true`)
   - Guarantees one canonical projection document per job entity.
2. `{ tenantId: 1, sourceId: 1, status: 1, updatedAt: -1, _id: -1 }`
   - Supports deterministic keyset/cursor pagination for `GET /jobs`.

---

## 4. Background Work Lifecycle and State Machine

```
[ POST /events ]
       |
       v
  [ pending ] <-----------------------------+
       |                                    | (Retryable 429/503 & attempts < 3)
       | (Atomic claim: findOneAndUpdate)   |
       v                                    |
 [ processing ]                             |
       |                                    |
       +---> Stale check (version <= job.version)?
       |        |
       |        +-- YES --> [ completed (no-op) ]
       |
       +---> External Verification (provider plan)
                |
                +-- 200 OK ----> Update Projection ---> [ completed ]
                |
                +-- 422 Unprocessable --> [ failed (permanent) ]
                |
                +-- 429/503 Error
                        |
                        +-- attempts >= 3 ----> [ failed (exhausted) ]
                        +-- attempts < 3  ----> Backoff schedule (nextRunAt)
```

### Competing Worker Claim Algorithm
Workers claim available work atomically using:
```typescript
const work = await eventsCollection.findOneAndUpdate(
  {
    status: 'pending',
    nextRunAt: { $lte: new Date() }
  },
  {
    $set: {
      status: 'processing',
      lockedAt: new Date(),
      lockedBy: workerId
    }
  },
  { returnDocument: 'after' }
);
```

### Abandoned Work Recovery
If a worker crashes or encounters an unhandled process termination while holding a claim:
- A periodic recovery sweep queries:
  `{ status: 'processing', lockedAt: { $lt: new Date(Date.now() - LOCK_TIMEOUT_MS) } }`
- The lock lease is reset, incrementing or preserving the attempt counter, allowing surviving workers to safely resume the task.

### Pagination Semantics and Data Changes Between Pages
The `GET /jobs` endpoint employs deterministic keyset (cursor-based) pagination sorted by `{ updatedAt: -1, _id: -1 }`:
- **Cursor Format**: An opaque, URL-safe base64url string encoding `{ updatedAt, id }`.
- **Query Filter**:
  ```typescript
  $or: [
    { updatedAt: { $lt: cursorDate } },
    { updatedAt: cursorDate, _id: { $lt: cursorId } }
  ]
  ```
- **Behavior When Data Changes Between Pages**:
  1. *New Insertions*: New jobs inserted with `now()` timestamps appear at the top of the collection (before the cursor). A client paginating forward through older items will **not receive duplicate records**.
  2. *Updates to Already-Seen Items*: If an item on Page 1 is updated while the client is fetching Page 2, its `updatedAt` shifts to the top of the collection. The client advancing forward will not see it again on future pages.
  3. *Zero Duplicates Invariant*: Keyset pagination guarantees that records already traversed are never repeated, and pagination remains $O(1)$ without the performance degradation of `skip()` offsets.

---

## 5. Atomicity Boundaries and Independent Failure Modes

| Failure Point | Consequence | Recovery Mechanism |
|---|---|---|
| **Ingestion failure before DB write** | HTTP request fails (500 or timeout). Client receives no 202. | Client retransmits. Replay safety ensures safe eventual ingestion. |
| **Ingestion crash after DB write, before HTTP response** | Document exists in `events` collection (`pending`). Client may assume failure and retry. | Retried request hits existing event identity: returns `200 OK (replayed)`. Background worker processes the event normally. No work lost, no duplicates. |
| **Worker crashes after projection update, before work ack** | Projection is updated to version $V$, but event remains in `processing` status. | Lock reaper detects expired lease and marks event `pending`. Another worker claims the event, checks the current projection, sees `currentJob.version >= event.version`, and finishes as an idempotent no-op. Projection remains correct. |
| **External verification fails (429/503)** | Event state marked `pending` with exponential backoff `nextRunAt = now + base * 2^attempts`. | Event is picked up once backoff time elapses. Projection remains unmodified until success. |
| **External verification fails permanently (422) or exhausts retries** | Event marked `failed` with terminal error details. | Job projection is never touched. Existing lower version remains visible. |

---

## 6. Alternatives Considered and Rejected

### Alternative 1: Pure MongoDB Change Streams as Worker Queue
- **Concept**: Have background workers attach `collection.watch()` on the `events` collection.
- **Why Rejected**:
  1. *Fan-Out, Not Competing Consumers*: Change streams broadcast each insert to *every* active listener. Multiple workers would all receive the same event simultaneously, requiring an additional distributed locking layer to prevent redundant execution.
  2. *Scheduled Retries*: Change streams cannot delay delivery for exponential backoff (429/503). Retrying would require in-memory timers (`setTimeout`), which are lost if a worker process crashes or restarts.
  3. *Linear Resume Tokens*: Change stream resume tokens are monotonic across the collection. If Worker A fails on item 5 while Worker B succeeds on item 6, you cannot rewind the resume token for Worker A without redelivering item 6.

### Alternative 2: In-Memory Queue (BullMQ / Async Queue in Node.js)
- **Concept**: In-process queues or ephemeral worker channels.
- **Why Rejected**:
  1. *Violation of Durable Acceptance*: If an API process accepts an event and pushes it to an in-memory queue, an unexpected process restart loses all queued items.
  2. *Lack of Multi-Process Competing Workers*: In-memory queues do not coordinate across multiple OS processes or worker containers without an external broker like Redis.

---

## 7. Production Security and Edge Cases

### Production Authentication & Authorization
In this exercise, `tenantId` is accepted as a trusted payload input. In production:
1. Requests must pass through an API Gateway or JWT authentication middleware.
2. The authenticated caller's identity (e.g., `req.user.tenantId`) is extracted from the cryptographic token.
3. The server overrides or validates that `payload.tenantId === req.user.tenantId`, preventing cross-tenant spoofing.

### Conflicting Content for Same Job Version
The fixture contract specifies that a job version describes one semantic change. If a source transmits two events with the same `(tenantId, sourceId, externalJobId, version)` but conflicting content:
1. **Rejection at Ingestion**: If submitted with the same `eventId`, it is caught by the replay checker and rejected with `409 Conflict`.
2. **If Submitted Under New `eventId`**:
   - In production, we would maintain an optional compound unique constraint or state guard on `(tenantId, sourceId, externalJobId, version)`.
   - If content diverges, the service can route the conflicting version to a dead-letter inspection collection (`quarantine_events`) with an alert for data source divergence, preventing silent inconsistent overwrites.

---

## 8. Bottlenecks and Deliberate Trade-Offs

### First Likely Bottleneck
- **Worker Polling Write-Contention**: Under high worker concurrency, multiple workers running `findOneAndUpdate` on `{ status: 'pending', nextRunAt: { $lte: now } }` create index lock contention on the queue index.
  - *Mitigation*: Batch claims or partition worker claims by hashed `tenantId` / `externalJobId`.

### Deliberate Trade-off Accepted Within Time Budget
- **Single Work/Event Document vs. Separate Queue Collection**: Storing execution metadata (`status`, `attempts`, `nextRunAt`) directly on the `events` document minimizes collection overhead and enables single-document atomic updates without multi-document transactions. The tradeoff is that updates to work status generate write amplification on the event collection.
