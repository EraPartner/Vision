// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import RebalancePage from "@/pages/portfolio/RebalancePage";
import { apiClient } from "@/lib/api";

const { deletePlan } = vi.hoisted(() => ({
    deletePlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useRebalancePlans", () => ({
    useRebalancePlans: () => ({
        plans: [
            {
                id: "plan-1",
                name: "Balanced plan",
                targetWeights: { stocks: 0.6, bonds: 0.4 },
            },
        ],
        upsertPlan: vi.fn(),
        deletePlan,
        isSaving: false,
        isLoading: false,
    }),
}));

describe("RebalancePage saved-plan deletion", () => {
    beforeEach(() => {
        deletePlan.mockClear();
        vi.spyOn(apiClient, "computeRebalance").mockResolvedValue({
            availableCash: 0,
            actualValues: {},
        } as never);
    });

    it("keeps the plan on cancel and deletes exactly the selected plan on confirm", async () => {
        const user = userEvent.setup();
        renderWithApp(<RebalancePage />, {
            initialEntries: [
                "/portfolio/rebalance?source=plan%3Aplan-1&target=stocks%3A60&target=bonds%3A40&name=Balanced+plan",
            ],
        });

        const deleteButton = await screen.findByRole("button", {
            name: /delete plan/i,
        });
        await user.click(deleteButton);
        let dialog = await screen.findByRole("alertdialog");
        expect(within(dialog).getByText(/Balanced plan/)).toBeInTheDocument();
        await user.click(
            within(dialog).getByRole("button", { name: /cancel/i }),
        );
        expect(deletePlan).not.toHaveBeenCalled();

        await user.click(deleteButton);
        dialog = await screen.findByRole("alertdialog");
        await user.click(
            within(dialog).getByRole("button", { name: /delete plan/i }),
        );

        await waitFor(() => expect(deletePlan).toHaveBeenCalledWith("plan-1"));
        expect(deletePlan).toHaveBeenCalledTimes(1);
    });
});
