// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { StatisticsSection } from "../StatisticsSection";

describe("Statistics category groups", () => {
    it("names group checkboxes and supports keyboard and label toggles", async () => {
        server.use(
            http.get("http://localhost:3002/api/categories/tree", () =>
                ok({
                    items: [
                        {
                            id: 701,
                            name: "Fees",
                            path: ["Finance", "Fees"],
                            is_active: true,
                        },
                        {
                            id: 702,
                            name: "Interest",
                            path: ["Finance", "Interest"],
                            is_active: true,
                        },
                    ],
                    total: 2,
                    links: [],
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<StatisticsSection />);
        const group = await screen.findByRole("checkbox", {
            name: "Finance",
            exact: true,
        });
        const fees = screen.getByRole("checkbox", { name: /Fees/ });
        const interest = screen.getByRole("checkbox", { name: /Interest/ });
        expect(group).not.toBeChecked();
        group.focus();
        await user.keyboard(" ");
        expect(group).toBeChecked();
        expect(fees).toBeChecked();
        expect(interest).toBeChecked();
        await user.click(fees);
        expect(group).toBePartiallyChecked();
        await user.click(screen.getByText("Finance", { exact: true }));
        expect(group).toBeChecked();
        await user.keyboard(" ");
        expect(group).not.toBeChecked();
        expect(fees).not.toBeChecked();
        expect(interest).not.toBeChecked();
    });
});
