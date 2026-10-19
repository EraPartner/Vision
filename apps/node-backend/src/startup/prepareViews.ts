/**
 * One refresh after both inputs settle; late backfill still refreshes existing views.
 * `readable` fires before that refresh when the views exist and no backfill rewrote
 * their inputs, so callers can serve the previous launch's aggregates meanwhile.
 */
export async function prepareViewsAfterBackfill({
  prepare,
  backfill,
  refresh,
  backfillFailed,
  readable,
}: {
  prepare: () => Promise<unknown>;
  backfill: () => Promise<{ skipped?: boolean }>;
  refresh: () => Promise<unknown>;
  backfillFailed: (error: unknown) => void;
  readable?: () => void;
}): Promise<void> {
  const [prepared, backfilled] = await Promise.allSettled([
    prepare(),
    backfill(),
  ]);
  if (backfilled.status === "rejected") backfillFailed(backfilled.reason);
  const rewritten =
    backfilled.status === "fulfilled" && !backfilled.value.skipped;
  if (prepared.status === "fulfilled" && !rewritten) readable?.();
  if (prepared.status === "fulfilled" || rewritten) await refresh();
  if (prepared.status === "rejected") throw prepared.reason;
}
