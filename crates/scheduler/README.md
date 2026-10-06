# Persistent scheduler

`asset-scheduler` keeps a FIFO DAG queue in SQLite. SQLite WAL, `FULL` durability,
busy timeout, and immediate write transactions protect state and prevent duplicate
claims by multiple connections. The coordinator calls `recover()` once at startup,
after previous local worker processes are gone.

The active queue defaults to 512 jobs. `open_with_options` or `set_queue_capacity`
can persist an explicit limit from 1 through 4096; every connection reads the same
setting inside its admission transaction. Reducing it below active work is rejected.
Historical succeeded, failed, and cancelled
jobs remain readable. Missing dependencies, duplicate ids, dependency cycles,
invalid reservations, and jobs larger than 1 MB are rejected atomically.

## Coordinator contract

- `SchedulerStore::open(path)`; `enqueue(job)` / `enqueue_many(jobs)`; `jobs()`.
  Retain one store per project: it owns one mutex-protected SQLite connection and
  caches hot-path statements. Opening another store remains safe for concurrent
  coordinators. `get_job(id)` returns one current row or `None` without reading the
  entire history.
  Admission, current resource usage, and single-job callbacks read indexed active
  rows plus only the terminal dependency states they reference. The active DAG,
  referenced metadata, immutable FIFO sequence, and queue capacity are still
  validated. Completed history is never deleted or truncated; `jobs()` and graph
  rerun/cancellation retain the full-history validation and descendant semantics.
  A partial index for cancelled local worker holds avoids scanning every old
  cancellation. It is installed idempotently without changing scheduler schema 2
  or the project's `user_version`.
- `enqueue_once(request_id, job)` and `enqueue_many_once(request_id, jobs)` persist
  one user action and its ordered receipt in the same transaction as the jobs.
  Replaying the same intent returns the original ids with `replayed=true`, including
  after a lost response or restart. A conflicting intent is rejected. New deliberate
  variations require a new request id. Request ids are safe ASCII identifiers up to
  256 bytes (UUIDs are suitable), separate from cache identity.
  Fingerprints omit runtime ids/times/progress and normalize intra-batch dependencies
  and `jobId`/`processJobId` references. Other payload fields remain semantic:
  the coordinator must keep options, seeds, and any `versionId` stable during retry.
- `jobs_page(after_sequence, limit)` uses the immutable enqueue sequence and
  returns `{jobs,nextCursor,hasMore}`. `events_after(cursor, limit)` returns
  `{events,nextCursor,hasMore}`. Start at zero; limits must be 1 through 256.
  State changes append durable, monotonic events in the same transaction as changed
  rows. Unchanged rows and repeated acknowledgements create no extra writes/events.
  Events contain only state, stage/counts, attempts, time, and optional external ids;
  prompts, payloads, and raw errors stay in the current job. Individual events are
  bounded to 4 KB. History is retained; this is a state-event log, not artifact commit
  replay or a full execution journal. A schema-1 migration records one current
  snapshot per existing job, without inventing previous transitions.
- `claim_ready(&ResourceLimits)` returns persisted running reservations. Only then
  launch a verified local worker or provider operation.
  Every claim stores a fresh UUID in `payload.executionId`, including retries and
  crash recovery. Artifact commit markers must identify this execution UUID: a
  deliberate rerun resets attempts to zero, so `(jobId, attempts)` can repeat.
  Enqueue/reset discard supplied/old execution ids; request fingerprinting ignores
  this runtime field. Interrupted ids remain available until the next claim so
  startup commit recovery can verify already written results before rescheduling.
- Default admission: two CPU jobs, one Blender job, one external job; 2 CPU threads,
  2048 MB RAM, 0 MB GPU memory, disk weight 2. Resource counts are separate while
  RAM, GPU memory, threads, and disk reservations are shared.
- `payload.resources` supports `ramMb`, `cpuThreads`, `gpuMb`, `diskWeight`.
  Defaults are CPU `(256 MB, 1 thread, disk 1)`, Blender `(1024 MB, 2 threads,
  disk 1)`, and external `(64 MB, 0 local threads, disk 0)`.
- `try_transition_resources(id, execution_id, &ResourceReservation, &limits)`
  atomically changes a running execution's RAM/GPU/thread/disk reservation. Its
  CPU/Blender/external job slot stays reserved. The worker must wait for `true`
  before beginning a phase that needs the new reservation. Contention, stale
  execution ids, and cancelled/non-running jobs return `false`; invalid or
  individually oversized requests return an error. Repeated identical transitions
  create no writes/events. An external worker can hold its existing RAM while
  releasing local CPU/disk during remote waiting, then reacquire CPU/disk before
  downloading, decoding, or writing artifacts. External concurrency is unchanged.
  `payload.runningResources` is coordinator-owned runtime state; enqueue, retry,
  reset, new claims, completion, and startup recovery clear it, and request
  fingerprinting ignores it. `payload.resources` remains the initial admission
  reservation. Cancelled local workers retain their transitioned reservation until
  observed exit; uncertain external jobs retain only their external slot.
