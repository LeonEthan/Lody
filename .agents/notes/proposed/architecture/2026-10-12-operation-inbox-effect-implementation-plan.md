# Asynchronous conversations: Inbox implementation plan

Status: proposed
Type: architecture
Translation: current

[中文](2026-10-12-operation-inbox-effect-implementation-plan.zh.md)

## Abstract

The user authorized the complete plan. This implementation includes the reverse-chat guard, durable result inbox, batching, Stop, actual submission/release, history display and read-only pagination. It adds no task/note tools or task graph. The kernel and main consumers are connected. Focused acceptance passed; outstanding repository checks and independent review are recorded separately from implementation, merge and release.

## 0. Current implementation scope

| Part | Implementation and acceptance entry |
| --- | --- |
| Reverse chat | Existing `REVERSE_CHAT_FORBIDDEN` and real MCP suites |
| Durable state | `inbox/sqlite.ts`; completion-transaction index, fixed intents/watermarks/members/input/release receipts |
| Effect kernel | `inbox/service.ts`; Service / Layer / Scope, coalesced signal, per-session admission and settlement recovery |
| Actual execution | `session-execution-service.ts`; synchronous prompt initiation, immutable execution ID, cancellation and retained resource recovery |
| Main consumers | Coordinator removes per-Delivery continuation; trusted UI/CLI receipts, Stop and preserved queue history |
| Display/read | One `operation_completion_batch`, stable history receipt, 64 KiB preview and 128 KiB pages |
| Acceptance | Owning suites, real legacy coordinator fixture, SQLite reopen/fault injection and static boundary guard |

## 1. Confirmed behavior

Result arrival only persists. Busy sessions queue results; normal completion and actual release flush one batch at the first boundary's fixed watermark. Empty boundaries, duplicate releases and results arriving after that boundary do not start additional execution. Stop persists pause before canceling; fresh human input carries saved results. Failed exits create no automatic intent; unresolved release also blocks fresh human execution.

**Human input accepted before Stop but not executed loses execution eligibility and retains its text/history. Recovery does not merge it into new instructions. Executing it requires a new send with a new input ID.** Fresh human input automatically carries only Operation results. A later queued human input does not invalidate the human input already being prepared; yielding applies to automatic batches. Clearing pause cannot revive a Stop-canceled execution.

Ordinary task chat may still start an idle session, but cannot clear durable pause. Role, userId and author are not recovery authorization. Tree Stop, archive, deletion and identity isolation retain vetoes. No wait-registration tool or continue button is introduced.

## 2. Independent Effect unit

Location: `apps/cli/src/orchestration/inbox/`. Use the consuming CLI's pinned Effect `4.0.2`; do not upgrade dependencies or replace existing SQLite, Zod or HistoryWriter frameworks.

| Part | Responsibility/dependencies |
| --- | --- |
| Pure rules | Exit causes, pause, input priority, eligibility and stable batches; ordinary functions without time or I/O |
| `OperationInbox` | Native composition of events, transactions, coalesced signals, claims, cancellation and settlement; abstract capabilities only |
| `InboxRepository` | SQLite transactions, pause revision, result index, batches and recovery; synchronous driver via Effect.try |
| `InboxExecution` | Session admission, one submission, exact cancellation and release receipt; no exposure of all SessionManager internals |
| History projection adapter | Display through bound Session backend/HistoryWriter for existing Loro and Roost |

Use `Context.Service`, `Layer.effect` and named Effect methods. One host-lease Scope owns a storage connection, subscriptions, coalesced signals and scoped fibers. Per-Session admission owns dispatch serialization. Signals only mean re-read durable state; result payloads do not live in a lossy memory event queue.

SQLite is real third-party I/O. Existing Session/history/ACP orchestration is unfinished Lody code: isolate it behind one explicitly named temporary execution adapter with real submission and cleanup ownership. Wrapping its Promise implementation does not finish migration. The kernel imports neither the old coordinator nor SessionManager, executes no internal `Effect.run*` and starts no detached promises/fibers.

Promise entries share one host-lease runtime through one registered `operationInboxLegacy` facade. Its consumers are coordinator completion events, execution/Stop/user-input hooks and daemon lifecycle. Delete it when those entries compose Effect natively; never create a runtime per call.

### Minimum interfaces and resource owners

