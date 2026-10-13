import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Context, Deferred, Effect, Fiber, Layer } from 'effect';
import { LodyOperationStore } from '../operation-store';
import { InboxExecution, InboxRepository, OperationInbox, inboxRepositoryLayer } from './service';
import {
  batchDepth,
  batchPreview,
  INBOX_PREVIEW_BYTES,
  type InboxInput,
  type InboxRelease,
} from './model';
import type { MachineId, SessionId, WorkspaceId } from '@lody/shared';

const roots: string[] = [];
const stores: LodyOperationStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fixture(now?: () => number) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lody-inbox-'));
  roots.push(root);
  const filename = path.join(root, 'operations.sqlite3');
  const store = new LodyOperationStore(filename, now);
  stores.push(store);
  const input: InboxInput = {
    workspaceId: 'workspace',
    sessionId: 'A',
    userId: 'human',
    inputId: 'user-1',
    kind: 'human',
    config: { prompt: 'current human request', chainDepth: 0 },
  };
  const sql = store.inbox;
  sql.activate(input.workspaceId, 'owner');
  const add = (id: string, depth = 0) => {
    store.accept({
      workspaceId: input.workspaceId as WorkspaceId,
      ownerMachineId: 'machine' as MachineId,
      requesterSessionId: input.sessionId as SessionId,
      requesterUserId: input.userId,
      operationId: id,
      kind: 'session_chat',
      canonicalCommand: { operationId: id },
      frozenContinuationConfig: {
        sourceTurnId: 'source',
        inputConfig: { prompt: 'obsolete prompt' },
      },
      initiatorChainDepth: depth,
      createdAt: '2026-10-12T00:00:00.000Z',
      deadlineAt: '2026-10-13T00:00:00.000Z',
      items: [],
    });
    store.finish(input.sessionId as SessionId, id, { type: 'result', value: { items: [] } });
  };
  const release = (outcome: InboxRelease['outcome'] = 'normal', executionId = 'execution-1') =>
    sql.release({ ...input, executionId, outcome });
  const start = () => {
    expect(sql.accept(input)).toBe(true);
    expect(sql.begin(input, 'execution-1')).toBe(true);
  };
  return { root, filename, store, sql, input, add, release, start };
}

async function runInboxChild(root: string, source: string): Promise<string> {
  const child = path.join(root, 'recover.mts');
  writeFileSync(child, source);
  const cliRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', path.join(cliRoot, 'node_modules/tsx/dist/loader.mjs'), child],
    {
      cwd: cliRoot,
      timeout: 20000,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(cliRoot, 'tsconfig.json') },
    }
  );
  return stdout;
}