- Job reservations are estimates supplied by trusted workers, **not an OS memory
  sandbox**. Actual worker RSS, process trees, thread count, and artifacts still
  require coordinator measurement and enforcement.
- `set_progress` accepts a known stage and either confirmed count/total or
  indeterminate `None/None`. It never fabricates percentages.
- After a provider request is submitted, call `mark_external_submitted(id)`.
  Network/rate errors on submitted requests become `external_unknown`.
  Prefer `set_external_identity(id, thread_id, turn_id)` immediately in the official
  start callback: it marks submitted and persists both ids atomically, including if
  local cancellation already made the job uncertain. Conflicting identities require
  explicit resolution. The coordinator must match callbacks to the current attempt.
- `complete(id)` requires the coordinator to validate the actual output first.
- `fail(id, FailureKind, message)` retries network/rate failures at 2, 4, and 8
  seconds only when submission is known not to have happened. Authentication,
  permission, and unsupported capability errors wait for user input. Input/worker
  failures stop and propagate to dependent jobs.
- `cancel(id)` returns affected ids. The coordinator must terminate local process
  handles. A running external request becomes `external_unknown`; local
  cancellation never claims remote cancellation.
  Call `confirm_external_cancelled(id)` only after the official service reports a
  matching terminal interrupted/cancelled acknowledgement. It changes the uncertain
  job to cancelled and releases its external slot; sending an interrupt or aborting
  local polling does not authorize this acknowledgement.
  Running local cancellations retain reservations through
  `payload.cancellationAwaitingWorker`. Call `release_cancelled_resources(id)` only
  after observing process/thread exit. This prevents a cancellation race from
  admitting new work while the old worker still consumes CPU and memory.
- `rerun(id)` resets that job and descendants, retaining successful upstream jobs
  and all artifact files. Running local workers must be stopped first. Unknown
  external work cannot be rerun through this method.
- `resume_user(id)` resumes a settings/authentication/resource wait.
  `resume_external(id, true)` requires explicit user acknowledgement that the old
  remote request may still finish and a duplicate request may consume usage.
- `recover()` requeues interrupted local work, preserves terminal state, and marks
  every interrupted external request `external_unknown` without resending it.
  Unknown remote requests retain their external slot until user resolution, because
  the provider may still be processing them. They do not reserve a local worker's RAM.

`cache_key(prompt, input_hashes, options, provider_version, tool_version)` uses
SHA-256 over canonical JSON. Input order is meaningful; object property order is
not. It stores identity only and performs no automatic reuse. A new variation
must execute unless the user explicitly chooses an existing artifact.

## Verification

```powershell
cargo test -p asset-scheduler -- --nocapture
cargo run -p asset-scheduler --release --example queue_benchmark -- C:\masset\crates\scheduler\artifacts\benchmark-results.json
```

The benchmark executes real local SHA-256 work in admitted threads and reports
measured wall time, actual overlapping execution intervals, configured reservation
peaks, counted live input buffer capacities, and Windows process CPU/peak working
set when available. Serial and parallel workloads run in fresh, isolated native
processes so their memory peaks do not contaminate each other. Matching SHA-256
outputs and completion counts are required; no fixed speedup is assumed. It is
scheduler evidence, not a claim about provider or Blender throughput.
The benchmark uses in-memory SQLite to isolate CPU/admission measurements; it
does not measure disk queue throughput. The separate crash fixture uses disk/WAL.

`tests/durable_crash.rs` starts a real child and exits without Rust destructors
while SQLite has an uncommitted write. The parent verifies committed state/events,
external ids, original artifact bytes, rollback of incomplete writes, local recovery,
and no external resubmission. The ids in this fixture are local test data; no provider
is contacted and no provider cancellation is claimed.

Resource-transition tests race independent native SQLite connections, verify
event-write rollback, reject stale executions/oversized requests, and check local
cancellation holds, uncertain remote slots, and retries/recovery. The archive
fixture contains 3,000 terminal jobs (including a deep successful dependency
chain); real SQLite full-scan counters verify that normal admission does not scan
that history. FIFO, capacity, reference validation, original schema/user version,
and project-owned foreign-key rows remain covered.
