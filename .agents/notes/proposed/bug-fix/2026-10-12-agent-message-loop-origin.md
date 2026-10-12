# Distinguish message identity changes from collaboration loops

Status: proposed
Translation: current

[中文](2026-10-12-agent-message-loop-origin.zh.md)

## Abstract

Agent avatars appeared near reports of reverse messages and sessions repeatedly resuming. History identifies the avatar change precisely, but does not establish that it introduced the loop. The message already used a user-input row before that change, and its normal execution prompt did not gain sender instructions. The orchestration boundary still permits reverse tasks and gives each completed Operation a separate continuation after the requester becomes idle. A fix should address those semantics; reverting author presentation alone has no demonstrated effect on model execution.

## Scope and evidence

Source baseline: `3ac76bad10f46720517a2ca6929f03de4ef5bb9b`; history window: 2026-09-20 through 2026-10-12. This note contains public source evidence only, without captured conversations or internal task records. No production code or model behavior was changed or experimentally replayed.

| Candidate | Verified change | Causal limit |
| --- | --- | --- |
| [#1262](https://github.com/LodyAI/Lody/pull/1262), `0c10ae2b7`, Leon Zhao, October 5 21:43 UTC+8 | Frozen Agent authors and Role avatars replace human sender presentation. Structured history exports include `author`. | Parent revision already writes `role: 'user'` and renders a user row. Normal ACP input does not consume author metadata. Completion stays system-authored. |
| [#1334](https://github.com/LodyAI/Lody/pull/1334), `811b57332`, October 8 | Execute accepted Config/Role/task text consistently on continue, steer and restore. | Can change effective instructions when composed and raw text differ; must compare the actual accepted input, rather than infer causality from an empty Role prefix alone. |
| `8305406d6`, September 30 | Codex runtime 0.156.0 to 0.159.2. | Runtime/model behavior may differ; a version change alone does not establish a new reverse-message instruction. |
| [#1422](https://github.com/LodyAI/Lody/pull/1422), `45753fe61`, October 11 | Avoid resubmitting completion input after a disconnected transport; retain retired Operation keys. | Prevents duplicate submission of one identity, not distinct new Operations. |
| [#1428](https://github.com/LodyAI/Lody/pull/1428), `9d9963d49`, October 11 | Add collaboration guidance, a smaller depth bound and tree-stop barriers. | Historical runtime tool definitions must be checked separately from merge status; prompt guidance is not a reverse-target admission rule. |

For #1262, inspect its parent `apps/cli/src/commands/session.ts` at `appendUserPromptHistory` and `packages/components/src/components/ai-gui/view.tsx` at `UserMessageRowView`. Its coordinator diff adds only a system author. Its new Role snapshot contains id, revision, name and emoji, not a prompt. The history-tool author field is a genuine model-visible difference only when the model reads that history; it is not automatically included in execution text.

The Codex adapter range `51a07eeb9..b67f2eaab63247159c8cbdbd4075334f69729daf` was also inspected from the public submodule. Changes cover diagnostics, explicit `/plan` input, startup model selection and title handling. It adds no ordinary delegation sender/parent instructions or reverse-message policy. Correcting startup model selection remains a possible behavioral confounder, requiring actual before/after model evidence.

## Existing amplification paths

- [`session_chat`](../../../../apps/cli/src/mcp/lody-mcp-server.ts) creates durable work. The target-difference check prevents self-send; it does not reject sending to the driving task's sender. Repeated calls in one turn share its depth, so a depth ceiling does not bound their count.
- [`deliverIfRunnable`](../../../../apps/cli/src/orchestration/operation-coordinator.ts) waits for no active turn and no pending user dispatch, then calls `continueSession` separately for each eligible Delivery. The original source turn need not remain open. These idle gates predate the history window.
- Delivery expiry uses `deadlineAt + 8h`, not `finishedAt + 8h`. With the default 24-hour deadline, an early result can remain eligible close to 32 hours after acceptance.
- Operation identity deduplication does not merge semantically redundant messages with different ids. Human authorization, UI author, model input and continuation eligibility are different contracts.

Thus both a new reverse task and a later automatic result can resume work. This explains a feedback mechanism, not the date on which a particular model first began using it frequently.

## Evidence interpretation and follow-up

Do not equate `consumed_at` with successful model execution: a Delivery can settle without submission. Check execution phase, attempt count, terminal reason, provider submission and the actual native input separately. Likewise a provider prompt-start trace does not prove successful model consumption.

The [message-author decision](../../implemented/architecture/2026-10-05-message-author-identity.md) remains valid; this investigation does not reverse its presentation choice. The [frozen-input decision](../../implemented/architecture/2026-10-08-frozen-turn-execution-input.md) explains why actual text comparison matters. Any fix needs an explicit decision about reverse requests, passive progress, result batching and the lifetime of permission to resume a requester. Those behavior changes require review of the existing [orchestration Spec](../../../../specs/session-orchestration.md), not a speculative avatar rollback.

No individual introduction commit for increased model back-messaging has been established. Historical diff analysis and input inspection do not substitute for a controlled model-behavior experiment.
