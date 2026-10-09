// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { ScorecardPanel } from "../ResearchScorecard";

describe("ScorecardPanel", () => {
    it("shows the measured percentage in the same units as its benchmark", async () => {
        renderWithApp(
            <ScorecardPanel
                scorecard={{
                    score: 50,
                    grade: "mixed",
                    evaluated: 1,
                    counts: { ok: 0, caution: 1, warn: 0, risk: 0 },
                    flags: [
                        {
                            metric: "profitMargin",
                            category: "profitability",
                            better: "higher",
                            value: 0.025,
                            severity: "caution",
                            code: "profitMargin.caution",
                            reasonKey: "profitMargin.slim",
                            reason: "Slim net margin",
                            benchmark: "> 5%",
                        },
                    ],
                }}
            />,
        );
        expect(screen.getByText(/2[.,]50?\s*%/)).toBeInTheDocument();
        expect(await screen.findByText(/5%/)).toBeInTheDocument();
    });
});
