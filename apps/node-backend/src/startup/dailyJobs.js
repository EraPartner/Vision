import settingsRepository from "../repositories/settingsRepository.js";
import { logger } from "../config/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

/**
 * Single-instance daily work. Persist successful completion, coalesce missed
 * periods into one run, and share the guard between startup and timer ticks.
 * Failed/offline work retries after an hour without advancing the checkpoint.
 * @param {string} name
 * @param {() => Promise<boolean>} run true only when the work completed
 * @param {{ store?: typeof settingsRepository, now?: () => number }} [options]
 */
export function createDailyJob(
  name,
  run,
  { store = settingsRepository, now = Date.now } = {},
) {
  const key = `daily_job_${name}`;
  let running = false;
  let retryAfter = 0;
  return async () => {
    if (running || now() < retryAfter) return;
    running = true;
    try {
      const completedAt = await store.get(key);
      if (
        typeof completedAt === "number" &&
        Number.isFinite(completedAt) &&
        completedAt >= 0 &&
        completedAt <= now() &&
        now() - completedAt < DAY_MS
      )
        return;
      if (await run()) {
        await store.set(key, now());
        retryAfter = 0;
      } else {
        retryAfter = now() + RETRY_MS;
      }
    } catch (err) {
      retryAfter = now() + RETRY_MS;
      logger.error(`Daily job ${name} failed`, { error: err.message });
    } finally {
      running = false;
    }
  };
}