- `completeAndIndex(tx, operationKey)`: insert the result index inside the existing Operation completion transaction. Post-commit notifications trigger reads, never index repair.
- `acceptHumanInput(receipt)`: an authenticated UI/CLI human entry registers unforgeable provenance, input ID, acceptance sequence, user, frozen configuration and original causal identity. Agent chat, results and system events cannot invoke this recovery entry. `role: user`, a human `userId`, history author and model parameters do not establish fresh human authorization.
- `pause(sessionId, expectedExecutionId)`: target the actual running execution, not the latest accepted input, using the admission protocol below.
- `executionReleased(executionId, receipt)`: report actual release and `normal | user_stop | failed`. Uncertain release returns an unreleased-resource recovery handle, never a normal-completion intent.
- `prepareInput(sessionId)`: choose waiting, user-plus-results or an automatic batch without bypassing the user queue.
- `settleBatch(batchId, receipt)`: durable settlement; retry settlement only, never submitted input.

The execution adapter returns three separate things. One Promise finishing cannot stand for all three:

| Receipt/handle | Meaning and owner |
| --- | --- |
| Submission `not_submitted` / `submitted` / `unknown` | Whether input reached transport; missing output is not non-submission. Batch storage retains the outcome and full Cause |
| Actual release receipt | Raw prompt, steer/config requests and associated processes/resources have ended; the execution slot may transfer. `InboxExecution` verifies this before publication |
| Unreleased-resource recovery handle | Execution ID, owner epoch, raw request handle, cleanup state and full Cause. A daemon-level recovery service owns the resources beyond Session closure |

Register resource ownership before starting requests. Cancellation requests cancellation; interrupted Effect waiting, an aborted signal or a closed Scope do not prove raw release. Adapter `shutdownOnce` memoizes one shutdown task and completion receipt; concurrent callers await that receipt instead of separately relying on `Scope.close`. Shutdown waiting is bounded: timeout/cleanup failure returns an unreleased handle, keeps the execution slot blocked and neither stalls global shutdown forever nor admits a successor.

The recovery service retries actual cleanup through independent `recover(handle)`, retaining the full failure Cause. Closing Scope again is not recovery. The daemon-root owner retains resources after Inbox/Session Scope exit and journals their recovery identity. After reopen, verify old processes/external requests have actually ended; uncertainty blocks that Session. Fresh human input clears message pause but cannot bypass unreleased resources. Until the temporary adapter implements these obligations, the kernel does not fully own cancellation and recovery.

## 3. Durable state, flow and integration

### Identity, pause and normal-completion intent

Isolate workspace/machine/Session/requester. Track separate `ownerEpoch`, `activeExecutionId`, `acceptedHumanSeq`, `pauseEpoch` and `active | paused | recovery_required`. Running execution and accepted-but-queued input are different identities. Queued input advances its acceptance sequence without replacing the running execution ID, so Stop targeting that execution remains valid.

Manual Stop shares a cancelId between RPC and durable fallback; duplicates cannot pause later input again. Internal cancellation uses the same admission gate without persisting a human message pause. Failed Stop persistence retains each pending request identity; repair them before accepting a fresh human input or closing the Scope. Stop records the current human acceptance sequence. Only fresh input accepted through the trusted entry afterward starts a new generation; previously queued input cannot impersonate recovery authorization. Archive, deletion, tree Stop and identity mismatch independently veto admission. Human input cannot clear tree Stop. Execution ownership, not UI idle or `finished/endedAt`, establishes release.

Record each execution's normal-release boundary once, with a unique isolation-identity-plus-`executionId` key. Its first transaction fixes the release receipt and queue sequence watermark. Create a pending dispatch intent in that transaction only when eligible results exist through that watermark; otherwise retain the boundary record alone. Repeated release returns that record and never snapshots again; retain even a zero-watermark boundary. Conflicting duplicate identity/receipt blocks recovery. Result arrival only stores data. Thus release of T at watermark eight, a later ninth result and redelivery of T cannot grant wake permission to item nine.

### Shared admission for Stop, human acceptance and actual submission

