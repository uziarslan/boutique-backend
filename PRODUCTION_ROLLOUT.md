# Production rollout and rollback

This release intentionally separates **safe code deployment** from **live
activation**. All Redis-dependent behavior is off by default. The first
deployment therefore keeps the direct PRA eIMS path and single-process
Socket.IO/rate-limit behavior while adding the POS query reductions, graceful
shutdown, request IDs, readiness checks, security fixes, and durable PRA state.

Never enable every flag in one release. Advance only after the preceding gate
has remained healthy through a full busy service period.

## Invariants that must remain synchronous

The following work stays inside the sale request and is not a worker candidate:

- authoritative price, discount, tax, and payment validation;
- inventory deduction and stock ledger entries;
- journal entries and drawer/session totals;
- employee credit and allowance authorization;
- loyalty redemption and balance mutation;
- the persisted completed sale and its idempotency key.

A POS success response therefore still means the financial and inventory result
has been committed. Only external or rebuildable work may be asynchronous.

## Release gate 0: credentials and backups

1. Confirm a recent restorable MongoDB backup and document the restore owner.
2. Restore that backup into a non-production database at least once.
3. Re-authenticate the Heroku CLI and confirm the exact app before any command:

   ```sh
   heroku auth:whoami
   heroku apps:info --app "$RESTAURANT_HEROKU_APP"
   heroku ps --app "$RESTAURANT_HEROKU_APP"
   heroku addons --app "$RESTAURANT_HEROKU_APP"
   ```

4. Run the current production test suite and capture baseline metrics:
   POS sale p50/p95/p99 latency, 5xx rate, Mongo connections/CPU, web dyno
   memory/load, PRA pending count, and print claim latency.
5. For every PRA-enabled outlet, verify its own Test/Production POS ID, bearer
   token, and eight-digit PCT service code. Before production activation, obtain
   PRA confirmation that every IP in `PRA_STATIC_IPS` is whitelisted for that
   restaurant/POS registration.

Do not paste Redis URLs, tokens, JWT secrets, or the output of an unredacted
configuration dump into tickets or chat.

## Release gate 1: deploy with every Redis flag off

Required values:

```text
PRA_QUEUE_ENABLED=false
RIDER_TRACKING_QUEUE_ENABLED=false
SOCKET_REDIS_ENABLED=false
DISTRIBUTED_RATE_LIMIT_ENABLED=false
MONGO_PLATFORM_MAX_POOL_SIZE=10
MONGO_TENANT_MAX_POOL_SIZE=5
MONGO_MAX_IDLE_TIME_MS=60000
MONGO_WAIT_QUEUE_TIMEOUT_MS=10000
```

After deployment:

1. Verify `/api/health/live` returns 200.
2. Verify `/api/health/ready` returns 200 and reports the platform database as
   connected.
3. Perform one test sale for every payment path in a test outlet: cash, card,
   split, discount, loyalty earn/redeem, employee credit/allowance, hold/resume,
   void, refund, and offline replay.
4. Confirm stock, stock ledger, journal, session totals, receipt, KOT, audit,
   loyalty, and PRA status agree with the pre-calculated expected result.
5. Stop/restart one web dyno during a non-financial test request and confirm it
   drains cleanly.

Rollback for this gate is the previous application release. No data migration
is required; the new compound and outbox indexes are additive.

## Release gate 2: prove the queue Redis

Prefer a durable Redis instance for BullMQ. When using Heroku Key-Value Mini,
MongoDB sale state and outbox events remain authoritative: the dispatcher
requeues stale published events, while the PRA retry sweep is the final
recovery path after a Key-Value restart. Its eviction policy must still be
`noeviction`, and the connection limit must cover web producers plus workers.

Set only `QUEUE_REDIS_URL`, leave `PRA_QUEUE_ENABLED=false`, then run:

```sh
heroku run npm run ops:preflight --app "$RESTAURANT_HEROKU_APP"
```

The command must report:

- database connected;
- queue Redis reachable;
- Redis `maxmemoryPolicy` equal to `noeviction`, or independently verified with
  the provider if managed Redis blocks `CONFIG`;
- no secret values in output.

Do not enable the queue if this check fails.

## Release gate 3: activate one critical worker

1. Scale exactly one `worker-critical` process.
2. Confirm its logs show a successful Mongo and Redis connection and no restart
   loop.
3. Keep the PRA retry sweep scheduled.
4. Schedule `npm run jobs:outbox-dispatch` at least every ten minutes. It repairs
   the narrow crash window between saving a sale and publishing its queue job.
