// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { OllamaStatusBanner } from "./OllamaStatusBanner";
import { ToolResultCard } from "./ToolResultCard";

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));

vi.mock("@/lib/logger", () => {
    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: loggerError,
    };
    return { logger, default: logger };
});

describe("AI status copy", () => {
    beforeEach(() => {
        loggerError.mockClear();
    });

    it("uses the localized fallback for a tool failure without detail", async () => {
        renderWithApp(
            <ToolResultCard
                toolName="portfolio_lookup"
                result={{ ok: false }}
            />,
        );

        expect(await screen.findByText("Tool failed.")).toBeInTheDocument();
    });

    it("keeps raw string diagnostics out of the card and writes them to the log", async () => {
        renderWithApp(
            <ToolResultCard
                toolName="planned_lookup"
                result={{
                    ok: false,
                    error: "Planned transaction 99 not found",
                }}
            />,
        );

        expect(await screen.findByText("Tool failed.")).toBeInTheDocument();
        expect(
            screen.queryByText(/planned transaction 99 not found/i),
        ).not.toBeInTheDocument();
        expect(loggerError).toHaveBeenCalledWith("AI tool returned an error", {
            toolName: "planned_lookup",
            error: "Planned transaction 99 not found",
        });
    });

    it("maps structured validation and availability errors to safe localized copy", async () => {
        const { rerender } = renderWithApp(
            <ToolResultCard
                toolName="expenses"
                result={{
                    ok: false,
                    error: {
                        code: "VALIDATION_ERROR",
                        field: "categoryId",
                        message: "categoryId must be a positive integer",
                    },
                }}
            />,
        );

        expect(
            await screen.findByText(
                "The AI action needs different input. Try rephrasing your request.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText(/categoryId/i)).not.toBeInTheDocument();

        rerender(
            <ToolResultCard
                toolName="invented_tool"
                result={{
                    ok: false,
                    error: {
                        code: "UNKNOWN_TOOL",
                        message: "Unknown tool: invented_tool",
                    },
                }}
            />,
        );

        expect(
            await screen.findByText("That AI action is not available."),
        ).toBeInTheDocument();
        expect(screen.queryByText(/unknown tool/i)).not.toBeInTheDocument();
    });

    it("does not expose a raw Ollama error as the primary user hint", async () => {
        renderWithApp(
            <OllamaStatusBanner
                isLoading={false}
                status={{
                    ok: false,
                    baseUrl: "http://localhost:11434",
                    defaultModel: "llama3",
                    enabled: true,
                    error: "connect ECONNREFUSED 127.0.0.1:11434",
                }}
            />,
        );

        expect(
            await screen.findByText(/install ollama and start it locally/i),
        ).toBeInTheDocument();
        expect(screen.queryByText(/econnrefused/i)).not.toBeInTheDocument();
    });

    it("loads the nested chart renderer only for a chart result", async () => {
        renderWithApp(
            <ToolResultCard
                toolName="portfolio_history"
                result={{
                    ok: true,
                    data: [],
                    meta: { renderAs: "line", xKey: "date", yKeys: ["value"] },
                }}
            />,
        );

        expect(await screen.findByText("No chart data.")).toBeInTheDocument();
    });
});
