// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIChatSettingsSection } from "@/features/settings/AIChatSettingsSection";
import { ResearchKeysSection } from "@/features/settings/ResearchKeysSection";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";

const ollama = vi.hoisted(() => ({
    useStatus: vi.fn(),
    useModels: vi.fn(),
}));

vi.mock("@/hooks/useOllamaStatus", () => ({
    useOllamaStatus: ollama.useStatus,
    useOllamaModels: ollama.useModels,
}));

const API_BASE = "http://localhost:3002";

beforeEach(() => {
    ollama.useStatus.mockReturnValue({ data: undefined, isLoading: false });
    ollama.useModels.mockReturnValue({ data: [], isLoading: false });
});

describe("AI settings behavior", () => {
    it("keeps the URL, error, and recovery hint visible together", async () => {
        ollama.useStatus.mockReturnValue({
            data: {
                ok: false,
                displayUrl: "http://host.docker.internal:11434",
                error: "Connection refused",
                hint: "Restart Ollama and try again.",
            },
            isLoading: false,
        });

        renderWithApp(<AIChatSettingsSection value={undefined} onChange={vi.fn()} />);

        expect(await screen.findByText("http://host.docker.internal:11434")).toHaveClass("font-mono");
        expect(screen.getByText("Connection refused")).toHaveClass("text-destructive");
        expect(screen.getByText("Restart Ollama and try again.")).toBeInTheDocument();
        expect(screen.getByRole("combobox", { name: /default model/i })).toBeDisabled();
    });

    it("associates provider inputs and preserves save behavior", async () => {
        let savedKey: string | undefined;
        server.use(
            http.get(`${API_BASE}/api/research/provider-keys`, () => ok({
                items: [{
                    provider: "alpha_vantage",
                    label: "Alpha Vantage",
                    envVar: "ALPHA_VANTAGE_API_KEY",
                    configured: false,
                    source: "none",
                }],
                total: 1,
            })),
            http.put(`${API_BASE}/api/research/provider-keys/alpha_vantage`, async ({ request }) => {
                savedKey = ((await request.json()) as { api_key: string }).api_key;
                return ok({ items: [], total: 0 });
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<ResearchKeysSection />);

        const input = await screen.findByLabelText("Alpha Vantage");
        await user.type(input, "  secret-key  ");
        await user.click(screen.getByRole("button", { name: /save/i }));

        await waitFor(() => expect(savedKey).toBe("secret-key"));
        expect(input).toHaveValue("");
    });
});
