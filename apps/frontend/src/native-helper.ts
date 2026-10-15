import { z } from "zod";
import {
    startNativeHelperDocument,
    type NativeHelperDocument,
    type NativeHelperDocumentProvenance,
} from "@/lib/nativeHelperDocument";
import type { NativeHelperWindow } from "@/lib/nativeHelperRuntime";

const identity = z.strictObject({
    abi: z.literal(1),
    documentId: z.string().min(1),
    generation: z.string().min(1),
});
const bootstrap = identity.extend({ initialLanguage: z.enum(["en", "nl"]) });
const locale = identity.extend({ language: z.enum(["en", "nl"]) });
type Identity = z.infer<typeof identity>;
type HelperEntryWindow = NativeHelperWindow & {
    readonly __visionNativeHelperReady?: (
        provenance: NativeHelperDocumentProvenance,
    ) => Promise<void>;
    readonly __visionNativeHelperFailed?: (
        provenance: NativeHelperDocumentProvenance,
        code: "bootstrap-failed",
    ) => Promise<void>;
};

const target = window as HelperEntryWindow;
// These functions must have been installed by the mode-specific document-start
// script. Their native receiver, not their names or the ABI marker, authorizes ACKs.
const ready = target.__visionNativeHelperReady?.bind(target);
const failed = target.__visionNativeHelperFailed?.bind(target);
let owner: NativeHelperDocument | undefined;
let issued: Identity | undefined;
let active = false;

function matches(candidate: NativeHelperDocumentProvenance): boolean {
    return (
        candidate.documentId === issued?.documentId &&
        candidate.generation === issued.generation
    );
}

function requireOwner(candidate: Identity): NativeHelperDocument {
    if (!matches(candidate) || !owner)
        throw new Error("Native helper owner is unavailable");
    return owner;
}

const exports = {
    __VISION_NATIVE_HELPER_ABI__: 1,
    __visionNativeBootstrapHelper(request: unknown) {
        const parsed = bootstrap.parse(request);
        if (!ready || !failed)
            throw new Error(
                "Native helper document-start bridge is unavailable",
            );
        if (issued) throw new Error("Native helper document already issued");
        issued = Object.freeze({
            abi: 1,
            documentId: parsed.documentId,
            generation: parsed.generation,
        });
        const provenance = Object.freeze({
            documentId: parsed.documentId,
            generation: parsed.generation,
        });
        active = true;
        owner = startNativeHelperDocument({
            target,
            provenance,
            initialLanguage: parsed.initialLanguage,
            isCurrent: (candidate) => active && matches(candidate),
            signalReady: ready,
        });
        const started = owner;
        void started.ready.catch(() => {
            if (owner !== started || !matches(provenance)) return;
            started.dispose();
            active = false;
            owner = undefined;
            void failed(provenance, "bootstrap-failed").catch(() => {});
        });
        return { ...issued, started: true };
    },
    async __visionNativeUpdateHelperLocale(request: unknown) {
        const parsed = locale.parse(request);
        const current = requireOwner(parsed);
        // The native ACK can accept a locale command before signalReady resumes.
        await current.ready;
        if (requireOwner(parsed) !== current)
            throw new Error("Native helper owner retired");
        await current.updateLocale(parsed.language, parsed);
        return {
            abi: 1,
            documentId: parsed.documentId,
            generation: parsed.generation,
            language: parsed.language,
        };
    },
    __visionNativeDisposeHelper(request: unknown) {
        const parsed = identity.parse(request);
        if (!matches(parsed))
            throw new Error("Native helper provenance mismatch");
        const current = owner;
        active = false;
        owner = undefined;
        current?.dispose();
        return { ...parsed, disposed: true };
    },
};

// Entry import is inert: no owner, locale load, handlers or ready signal until
// the host invokes bootstrap after validating its committed helper document.
for (const [name, value] of Object.entries(exports)) {
    Object.defineProperty(target, name, {
        value,
        configurable: false,
        writable: false,
        enumerable: false,
    });
}
