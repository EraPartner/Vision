import { describe, expect, it } from "vitest";
import { schemaNewerDescription } from "./restoreErrors";

describe("schemaNewerDescription", () => {
    it("recognises the marker behind the Error: prefix the desktop handler adds", () => {
        expect(
            schemaNewerDescription(
                'Error: BUNDLE_SCHEMA_NEWER: This backup was created on schema revision "b" but this app is on "a".',
            ),
        ).toBe(
            'This backup was created on schema revision "b" but this app is on "a".',
        );
    });

    it("recognises a bare marker", () => {
        expect(schemaNewerDescription("BUNDLE_SCHEMA_NEWER: newer")).toBe(
            "newer",
        );
    });

    it("returns undefined for other errors", () => {
        expect(
            schemaNewerDescription("Error: INVALID_PASSPHRASE"),
        ).toBeUndefined();
        expect(schemaNewerDescription("")).toBeUndefined();
    });
});
