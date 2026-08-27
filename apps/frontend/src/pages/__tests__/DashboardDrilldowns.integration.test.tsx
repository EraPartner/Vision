// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, TRANSACTION_STUB } from "@/test/msw/handlers";
import DashboardPage from "@/pages/DashboardPage";

vi.mock("@/components/charts", async (importOriginal) => {
    const original =
        await importOriginal<typeof import("@/components/charts")>();
    return {
        ...original,
        DonutChart: ({
            data,
        }: {
            data: Array<{ name: string; value: number; to?: string }>;
        }) => (
            <div>
                {data.map((item) =>
                    item.to ? (
                        <a key={item.name} href={item.to}>
                            {item.name}: {item.value}
                        </a>
                    ) : null,
                )}
            </div>
        ),
    };
});

const API_BASE = "http://localhost:3002";

describe("Dashboard category drill-down composition", () => {
    it("maps named, uncategorized, and Other slices to exact filters", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({
                    items: [
                        ...Array.from({ length: 6 }, (_, index) => ({
                            ...TRANSACTION_STUB,
                            id: index + 1,
                            category_id: index + 1,
                            category_name: `GROUP:CATEGORY ${index + 1}`,
                        })),
                        {
                            ...TRANSACTION_STUB,
                            id: 7,
                            category_id: null,
                            category_name: null,
                        },
                    ],
                    total: 7,
                    limit: 50,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        renderWithApp(<DashboardPage />);

        const named = await screen.findByRole("link", {
            name: /category 1: 1/i,
        });
        expect(
            new URL(
                named.getAttribute("href")!,
                "http://test",
            ).searchParams.get("category_id"),
        ).toBe("1");

        const uncategorized = screen.getByRole("link", {
            name: /uncategorized: 1/i,
        });
        expect(
            new URL(
                uncategorized.getAttribute("href")!,
                "http://test",
            ).searchParams.get("uncategorised"),
        ).toBe("true");

        const other = screen.getByRole("link", { name: /other: 1/i });
        expect(
            new URL(
                other.getAttribute("href")!,
                "http://test",
            ).searchParams.get("category_ids"),
        ).toBe("6");
    });
});
