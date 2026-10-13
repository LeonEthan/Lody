# MCP Session orchestration

Root and `apps/cli/AGENTS.md` apply; `specs/session-orchestration.md` owns behavior.

- `operation-store.ts` is the shared machine-local WAL SQLite source of truth.
  The key is `(requesterSessionId, operationId)`; foreign Session lookup must be
  indistinguishable from absence. Operation finalization and Inbox result insertion
  are one transaction. Cleanup retains retired ids; accepting them again is forbidden.
  Result/system-Turn ids include both key parts; never
  derive a globally unique id from the Session-scoped `operationId` alone.
- Target input creation is fenced by the SQLite item-materialization claim.
  Acceptance owns new claims; the lease Worker only adopts absent/expired
  claims. Loro history evidence clears the claim. Before an adopted claim may
  treat a missing fixed Turn as permission to write, confirm authority: cloud
  requires remote Streams catch-up (local transport sync is insufficient); OSS
  uses the daemon repo that owns every MCP write. A failed confirmation is
  uncertainty and arms the same owned bounded-backoff wake as a materializer
  error; unrelated SQLite/Meta watch hints must not be the only retry path, and
  every retry rechecks the fixed user Turn id first.
- Successful item completion copies only visible assistant text into an 8 KiB
  `output` preview. The store may further head/tail-bound it to keep the whole
  completion at 64 KiB; preserve both per-output and aggregate omission metadata.
- Operation files contain prompts and assistant output; keep them private to the
  local account (0700/0600 on Unix).
- Create Operations freeze each target's effective dispatch config at
  acceptance; recovery must not re-read mutable requester history defaults.
  Full content stays in the target Session history.
- Accepted Operations freeze `requesterUserId` and exact `sourceTurnId`; `requesterSessionId` names
  the source Session. Recovery uses that user for attribution/authorization and the current owner
  Machine credential to execute. Completion preserves userId. Matching includes both ids, kind,
  and fingerprint; reuse from another Turn is `OPERATION_ID_REUSED`, not a retry.
  Author/attachment snapshots in `operation_authors` / `operation_inputs` freeze atomically.
  Missing authors retain frozen Session/Turn provenance, never human identity.
- `operation-coordinator.ts` is owned only by the local Host-lease Worker. MCP
  subprocesses may accept Operations but never schedule completion Turns.
- Reconciliation is level-checked. Loro subscriptions and SQLite directory
  watch events are hints; startup/lease acquisition scans active Operations and
  durable Inbox intents and unsettled progress once. The watcher never carries result data.
- The coordinator holds ONE store connection from start to stop. Watch wakes are
  leading-edge coalesced; never do store work per raw fs event.
- The MCP server holds ONE lazy store connection with `maintenance: false`.
  Current-schema detection is read-only; migration locks only when needed.
  The daemon owns open-time repair/cleanup. Never reopen per call.
  See [connection and notification rationale](README.md).
- WAL allows one writer machine-wide. Every writing store transaction runs
  `BEGIN IMMEDIATE`. Subprocess
  boundaries wrap store calls in `runWithOperationStoreBusyRetry` (bounded
  async backoff; exhausted retries surface as retryable `STORE_BUSY`). Daemon
  paths must not add blocking waits on top of the driver's `busy_timeout`.
- `operation-model.ts` is the reduced executable race model. Update its bounded
  exploration and concrete traces whenever scheduling semantics change.
- Inbox result arrival only persists. Automatic dispatch requires a unique normal-release
  boundary with fixed watermark and nonempty eligible members; empty and duplicate boundaries
  never resnapshot or wake. Late results wait for fresh input or another normal boundary.
- `inbox/service.ts` is native Effect v4. Scope owns its signal/fibers and repository connection;
  one per-Session admission covers Stop, trusted human acceptance and actual transport start.
  Only `inbox/legacy.ts` creates the registered host runtime; the kernel never imports consumers.
- Stop persists pause and cancels pre-Stop queued input eligibility while retaining history.
  Only trusted fresh human receipts clear pause; role/userId/author are insufficient. New human
  acceptance cannot revive a canceled execution or discard an already prepared human input.
- Fixed batch claims and submission fence precede synchronous transport initiation under the
  same gate, without an await between them. Post-fence uncertainty never replays, including
  human-plus-batch stale-ACP recovery. Retry failed settlement only, never the request.
- Physical request/resource release differs from waiter exit and Scope close. Keep immutable
  execution IDs, shared close receipts, full Cause and retained recovery owners. Unknown
  release blocks successors. Independent recovery must prove release before clearing that slot.
  Persist acquisition-incomplete before every sandbox spawn, then union all spawned roots for
  every Session owned by the execution. Only explicitly complete identities can prove restart
  release; legacy snapshots and interrupted journaling remain blocked. Coordinator recovery
  calls `recoverClose`, not the cached failed `close` receipt; never replay transport.
- Schema/Inbox v2 drops old-only stores, Delivery data/APIs and unused compatibility results.
  Keep current pause/unknown/resource evidence and monotonic sequences. Host v3 rejects old
  workers before storage; end the prior Worker before handoff. Passive results are not busy.
- Create Operations may also maintain one stable `role: system` `operation_progress`
  Turn in the requester Session, written only by the Host-lease Worker, never by MCP
  replicas. It is durable UI state, never agent input/dispatch. Merge duplicate rows through
  HistoryWriter without raw alias writes. Publish cards only from materialized Session/UserTurn evidence or an existing
  target, and merge status monotonically by exact target.
  Progress failures must not fail acceptance, materialization, cancellation, finalization,
  result persistence, or target cancellation. Set `progressMessageId` only when the row covers every durable
  target and successful result; otherwise retain completion fallback cards. Root cancellation,
  errors, and deadlines do not terminate targets. Result consumption does not end reconciliation:
  retain it through target terminal state and local Loro flush, and preserve it through SQLite
  cleanup/restart. Missing evidence or writes retain an owned retry and never wake the agent.
  Unchanged progress must return before `updateHistory` / `Mirror.setState`: Mirror notifies
  even for unchanged state, so nested A -> B -> C progress writes otherwise wake their own
  coordinator forever. Test this with real Mirror subscriptions.
- Missing Session metadata, a recoverable tombstone, or an unsynchronized
  Machine Flock document is uncertainty, not permanent deletion/configuration
  absence. Keep the item/result pending until positive evidence or deadline.
- Deadlines finish the root with item `TARGET_TIMEOUT` results but never cancel
  target Turns. Operation cancel is the only best-effort remote-cancel path.
- Store paths are keyed strictly by an explicit machineId
  (`getLodyOperationStorePath` has no default): the MCP server resolves it from
  the session context, never from its own process environment. The former
  env/`'local'` fallback let the daemon-hosted HTTP transport (whose process
  has no `LODY_MCP_MACHINE_ID`) silently write Operations into a store no
  coordinator reconciles, so completions were never delivered.
- `session_create_many` and `session_chat_many` target writes bypass cooperative
  Session/Turn quotas. Preserve the bypass in both MCP-process materialization
  and daemon recovery replay; otherwise quota rejection degrades into a false
  `TARGET_TIMEOUT`.
- Tests use injected clocks and explicit reconciliation/idle barriers. Do not
  add polling sleeps or wall-clock races.
