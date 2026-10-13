import {
  makeLodyError,
  type LodyOperationCompletion,
  type LodyOperationItemResult,
  type MachineId,
  type OperationProgressStatus,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type StoredLodyOperation,
  type WorkspaceId,
} from '@lody/shared';
import {
  getOperationProgressTargetKey,
  getOperationProgressTurnId,
  type OperationProgressStatusByTarget,
} from '@lody/shared/session-data';
import { Cause, Context, Effect, Exit, Layer, Scope } from 'effect';
import { CoordinatorActivity } from './coordinator-activity';
import {
  assistantOutputPreview,
  isTerminalAssistantEntry,
  progressIsSettled,
} from './coordinator-model';
import { CoordinatorPorts, type CoordinatorHistory } from './coordinator-ports';
import { OperationRepository } from './operation-repository';
class CoordinatorFailure extends Error {
  constructor(readonly effectCause: Cause.Cause<unknown>) {
    super(String(Cause.squash(effectCause)));
  }
}
function unwrapExit<A>(exit: Exit.Exit<A, unknown>): A {
  if (Exit.isFailure(exit)) throw new CoordinatorFailure(exit.cause);
  return exit.value;
}
const restoreCause = Effect.catchCause((cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause);
  return Effect.failCause(failure instanceof CoordinatorFailure ? failure.effectCause : cause);
});
export class CoordinatorWorkflow {
  recoverSubscriptions = () =>
    Effect.forEach([...this.subscriptions.values()], (detach) => detach, { discard: true });
  private readonly projectedBatches = new Set<string>();
  private readonly subscriptions = new Map<string, Effect.Effect<void>>();
  private readonly materializationRetryAttempts = new Map<string, number>();
  private readonly store: OperationRepository['Service'];
  constructor(
    private readonly options: { workspaceId: WorkspaceId; machineId: MachineId },
    private readonly ports: CoordinatorPorts['Service'],
    private readonly operations: OperationRepository['Service'],
    private readonly activity: CoordinatorActivity['Service'],
    private readonly scope: Scope.Scope
  ) {
    this.store = operations;
  }
  private get started() {
    return this.ports.active();
  }
  private now = () => this.ports.now();
  private get materializationClaimToken() {
    return this.ports.claimToken;
  }
  private operationKey(operation: StoredLodyOperation) {
    return operation.requesterSessionId + '\0' + operation.operationId;
  }
  private materializationKey(operation: StoredLodyOperation, index: number) {
    return 'material:' + this.operationKey(operation) + '\0' + index;
  }
  private hasMaterializationRetry(operation: StoredLodyOperation, index: number) {
    return this.activity.has(this.materializationKey(operation, index));
  }
  private mapItemsWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    map: (value: T, index: number) => Effect.Effect<R, unknown>
  ) {
    return Effect.forEach(values, map, { concurrency });
  }
  reconcile = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, _reason: string): Effect.fn.Return<void, unknown> {
      if (!this.started) return;
      unwrapExit(yield* Effect.exit(this.projectInboxReceipts()));
      const active = unwrapExit(
        yield* Effect.exit(
          this.operations.listActive(this.options.workspaceId, this.options.machineId)
        )
      );
      const activeKeys = new Set(active.map((operation) => this.operationKey(operation)));
      unwrapExit(yield* Effect.exit(this.dropInactiveResources(activeKeys)));
      for (const operation of active) {
        unwrapExit(yield* Effect.exit(this.reconcileOperation(operation)));
      }
      const pendingProgress = unwrapExit(
        yield* Effect.exit(
          this.operations.listPendingProgress(this.options.workspaceId, this.options.machineId)
        )
      );
      for (const operation of pendingProgress)
        unwrapExit(yield* Effect.exit(this.writeOperationProgress(operation)));
      if (
        unwrapExit(
          yield* Effect.exit(
            this.operations.listPendingProgress(this.options.workspaceId, this.options.machineId)
          )
        ).length > 0
      ) {
        unwrapExit(yield* Effect.exit(this.activity.arm('progress', 5000, 'progress-retry')));
      } else {
        unwrapExit(yield* Effect.exit(this.activity.cancel('progress')));
      }
      unwrapExit(yield* Effect.exit(this.ports.wakeInbox));
    }.bind(this),
    restoreCause
  );
  projectInboxReceipts = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow): Effect.fn.Return<void, unknown> {
      const ownerStore = this.store;
      if (!ownerStore) return;
      for (const batch of unwrapExit(yield* Effect.exit(this.ports.receipts))) {
        const key = JSON.stringify([batch.batchId, batch.state]);
        if (this.projectedBatches.has(key)) continue;
        const meta = unwrapExit(
          yield* Effect.exit(this.ports.metadata(batch.sessionId as SessionId))
        );
        if (!meta?.meta) continue;
        const doc = unwrapExit(
          yield* Effect.exit(this.ports.session(batch.sessionId as SessionId))
        );
        const backend = doc;
        if (!this.started || this.store !== ownerStore) return;
        unwrapExit(
          yield* Effect.exit(
            backend.applyHistoryAction({
              kind: 'operation-batch-status',
              batchId: batch.batchId,
              turnId:
                batch.kind === 'automatic' ? batch.inputId : `operation-batch:${batch.batchId}`,
              status:
                batch.state === 'superseded'
                  ? 'not_submitted'
                  : (batch.state as 'submitted' | 'unknown' | 'settled'),
            })
          )
        );
        this.projectedBatches.add(key);
      }
    }.bind(this),
    restoreCause
  );
  reconcileOperation = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      operation: StoredLodyOperation
    ): Effect.fn.Return<void, unknown> {
      unwrapExit(
        yield* Effect.exit(
          this.activity.arm(
            'deadline:' + this.operationKey(operation),
            Date.parse(operation.deadlineAt) - this.now(),
            'deadline'
          )
        )
      );
      const key = this.operationKey(operation);
      const controller = unwrapExit(yield* Effect.exit(this.ports.operation(key)));
      const isAtDeadline = () => this.now() >= Date.parse(operation.deadlineAt);
      let items: LodyOperationItemResult[];
      try {
        items = unwrapExit(
          yield* Effect.exit(
            this.mapItemsWithConcurrency(operation.items, 5, (item, index) =>
              Effect.gen(
                function* (this: CoordinatorWorkflow) {
                  return unwrapExit(
                    yield* Effect.exit(
                      this.reconcileItem(operation, item, index, isAtDeadline, controller.signal)
                    )
                  );
                }.bind(this)
              )
            )
          )
        );
      } catch (error) {
        if (!isAtDeadline()) throw error;
        unwrapExit(
          yield* Effect.exit(
            this.operations.finish(operation.requesterSessionId, operation.operationId, {
              type: 'error',
              error: makeLodyError(
                'COORDINATOR_FAILED',
                `Operation could not read trustworthy target state at its deadline: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                false
              ),
            })
          )
        );
        unwrapExit(
          yield* Effect.exit(this.activity.cancel('deadline:' + this.operationKey(operation)))
        );
        unwrapExit(yield* Effect.exit(this.clearOperationMaterializationRetries(operation)));
        return;
      }
      const changed = JSON.stringify(items) !== JSON.stringify(operation.items);
      let latestOperation = operation;
      if (changed) {
        latestOperation = unwrapExit(
          yield* Effect.exit(
            this.operations.updateItems(operation.requesterSessionId, operation.operationId, items)
          )
        );
      }
      unwrapExit(yield* Effect.exit(this.writeOperationProgress(latestOperation)));
      if (items.every((item) => item.status !== 'active')) {
        const completion: LodyOperationCompletion = { type: 'result', value: { items } };
        latestOperation = unwrapExit(
          yield* Effect.exit(
            this.operations.finish(operation.requesterSessionId, operation.operationId, completion)
          )
        );
        unwrapExit(yield* Effect.exit(this.writeOperationProgress(latestOperation)));
        unwrapExit(
          yield* Effect.exit(this.activity.cancel('deadline:' + this.operationKey(operation)))
        );
        unwrapExit(yield* Effect.exit(this.clearOperationMaterializationRetries(operation)));
      }
    }.bind(this),
    restoreCause
  );
  writeOperationProgress = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      operation: StoredLodyOperation
    ): Effect.fn.Return<void, unknown> {
      const ownerStore = this.store;
      if (!ownerStore) return;
      try {
        if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many') return;
        const metaRecord = unwrapExit(
          yield* Effect.exit(this.ports.metadata(operation.requesterSessionId))
        );
        if (!metaRecord?.meta) return;
        const sessionDoc = unwrapExit(
          yield* Effect.exit(this.ports.session(operation.requesterSessionId))
        );
        const backend = sessionDoc;
        const statusByTarget = unwrapExit(
          yield* Effect.exit(this.collectOperationProgressTargetStatuses(operation))
        );
        // A previous lease must not resume writing after stop/restart.
        if (!this.started || this.store !== ownerStore) return;
        unwrapExit(
          yield* Effect.exit(
            backend.applyHistoryAction({
              kind: 'operation-progress',
              operation,
              timestamp: new Date(this.now()).toISOString(),
              statuses: [...statusByTarget],
            })
          )
        );
        const progressTurn = unwrapExit(
          yield* Effect.exit(
            backend.readTurn(
              getOperationProgressTurnId(operation.requesterSessionId, operation.operationId)
            )
          )
        );
        if (
          operation.state === 'finished' &&
          progressIsSettled(
            operation,
            progressTurn.state === 'ready'
              ? (progressTurn.turn as unknown as SessionHistoryInput)
              : undefined,
            statusByTarget
          )
        ) {
          unwrapExit(yield* Effect.exit(backend.flushLocalWrites));
          if (!this.started || this.store !== ownerStore) return;
          unwrapExit(
            yield* Effect.exit(
              this.operations.settleProgress(operation.requesterSessionId, operation.operationId)
            )
          );
        }
      } catch (error) {
        unwrapExit(
          yield* Effect.exit(
            this.ports.warn(
              `[orchestration] Progress update failed for ${operation.operationId}; retrying on a later wake: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          )
        );
      }
    }.bind(this),
    restoreCause
  );
  collectOperationProgressTargetStatuses = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      operation: StoredLodyOperation
    ): Effect.fn.Return<OperationProgressStatusByTarget, unknown> {
      const statuses = new Map<string, OperationProgressStatus>();
      unwrapExit(
        yield* Effect.exit(
          this.mapItemsWithConcurrency(operation.items, 5, (item) =>
            Effect.gen(
              function* (this: CoordinatorWorkflow) {
                if (!('target' in item) || !item.target) return;
                if (item.status === 'active' && !item.inputDurable) return;
                const target = item.target;
                const metaRecord = unwrapExit(
                  yield* Effect.exit(this.ports.metadata(target.sessionId))
                );
                if (!metaRecord?.meta) return;
                const meta = metaRecord.meta as SessionMeta;
                const sessionDoc = unwrapExit(
                  yield* Effect.exit(this.ports.session(target.sessionId))
                );
                const backend = sessionDoc;
                unwrapExit(yield* Effect.exit(this.subscribeTarget(target.sessionId, backend)));
                const output = unwrapExit(
                  yield* Effect.exit(backend.readTurnOutput(target.userTurnId))
                );
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
                const execution = this.ports.execution(target.sessionId);
                if (
                  execution.activeTurnId === `assistant:${target.userTurnId}` ||
                  meta.processingUserMsgId === target.userTurnId ||
                  userTurn.status === 'processing'
                ) {
                  statuses.set(key, 'running');
                  return;
                }
                statuses.set(key, 'created');
              }.bind(this)
            )
          )
        )
      );
      return statuses;
    }.bind(this),
    restoreCause
  );
  reconcileItem = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      operation: StoredLodyOperation,
      item: LodyOperationItemResult,
      index: number,
      isAtDeadline: () => boolean,
      signal: { readonly aborted: boolean }
    ): Effect.fn.Return<LodyOperationItemResult, unknown> {
      if (item.status !== 'active') return item;
      if (signal.aborted) return item;
      const target = item.target;
      if (!item.inputDurable) {
        let alreadyMaterialized = unwrapExit(
          yield* Effect.exit(this.isTargetInputDurable(target.sessionId, target.userTurnId))
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
          const claim = unwrapExit(
            yield* Effect.exit(
              this.operations.claimItemMaterialization(
                operation.requesterSessionId,
                operation.operationId,
                index,
                this.materializationClaimToken
              )
            )
          );
          if (!claim.claimed) {
            if (claim.retryAtMs !== undefined) {
              unwrapExit(
                yield* Effect.exit(this.armMaterializationRetry(operation, index, claim.retryAtMs))
              );
            }
            return item;
          }
          claimedMaterialization = true;
          try {
            const reason = `orchestration.materialize:${operation.operationId}:${index}`;
            unwrapExit(yield* Effect.exit(this.ports.confirmReadable(target.sessionId, reason)));
          } catch (error) {
            if (signal.aborted) return item;
            if (!isAtDeadline()) {
              const delayMs = unwrapExit(
                yield* Effect.exit(this.armMaterializationFailureRetry(operation, index))
              );
              unwrapExit(
                yield* Effect.exit(
                  this.ports.warn(
                    `[orchestration] Target document catch-up was not confirmed ` +
                      `(${operation.operationId}:${index}); retrying in ${delayMs}ms: ${
                        error instanceof Error ? error.message : String(error)
                      }`
                  )
                )
              );
              return item;
            }
          }
          if (signal.aborted) return item;
          alreadyMaterialized = unwrapExit(
            yield* Effect.exit(this.isTargetInputDurable(target.sessionId, target.userTurnId))
          );
        }
        if (!alreadyMaterialized && !isAtDeadline()) {
          try {
            unwrapExit(yield* Effect.exit(this.ports.materialize(operation, item, index)));
          } catch (error) {
            if (signal.aborted) return item;
            const delayMs = unwrapExit(
              yield* Effect.exit(this.armMaterializationFailureRetry(operation, index))
            );
            unwrapExit(
              yield* Effect.exit(
                this.ports.warn(
                  `[orchestration] Target materialization failed ` +
                    `(${operation.operationId}:${index}); retrying in ${delayMs}ms: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                )
              )
            );
            return item;
          }
          if (signal.aborted) return item;
          alreadyMaterialized = true;
        }
        if (!alreadyMaterialized) {
          unwrapExit(yield* Effect.exit(this.clearMaterializationRetry(operation, index)));
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
        const materializedOperation = unwrapExit(
          yield* Effect.exit(
            this.operations.markItemInputDurable(
              operation.requesterSessionId,
              operation.operationId,
              index,
              claimedMaterialization ? this.materializationClaimToken : undefined
            )
          )
        );
        // Publish each recovered child without waiting for slower batch siblings.
        unwrapExit(yield* Effect.exit(this.writeOperationProgress(materializedOperation)));
        unwrapExit(yield* Effect.exit(this.clearMaterializationRetry(operation, index)));
        item = { ...item, inputDurable: true };
      }
      const metaRecord = unwrapExit(yield* Effect.exit(this.ports.metadata(item.target.sessionId)));
      if (!metaRecord?.meta) {
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
      const sessionDoc = unwrapExit(yield* Effect.exit(this.ports.session(item.target.sessionId)));
      const backend = sessionDoc;
      unwrapExit(yield* Effect.exit(this.subscribeTarget(item.target.sessionId, backend)));
      const targetOutput = unwrapExit(
        yield* Effect.exit(backend.readTurnOutput(item.target.userTurnId))
      );
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
    }.bind(this),
    restoreCause
  );
  isTargetInputDurable = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      sessionId: SessionId,
      userTurnId: string
    ): Effect.fn.Return<boolean, unknown> {
      const metaRecord = unwrapExit(yield* Effect.exit(this.ports.metadata(sessionId)));
      if (!metaRecord?.meta) {
        return false;
      }
      const sessionDoc = unwrapExit(yield* Effect.exit(this.ports.session(sessionId)));
      const backend = sessionDoc;
      const output = unwrapExit(yield* Effect.exit(backend.readTurnOutput(userTurnId)));
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
    }.bind(this),
    restoreCause
  );
  subscribeTarget = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, id: SessionId, history: CoordinatorHistory) {
      if (!this.started || this.subscriptions.has(id)) return;
      const detach = yield* history.observe(this.activity.signal('target-history'));
      this.subscriptions.set(id, detach);
      yield* Scope.addFinalizer(this.scope, detach);
    }.bind(this)
  );
  armMaterializationRetry = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      op: StoredLodyOperation,
      index: number,
      at: number,
      reason = 'materialization-claim-expired'
    ) {
      yield* this.activity.arm(this.materializationKey(op, index), at - this.now(), reason);
    }.bind(this)
  );
  armMaterializationFailureRetry = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, op: StoredLodyOperation, index: number) {
      const key = this.materializationKey(op, index);
      const attempt = Math.min(this.materializationRetryAttempts.get(key) ?? 0, 5);
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      this.materializationRetryAttempts.set(key, attempt + 1);
      const now = this.now();
      const at = Math.min(now + delay, Date.parse(op.deadlineAt));
      yield* this.armMaterializationRetry(op, index, at, 'materialization-retry');
      return Math.max(0, at - now);
    }.bind(this)
  );
  clearMaterializationRetry = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, op: StoredLodyOperation, index: number) {
      const key = this.materializationKey(op, index);
      yield* this.activity.cancel(key);
      this.materializationRetryAttempts.delete(key);
    }.bind(this)
  );
  clearOperationMaterializationRetries = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, op: StoredLodyOperation) {
      const prefix = 'material:' + this.operationKey(op) + '\0';
      yield* this.activity.cancelWhere((key) => key.startsWith(prefix));
      for (const key of this.materializationRetryAttempts.keys())
        if (key.startsWith(prefix)) this.materializationRetryAttempts.delete(key);
    }.bind(this)
  );
  dropInactiveResources = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, keys: Set<string>) {
      yield* this.activity.cancelWhere((key) =>
        key.startsWith('deadline:')
          ? !keys.has(key.slice(9))
          : key.startsWith('material:') &&
            ![...keys].some((op) => key.startsWith('material:' + op + '\0'))
      );
      yield* this.ports.cancelInactive(keys);
    }.bind(this)
  );
}

export class CoordinatorScope extends Context.Service<
  CoordinatorScope,
  { core: CoordinatorWorkflow; activity: CoordinatorActivity['Service'] }
>()('lody/orchestration/Coordinator') {
  static layer(options: { workspaceId: WorkspaceId; machineId: MachineId }) {
    return Layer.unwrap(
      Effect.gen(function* () {
        const outerPorts = yield* CoordinatorPorts;
        let core: CoordinatorWorkflow;
        const activityLayer = CoordinatorActivity.layer(
          (reason) => Effect.suspend(() => core.reconcile(reason)),
          (cause) => outerPorts.warn('Coordinator reconciliation failed', cause)
        );
        return Layer.effect(
          CoordinatorScope,
          Effect.gen(function* () {
            const ports = yield* CoordinatorPorts;
            const operations = yield* OperationRepository;
            const activity = yield* CoordinatorActivity;
            const scope = yield* Effect.scope;
            core = new CoordinatorWorkflow(options, ports, operations, activity, scope);
            return { core, activity };
          })
        ).pipe(Layer.provideMerge(activityLayer));
      })
    );
  }
}
