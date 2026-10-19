// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardContent } from "./card";

describe("CardContent spacing", () => {
    it.each([
        ["default", "p-6 pt-0"],
        ["headerless", "p-6"],
        ["flush", "p-0"],
        ["compact", "p-4"],
        ["row", "px-6 py-4"],
        ["state", "px-6 py-8"],
    ] as const)("renders the %s spacing role", (variant, classes) => {
        const markup = renderToStaticMarkup(
            <CardContent variant={variant}>Content</CardContent>,
        );
        for (const className of classes.split(" ")) {
            expect(markup).toContain(className);
        }
    });
});
