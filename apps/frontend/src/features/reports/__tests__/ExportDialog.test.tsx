// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { ExportDialog } from "@/features/reports/ExportDialog";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok, settingsWithBaselines } from "@/test/msw/handlers";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import { computeBelgianPIT } from "@/lib/belgianTax";
import * as reportsApi from "@/lib/api/reports";
import { useSettingsStore } from "@/stores/settingsStore";
import { LATEST_TAX_YEAR } from "@/lib/belgianTax/constants";
import {
    computeHouseholdTax,
    toBelgianTaxCalculation,
} from "@/lib/belgianTax/household";
import {
    activity,
    household,
    partner,
} from "@/lib/belgianTax/__tests__/testHousehold";

// jsdom does not implement these blob URL APIs
beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue("blob:fake");
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

// Mock the reports API module so fetch is never called.
// Node's fetch (undici) rejects relative URLs before MSW can intercept them.
vi.mock("@/lib/api/reports", () => ({
    downloadFinancialReport: vi.fn(),
    downloadPortfolioReport: vi.fn(),
    downloadTaxReport: vi.fn(),
}));

vi.mock("@/components/shared/DatePicker", () => ({
    DatePicker: ({
        id,
        onChange,
        placeholder,
        ...props
    }: {
        id?: string;
        onChange: (date?: Date) => void;
        placeholder?: string;
        [key: string]: unknown;
    }) => (
        <button
            type="button"
            id={id}
            aria-invalid={props["aria-invalid"] as boolean | undefined}
            aria-describedby={props["aria-describedby"] as string | undefined}
            onClick={() =>
                onChange(
                    id === "export-from"
                        ? new Date(2026, 11, 31)
                        : new Date(2026, 0, 1),
                )
            }
        >
            {placeholder}
        </button>
    ),
}));

function stubFinancialSuccess() {
    vi.mocked(reportsApi.downloadFinancialReport).mockResolvedValue(undefined);
}

function stubFinancialError() {
    vi.mocked(reportsApi.downloadFinancialReport).mockRejectedValue(
        new Error("Report download failed: 500 Internal Server Error"),
    );
}

async function openDialog() {
    const user = userEvent.setup();
    renderWithApp(<ExportDialog />);
    const trigger = await screen.findByRole("button", { name: /export pdf/i });
    await user.click(trigger);
    await screen.findByRole("dialog");
    return user;
}

