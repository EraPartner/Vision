import { z } from "zod";
import { hasNativeShellCapability } from "@/lib/nativeShell";
import type { NativeShellWindow } from "@/lib/nativeShell";
import type { BelgianTaxProfile } from "@/lib/belgianTax/types";

export type NativeTaxReportProfileCallback = (
    householdJSON: unknown,
    year: unknown,
) => Promise<BelgianTaxProfile>;

export interface NativeTaxReportWindow extends NativeShellWindow {
    readonly __visionNativeTaxReportProfile?: NativeTaxReportProfileCallback;
}

/** Uses the source projection only; the selected report year never rewrites the household. */
export async function nativeTaxReportProfile(
    householdJSON: unknown,
    year: unknown,
): Promise<BelgianTaxProfile> {
    const request = z.object({ householdJSON: z.string(), year: z.number().int() })
        .parse({ householdJSON, year });
    const raw: unknown = JSON.parse(request.householdJSON);
    // ADR-200 keeps household schema/engine imports out of the frontend boot graph.
    const [schema, migration] = await Promise.all([
        import("@/lib/belgianTax/householdSchema"),
        import("@/lib/belgianTax/householdMigration"),
    ]);
    const parsed = schema.parseHouseholdV2(raw);
    if (!parsed.ok) throw new Error("Invalid Belgian tax report household");
    return migration.projectHouseholdToProfileV1(parsed.value);
}

interface Registration { active: boolean }
const registrations = new WeakMap<NativeTaxReportWindow, Set<Registration>>();

export function registerNativeTaxReportProfileBridge(
    target: NativeTaxReportWindow = window,
): () => void {
    if (!hasNativeShellCapability("reports", target)) return () => {};
    let owners = registrations.get(target);
    if (!owners) {
        if (Object.getOwnPropertyDescriptor(target, "__visionNativeTaxReportProfile"))
            return () => {};
        owners = new Set();
        const fixedOwners = owners;
        const callback: NativeTaxReportProfileCallback = async (householdJSON, year) => {
            const owner = [...fixedOwners].at(-1);
            if (!owner?.active) throw new Error("Native tax report bridge is unavailable");
            const profile = await nativeTaxReportProfile(householdJSON, year);
            if (!owner.active) throw new Error("Native tax report bridge is unavailable");
            return profile;
        };
        Object.defineProperty(target, "__visionNativeTaxReportProfile", {
            value: callback,
            writable: false,
            configurable: false,
            enumerable: false,
        });
        registrations.set(target, owners);
    }
    const owner = { active: true };
    owners.add(owner);
    return () => {
        owner.active = false;
        owners.delete(owner);
    };
}
