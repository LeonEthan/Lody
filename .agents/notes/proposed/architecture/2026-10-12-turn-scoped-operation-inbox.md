# Asynchronous task results: storage, queues and dispatch

Status: proposed
Type: architecture
Translation: current

[中文](2026-10-12-turn-scoped-operation-inbox.zh.md)

## Abstract

Work delegated to other conversations can finish later. Save results first: queue them while busy, batch after normal completion and actual release, and never automatically continue after a user pause. New user input carries existing results in the same request and takes priority. This document explains the confirmed design direction, an eight-result example, an independent module and tests; implementation is pending.

## Current implementation scope

The user authorized full implementation: the inbox, durable Stop, batching, Effect kernel and main consumers are connected. This remains a design record awaiting review; see the [plan](2026-10-12-operation-inbox-effect-implementation-plan.md) and [implementation note](../../implemented/architecture/2026-10-12-operation-inbox.md) for evidence. Keep existing chat names and reverse-chat restrictions; add no note tool or task graph.

Pre-Stop queued human instructions retain history but lose execution eligibility. Recovery carries saved results only; executing an old instruction requires sending it again. Failed exits never auto-flush; uncertain physical release also blocks fresh human execution.

## Four terms

Suppose conversation A asks other conversations to check eight files.

- **Operation:** one asynchronous work request from A; its result may not exist yet.
- **Result queue:** completed results A has not processed. Success, failure and cancellation count; still-running tasks do not.
- **Turn:** one Agent execution from receiving input to finishing its answer or work. A user task can span multiple turns.
- **Dispatch:** supplying results to the model. Saving a result is not dispatching it.

Normal completion and user pause are different outcomes. While paused without new user input, results are stored only. A new user message starts a new execution generation and includes queued results; after that run completes normally, normal batching rules apply again. No user knowledge of Operations or additional control is required.

## 1. Six invariants

1. **Save first, decide execution separately.** Withholding dispatch must not lose results.
2. **Queue while busy.** Child results must not interrupt current user input.
3. **Pause disables automatic continuation.** Persist pause to disk. Late results, restart and a newly idle Session cannot clear it. A fresh user message starts a new generation carrying queued results.
4. **User input wins.** An automatic batch not yet submitted yields to new user input.
5. **Take all, deliver once.** At the chosen dispatch point, combine all eligible results into one message, rather than running the model once per result. Normal completion permits batching without an additional wait registration.
6. **Do not execute the same result twice.** Retries and restart retain its identity. Unknown post-submission receipt is retained as unknown, not automatically retried.

Results are reference material, not new user instructions. Acknowledgments must not create reverse tasks. Only fresh input from the human through a trusted UI/CLI entry grants recovery authorization. Agent chat displayed as user input in history cannot clear pause.

Fresh human tasks retain their own identity, configuration and causal depth. A depth-zero task carrying an old depth-15 result still delegates at depth zero; the old depth is provenance only. Automatic result continuation remains subject to the original maximum causal depth.

## 2. Basic behavior

| Event | Action |
| --- | --- |
| A sends an Operation | Record its identity, requester and owning user task; A need not keep waiting |
| A result returns | Persist it and add it to A's queue |
| A is busy | Queue only; do not call the model |
| Execution fails or physical release is uncertain | Save results and await fresh human input; uncertain release also blocks successors |
| A finishes normally | Wait for the old execution to release, then select input using the rules below |
| User pauses or interrupts | Revoke automatic permission before cancellation; retain the queue |
| User sends input | Run that input and attach the current queue when preparing it |
| Session archived/deleted or tree stopped | Retain results and obey existing execution prohibitions |

Pausing the main task does not undo child work. Stopping the whole task tree is a separate explicit action; completed results remain available.

## 3. Dispatch timing

**Result arrival only saves data; it grants no wake permission.** Dispatch occurs at normal completion and actual release, or when fresh user input starts. Normal completion fixes the queue watermark; results arriving afterward do not wake the idle conversation. Restart may recover a recorded, unsubmitted normal-completion intent, but scanning a queue cannot create a new wake. Recovery resumes this check without another event: even with no subsequent human message, previously authorized dispatch must complete. Each normal release records its watermark once; duplicate notification cannot add a late ninth result to the old batch. Record empty boundaries too, but create dispatch intent only when eligible results exist through the fixed watermark. If claiming finds none, atomically settle the intent without automatic execution. An automatic batch must contain at least one result.

