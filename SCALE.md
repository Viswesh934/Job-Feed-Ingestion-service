# SCALE.md: Architectural Scaling Analysis

This document analyzes the evolution of the Job-Feed Ingestion Service from **100,000 events/day** to **10,000,000 events/day**, handling bursts of **5,000 events/second**, achieving a 5-minute processing SLA, and maintaining 7-day raw event retention with ~1 million current job projections.

---

## 1. Workload Profiling & Mathematical Model

### Baseline Parameters
- **Daily Volume**: 100,000 events/day $\rightarrow$ 10,000,000 events/day
- **Peak Burst Rate**: 5,000 events/second
- **SLA**: 100% of accepted events processed within $\le 5\text{ minutes}$ (300 seconds)
- **Raw Event Payload**: 1 KB average size
- **Event Retention Window**: 7 days (604,800 seconds)
- **Projected Jobs Entity Count**: ~1,000,000 active/archived documents

---

### Ingestion Rates and Capacity Demands

| Metric | 100,000 events/day | 10,000,000 events/day | 5,000 events/sec Burst |
|---|---|---|---|
| **Average Ingestion Rate** | $1.16\text{ events/sec}$ | $115.7\text{ events/sec}$ | $5,000\text{ events/sec}$ |
| **Ingestion Network Bandwidth** | $1.16\text{ KB/sec}$ | $115.7\text{ KB/sec}$ | $5.0\text{ MB/sec}$ ($40\text{ Mbps}$) |
| **Daily Storage Addition** | $100\text{ MB/day}$ | $10.0\text{ GB/day}$ | $300\text{ MB/minute}$ (during burst) |
| **7-Day Retention Storage** | $700\text{ MB}$ raw | $70.0\text{ GB}$ raw ($\sim 105\text{ GB}$ with indexes) | N/A |

---

### Burst Duration vs. Drain Capacity Calculations

Under a burst of $5,000\text{ events/second}$, the system accumulates a backlog $B = \text{BurstRate} \times T_{\text{burst}}$.
To satisfy the SLA of draining this backlog within $T_{\text{SLA}} = 300\text{ seconds}$, the effective processing capacity $C_{\text{drain}}$ must satisfy:

$$C_{\text{drain}} \ge \frac{B}{T_{\text{SLA}}} = \frac{5,000 \times T_{\text{burst}}}{300}$$

#### Scenarios for Burst Durations:
1. **Flash Burst ($T_{\text{burst}} = 15\text{ seconds}$)**:
   - Total burst backlog: $75,000\text{ events}$
   - Required drain throughput: $C_{\text{drain}} \ge \frac{75,000}{300} = 250\text{ events/second}$
2. **Standard Burst ($T_{\text{burst}} = 60\text{ seconds}$)**:
   - Total burst backlog: $300,000\text{ events}$
   - Required drain throughput: $C_{\text{drain}} \ge \frac{300,000}{300} = 1,000\text{ events/second}$
3. **Prolonged Burst ($T_{\text{burst}} = 120\text{ seconds}$)**:
   - Total burst backlog: $600,000\text{ events}$
   - Required drain throughput: $C_{\text{drain}} \ge \frac{600,000}{300} = 2,000\text{ events/second}$

**Maximum Sustainable Burst**:
With a target worker pool sized for $1,200\text{ events/second}$ processing throughput:
$$T_{\text{burst, max}} = \frac{C_{\text{drain}} \times T_{\text{SLA}}}{5,000 - C_{\text{drain}}} = \frac{1,200 \times 300}{3,800} \approx 94.7\text{ seconds}$$
*Conclusion*: Sized at $1,200\text{ events/second}$ processing capacity, the system can sustain a full $5,000\text{ events/second}$ burst for **up to 95 consecutive seconds** without breaching the 5-minute processing SLA.

---

## 2. Worker Sizing and Horizontal Scaling

### Processing Cost Assumptions
- Verification HTTP call (network latency): $5\text{ ms}$ (internal VPC)
- MongoDB findOneAndUpdate claim: $2\text{ ms}$
- MongoDB projection upsert + event complete write: $3\text{ ms}$
- Total CPU/IO time per event: $\approx 10\text{ ms}$

### Worker Pool Sizing
- A single Node.js worker event loop utilizing async concurrency of 20 can process $\approx 100\text{ events/second}$.
- To sustain $1,200\text{ events/second}$ peak drain throughput:
  $$\text{Workers Required} = \frac{1,200}{100} = 12\text{ worker processes}$$
- Distributed as 3 worker pods (4 processes each) with 2 vCPUs and 2 GB RAM per pod.

---

## 3. MongoDB Scaling: Retention, Hot Keys, and Sharding

