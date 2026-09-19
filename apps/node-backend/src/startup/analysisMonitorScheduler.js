/** Bounded local monitor polling, outside startup-readiness warmup. */

import { logger } from "../config/logger.js";
import { checkDueAnalysisMonitors } from "../services/analysisMonitorService.js";

export function startAnalysisMonitorScheduler() {
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await checkDueAnalysisMonitors();
    } catch (error) {
      logger.error("Analysis monitor scheduler failed", {
        error: error.message,
      });
    } finally {
      inFlight = false;
    }
  };
  // One startup catch-up, then bounded local-only checks. Missed periods are
  // not replayed as repeated alerts after a sleeping desktop resumes.
  void tick();
  const interval = setInterval(tick, 60_000);
  interval.unref?.();
  return interval;
}