1. One valid host-lease owner holds a short per-Session admission gate. Stop, trusted human acceptance, scheduler handoff and final submission all use it. Route competing Workers' commands to this owner; separate local mutexes are insufficient. Invalid owner epoch forbids submission, and unconfirmed ownership transfer forbids enabling a replacement.
2. Prepare batches, publish history and finish asynchronous authorization checks before final admission. Inside the gate, a conditional transaction checks owner epoch, execution slot, human acceptance sequence, pause revision, input binding and batch claim together. Any change prevents the fence. Revocation of submission policy uses the same gate.
3. After committing the durable fence, retain the gate, **perform no further asynchronous checks and immediately invoke the real transport start primitive**, acquire its owned request handle, then release the gate. Do not hold a SQLite transaction across network waiting. Deferred queues, `onTurnStarted` and a Promise that calls the provider later are not actual start boundaries. Do not enable Inbox if the adapter cannot supply this boundary.
4. If Stop/human input completes admission first, the automatic batch fails conditional submission; human input takes the results through the transaction below. If submission wins admission, later Stop cancels that initiated execution and later human input queues. Submitted results cannot be withdrawn/replayed. A received click differs from durably accepted pause: do not acknowledge pause success while waiting for the gate.
5. Crash after fencing but before invocation is submission uncertainty, not evidence for resend. Only adapter evidence that transport was never invoked permits `not_submitted`. If pause persistence fails, immediately veto automatic admission in-process, attempt cancellation and report that Stop was not durably saved. Do not continue or acknowledge success; persist pause first when storage recovers. An uncommitted pause has no claimed power-loss guarantee.

Test barriers after the last check, after fence commit and before transport receipt. The post-fence barrier still holds the gate: competing Stop/human input cannot be acknowledged first and then allow the old submission. Asynchronous transport already initiated before receipt means submission won; Stop propagates cancellation while retaining submission state. Existing `onTurnStarted` is followed by asynchronous checks, so move/refactor that boundary; another recheck alone is insufficient.

### Transaction transitions

Batch membership is immutable. History projection is an idempotent stable-ID write outside the transaction and grants no dispatch permission. Enforce unique release records, intent-to-automatic-batch binding, human-input-to-submittable-batch binding, and at most one live claim per result. Superseded batches retain member history; only current claims/bindings grant eligibility. Automatic batches require `memberCount > 0`, consistent with actual membership; both batch creation and submission fencing validate this condition.

| Transition | Atomic write set and conditions |
| --- | --- |
| Operation completion → queued | Existing completion row plus idempotent result index; never depend on post-commit notification |
| First normal release → boundary record/pending intent | Require verified normal release and no existing record; atomically save the unique release record and fixed watermark. Create pending intent only with eligible results through that watermark; otherwise terminate here. Duplicates cannot resnapshot |
| Pending intent → prepared/settled_empty | Conditionally claim intent and query all eligible results through its watermark. Only nonempty results atomically create fixed batch/members, live claims and input binding. Empty results atomically settle intent as terminal settled_empty without batch/execution or reactivation. Pending human input prevents this automatic branch |
| Human input → prepared/original batch-free path | With results, bind trusted input receipt to a nonempty batch; without results, create no batch and retain the ordinary human-input path. Freeze original prompt/attachments/configuration |
| Unsubmitted automatic batch → yield to human | Require old batch still prepared; supersede old intent/batch, transfer all live claims, create new fixed membership and human-input binding in one transaction. Failure rolls everything back; never release and bind in separate transactions |
| Prepared → submitting | Under the shared gate, conditionally update owner/pause/acceptance sequence/execution identity/claim/binding, also verify automatic batch memberCount > 0, and persist unique submission token; immediately start transport afterward |
| Prepared → paused/invalid | Require no submission fence; invalidate intent/binding and release claims as passive queued data, with pause in the same transaction; do not restore automatic eligibility |
| Submitting → submitted/unknown | Persist receipt and retain non-resubmittable members. Unknown never returns to prepared/queued. Proven non-invocation records not_submitted for the recovery entry, without automatic replay |
| Submitted/unknown → settled | Update settlement/consumption and Cause only; duplicate settlement is idempotent and invokes no provider. Settled uncertainty is not confirmed model success |

Use `BEGIN IMMEDIATE` for claims. Automatic batches use their intent's saved watermark; human preparation snapshots the current watermark. The replacement batch may include newly available results; old membership history stays unchanged. Post-claim arrivals remain queued. History failure is pre-submission; uncertainty beyond the fence remains unknown and rebuilding history cannot restore submission eligibility.

### Causal depth and complete input

- **Automatic result continuation:** advance the maximum current-generation/member depth under existing chain rules; batching cannot reset the cap. Capped results remain readable without automatic execution.
- **Real fresh human input:** preserve its own causal identity and original depth. Old depths remain member provenance and cannot overwrite the new task. A depth-zero new task carrying a depth-15 result still delegates at depth zero. Explicitly redispatching old work retains that work's causal identity rather than evading the cap through data packaging.

Preserve each member's identity/time; do not mix requesters. Freeze original prompt, attachments, MCP/Role configuration; results form a separate data block. Automatic input uses valid current-generation configuration, never old Operation continuation prompts/configuration.

