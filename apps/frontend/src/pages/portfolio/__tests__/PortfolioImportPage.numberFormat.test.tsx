// @vitest-environment jsdom
import { expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import type { SavedPortfolioParserConfig } from "@/lib/api/portfolioImports";
import PortfolioImportPage from "../PortfolioImportPage";
import { DEFAULT_PORTFOLIO_IMPORT_CONFIG } from "../portfolioImportPresets";

it("saves, reloads, and submits the selected portfolio number format", async () => {
    const { number_format: _oldMissingField, ...oldConfig } =
        DEFAULT_PORTFOLIO_IMPORT_CONFIG;
    let stored: SavedPortfolioParserConfig = {
        id: 41,
        name: "My Trades",
        kind: "custom",
        config: {
            ...oldConfig,
            dateColumn: "Date",
            symbolColumn: "Symbol",
            amountColumn: "Amount",
            nameColumn: "Café",
            separator: ";",
            encoding: "windows-1252",
            skipRows: 1,
        },
        created_at: "",
        updated_at: "",
    };
    let submittedFormat: string | undefined;
    const api = "http://localhost:3002/api/portfolio/import";
    server.use(
        http.get(`${api}/parsers`, () => ok({ items: [stored], total: 1 })),
        http.patch(`${api}/parsers/41`, async ({ request }) => {
            const patch = (await request.json()) as Pick<
                SavedPortfolioParserConfig,
                "name" | "config"
            >;
            stored = { ...stored, ...patch };
            return ok(stored);
        }),
        http.post(`${api}/csv/stream`, async ({ request }) => {
            // jsdom File objects are incompatible with Node's multipart parser.
            submittedFormat = (await request.text()).match(
                /name="number_format"\r\n\r\n([^\r\n]+)/,
            )?.[1];
            return new HttpResponse(
                'event: complete\ndata: {"batch_id":2,"imported":1,"duplicates":0,"errors":0}\n\n',
                { headers: { "Content-Type": "text/event-stream" } },
            );
        }),
    );
    const user = userEvent.setup();
    async function pickSavedParser() {
        await user.click(
            await screen.findByText("Advanced single-file import"),
        );
        await user.click(
            await screen.findByRole("combobox", { name: "Parser" }),
        );
        await user.click(
            await screen.findByRole("option", { name: "My Trades" }),
        );
    }

    const first = renderWithApp(<PortfolioImportPage />);
    await pickSavedParser();
    await user.click(screen.getByText("CSV format options"));
    const formatSelect = screen.getByRole("combobox", {
        name: "Number format",
    });
    expect(formatSelect).toHaveTextContent("Automatic");
    await user.click(formatSelect);
    await user.click(
        screen.getByRole("option", { name: "Decimal point (1,234.56)" }),
    );
    await user.click(screen.getByText("Save this setup for reuse"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
        expect(stored.config.number_format).toBe("decimal_dot"),
    );
    first.unmount();

    renderWithApp(<PortfolioImportPage />);
    await pickSavedParser();
    await user.click(screen.getByText("CSV format options"));
    expect(
        screen.getByRole("combobox", { name: "Number format" }),
    ).toHaveTextContent("Decimal point");
    const input = screen
        .getByText("Advanced single-file import")
        .closest("details")!
        .querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
        input,
        new File(
            [
                Uint8Array.from([
                    ...new TextEncoder().encode("Statement\nDate;Symbol;Caf"),
                    0xe9,
                    ...new TextEncoder().encode(";Amount\n2026-01-01;AAPL;"),
                    0x80,
                    ...new TextEncoder().encode(";1,234"),
                ]),
            ],
            "trades.csv",
            { type: "text/csv" },
        ),
    );
    expect(await screen.findByText("4 columns")).toBeInTheDocument();
    await waitFor(() =>
        expect(screen.getByLabelText(/Price column/)).toHaveAttribute(
            "role",
            "combobox",
        ),
    );
    await user.click(screen.getByRole("combobox", { name: /Price column/ }));
    expect(screen.getByRole("option", { name: "Café" })).toBeInTheDocument();
    expect(
        screen.queryByRole("option", { name: "Statement" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(
        screen.getByRole("button", { name: /Import transactions/i }),
    );
    await waitFor(() => expect(submittedFormat).toBe("decimal_dot"));
});
