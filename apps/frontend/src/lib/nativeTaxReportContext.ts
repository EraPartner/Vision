import { z } from "zod";
import { hasNativeShellCapability, type NativeShellWindow } from "@/lib/nativeShell";
import type { TaxReportContext } from "@/features/reports/taxReportContext";

export type NativeTaxReportContextCallback = (settingsJSON: unknown, year: unknown) => Promise<TaxReportContext>;
export interface NativeTaxReportContextWindow extends NativeShellWindow {
    readonly __visionNativeTaxReportContext?: NativeTaxReportContextCallback;
}

export async function nativeTaxReportContext(
    settingsJSON: unknown,
    year: unknown,
    translate: (key: string) => string,
): Promise<TaxReportContext> {
    const request = z.object({ settingsJSON: z.string(), year: z.number().int() }).parse({ settingsJSON, year });
    const settings: unknown = JSON.parse(request.settingsJSON);
    const [source, runtime] = await Promise.all([
        import("@/lib/nativeTaxReportContextSource"),
        import("@/lib/belgianTax/householdRuntime"),
    ]);
    const context = source.taxReportContextFromSettings(settings, request.year, translate, runtime);
    // Match the original download request's JSON wire shape, including omitted optionals.
    return JSON.parse(JSON.stringify(context)) as TaxReportContext;
}

interface Registration { active: boolean; translate: (key: string) => string }
const registrations = new WeakMap<NativeTaxReportContextWindow, Set<Registration>>();

export function registerNativeTaxReportContextBridge(
    translate: (key: string) => string,
    target: NativeTaxReportContextWindow = window,
): () => void {
    if (!hasNativeShellCapability("reports", target)) return () => {};
    let owners = registrations.get(target);
    if (!owners) {
        if (Object.getOwnPropertyDescriptor(target, "__visionNativeTaxReportContext")) return () => {};
        owners = new Set();
        const fixedOwners = owners;
        const callback: NativeTaxReportContextCallback = async (settingsJSON, year) => {
            const owner = [...fixedOwners].at(-1);
            if (!owner?.active) throw new Error("Native tax report bridge is unavailable");
            const context = await nativeTaxReportContext(settingsJSON, year, owner.translate);
            if (!owner.active) throw new Error("Native tax report bridge is unavailable");
            return context;
        };
        Object.defineProperty(target, "__visionNativeTaxReportContext", {
            value: callback, writable: false, configurable: false, enumerable: false,
        });
        registrations.set(target, owners);
    }
    const owner = { active: true, translate };
    owners.add(owner);
    return () => { owner.active = false; owners.delete(owner); };
}