describe('durable Operation inbox', () => {
  it('records an empty boundary; late completion and duplicate release never create a wake', () => {
    const f = fixture();
    f.start();
    f.release();
    f.add('late');
    f.release();
    expect(f.sql.pending('workspace')).toEqual([]);
    const second = new LodyOperationStore(f.filename);
    stores.push(second);
    second.inbox.activate('workspace', 'replacement');
    expect(second.inbox.pending('workspace')).toEqual([]);
    const input = { ...f.input, inputId: 'fresh' };
    second.inbox.accept(input);
    expect(second.inbox.prepare(input, 'replacement')?.memberCount).toBe(1);
  });
  it('keeps eight arrivals passive until one normal release and one fixed batch', () => {
    const f = fixture();
    f.start();
    for (let n = 0; n < 8; n++) f.add(`result-${n}`);
    expect(f.sql.pending('workspace')).toEqual([]);
    f.release();
    const [intent] = f.sql.pending('workspace');
    f.add('late-nine');
    f.release();
    const batch = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    expect(batch.memberCount).toBe(8);
    expect(f.sql.members(batch).map((x) => x.operationId)).toEqual(
      Array.from({ length: 8 }, (_, n) => `result-${n}`)
    );
    expect(f.sql.begin(batch, 'automatic')).toBe(true);
    expect(f.sql.fence(batch, 'automatic')).toBe(true);
    f.sql.settle(batch, 'settled');
    f.sql.release({ ...batch, executionId: 'automatic', outcome: 'normal' });
    expect(f.sql.pending('workspace').map((x) => x.input.inputId)).toEqual(['inbox:automatic']);
  });
  it('does not launch an empty successor after all eight results are consumed', () => {
    const f = fixture();
    f.start();
    for (let n = 0; n < 8; n++) f.add(`result-${n}`);
    f.release();
    const [intent] = f.sql.pending('workspace');
    const b = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    f.sql.begin(b, 'auto');
    expect(f.sql.fence(b, 'auto')).toBe(true);
    f.sql.settle(b, 'settled');
    f.sql.release({ ...b, executionId: 'auto', outcome: 'normal' });
    expect(f.sql.pending('workspace')).toEqual([]);
  });
  it('reopens a pending released intent without any new event and excludes the ninth', () => {
    const f = fixture();
    f.start();
    f.add('one');
    f.release();
    f.add('late');
    const other = new LodyOperationStore(f.filename);
    stores.push(other);
    other.inbox.activate('workspace', 'new-owner');
    const [intent] = other.inbox.pending('workspace');
    const b = other.inbox.prepare(intent.input, 'new-owner', intent.intentId)!;
    expect(other.inbox.members(b).map((x) => x.operationId)).toEqual(['one']);
  });
  it('atomically settles an intent that lost its eligible members without creating an empty batch', () => {
    const f = fixture();
    f.start();
    f.add('one');
    f.release();
    const [intent] = f.sql.pending('workspace');
    const db = new Database(f.filename);
    db.prepare('UPDATE inbox_results SET consumed=1').run();
    db.close();
    expect(f.sql.prepare(intent.input, 'owner', intent.intentId)).toBeUndefined();
    expect(f.sql.pending('workspace')).toEqual([]);
  });
  it('Stop keeps old queued input canceled and only a fresh human receipt clears pause', () => {
    const f = fixture();
    f.start();
    const queued = { ...f.input, inputId: 'queued-before-stop' };
    f.sql.accept(queued);
    f.add('one');
    expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
    f.release('user_stop');
    expect(f.sql.accept(queued)).toBe(false);
    expect(f.sql.accept({ ...f.input, kind: 'task', inputId: 'agent-message' })).toBe(false);
    const human = { ...f.input, inputId: 'fresh-human' };
    expect(f.sql.accept(human)).toBe(true);
    expect(f.sql.prepare(human, 'owner')?.memberCount).toBe(1);
  });
  it('Stop still targets running execution after newer input is accepted', () => {
    const f = fixture();
    f.start();
    f.sql.accept({ ...f.input, inputId: 'queued-new' });
    expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
    expect(f.sql.pause(f.input, 'stale')).toBe(false);
  });
  it('fresh human identity and depth are independent of attached old results', () => {
    const f = fixture();
    f.add('old-deep', 15);
    f.sql.accept(f.input);
    const b = f.sql.prepare(f.input, 'owner')!;
    expect(b.chainDepth).toBe(0);
    expect(b.config.prompt).toBe('current human request');
    expect(f.sql.members(b)[0].chainDepth).toBe(15);
    expect(batchDepth({ ...f.input, kind: 'automatic' }, [15])).toBe(16);
  });
  it('a newer human acceptance invalidates automatic preparation before submission', () => {
    const f = fixture();
    f.start();
    f.add('one');
    f.release();
    const [intent] = f.sql.pending('workspace');
    const auto = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    const human = { ...f.input, inputId: 'new-user' };
    f.sql.accept(human);
    const merged = f.sql.prepare(human, 'owner')!;
    expect(f.sql.getBatch(auto.batchId, auto)?.state).toBe('superseded');
    expect(f.sql.begin(merged, 'new-exec')).toBe(true);
    expect(f.sql.fence(auto, 'new-exec')).toBe(false);
    expect(f.sql.fence(merged, 'new-exec')).toBe(true);
    expect(f.sql.members(merged)).toHaveLength(1);
  });
  it('two SQLite connections preserve one claim, and unknown never becomes resubmittable after reopen', () => {
    const f = fixture();
    f.add('one');
    f.sql.accept(f.input);
    const b = f.sql.prepare(f.input, 'owner')!;
    const other = new LodyOperationStore(f.filename);
    stores.push(other);
    expect(other.inbox.prepare({ ...f.input, inputId: 'racing' }, 'owner')).toBeUndefined();
    f.sql.begin(f.input, 'exec');
    expect(f.sql.fence(b, 'exec')).toBe(true);
    f.sql.settle(b, 'unknown', 'disconnect');
    other.inbox.activate('workspace', 'new-owner');
    expect(other.inbox.getBatch(b.batchId, b)?.state).toBe('unknown');
    expect(other.inbox.prepare(f.input, 'new-owner')).toBeUndefined();
    expect(other.inbox.fence(b, 'exec')).toBe(false);
    expect(
      (other as unknown as { db: Database.Database }).db
        .prepare("SELECT consumed FROM inbox_results WHERE session_id='A' AND operation_id='one'")
        .get()
    ).toEqual({ consumed: 1 });
  });
  it('retains failed and unreleased state without granting automatic continuation', () => {
    for (const outcome of ['failed', 'unreleased'] as const) {
      const f = fixture();
      f.start();
      f.add('one');
      f.release(outcome);
      expect(f.sql.pending('workspace')).toEqual([]);
      if (outcome === 'unreleased') expect(f.sql.begin(f.input, 'successor')).toBe(false);
    }
  });
  it('denies foreign batch lookup and has no per-result execution tables', () => {
    const f = fixture();
    f.add('one');
    f.sql.accept(f.input);
    const b = f.sql.prepare(f.input, 'owner')!;
    expect(f.sql.getBatch(b.batchId, { ...f.input, userId: 'foreign' })).toBeUndefined();
    const db = new Database(f.filename);
    try {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('deliveries','delivery_execution_state')"
          )
          .all()
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('index insertion rolls back with the real completion transaction', () => {
    const f = fixture();
    const db = new Database(f.filename);
    db.exec(
      "CREATE TRIGGER reject_index BEFORE INSERT ON inbox_results BEGIN SELECT RAISE(ABORT,'injected completion failure'); END;"
    );
    expect(() => f.add('atomic')).toThrow('injected completion failure');
    expect(f.store.get('A' as SessionId, 'atomic').state).toBe('active');
    expect(db.prepare('SELECT * FROM inbox_results').all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='deliveries'").all()).toEqual([]);
    db.close();
  });
  it('native service submits user-plus-results under the same admission as Stop', async () => {
    const f = fixture();
    f.add('one');
    const received: string[] = [];
    const deps = Layer.merge(
      inboxRepositoryLayer(f.sql),
      Layer.succeed(InboxExecution, {
        ready: () => true,
        admit: () => true,
        launch: () => Effect.void,
        report: () => Effect.void,
      })
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* OperationInbox;
          yield* inbox.accept(f.input);
          yield* inbox.begin(f.input, 'exec');
          const b = yield* inbox.prepare(f.input);
          yield* inbox.pause(f.input, 'exec');
          const denied = yield* Effect.exit(
            inbox.submit(b, f.input, 'exec', () => received.push('user+result'))
          );
          expect(denied._tag).toBe('Failure');
          expect(received).toEqual([]);
          expect(f.sql.getBatch(b!.batchId, f.input)?.state).toBe('superseded');
        }).pipe(
          Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
        )
      )
    );
  });
  it('uses one execution slot across requester identities and cannot bypass pause by changing user', () => {
    const f = fixture();
    f.start();
    const other = { ...f.input, userId: 'other', inputId: 'other-task', kind: 'task' as const };
    expect(f.sql.accept(other)).toBe(true);
    expect(f.sql.begin(other, 'overlap')).toBe(false);
    f.sql.pause(f.input, 'execution-1');
    f.release('user_stop');
    expect(f.sql.accept({ ...other, inputId: 'after-stop' })).toBe(false);
    const fresh = { ...other, inputId: 'fresh-human', kind: 'human' as const };
    expect(f.sql.accept(fresh)).toBe(true);
    expect(f.sql.begin(fresh, 'new-owner')).toBe(true);
  });
  it('rolls back the entire automatic-to-human transfer when a member write fails', () => {
    const f = fixture();
    f.start();
    f.add('one');
    f.release();
    const [intent] = f.sql.pending('workspace');
    const automatic = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    const db = new Database(f.filename);
    db.exec(
      `CREATE TRIGGER fail_transfer BEFORE INSERT ON inbox_members WHEN NEW.batch_id <> '${automatic.batchId}' BEGIN SELECT RAISE(ABORT,'transfer failed'); END;`
    );
    const human = { ...f.input, inputId: 'new-human' };
    expect(() => f.sql.accept(human)).toThrow('transfer failed');
    expect(f.sql.getBatch(automatic.batchId, automatic)?.state).toBe('prepared');
    expect(db.prepare('SELECT claim FROM inbox_results').get()).toEqual({
      claim: automatic.batchId,
    });
    expect(f.sql.inputKind(human, human.inputId)).toBeUndefined();
    db.exec('DROP TRIGGER fail_transfer');
    db.close();
    f.sql.accept(human);
    const replacement = f.sql.prepare(human, 'owner')!;
    expect(replacement.memberCount).toBe(1);
    expect(f.sql.getBatch(automatic.batchId, automatic)?.state).toBe('superseded');
  });
  it('startup native worker recovers one fixed batch without injecting any new event', async () => {
    const f = fixture();
    f.start();
    for (let n = 0; n < 8; n++) f.add(`saved-${n}`);
    f.release();
    f.add('late-nine');
    const received: Array<{ batchId: string; ids: string[] }> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          const execution = Layer.succeed(InboxExecution, {
            ready: () => true,
            admit: () => true,
            report: () => Effect.void,
            launch: (batch) =>
              Effect.gen(function* () {
                const repo = yield* InboxRepository;
                expect(yield* repo.begin(batch, 'recovered')).toBe(true);
                expect(yield* repo.fence(batch, 'recovered')).toBe(true);
                received.push({
                  batchId: batch.batchId,
                  ids: f.sql.members(batch).map((m) => m.operationId),
                });
                yield* repo.settle(batch, 'settled');
                yield* Deferred.succeed(done, undefined);
              }).pipe(Effect.provide(inboxRepositoryLayer(f.sql))),
          });
          const layer = OperationInbox.layer('workspace', 'owner').pipe(
            Layer.provide(Layer.merge(inboxRepositoryLayer(f.sql), execution))
          );
          yield* Effect.gen(function* () {
            yield* OperationInbox;
            yield* Deferred.await(done);
          }).pipe(Effect.provide(layer));
          expect(received).toHaveLength(1);
          expect(received[0].ids).toEqual(Array.from({ length: 8 }, (_, n) => `saved-${n}`));
        })
      )
    );
  });
  it('a failed pause write vetoes even batch-free transport admission', async () => {
    const f = fixture();
    const db = new Database(f.filename);
    const received: string[] = [];
    const deps = Layer.merge(
      inboxRepositoryLayer(f.sql),
      Layer.succeed(InboxExecution, {
        ready: () => true,
        admit: () => true,
        launch: () => Effect.void,
        report: () => Effect.void,
      })
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const inbox = yield* OperationInbox;
            yield* inbox.accept(f.input);
            yield* inbox.begin(f.input, 'exec');
            db.exec(
              "CREATE TRIGGER fail_pause BEFORE UPDATE OF paused ON inbox_sessions WHEN NEW.paused=1 BEGIN SELECT RAISE(ABORT,'pause write failed'); END;"
            );
            const stopped = yield* Effect.exit(inbox.pause(f.input, 'exec'));
            expect(stopped._tag).toBe('Failure');
            const submission = yield* Effect.exit(
              inbox.submit(undefined, f.input, 'exec', () => received.push('unexpected'))
            );
            expect(submission._tag).toBe('Failure');
            expect(received).toEqual([]);
            db.exec('DROP TRIGGER fail_pause');
            // A later Stop succeeds first; retain the earlier failed request's identity too.
            yield* inbox.pause(f.input, 'exec', [], 'second-stop');
            const fresh = { ...f.input, inputId: 'new-human-after-failed-stop' };
            yield* inbox.accept(fresh);
            expect(f.sql.inputCanceled('workspace', 'A', f.input.inputId)).toBe(true);
            expect(f.sql.inputCanceled('workspace', 'A', fresh.inputId)).toBe(false);
            expect(yield* inbox.pause(f.input, 'exec')).toBe(true);
            expect(f.sql.inputCanceled('workspace', 'A', fresh.inputId)).toBe(false);
            expect(
              (yield* Effect.exit(
                inbox.submit(undefined, f.input, 'exec', () => received.push('old'))
              ))._tag
            ).toBe('Failure');
            yield* inbox.release({ ...f.input, executionId: 'exec', outcome: 'user_stop' });
            expect(yield* inbox.begin(fresh, 'fresh-exec')).toBe(true);
            yield* inbox.submit(undefined, fresh, 'fresh-exec', () => received.push('fresh'));
            expect(received).toEqual(['fresh']);
          }).pipe(
            Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
          )
        )
      );
    } finally {
      db.close();
    }
  });
});

