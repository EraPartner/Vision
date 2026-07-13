// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { apiClient } from "@/lib/api";
import { BehaviorSection } from "@/components/settings/sections/BehaviorSection";

// The server-computed portfolio summary reads the TOP-LEVEL cost_basis_method
// setting (portfolioSummaryService.resolveCostBasisMethod), not the
// app_settings blob the Select historically wrote — so changing the method
// must also persist that key and refresh the server-computed summaries.

function costBasisTrigger(): Promise<HTMLElement> {
    // findBy: the provider stack resolves settings before children render.
    return screen.findByRole("combobox", { name: /cost basis method/i });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("BehaviorSection — cost basis method", () => {
    it("persists the top-level cost_basis_method key and refreshes portfolio summaries", async () => {
        const saveSetting = vi
            .spyOn(apiClient, "saveSetting")
            .mockResolvedValue({ key: "cost_basis_method", value: "fifo" });
        const user = userEvent.setup();
        const { queryClient } = renderWithApp(<BehaviorSection />);
        const invalidate = vi.spyOn(queryClient, "invalidateQueries");

        await user.click(await costBasisTrigger());
        await user.click(await screen.findByRole("option", { name: /fifo/i }));

        await waitFor(() => {
            expect(saveSetting).toHaveBeenCalledWith("cost_basis_method", "fifo");
        });
        await waitFor(() => {
            expect(invalidate).toHaveBeenCalledWith({ queryKey: ["portfolio-summary"] });
        });
    });

    it("surfaces a save failure instead of swallowing it", async () => {
        vi.spyOn(apiClient, "saveSetting").mockRejectedValue(new Error("boom"));
        const { toast } = await import("sonner");
        const errorToast = vi.spyOn(toast, "error").mockReturnValue("t" as never);
        const user = userEvent.setup();
        renderWithApp(<BehaviorSection />);

        await user.click(await costBasisTrigger());
        await user.click(await screen.findByRole("option", { name: /lifo/i }));

        await waitFor(() => {
            expect(errorToast).toHaveBeenCalled();
        });
    });
});
