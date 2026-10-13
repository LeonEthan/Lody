# Operation result inbox and reverse-chat containment

Status: implemented
Type: architecture
Translation: current

[中文](2026-10-12-operation-inbox.zh.md)

## Abstract

Per-result continuations and reverse task chat could repeatedly restart conversations. Results now persist without waking an idle Session; confirmed normal release delivers one fixed, nonempty batch, while Stop defers results until fresh human input. A native Effect kernel owns durable scheduling and admission, with an explicitly temporary Session/ACP adapter. This PR candidate is implemented, but independent re-review, Spec approval and model/desktop acceptance remain outstanding.

## Decision and rationale

The [Session orchestration Spec](../../../../specs/session-orchestration.md) owns behavior; the [orchestration README](../../../../apps/cli/src/orchestration/README.md#completion-consumption) owns implementation and transaction contracts. This record consolidates the former investigation, reverse-chat note, design and implementation plan; their earlier revisions remain in Git history.

- Result arrival grants no execution permission. Actual normal release records one immutable watermark, including empty boundaries; only eligible, nonempty membership grants an automatic intent. Restart recovers that intent without a new event. Late results and duplicate releases cannot enlarge it.
- Inbox-aware Stop persists pause before cancellation. Pre-Stop queued inputs retain their history but lose execution eligibility; fresh human input carries result data, not canceled instructions. Human text, configuration and causal depth remain unchanged. Agent-authored tasks cannot clear pause.
- Stop, trusted human acceptance and actual transport start share admission. Unknown submission never replays, including user-plus-batch stale-ACP recovery; only settlement retries. Scope closure or canceled waiting does not prove resource release.
- B cannot chat back to A while A's exact Agent-authored input drives B. Single, batch and legacy paths reject before new work with `REVERSE_CHAT_FORBIDDEN`; subsequent independent input replaces that scope. This avoids a new task graph or task/note tools, but does not guarantee prevention of longer cycles or repeated outbound delegation.

The historical investigation did not identify a single change that made models send more reverse messages. [PR #1262](https://github.com/LodyAI/Lody/pull/1262) changed Agent-author display, not the ordinary execution prompt; reverting avatars was not supported as a fix. The pre-existing amplification paths were reverse task creation and per-Delivery continuation. Source inspection was not a controlled model replay.

The 2026-10-12 research borrowed durable queuing, separate admission and batched consumption from [Codex completion handling](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/agent/control/completion.rs) and [OpenCode's coordinator](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/run-coordinator.ts). Neither product's Stop semantics were adopted wholesale, and their test suites were not independently run.

## Ownership, recovery and compatibility

Effect remains locked at 4.0.2. `inbox/service.ts` owns the repository, signals and scoped fibers; `operationInboxLegacy` bridges Session input; `operation-coordinator.ts` and `workspace-cleanup-legacy.ts` are registered application entries. Platform Session resource observers bridge acquisition callbacks synchronously before spawn. Whole Session/ACP/history migration remains unfinished, as recorded in the [Effect ledger](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger).

Review of `40ef5c29cbe496f28f17ab10297cf37c3c48030f` found three adapter defects, addressed by the following contracts:

1. Journal every resource acquisition before spawning, mark incomplete acquisition persistently, union later terminal/process roots, and retain all Session owners and the producing host PID. Reopen requires a complete resource set and proven disappearance. Missing identities, Windows and unproven release remain blocked; never signal a possibly reused PID.
2. Trusted renderer/non-delegated CLI sends persist `humanInputReceipts` before activation or queuing. History fallback restores matching authorization after lost or oversized RPC; generic history, foreign receipts and canceled/terminal inputs cannot clear pause.
3. Coordinator `recoverStop()` calls independent `recoverClose()` to repair durable settlement/release/pause writes. Preserve the original failed receipt and recovery owner; never replay transport or treat repeated Scope close as recovery.

Manual Stop shares its request ID between RPC and persistent fallback, preventing late duplicates from pausing fresh input. Failed writes retain request identities for repair. Consumed payload copies follow Operation retention; permanent Session deletion removes Inbox copies. The final storage boundary is schema/Inbox protocol v2 and host launch v3. Upgrade preserves released Operations, author/input snapshots, recovery state and retired IDs; only Delivery tables and unused compatibility result copies are removed. Legacy completion backlog is never imported or replayed. Current Inbox pause, unknown submission and resource ownership remain. Completion indexes directly into Inbox; old tables, per-result claims/continuations, models and coordinator fixture are removed. Persistent result sequences cannot be reused after retention cleanup, and passive results no longer imply busy execution. `inbox/legacy.ts` only bridges current unfinished Session/ACP consumers; batch-member display format remains. Inbox has not shipped, but Operation tables have: those compatibility boundaries must not be conflated.

Source provenance is separate from display snapshots. A retained current Operation with no author snapshot but a saved `sourceTurnId` reads as minimal Agent provenance from its frozen requester Session/source Turn, using the generic `Agent` label without Role/model/catalog reconstruction. Create/chat reject delegated input without source identity before publication; ordinary human entry points remain human-authored. Reverse checks use the exact input’s Agent Session, never parent relationships. This preserves existing Operations and does not rewrite history.

Stop request details now live in one replaceable `cancelRequest` control-document slot, rather than an extra metadata ID field. The renderer persists the payload before publishing `lastCanceledTurn = cancel-request:<id>`; RPC remains an immediate fast path with the same ID. The watcher waits for matching control data and processes control arrivals on its separate cancellation chain. Legacy turn-ID markers remain supported. SQLite owns durable deduplication, so reopen and late RPC/fallback cannot pause fresh input again, while a new click has an independent ID. Resource ownership, actual-release handoff and failed-pause recovery are unchanged; this adapter adjustment does not extend the native migration.

Integration with main `09407b3b7` preserves raw ACP drain → presence clear → Turn/Inbox handoff. Presence cleanup failure retains the old execution owner. Daemon shutdown cancels history-owned work and drains/recover-closes Inbox. Merged dependency pins remain unchanged, including Streams 0.17.0 and Effect 4.0.2. Capability registration retains Inbox v2 alongside main’s new Magpie/DSH capabilities.

## Native orchestration unit

Coordinator reconciliation, coalesced wake tickets and retry fibers now run as native
Effect workflows; the application facade only composes and hands off owners. Pure
rules are separate from platform effects. Static checks forbid direct SQL, Session,
process, Promise-workflow and runtime access from the native core. A scoped SQLite
Service owns the shared Operation/Inbox connection. Semantic transactions are
synchronous and reject Effect/Promise returns. The memory Layer uses the same real
implementation and remains effectful. Unused session configuration I/O is removed
without changing the schema.

ExecutionOwner contains input, batch, resources and raw requests, and owns submission,
settlement, actual release and independent recovery. Session no longer accesses Inbox
SQL. A native close owner retains shared failed receipts and full Cause; recovery only
retries settlement. Fleet startup failure and normal stop share a phased owner, and
production automatic retry recovers that owner before replacement. Session/ACP/history
remain registered temporary adapters; this does not complete their dependency chains.

Agent-initiated turns suppress user-facing completion notices. Finalization reads the
exact completed invocation's input author, including steer handoffs, rather than
parent relationships or older input. Operation receipts, Inbox results, finalization
and release retain their behavior. Stop is rechecked after the author read. The
execution suite passes 256 tests, including Agent suppression, later human delivery
and completed history/release in both cases.

Upgrade review identified destructive Operation migration, unsupported Stop fields sent
to released CLIs, and persistent pause that old clients could never resume. The fix
retains Operations, duplicate guards, author snapshots and recovery state; removes
only Delivery scheduling data; negotiates Inbox v2 before sending new Stop fields;
and treats identity-free legacy Stop as ordinary execution cancellation without
persistent Inbox pause. This avoids inferring human authority from missing receipts,
role or author. Updated clients retain the persistent-pause contract. New tests use
real SQLite upgrade/completion, React Stop publication and the Session/Inbox boundary
for the next legacy message after Stop.

Upgrade validation: 4 CLI suites / 487 tests and 79 component tests pass. All three targeted cases fail against reviewed `552c349` source in the isolated copy and pass after restoring the fix. CLI Stop also tests released strict parsing and Inbox v2 pause / Operation cancellation fields. No full-machine upgrade or old-desktop-binary end-to-end acceptance is claimed.

The native orchestration cleanup removes the Effect.exit / thrown exception / Cause
restoration round trip from ordinary steps. Only deadline, materialization retry and
best-effort progress boundaries handle failure; interruption propagates. Immutable
store aliases and identity comparisons are removed, while activity/epoch checks remain.
The Legacy facade no longer exposes begin/prepare/submit/settle/adopt. ExecutionOwner.submit
records the submitted receipt, replacing Session's manual settlement. Queries use an
ordinary Effect-valued port instead of an unused Context.Service/Layer. Shared close
receipts, actual release, independent recovery and durable admission remain intact.

The changed intersection passes 4 suites / 339 tests, including seven native Cause /
real SQLite state cases for combined failures, deadline settlement, progress downgrade
and interruption. Shared-close failure/recovery tests now use the production execution
owner and still assert original receipts and non-replay. Counts overlap earlier evidence;
upstream Session/ACP/history migration completion is not expanded.

## Verification and remaining limits

Author validation now includes installation and checks in the actual author worktree: Node 24.21.0, pnpm 10.20.0 and locked Effect 4.0.2. `pnpm install --frozen-lockfile` succeeds without changing the lockfile. The install guard permits this checkout; the earlier assumption that it was a nested workspace was incorrect. Earlier isolated-copy results remain historical evidence, not an independent base/head review. Overlapping scopes must not be added.

| Scope | Current implementation evidence |
| --- | --- |
| Author-worktree intersection | 7 suites, 569 passed: Coordinator, progress feedback, Inbox, execution service, Operation store, Session commands and dispatch watcher |
| Admission ablation | Earlier isolated-copy tests fail at both deterministic competition positions when the submission lock is removed, and pass when restored; unknown-submission non-replay assertions retained |
| SQLite / ownership | Shared in-memory completion transaction, rollback and asynchronous-callback rejection; disk reopen, actual release and shared-close recovery behavior retained |
| Types / static / format | Author-worktree root type checks, lint, format and check:quick pass; native core boundaries checked |
| pnpm check | Author-worktree run is not green: types and lint pass; CLI reports 4106 passed, 4 skipped and one Git transport failure (`context_unreadable` / remote helper aborted). Both transport source and test are unchanged from main. No independent baseline reproduction; recursive termination prevents a full-root test acceptance claim |
| Documentation | Author docs check passes; earlier 82 broken-link errors are historical (the previously absent submodule source files are now present) |

Tests observe full provider inputs, durable rows and actual release with Deferred, injected clocks, fake timers and failure triggers. They cover eight-result batching, empty boundaries, late ninth results, event-free restart, paused/unknown non-replay, and current scheduler ownership/resource release. Earlier legacy-fixture handoff tests were retired with their contract and are not v2 acceptance. Resource tests use real independent process groups with injected process-table snapshots. No live model, complete system process-table, desktop end-to-end, merge or release acceptance is claimed.

The revised candidate requires independent re-review; the Spec stays draft. Once all Lody endpoints and Agent adapters fully support ACP steer, reconsider batched delivery during execution with application, pause, cancellation and unknown-delivery tests. This is a future maintenance condition, not current behavior or a scheduled reminder.

[PR #1523](https://github.com/LodyAI/Lody/pull/1523).
