// @vitest-environment jsdom
/**
 * `?year=` mirroring for the two tax routes.
 *
 * The interesting cases are the ordering ones: adoption and mirroring run as
 * two effects in the same commit, so a naive implementation writes the live
 * year over an incoming `?year=` before the adoption lands.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { createElement, type ReactNode } from "react";

vi.mock("@/contexts/BelgianTaxProfileContext", () => ({
    useBelgianTaxProfile: vi.fn(),
}));

import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useTaxYearParam } from "@/hooks/useTaxYearParam";

const mockedProfileCtx = vi.mocked(useBelgianTaxProfile);

const LIVE_YEAR = 2026;

function setContext({
    viewedYear,
    setViewedYear,
    snapshotYears = [] as number[],
    isLoading = false,
}: {
    viewedYear: number;
    setViewedYear: (year: number) => void;
    snapshotYears?: number[];
    isLoading?: boolean;
}) {
    mockedProfileCtx.mockReturnValue({
        viewedYear,
        setViewedYear,
        profile: { taxYear: LIVE_YEAR },
        snapshotExistsForYear: (y: number) => snapshotYears.includes(y),
        isLoading,
    } as unknown as ReturnType<typeof useBelgianTaxProfile>);
}

function Probe({ onUrl }: { onUrl: (search: string) => void }) {
    useTaxYearParam();
    const location = useLocation();
    onUrl(location.search);
    return null;
}

function renderAt(initialUrl: string, onUrl: (search: string) => void): ReactNode {
    return render(
        createElement(
            MemoryRouter,
            { initialEntries: [initialUrl] },
            createElement(Probe, { onUrl }),
        ),
    ) as unknown as ReactNode;
}

describe("useTaxYearParam", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("adopts a valid ?year= into the provider without bouncing the URL to the live year", async () => {
        const setViewedYear = vi.fn();
        // Provider still reports the live year on the adoption commit — the
        // regression this guards is the mirror effect writing 2026 here.
        setContext({ viewedYear: LIVE_YEAR, setViewedYear, snapshotYears: [2023] });

        const urls: string[] = [];
        renderAt("/tax?year=2023", (s) => urls.push(s));

        await waitFor(() => expect(setViewedYear).toHaveBeenCalledWith(2023));
        expect(urls.every((u) => u === "?year=2023")).toBe(true);
    });

    it("falls back to the live year for an out-of-range year", async () => {
        const setViewedYear = vi.fn();
        setContext({ viewedYear: LIVE_YEAR, setViewedYear });

        const urls: string[] = [];
        renderAt("/tax?year=9999", (s) => urls.push(s));

        await waitFor(() => expect(urls.at(-1)).toBe(`?year=${LIVE_YEAR}`));
        expect(setViewedYear).not.toHaveBeenCalled();
    });

    it("ignores a non-numeric year and stamps the viewed year instead", async () => {
        const setViewedYear = vi.fn();
        setContext({ viewedYear: LIVE_YEAR, setViewedYear });

        const urls: string[] = [];
        renderAt("/tax?year=abc", (s) => urls.push(s));

        await waitFor(() => expect(urls.at(-1)).toBe(`?year=${LIVE_YEAR}`));
        expect(setViewedYear).not.toHaveBeenCalled();
    });

    it("writes the currently viewed year when the route carries no ?year=", async () => {
        const setViewedYear = vi.fn();
        setContext({ viewedYear: 2024, setViewedYear, snapshotYears: [2024] });

        const urls: string[] = [];
        renderAt("/portfolio/tax", (s) => urls.push(s));

        await waitFor(() => expect(urls.at(-1)).toBe("?year=2024"));
        expect(setViewedYear).not.toHaveBeenCalled();
    });

    it("preserves unrelated params when stamping the year", async () => {
        const setViewedYear = vi.fn();
        setContext({ viewedYear: 2024, setViewedYear, snapshotYears: [2024] });

        const urls: string[] = [];
        renderAt("/tax?tab=detail", (s) => urls.push(s));

        await waitFor(() => expect(urls.at(-1)).toContain("tab=detail"));
        expect(urls.at(-1)).toContain("year=2024");
    });

    it("does not adopt while the provider is still loading", async () => {
        const setViewedYear = vi.fn();
        setContext({ viewedYear: LIVE_YEAR, setViewedYear, isLoading: true });

        const urls: string[] = [];
        renderAt("/tax?year=2023", (s) => urls.push(s));

        await waitFor(() => expect(urls.length).toBeGreaterThan(0));
        expect(setViewedYear).not.toHaveBeenCalled();
        // URL must be left alone so the pending deep link survives the load.
        expect(urls.every((u) => u === "?year=2023")).toBe(true);
    });
});
