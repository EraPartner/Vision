// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { SavedChartsSection } from "@/features/statistics/SavedChartsSection";
import type { SavedChart } from "@/types/apiClient";
import type { StatisticsData } from "@/hooks/useStatistics";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));

const charts = [
    { id: 11, name: "Monthly cash flow" },
    { id: 22, name: "Category trend" },
] as SavedChart[];

vi.mock("@/hooks/useSavedCharts", () => ({
    useSavedCharts: () => ({ data: charts, isLoading: false }),
    useDeleteSavedChart: () => ({ mutate, isPending: false }),
}));

vi.mock("@/features/statistics/CustomChart", () => ({
    CustomChart: ({
        savedChart,
        onDelete,
    }: {
        savedChart: SavedChart;
        onDelete: (chart: SavedChart) => void;
    }) => (
        <button type="button" onClick={() => onDelete(savedChart)}>
            Delete {savedChart.name}
        </button>
    ),
}));

vi.mock("@/features/statistics/CustomChartBuilderModal", () => ({
    CustomChartBuilderModal: () => null,
}));

describe("SavedChartsSection", () => {
    it("cancels without mutation and confirms deletion of the captured chart id", async () => {
        mutate.mockReset();
        const user = userEvent.setup();
        renderWithApp(<SavedChartsSection data={{} as StatisticsData} />);

        await user.click(
            screen.getByRole("button", { name: "Delete Monthly cash flow" }),
        );
        let dialog = await screen.findByRole("alertdialog");
        expect(
            within(dialog).getByText(/Monthly cash flow/),
        ).toBeInTheDocument();
        await user.click(
            within(dialog).getByRole("button", { name: /cancel/i }),
        );
        expect(mutate).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Delete Category trend" }),
        );
        dialog = await screen.findByRole("alertdialog");
        expect(within(dialog).getByText(/Category trend/)).toBeInTheDocument();
        await user.click(
            within(dialog).getByRole("button", { name: /delete/i }),
        );

        await waitFor(() => expect(mutate).toHaveBeenCalledWith(22));
        expect(mutate).toHaveBeenCalledTimes(1);
    });
});
