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
        onEdit,
    }: {
        savedChart: SavedChart;
        onDelete: (chart: SavedChart, opener: HTMLButtonElement) => void;
        onEdit: (chart: SavedChart, opener: HTMLButtonElement) => void;
    }) => (
        <>
            <button
                type="button"
                onClick={(event) => onDelete(savedChart, event.currentTarget)}
            >
                Delete {savedChart.name}
            </button>
            <button
                type="button"
                onClick={(event) => onEdit(savedChart, event.currentTarget)}
            >
                Edit {savedChart.name}
            </button>
        </>
    ),
}));

vi.mock("@/features/statistics/CustomChartBuilderModal", async () => {
    const { Dialog, DialogContent, DialogTitle } =
        await import("@/components/ui/dialog");
    return {
        CustomChartBuilderModal: ({
            open,
            onOpenChange,
            onCloseAutoFocus,
        }: {
            open: boolean;
            onOpenChange: (open: boolean) => void;
            onCloseAutoFocus: () => void;
        }) => (
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent
                    aria-describedby={undefined}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        onCloseAutoFocus();
                    }}
                >
                    <DialogTitle>Chart builder</DialogTitle>
                    <button onClick={() => onOpenChange(false)}>
                        Cancel builder
                    </button>
                </DialogContent>
            </Dialog>
        ),
    };
});

describe("SavedChartsSection", () => {
    it("restores each edit or new-chart opener after cancelling the builder", async () => {
        const user = userEvent.setup();
        renderWithApp(<SavedChartsSection data={{} as StatisticsData} />);
        for (const name of [
            "Edit Monthly cash flow",
            "Edit Category trend",
            "New chart",
        ]) {
            const opener = await screen.findByRole("button", { name });
            await user.click(opener);
            await user.click(
                await screen.findByRole("button", { name: "Cancel builder" }),
            );
            await waitFor(() => expect(opener).toHaveFocus());
        }
    });

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
        await waitFor(() =>
            expect(
                screen.getByRole("button", {
                    name: "Delete Monthly cash flow",
                }),
            ).toHaveFocus(),
        );

        await user.click(
            screen.getByRole("button", { name: "Delete Category trend" }),
        );
        dialog = await screen.findByRole("alertdialog");
        expect(within(dialog).getByText(/Category trend/)).toBeInTheDocument();
        await user.click(
            within(dialog).getByRole("button", { name: /delete/i }),
        );

        await waitFor(() =>
            expect(mutate).toHaveBeenCalledWith(
                22,
                expect.objectContaining({ onSuccess: expect.any(Function) }),
            ),
        );
        expect(mutate).toHaveBeenCalledTimes(1);
    });
});