Immediately before submitting input, choose in this order:

```text
Session execution prohibited? -> results remain records
Busy or not actually released? -> queue until actual old-execution release
Authorized fresh human input? -> one user call; attach results if any, otherwise original path
Paused by the user?      -> no automatic call; wait for the user
Normal-completion intent? -> results through fixed watermark; call only if nonempty, otherwise settle
Otherwise               -> remain idle
```

Attach result data without letting old results override the new request. Normal completion permits batching; user pause blocks it. The execution system records these outcomes explicitly, rather than sharing one idle flag or interpreting assistant prose. Existing archive, deletion and conversation-tree stop boundaries still apply.

### Example A: eight results queued while A is busy

Send nothing. After normal completion and actual execution release, take all eight and run once, without wait registration.

```text
A busy -> eight results queue -> normal completion -> one eight-item message -> one run
```

UI idleness is insufficient: an unfinished old request still blocks its successor.

### Example B: eight results queued when the user pauses

Keep all eight, with zero new model inputs. A ninth late result is also stored. Restart remains paused.

If the user asks for progress, supply that question with existing results and follow the new request, rather than first executing old results. This user message starts a new generation; normal dispatch rules apply after its normal completion, with no additional resume button.

### Example C: eight results queued and a new user message

Recommend **delivery with the user message**, rather than answering the user and starting another results-only run:

```text
One model input
  User request: Do not edit code; summarize the eight checks.
  Task results: identities, statuses and outputs for items 1...8.
```

Keep the sections structurally separate, with the user request authoritative. This avoids an extra run and acting on an outdated request before reading its replacement.

User input received while busy queues first. Snapshot the results when that input's execution is prepared. A ninth result arriving after the snapshot stays queued; it does not mutate the prepared input.

### Example D: eight expected, only three completed

Batch the three already available by default; batching does not mean waiting for all eight. The model can process these and report five unfinished tasks. A caller needing all eight retains that business condition; this change adds no wait-registration tool.

### Pause racing dispatch

Stop, human-input acceptance and actual request initiation share one short admission entry. If pause or human acceptance wins, the old automatic batch cannot submit: retain results or attach them to the new input. If initiation wins, later pause cancels that initiated execution without withdrawal or replay. A stale check cannot bridge durably saved pause and request initiation. Do not acknowledge pause success while its click waits for admission; failed persistence must be reported and veto automatic dispatch in-process.

Track running execution separately from accepted, queued input. Accepting new input cannot invalidate Stop against the still-running old execution. When raw requests ignore cancellation, an exited waiter or closed Scope is not release; recovery still owns unfinished resources until verified termination permits a successor. See [plan sections 2–3](2026-10-12-operation-inbox-effect-implementation-plan.md) for admission and resource contracts.

### Stale results

Consumed or uncertain delivery, deleted/archived Sessions, tree Stop and current pause prohibit automatic wake-up. A remaining deadline alone does not authorize dispatch. Preserve old result identity, provenance and time as data without replaying old prompts. Upgrade backlog without verifiable provenance waits for a new user message.

Batching after normal completion and waiting for user input after pause are this design's choices, not universal harness behavior.

## 4. Tests

Use a controlled test model for rules and real SQLite for persistence/restart, without live network or sleeps.

| Scenario | Observable result |
| --- | --- |
| Eight results arrive while busy | Eight retained results; no new model input |
| Ordinary turn ends with empty queue | Retain boundary without dispatchable intent; zero additional submissions |
| Eight results consumed, then normal completion with empty queue | No successor empty batch; zero additional submissions |
| Empty boundary, late result, duplicate release and reopen | Store the late result; original empty boundary never expands its watermark; zero additional submissions |
| Eight ready after normal completion | One input contains all eight identities and results, without wait registration |
| Pause before submission | No model input; eight results remain readable |
| Ninth arrival or restart after pause | Store only; no automatic execution |
| User asks for progress after pause | One user-plus-results input follows the new request; its normal completion permits later batching |
| New user input races an automatic batch | User wins before submission; no result loss or duplication |
| Ninth arrival after batch snapshot | Original batch unchanged; ninth remains queued |
| Ninth arrival after normal-completion boundary | Store only; do not wake the idle conversation |
| Restart finds an unsubmitted normal-completion intent without any new event | Actively recover the original watermark batch, recheck pause/user priority, and exclude later arrivals |
| Release at eight, late ninth, duplicate notification and reopen | Recover only the original eight; the ninth cannot wake the conversation |
| Fresh human depth zero carries an old depth-15 result | New delegation retains depth zero; automatic continuation respects the original maximum |
| Agent chat arrives while paused | It does not grant fresh-human recovery authorization |
| Competing Workers dispatch | No result executes twice |
| History persisted, submission unknown | Retain unknown state; no resend; manual handling remains possible |
| Result arrives after archive/deletion/tree Stop | Retain record; do not wake the Session |
| Execution fails | Save results without automatic intent; await fresh human input |
| Wait cancelled, concurrent shutdown or failed cleanup | Unfinished work retains owner/recovery handle; no successor before actual release |

