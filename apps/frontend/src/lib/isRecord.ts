/** True for a non-null object, so its properties can be read as `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
