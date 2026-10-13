# Native Effect result inbox

Status: implemented
Type: architecture
Translation: current

[中文](2026-10-12-operation-inbox.zh.md)

## Abstract

Completed results persist first; actual normal release batches a fixed watermark, while Stop defers handling until fresh human input. An independent Effect kernel owns SQLite intents, membership, admission and settlement. Main execution supplies actual prompt initiation and release. Per-Delivery continuation is removed; task chat and result data retain different start permissions. Implementation, independent review, complete acceptance and release are separate; earlier reverse-chat tests are not Inbox acceptance.

## Decision and boundary

Pre-Stop queued human inputs lose execution eligibility and retain text; fresh input carries results only. Admission covers the fence and transport initiation, and persistent active-input binding prevents fresh human acceptance from reviving canceled execution. Automatic batches yield to human input; an already preparing human input survives later queued input. Applied human steer changes input ownership while preserving immutable execution identity.

`inbox/service.ts` uses Effect 4.0.2 primitives; Scope owns its connection, signal and fibers. `operationInboxLegacy` is the single registered host runtime for Promise coordinator, human/Stop/submission/release consumers. Whole Session, ACP and history migration remains unfinished. The temporary adapter retains raw requests, failures and independent recovery; wrapping them does not complete their migration. A static guard separates the kernel from legacy consumers.

POSIX reopen recovery requires nonempty process-root identity and proven absence of roots/groups; it never signals potentially reused PIDs. Windows, empty identities or unprovable resources remain blocked. Unknown submission only settles and never replays. Oversized individual members remain fully readable through fragments. Compatibility is Inbox v1; older per-Delivery binaries are unsupported downgrades. Host exit fences upgrade; the same-process legacy adapter must drain old chains and physical resources.

Review of `40ef5c29cbe496f28f17ab10297cf37c3c48030f` found three adapter handoff defects. The revision continuously journals every sandbox acquisition, marking identity incomplete before spawn and unioning later terminal roots. Execution retains all Session owners and the producing host PID; absence of initial ACP roots alone cannot prove a closed resource set. Missing completeness and interrupted journaling remain blocked. Trusted renderer/non-delegated CLI sends persist a separate control-document `humanInputReceipts` outbox before activation/queue. Matching history dispatch restores authorization without RPC, while Agent/generic history writes, foreign receipts and canceled/terminal IDs cannot clear pause. Coordinator `recoverStop` calls independent `recoverClose` to retry retained durable receipts, preserving the original failure and never resending transport.

## Validation and delivery status

Base: `3ac76bad10f46720517a2ca6929f03de4ef5bb9b`. This implementation is a PR candidate, not merged or released. Verification used an isolated source copy with pinned dependencies; the final comparison found matching changed-source bytes. Effect remains 4.0.2; catalog and lockfile were not upgraded.

The following table preserves the initial `40ef5c29c` authoring evidence. Revision results are separate below.

| Scope | Result |
| --- | --- |
| Inbox, current/compatibility models, coordinator, edit/resend, MCP, history and local platform | 11 suites, 201 passed |
| Execution, Watcher, Fleet, SessionManager, sandbox and credential ownership | 6 suites, 400 passed |
| Final pending-Stop recovery and Watcher changes | 5 suites, 396 passed; failed pause repair, multiple Stop identities, shared admission, raw requests and close recovery |
| Native Roost backend contract | 31 passed; targeted batch status, unchanged human input, duplicate idempotency and reopen |
| Complete Shared/RPC/components/Electron consumers | 1428/124/5139/216 passed; RPC retains 3 existing skips |
| Types, lint, format, native Inbox/process/platform/public boundaries and i18n | Passed; no lint errors |
| Root `pnpm check` | Failed: CLI 4055 passed, 4 skipped; one unchanged Git transport case failed with `context_unreadable`. Later pause/Watcher edits received the focused reruns above, not a claim of final full-tree green |
| Actual working-tree docs status/check | 82 existing errors, no Inbox-file errors; not document approval |

Revision-specific regression: 7 owning CLI suites, 676 passed; 4 human-send/configuration suites, 117 passed. Coverage includes real independent process groups with SQLite reopen and injected process-table snapshots, concurrent acquisition fences, producing-host presence, actual execution adapter journaling, incomplete acquisition after prompt completion, retryable release persistence, fresh verified resource generations, durable user receipts after CRDT reopen (valid/absent/foreign/canceled), RPC loss/oversized send, and coordinator-level settlement outage/recovery without transport replay. These counts overlap the earlier matrix and are not additive.

The revision's complete Shared/components suites passed 1428/5141 tests. Complete typecheck, final CLI typecheck, lint (zero errors), format and Inbox/process/platform/public/i18n guards passed. Re-running root `pnpm check` reached CLI 4065 passed/4 skipped with the same unchanged Git transport `context_unreadable` failure; final acquisition/cleanup guards and fixture changes received the 676-test intersection, final types/lint/format and source-byte comparison, not another full-root green claim. Docs check retains the exact same 82-error array as `40ef5c29c`, without Inbox errors. No real-model, full-system-process-table or desktop end-to-end acceptance is claimed.

Tests observe full received input, durable rows, fault triggers, Deferred, injected clocks and fake timers without live network or sleeps. OS children recover the fixed eight-member intent without a new event, exclude the late ninth, and leave paused/cross-fence unknown work passive. The actual legacy coordinator fixture matches the base bytes after relative-import relocation; before/after-fence cases still require old-chain completion and actual release after old stop returns. Tests do not call real models.

Manual Stop shares its cancelId across RPC and durable fallback. Failed persistence retains each request identity and repairs it before fresh human acceptance. Internal cancellation revokes execution without persisting a human message pause. Consumed payload copies follow Operation retention; permanent Session deletion also removes Inbox copies. Reopen repairs history receipts without replaying transport.

The reviewed `40ef5c29c` had three P1 findings; the revised candidate still requires independent re-review. Human Spec approval, real-model and desktop end-to-end product acceptance remain outstanding. Windows, missing POSIX identity or unproven release remain blocked even after fresh input. Whole Session/ACP/history native migration is not claimed.

[Design](../../proposed/architecture/2026-10-12-turn-scoped-operation-inbox.md), [implementation plan](../../proposed/architecture/2026-10-12-operation-inbox-effect-implementation-plan.md), [Spec](../../../../specs/session-orchestration.md).
