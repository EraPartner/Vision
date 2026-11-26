/**
 * Network reachability check.
 *
 * Used at startup and before scheduled refreshes to skip outbound data
 * fetches when the Mac has no network, so warmups (ECB rates, Yahoo quotes,
 * historical backfills) do not burn their per-call timeouts before falling
 * back to cached/DB data.
 *
 * It sends nothing (ADR-271): offline mode reads as unreachable, and
 * otherwise the Mac counts as online when a network interface has a routable
 * address. Link-local addresses do not count (macOS keeps fe80:: on utun and
 * awdl interfaces with Wi-Fi off). A network that is up but has no internet
 * fails at the real request, within that request's own timeout.
 */

import os from "node:os";
import { isNetworkAllowed } from "./networkPolicy.ts";

type InterfaceMap = ReturnType<typeof os.networkInterfaces>;

/** True when some non-internal interface has a non-link-local address. */
function hasRoutableNetworkInterface(
  interfaces: InterfaceMap = os.networkInterfaces(),
): boolean {
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      if (address.family === "IPv4" && !address.address.startsWith("169.254."))
        return true;
      if (address.family === "IPv6" && !/^fe[89ab]/i.test(address.address))
        return true;
    }
  }
  return false;
}

/** True when offline mode is off and the Mac has a routable network address. */
export async function isInternetReachable(): Promise<boolean> {
  if (process.env.VISION_SYNTHETIC_SMOKE_OFFLINE === "1") return false;
  if (!(await isNetworkAllowed())) return false;
  return hasRoutableNetworkInterface();
}

export { hasRoutableNetworkInterface as __hasRoutableNetworkInterface };