describe('Inbox recovery and retained settlement', () => {
  it('keeps an unreleased immutable execution blocked across human acceptance and reopen', () => {
    const f = fixture();
    f.start();
    f.sql.registerResources(f.input, 'execution-1', { platform: 'darwin', roots: [123] });
    f.add('saved');
    f.sql.release({
      ...f.input,
      executionId: 'execution-1',
      outcome: 'unreleased',
      cause: 'termination failed',
    });
    const reopened = new LodyOperationStore(f.filename);
    stores.push(reopened);
    reopened.inbox.activate('workspace', 'next-owner');
    const fresh = { ...f.input, inputId: 'new-human' };
    expect(reopened.inbox.accept(fresh)).toBe(true);
    expect(reopened.inbox.begin(fresh, 'successor', 'next-owner')).toBe(false);
    expect(reopened.inbox.pending('workspace')).toEqual([]);
    expect(reopened.inbox.unreleased('workspace')).toMatchObject([
      { executionId: 'execution-1', identity: { roots: [123] } },
    ]);
    reopened.inbox.confirmReleased(fresh, 'wrong-execution');
    expect(reopened.inbox.begin(fresh, 'successor', 'next-owner')).toBe(false);
    reopened.inbox.confirmReleased(fresh, 'execution-1');
    expect(reopened.inbox.begin(fresh, 'successor', 'next-owner')).toBe(true);
    expect(reopened.inbox.prepare(fresh, 'next-owner')?.memberCount).toBe(1);
  });

  it('applied human steer transfers authority without changing the actual execution identity', () => {
    const f = fixture();
    f.start();
    f.add('one');
    const next = {
      ...f.input,
      inputId: 'steered-user',
      config: { prompt: 'new request', chainDepth: 0 },
    };
    expect(f.sql.adoptExecution(f.input, next, 'execution-1')).toBe(true);
    expect(f.sql.canSubmit(next, 'execution-1', 'owner')).toBe(true);
    expect(f.sql.pause(next, 'display-assistant-2')).toBe(false);
    expect(f.sql.pause(next, 'execution-1')).toBe(true);
    f.sql.release({ ...next, executionId: 'execution-1', outcome: 'user_stop' });
    expect(f.sql.pending('workspace')).toEqual([]);
    expect(f.sql.inputCanceled(next.workspaceId, next.sessionId, next.inputId)).toBe(true);
  });

  it('retains a failed settlement and retries only its SQL receipt after the outage', async () => {
    const f = fixture();
    f.add('one');
    const db = new Database(f.filename);
    const submitted: string[] = [];
    const deps = Layer.merge(
      inboxRepositoryLayer(f.sql),
      Layer.succeed(InboxExecution, {
        ready: () => true,
        admit: () => true,
        launch: () => Effect.void,
        report: () => Effect.void,
      })
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const inbox = yield* OperationInbox;
            yield* inbox.accept(f.input);
            yield* inbox.begin(f.input, 'exec');
            const b = (yield* inbox.prepare(f.input))!;
            yield* inbox.submit(b, f.input, 'exec', () => submitted.push(b.batchId));
            db.exec(
              "CREATE TRIGGER fail_settle BEFORE UPDATE OF state ON inbox_batches WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'settlement outage'); END;"
            );
            yield* inbox.settle(b, 'settled');
            expect(f.sql.getBatch(b.batchId, b)?.state).toBe('submitting');
            db.exec('DROP TRIGGER fail_settle');
            // Scope finalization flushes the retained receipt without executing transport.
          }).pipe(
            Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
          )
        )
      );
      const [batch] = db.prepare('SELECT batch_id,state FROM inbox_batches').all() as {
        batch_id: string;
        state: string;
      }[];
      expect(batch.state).toBe('settled');
      expect(submitted).toEqual([batch.batch_id]);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM inbox_results WHERE consumed=0').get()
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('does not lose the next natural-release signal while the prior launch is still returning', async () => {
    const f = fixture();
    f.start();
    f.add('first');
    f.release();
    const received: string[][] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          let inbox: Context.Service.Shape<typeof OperationInbox>;
          const execution = Layer.succeed(InboxExecution, {
            ready: () => true,
            admit: () => true,
            report: () => Effect.void,
            launch: (batch) =>
              Effect.gen(function* () {
                yield* Deferred.await(ready);
                const id = `auto-${received.length}`;
                expect(yield* inbox.begin(batch, id)).toBe(true);
                yield* inbox.submit(batch, batch, id, () =>
                  received.push(f.sql.members(batch).map((m) => m.operationId))
                );
                yield* inbox.settle(batch, 'settled');
                if (received.length === 1) f.add('second');
                yield* inbox.release({ ...batch, executionId: id, outcome: 'normal' });
                if (received.length === 2) yield* Deferred.succeed(done, undefined);
              }),
          });
          yield* Effect.gen(function* () {
            inbox = yield* OperationInbox;
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(done);
          }).pipe(
            Effect.provide(
              OperationInbox.layer('workspace', 'owner').pipe(
                Layer.provide(Layer.merge(inboxRepositoryLayer(f.sql), execution))
              )
            )
          );
        })
      )
    );
    expect(received).toEqual([['first'], ['second']]);
    expect(f.sql.pending('workspace')).toEqual([]);
  });
});

