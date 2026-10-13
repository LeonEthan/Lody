import { Effect, Layer } from 'effect';
import { ExecutionJournal } from '../inbox/execution-owner';
import type { InboxSqlite } from '../inbox/sqlite';

export const executionJournalLayer = (sql: InboxSqlite) => {
  const io = <A>(f: () => A) => Effect.try({ try: f, catch: (cause) => cause });
  return Layer.succeed(ExecutionJournal, {
    record: (i, id, identity) => io(() => sql.registerResources(i, id, identity)),
    confirm: (i, id) => io(() => sql.confirmReleased(i, id)),
    members: (batch) => io(() => sql.members(batch, 0, 50)),
    identity: (roots, complete) => ({
      platform: process.platform,
      roots: [...new Set([process.pid, ...roots])],
      complete,
    }),
  });
};
