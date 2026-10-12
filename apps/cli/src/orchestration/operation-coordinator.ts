import { operationInboxLegacy, type OperationInboxLegacy } from './inbox/legacy';
import type { InboxBatch } from './inbox/model';
import { isSessionCollaborationStopped } from '@lody/shared';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { withTimeout } from '@/lib/loro/timeout-utils';

import type { RepoWatchHandle } from 'loro-repo';

import {
  buildMissingEmail,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  makeLodyError,
  type LodyOperationCompletion,
  type LodyOperationItemResult,
  type MachineId,
  type MessageContent,
  type OperationProgressStatus,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type StoredLodyOperation,
  type WorkspaceId,
} from '@lody/shared';

import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import { subscribeSessionChanges } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type { SessionDispatchWatcher } from '@/session/session-dispatch-watcher';
import type { SessionExecutionService } from '@/session/session-execution-service';
import type { SessionUserResolver } from '@/session/session-user-resolver';
import { createSessionBackend, type SessionBackend } from '@/session/session-backend';

import { getLodyOperationStorePath, LodyOperationStore } from './operation-store';
import {
  getOperationProgressTargetKey,
  getOperationProgressTurnId,
  upsertOperationProgressHistory,
  type OperationProgressStatusByTarget,
} from './operation-progress-history';

type TargetSubscription = {
  unsubscribe: () => void;
};

const TARGET_OUTPUT_PREVIEW_MAX_BYTES = 8 * 1024;
const MATERIALIZATION_RETRY_MIN_MS = 1_000;
const MATERIALIZATION_RETRY_MAX_MS = 30_000;
// This module is loaded once by each CLI Worker process. All workspace
// coordinators in that Worker share one boot identity, while a replacement
// Worker necessarily receives a fresh identity after the supervisor's child
// exit barrier (or the foreground Host-lease acquisition barrier).
const WORKER_BOOT_ID = randomUUID();

const truncateTargetOutput = (
  text: string
): { text: string; truncated?: true; omittedBytes?: number } => {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= TARGET_OUTPUT_PREVIEW_MAX_BYTES) return { text };
  const marker = '\n…\n';
  const characters = Array.from(text);
  const render = (keptCharacters: number) => {
    const headCount = Math.ceil(keptCharacters / 2);
    const tailCount = keptCharacters - headCount;
    return `${characters.slice(0, headCount).join('')}${marker}${characters
      .slice(characters.length - tailCount)
      .join('')}`;
  };
  let low = 0;
  let high = characters.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(render(middle), 'utf8') <= TARGET_OUTPUT_PREVIEW_MAX_BYTES) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const headCount = Math.ceil(best / 2);
  const tailCount = best - headCount;
  const kept = `${characters.slice(0, headCount).join('')}${characters
    .slice(characters.length - tailCount)
    .join('')}`;
  return {
    text: render(best),
    truncated: true,
    omittedBytes: originalBytes - Buffer.byteLength(kept, 'utf8'),
  };
};