Any human input carrying a batch disables stale-ACP resend for the entire user-plus-results input. Provider receipt followed by disconnection persists unknown and cannot replay after reopen. Ordinary input without a batch keeps existing recovery behavior.

### History and size boundaries

Add shared `operation_completion_batch` history data. Automatic dispatch produces one system result message rather than N user messages. User-merged input preserves the original user entry with a batch reference/receipt, not an additional model turn or edited user text.

Retain a 64 KiB aggregate preview budget, complete membership and omission metadata. An oversized index supplies batch ID, count and bounded entries, with paged full index/content. It remains one logical full snapshot without dropping unseen members or splitting automatic execution.

Add read-only `lody_operation_batch_get({ batchId, cursor?, limit? })`, default 20 and maximum 50 items within the existing 128 KiB read-response bound. Identity comes from current Session context. IDs/cursors bind to requester; foreign lookup is indistinguishable from absence.

### Legacy handoff, versions and restart

The coordinator retains acceptance/materialization, target observation and UI progress, removing per-Delivery `continueSession`; indexing joins its existing completion transaction. Execution service supplies actual-start, cancellation and real-release boundaries above, preserving backend/history write owners.

Handoff order is mandatory:

1. Enter quiescing under shared admission, close legacy dispatch entries and durably invalidate the old Worker epoch. Do not enable the new scheduler yet.
2. Collect all in-flight legacy chains, requests past their fence and resource handles. Existing `coordinator.stop()` returning is not a drain receipt. Add an awaitable handoff adapter that drains or confirms termination and obtains actual release. New SQL conditions cannot revoke requests already past an old fence.
3. Unknown/unreleased legacy requests enter recovery and block new execution for that Session. Failed handoff enables neither partial scheduling nor per-result fallback.
4. Only after verified release commit the new owner epoch/Inbox mode and enable scheduling. Reject legacy Delivery admission without a valid new token as an additional defense, not a substitute for draining.

Companion tables hold state/intents/members/receipts without extending strict legacy rows. Never replay consumed/retired data; upgrade backlog is passive for fresh human input. Unknown legacy submissions never become new batches.

**Compatibility is fixed by actual protocols, without presenting a candidate as released:**

| Version/source | Inbox schema/capability | Host launch contract | Handoff/downgrade |
| --- | --- | --- | --- |
| This working tree, based on `3ac76bad10f46720517a2ca6929f03de4ef5bb9b` | Companion schema v1, `operationInbox: 1` | v2 | Current candidate; same-protocol owners require actual draining before handoff |
| Per-Delivery coordinator at that base | No Inbox admission | v1 | Unsupported downgrade; supported supervisor rejects before write ownership |
| Future versions | Must support schema v1 and Inbox v1 | Must support v2 | Host exit/drain still required; other protocol versions are rejected |

No released compatible SHA exists yet. Record the first merged/released revision when it exists rather than inventing a version. Real legacy-coordinator tests pause before/after the fence and during its original request. New ownership awaits both old-chain completion and physical release. SQL rejection is an extra defense, not a draining substitute. Arbitrary old binaries bypassing supported launch entries are outside compatibility guarantees.

Restart actively resumes existing pending dispatch checks without new completion events or human messages. Recover the fixed watermark only when the original normal-release receipt is verifiable, intent remains valid and submission is provably absent; recheck pause, identity, owner and human priority. A queue alone creates no intent; duplicate release never expands its watermark. Submitting without a reliable receipt becomes unknown; submitted/unknown only settle, never resend. Pause and unreleased resources remain blocking. Durable intent/claim/binding survive a crash and are conditionally reclaimed by the valid owner, never repaired by blindly deleting claims.

## 4. Implementation sequence and acceptance

| Stage | Deliverable | Gate | Status |
| --- | --- | --- | --- |
| A | Bilingual Spec, pure rules, transition table, adapter contracts and version matrix | Review implementable contracts; pin compatible SHA/schema; no extra recovery controls | Implemented; independent review pending |
| B | SQLite state/batches, native Effect kernel and test Layers | Actual state evidence for pause, revisions, batching, contention and reopen | Implemented; validation scope in implementation note |
| C | Main flow, actual-start/release adapter, input/history types and legacy draining | Admission races, unreleased resources and real legacy handoff pass; eight results in one input | Implemented; validation scope in implementation note |
| D | Upgrade/downgrade, real release, full checks and migration record | No dual scheduler, unknown replay or false native-completion claim | Implemented; validation scope in implementation note |

Review stages by dependency, but do not enable an unintegrated kernel in production. Pin current base/head before implementation and preserve unrelated work; this plan does not authorize automatic merge or release.