it('requires proof of resource disappearance and never treats PID reuse or empty roots as release', async () => {
  const { provesResourcesGone } = await import('./recovery');
  const snapshot = { sampledAtMs: 0, memoryKind: 'rss-sum' as const, entries: [], warnings: [] };
  expect(provesResourcesGone({ platform: 'darwin', roots: [123], complete: true }, snapshot)).toBe(
    true
  );
  expect(provesResourcesGone({ platform: 'darwin', roots: [], complete: true }, snapshot)).toBe(
    false
  );
  expect(provesResourcesGone({ platform: 'win32', roots: [123], complete: true }, snapshot)).toBe(
    false
  );
  expect(provesResourcesGone({ platform: 'darwin', roots: [123] }, snapshot)).toBe(false);
  expect(provesResourcesGone({ platform: 'darwin', roots: [123], complete: false }, snapshot)).toBe(
    false
  );
  const child = {
    pid: 456,
    parentPid: 1,
    processGroupId: 123,
    startedAtMs: 99,
    cpuTimeMicros: 0,
    memoryBytes: 1,
  };
  expect(
    provesResourcesGone(
      { platform: 'darwin', roots: [123], complete: true },
      { ...snapshot, entries: [child] }
    )
  ).toBe(false);
  expect(
    provesResourcesGone(
      { platform: 'darwin', roots: [456], complete: true },
      { ...snapshot, entries: [child] }
    )
  ).toBe(false);
});