const assistantOutputPreview = (
  assistant: Pick<SessionHistoryInput, 'items'>
): ReturnType<typeof truncateTargetOutput> | undefined => {
  const text = (assistant.items ?? [])
    .filter((item): item is Extract<MessageContent, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .filter((item) => item.length > 0)
    .join('\n\n');
  return text.length > 0 ? truncateTargetOutput(text) : undefined;
};

export type LodyOperationCoordinatorOptions = {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  userId: string;
  workspaceDocument: LoroDocumentManager;
  executionService: SessionExecutionService;
  dispatchWatcher: SessionDispatchWatcher;
  // Delivery turns run inside the requester's own Session, so they must carry
  // the requester's commit identity. Without it the continuation turn would
  // overwrite the session's git identity with a placeholder, and any commit it
  // makes would be authored by the daemon host instead of the requesting user.
  userResolver?: Pick<SessionUserResolver, 'resolve'>;
  logger: Logger;
  storeFactory?: () => LodyOperationStore;
  storePath?: string;
  now?: () => number;
  operationStoreWatchFactory?: (
    directory: string,
    onChange: (filename: string | Buffer | null) => void
  ) => Pick<FSWatcher, 'close'>;
  workerBootId?: string;
  /** Confirm authoritative input absence before replay; cloud requires remote catch-up. */
  confirmTargetReadable?: (docId: string, reason: string) => Promise<void>;
  materializeTarget: (
    operation: StoredLodyOperation,
    item: Extract<LodyOperationItemResult, { status: 'active' }>,
    index: number,
    signal: AbortSignal
  ) => Promise<void>;
};

const isTerminalAssistantEntry = (entry: SessionHistoryInput): boolean =>
  entry.role === 'assistant' && (entry.finished === true || typeof entry.endedAt === 'number');

export class LodyOperationCoordinator {
  private readonly storeFactory: () => LodyOperationStore;
  private readonly now: () => number;
  private readonly targetSubscriptions = new Map<string, TargetSubscription>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly materializationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly materializationRetryAttempts = new Map<string, number>();
  private readonly reconcileChains = new Map<string, Promise<void>>();
  private readonly operationAbortControllers = new Map<string, AbortController>();
  private metaWatch: RepoWatchHandle | null = null;
  private store: LodyOperationStore | null = null;
  private storeWatch: Pick<FSWatcher, 'close'> | null = null;
  private progressRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private storeWakeTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inbox: OperationInboxLegacy | undefined;
  private shutdown: Promise<void> | undefined;
  private quiesceReceipt: Promise<void> | undefined;
  private quiesceFailure: unknown;
  private legacyDrain: Promise<void> | undefined;
  private legacyHandoffPending = false;
  private stoppedComplete = true;
  private shutdownFailure: unknown;
  private shutdownRecovery: Promise<void> | undefined;
  private readonly inboxExecutions = new Set<Promise<void>>();
  private readonly projectedBatches = new Set<string>();
  private readonly materializationClaimToken = randomUUID();
  private readonly workerBootId: string;

  constructor(private readonly options: LodyOperationCoordinatorOptions) {
    const storePath = options.storePath ?? getLodyOperationStorePath(options.machineId);
    this.storeFactory = options.storeFactory ?? (() => new LodyOperationStore(storePath));
    this.now = options.now ?? getServerNow;
    this.workerBootId = options.workerBootId ?? WORKER_BOOT_ID;
  }

  start(): void {
    if (this.legacyHandoffPending) throw new Error('Legacy coordinator has not physically drained');
    if (this.started) return;
    if (!this.stoppedComplete) throw new Error('Coordinator shutdown is not complete');
    this.shutdown = undefined;
    this.shutdownFailure = undefined;
    this.shutdownRecovery = undefined;
    this.quiesceReceipt = undefined;
    this.quiesceFailure = undefined;
    this.projectedBatches.clear();
    this.stoppedComplete = false;
    this.started = true;
    this.metaWatch = this.options.workspaceDocument.repo.watch(
      (event) => {
        if (event.kind !== 'doc-metadata') return;
        void this.wake('session-meta');
      },
      { kinds: ['doc-metadata'] }
    );
    // SQLite does the serialization; this watcher is only a cross-process wake
    // hint. Every wake re-reads durable state, so coalesced or duplicate file
    // events cannot affect correctness.
    //
    // The store connection MUST stay open for the coordinator's lifetime:
    // closing the last SQLite connection checkpoints and deletes the WAL/SHM
    // sidecar files, so per-reconcile open/close makes this directory watcher
    // observe its own file churn and wake itself in a loop that starves the
    // event loop (multiple workspace coordinators watching the shared
    // machine-level store amplify it).
    this.store = this.storeFactory();
    this.store.inbox.activate(this.options.workspaceId, this.workerBootId);
    this.inbox = operationInboxLegacy({
      workspaceId: this.options.workspaceId,
      owner: this.workerBootId,
      sql: this.store.inbox,
      openRecoveryRepository: () => {
        const store = this.storeFactory();
        return { sql: store.inbox, close: () => store.close() };
      },
      quiesce: () => this.options.executionService.quiesceInboxExecutions?.(),
      ready: (batch) =>
        this.started &&
        !this.options.executionService.getExecutionSnapshot(batch.sessionId as SessionId)
          .hasActiveTurn &&
        !this.options.dispatchWatcher.hasPendingDispatch(batch.sessionId as SessionId),
      admit: (batch) =>
        this.started &&
        (batch.kind !== 'automatic' ||
          !this.options.dispatchWatcher.hasPendingDispatch(batch.sessionId as SessionId)),
      launch: (batch) => {
        const pending = this.launchInboxBatch(batch);
        this.inboxExecutions.add(pending);
        void pending.finally(() => this.inboxExecutions.delete(pending)).catch(() => undefined);
        return pending;
      },
      report: (cause) => this.options.logger.warn(`[inbox] ${String(cause)}`),
    });
    this.options.executionService.setOperationInbox?.(this.inbox, this.store.inbox, (sessionId) => {
      void this.options.dispatchWatcher.enqueueSessionCheck?.(sessionId);
    });
    const recoveredClaims = this.store.recoverOrphanedDeliveryClaims(
      this.options.workspaceId,
      this.workerBootId
    );
    if (recoveredClaims > 0) {
      this.options.logger.warn(
        `[orchestration] Recovered ${recoveredClaims} orphaned Delivery claim(s) from an exited Worker`
      );
    }
    const storePath = this.options.storePath ?? getLodyOperationStorePath(this.options.machineId);
    const storeBasename = path.basename(storePath);
    const watchOperationStore =
      this.options.operationStoreWatchFactory ??
      ((directory: string, onChange: (filename: string | Buffer | null) => void) =>
        watch(directory, (_event, filename) => onChange(filename)));
    this.storeWatch = watchOperationStore(path.dirname(storePath), (filename) => {
      if (!filename || !filename.toString().startsWith(storeBasename)) return;
      // Coalesce event bursts on the leading edge: a pending timer already
      // covers this event, and resetting it per event would let a sustained
      // event stream defer the wake indefinitely. The wake (and the
      // cancellation refresh) re-reads durable state, so batching is safe.
      if (this.storeWakeTimer) return;
      this.storeWakeTimer = setTimeout(() => {
        this.storeWakeTimer = null;
        this.abortTerminalCoordinators();
        void this.wake('operation-store');
      }, 10);
      this.storeWakeTimer.unref?.();
    });
    void this.wake('startup');
  }

  /** Upgrade-only adapter: old stop is not a release receipt. Never activates on timeout. */
  async startAfterLegacyDrain(
    previous: { stop(): void | Promise<void>; idle(): Promise<void> },
    physicalRelease: () => Promise<void>
  ): Promise<void> {
    this.legacyHandoffPending = true;
    this.legacyDrain ??= (async () => {
      await previous.stop();
      await previous.idle();
      await physicalRelease();
    })();
    await withTimeout(this.legacyDrain, 15_000, 'Legacy coordinator release is unresolved');
    this.legacyHandoffPending = false;
    this.start();
  }

  hasPendingWorkForRequester(sessionId: SessionId): boolean {
    return this.store?.hasPendingWorkForRequester(this.options.workspaceId, sessionId) ?? true;
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.started = false;
    this.metaWatch?.unsubscribe();
    this.metaWatch = null;
    this.storeWatch?.close();
    this.storeWatch = null;
    if (this.storeWakeTimer) clearTimeout(this.storeWakeTimer);
    this.storeWakeTimer = null;
    if (this.progressRetryTimer) clearTimeout(this.progressRetryTimer);
    this.progressRetryTimer = null;
    if (this.store) {
      try {
        const abandonedClaims = this.store.abandonDeliveryClaimsOwnedBy(
          this.options.workspaceId,
          this.workerBootId
        );
        if (abandonedClaims > 0) {
          this.options.logger.warn(
            `[orchestration] Abandoned ${abandonedClaims} Delivery claim(s) while stopping the workspace coordinator`
          );
        }
      } catch (error) {
        this.options.logger.warn(
          `[orchestration] Could not abandon Delivery claims during coordinator stop: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    this.quiesceReceipt = this.inbox?.quiesce() ?? Promise.resolve();
    void this.quiesceReceipt.catch((cause) => {
      this.quiesceFailure = cause;
    });
    for (const subscription of this.targetSubscriptions.values()) {
      subscription.unsubscribe();
    }
    this.targetSubscriptions.clear();
    for (const timer of this.deadlineTimers.values()) {
      clearTimeout(timer);
    }
    this.deadlineTimers.clear();
    for (const timer of this.materializationTimers.values()) clearTimeout(timer);
    this.materializationTimers.clear();
    this.materializationRetryAttempts.clear();
    for (const controller of this.operationAbortControllers.values()) controller.abort();
    this.operationAbortControllers.clear();
    this.shutdown = this.finishStop().catch((cause) => {
      this.shutdownFailure = cause;
      throw cause;
    });
    return this.shutdown;
  }

  private async finishStop(): Promise<void> {
    await this.quiesceReceipt;
    // Keep the native runtime/connection alive for the final release and settlement receipts.
    await withTimeout(
      (async () => {
        await this.idle();
        await this.options.executionService.drainInboxExecutions?.();
        await Promise.allSettled([...this.inboxExecutions]);
      })(),
      15_000,
      'Coordinator resources did not drain'
    );
    await this.inbox?.close();
    this.options.executionService.setOperationInbox?.(undefined, undefined);
    this.store?.close();
    this.store = null;
    this.stoppedComplete = true;
  }
  recoverStop(): Promise<void> {
    if (this.stoppedComplete) return Promise.resolve();
    if (!this.shutdownFailure) return this.stop();
    if (this.shutdownRecovery) return this.shutdownRecovery;
    const recovery = (async () => {
      if (this.quiesceFailure) {
        this.quiesceFailure = undefined;
        this.quiesceReceipt = this.inbox?.quiesce();
        await this.quiesceReceipt;
      }
      await this.options.executionService.recoverUnreleasedInboxExecutions?.();
      await this.finishStop();
    })();
    this.shutdownRecovery = recovery;
    void recovery
      .finally(() => {
        if (this.shutdownRecovery === recovery) this.shutdownRecovery = undefined;
      })
      .catch(() => undefined);
    return recovery;
  }

  wake(reason: string): Promise<void> {
    if (!this.started) return Promise.resolve();
    const key = 'workspace';
    const previous = this.reconcileChains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => await this.reconcile(reason))
      .catch((error: unknown) => {
        this.options.logger.warn(
          `[orchestration] reconciliation failed (${reason}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      })
      .finally(() => {
        if (this.reconcileChains.get(key) === next) {
          this.reconcileChains.delete(key);
        }
      });
    this.reconcileChains.set(key, next);
    return next;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.reconcileChains.values()]);
  }

  private withStore<T>(fn: (store: LodyOperationStore) => T): T {
    // Use the lifetime connection while started; see start() for why transient
    // open/close cycles are forbidden (WAL/SHM churn re-wakes the watcher).
    if (this.store) return fn(this.store);
    throw new Error('Operation coordinator has released its store');
  }

  private async reconcile(_reason: string): Promise<void> {
    if (!this.started) return;
    await this.projectInboxReceipts();
    const active = this.withStore((store) =>
      store.listActive(this.options.workspaceId, this.options.machineId)
    );
    const activeKeys = new Set(active.map((operation) => this.operationKey(operation)));
    this.dropInactiveResources(activeKeys);

    for (const operation of active) {
      await this.reconcileOperation(operation);
    }

    const pendingProgress = this.withStore((store) =>
      store.listPendingProgress(this.options.workspaceId, this.options.machineId)
    );
    for (const operation of pendingProgress) await this.writeOperationProgress(operation);
    if (
      this.withStore((store) =>
        store.listPendingProgress(this.options.workspaceId, this.options.machineId)
      ).length > 0
    ) {
      if (!this.progressRetryTimer) {
        this.progressRetryTimer = setTimeout(() => {
          this.progressRetryTimer = null;
          void this.wake('progress-retry');
        }, 5_000);
        this.progressRetryTimer.unref?.();
      }
    } else if (this.progressRetryTimer) {
      clearTimeout(this.progressRetryTimer);
      this.progressRetryTimer = null;
    }

    // Result arrival is passive. The native inbox only resumes recorded release intents.
    void this.inbox?.wake().catch((cause) => this.options.logger.warn(`[inbox] ${String(cause)}`));
  }

  /** Restore only the stable history projection; it never authorizes model input. */
  private async projectInboxReceipts(): Promise<void> {
    const ownerStore = this.store;
    if (!ownerStore) return;
    for (const batch of ownerStore.inbox.historyReceipts(this.options.workspaceId)) {
      const key = JSON.stringify([batch.batchId, batch.state]);
      if (this.projectedBatches.has(key)) continue;
      const meta = await this.options.workspaceDocument.repo.getDocMeta(
        getSessionRoomId(batch.sessionId as SessionId)
      );
      if (!meta?.meta || isLoroRepoDocDeleted(meta)) continue;
      const doc = await this.options.workspaceDocument.getOrCreateSessionDoc(
        batch.sessionId as SessionId
      );
      const backend = await createSessionBackend(doc, meta.meta as SessionMeta);
      if (!this.started || this.store !== ownerStore) return;
      await backend.applyHistoryAction({
        kind: 'operation-batch-status',
        batchId: batch.batchId,
        turnId: batch.kind === 'automatic' ? batch.inputId : `operation-batch:${batch.batchId}`,
        status:
          batch.state === 'superseded'
            ? 'not_submitted'
            : (batch.state as 'submitted' | 'unknown' | 'settled'),
      });
      this.projectedBatches.add(key);
    }
  }

  private async reconcileOperation(operation: StoredLodyOperation): Promise<void> {
    this.armDeadline(operation);
    const key = this.operationKey(operation);
    const controller = this.operationAbortControllers.get(key) ?? new AbortController();
    this.operationAbortControllers.set(key, controller);
    const isAtDeadline = () => this.now() >= Date.parse(operation.deadlineAt);
    let items: LodyOperationItemResult[];
    try {
      items = await this.mapItemsWithConcurrency(
        operation.items,
        5,
        async (item, index) =>
          await this.reconcileItem(operation, item, index, isAtDeadline, controller.signal)
      );
    } catch (error) {
      if (!isAtDeadline()) throw error;
      this.withStore((store) =>
        store.finish(operation.requesterSessionId, operation.operationId, {
          type: 'error',
          error: makeLodyError(
            'COORDINATOR_FAILED',
            `Operation could not read trustworthy target state at its deadline: ${
              error instanceof Error ? error.message : String(error)
            }`,
            false
          ),
        })
      );
      this.clearDeadline(operation);
      this.clearOperationMaterializationRetries(operation);
      return;
    }
    const changed = JSON.stringify(items) !== JSON.stringify(operation.items);
    let latestOperation = operation;
    if (changed) {
      latestOperation = this.withStore((store) =>
        store.updateItems(operation.requesterSessionId, operation.operationId, items)
      );
    }
    await this.writeOperationProgress(latestOperation);
    if (items.every((item) => item.status !== 'active')) {
      const completion: LodyOperationCompletion = { type: 'result', value: { items } };
      latestOperation = this.withStore((store) =>
        store.finish(operation.requesterSessionId, operation.operationId, completion)
      );
      await this.writeOperationProgress(latestOperation);
      this.clearDeadline(operation);
      this.clearOperationMaterializationRetries(operation);
    }
  }

  private async writeOperationProgress(operation: StoredLodyOperation): Promise<void> {
    const ownerStore = this.store;
    if (!ownerStore) return;
    try {
      if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many') return;
      const metaRecord = await this.options.workspaceDocument.repo.getDocMeta(
        getSessionRoomId(operation.requesterSessionId)
      );
      if (!metaRecord?.meta || isLoroRepoDocDeleted(metaRecord)) return;
      const sessionDoc = await this.options.workspaceDocument.getOrCreateSessionDoc(
        operation.requesterSessionId
      );
      const backend = await createSessionBackend(sessionDoc, metaRecord.meta as SessionMeta);
      const statusByTarget = await this.collectOperationProgressTargetStatuses(operation);
      // A previous lease must not resume writing after stop/restart.
      if (!this.started || this.store !== ownerStore) return;
      await upsertOperationProgressHistory(backend, operation, this.now, statusByTarget);
      const progressTurn = await backend.readTurn(
        getOperationProgressTurnId(operation.requesterSessionId, operation.operationId)
      );
      if (
        operation.state === 'finished' &&
        this.progressIsSettled(
          operation,
          progressTurn.state === 'ready'
            ? (progressTurn.turn as unknown as SessionHistoryInput)
            : undefined,
          statusByTarget
        )
      ) {
        await backend.flushLocalWrites();
        if (!this.started || this.store !== ownerStore) return;
        this.withStore((store) =>
          store.settleProgress(operation.requesterSessionId, operation.operationId)
        );
      }
    } catch (error) {
      this.options.logger.warn(
        `[orchestration] Progress update failed for ${operation.operationId}; retrying on a later wake: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private progressIsSettled(
    operation: StoredLodyOperation,
    row: SessionHistoryInput | undefined,
    observed: OperationProgressStatusByTarget
  ): boolean {
    const content = row?.items?.find((item) => item.type === 'operation_progress');
    const published = new Map(
      (content?.items ?? []).map((item) => [
        getOperationProgressTargetKey(item.target),
        item.status,
      ])
    );
    const expected = new Map(observed);
    for (const item of operation.items) {
      if (!('target' in item) || !item.target) continue;
      const key = getOperationProgressTargetKey(item.target);
      if (expected.has(key)) continue;
      if (
        item.status === 'succeeded' ||
        item.status === 'cancelled' ||
        (item.status === 'failed' && item.error.code === 'TARGET_FAILED')
      ) {
        if (item.status === 'succeeded' || published.has(key)) expected.set(key, item.status);
      } else if (item.status === 'active' && item.inputDurable) expected.set(key, 'created');
    }
    // Previously published targets stay owned even when metadata is temporarily absent.
    if (published.size !== expected.size) return false;
    return [...expected].every(
      ([key, status]) =>
        status !== 'created' && status !== 'running' && published.get(key) === status
    );
  }

  private async collectOperationProgressTargetStatuses(
    operation: StoredLodyOperation
  ): Promise<OperationProgressStatusByTarget> {
    const statuses = new Map<string, OperationProgressStatus>();
    await this.mapItemsWithConcurrency(operation.items, 5, async (item) => {
      if (!('target' in item) || !item.target) return;
      if (item.status === 'active' && !item.inputDurable) return;
      const target = item.target;
      const metaRecord = await this.options.workspaceDocument.repo.getDocMeta(
        getSessionRoomId(target.sessionId)
      );
      if (!metaRecord?.meta || isLoroRepoDocDeleted(metaRecord)) return;
      const meta = metaRecord.meta as SessionMeta;
      const sessionDoc = await this.options.workspaceDocument.getOrCreateSessionDoc(
        target.sessionId
      );
      const backend = await createSessionBackend(sessionDoc, meta);
      this.subscribeTarget(target.sessionId, sessionDoc, backend);
      const output = await backend.readTurnOutput(target.userTurnId);
      const userTurn = output.find(
        (entry) => entry.id === target.userTurnId && entry.role === 'user'
      );
      if (!userTurn) return;
      const assistantRead = output.find(
        (entry) => entry.role === 'assistant' && entry.userTurnId === target.userTurnId
      );
      const key = getOperationProgressTargetKey(target);
      if (userTurn.status === 'failed') {
        statuses.set(key, 'failed');
        return;
      }
      if (userTurn.status === 'canceled') {
        statuses.set(key, 'cancelled');
        return;
      }
      if (assistantRead !== undefined && isTerminalAssistantEntry(assistantRead)) {
        statuses.set(key, 'succeeded');
        return;
      }
      const execution = this.options.executionService.getExecutionSnapshot(target.sessionId);
      if (
        execution.activeTurnId === `assistant:${target.userTurnId}` ||
        meta.processingUserMsgId === target.userTurnId ||
        userTurn.status === 'processing'
      ) {
        statuses.set(key, 'running');
        return;
      }
      statuses.set(key, 'created');
    });
    return statuses;
  }

  private async reconcileItem(
    operation: StoredLodyOperation,
    item: LodyOperationItemResult,
    index: number,
    isAtDeadline: () => boolean,
    signal: AbortSignal
  ): Promise<LodyOperationItemResult> {
    if (item.status !== 'active') return item;
    if (signal.aborted) return item;
    const target = item.target;
    if (!item.inputDurable) {
      let alreadyMaterialized = await this.isTargetInputDurable(
        target.sessionId,
        target.userTurnId
      );
      let claimedMaterialization = false;
      if (
        !alreadyMaterialized &&
        !isAtDeadline() &&
        this.hasMaterializationRetry(operation, index)
      ) {
        return item;
      }
      if (!alreadyMaterialized && !isAtDeadline()) {
        if (signal.aborted) return item;
        const claim = this.withStore((store) =>
          store.claimItemMaterialization(
            operation.requesterSessionId,
            operation.operationId,
            index,
            this.materializationClaimToken
          )
        );
        if (!claim.claimed) {
          if (claim.retryAtMs !== undefined) {
            this.armMaterializationRetry(operation, index, claim.retryAtMs);
          }
          return item;
        }
        claimedMaterialization = true;
        try {
          const docId = getSessionRoomId(target.sessionId);
          const reason = `orchestration.materialize:${operation.operationId}:${index}`;
          if (this.options.confirmTargetReadable) {
            await this.options.confirmTargetReadable(docId, reason);
          } else {
            await this.options.workspaceDocument.syncRemoteDocOrThrow(docId, { reason });
          }
        } catch (error) {
          if (signal.aborted) return item;
          if (!isAtDeadline()) {
            const delayMs = this.armMaterializationFailureRetry(operation, index);
            this.options.logger.warn(
              `[orchestration] Target document catch-up was not confirmed ` +
                `(${operation.operationId}:${index}); retrying in ${delayMs}ms: ${
                  error instanceof Error ? error.message : String(error)
                }`
            );
            return item;
          }
        }
        if (signal.aborted) return item;
        alreadyMaterialized = await this.isTargetInputDurable(target.sessionId, target.userTurnId);
      }
      if (!alreadyMaterialized && !isAtDeadline()) {
        try {
          await this.options.materializeTarget(operation, item, index, signal);
        } catch (error) {
          if (signal.aborted) return item;
          const delayMs = this.armMaterializationFailureRetry(operation, index);
          this.options.logger.warn(
            `[orchestration] Target materialization failed ` +
              `(${operation.operationId}:${index}); retrying in ${delayMs}ms: ${
                error instanceof Error ? error.message : String(error)
              }`
          );
          return item;
        }
        if (signal.aborted) return item;
        alreadyMaterialized = true;
      }
      if (!alreadyMaterialized) {
        this.clearMaterializationRetry(operation, index);
        return {
          status: 'failed',
          ...(item.label ? { label: item.label } : {}),
          target: item.target,
          error: makeLodyError(
            'TARGET_TIMEOUT',
            'Target input was not durably materialized before the Operation deadline.',
            false
          ),
        };
      }
      const materializedOperation = this.withStore((store) =>
        store.markItemInputDurable(
          operation.requesterSessionId,
          operation.operationId,
          index,
          claimedMaterialization ? this.materializationClaimToken : undefined
        )
      );
      // Publish each recovered child without waiting for slower batch siblings.
      await this.writeOperationProgress(materializedOperation);
      this.clearMaterializationRetry(operation, index);
      item = { ...item, inputDurable: true };
    }

    const metaRecord = await this.options.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(item.target.sessionId)
    );
    if (!metaRecord?.meta || isLoroRepoDocDeleted(metaRecord)) {
      return isAtDeadline()
        ? {
            status: 'failed',
            ...(item.label ? { label: item.label } : {}),
            target: item.target,
            error: makeLodyError(
              'TARGET_TIMEOUT',
              'Target state was unavailable when the Operation deadline was enforced.',
              false
            ),
          }
        : item;
    }

    const sessionDoc = await this.options.workspaceDocument.getOrCreateSessionDoc(
      item.target.sessionId
    );
    const backend = await createSessionBackend(sessionDoc, metaRecord.meta as SessionMeta);
    this.subscribeTarget(item.target.sessionId, sessionDoc, backend);
    const targetOutput = await backend.readTurnOutput(item.target.userTurnId);
    const userTurn = targetOutput.find(
      (entry) => entry.id === item.target.userTurnId && entry.role === 'user'
    );
    const assistant = targetOutput.find(
      (entry) =>
        entry.role === 'assistant' &&
        entry.userTurnId === item.target.userTurnId &&
        isTerminalAssistantEntry(entry)
    );
    if (userTurn?.status === 'failed') {
      return {
        status: 'failed',
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
        error: makeLodyError('TARGET_FAILED', 'Target Turn failed.', false),
      };
    }
    if (userTurn?.status === 'canceled') {
      return {
        status: 'cancelled',
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
      };
    }
    if (assistant) {
      const output = assistantOutputPreview(assistant);
      return {
        status: 'succeeded',
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
        assistantTurnId: assistant.id,
        ...(output ? { output } : {}),
      };
    }
    if (isAtDeadline()) {
      return {
        status: 'failed',
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
        error: makeLodyError(
          'TARGET_TIMEOUT',
          'Target Turn was not terminal when the Operation deadline was enforced.',
          false
        ),
      };
    }
    return item;
  }

  private async isTargetInputDurable(sessionId: SessionId, userTurnId: string): Promise<boolean> {
    const metaRecord = await this.options.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(sessionId)
    );
    if (!metaRecord?.meta || isLoroRepoDocDeleted(metaRecord)) {
      return false;
    }
    const sessionDoc = await this.options.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const backend = await createSessionBackend(sessionDoc, metaRecord.meta as SessionMeta);
    const output = await backend.readTurnOutput(userTurnId);
    const userTurn = output.find((entry) => entry.id === userTurnId && entry.role === 'user');
    if (!userTurn) return false;
    const meta = metaRecord.meta as SessionMeta;
    const assistantIsTerminal = output.some(
      (entry) =>
        entry.role === 'assistant' &&
        entry.userTurnId === userTurnId &&
        isTerminalAssistantEntry(entry)
    );
    return (
      meta.latestUserMsgId === userTurnId ||
      meta.processingUserMsgId === userTurnId ||
      meta.lastHandledUserMsgId === userTurnId ||
      userTurn.status === 'handled' ||
      userTurn.status === 'failed' ||
      userTurn.status === 'canceled' ||
      assistantIsTerminal
    );
  }

  private subscribeTarget(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    backend: Pick<SessionBackend, 'subscribeHistory'>
  ): void {
    if (!this.started || this.targetSubscriptions.has(sessionId)) return;
    const unsubscribe = subscribeSessionChanges(
      sessionDoc,
      () => {
        void this.wake('target-history');
      },
      backend
    );
    this.targetSubscriptions.set(sessionId, { unsubscribe });
  }

  private armDeadline(operation: StoredLodyOperation): void {
    const key = this.operationKey(operation);
    if (this.deadlineTimers.has(key)) return;
    const delay = Math.max(0, Date.parse(operation.deadlineAt) - this.now());
    const timer = setTimeout(
      () => {
        this.deadlineTimers.delete(key);
        void this.wake('deadline');
      },
      Math.min(delay, 2_147_483_647)
    );
    timer.unref?.();
    this.deadlineTimers.set(key, timer);
  }

  private armMaterializationRetry(
    operation: StoredLodyOperation,
    itemIndex: number,
    retryAtMs: number,
    wakeReason = 'materialization-claim-expired'
  ): void {
    const key = `${this.operationKey(operation)}\0${itemIndex}`;
    if (this.materializationTimers.has(key)) return;
    const timer = setTimeout(
      () => {
        this.materializationTimers.delete(key);
        void this.wake(wakeReason);
      },
      Math.max(0, retryAtMs - this.now())
    );
    timer.unref?.();
    this.materializationTimers.set(key, timer);
  }

  private armMaterializationFailureRetry(
    operation: StoredLodyOperation,
    itemIndex: number
  ): number {
    const key = this.materializationKey(operation, itemIndex);
    const attempt = this.materializationRetryAttempts.get(key) ?? 0;
    const exponent = Math.min(
      attempt,
      Math.ceil(Math.log2(MATERIALIZATION_RETRY_MAX_MS / MATERIALIZATION_RETRY_MIN_MS))
    );
    const delayMs = Math.min(
      MATERIALIZATION_RETRY_MIN_MS * 2 ** exponent,
      MATERIALIZATION_RETRY_MAX_MS
    );
    this.materializationRetryAttempts.set(key, exponent + 1);
    const now = this.now();
    const retryAtMs = Math.min(now + delayMs, Date.parse(operation.deadlineAt));
    this.armMaterializationRetry(operation, itemIndex, retryAtMs, 'materialization-retry');
    return Math.max(0, retryAtMs - now);
  }

  private hasMaterializationRetry(operation: StoredLodyOperation, itemIndex: number): boolean {
    return this.materializationTimers.has(this.materializationKey(operation, itemIndex));
  }

  private clearMaterializationRetry(operation: StoredLodyOperation, itemIndex: number): void {
    const key = this.materializationKey(operation, itemIndex);
    const timer = this.materializationTimers.get(key);
    if (timer) clearTimeout(timer);
    this.materializationTimers.delete(key);
    this.materializationRetryAttempts.delete(key);
  }

  private clearOperationMaterializationRetries(operation: StoredLodyOperation): void {
    const prefix = `${this.operationKey(operation)}\0`;
    for (const [key, timer] of this.materializationTimers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.materializationTimers.delete(key);
    }
    for (const key of this.materializationRetryAttempts.keys()) {
      if (key.startsWith(prefix)) this.materializationRetryAttempts.delete(key);
    }
  }

  private clearDeadline(operation: StoredLodyOperation): void {
    const key = this.operationKey(operation);
    const timer = this.deadlineTimers.get(key);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(key);
  }

  private operationKey(operation: StoredLodyOperation): string {
    return `${operation.requesterSessionId}\0${operation.operationId}`;
  }

  private materializationKey(operation: StoredLodyOperation, itemIndex: number): string {
    return `${this.operationKey(operation)}\0${itemIndex}`;
  }

  private dropInactiveResources(activeKeys: Set<string>): void {
    for (const [key, timer] of this.deadlineTimers) {
      if (!activeKeys.has(key)) {
        clearTimeout(timer);
        this.deadlineTimers.delete(key);
      }
    }
    for (const [key, controller] of this.operationAbortControllers) {
      if (!activeKeys.has(key)) {
        controller.abort();
        this.operationAbortControllers.delete(key);
      }
    }
    for (const [key, timer] of this.materializationTimers) {
      const active = [...activeKeys].some((operationKey) => key.startsWith(`${operationKey}\0`));
      if (active) continue;
      clearTimeout(timer);
      this.materializationTimers.delete(key);
      this.materializationRetryAttempts.delete(key);
    }
    for (const key of this.materializationRetryAttempts.keys()) {
      const active = [...activeKeys].some((operationKey) => key.startsWith(`${operationKey}\0`));
      if (!active) this.materializationRetryAttempts.delete(key);
    }
  }

  private abortTerminalCoordinators(): void {
    if (!this.started || this.operationAbortControllers.size === 0) return;
    try {
      const active = this.withStore((store) =>
        store.listActive(this.options.workspaceId, this.options.machineId)
      );
      this.dropInactiveResources(new Set(active.map((operation) => this.operationKey(operation))));
    } catch (error) {
      this.options.logger.debug(
        `[orchestration] Could not refresh coordinator cancellation state: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async mapItemsWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    map: (value: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const output = new Array<R>(values.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) output[index] = await map(value, index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
    return output;
  }

  private async launchInboxBatch(batch: InboxBatch): Promise<void> {
    if (!this.started || !this.store) return;
    const sessionId = batch.sessionId as SessionId;
    const record = await this.options.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(sessionId)
    );
    if (!this.started || !record?.meta || isLoroRepoDocDeleted(record)) return;
    const meta = record.meta as SessionMeta;
    if (
      meta.isArchived ||
      meta.machineId !== this.options.machineId ||
      (await isSessionCollaborationStopped(this.options.workspaceDocument.repo, sessionId))
    )
      return;
    const cliType = batch.config.cliType ?? meta.cliType;
    if (!cliType) return;
    const requester = await this.resolveRequesterIdentity(batch.userId);
    if (!this.started) return;
    await this.options.executionService.continueSession(
      {
        type: 'session/chat',
        sessionId,
        machineId: this.options.machineId,
        workspaceId: this.options.workspaceId,
        userTurnId: batch.inputId,
        userId: batch.userId,
        userName: requester.name,
        userEmail: requester.email,
        acpSessionConfig: {
          ...batch.config,
          cliType,
          agentType: batch.config.agentType ?? meta.agentType,
          prompt: 'Review the completed results according to the current conversation request.',
          inputBlocks: undefined,
          resume: meta.acpSessionId ?? undefined,
          chainDepth: batch.chainDepth,
        },
      },
      { dispatchSource: 'delivery', inboxBatch: batch }
    );
  }

  private async resolveRequesterIdentity(
    requesterUserId: string
  ): Promise<{ name: string; email: string }> {
    const fallback = {
      name: requesterUserId,
      email: buildMissingEmail('lody', requesterUserId),
    };
    const resolver = this.options.userResolver;
    if (!resolver) {
      return fallback;
    }
    try {
      const profile = await resolver.resolve(requesterUserId);
      return { name: profile.name, email: profile.email };
    } catch (error) {
      this.options.logger.debug(
        `[operation-coordinator] Failed to resolve requester identity ${requesterUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return fallback;
    }
  }
}
