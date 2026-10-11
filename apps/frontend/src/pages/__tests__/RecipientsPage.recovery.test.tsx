// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import { recipientRow } from "@/test/msw/rowFixtures";
import RecipientsPage from "@/pages/RecipientsPage";

vi.mock("@/components/shared/VirtualDataTable", () => ({
    VirtualDataTable: ({
        data,
        serverMode,
    }: {
        data: { id: number; name: string }[];
        serverMode: { pagination: { onLoadMore: () => void } };
    }) => (
        <div>
            {data.map((row) => (
                <p key={row.id}>{row.name}</p>
            ))}
            <button onClick={serverMode.pagination.onLoadMore}>
                Load next page
            </button>
        </div>
    ),
}));

it("keeps loaded recipients and retries a failed next page at the same offset", async () => {
    const user = userEvent.setup();
    const offsets: number[] = [];
    let failing = true;
    const recipient = (id: number, name: string) =>
        recipientRow({ id, name, is_active: true });
    server.use(
        http.get("http://localhost:3002/api/recipients", ({ request }) => {
            const offset = Number(
                new URL(request.url).searchParams.get("offset") ?? 0,
            );
            offsets.push(offset);
            if (offset === 1 && failing) return err(403, "Unavailable");
            return ok({
                items: [
                    offset === 0
                        ? recipient(1, "First recipient")
                        : recipient(2, "Second recipient"),
                ],
                total: 2,
                limit: 200,
                offset,
                links: [],
            });
        }),
    );
    renderWithApp(<RecipientsPage />);
    expect(await screen.findByText("First recipient")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load next page" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("First recipient")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
        "Couldn't load more payees",
    );
    failing = false;
    await user.click(retry);
    expect(await screen.findByText("Second recipient")).toBeInTheDocument();
    expect(screen.getByText("First recipient")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(offsets).toEqual([0, 1, 1]);
});