it.skipIf(process.platform === 'win32')(
  'persists terminal groups added after prompt start and blocks reopen until all groups are gone',
  async () => {
    const { createSessionSandboxFactory } = await import('@/session/session-sandbox');
    const { provesResourcesGone } = await import('./recovery');
    const sandbox = await createSessionSandboxFactory({
      logger: { debug: () => {}, warn: () => {} } as import('@/utils/logger').Logger,
      // Exercise the same POSIX noop groups on macOS/Linux without depending on
      // whether the test machine grants cgroup administration.
      deps: { platform: 'darwin', configureExecutionProcess: async () => {} },
    })('resource-reopen' as SessionId);
    const launch = async () => {
      const handle = await sandbox.spawn(
        process.execPath,
        ['-e', 'process.stdin.resume();process.stdout.write("ready")'],
        { captureOutput: true }
      );
      await new Promise<void>((resolve) => handle.onStdout(() => resolve()));
      return handle;
    };
    const f = fixture();
    f.start();
    const acp = await launch();
    const detach = await sandbox.watchRecoveryResources!((identity) =>
      f.sql.registerResources(f.input, 'execution-1', {
        platform: process.platform,
        ...identity,
        roots: [process.pid, ...identity.roots],
      })
    );
    try {
      const terminal = await launch();
      const exited = new Promise<void>((resolve) => acp.onExit(() => resolve()));
      acp.child.stdin!.end();
      await exited;
      const second = new LodyOperationStore(f.filename);
      stores.push(second);
      second.inbox.activate('workspace', 'replacement');
      const [handle] = second.inbox.unreleased('workspace');
      expect(handle!.identity).toMatchObject({ complete: true });
      expect(handle!.identity.roots).toEqual(
        expect.arrayContaining([acp.child.pid, terminal.child.pid])
      );
      // A real independently spawned group remains after the ACP leader exits.
      expect(process.kill(-terminal.child.pid!, 0)).toBe(true);
      const snapshot = {
        sampledAtMs: 0,
        memoryKind: 'rss-sum' as const,
        warnings: [],
        entries: [
          {
            pid: terminal.child.pid!,
            parentPid: process.pid,
            processGroupId: terminal.child.pid!,
            startedAtMs: 0,
            cpuTimeMicros: 0,
            memoryBytes: 0,
          },
        ],
      };
      expect(provesResourcesGone(handle!.identity, snapshot)).toBe(false);
      const fresh = { ...f.input, inputId: 'successor-input' };
      second.inbox.accept(fresh);
      expect(second.inbox.begin(fresh, 'successor', 'replacement')).toBe(false);
      await sandbox.terminate(true);
      const host = { ...snapshot.entries[0]!, pid: process.pid, processGroupId: process.pid };
      expect(provesResourcesGone(handle!.identity, { ...snapshot, entries: [host] })).toBe(false);
      expect(provesResourcesGone(handle!.identity, { ...snapshot, entries: [] })).toBe(true);
      second.inbox.confirmReleased(handle!.scope, handle!.executionId);
      expect(second.inbox.begin(fresh, 'successor', 'replacement')).toBe(true);
    } finally {
      detach();
      await sandbox.cleanup();
    }
  }
);

it('reads an oversized member in bounded fragments without dropping any result bytes', async () => {
  const { batchPage, INBOX_READ_BYTES } = await import('./batch-page');
  const member = {
    sequence: 1,
    operationId: 'large',
    operationKind: 'session_chat' as const,
    chainDepth: 0,
    completion: { text: '中文😀'.repeat(40_000) },
  };
  let offset = 0;
  let restored = '';
  let pageCount = 0;
  do {
    const page = batchPage([member], 20, offset);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(INBOX_READ_BYTES);
    const fragment = page.items[0]!;
    expect('jsonChunk' in fragment).toBe(true);
    if (!('jsonChunk' in fragment)) throw new Error('Missing fragment');
    restored += fragment.jsonChunk;
    pageCount++;
    offset = page.next ? Number(page.next.split(':')[1]) : 0;
  } while (offset);
  expect(pageCount).toBeGreaterThan(1);
  expect(JSON.parse(restored)).toEqual(member);
});

it('holds the same admission gate from durable fence to transport start', async () => {
  const f = fixture();
  f.add('one');
  const received: string[] = [];
  const deps = Layer.merge(
    inboxRepositoryLayer(f.sql),
    Layer.succeed(InboxExecution, {
      ready: () => true,
      admit: () => true,
      launch: () => Effect.void,
      report: () => Effect.void,
    })
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const inbox = yield* OperationInbox;
        yield* inbox.accept(f.input);
        yield* inbox.begin(f.input, 'exec');
        const batch = (yield* inbox.prepare(f.input))!;
        let stop: Promise<boolean> | undefined;
        yield* inbox.submit(batch, f.input, 'exec', () => {
          stop = Effect.runPromise(inbox.pause(f.input, 'exec'));
          received.push('actual transport received user+batch');
        });
        yield* Effect.promise(() => stop!);
        expect(received).toEqual(['actual transport received user+batch']);
        const retry = yield* Effect.exit(
          inbox.submit(batch, f.input, 'exec', () => received.push('replay'))
        );
        expect(retry._tag).toBe('Failure');
        expect(received).toEqual(['actual transport received user+batch']);
        expect(f.sql.getBatch(batch.batchId, batch)?.state).toBe('submitting');
      }).pipe(Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps))))
    )
  );
});

it('a later queued human input does not invalidate the human execution already being prepared', () => {
  const f = fixture();
  f.start();
  f.add('one');
  const own = f.sql.prepare(f.input, 'owner')!;
  const next = { ...f.input, inputId: 'later-human' };
  expect(f.sql.accept(next)).toBe(true);
  expect(f.sql.getBatch(own.batchId, own)?.state).toBe('prepared');
  expect(f.sql.fence(own, 'execution-1')).toBe(true);
  expect(f.sql.members(own).map((m) => m.operationId)).toEqual(['one']);
});

it('a fresh human can clear pause without reviving the execution canceled by Stop', () => {
  const f = fixture();
  f.start();
  expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
  expect(f.sql.accept({ ...f.input, inputId: 'post-stop-human' })).toBe(true);
  expect(f.sql.canSubmit(f.input, 'execution-1', 'owner')).toBe(false);
});

