# Reject chats back to the current turn's sender

Status: implemented
Type: bug-fix
Translation: current

[中文](2026-10-12-turn-scoped-reverse-chat.zh.md)

## Abstract

Two independent conversations can create a feedback loop when each sends the other a new chat task and receives an automatic result. This fix rejects B-to-A chats while B's exact active input was authored by Agent A. It preserves existing chat tools, automatic results and dispatch timing, without adding note tools or a task graph. The guard is implemented and tested locally; legacy inputs without sender metadata and longer cycles remain outside this fix.

## Decision and boundary

The execution runtime selects the exact driving input id. The history backend reads only that input; its Agent author identifies the sender for this scheduling restriction. Human authorization continues to come from the runtime, never from author metadata. No parent-session relationship, latest-history scan or assistant author determines the blocked target. A later human input or input from C replaces the scope, so A remains available for unrelated future work.

Single and legacy chats fail with non-retryable `REVERSE_CHAT_FORBIDDEN` before target input or new Operation creation. A mixed batch records a failed reverse item and continues its unrelated targets; a batch consisting entirely of reverse targets creates no Operation. Exact retries of already accepted Operations retain their existing receipt and do not append another prompt. Missing exact input history blocks a new chat; an existing legacy input without Agent author retains compatibility because its sender cannot be inferred safely.

This is deliberately smaller than an ancestor-chain policy or a separate passive-note protocol. It prevents direct task replies, not every multi-party cycle or repeated outbound task. It does not cancel previously accepted work or change result batching, Stop, queue consumption, or existing delivery wake behavior. The broader [inbox proposal](../../proposed/architecture/2026-10-12-turn-scoped-operation-inbox.md) and [loop diagnosis](../../proposed/bug-fix/2026-10-12-agent-message-loop-origin.md) remain separate work.

The Effect feature/fix assessment keeps this guard in the existing acceptance workflow. A native migration would pull in unfinished command/history dependencies and expand the requested change; no lifecycle, ownership or Effect migration completion is claimed.

## Verification

The existing MCP suites pass 75 tests, including real HistoryWriter/SessionData and SQLite acceptance tests for single, legacy and default-expanded batch rejection, mixed-batch persistence and retry, later human/other-agent inputs and missing-source history. Tests inspect persisted Operations and delivered inputs rather than mock call counts. Verification used an isolated source snapshot and existing local test dependencies; no real model or network was involved.

Repository checks and CLI type checking are reported separately from these behavioral tests: the worktree has no installed dependencies or initialized ACP submodules. Patched and baseline CLI type checks produce the same 47 diagnostic lines in the temporary environment; docs check retains the same 82 baseline errors with no added errors. Targeted formatting and whitespace checks pass. This is local implementation evidence, not deployment or product acceptance. Owning contracts are [Session orchestration](../../../../specs/session-orchestration.md) and [MCP rules](../../../../apps/cli/src/mcp/AGENTS.md).

## Future ACP steer review

Keep asynchronous task inputs, notes and Operation results at the agreed consumption boundaries: after the prior turn naturally finishes or when the next input begins, with user pause still preventing automatic continuation. This fix does not implement that broader inbox policy. When ACP steer is supported consistently by Lody endpoints and agent adapters, maintainers should revisit delivery into the active execution through steer. Protocol availability alone is insufficient: verify provider application, ownership, cancellation, pause and unknown-delivery handling before changing the policy. This is a future review trigger, not a scheduled reminder or authorization to enable steer now.
