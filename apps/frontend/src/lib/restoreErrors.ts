const SCHEMA_NEWER_MARKER = "BUNDLE_SCHEMA_NEWER:";

/**
 * Returns the human-readable part of a `BUNDLE_SCHEMA_NEWER` restore error, or
 * `undefined` for any other error. The desktop restore handler reports thrown
 * errors as `String(err)`, so the marker arrives behind an `Error: ` prefix and
 * must be searched for, not anchored at the start.
 */
export function schemaNewerDescription(
    errorMessage: string,
): string | undefined {
    const index = errorMessage.indexOf(SCHEMA_NEWER_MARKER);
    if (index === -1) return undefined;
    return errorMessage.slice(index + SCHEMA_NEWER_MARKER.length).trim();
}
