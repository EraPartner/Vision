// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { OllamaStatusBanner } from "./OllamaStatusBanner";
import { ToolResultCard } from "./ToolResultCard";

describe("AI status copy", () => {
    it("uses the localized fallback for a tool failure without detail", async () => {
        renderWithApp(
            <ToolResultCard
                toolName="portfolio_lookup"
                result={{ ok: false }}
            />,
        );

        expect(
            await screen.findByText("portfolio_lookup: Tool failed."),
        ).toBeInTheDocument();
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