it('keeps the original shared failed shutdown receipt and recovers settlement through a new repository', async () => {
  const { operationInboxLegacy } = await import('./legacy');
  const f = fixture();
  f.add('one');
  const received: string[] = [];
  const bridge = operationInboxLegacy({
    workspaceId: 'workspace',
    owner: 'owner',
    sql: f.sql,
    ready: () => true,
    admit: () => true,
    launch: async () => {},
    report: () => {},
    openRecoveryRepository: () => {
      const store = new LodyOperationStore(f.filename);
      return { sql: store.inbox, close: () => store.close() };
    },
  });
  await bridge.accept(f.input);
  await bridge.begin(f.input, 'exec');
  const batch = (await bridge.prepare(f.input))!;
  await bridge.submit(batch, f.input, 'exec', () => received.push(batch.batchId));
  const db = new Database(f.filename);
  db.exec(
    "CREATE TRIGGER fail_close_settlement BEFORE UPDATE OF state ON inbox_batches WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'outage'); END;"
  );
  await bridge.settle(batch, 'settled');
  const first = bridge.close();
  expect(bridge.close()).toBe(first);
  await expect(first).rejects.toHaveProperty('cause');
  expect(db.prepare('SELECT state FROM inbox_batches').get()).toEqual({ state: 'submitting' });
  db.exec('DROP TRIGGER fail_close_settlement');
  await bridge.recoverClose();
  expect(db.prepare('SELECT state FROM inbox_batches').get()).toEqual({ state: 'settled' });
  expect(received).toEqual([batch.batchId]);
  db.close();
});

it('physical release clears inherited recovery blocking for another requester in the same session', () => {
  const f = fixture();
  f.start();
  f.release('unreleased');
  const next = { ...f.input, userId: 'other-human', inputId: 'fresh-other-human' };
  f.sql.accept(next);
  expect(f.sql.begin(next, 'next')).toBe(false);
  f.sql.confirmReleased(f.input, 'execution-1');
  expect(f.sql.begin(next, 'next')).toBe(true);
});

it('Stop at the normal-release gap supersedes the fixed intent before an extra execution', () => {
  const f = fixture();
  f.start();
  f.add('one');
  f.release();
  expect(f.sql.pending('workspace')).toHaveLength(1);
  expect(f.sql.pauseTarget('workspace', 'A', 'execution-1')).toMatchObject({
    executionId: 'execution-1',
  });
  expect(f.sql.pause(f.input, 'execution-1')).toBe(true);
  expect(f.sql.pending('workspace')).toEqual([]);
  expect(f.sql.accept({ ...f.input, kind: 'task', inputId: 'reply' })).toBe(false);
});

it('retries a failed normal-release write with its first watermark, excluding late arrivals', async () => {
  const f = fixture();
  const db = new Database(f.filename);
  const deps = Layer.merge(
    inboxRepositoryLayer(f.sql),
    Layer.succeed(InboxExecution, {
      ready: () => false,
      admit: () => true,
      launch: () => Effect.void,
      report: () => Effect.void,
    })
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* OperationInbox;
          yield* inbox.accept(f.input);
          yield* inbox.begin(f.input, 'exec');
          f.add('first');
          db.exec(
            "CREATE TRIGGER fail_release BEFORE INSERT ON inbox_intents BEGIN SELECT RAISE(ABORT,'release outage'); END;"
          );
          const event = { ...f.input, executionId: 'exec', outcome: 'normal' as const };
          expect((yield* Effect.exit(inbox.release(event)))._tag).toBe('Failure');
          f.add('late');
          db.exec('DROP TRIGGER fail_release');
        }).pipe(
          Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
        )
      )
    );
    const intent = f.sql.pending('workspace')[0]!;
    const batch = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
    expect(f.sql.members(batch).map((m) => m.operationId)).toEqual(['first']);
  } finally {
    db.close();
  }
});

it('a failed pre-transport human batch releases its claim so fresh human input can carry the results', () => {
  const f = fixture();
  f.start();
  f.add('one');
  const abandoned = f.sql.prepare(f.input, 'owner')!;
  f.release('failed');
  expect(f.sql.getBatch(abandoned.batchId, abandoned)?.state).toBe('superseded');
  const fresh = { ...f.input, inputId: 'fresh-human' };
  f.sql.accept(fresh);
  const batch = f.sql.prepare(fresh, 'owner')!;
  expect(f.sql.members(batch).map((m) => m.operationId)).toEqual(['one']);
  expect(f.sql.members(abandoned).map((m) => m.operationId)).toEqual(['one']);
});

it('a superseded automatic input cannot reserve the execution slot ahead of fresh human input', () => {
  const f = fixture();
  f.start();
  f.add('one');
  f.release();
  const intent = f.sql.pending('workspace')[0]!;
  const old = f.sql.prepare(intent.input, 'owner', intent.intentId)!;
  const fresh = { ...f.input, inputId: 'fresh' };
  f.sql.accept(fresh);
  expect(f.sql.begin(old, 'stale-auto', 'owner')).toBe(false);
  expect(f.sql.begin(fresh, 'fresh-owner', 'owner')).toBe(true);
});

it('duplicate Stop delivery cannot pause a fresh input, but a new Stop can', () => {
  const f = fixture();
  f.start();
  expect(f.sql.pause(f.input, 'execution-1', [], 'stop-one')).toBe(true);
  f.release('user_stop');
  const fresh = { ...f.input, inputId: 'fresh-human' };
  expect(f.sql.accept(fresh)).toBe(true);
  expect(f.sql.pause(f.input, 'execution-1', [], 'stop-one')).toBe(true);
  expect(f.sql.inputCanceled('workspace', 'A', fresh.inputId)).toBe(false);
  expect(f.sql.pause(f.input, 'execution-1', [], 'stop-two')).toBe(true);
  expect(f.sql.inputCanceled('workspace', 'A', fresh.inputId)).toBe(true);
});

it('internal cancellation vetoes the old input without persisting a message pause', () => {
  const f = fixture();
  f.start();
  expect(f.sql.cancelExecution(f.input, 'execution-1')).toBe(true);
  const fresh = { ...f.input, inputId: 'fresh' };
  f.sql.accept(fresh);
  expect(f.sql.adoptExecution(f.input, fresh, 'execution-1')).toBe(false);
  expect(f.sql.canSubmit(f.input, 'execution-1', 'owner')).toBe(false);
  f.release('failed');
  const task = { ...f.input, inputId: 'new-task', kind: 'task' as const };
  expect(f.sql.accept(task)).toBe(true);
  expect(f.sql.begin(task, 'task-execution')).toBe(true);
});