describe("ExportDialog", () => {
    it("blocks an inverted custom range before submission", async () => {
        const user = await openDialog();
        await user.click(screen.getByRole("radio", { name: /custom range/i }));
        await user.click(screen.getByRole("button", { name: "From" }));
        await user.click(screen.getByRole("button", { name: "To" }));

        expect(screen.getByRole("alert")).toHaveTextContent(
            /start date must be on or before/i,
        );
        expect(
            screen.getByRole("button", { name: /download pdf/i }),
        ).toBeDisabled();
        expect(reportsApi.downloadFinancialReport).not.toHaveBeenCalled();
    });

    it("renders trigger button", async () => {
        renderWithApp(<ExportDialog />);
        expect(
            await screen.findByRole("button", { name: /export pdf/i }),
        ).toBeInTheDocument();
    });

    it("clicking trigger opens dialog", async () => {
        await openDialog();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("shows financial report sections by default", async () => {
        await openDialog();
        // The financial sections heading and at least one section label should appear
        expect(
            await screen.findByText(/executive summary/i),
        ).toBeInTheDocument();
        expect(await screen.findByText(/cash flow trend/i)).toBeInTheDocument();
    });

    it("switching to portfolio report type shows portfolio sections", async () => {
        const user = await openDialog();
        const portfolioRadio = await screen.findByRole("radio", {
            name: /portfolio/i,
        });
        await user.click(portfolioRadio);
        expect(
            await screen.findByText(/portfolio summary/i),
        ).toBeInTheDocument();
        expect(
            await screen.findByText(/portfolio allocation/i),
        ).toBeInTheDocument();
    });

    it("switching to tax report type shows tax sections", async () => {
        const user = await openDialog();
        const taxRadio = await screen.findByRole("radio", { name: /^tax$/i });
        await user.click(taxRadio);
        expect(await screen.findByText(/tax summary/i)).toBeInTheDocument();
        expect(
            await screen.findByText(/tax type breakdown/i),
        ).toBeInTheDocument();
    });

    it("Download button disabled when all sections unchecked", async () => {
        const user = await openDialog();
        // The "All" checkbox toggles all sections — click it to uncheck all
        const allCheckbox = await screen.findByRole("checkbox", {
            name: /^all$/i,
        });
        await user.click(allCheckbox); // uncheck all
        const downloadBtn = await screen.findByRole("button", {
            name: /download pdf/i,
        });
        expect(downloadBtn).toBeDisabled();
    });

    it("successful download closes dialog", async () => {
        stubFinancialSuccess();
        const user = await openDialog();
        const downloadBtn = await screen.findByRole("button", {
            name: /download pdf/i,
        });
        await user.click(downloadBtn);
        await waitFor(() => {
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    it("download error keeps dialog open", async () => {
        stubFinancialError();
        const user = await openDialog();
        const downloadBtn = await screen.findByRole("button", {
            name: /download pdf/i,
        });
        await user.click(downloadBtn);
        // Wait for the async error path to settle, then dialog should still be present
        await waitFor(() => {
            expect(screen.getByRole("dialog")).toBeInTheDocument();
        });
    });

    it("Cancel button closes dialog", async () => {
        const user = await openDialog();
        const cancelBtn = await screen.findByRole("button", {
            name: /cancel/i,
        });
        await user.click(cancelBtn);
        await waitFor(() => {
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key closes dialog", async () => {
        const user = await openDialog();
        await user.keyboard("{Escape}");
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        await openDialog();
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for keyboard nav", async () => {
        await openDialog();
        await screen.findByRole("dialog");
        const buttons = screen.getAllByRole("button");
        expect(buttons.length).toBeGreaterThan(0);
    });
    it.each(["", "1999", "2020.5", String(new Date().getFullYear() + 2)])(
        "blocks an invalid full year %s without falling back",
        async (year) => {
            const user = await openDialog();
            await user.click(
                screen.getByRole("radio", { name: /full year|specific year/i }),
            );
            const input = screen.getByLabelText(/^year$/i);
            fireEvent.change(input, { target: { value: year } });
            expect(input).toHaveAttribute("aria-invalid", "true");
            expect(screen.getByRole("alert")).toHaveTextContent(/2000/);
            expect(
                screen.getByRole("button", { name: /download pdf/i }),
            ).toBeDisabled();
            fireEvent.submit(input.closest("form")!);
            expect(reportsApi.downloadFinancialReport).not.toHaveBeenCalled();
            fireEvent.change(input, { target: { value: "2000" } });
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
            await user.click(
                screen.getByRole("button", { name: /download pdf/i }),
            );
            await waitFor(() =>
                expect(reportsApi.downloadFinancialReport).toHaveBeenCalledWith(
                    expect.objectContaining({
                        period: { kind: "year", year: 2000 },
                    }),
                ),
            );
        },
    );

    it.each(["financial", "portfolio", "tax"] as const)(
        "shows and sends only effective exclusions for %s reports",
        async (type) => {
            server.use(
                http.get("http://localhost:3002/api/settings", () =>
                    ok(
                        settingsWithBaselines({
                            dashboard_settings: {
                                exclusionScope: "statistics",
                                excludedCategoryIds: [11, 12],
                                excludedRecipientIds: [21],
                            },
                        }),
                    ),
                ),
            );
            const user = await openDialog();
            await user.click(
                screen.getByRole("radio", { name: new RegExp(type, "i") }),
            );
            if (type === "financial") {
                expect(
                    screen.getByText(/insights exclusions/i),
                ).toHaveTextContent(/2.*1/);
            } else {
                expect(
                    screen.queryByText(/insights exclusions/i),
                ).not.toBeInTheDocument();
            }
            await user.click(
                screen.getByRole("button", { name: /download pdf/i }),
            );
            const download =
                type === "financial"
                    ? reportsApi.downloadFinancialReport
                    : type === "portfolio"
                      ? reportsApi.downloadPortfolioReport
                      : reportsApi.downloadTaxReport;
            await waitFor(() =>
                expect(download).toHaveBeenCalledWith(
                    expect.objectContaining({
                        excludedCategoryIds:
                            type === "financial" ? [11, 12] : [],
                        excludedRecipientIds: type === "financial" ? [21] : [],
                    }),
                ),
            );
        },
    );

    describe("tax report household (ADR-200/201)", () => {
        const married = (gross: number) =>
            household(
                [
                    partner("A", [{ ...activity("employee", 60_000), id: "act_A_1" }]),
                    partner("B", [{ ...activity("employee", gross), id: "act_B_1" }]),
                ],
                {
                    taxYear: LATEST_TAX_YEAR,
                    relationship: {
                        events: [{ id: "evt_1", kind: "marriage", date: "2015-06-01" }],
                    },
                },
            );

        async function downloadTax(
            settings: Record<string, unknown>,
            { year = LATEST_TAX_YEAR, partners = 2 }: { year?: number | "rolling"; partners?: number } = {},
        ) {
            server.use(
                http.get("http://localhost:3002/api/settings", () =>
                    ok(settingsWithBaselines(settings)),
                ),
            );
            const user = userEvent.setup();
            renderWithApp(<ExportDialog defaultType="tax" />);
            await waitFor(() =>
                expect(useSettingsStore.getState().household?.partners).toHaveLength(partners),
            );
            await user.click(await screen.findByRole("button", { name: /export pdf/i }));
            if (year !== "rolling") {
                await user.click(
                    screen.getByRole("radio", { name: /full year|specific year/i }),
                );
                fireEvent.change(screen.getByLabelText(/^year$/i), {
                    target: { value: String(year) },
                });
            }
            await user.click(await screen.findByRole("button", { name: /download pdf/i }));
            await waitFor(() => expect(reportsApi.downloadTaxReport).toHaveBeenCalled());
            return vi.mocked(reportsApi.downloadTaxReport).mock.calls[0]![0]!;
        }

        it("sends the household and a row per partner", async () => {
            const live = married(20_000);
            const options = await downloadTax({ belgian_tax_household_v2: live });
            const expected = computeHouseholdTax(live);
            expect(options.household).toEqual(live);
            expect(options.precomputedHousehold?.assessmentMode).toBe("joint");
            expect(options.precomputedHousehold?.partners).toEqual(
                expected.partners.map((p) => ({
                    partnerId: p.partnerId,
                    grossIncome: p.grossIncome,
                    taxableIncome: p.taxableIncome,
                    totalPIT: p.totalPIT,
                })),
            );
            expect(options.precomputedPIT?.totalTax).toBeCloseTo(expected.totals.totalPIT, 6);
        });

        it("sends no household for a one-partner household", async () => {
            const single = household(
                [partner("A", [{ ...activity("employee", 60_000), id: "act_A_1" }])],
                { taxYear: LATEST_TAX_YEAR },
            );
            const options = await downloadTax(
                { belgian_tax_household_v2: single },
                { partners: 1 },
            );
            expect(options).not.toHaveProperty("household");
            expect(options).not.toHaveProperty("precomputedHousehold");
            expect(options.precomputedPIT?.totalTax).toBeGreaterThan(0);
        });

        it("exports the year the period covers, not the live tax year", async () => {
            const live = married(20_000);
            const previous = { ...married(35_000), taxYear: LATEST_TAX_YEAR - 1 };
            const options = await downloadTax(
                {
                    belgian_tax_household_v2: live,
                    belgian_tax_household_snapshots_v2: {
                        [LATEST_TAX_YEAR - 1]: previous,
                    },
                },
                { year: LATEST_TAX_YEAR - 1 },
            );
            expect(options.period).toEqual({ kind: "year", year: LATEST_TAX_YEAR - 1 });
            expect(options.taxProfile?.taxYear).toBe(LATEST_TAX_YEAR - 1);
            expect(options.household).toEqual(previous);
            expect(options.precomputedHousehold?.partners[1]?.grossIncome).toBe(35_000);
            expect(options.precomputedPIT?.totalTax).toBeCloseTo(
                computeHouseholdTax(previous).totals.totalPIT,
                6,
            );
        });

        it("omits annual tax and household figures for a rolling period", async () => {
            const live = married(20_000);
            const options = await downloadTax(
                { belgian_tax_household_v2: live },
                { year: "rolling" },
            );
            expect(options.period).toEqual({ kind: "rolling", months: 12 });
            expect(options.taxProfile).toBeUndefined();
            expect(options.precomputedPIT).toBeUndefined();
            expect(options.household).toBeUndefined();
        });

        it("exports a frozen year's frozen figures, not a live recompute", async () => {
            const live = married(20_000);
            const frozenHousehold = married(35_000);
            const frozen = computeHouseholdTax(frozenHousehold);
            const options = await downloadTax({
                belgian_tax_household_v2: live,
                belgian_tax_profile_snapshot_meta_v1: {
                    [LATEST_TAX_YEAR]: {
                        frozenCalculation: toBelgianTaxCalculation(frozen, frozenHousehold),
                        frozenHouseholdResult: frozen,
                        history: [],
                    },
                },
            });
            expect(options.precomputedPIT?.totalTax).toBe(frozen.totals.totalPIT);
            expect(options.precomputedHousehold?.partners[1]?.grossIncome).toBe(35_000);
        });
    });
});


it.each([false, true])('exports historical PIT only from an existing year profile (saved=%s), preserving frozen totals', async (saved) => {
    const live = { ...DEFAULT_BELGIAN_TAX_PROFILE, taxYear: 2026, profileConfigured: true };
    const historical = { ...live, taxYear: 2024 };
    const frozen = { ...computeBelgianPIT(historical), totalPIT: 12345 };
    server.use(http.get('http://localhost:3002/api/settings', () => ok(settingsWithBaselines({
        belgian_tax_profile: live,
        belgian_tax_profile_snapshots_v1: saved ? { 2024: historical } : {},
        belgian_tax_profile_snapshot_meta_v1: saved ? { 2024: { frozenCalculation: frozen } } : {},
    }))));
    const user = await openDialog();
    await user.click(screen.getByRole('radio', { name: /^tax$/i }));
    await user.click(screen.getByRole('radio', { name: /full year|specific year/i }));
    fireEvent.change(screen.getByLabelText(/^year$/i), { target: { value: '2024' } });
    await user.click(screen.getByRole('button', { name: /download pdf/i }));
    await waitFor(() => expect(reportsApi.downloadTaxReport).toHaveBeenCalled());
    const options = vi.mocked(reportsApi.downloadTaxReport).mock.calls[0]?.[0];
    if (saved) {
        expect(options?.taxProfile?.taxYear).toBe(2024);
        expect(options?.precomputedPIT?.totalTax).toBe(12345);
    } else {
        expect(options?.taxProfile).toBeUndefined();
        expect(options?.precomputedPIT).toBeUndefined();
    }
});

it('exports a historical year that has only a frozen calculation, using its frozen totals', async () => {
    const live = { ...DEFAULT_BELGIAN_TAX_PROFILE, taxYear: 2026, profileConfigured: true };
    const frozen = { ...computeBelgianPIT({ ...live, taxYear: 2024 }), totalPIT: 12345 };
    server.use(http.get('http://localhost:3002/api/settings', () => ok(settingsWithBaselines({
        belgian_tax_profile: live,
        belgian_tax_profile_snapshot_meta_v1: { 2024: { frozenCalculation: frozen } },
    }))));
    const user = await openDialog();
    await user.click(screen.getByRole('radio', { name: /^tax$/i }));
    await user.click(screen.getByRole('radio', { name: /full year|specific year/i }));
    fireEvent.change(screen.getByLabelText(/^year$/i), { target: { value: '2024' } });
    await user.click(screen.getByRole('button', { name: /download pdf/i }));
    await waitFor(() => expect(reportsApi.downloadTaxReport).toHaveBeenCalled());
    const options = vi.mocked(reportsApi.downloadTaxReport).mock.calls[0]?.[0];
    expect(options?.taxProfile?.taxYear).toBe(2024);
    expect(options?.precomputedPIT?.totalTax).toBe(12345);
});
