# QC_REPORT.md: Post-Generation Quality Control Report

## 1. Execution Environment & Baseline
- **Operating System**: Linux 6.8.0-1064-azure (x64)
- **Node.js Version**: v24.21.0
- **MongoDB**: 7.0 Single-Node Replica Set (`rs0`) via Docker Compose
- **Date & Time of QC Pass**: 2026-10-07
- **Base Commit Tested**: `0b4d728` (Phase 1)
- **Final Submission Commit SHA**: `ecb1872` (Phase 2 completion)

---

## 2. Mandatory Verification Runs

| Verification Step | Command Run | Result | Evidence / Notes |
|---|---|---|---|
| **TypeScript Strict Checking** | `npm run build` | **PASS (0 errors)** | Compiled via `tsc` with `strict: true`, `noImplicitAny`, `noUncheckedIndexedAccess`. |
| **Unit & Integration Tests** | `npm test` | **PASS (51/51 passed)** | 6 test files, 51 tests passed in ~3s across real MongoDB replica set (including restart persistence and pagination boundary checks). |
| **End-to-End Demo Scenario** | `npm run demo` | **PASS (20/20 requests)** | 18 Phase 1 requests + 2 delayed Phase 2 requests verified with drain settlement. |
| **Load Benchmark Scenario** | `npm run load-test` | **PASS (1200 requests)** | 1,000 accepted (`202`), 200 replayed (`200`), 0 errors. Ingestion: 191.8 req/s, Drain: 8.56s. |

---

## 3. Challenging Plausible Failure Hypotheses

### Hypothesis 1: Concurrency Crash Recovery Edge Case
- **Hypothesis**: If a worker crashes immediately after successfully persisting a job projection update to MongoDB, but before acknowledging the event document (`status: 'processing'`), the lock lease recovery could cause a surviving worker to re-execute external verification or create duplicate side-effects.
- **Verification & Evidence**:
  - Implemented in `tests/integration/worker.test.ts` (`recovers from deliberate crash after projection update before acknowledgment`):
    - Worker 1 executes `applyJobProjection` and is stopped immediately by throwing via `testHookCrashBeforeAck`.
    - Event remains in `status: 'processing'` with lock held.
    - Lease timer expires ($50\text{ ms}$).
    - Worker 2 reclaims the item via `reapAbandonedLocks()`.
    - Worker 2 executes `isEventStale()`, discovers the job version is already $\ge$ event version, and marks the event `completed` as an idempotent no-op without re-contacting the provider or duplicating the projection.
  - **Verdict**: Hypothesis refuted. The stale short-circuit guarantees idempotency and safe recovery under worker crashes.

### Hypothesis 2: Replay Safety Under Arbitrary Key Permutations
- **Hypothesis**: If a client sends an identical event payload with nested objects whose keys are serialized in a different order (e.g. `{ skills, title, ... }` vs `{ title, skills, ... }`), the service might erroneously return `409 Conflict` or accept duplicate work.
- **Verification & Evidence**:
  - Evaluated in `tests/unit/canonical.test.ts` and `tests/integration/events.api.test.ts`:
    - Permuted keys were submitted for the same event ID.
    - The canonical serializer recursively sorts object keys while strictly preserving array order (skills order remains intact).
    - Produced identical SHA-256 hash.
    - Returned `200 OK` (`status: "replayed"`). Collection count remained strictly 1.
  - **Verdict**: Hypothesis refuted. Canonical hashing eliminates key-order sensitivity while preserving array significance.

### Hypothesis 3: Stale Work Bypassing External Rate Limits
- **Hypothesis**: If out-of-order delivery results in an older version arriving after a newer version is already active, the worker might unnecessarily call the external verification endpoint before discarding the change, consuming provider rate limits.
- **Verification & Evidence**:
  - Evaluated in `src/worker/worker.ts` lines 118-135 and fixture request #11 (`req-upsert-stale`):
    - In `Worker.handleEvent()`, `isEventStale(this.db, event)` is invoked as step 1 *before* `this.provider.verify()`.
    - Because job `beta` had already been archived at version 1, `req-upsert-stale` (version 1) was short-circuited directly to `status: 'completed'` with 0 provider calls consumed.
  - **Verdict**: Hypothesis refuted. Stale events bypass verification completely.

---

## 4. Documentation, Index, and Contract Consistency Audit

- **README Examples**: Verified that example requests in `README.md` conform to the strict Zod schema in `src/domain/validation.ts`.
- **Database Indexes**: Verified that all indexes declared in `src/db/client.ts` match those documented in `DESIGN.md`:
  - `events`: `{ tenantId: 1, sourceId: 1, eventId: 1 }` (unique)
  - `events`: `{ status: 1, nextRunAt: 1 }` (queue poll)
  - `events`: `{ status: 1, lockedAt: 1 }` (lock recovery)
  - `jobs`: `{ tenantId: 1, sourceId: 1, externalJobId: 1 }` (unique)
  - `jobs`: `{ tenantId: 1, sourceId: 1, status: 1, updatedAt: -1, _id: -1 }` (cursor pagination)
- **Retry Settings**: Verified `maxAttempts: 3` and exponential backoff base $1000\text{ ms}$ ($2^{\text{attempt}-1}$) aligns across `.env.example`, `config.ts`, `worker.ts`, and `DESIGN.md`.

---

## 5. Security and Input Sanitization Review

1. **Identifier Sanitization**: Rejection of surrounding whitespace (`val.trim() === val && val.length > 0`) is applied to `tenantId`, `sourceId`, `eventId`, and `externalJobId`, preventing silent identifier mutations.
2. **Tenant Scoping**: All job listing queries and event status queries strictly require `tenantId`.
3. **Credentials Check**: Verified that no secrets or API keys are committed. `.env` is listed in `.gitignore`; only `.env.example` is committed.
4. **Dependencies**: `npm audit` shows 0 runtime production vulnerabilities in Express, MongoDB, and Zod.