it('quiescing closes actual transport admission even for a prepared ordinary input', async () => {
  const f = fixture();
  const received: string[] = [];
  const deps = Layer.merge(
    inboxRepositoryLayer(f.sql),
    Layer.succeed(InboxExecution, {
      ready: () => false,
      admit: () => true,
      launch: () => Effect.void,
      report: () => Effect.void,
    })
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const inbox = yield* OperationInbox;
        yield* inbox.accept(f.input);
        yield* inbox.begin(f.input, 'exec');
        yield* inbox.quiesce;
        expect(
          (yield* Effect.exit(
            inbox.submit(undefined, f.input, 'exec', () => received.push('received'))
          ))._tag
        ).toBe('Failure');
        expect(received).toEqual([]);
      }).pipe(Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps))))
    )
  );
});

it('owner replacement settles a crossed fence as unknown without making its members eligible again', () => {
  const f = fixture();
  f.start();
  f.add('one');
  const batch = f.sql.prepare(f.input, 'owner')!;
  expect(f.sql.fence(batch, 'execution-1')).toBe(true);
  const other = new LodyOperationStore(f.filename);
  stores.push(other);
  other.inbox.activate('workspace', 'replacement');
  expect(other.inbox.getBatch(batch.batchId, batch)?.state).toBe('unknown');
  expect(
    (other as unknown as { db: Database.Database }).db
      .prepare("SELECT consumed FROM inbox_results WHERE session_id='A' AND operation_id='one'")
      .get()
  ).toEqual({ consumed: 1 });
  other.inbox.confirmReleased(f.input, 'execution-1');
  const next = { ...f.input, inputId: 'fresh' };
  other.inbox.accept(next);
  expect(other.inbox.prepare(next, 'replacement')).toBeUndefined();
});

it('expires consumed copied payloads with Operations, retaining unconsumed results and Stop identities', () => {
  let time = Date.parse('2026-10-12T00:00:00Z');
  const f = fixture(() => time);
  f.start();
  f.add('consumed');
  const batch = f.sql.prepare(f.input, 'owner')!;
  f.sql.fence(batch, 'execution-1');
  f.sql.settle(batch, 'settled');
  f.release('failed');
  f.add('waiting');
  time += 8 * 24 * 60 * 60 * 1000;
  const other = new LodyOperationStore(f.filename, () => time);
  stores.push(other);
  expect(other.inbox.getBatch(batch.batchId, batch)).toBeUndefined();
  const fresh = { ...f.input, inputId: 'fresh' };
  other.inbox.accept(fresh);
  const waiting = other.inbox.prepare(fresh, 'owner')!;
  expect(other.inbox.members(waiting).map((m) => m.operationId)).toEqual(['waiting']);
  other.deleteRequesterSession('A' as SessionId);
  const db = new Database(f.filename);
  for (const table of [
    'inbox_results',
    'inbox_members',
    'inbox_batches',
    'inbox_inputs',
    'inbox_releases',
    'inbox_resources',
    'inbox_stops',
  ])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  db.close();
});

it('an OS child recovers the fixed eight-member intent without any new event', async () => {
  const f = fixture();
  f.start();
  for (let i = 0; i < 8; i++) f.add(`result-${i}`);
  f.release();
  f.add('late-nine');
  f.store.close();
  const storePath = fileURLToPath(new URL('../operation-store.ts', import.meta.url));
  const servicePath = fileURLToPath(new URL('./service.ts', import.meta.url));
  const stdout = await runInboxChild(
    f.root,
    `
    import {LodyOperationStore} from ${JSON.stringify(storePath)};
    import {OperationInbox,InboxExecution,inboxRepositoryLayer} from ${JSON.stringify(servicePath)};
    import {Effect,Layer,Deferred} from ${JSON.stringify(fileURLToPath(new URL('../../../node_modules/effect/dist/index.js', import.meta.url)))};
    const store=new LodyOperationStore(${JSON.stringify(f.filename)});
    store.inbox.activate('workspace','child');
    const received=[];
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const done=yield* Deferred.make();
      const execution=Layer.succeed(InboxExecution,{
        ready:()=>true,admit:()=>true,report:()=>Effect.void,
        launch:batch=>Effect.gen(function*(){
          store.inbox.begin(batch,'child-exec','child');
          store.inbox.fence(batch,'child-exec');
          received.push(store.inbox.members(batch).map(m=>m.operationId));
          store.inbox.settle(batch,'settled');
          store.inbox.release({...batch,executionId:'child-exec',outcome:'failed'});
          yield* Deferred.succeed(done,undefined);
        })
      });
      yield* Effect.gen(function*(){yield* OperationInbox;yield* Deferred.await(done);})
        .pipe(Effect.provide(OperationInbox.layer('workspace','child').pipe(Layer.provide(Layer.merge(inboxRepositoryLayer(store.inbox),execution)))));
    })));
    store.close(); process.stdout.write(JSON.stringify(received));
  `
  );
  expect(JSON.parse(stdout)).toEqual([Array.from({ length: 8 }, (_, i) => `result-${i}`)]);
  const reopened = new LodyOperationStore(f.filename);
  stores.push(reopened);
  reopened.inbox.activate('workspace', 'parent');
  expect(reopened.inbox.pending('workspace')).toEqual([]);
  const fresh = { ...f.input, inputId: 'fresh' };
  reopened.inbox.accept(fresh);
  expect(
    reopened.inbox.members(reopened.inbox.prepare(fresh, 'parent')!).map((m) => m.operationId)
  ).toEqual(['late-nine']);
});

it('persists recovery blocking when a repeated release contradicts its original receipt', () => {
  const f = fixture();
  f.start();
  f.add('one');
  f.release();
  expect(() => f.release('failed')).toThrow('Conflicting release');
  const other = new LodyOperationStore(f.filename);
  stores.push(other);
  other.inbox.activate('workspace', 'next-owner');
  const intent = other.inbox.pending('workspace')[0]!;
  expect(other.inbox.prepare(intent.input, 'next-owner', intent.intentId)).toBeUndefined();
  const fresh = { ...f.input, inputId: 'fresh' };
  other.inbox.accept(fresh);
  expect(other.inbox.begin(fresh, 'successor', 'next-owner')).toBe(false);
});

