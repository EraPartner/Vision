import { QueryClient } from "@tanstack/react-query";
import {
    startNativeHelperRuntime,
    type NativeHelperWindow,
} from "@/lib/nativeHelperRuntime";
import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import type { Language } from "@/types/i18n";

export interface NativeHelperDocumentProvenance {
    readonly documentId: string;
    readonly generation: string;
}

type Dictionary = Readonly<Record<string, string>>;

export interface NativeHelperDocumentOptions {
    target: NativeHelperWindow;
    provenance: NativeHelperDocumentProvenance;
    initialLanguage: Language;
    /** The trusted host must also fence its actual ACK and dispose retired owners. */
    isCurrent: (provenance: NativeHelperDocumentProvenance) => boolean;
    signalReady: (provenance: NativeHelperDocumentProvenance) => Promise<void>;
    loadLocale?: (language: Language) => Promise<Dictionary>;
    reportOverlayFailure?: (error: unknown) => void;
}

export interface NativeHelperDocument {
    readonly provenance: NativeHelperDocumentProvenance;
    readonly queryClient: QueryClient;
    readonly language: Language;
    readonly ready: Promise<void>;
    /** Explicit host-owned update; unproven settings events are not subscribed to. */
    updateLocale: (
        language: Language,
        provenance: NativeHelperDocumentProvenance,
    ) => Promise<void>;
    dispose: () => void;
}

const owners = new WeakMap<NativeHelperWindow, NativeHelperDocument>();
const installedTargets = new WeakSet<NativeHelperWindow>();
const callbackNames = [
    "__visionNativePaletteAnswer",
    "__visionNativeTaxReportProfile",
    "__visionNativeTaxReportContext",
] as const;
const localeLoaders = {
    en: async () => (await import("@/locales/en")).default,
    nl: async () => (await import("@/locales/nl")).default,
};

function retired(message: string): Error {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

function validLanguage(language: Language): void {
    if (language !== "en" && language !== "nl")
        throw new Error("Unsupported native helper language");
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) {
            // Consume a later loader failure even when this request was already retired.
            void pending.catch(() => {});
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
        pending.then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", abort);
                reject(error);
            },
        );
    });
}

/** Dormant document bootstrap. No React mount, settings hydration, storage mutation
 * or ready signal occurs merely by importing this module. Provenance is supplied
 * by a future trusted host adapter; these client guards do not authorize its ACK. */
export function startNativeHelperDocument(
    options: NativeHelperDocumentOptions,
): NativeHelperDocument {
    validLanguage(options.initialLanguage);
    const provenance = Object.freeze({ ...options.provenance });
    if (!provenance.documentId || !provenance.generation)
        throw new Error("Missing native helper provenance");
    // Match App.tsx without importing its UI, router or QueryClientProvider.
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: QUERY_STALE_TIME_MS.DEFAULT,
                gcTime: 5 * 60_000,
                refetchOnWindowFocus: false,
                retry: 1,
            },
        },
    });
    const dictionaries: Partial<Record<Language, Dictionary>> = {};
    const pendingLocales = new Map<Language, Promise<Dictionary>>();
    const loadLocale =
        options.loadLocale ??
        ((language: Language) => localeLoaders[language]());
    let language = options.initialLanguage;
    let disposed = false;
    let acknowledged = false;
    let localeRevision = 0;
    let localeRequest = new AbortController();
    let stopRuntime: (() => void) | undefined;
    let resolveReady!: () => void;
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });

    function dispose(): void {
        if (disposed) return;
        disposed = true;
        localeRequest.abort(retired("Native helper document disposed"));
        stopRuntime?.();
        queryClient.unmount();
        queryClient.clear();
        pendingLocales.clear();
        rejectReady(retired("Native helper document disposed"));
        if (owners.get(options.target) === owner) owners.delete(options.target);
    }

    function requireCurrent(candidate = provenance): void {
        if (
            candidate.documentId !== provenance.documentId ||
            candidate.generation !== provenance.generation
        ) {
            throw retired("Native helper provenance mismatch");
        }
        if (disposed || owners.get(options.target) !== owner)
            throw retired("Native helper document retired");
        if (!options.isCurrent(provenance)) {
            dispose();
            throw retired("Native helper document is no longer current");
        }
    }

    function dictionary(language: Language): Promise<Dictionary> {
        let pending = pendingLocales.get(language);
        if (!pending) {
            pending = Promise.resolve().then(() => loadLocale(language));
            pendingLocales.set(language, pending);
            const captured = pending;
            void pending.catch(() => {
                if (pendingLocales.get(language) === captured)
                    pendingLocales.delete(language);
            });
        }
        return pending;
    }

    async function acceptLocale(
        next: Language,
        revision: number,
        signal: AbortSignal,
    ): Promise<void> {
        const loaded = await abortable(dictionary(next), signal);
        requireCurrent();
        if (revision !== localeRevision)
            throw retired("Native helper locale superseded");
        dictionaries[next] = loaded;
        language = next;
        options.target.document.documentElement.lang = next;
    }

    const owner: NativeHelperDocument = {
        provenance,
        queryClient,
        get language() {
            return language;
        },
        ready,
        async updateLocale(next, candidate) {
            requireCurrent(candidate);
            if (!acknowledged)
                throw new Error("Native helper document is not ready");
            validLanguage(next);
            localeRequest.abort(retired("Native helper locale superseded"));
            localeRequest = new AbortController();
            await acceptLocale(next, ++localeRevision, localeRequest.signal);
        },
        dispose,
    };
    owners.get(options.target)?.dispose();
    owners.set(options.target, owner);
    queryClient.mount();

    async function initialise(): Promise<void> {
        requireCurrent();
        if (
            options.target.__VISION_NATIVE_PALETTE__ !== true ||
            options.target.__VISION_NATIVE_REPORTS__ !== true
        ) {
            throw new Error("Missing native helper capabilities");
        }
        if (
            !installedTargets.has(options.target) &&
            callbackNames.some((name) =>
                Object.getOwnPropertyDescriptor(options.target, name),
            )
        ) {
            throw new Error(
                "Native helper callbacks already have an unknown owner",
            );
        }
        await acceptLocale(language, ++localeRevision, localeRequest.signal);
        requireCurrent();
        stopRuntime = startNativeHelperRuntime({
            queryClient,
            // Same active -> already-loaded English -> raw-key lookup as source t.
            translate: (key) =>
                dictionaries[language]?.[key] ?? dictionaries.en?.[key] ?? key,
            target: options.target,
            ...(options.reportOverlayFailure
                ? { reportOverlayFailure: options.reportOverlayFailure }
                : {}),
        });
        installedTargets.add(options.target);
        if (
            callbackNames.some(
                (name) => typeof options.target[name] !== "function",
            )
        ) {
            throw new Error("Native helper callback installation failed");
        }
        requireCurrent();
        await options.signalReady(provenance);
        requireCurrent();
        acknowledged = true;
        resolveReady();
    }
    void initialise().catch((error: unknown) => {
        rejectReady(error);
        dispose();
    });
    return owner;
}
