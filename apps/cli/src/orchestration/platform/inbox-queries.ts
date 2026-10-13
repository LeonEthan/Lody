import { Effect, Layer } from 'effect';
import { InboxQueries } from '../inbox/queries';
import type { InboxSqlite } from '../inbox/sqlite';

export const makeInboxQueries = (sql: InboxSqlite): InboxQueries['Service'] => {
  const io = <A>(f: () => A) => Effect.try({ try: f, catch: (cause) => cause });
  return {
    preferredHumanInput: (w, s) => io(() => sql.preferredHumanInput(w, s)),
    inputCanceled: (w, s, id) => io(() => sql.inputCanceled(w, s, id)),
    inputKind: (s, id) => io(() => sql.inputKind(s, id)),
    pauseTarget: (w, s, id) => io(() => sql.pauseTarget(w, s, id)),
  };
};
export const inboxQueriesLayer = (sql: InboxSqlite) =>
  Layer.succeed(InboxQueries, makeInboxQueries(sql));
