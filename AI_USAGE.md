# AI_USAGE.md: AI Assistance Record and Human Verification

## 1. Overview and Tool Attribution
- **AI Tool/Model**: Google Antigravity / Gemini 3.8 Flash (High)
- **Role of AI**: Assisted in drafting domain validation schemas, canonical JSON serializer, worker competing consumer loop, and load test scripts.
- **Responsibility**: All generated artifacts, architecture claims, invariants, and implementation code were independently reviewed, executed, verified, and benchmarked against real MongoDB concurrency.

---

## 2. Artifacts Assisted by AI

### Artifact 1: Canonical JSON Serialization & Hashing (`src/domain/canonical.ts`)
- **Prompt Excerpt**: "Generate a canonical JSON stringifier and SHA-256 hasher that ignores object-key order while preserving array element order."
- **AI Output**: A recursive function sorting object keys lexicographically and preserving array index sequences.
- **Human Review & Changes**:
  - Verified edge cases: verified that primitives (`null`, `number`, `boolean`, `string`) and nested objects within arrays are properly handled.
  - Added unit tests in `tests/unit/canonical.test.ts` verifying that `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash identically, whereas `{ skills: ['a', 'b'] }` and `{ skills: ['b', 'a'] }` produce distinct hashes.
- **Verification Method**: Executed `tests/unit/canonical.test.ts` via Vitest. Passed.

### Artifact 2: Competing Background Worker Loop (`src/worker/worker.ts`)
- **Prompt Excerpt**: "Draft a MongoDB atomic work claim loop with lock lease recovery and exponential backoff retry scheduling."
- **AI Output**: Implementation utilizing `findOneAndUpdate` on `{ status: 'pending', nextRunAt: { $lte: now } }` with lock leases.
- **Human Review & Changes**:
  - Found and fixed: Initially, unused variables in `pool.ts` violated TypeScript's strict `noUnusedLocals` rule. Removed unused fields.
  - Added test hook `testHookCrashBeforeAck` into `Worker` to enable reproducible simulation of the assignment's explicit failure case (crash after writing projection but before acknowledging work).
- **Verification Method**: Executed `tests/integration/worker.test.ts` verifying atomic claims, 429 backoff, 422 permanent failure, 503 retry exhaustion, and crash recovery. Passed.

### Artifact 3: High-Volume Load Scenario (`scripts/load-test.ts`)
- **Prompt Excerpt**: "Generate a load test script for 1,000 distinct valid events, 200 exact replays, and 50 out-of-order version jobs measuring p50/p95 latency and queue drain time."
- **AI Output**: Benchmark script using `supertest` with concurrent async workers and latency percentile calculation.
- **Human Review & Changes**:
  - Verified that 50 out-of-order jobs (100 events total) plus 900 standard jobs strictly equaled the 1,000 distinct valid events target.
  - Added database assertions verifying that all 50 out-of-order jobs resolved strictly to version 2, and that total jobs in MongoDB equaled 950.
- **Verification Method**: Executed `npm run load-test` against live MongoDB replica set, recording real metrics: 192.2 req/sec, p50 90.33ms, p95 220.44ms, drain time 8.41s.

---

## 3. Human Quality Control Summary
No unverified AI claims or hallucinations were accepted into the codebase. All algorithms were validated against the assignment specification, strict TypeScript compiler (`tsc`), and live replica set integration tests.
