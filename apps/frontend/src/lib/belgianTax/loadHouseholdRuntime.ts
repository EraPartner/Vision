import type * as HouseholdRuntimeModule from "./householdRuntime";

type HouseholdRuntime = typeof HouseholdRuntimeModule;

/**
 * Load the household engine chunk, retrying once when the dynamic import rejects (a transient
 * network failure or a chunk evicted by a deploy). The caller handles a second rejection.
 */
export function loadHouseholdRuntime(
    importRuntime: () => Promise<HouseholdRuntime> = () =>
        import("./householdRuntime"),
): Promise<HouseholdRuntime> {
    return importRuntime().catch(() => importRuntime());
}
