# Reconciliation feedback

Binding constraints live in [AGENTS.md](AGENTS.md). This page explains why
connection lifetime and change notifications matter to the coordinator.

`operation-store.ts` uses SQLite WAL. Closing the last connection checkpoints
and removes WAL/SHM sidecars. Opening and closing for each reconciliation makes
`operation-coordinator.ts` observe its own filesystem churn. Multiple workspace
coordinators share the machine store and can amplify those notifications.
Per-call MCP opens can also perform maintenance writes and trigger lock contention;
the coordinator owns maintenance, while MCP keeps a read-only schema probe before
any required migration.

`operation-progress-history.ts` projects target execution into a requester card.
With nested A -> B -> C sessions, A observes B, while B contains a card for C.
Mirror notifies subscribers even when a state updater returns unchanged history.
Writing the same card can therefore schedule another reconciliation indefinitely.
The preflight comparison avoids entering Mirror; real writes recompute against
current history so a preflight snapshot cannot overwrite an intervening update.

The real-Mirror regression is in
[operation-progress-feedback.test.ts](../../tests/operation-progress-feedback.test.ts).

## Completion consumption

`inbox/sqlite.ts` indexes results in the existing completion transaction, fixes release
watermarks and persists input/batch/resource receipts. `inbox/service.ts` owns coalesced
signals, scoped workers and the shared admission gate. `inbox/legacy.ts` registers the
single host runtime and the unfinished Session adapter. `inbox/recovery.ts` proves
resource disappearance conservatively; unsupported or missing identities remain blocked.

`session-execution-service.ts` calls the actual prompt primitive while holding admission.
A batch is one system history item plus one model input, even when details require pages.
`batch-page.ts` returns complete large members in bounded JSON fragments. The execution
owner retains raw requests and full failures; `recoverInboxExecution` retries cleanup.
Coordinator `stop()` now has a shared awaited drain receipt; `recoverStop()` is its
independent retry entry. Same-process legacy handoff uses `startAfterLegacyDrain`.
`recoverStop()` invokes the bridge's `recoverClose()` for failed close receipts, using
an independent connection to retry only settlement/release/pause writes. The original
failed close receipt remains unchanged; requests are never resubmitted.

Only a confirmed normal release can grant an automatic intent. Stop cancels queued
human execution eligibility and pauses automatic work. Fresh human input carries saved
results, and a failed/unreleased execution cannot manufacture another wake. See the
[contract](../../../../specs/session-orchestration.md#idempotent-message-consumption).

Consumed Operation payloads expire after seven days. `operation_retired_ids`
retains only their Session/Operation keys for the life of the local store.
The retirement trigger runs in the same cleanup transaction, before cascaded
Delivery deletion; the insertion trigger also fences older writers. No columns
are added to the strict legacy Operation or Delivery rows. Modern acceptance and
retry lookup return non-retryable `OPERATION_ID_REUSED` for retired keys.

Persistence and acknowledgement stay in this store: repeated notifications
resolve the same Delivery, and successful settlement atomically records consumed
state for its claim. No ACP client or provider-specific protocol is required.
See the [scope correction](../../../../.agents/notes/rejected/architecture/2026-10-10-provider-prompt-receipts.md).

## Message-author snapshots

`operation_authors` stores source identity and per-target Role display snapshots in
the Operation acceptance transaction, with cascading cleanup. Separate storage
keeps strict legacy `SELECT *` and frozen-config readers compatible. Missing rows
mean legacy provenance, not permission to reconstruct historical identities from
current catalogs. See the [contract](../../../../specs/message-author-identity.md).
