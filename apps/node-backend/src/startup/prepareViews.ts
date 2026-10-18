/** One refresh after both inputs settle; late backfill still refreshes existing views. */
export async function prepareViewsAfterBackfill({
  prepare,
  backfill,
  refresh,
  backfillFailed,
}: {
  prepare: () => Promise<unknown>;
  backfill: () => Promise<{ skipped?: boolean }>;
  refresh: () => Promise<unknown>;
  backfillFailed: (error: unknown) => void;
}): Promise<void> {
  const [prepared, backfilled] = await Promise.allSettled([
    prepare(),
    backfill(),
  ]);
  if (backfilled.status === "rejected") backfillFailed(backfilled.reason);
  if (
    prepared.status === "fulfilled" ||
    (backfilled.status === "fulfilled" && !backfilled.value.skipped)
  )
    await refresh();
  if (prepared.status === "rejected") throw prepared.reason;
}
