// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import RebalancePage from "@/pages/portfolio/RebalancePage";
import { apiClient } from "@/lib/api";

const { deletePlan, upsertPlan } = vi.hoisted(() => ({
    deletePlan: vi.fn().mockResolvedValue(undefined),
    upsertPlan: vi.fn().mockResolvedValue(undefined),
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
        upsertPlan,
        deletePlan,
        isSaving: false,
        isLoading: false,
    }),
}));

describe("RebalancePage saved-plan deletion", () => {
    beforeEach(() => {
        deletePlan.mockClear();
        upsertPlan.mockClear();
        vi.spyOn(apiClient, "computeRebalance").mockResolvedValue({
            availableCash: 0,
            actualValues: {},
            deployment: {},
            targetWeights: {},
            cashAccounts: [],
        } as never);
        vi.spyOn(apiClient, "computeCommitmentAwareCash").mockResolvedValue({
            candidateCashCap: 500,
            minimumProjectedBalance: 600,
            minimumDate: "2026-10-01",
            horizonEnd: "2026-12-18",
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

    it("parses EU grouped target weights and cash caps with the selected format", async () => {
        vi.mocked(apiClient.computeCommitmentAwareCash).mockResolvedValue({
            candidateCashCap: 5000,
            minimumProjectedBalance: 5000,
            minimumDate: "2026-10-01",
            horizonEnd: "2026-12-18",
        } as never);
        const calls: unknown[] = [];
        vi.spyOn(apiClient, "computeRebalance").mockImplementation(
            async (input) => {
                calls.push(input);
                return {
                    availableCash: 5000,
                    actualValues: {},
                    targetWeights: {},
                    deployment: {},
                } as never;
            },
        );
        const user = userEvent.setup();
        renderWithApp(<RebalancePage />, {
            initialEntries: [
                "/portfolio/rebalance?source=custom&target=stocks%3A1.234&cap=1.234",
            ],
        });

        expect(
            await screen.findByRole("textbox", { name: /target/i }),
        ).toHaveAttribute("inputmode", "decimal");
        expect(
            screen.getByRole("textbox", { name: /cap the cash/i }),
        ).toHaveAttribute("inputmode", "decimal");

        await user.click(
            await screen.findByRole("button", { name: /compute/i }),
        );

        await waitFor(() => {
            expect(calls.at(-1)).toMatchObject({
                targetWeights: { stocks: 12.34 },
                availableCash: 1234,
            });
        });
    });

    it("shows Awesome and saves its five targets as a custom plan", async () => {
        const user = userEvent.setup();
        renderWithApp(<RebalancePage />, {
            initialEntries: ["/portfolio/rebalance?source=custom"],
        });

        await user.click(
            (await screen.findByText(/load from a preset/i)).closest("button")!,
        );
        await user.click(
            await screen.findByRole("option", { name: /awesome portfolio/i }),
        );
        expect(
            screen.getAllByRole("textbox", { name: /target/i }),
        ).toHaveLength(5);
        expect(
            screen
                .getAllByRole("textbox", { name: /target/i })
                .map((input) => (input as HTMLInputElement).value),
        ).toEqual(["20", "20", "20", "20", "20"]);

        await user.type(
            screen.getByRole("textbox", { name: /plan name/i }),
            "My Awesome plan",
        );
        await user.click(screen.getByRole("button", { name: /save plan/i }));
        await waitFor(() =>
            expect(upsertPlan).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: "My Awesome plan",
                    targetWeights: {
                        real_estate: 0.2,
                        stocks: 0.2,
                        gold: 0.2,
                        bonds: 0.2,
                        savings: 0.2,
                    },
                }),
            ),
        );
    });

    it("shows all five Awesome targets when selected as the main preset", async () => {
        const user = userEvent.setup();
        renderWithApp(<RebalancePage />);

        await user.click(
            screen.getByRole("combobox", { name: /target allocation/i }),
        );
        await user.click(
            await screen.findByRole("option", { name: /awesome portfolio/i }),
        );
        const targets = within(
            screen.getByRole("list", { name: /^target$/i }),
        ).getAllByRole("listitem");
        expect(targets).toHaveLength(5);
        expect(targets.map((target) => target.textContent)).toEqual([
            "Real estate 20%",
            "Stocks 20%",
            "Gold 20%",
            "Bonds 20%",
            "Savings 20%",
        ]);
    });

    it("applies the 90-day candidate cap to presets and shows its assumptions", async () => {
        const user = userEvent.setup();
        renderWithApp(<RebalancePage />);
        const reserve = screen.getByRole("textbox", { name: /reserve floor/i });
        await user.clear(reserve);
        await user.type(reserve, "250");
        await user.click(screen.getByRole("button", { name: /compute plan/i }));

        await waitFor(() =>
            expect(apiClient.computeCommitmentAwareCash).toHaveBeenCalledWith({
                currency: "EUR",
                reserveFloor: 250,
            }),
        );
        await waitFor(() =>
            expect(apiClient.computeRebalance).toHaveBeenLastCalledWith(
                expect.objectContaining({ availableCash: 500 }),
            ),
        );
        expect(
            await screen.findByText(/not guaranteed spendable cash/i),
        ).toBeInTheDocument();
    });

    it("clears a computed estimate when the custom target changes", async () => {
        const user = userEvent.setup();
        renderWithApp(<RebalancePage />, {
            initialEntries: [
                "/portfolio/rebalance?source=custom&target=stocks%3A60",
            ],
        });
        await user.click(screen.getByRole("button", { name: /compute plan/i }));
        expect(
            await screen.findByText(/90-day cash estimate/i),
        ).toBeInTheDocument();

        await user.type(screen.getByRole("textbox", { name: /target/i }), "1");
        await waitFor(() =>
            expect(
                screen.queryByText(/90-day cash estimate/i),
            ).not.toBeInTheDocument(),
        );
    });
});
