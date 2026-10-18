// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { useOnboarding } from "@/features/onboarding/useOnboarding";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { apiClient } from "@/lib/api";
import { NATIVE_ONBOARDING_EVENT, type NativeOnboardingState } from "@/lib/nativeShell";

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

afterEach(() => {
    Reflect.deleteProperty(window, "__VISION_NATIVE_ONBOARDING__");
    Reflect.deleteProperty(window, "__VISION_NATIVE_ONBOARDING_STATE__");
    vi.restoreAllMocks();
});

describe("useOnboarding", () => {
    it("keeps native onboarding unknown until a host receipt and never writes from web callbacks", async () => {
        const user = userEvent.setup();
        Object.defineProperty(window, "__VISION_NATIVE_ONBOARDING__", { value: true, configurable: true });
        const mirror: NativeOnboardingState = { complete: null, presented: false };
        Object.defineProperty(window, "__VISION_NATIVE_ONBOARDING_STATE__", { value: mirror, configurable: true });
        const reads = vi.spyOn(apiClient, "getSetting");
        const writes = vi.spyOn(apiClient, "saveSetting");
        renderWithApp(<Probe />);
        expect(screen.getByTestId("complete")).toHaveTextContent("false");
        expect(screen.getByTestId("loading")).toHaveTextContent("true");
        expect(reads.mock.calls.filter(([key]) => key === "onboarding_complete")).toHaveLength(0);
        localStorage.setItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT, "native-owned draft");
        const publish = (complete: boolean | null, presented: boolean) => act(() => {
            mirror.complete = complete;
            mirror.presented = presented;
            window.dispatchEvent(new CustomEvent(NATIVE_ONBOARDING_EVENT, { detail: { complete, presented } }));
        });
        publish(false, true);
        expect(screen.getByTestId("complete")).toHaveTextContent("false");
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
        await user.click(screen.getByRole("button", { name: "Complete" }));
        await user.click(screen.getByRole("button", { name: "Reset" }));
        expect(screen.getByTestId("complete")).toHaveTextContent("false");
        expect(writes.mock.calls.filter(([key]) => key === "onboarding_complete")).toHaveLength(0);
        expect(localStorage.getItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT)).toBe("native-owned draft");
        publish(true, false);
        expect(screen.getByTestId("complete")).toHaveTextContent("true");
        publish(null, false);
        expect(screen.getByTestId("complete")).toHaveTextContent("false");
        expect(screen.getByTestId("loading")).toHaveTextContent("true");
        publish(false, true);
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
    });

    it("reads a pre-mount native ACK and ignores malformed status events", () => {
        Object.defineProperty(window, "__VISION_NATIVE_ONBOARDING__", { value: true, configurable: true });
        Object.defineProperty(window, "__VISION_NATIVE_ONBOARDING_STATE__", {
            value: { complete: true, presented: false }, configurable: true,
        });
        renderWithApp(<Probe />);
        expect(screen.getByTestId("complete")).toHaveTextContent("true");
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
        act(() => window.dispatchEvent(new CustomEvent(NATIVE_ONBOARDING_EVENT, {
            detail: { complete: "false", presented: false },
        })));
        expect(screen.getByTestId("complete")).toHaveTextContent("true");
    });

    it("starts complete while loading and accepts only a strict true setting", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings/onboarding_complete`, () =>
                ok({
                    key: "onboarding_complete",
                    value: "true",
                    expected: { exists: true, value: "true" },
                }),
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
                ok({
                    key: "onboarding_complete",
                    value: true,
                    expected: { exists: true, value: true },
                }),
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
                        expected: { exists: true, value: body.value },
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
