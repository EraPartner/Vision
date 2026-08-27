// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { useOnboarding } from "@/features/onboarding/useOnboarding";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({
    default: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

const API_BASE = "http://localhost:3002";

function installMemoryLocalStorage() {
    const backing = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => backing.get(key) ?? null,
            setItem: (key: string, value: string) =>
                void backing.set(key, String(value)),
            removeItem: (key: string) => void backing.delete(key),
            clear: () => backing.clear(),
        },
    });
}

function Probe() {
    const { isComplete, isLoading, complete, reset } = useOnboarding();
    return (
        <div>
            <span data-testid="complete">{String(isComplete)}</span>
            <span data-testid="loading">{String(isLoading)}</span>
            <button type="button" onClick={complete}>
                Complete
            </button>
            <button type="button" onClick={reset}>
                Reset
            </button>
        </div>
    );
}

beforeEach(() => {
    installMemoryLocalStorage();
    vi.mocked(toast.error).mockClear();
    localStorage.removeItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT);
});

describe("useOnboarding", () => {
    it("starts complete while loading and accepts only a strict true setting", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings/onboarding_complete`, () =>
                ok({ key: "onboarding_complete", value: "true" }),
            ),
        );

        renderWithApp(<Probe />);
        expect(screen.getByTestId("complete")).toHaveTextContent("true");
        expect(screen.getByTestId("loading")).toHaveTextContent("true");
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("false"),
        );
        expect(screen.getByTestId("complete")).toHaveTextContent("false");
    });

    it("loads a persisted boolean true", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings/onboarding_complete`, () =>
                ok({ key: "onboarding_complete", value: true }),
            ),
        );

        renderWithApp(<Probe />);
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("false"),
        );
        expect(screen.getByTestId("complete")).toHaveTextContent("true");
    });

    it("treats a failed setting read as incomplete", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings/onboarding_complete`, () =>
                err(500, "load failed"),
            ),
        );

        renderWithApp(<Probe />);
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("false"),
        );
        expect(screen.getByTestId("complete")).toHaveTextContent("false");
    });

    it("updates optimistically and persists complete and reset values", async () => {
        const user = userEvent.setup();
        const saved: unknown[] = [];
        server.use(
            http.put(
                `${API_BASE}/api/settings/onboarding_complete`,
                async ({ request }) => {
                    const body = (await request.json()) as { value: unknown };
                    saved.push(body.value);
                    return ok({
                        key: "onboarding_complete",
                        value: body.value,
                    });
                },
            ),
        );

        renderWithApp(<Probe />);
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("false"),
        );
        localStorage.setItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT, "draft");
        await user.click(screen.getByRole("button", { name: "Complete" }));
        expect(screen.getByTestId("complete")).toHaveTextContent("true");
        expect(
            localStorage.getItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT),
        ).toBeNull();
        await waitFor(() => expect(saved).toEqual([true]));

        localStorage.setItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT, "draft");
        await user.click(screen.getByRole("button", { name: "Reset" }));
        expect(screen.getByTestId("complete")).toHaveTextContent("false");
        expect(
            localStorage.getItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT),
        ).toBeNull();
        await waitFor(() => expect(saved).toEqual([true, false]));
    });

    it("keeps optimistic state and reports a persistence failure", async () => {
        const user = userEvent.setup();
        server.use(
            http.put(`${API_BASE}/api/settings/onboarding_complete`, () =>
                err(500, "save failed"),
            ),
        );

        renderWithApp(<Probe />);
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("false"),
        );
        localStorage.setItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT, "draft");
        await user.click(screen.getByRole("button", { name: "Complete" }));

        expect(screen.getByTestId("complete")).toHaveTextContent("true");
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "Couldn't save onboarding progress. Try again.",
            ),
        );
        expect(localStorage.getItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT)).toBe(
            "draft",
        );
    });
});
