// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err, RECIPIENT_STUB } from "@/test/msw/handlers";
import { CustomChartBuilderModal } from "@/components/statistics/CustomChartBuilderModal";
import type { StatisticsData } from "@/hooks/useStatistics";
import type { SavedChart } from "@/lib/api/types";

const API_BASE = "http://localhost:3002";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STATS_DATA: StatisticsData = {
    monthlyData: [],
    categoryPivot: [
        {
            categoryName: "FOOD:GROCERIES",
            categoryId: 1,
            months: {},
            incomeMonths: {},
            expenseMonths: {},
            netMonths: {},
            total: -500,
            incomeTotal: 0,
            expenseTotal: -500,
            netTotal: -500,
        },
        {
            categoryName: "TRANSPORT:CAR",
            categoryId: 2,
            months: {},
            incomeMonths: {},
            expenseMonths: {},
            netMonths: {},
            total: -200,
            incomeTotal: 0,
            expenseTotal: -200,
            netTotal: -200,
        },
    ],
    topRecipients: [],
    topRecipientsByYear: {},
    yearlyComparison: [],
    allPeriods: [],
    allYears: [],
    totalIncome: 0,
    totalSpending: -700,
    averageMonthlySpending: 0,
    averageMonthlyIncome: 0,
};

const SAVED_CHART: SavedChart = {
    id: 1,
    name: "My chart",
    chart_type: "bar",
    chart_variant: "default",
    time_bucket: "monthly",
    category_ids: [1],
    recipient_ids: [],
    tag_ids: [],
    all_categories: false,
    all_recipients: false,
    all_tags: false,
    date_range_start: null,
    date_range_end: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "",
};

const SAVED_CHART_STUB = { ...SAVED_CHART };