5. Set `PRA_QUEUE_ENABLED=true`, causing the web and worker processes to restart.
6. Create sandbox PRA sales and verify:
   sale `pra.status=pending` before dispatch, one deterministic BullMQ job,
   one PRA submission, terminal sale status, and completed outbox event.
7. Simulate Redis unavailability in staging. The web path must return the sale,
   fall back to direct PRA submission, and retain `pra.status=pending` for retry
   when the external call cannot complete.

Rollback:

1. Set `PRA_QUEUE_ENABLED=false`.
2. Scale `worker-critical` to zero only after its active job has drained.
3. Keep `npm run jobs:pra-retry` active. Pending sales remain the durable source
   of truth and continue through the previous direct retry path.

Never delete BullMQ keys or outbox records as part of rollback.

## Release gate 3b: rider tracking worker

The tracking worker removes point persistence, route-distance updates, device
health writes, geofence transitions, and delivery-run preparation from the web
request. The web dyno still authenticates the rider, verifies the active shift,
and writes one durable MongoDB inbox record before acknowledging the phone.
BullMQ wakes the worker; a 15-second MongoDB inbox sweep recovers work after a
Redis restart, including on the non-persistent Heroku Redis Mini plan.

1. Keep `RIDER_TRACKING_QUEUE_ENABLED=false` during the first deployment.
2. Run `npm run ops:preflight` and verify the queue Redis uses `noeviction`.
3. Scale exactly one `worker-tracking` dyno. Keep
   `RIDER_TRACKING_WORKER_CONCURRENCY=1` so GPS batches remain FIFO.
4. Set `RIDER_TRACKING_QUEUE_ENABLED=true`.
5. Lock a test phone for at least 15 minutes and verify the worker queue returns
   to zero, GPS age remains live, route points increase, and Socket.IO updates
   reach both Rider Operations and POS Dispatch.
6. Temporarily block Redis in staging. The web log must report the queue
   failure and the request must complete through inline processing.

Rollback by setting `RIDER_TRACKING_QUEUE_ENABLED=false`, waiting for the queue
to drain, and then scaling `worker-tracking` to zero. Do not run more than one
tracking worker dyno until jobs are partitioned by rider while preserving order.

## Release gate 4: multiple web dynos

Before scaling the web process above one:

1. Configure and verify a cache/coordination Redis connection.
2. Enable `SOCKET_REDIS_ENABLED=true` so events and recovered sessions cross web
   dynos.
3. Enable `DISTRIBUTED_RATE_LIMIT_ENABLED=true` so limits are global rather than
   multiplied by dyno count.
4. Re-run authenticated cashier, public QR, order tablet, and print-status
   socket tests while forcing reconnects and dyno restarts.
5. Scale one dyno at a time while watching the Mongo connection budget. The
   upper bound is approximately:

   ```text
   web/worker processes × platform pool
   + processes × simultaneously touched tenant databases × tenant pool
   ```

Rollback these two flags independently. Do not reduce dynos until active
requests have drained.

## Release gate 5: performance acceptance

Use a staging copy with production-like menu, stock, users, held orders, and
reports. Test read traffic and sale traffic separately. A sale test must use
unique client transaction IDs and reconcile every generated financial record.

Release acceptance:

- no duplicate sale, journal, stock movement, loyalty transaction, print job, or
  PRA invoice;
- no cross-tenant response, socket room, or cache entry;
- POS sale p95 is better than baseline and has no material p99 regression;
- 5xx rate does not exceed baseline;
- Mongo wait queue remains empty and connections remain inside the provider
  budget;
- Redis has no eviction, reconnect storm, or growing failed-job backlog;
- worker backlog returns to zero after the peak;
- offline replay never causes a request burst and all entries reconcile.

If any invariant fails, disable only the newest gate and investigate from the
request ID, tenant slug, sale ID, client transaction ID, outbox event, and job
ID. Do not compensate financial records manually until their existing reversal
workflow has been checked.

## Work intentionally deferred

These changes need production measurements or infrastructure proof before code:

- moving stock, accounting, loyalty, or shift-close logic to workers;
- Mongo multi-document transactions until the live topology is transaction
  capable and integration-tested;
- Redis-cached POS menus until all menu mutation paths have proven invalidation;
- replacing the Windows print connector's durable claim protocol;
- asynchronous analytics projections until a reconciliation/rebuild command and
  freshness SLO exist;
- moving mandatory audit events to Redis without a same-database durable outbox.

Deferral is a correctness decision, not an omission: each item can silently
change financial, kitchen, or security behavior if enabled without those gates.
