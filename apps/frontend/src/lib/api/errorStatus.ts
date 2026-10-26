import { isRecord } from "@/lib/isRecord";

/** The HTTP status carried by a thrown API error (`ApiClientError.status`), if any. */
export function errorStatus(err: unknown): number | undefined {
    return isRecord(err) && typeof err.status === "number"
        ? err.status
        : undefined;
}