const RECIPIENT_WITH_NAME = {
    ...RECIPIENT_STUB,
    id: 10,
    name: "Alice",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CustomChartBuilderModal", () => {
    it("renders dialog when open=true", async () => {
        // Arrange
        const onOpenChange = vi.fn();
        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={onOpenChange} data={STATS_DATA} />,
        );

        // Assert
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("Save button disabled when name is empty", async () => {
        // Arrange
        const onOpenChange = vi.fn();
        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={onOpenChange} data={STATS_DATA} />,
        );

        // Assert — no name entered, no categories selected
        const saveBtn = await screen.findByRole("button", { name: "Save" });
        expect(saveBtn).toBeDisabled();
    });

    it("Save button disabled when name entered but no category or recipient selected", async () => {
        // Arrange
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={onOpenChange} data={STATS_DATA} />,
        );

        // Act — type a name only
        const nameInput = await screen.findByPlaceholderText("e.g. Groceries over time");
        await user.type(nameInput, "My chart");

        // Assert
        const saveBtn = screen.getByRole("button", { name: "Save" });
        expect(saveBtn).toBeDisabled();
    });

    it("Save button enabled when name and at least one category selected", async () => {
        // Arrange
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={onOpenChange} data={STATS_DATA} />,
        );

        // Act — type a name; wait for i18n via the placeholder text
        const nameInput = await screen.findByPlaceholderText("e.g. Groceries over time");
        await user.type(nameInput, "My chart");

        // Act — open category combobox (index 2: after chart-type[0] and time-bucket[1])
        const combos = screen.getAllByRole("combobox");
        const catTrigger = combos[2];
        await user.click(catTrigger);
        const categoryOption = await screen.findByRole("option", { name: /FOOD:GROCERIES/i });
        await user.click(categoryOption);

        // Assert
        const saveBtn = screen.getByRole("button", { name: "Save" });
        expect(saveBtn).not.toBeDisabled();
    });

    it("create mode: submitting calls POST /api/saved-charts and calls onOpenChange(false)", async () => {
        // Arrange
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        let interceptedBody: unknown;

        server.use(
            http.post(`${API_BASE}/api/saved-charts`, async ({ request }) => {
                interceptedBody = await request.json();
                return ok(SAVED_CHART_STUB);
            }),
        );

        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={onOpenChange} data={STATS_DATA} />,
        );

        // Act — enter name
        const nameInput = await screen.findByPlaceholderText("e.g. Groceries over time");
        await user.type(nameInput, "My chart");

        // Act — select a category (index 2: after chart-type[0] and time-bucket[1])
        const combos = screen.getAllByRole("combobox");
        const catTrigger = combos[2];
        await user.click(catTrigger);
        const categoryOption = await screen.findByRole("option", { name: /FOOD:GROCERIES/i });
        await user.click(categoryOption);

        // Act — close popover by pressing Escape, then save
        await user.keyboard("{Escape}");
        const saveBtn = screen.getByRole("button", { name: "Save" });
        await user.click(saveBtn);

        // Assert
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(interceptedBody).toBeDefined();
    });

    it("edit mode: form pre-populated with editChart data", async () => {
        // Arrange
        const onOpenChange = vi.fn();
        renderWithApp(
            <CustomChartBuilderModal
                open={true}
                onOpenChange={onOpenChange}
                data={STATS_DATA}
                editChart={SAVED_CHART}
            />,
        );

        // Assert — name input should show the chart name
        const nameInput = await screen.findByDisplayValue("My chart");
        expect(nameInput).toBeInTheDocument();

        // Assert — selected category badge should appear (may appear in both badge and dropdown option)
        const catLabels = await screen.findAllByText("FOOD:GROCERIES");
        expect(catLabels.length).toBeGreaterThanOrEqual(1);
    });

    it("edit mode: submitting calls PATCH /api/saved-charts/:id and calls onOpenChange(false)", async () => {
        // Arrange
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        let patchCalled = false;

        server.use(
            http.patch(`${API_BASE}/api/saved-charts/:id`, async () => {
                patchCalled = true;
                return ok(SAVED_CHART_STUB);
            }),
        );

        renderWithApp(
            <CustomChartBuilderModal
                open={true}
                onOpenChange={onOpenChange}
                data={STATS_DATA}
                editChart={SAVED_CHART}
            />,
        );

        // Act — save without changing anything (name + category already populated)
        const saveBtn = await screen.findByRole("button", { name: /save/i });
        await user.click(saveBtn);

        // Assert
        await waitFor(() => expect(patchCalled).toBe(true));
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("close/cancel button calls onOpenChange(false)", async () => {
        // Arrange
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={onOpenChange} data={STATS_DATA} />,
        );

        // Act
        const cancelBtn = await screen.findByRole("button", { name: "Cancel" });
        await user.click(cancelBtn);

        // Assert
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("recipients loaded from API and shown in recipient selector", async () => {
        // Arrange
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({ items: [RECIPIENT_WITH_NAME], total: 1, limit: 200, offset: 0, links: [] }),
            ),
        );

        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={onOpenChange} data={STATS_DATA} />,
        );

        // Act — open recipient combobox (index 3: after chart-type[0], time-bucket[1], category[2])
        const nameInput2 = await screen.findByPlaceholderText("e.g. Groceries over time");
        expect(nameInput2).toBeInTheDocument(); // wait for i18n
        const combos = screen.getAllByRole("combobox");
        const recTrigger = combos[3];
        await user.click(recTrigger);

        // Assert — loaded recipient name appears in the list
        expect(await screen.findByText("Alice")).toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={vi.fn()} data={STATS_DATA} />,
        );
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for keyboard nav", async () => {
        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={vi.fn()} data={STATS_DATA} />,
        );
        await screen.findByRole("dialog");
        const inputs = screen.getAllByRole("textbox");
        expect(inputs.length).toBeGreaterThan(0);
    });

    // ─── F3: Submit error ─────────────────────────────────────────────────

    it("POST 5xx: dialog stays open (does not call onOpenChange(false))", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const user = userEvent.setup();
        const onOpenChange = vi.fn();

        server.use(
            http.post(`${API_BASE}/api/saved-charts`, () => err(500, "save failed")),
        );

        renderWithApp(
            <CustomChartBuilderModal open={true} onOpenChange={onOpenChange} data={STATS_DATA} />,
        );

        const nameInput = await screen.findByPlaceholderText("e.g. Groceries over time");
        await user.type(nameInput, "My chart");

        const combos = screen.getAllByRole("combobox");
        const catTrigger = combos[2];
        await user.click(catTrigger);
        const categoryOption = await screen.findByRole("option", { name: /FOOD:GROCERIES/i });
        await user.click(categoryOption);

        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Save" }));

        // Wait for the failed mutation to settle
        await new Promise((r) => setTimeout(r, 400));
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
        errSpy.mockRestore();
    });
});
