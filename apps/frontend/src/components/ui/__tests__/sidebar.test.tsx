// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarProvider, SidebarRail, SidebarTrigger } from "../sidebar";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/contexts/LanguageContext", () => ({
    useLanguage: () => ({
        t: (key: string) => key === "menu.toggleSidebar" ? "Zijbalk tonen/verbergen" : key,
    }),
}));

describe("sidebar controls", () => {
    it("uses the localized sidebar label for the trigger and rail", () => {
        render(
            <SidebarProvider>
                <SidebarTrigger />
                <SidebarRail />
            </SidebarProvider>,
        );

        const controls = screen.getAllByRole("button", { name: "Zijbalk tonen/verbergen" });
        expect(controls).toHaveLength(2);
        expect(controls[1]).toHaveAttribute("title", "Zijbalk tonen/verbergen");
    });
});