### Retention and TTL Indexing
Raw events must be retained for 7 days.
MongoDB provides native TTL indexes:
```javascript
db.events.createIndex(
  { "createdAt": 1 },
  { expireAfterSeconds: 604800, name: "ttl_events_7d" }
);
```
- **Operational Reality**: The MongoDB background TTL monitor runs once per minute. Under 10M events/day, each minute expires $\approx 6,944$ documents.
- To prevent write stalls during large deletion spikes, TTL deletions should run against secondary storage during off-peak hours, or use capped time-series/bucket collections.

### Hot Keys & Write Contention
At $5,000\text{ writes/sec}$ during ingestion and $1,200\text{ writes/sec}$ during worker claims:
1. **Contention Point**: Multiple workers querying `{ status: 'pending', nextRunAt: { $lte: now } }` will contend on the index lock for `idx_worker_queue`.
2. **Mitigation Without Redis**:
   - **Bucket Partitioning**: Add a claim partition key: `partition: { $mod: [hash(externalJobId), 16] }`. Workers are assigned specific partition IDs ($0..15$), completely eliminating index mutex contention across workers.

### Sharding Strategy
When scaling beyond 10M events/day or single-node write saturation ($\approx 15,000\text{ writes/sec}$ on NVMe):
- **Shard Key for `events` Collection**:
  `{ tenantId: "hashed", sourceId: 1, eventId: 1 }`
  - *Trade-off*: Compound unique index `{ tenantId: 1, sourceId: 1, eventId: 1 }` is strictly preserved because the shard key is a prefix.
- **Shard Key for `jobs` Collection**:
  `{ tenantId: "hashed", sourceId: 1, externalJobId: 1 }`
  - *Trade-off*: All reads for a tenant (`GET /jobs?tenantId=...`) target a deterministic shard or broadcast cleanly, while individual job updates are targeted single-shard operations.

---

## 4. Backpressure, Noisy Tenants, and Retry Storms

### Admission Control & Ingestion Backpressure
When the database write queue exceeds safe operational thresholds (e.g. WiredTiger ticket exhaustion):
- **HTTP 429 Backpressure**: The API returns `429 Too Many Requests` with a `Retry-After: 5` header when pending queue length exceeds 100,000 items.

### Noisy Tenant Fairness
A single misconfigured tenant pushing 5,000 events/second must not starve other tenants.
- **Token Bucket Rate Limiting**: Ingestion throttles requests exceeding tenant tier limits ($R_{\text{tier}}$).
- **Fair Worker Scheduling**: Workers claim work with fair round-robin or tenant-distributed query cursors, preventing a single tenant from monopolizing worker concurrency.

### Retry Storm Prevention
When an upstream verification service fails:
- Exponential backoff with jitter:
  $$\text{Delay} = \text{base} \times 2^{\text{attempt}} + \text{random}(0, \text{jitter})$$
- Circuit Breakers: If provider returns consecutive 503 errors over a 10-second rolling window, open circuit for 30 seconds to prevent hammering the failing upstream service.

---

## 5. Metrics, Observability, and Alerts

### Key Operational Metrics
1. **`job_feed_queue_age_seconds`**: Maximum age of currently pending events ($\text{now} - \text{oldest}(\text{createdAt})$).
   - *Alert*: Warning if $> 60\text{s}$, Critical if $> 240\text{s}$ (approaching 5-minute SLA).
2. **`job_feed_ingestion_rate` & `job_feed_processing_rate`**: Rates per second.
   - *Alert*: Warning if processing rate $< 0.5 \times \text{ingestion rate}$ for $> 3\text{ minutes}$.
3. **`mongodb_wiredtiger_tickets_available`**: Concurrency tickets available.
   - *Alert*: Warning if read/write tickets $< 20$.
4. **`job_feed_retry_count` & `job_feed_dlq_count`**: Number of retries and terminal failures per minute.

---

## 6. Architecture Evolution: When to Introduce Kafka/Redis

While the current MongoDB architecture comfortably handles up to 10M events/day, an external streaming broker (e.g. Apache Kafka or AWS Kinesis) and Redis cache should be introduced when:

1. **Ingestion Exceeds 20,000 events/second**: At this scale, MongoDB write IOPS become cost-prohibitive compared to partitioned sequential append logs like Kafka.
2. **Multiple Downstream Consumers**: When job projections need to be ingested into Elasticsearch for full-text search, data lakes (Snowflake/BigQuery), and real-time webhook dispatchers, a pub/sub event log decouples consumers cleanly.
3. **Sub-second Worker Latency**: Redis streams provide microsecond claim latency without database index write amplification.