it.each(['check', 'fence'] as const)(
  'holds shared admission through %s and actual transport initiation',
  async (position) => {
    const f = fixture();
    f.start();
    f.add('one');
    const received: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const proceed = yield* Deferred.make<void>();
          const attempted = yield* Deferred.make<void>();
          const base = yield* Effect.provide(InboxRepository, inboxRepositoryLayer(f.sql));
          const barrier = Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(proceed);
          });
          const repo: typeof base = {
            ...base,
            canSubmit: (s, id, owner) =>
              base
                .canSubmit(s, id, owner)
                .pipe(Effect.tap(() => (position === 'check' ? barrier : Effect.void))),
            fence: (batch, id) =>
              base
                .fence(batch, id)
                .pipe(Effect.tap(() => (position === 'fence' ? barrier : Effect.void))),
          };
          const deps = Layer.merge(
            Layer.succeed(InboxRepository, repo),
            Layer.succeed(InboxExecution, {
              ready: () => false,
              admit: () => true,
              launch: () => Effect.void,
              report: () => Effect.void,
            })
          );
          yield* Effect.gen(function* () {
            const inbox = yield* OperationInbox;
            const batch = yield* inbox.prepare(f.input);
            const submitting = yield* inbox
              .submit(batch, f.input, 'execution-1', () => received.push('transport-started'))
              .pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            const stopping = yield* Effect.gen(function* () {
              yield* Deferred.succeed(attempted, undefined);
              expect(yield* inbox.pause(f.input, 'execution-1')).toBe(true);
              received.push('stop-confirmed');
            }).pipe(Effect.forkScoped);
            yield* Deferred.await(attempted);
            expect(f.sql.inputCanceled('workspace', 'A', f.input.inputId)).toBe(false);
            yield* Deferred.succeed(proceed, undefined);
            yield* Fiber.join(submitting);
            yield* Fiber.join(stopping);
            expect(received).toEqual(['transport-started', 'stop-confirmed']);
            yield* inbox.settle(batch!, 'unknown');
            yield* inbox.release({ ...f.input, executionId: 'execution-1', outcome: 'user_stop' });
            expect(f.sql.pending('workspace')).toEqual([]);
          }).pipe(
            Effect.provide(OperationInbox.layer('workspace', 'owner').pipe(Layer.provide(deps)))
          );
        })
      )
    );
  }
);

it.each(['unknown', 'paused'] as const)(
  'an OS child keeps %s work passive without a new event',
  async (mode) => {
    const f = fixture();
    f.start();
    f.add('saved');
    let batchId: string | undefined;
    if (mode === 'unknown') {
      const batch = f.sql.prepare(f.input, 'owner')!;
      batchId = batch.batchId;
      f.sql.fence(batch, 'execution-1'); // Crash with no reliable transport receipt.
    } else {
      f.sql.pause(f.input, 'execution-1');
      f.release('user_stop');
    }
    f.store.close();
    const stdout = await runInboxChild(
      f.root,
      `
    import {LodyOperationStore} from ${JSON.stringify(fileURLToPath(new URL('../operation-store.ts', import.meta.url)))};
    import {OperationInbox,InboxRepository,InboxExecution,inboxRepositoryLayer} from ${JSON.stringify(fileURLToPath(new URL('./service.ts', import.meta.url)))};
    import {Effect,Layer,Deferred} from ${JSON.stringify(fileURLToPath(new URL('../../../node_modules/effect/dist/index.js', import.meta.url)))};
    const store=new LodyOperationStore(${JSON.stringify(f.filename)});store.inbox.activate('workspace','child');
    const received=[];
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const scanned=yield* Deferred.make();
      const base=yield* Effect.provide(InboxRepository,inboxRepositoryLayer(store.inbox));
      const repository=Layer.succeed(InboxRepository,{...base,pending:w=>base.pending(w).pipe(Effect.tap(()=>Deferred.succeed(scanned,undefined)))});
      const execution=Layer.succeed(InboxExecution,{ready:()=>true,admit:()=>true,report:()=>Effect.void,launch:batch=>Effect.sync(()=>received.push(batch.batchId))});
      yield* Effect.gen(function*(){yield* OperationInbox;yield* Deferred.await(scanned);})
        .pipe(Effect.provide(OperationInbox.layer('workspace','child').pipe(Layer.provide(Layer.merge(repository,execution)))));
    })));
    const input=${JSON.stringify(f.input)};
    const batch=${JSON.stringify(batchId)}?store.inbox.getBatch(${JSON.stringify(batchId)},input):undefined;
    const taskAccepted=store.inbox.accept({...input,inputId:'agent-task',kind:'task'});
    process.stdout.write(JSON.stringify({received,state:batch?.state,taskAccepted,pending:store.inbox.pending('workspace')}));store.close();
  `
    );
    const observed = JSON.parse(stdout);
    expect(observed.received).toEqual([]);
    expect(observed.pending).toEqual([]);
    if (mode === 'unknown') expect(observed.state).toBe('unknown');
    else expect(observed.taskAccepted).toBe(false);
  }
);

it('includes the header and omission footer in the complete 64 KiB preview budget', () => {
  const f = fixture();
  f.start();
  f.add('one');
  const batch = f.sql.prepare(f.input, 'owner')!;
  const member = { ...f.sql.members(batch)[0]!, completion: { text: '' } };
  const nearLimit =
    INBOX_PREVIEW_BYTES -
    Buffer.byteLength(batchPreview(batch, []), 'utf8') -
    Buffer.byteLength(JSON.stringify(member), 'utf8') +
    8;
  member.completion.text = 'x'.repeat(nearLimit);
  const preview = batchPreview(batch, [member]);
  expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(INBOX_PREVIEW_BYTES);
  expect(preview).toContain('Shown 0/1.');
  expect(f.sql.members(batch)).toHaveLength(1);
});
