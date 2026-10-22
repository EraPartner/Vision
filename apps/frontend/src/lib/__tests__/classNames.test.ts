import { describe, expect, it } from "vitest";
import { cva, cx } from "@/lib/classNames";

// Expected strings were checked against clsx 2.1.1 and
// class-variance-authority 0.7.1 before they were removed (ADR-245).
describe("cx", () => {
    it("joins strings, numbers, arrays and truthy object keys", () => {
        expect(cx("a", 0, 1, null, undefined, false, "", ["b", ["c", false]], { d: true, e: 0 })).toBe(
            "a 1 b c d",
        );
    });

    it("keeps clsx's handling of an empty truthy key", () => {
        expect(cx({ x: true, "": true })).toBe("x ");
        expect(cx("a", { "": true })).toBe("a");
    });
});

describe("cva", () => {
    const button = cva("base", {
        variants: {
            size: { sm: "s", lg: "l" },
            disabled: { true: "off", false: "on" },
        },
        defaultVariants: { size: "sm", disabled: false },
        compoundVariants: [
            { size: "lg", disabled: true, class: "lg-off" },
            { size: ["sm", "lg"], className: "any" },
        ],
    });

    it("applies defaults, props, compounds and extra classes in order", () => {
        expect(button()).toBe("base s on any");
        expect(button({ size: "lg", disabled: true, className: "x" })).toBe("base l off lg-off any x");
    });

    it("turns a variant off with null", () => {
        expect(button({ size: null })).toBe("base on");
    });

    it("works without variants", () => {
        expect(cva("only")({ class: "extra" })).toBe("only extra");
    });
});
