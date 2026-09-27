// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LazyMotion, domAnimation } from "framer-motion";
import { renderWithApp } from "@/test/renderWithApp";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/layout/InsightsNavBadge", () => ({
    InsightsNavBadge: () => null,
}));
vi.mock("@/components/layout/MonitorInboxBadge", () => ({
    MonitorInboxBadge: () => null,
}));
vi.mock("@/hooks/usePortfolioPrefetch", () => ({
    usePortfolioPrefetch: () => ({
        prefetchNetWorth: vi.fn(),
        prefetchPerformance: vi.fn(),
    }),
}));

describe("workspace navigation", () => {
    it("lets a collapsed-sidebar user choose a workspace explicitly", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <LazyMotion features={domAnimation}>
                <SidebarProvider defaultOpen={false}>
                    <AppSidebar />
                </SidebarProvider>
            </LazyMotion>,
        );
        const trigger = await screen.findByRole("button", {
            name: /choose workspace: budgeting/i,
        });
        await user.click(trigger);
        expect(
            screen.getByRole("menuitemradio", { name: "Budgeting" }),
        ).toBeChecked();
        await user.click(
            screen.getByRole("menuitemradio", { name: "Research" }),
        );
        expect(
            await screen.findByRole("link", { name: /research home/i }),
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", { name: /choose workspace: research/i }),
        );
        expect(
            screen.getByRole("menuitemradio", { name: "Research" }),
        ).toBeChecked();
        await user.keyboard("{Home}{ArrowDown}{Enter}");
        expect(
            await screen.findByRole("button", {
                name: /choose workspace: portfolio/i,
            }),
        ).toBeInTheDocument();
    });
});
