// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ACCOUNT_LIST_ITEM_STUB, ok } from "@/test/msw/handlers";
import PortfolioImportPage from "../PortfolioImportPage";
import workbookFixtures from "./fixtures/portfolioDetectionWorkbooks";

const api = "http://localhost:3002/api";
const headers = {
    ibkr: "Transaction History,Header,Date,Symbol,Transaction Type,Quantity",
    kinesis:
        "DateTime,HIN,Currency_Code,Transaction_Type,Transaction_ID,Order_ID,Starting_Balance,Closing_Balance",
    nexo: "Transaction,Type,Input Currency,Input Amount,Output Currency,Output Amount,USD Equivalent,Date / Time (UTC)",
    saxo: "Transactiedatum,Rekening-ID,Transactie-ID,Transactietype,Acties,Boekingsbedrag,Instrumentsymbool,Instrumentvaluta",
};
const formats = {
    ibkr: "ibkr_transaction_history",
    kinesis: "kinesis_transaction_history",
    nexo: "nexo_transaction_history",
    saxo: "saxo_transaction_history",
};

function broker(id: number, institution: string, name = institution) {
    return {
        ...ACCOUNT_LIST_ITEM_STUB,
        id,
        name,
        display_name: name,
        institution,
        type: "brokerage",
        is_active: true,
    };
}

function serveAccounts(accounts: ReturnType<typeof broker>[]) {
    server.use(
        http.get(`${api}/accounts`, () =>
            ok({ items: accounts, total: accounts.length }),
        ),
    );
}

function statement(source: keyof typeof headers, body = "") {
    return new File([`${headers[source]}\n${body}`], "history.csv", {
        type: "text/csv",
    });
}

function deferredStatement(source: keyof typeof headers) {
    const file = statement(source);
    let resolve!: (value: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>((done) => {
        resolve = done;
    });
    Object.defineProperty(file, "arrayBuffer", { value: () => bytes });
    return {
        file,
        finish: () => resolve(new TextEncoder().encode(headers[source]).buffer),
    };
}

let submissions: Record<string, string>[];

beforeEach(() => {
    submissions = [];
    server.use(
        http.get(`${api}/portfolio/import/parsers`, () =>
            ok({ items: [], total: 0 }),
        ),
        http.post(`${api}/portfolio/import/csv/stream`, async ({ request }) => {
            // Browser Files in jsdom cannot be consumed by Node's multipart
            // parser. Inspect the actual serialized multipart fields instead.
            const body = await request.text();
            submissions.push(
                Object.fromEntries(
                    [...body.matchAll(/name="([^"]+)"\r\n\r\n([^\r\n]*)/g)].map(
                        (match) => [match[1], match[2]],
                    ),
                ),
            );
            return new HttpResponse(
                'event: complete\ndata: {"batch_id":2,"requires_review":true,"imported":0,"duplicates":0,"errors":0}\n\n',
                { headers: { "Content-Type": "text/event-stream" } },
            );
        }),
    );
});

async function renderAdvanced(user: ReturnType<typeof userEvent.setup>) {
    const rendered = renderWithApp(<PortfolioImportPage />);
    await user.click(await screen.findByText("Advanced single-file import"));
    return rendered;
}

function fileInput(_container: HTMLElement) {
    return screen
        .getByText("Advanced single-file import")
        .closest("details")!
        .querySelector<HTMLInputElement>('input[type="file"]')!;
}

function importButton() {
    return screen.getByRole("button", { name: "Import transactions" });
}

function brokerField() {
    return screen.getByRole("combobox", { name: "Broker" });
}

async function chooseBroker(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
) {
    await user.click(brokerField());
    await user.click(await screen.findByRole("option", { name }));
}