Assert actual input, stored results and release state, not only mock call counts. Deferred gates control races, injected clocks and fake timers control time, and real file-database reopen checks durable state.

## Implementation appendix: independent Effect module

Call it `OperationInbox`: **what results exist, whether execution is permitted, and which batch to supply**. It does not depend on model providers, chat UI or history-storage internals.

| Part | Responsibility |
| --- | --- |
| Pure rules | Decide queuing, user priority, batching or execution prohibition |
| Effect service | Persistence, serialized scheduling, waiting, cancellation and recovery |
| SQLite adapter | Atomically persist pause, task identity, membership and submission state |
| Execution adapter | One delivery; report submitted/not-submitted/unknown and await real cleanup |

The main flow reports start, normal completion, user pause, fresh user input and failure/recovery. Use pinned Effect `4.0.2`, Service/Layer and Scope-owned fibers; tests replace storage and execution adapters. Wrapping the old `continueSession` Promise workflow is not a complete native migration. Delivery steps are in the [implementation plan](2026-10-12-operation-inbox-effect-implementation-plan.md).

Each batch has a fixed ID, one transaction and stable members. Oversized bodies retain a complete member index and paged content; they do not become eight model runs. Enabling this module disables legacy per-Operation continuation. Legacy backlog without trustworthy task identity is readable only; handoff drains or confirms termination of old requests rather than trusting coordinator.stop() returning. Supported downgrade requires the same handoff protocol; pin the SHA/schema matrix before implementation and reject incompatible versions before write ownership, without reviving legacy wakes. Update the existing [Session orchestration Spec](../../../../specs/session-orchestration.md) before implementation.

## Research and verification limits

Research date: 2026-10-12. Fixed source and existing tests were inspected; neither product's source tests were independently executed.

- **Codex MultiAgentV2:** official main `a9b0815...`, stable CLI `0.154.0`. Ordinary child results do not request a new turn. Input boundaries drain queued results; ordinary results after a final answer wait for another turn. This does not guarantee all queued results appear in the first request of every new user turn. [Completion](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/agent/control/completion.rs#L100-L128), [input queue](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/session/input_queue.rs#L205-L430), [no-restart-after-final-answer test](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/tests/suite/pending_input.rs#L1099-L1161).
- **OpenCode v2:** the branch linked by its website, fixed `4617210...`. Results enter a durable inbox, busy wakes coalesce and idle wakes may start execution. Interrupt lacks the proposed persistent pause; a new wake during cleanup may start a successor. Steer promotes multiple messages, queue promotes one; this is not an eight-item bundled input. [Completion](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/subagent-completion.ts#L18-L42), [run coordinator](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/run-coordinator.ts#L120-L178), [inbox promotion](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/inbox.ts#L496-L539).

Reuse separate storage/permission decisions and batch reading, without copying Stop semantics. The user finally confirmed: while busy, wait for normal completion and batch; after manual pause, do not dispatch automatically, and include results with fresh user input. Status remains proposed for independent design review. The module is connected; validation and outstanding checks are in the implementation note. The Spec is not approved.

The current behavior model, real SQLite, execution paths and Loro/Roost history verify this implementation. Earlier intermediate models and library probes are not current acceptance evidence. Reviewer gaps covering recovery, depth, admission, release, handoff and empty batches are included. See the [implementation note](../../implemented/architecture/2026-10-12-operation-inbox.md) for scope and evidence, and the [Effect ledger](2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger) for migration boundaries. Future ACP steer review conditions remain in plan section 6; active task/result steer is not enabled.
