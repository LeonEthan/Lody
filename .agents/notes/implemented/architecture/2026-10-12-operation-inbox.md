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
- Stop persists pause before cancellation. Pre-Stop queued inputs retain their history but lose execution eligibility; fresh human input carries result data, not canceled instructions. Human text, configuration and causal depth remain unchanged. Agent-authored tasks cannot clear pause.
- Stop, trusted human acceptance and actual transport start share admission. Unknown submission never replays, including user-plus-batch stale-ACP recovery; only settlement retries. Scope closure or canceled waiting does not prove resource release.
- B cannot chat back to A while A's exact Agent-authored input drives B. Single, batch and legacy paths reject before new work with `REVERSE_CHAT_FORBIDDEN`; subsequent independent input replaces that scope. This avoids a new task graph or task/note tools, but does not guarantee prevention of longer cycles or repeated outbound delegation.

The historical investigation did not identify a single change that made models send more reverse messages. [PR #1262](https://github.com/LodyAI/Lody/pull/1262) changed Agent-author display, not the ordinary execution prompt; reverting avatars was not supported as a fix. The pre-existing amplification paths were reverse task creation and per-Delivery continuation. Source inspection was not a controlled model replay.

The 2026-10-12 research borrowed durable queuing, separate admission and batched consumption from [Codex completion handling](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/agent/control/completion.rs) and [OpenCode's coordinator](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/run-coordinator.ts). Neither product's Stop semantics were adopted wholesale, and their test suites were not independently run.

## Ownership, recovery and compatibility

Effect remains locked at 4.0.2. `inbox/service.ts` owns the repository, signals and scoped fibers; `operationInboxLegacy` is the single registered host bridge. Whole Session/ACP/history migration remains unfinished, as recorded in the [Effect ledger](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger).

Review of `40ef5c29cbe496f28f17ab10297cf37c3c48030f` found three adapter defects, addressed by the following contracts:

1. Journal every resource acquisition before spawning, mark incomplete acquisition persistently, union later terminal/process roots, and retain all Session owners and the producing host PID. Reopen requires a complete resource set and proven disappearance. Missing identities, Windows and unproven release remain blocked; never signal a possibly reused PID.
2. Trusted renderer/non-delegated CLI sends persist `humanInputReceipts` before activation or queuing. History fallback restores matching authorization after lost or oversized RPC; generic history, foreign receipts and canceled/terminal inputs cannot clear pause.
3. Coordinator `recoverStop()` calls independent `recoverClose()` to repair durable settlement/release/pause writes. Preserve the original failed receipt and recovery owner; never replay transport or treat repeated Scope close as recovery.

Manual Stop shares its request ID between RPC and persistent fallback, preventing late duplicates from pausing fresh input. Failed writes retain request identities for repair. Consumed payload copies follow Operation retention; permanent Session deletion removes Inbox copies. Compatibility is Inbox schema/protocol v1 and host launch v2. Old per-Delivery binaries are unsupported downgrades; same-process handoff requires actual chain/resource draining. No compatible released SHA exists yet.

Stop request details now live in one replaceable `cancelRequest` control-document slot, rather than an extra metadata ID field. The renderer persists the payload before publishing `lastCanceledTurn = cancel-request:<id>`; RPC remains an immediate fast path with the same ID. The watcher waits for matching control data and processes control arrivals on its separate cancellation chain. Legacy turn-ID markers remain supported. SQLite owns durable deduplication, so reopen and late RPC/fallback cannot pause fresh input again, while a new click has an independent ID. Resource ownership, actual-release handoff and failed-pause recovery are unchanged; this adapter adjustment does not extend the native migration.

The Stop-storage adjustment passed 159 CLI tests, 97 send/meta-cache tests and 16 Shared schema/compatibility tests; the final SQLite-plus-CRDT reopen fixture passed its 58-test owning suite. Types, lint, format and six static guards passed in the pinned source copy. Root check still fails on the unchanged Git transport `context_unreadable` case; it is not a full-green or independent baseline claim. Docs retain the same 82-error array. These scopes overlap the earlier evidence below.

## Verification and remaining limits

Author validation used a separate source copy with pinned dependencies and matching changed-source bytes, not an independent base/head review. Counts overlap and must not be added.

| Scope | Latest recorded evidence |
| --- | --- |
| Owning CLI suites | 7 suites, 676 passed; batching, admission, SQLite/CRDT reopen, resource acquisition and coordinator recovery |
| Human send/configuration | 4 suites, 117 passed; persistent authorization, RPC loss and oversized input |
| Complete Shared/components | 1428/5141 passed |
| Types, lint, format, Inbox/process/platform/public/i18n guards | Passed; lint has no errors |
| Root check | CLI 4065 passed, 4 skipped, one unchanged Git transport failure: `context_unreadable`; no independent baseline reproduction. Final resource edits received focused reruns, not another full-root pass |
| Documentation check | 82 pre-existing errors, no Inbox errors; unchanged error array after consolidation |

Earlier `40ef5c29c` consumer evidence included RPC 124 and Electron 216 passed, with 3 existing RPC skips. Those runs and the narrow reverse-chat 75-test result do not certify the revised Inbox. Detailed intermediate test matrices remain in Git history rather than duplicate active documents.

Tests observe full provider inputs, durable rows and actual release with Deferred, injected clocks, fake timers and failure triggers. They cover eight-result batching, empty boundaries, late ninth results, event-free restart, paused/unknown non-replay, and a real legacy-coordinator fixture before/after its fence. Resource tests use real independent process groups with injected process-table snapshots. No live model, complete system process-table, desktop end-to-end, merge or release acceptance is claimed.

The revised candidate requires independent re-review; the Spec stays draft. Once all Lody endpoints and Agent adapters fully support ACP steer, reconsider batched delivery during execution with application, pause, cancellation and unknown-delivery tests. This is a future maintenance condition, not current behavior or a scheduled reminder.

[PR #1523](https://github.com/LodyAI/Lody/pull/1523).
