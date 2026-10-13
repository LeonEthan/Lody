import type { ISession } from '@/session/session-manager';
import { Effect } from 'effect';
import type { ExecutionResource } from '../inbox/execution-owner';

/** Registered Session/ACP adapter. Acquisition callbacks must journal before spawning. */
export const sessionExecutionResource = (session: ISession): ExecutionResource => ({
  key: session,
  observesAcquisitions: !!session.watchInboxRecoveryResources,
  terminate: Effect.tryPromise({ try: () => session.terminate(true), catch: (cause) => cause }),
  observe: (update) =>
    session.watchInboxRecoveryResources
      ? Effect.tryPromise({
          try: async () => {
            const detach = await session.watchInboxRecoveryResources!((identity) => {
              Effect.runSync(update(identity));
            });
            return Effect.sync(detach);
          },
          catch: (cause) => cause,
        })
      : Effect.succeed(Effect.void),
});
