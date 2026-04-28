/**
 * downloadBlob helper tests.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { downloadBlob } from "./downloadBlob";

describe("downloadBlob", () => {
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;
    let originalCreate: typeof URL.createObjectURL;
    let originalRevoke: typeof URL.revokeObjectURL;

    beforeEach(() => {
        originalCreate = URL.createObjectURL;
        originalRevoke = URL.revokeObjectURL;
        createObjectURL = vi.fn(() => "blob:mock-url");
        revokeObjectURL = vi.fn();
        URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
        URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    });

    afterEach(() => {
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
    });

    test("creates an object URL, sets anchor download attribute, then revokes URL", () => {
        const clickSpy = vi.fn();
        const fakeAnchor = { click: clickSpy } as unknown as HTMLAnchorElement;
        const createElementSpy = vi.spyOn(document, "createElement").mockReturnValue(fakeAnchor);

        const blob = new Blob(["x"], { type: "text/csv" });
        downloadBlob(blob, "transactions_test.csv");

        expect(createObjectURL).toHaveBeenCalledWith(blob);
        expect((fakeAnchor as unknown as { href: string }).href).toBe("blob:mock-url");
        expect((fakeAnchor as unknown as { download: string }).download).toBe("transactions_test.csv");
        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

        createElementSpy.mockRestore();
    });

    test("revokes object URL even when click throws", () => {
        const clickSpy = vi.fn(() => {
            throw new Error("click failed");
        });
        const fakeAnchor = { click: clickSpy } as unknown as HTMLAnchorElement;
        const createElementSpy = vi.spyOn(document, "createElement").mockReturnValue(fakeAnchor);

        const blob = new Blob(["x"], { type: "text/csv" });
        expect(() => downloadBlob(blob, "fail.csv")).toThrow("click failed");
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

        createElementSpy.mockRestore();
    });
});
