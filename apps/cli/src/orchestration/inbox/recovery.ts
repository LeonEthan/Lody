import { Context, Effect, Layer } from 'effect';
import type { ProcessTableSnapshot } from '@/monitor/process-table';
import { readProcessTable } from '@/monitor/process-table';

export type InboxResourceIdentity = { platform: NodeJS.Platform; roots: readonly number[] };
/** Read-only verification. Never send a signal to a PID that may have been reused. */
export const provesResourcesGone = (
  identity: InboxResourceIdentity,
  snapshot: ProcessTableSnapshot
): boolean =>
  identity.platform !== 'win32' &&
  identity.roots.length > 0 &&
  identity.roots.every(
    (pid) => !snapshot.entries.some((entry) => entry.pid === pid || entry.processGroupId === pid)
  );

export class InboxRecoveryProbe extends Context.Service<
  InboxRecoveryProbe,
  {
    released(identity: InboxResourceIdentity): Effect.Effect<boolean, unknown>;
  }
>()('lody/orchestration/InboxRecoveryProbe') {
  static layer = Layer.succeed(InboxRecoveryProbe, {
    released: Effect.fn('InboxRecoveryProbe.released')(function* (identity: InboxResourceIdentity) {
      const snapshot = yield* Effect.tryPromise({
        try: () => readProcessTable(identity.platform),
        catch: (cause) => cause,
      });
      return provesResourcesGone(identity, snapshot);
    }),
  });
}
