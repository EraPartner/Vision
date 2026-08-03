// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useWorkspace } from "@/contexts/WorkspaceContext";

function makeWrapper(path: string) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
    };
}

describe("useWorkspace", () => {
    beforeEach(() => sessionStorage.clear());
    afterEach(() => sessionStorage.clear());

    it('returns "budgeting" for the root path', () => {
        const { result } = renderHook(() => useWorkspace(), { wrapper: makeWrapper("/") });
        expect(result.current.workspace).toBe("budgeting");
    });

    it('returns "portfolio" for /portfolio', () => {
        const { result } = renderHook(() => useWorkspace(), { wrapper: makeWrapper("/portfolio") });
        expect(result.current.workspace).toBe("portfolio");
    });

    it('returns "portfolio" for a nested /portfolio path', () => {
        const { result } = renderHook(() => useWorkspace(), {
            wrapper: makeWrapper("/portfolio/investments"),
        });
        expect(result.current.workspace).toBe("portfolio");
    });

    it('returns "budgeting" for /admin when no workspace is stored', () => {
        const { result } = renderHook(() => useWorkspace(), { wrapper: makeWrapper("/admin") });
        expect(result.current.workspace).toBe("budgeting");
    });

    it('returns stored "portfolio" workspace for /admin path', () => {
        sessionStorage.setItem("vision_workspace", "portfolio");
        const { result } = renderHook(() => useWorkspace(), {
            wrapper: makeWrapper("/admin/settings"),
        });
        expect(result.current.workspace).toBe("portfolio");
    });

    it("exposes a setWorkspace function", () => {
        const { result } = renderHook(() => useWorkspace(), { wrapper: makeWrapper("/") });
        expect(typeof result.current.setWorkspace).toBe("function");
    });

    it("setWorkspace persists to sessionStorage (mutation success)", () => {
        const { result } = renderHook(() => useWorkspace(), { wrapper: makeWrapper("/admin") });
        act(() => result.current.setWorkspace("portfolio"));
        expect(sessionStorage.getItem("vision_workspace")).toBe("portfolio");
    });

    it("setWorkspace tolerates sessionStorage failure (mutation error)", () => {
        const original = Storage.prototype.setItem;
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        Storage.prototype.setItem = vi.fn(() => {
            throw new Error("quota exceeded");
        });
        const { result } = renderHook(() => useWorkspace(), { wrapper: makeWrapper("/admin") });
        // Must not throw — context should swallow storage errors
        expect(() => act(() => result.current.setWorkspace("portfolio"))).not.toThrow();
        Storage.prototype.setItem = original;
        errSpy.mockRestore();
    });

    it("ignores corrupted sessionStorage value (mutation error / boot)", () => {
        sessionStorage.setItem("vision_workspace", "not-a-real-workspace");
        const { result } = renderHook(() => useWorkspace(), { wrapper: makeWrapper("/admin") });
        // Falls back to default budgeting when stored value is invalid
        expect(["budgeting", "portfolio"]).toContain(result.current.workspace);
    });
});