Independent acceptance covers these cases. Absence of new input must be observed at the execution adapter's actual receipt boundary, not merely counted in mocks.

| Group | Deterministic scenario and observable acceptance |
| --- | --- |
| Batch boundary | Eight busy arrivals produce no input; actual normal release yields one input with all eight identities/statuses; three of eight complete means three dispatch; post-claim ninth stays queued |
| Empty termination | Ordinary turn ends with an empty queue; eight results consumed then execution ends normally; empty boundary followed by a late result, duplicate release and reopen: each yields zero additional submissions. Retain the unique boundary, never an empty automatic batch. Empty claim settles intent as terminal settled_empty; batch-free human input retains its original path |
| Restart/event identity | Release at watermark eight, exit before dispatch, reopen without injecting any event: recover once. Late ninth plus duplicate release plus reopen never expands watermark. Queue alone never runs |
| Pause/trusted recovery | Late arrivals/reopen while paused do not run; fresh human input carries results once and later normal completion may batch. Agent chat with role user/human userId cannot clear pause. Failed pause persistence cannot acknowledge success or admit automatic work |
| Admission races | Gates after final check, fence commit and before transport receipt; Stop/human acceptance first rejects automatic submission. Post-fence gate cannot acknowledge Stop then submit. Start-first Stop cancels without replay. Stop targeting an old active execution remains valid after newer input queues |
| Human cause/configuration | Prompt/attachments/MCP/Role/identity unchanged. Human depth zero plus member depth 15 accepts new delegation; automatic continuation enforces maximum depth. Forged batch IDs/cursors fail |
| Atomicity/failure | Real SQLite and two Workers. Failure/interruption at each yield transaction write reopens with complete old or new binding, no dual/orphan live claims. Completion committed with lost notification still has its index. Duplicate settlement never resends |
| Unknown submission | Provider records full user-plus-batch input then disconnects; unknown persists and child-process reopen does not resend. Submitting crash without proof also never resends. Ordinary batch-free input retains recovery |
| Raw resource lifetime | Uncooperative raw request outlives cancelled waiter without admitting successor. Concurrent shutdown shares receipt. Failed cleanup retains Cause/owner; repeated Scope.close is not recovery. Independent recover releases before successor; timeout cannot stall global shutdown |
| Cutover/compatibility | Run real legacy coordinator gated before check, past fence and during raw request. Old stop returning does not enable new execution; drain/confirmed termination precedes handoff. Unknown old work blocks. Unsupported downgrade fails before write ownership |
| Reads/existing vetoes | Oversized preview retains all members and paged reads without extra model turns. Archive/deletion/tree Stop/identity mismatch veto dispatch |

Use native Effect test Layers, Deferred, injected clocks and fake timers. SQLite tests inspect rows, receipts, reopen and same-handle behavior. Execution tests observe received input and release state instead of mock call counts. No network, wall-clock sleeps or scheduler luck.

Complete CLI type/owning tests, root `pnpm check`/`pnpm format`, docs and required public-boundary checks. Prepare an isolated verification environment under repository rules if dependencies are missing, without upgrading pins. Record kernel, consumers and ownership separately in the [Effect ledger](2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger), retaining unfinished Session/ACP/history limitations.

## 5. Review focus and current evidence

Effect review examines whether the unit owns waiting/cancellation/recovery, whether the Session adapter hides unfinished orchestration, whether Stop/submission share a linearization point, whether raw work releases prematurely and whether at-most-once submission is being confused with exactly-once success.

Storage/execution review examines competing Workers, nontransactional history/SQL boundaries, partial migration, old-writer fences, user/batch races and cross-identity/configuration batching. Unsafe plans need a minimal counterexample and concrete correction; do not weaken the user's two rules to simplify implementation.

Current implementation and validation boundaries are in the [implementation note](../../implemented/architecture/2026-10-12-operation-inbox.md). Earlier library probes and reverse-chat tests are not Inbox acceptance.

## 6. Future ACP steer review trigger

If a common inbox for tasks, notes and results is introduced later, current consumption boundaries are normal completion or the next input starting, with no injection while busy. Starting an idle recipient with a task remains distinct from passive notes. Once ACP steer is fully supported by Lody endpoints and Agent adapters, remind maintainers to review batched delivery through steer during execution. Require actual application confirmation and pause, cancellation/cleanup, identity and unknown-delivery tests; a protocol declaration alone does not enable this policy. This is a maintenance note, not a current implementation step or scheduled reminder.
