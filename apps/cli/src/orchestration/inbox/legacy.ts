import { withTimeout } from '@/lib/loro/timeout-utils';
import { Exit } from 'effect';
import { InboxRecoveryProbe } from './recovery';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { InboxExecution, OperationInbox, inboxRepositoryLayer } from './service';
import type { InboxSqlite } from './sqlite';
import type { InboxBatch, InboxInput, InboxRelease, InboxScope } from './model';

export type OperationInboxLegacy = ReturnType<typeof operationInboxLegacy>;
/** One host-lease bridge. Consumers: coordinator; dispatch, Stop, prompt and release hooks. */
export const operationInboxLegacy = (options: {
  workspaceId: string;
  owner: string;
  sql: InboxSqlite;
  ready(batch: InboxBatch): boolean;
  admit(batch: InboxBatch): boolean;
  launch(batch: InboxBatch): Promise<void>;
  report(cause: unknown): void;
  quiesce?(): void;
  openRecoveryRepository?(): { sql: InboxSqlite; close(): void };
}) => {
  const dependencies = Layer.merge(
    inboxRepositoryLayer(options.sql, true),
    Layer.succeed(InboxExecution, {
      ready: options.ready,
      quiesce: options.quiesce,
      admit: options.admit,
      launch: (batch) =>
        Effect.tryPromise({ try: () => options.launch(batch), catch: (cause) => cause }),
      report: (cause) => Effect.sync(() => options.report(cause)),
    })
  );
  const runtime = ManagedRuntime.make(
    OperationInbox.layer(options.workspaceId, options.owner).pipe(Layer.provide(dependencies))
  );
  const service = runtime.runPromise(OperationInbox);
  void service.catch(options.report);
  let shutdown: Promise<void> | undefined;
  let recoveredClose: Promise<void> | undefined;
  let closingRaw: Promise<void> | undefined;
  const recovery = runtime.runPromise(
    Effect.gen(function* () {
      const probe = yield* InboxRecoveryProbe;
      for (const handle of options.sql.unreleased(options.workspaceId)) {
        const gone = yield* probe
          .released(handle.identity)
          .pipe(Effect.catch(() => Effect.succeed(false)));
        if (gone)
          yield* Effect.try({
            try: () => options.sql.confirmReleased(handle.scope, handle.executionId),
            catch: (cause) => cause,
          });
      }
    }).pipe(Effect.provide(InboxRecoveryProbe.layer))
  );
  void recovery.catch(options.report);
  return {
    adopt: (p: InboxInput, n: InboxInput, id: string, update: () => void) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.adopt(p, n, id, update))),
    quiesce: () => runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.quiesce)),
    cancelExecution: (scope: InboxScope, id: string) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.cancelExecution(scope, id))),
    wake: () => runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.wake)),
    accept: (input: InboxInput) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.accept(input))),
    begin: (scope: InboxScope, id: string) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.begin(scope, id))),
    pause: (scope: InboxScope, id: string, ids?: readonly string[], cancelId?: string) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.pause(scope, id, ids, cancelId))),
    prepare: (input: InboxInput) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.prepare(input))),
    release: (event: InboxRelease) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.release(event))),
    submit: <A>(batch: InboxBatch | undefined, scope: InboxScope, id: string, start: () => A) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.submit(batch, scope, id, start))),
    settle: (batch: InboxBatch, outcome: 'submitted' | 'unknown' | 'settled', cause?: string) =>
      runtime.runPromise(Effect.flatMap(OperationInbox, (i) => i.settle(batch, outcome, cause))),
    recoverClose: () => {
      if (!closingRaw) return Promise.resolve();
      if (recoveredClose) return recoveredClose;
      const attempt = (async () => {
        await withTimeout(
          closingRaw!.catch(() => undefined),
          10_000,
          'Inbox Scope release remains unresolved'
        );
        const recoveryStore = options.openRecoveryRepository?.();
        if (!recoveryStore) throw new Error('Inbox recovery repository is unavailable');
        try {
          const inbox = await service;
          await Effect.runPromise(
            inbox.recoverSettlements(
              (batch, outcome, receiptCause) =>
                Effect.try({
                  try: () => recoveryStore.sql.settle(batch, outcome, receiptCause),
                  catch: (failure) => failure,
                }),
              (event) =>
                Effect.try({
                  try: () => recoveryStore.sql.release(event),
                  catch: (cause) => cause,
                }),
              (scope, id, ids, cancelId) =>
                Effect.try({
                  try: () => recoveryStore.sql.pause(scope, id, ids, cancelId),
                  catch: (cause) => cause,
                })
            )
          );
        } finally {
          recoveryStore.close();
        }
        options.sql.closeConnection();
      })();
      recoveredClose = attempt;
      void attempt.catch(() => {
        if (recoveredClose === attempt) recoveredClose = undefined;
      });
      return attempt;
    },
    close: () =>
      recoveredClose ??
      (shutdown ??= (async () => {
        await recovery.catch(options.report);
        closingRaw = Effect.runPromiseExit(runtime.disposeEffect).then((exit) => {
          if (Exit.isFailure(exit))
            throw new Error('Inbox Scope release failed', { cause: exit.cause });
        });
        await withTimeout(closingRaw, 10_000, 'Inbox Scope release timed out');
      })()),
  };
};
