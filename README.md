# Reliable Job-Feed Ingestion Service

A production-grade, fault-tolerant job-feed ingestion service built with **Node.js 24**, **TypeScript** (strict checking), **Express**, and **MongoDB Replica Set** (`rs0`).

Designed for high reliability, durable acceptance, replay idempotency, monotonic job versioning, and asynchronous background worker processing without external brokers (no Redis or Kafka in runnable core).

---

## Architecture Overview

```
[ POST /events ] 
       │
       ▼ (Durable Write: w: majority)
 [ MongoDB `events` ] ◄── (Replay 200 / Conflict 409)
       │
       ▼ (Atomic Claims: findOneAndUpdate)
 [ Competing Workers (Worker-1, Worker-2) ]
       │
       ├─► [ Stale Check ] ──────────► [ Complete (No-Op) ]
       │
       ├─► [ Fake Provider Verification ] ──► (429/503: Exponential Backoff, 422: Fail)
       │
       ▼ (Monotonic Greatest-Version Update)
 [ MongoDB `jobs` Projection ] ◄── (Tombstone Preservation)
       ▲
       │
 [ GET /jobs ] (Keyset / Deterministic Cursor Pagination)
```

For in-depth invariants, failure scenarios, and architectural trade-offs, read [DESIGN.md](DESIGN.md).  
For the 100k to 10M events/day growth, 5,000 req/s burst models, and sharding strategies, read [SCALE.md](SCALE.md).

---

## Quickstart & Setup Commands

### Prerequisites
- Node.js >= 22.0.0
- Docker & Docker Compose

### 1. Setup Environment
```bash
# Clone the repository
git clone https://github.com/Viswesh934/Job-Feed-Ingestion-service.git
cd Job-Feed-Ingestion-service

# Start MongoDB 7.0 single-node replica set (rs0)
docker compose up -d

# Install dependencies
npm install

# Compile TypeScript
npm run build
```

### 2. Run the End-to-End Demo
Runs the supplied 20-request scenario across Phase 1 and delayed Phase 2 with queue draining and invariant checks:
```bash
npm run demo
```
See [DEMO.md](DEMO.md) for expected output and detailed scenario walkthrough.

### 3. Run the Automated Test Suite
Runs all unit and integration tests (validation, canonical hashing, API endpoints, worker races, crash recovery):
```bash
npm test
```

### 4. Run the Load Scenario
Executes 1,000 distinct valid events + 200 exact replays + 50 out-of-order version jobs:
```bash
npm run load-test
```

### 5. Running the Service Locally
```bash
# Start API server and in-process worker pool
WORKER_ENABLED=true npm run dev

# Or run API server and worker in separate processes:
# Terminal 1:
npm run dev

# Terminal 2:
npm run worker
```

---

## API Contract

### 1. `POST /events`
Accepts a single job event. Returns `202 Accepted` only after the event is durably committed to MongoDB (`w: majority`).

- **Exact Duplicate Replay**: Same `(tenantId, sourceId, eventId)` and same canonical JSON $\rightarrow$ returns `200 OK` (creates zero second work items).
- **Conflict**: Reusing `(tenantId, sourceId, eventId)` with different content $\rightarrow$ returns `409 Conflict`.
- **Validation Failure**: Malformed identifier, non-safe version, non-https URL, or invalid skills $\rightarrow$ returns `400 Bad Request` (does not reserve event ID).

**Example Upsert Request**:
```json
{
  "tenantId": "tenant-a",
  "sourceId": "main",
  "eventId": "event-101",
  "externalJobId": "alpha",
  "version": 1,
  "operation": "upsert",
  "payload": {
    "title": "Full Stack Developer",
    "company": "Example Labs",
    "location": "Surat",
    "experienceMin": 1,
    "experienceMax": 3,
    "applyUrl": "https://example.test/jobs/alpha",
    "skills": [" TypeScript ", "MongoDB", "typescript"]
  }
}
```

**Example Archive Request**:
```json
{
  "tenantId": "tenant-a",
  "sourceId": "main",
  "eventId": "event-102",
  "externalJobId": "alpha",
  "version": 2,
  "operation": "archive"
}
```

### 2. `GET /events/:eventId?tenantId=...&sourceId=...`
Returns acceptance/processing state, attempt count, and last error for a specific event.

### 3. `GET /jobs?tenantId=...&sourceId=...&status=active&limit=20&cursor=...`
Returns tenant-scoped list of current job projections.
- `status`: `active` (default), `archived`, or `all`.
- `limit`: Capped page size (1..100, default 20).
- `cursor`: Keyset cursor for deterministic pagination (`updatedAt`, `_id`).

### 4. `GET /health`
Returns service and MongoDB connection readiness status (`status: "ok"` or `"degraded"`).

---

## Deliverables & Documentation Index

- [DESIGN.md](DESIGN.md): Invariants, collection schemas, atomicity boundaries, failure modes, rejected alternatives, and trade-offs.
- [SCALE.md](SCALE.md): Scale analysis for 100k $\rightarrow$ 10M events/day, 5k req/s burst models, worker sizing, retention, and sharding.
- [DEMO.md](DEMO.md): Complete demo walkthrough, measured load benchmarks, and verification guide.
- [AI_USAGE.md](AI_USAGE.md): AI tool attribution, prompt excerpts, human code review, and verification log.
- [QC_REPORT.md](QC_REPORT.md): Mandatory post-generation quality control, hypothesis challenging, and security review.