describe("automatic portfolio upload", () => {
    it("detects a real Saxo workbook and submits it to its exported broker account", async () => {
        serveAccounts([broker(8, "Saxo", "SYNTHETIC-ACCOUNT")]);
        const bytes = Uint8Array.from(atob(workbookFixtures.saxo), (value) =>
            value.charCodeAt(0),
        );
        const user = userEvent.setup();
        const { container } = await renderAdvanced(user);
        await user.upload(
            fileInput(container),
            new File([bytes], "history.xlsx"),
        );
        await waitFor(() => {
            expect(brokerField()).toHaveTextContent("SYNTHETIC-ACCOUNT");
            expect(importButton()).toBeEnabled();
        });
        await user.click(importButton());
        await waitFor(() => expect(submissions).toHaveLength(1));
        expect(submissions[0]).toMatchObject({
            portfolio_format: formats.saxo,
            adapter_name: formats.saxo,
            account_id: "8",
            is_brokerage: "true",
        });
    });

    it.each(["ibkr", "kinesis", "nexo", "saxo"] as const)(
        "detects %s and its unique active broker and submits the maintained multipart routing",
        async (source) => {
            serveAccounts([
                broker(71, source, "Selected broker"),
                { ...broker(72, source, "Inactive broker"), is_active: false },
                { ...broker(73, source, "Bank account"), type: "checking" },
            ]);
            const user = userEvent.setup();
            const { container } = await renderAdvanced(user);
            await user.upload(fileInput(container), statement(source));

            await waitFor(() => {
                expect(brokerField()).toHaveTextContent("Selected broker");
                expect(importButton()).toBeEnabled();
            });
            expect(
                screen.queryByLabelText(/Date column/),
            ).not.toBeInTheDocument();
            await user.click(importButton());
            await waitFor(() => expect(submissions).toHaveLength(1));
            expect(submissions[0]).toMatchObject({
                portfolio_format: formats[source],
                adapter_name: formats[source],
                account_id: "71",
                is_brokerage: "true",
            });
        },
    );

    it("selects the exact exported account when two accounts share the broker", async () => {
        serveAccounts([
            broker(1, "Kinesis", "Other account"),
            broker(2, "Kinesis", "HIN-SYNTHETIC"),
        ]);
        const user = userEvent.setup();
        const { container } = await renderAdvanced(user);
        await user.upload(
            fileInput(container),
            statement("kinesis", "2026-01-01,HIN-SYNTHETIC,KAU,buy,1,1,0,1"),
        );
        await waitFor(() =>
            expect(brokerField()).toHaveTextContent("HIN-SYNTHETIC"),
        );
        await user.click(importButton());
        await waitFor(() => expect(submissions[0]?.account_id).toBe("2"));
    });

    it("requires an explicit choice when the broker matches multiple accounts", async () => {
        serveAccounts([
            broker(1, "Nexo", "Nexo one"),
            broker(2, "Nexo", "Nexo two"),
        ]);
        const user = userEvent.setup();
        const { container } = await renderAdvanced(user);
        await user.upload(fileInput(container), statement("nexo"));
        await waitFor(() =>
            expect(screen.queryByRole("status")).not.toBeInTheDocument(),
        );
        expect(brokerField()).toHaveTextContent("Unassigned");
        expect(importButton()).toBeDisabled();
        expect(submissions).toHaveLength(0);

        await chooseBroker(user, "Nexo two");
        await user.click(importButton());
        await waitFor(() => expect(submissions[0]?.account_id).toBe("2"));
    });

    it("requires an explicit choice when a later row names a second source account", async () => {
        serveAccounts([broker(1, "Kinesis", "HIN-ONE")]);
        const user = userEvent.setup();
        const { container } = await renderAdvanced(user);
        await user.upload(
            fileInput(container),
            statement(
                "kinesis",
                `2026-01-01,HIN-ONE,KAU,buy,1,${"X".repeat(270_000)},0,1\n2026-01-02,HIN-TWO,KAU,buy,2,2,0,1`,
            ),
        );
        await waitFor(() =>
            expect(screen.queryByRole("status")).not.toBeInTheDocument(),
        );
        expect(brokerField()).toHaveTextContent("Unassigned");
        expect(importButton()).toBeDisabled();

        await chooseBroker(user, "HIN-ONE");
        await user.click(importButton());
        await waitFor(() => expect(submissions[0]?.account_id).toBe("1"));
    });

    it("clears the previous automatic preset and broker when replaced by an unknown CSV", async () => {
        serveAccounts([broker(1, "Nexo")]);
        const user = userEvent.setup();
        const { container } = await renderAdvanced(user);
        const input = fileInput(container);
        await user.upload(input, statement("nexo"));
        await waitFor(() => expect(brokerField()).toHaveTextContent("Nexo"));

        await user.upload(
            input,
            new File(
                ["Date,Symbol,Amount\n2026-01-01,ACME,100"],
                "custom.csv",
                { type: "text/csv" },
            ),
        );
        await waitFor(() =>
            expect(screen.getByLabelText(/Date column/)).toBeVisible(),
        );
        await waitFor(() =>
            expect(screen.queryByRole("status")).not.toBeInTheDocument(),
        );
        expect(brokerField()).toHaveTextContent("Unassigned");
        expect(
            screen.getByRole("combobox", { name: "Parser" }),
        ).toHaveTextContent("Detect automatically");
        expect(screen.queryByText(/In Nexo, export/)).not.toBeInTheDocument();
    });

    it("keeps a replacement pending until its own read finishes and ignores the stale earlier detection", async () => {
        serveAccounts([broker(1, "Nexo"), broker(2, "Kinesis")]);
        const first = deferredStatement("nexo");
        const second = deferredStatement("kinesis");
        const user = userEvent.setup();
        const { container } = await renderAdvanced(user);
        const input = fileInput(container);
        await user.upload(input, first.file);
        await user.upload(input, second.file);
        await act(async () => first.finish());
        expect(screen.getByRole("status")).toHaveTextContent(
            "Detecting statement format",
        );
        expect(importButton()).toBeDisabled();
        expect(brokerField()).toHaveTextContent("Unassigned");

        await act(async () => second.finish());
        await waitFor(() => expect(brokerField()).toHaveTextContent("Kinesis"));
        await user.click(importButton());
        await waitFor(() => expect(submissions).toHaveLength(1));
        expect(submissions[0]).toMatchObject({
            portfolio_format: formats.kinesis,
            account_id: "2",
        });
    });

    it("replaces a manually changed broker with the new file's detected broker", async () => {
        serveAccounts([
            broker(1, "Nexo"),
            broker(2, "Kinesis"),
            broker(3, "Other"),
        ]);
        const user = userEvent.setup();
        const { container } = await renderAdvanced(user);
        const input = fileInput(container);
        await user.upload(input, statement("nexo"));
        await waitFor(() => expect(brokerField()).toHaveTextContent("Nexo"));
        await chooseBroker(user, "Other");
        await user.upload(input, statement("kinesis"));
        await waitFor(() => expect(brokerField()).toHaveTextContent("Kinesis"));
        await user.click(importButton());
        await waitFor(() => expect(submissions[0]?.account_id).toBe("2"));
        expect(submissions[0]?.portfolio_format).toBe(formats.kinesis);
    });

    it("preserves a broker chosen manually while detection is still pending", async () => {
        serveAccounts([
            broker(1, "Nexo"),
            broker(2, "Nexo", "Explicit destination"),
        ]);
        const pending = deferredStatement("nexo");
        const user = userEvent.setup();
        const { container } = await renderAdvanced(user);
        await user.upload(fileInput(container), pending.file);
        await chooseBroker(user, "Explicit destination");
        await act(async () => pending.finish());
        await waitFor(() => expect(importButton()).toBeEnabled());
        expect(brokerField()).toHaveTextContent("Explicit destination");
        await user.click(importButton());
        await waitFor(() => expect(submissions[0]?.account_id).toBe("2"));
    });

    it("blocks an unreadable workbook without submitting it", async () => {
        serveAccounts([broker(1, "Saxo")]);
        const user = userEvent.setup();
        const { container } = await renderAdvanced(user);
        await user.upload(
            fileInput(container),
            new File(["not a workbook"], "history.xlsx"),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "could not be read",
        );
        expect(importButton()).toBeDisabled();
        expect(submissions).toHaveLength(0);
    });
});
