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
                displayUrl: "http://localhost:11434",
                error: "Connection refused",
                hint: "Restart Ollama and try again.",
            },
            isLoading: false,
        });

        renderWithApp(
            <AIChatSettingsSection value={undefined} onChange={vi.fn()} />,
        );

        expect(await screen.findByText("http://localhost:11434")).toHaveClass(
            "font-mono",
        );
        expect(screen.getByText("Connection refused")).toHaveClass(
            "text-destructive",
        );
        expect(
            screen.getByText("Restart Ollama and try again."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("combobox", { name: /default model/i }),
        ).toBeDisabled();
    });

    describe("memory advisor line", () => {
        const GiB = 1024 ** 3;
        const fitFor = (model: string, over: Record<string, unknown> = {}) =>
            http.get(`${API_BASE}/api/ai/model/fit`, ({ request }) => {
                expect(new URL(request.url).searchParams.get("model")).toBe(
                    model,
                );
                return ok({
                    model,
                    totalMemoryBytes: 16 * GiB,
                    weightBytes: 4.9 * GiB,
                    kvBytesPerToken: 128 * 1024,
                    maxNumCtx: 16_384,
                    ...over,
                });
            });
        const readyStatus = () =>
            ollama.useStatus.mockReturnValue({
                data: {
                    ok: true,
                    defaultModel: "llama3.1:8b",
                    displayUrl: "http://localhost:11434",
                },
                isLoading: false,
            });
        const OLLAMA_TIP = /OLLAMA_FLASH_ATTENTION=1/;

        it("shows weights, context and total memory for the selected model", async () => {
            readyStatus();
            server.use(fitFor("llama3.1:8b"));
            renderWithApp(
                <AIChatSettingsSection value={undefined} onChange={vi.fn()} />,
            );
            expect(
                await screen.findByText(
                    "Uses about 4.9 GB plus up to 2.0 GB for conversation context, of 16 GB memory.",
                ),
            ).toBeInTheDocument();
            expect(screen.getByText(OLLAMA_TIP)).toBeInTheDocument();
        });

        it("hides the line when Ollama can't report the model's size", async () => {
            readyStatus();
            server.use(
                fitFor("llama3.1:8b", {
                    weightBytes: null,
                    kvBytesPerToken: null,
                    maxNumCtx: null,
                }),
            );
            renderWithApp(
                <AIChatSettingsSection value={undefined} onChange={vi.fn()} />,
            );
            await screen.findByRole("combobox", { name: /default model/i });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(screen.queryByText(/Uses about/)).not.toBeInTheDocument();
            expect(screen.queryByText(OLLAMA_TIP)).not.toBeInTheDocument();
        });

        it("shows nothing for the Apple Foundation model", async () => {
            readyStatus();
            let asked = false;
            server.use(
                http.get(`${API_BASE}/api/ai/model/fit`, () => {
                    asked = true;
                    return ok({});
                }),
            );
            renderWithApp(
                <AIChatSettingsSection
                    value="apple-foundation"
                    onChange={vi.fn()}
                />,
            );
            await screen.findByRole("combobox", { name: /default model/i });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(asked).toBe(false);
            expect(screen.queryByText(/Uses about/)).not.toBeInTheDocument();
        });
    });

    it("associates provider inputs and preserves save behavior", async () => {
        let savedKey: string | undefined;
        server.use(
            http.get(`${API_BASE}/api/research/provider-keys`, () =>
                ok({
                    items: [
                        {
                            provider: "alpha_vantage",
                            label: "Alpha Vantage",
                            envVar: "ALPHA_VANTAGE_API_KEY",
                            configured: false,
                            source: "none",
                        },
                    ],
                    total: 1,
                }),
            ),
            http.put(
                `${API_BASE}/api/research/provider-keys/alpha_vantage`,
                async ({ request }) => {
                    savedKey = ((await request.json()) as { api_key: string })
                        .api_key;
                    return ok({ items: [], total: 0 });
                },
            ),
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
