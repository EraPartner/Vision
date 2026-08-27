// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import ImportPage from "@/pages/ImportPage";

const API_BASE = "http://localhost:3002";

describe("ImportPage (integration)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function expandSetupReference() {
        const user = userEvent.setup();
        await user.click(
            await screen.findByRole("button", {
                name: /toggle setup and reference/i,
            }),
        );
    }

    it("renders page heading", async () => {
        renderWithApp(<ImportPage />);
        expect(
            await screen.findByRole("heading", { name: /import & export/i }),
        ).toBeInTheDocument();
    });

    it("shows and then consumes the approved-import completion receipt", async () => {
        renderWithApp(<ImportPage />, {
            initialEntries: [
                {
                    pathname: "/import",
                    state: {
                        importCommitReceipt: {
                            imported: 42,
                            duplicates: 3,
                            errors: 1,
                        },
                    },
                },
            ],
        });

        const status = await screen.findByRole("status");
        expect(status).toHaveTextContent("Import complete");
        expect(
            within(status).getByRole("img", { name: "42" }),
        ).toBeInTheDocument();
        expect(status).toHaveTextContent("transactions imported");
        expect(status).toHaveTextContent("3 duplicates · 1 error");

        await userEvent.click(
            screen.getByRole("button", { name: /dismiss import receipt/i }),
        );
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it.each([
        [0, "transactions imported", "0 duplicates · 0 errors"],
        [1, "transaction imported", "1 duplicate · 1 error"],
    ])(
        "uses English singular and plural receipt copy for count %i",
        async (count, importedCopy, detailsCopy) => {
            renderWithApp(<ImportPage />, {
                initialEntries: [
                    {
                        pathname: "/import",
                        state: {
                            importCommitReceipt: {
                                imported: count,
                                duplicates: count,
                                errors: count,
                            },
                        },
                    },
                ],
            });

            const status = await screen.findByRole("status");
            expect(status).toHaveTextContent(importedCopy);
            expect(status).toHaveTextContent(detailsCopy);
        },
    );

    it.each([
        [0, "transacties geïmporteerd", "0 duplicaten · 0 fouten"],
        [1, "transactie geïmporteerd", "1 duplicaat · 1 fout"],
        [7, "transacties geïmporteerd", "7 duplicaten · 7 fouten"],
    ])(
        "uses Dutch singular and plural receipt copy for count %i",
        async (count, importedCopy, detailsCopy) => {
            server.use(
                http.get(`${API_BASE}/api/settings`, () =>
                    ok({ app_settings: { language: "nl" } }),
                ),
            );
            renderWithApp(<ImportPage />, {
                initialEntries: [
                    {
                        pathname: "/import",
                        state: {
                            importCommitReceipt: {
                                imported: count,
                                duplicates: count,
                                errors: count,
                            },
                        },
                    },
                ],
            });

            const status = await screen.findByRole("status");
            expect(status).toHaveTextContent(importedCopy);
            expect(status).toHaveTextContent(detailsCopy);
        },
    );

    it("renders the bank source selector label", async () => {
        renderWithApp(<ImportPage />);
        // "Bank Source" label is the first field in the CSV import card
        expect(await screen.findByText(/bank source/i)).toBeInTheDocument();
    });

    it("renders the bank source select trigger", async () => {
        renderWithApp(<ImportPage />);
        // The select trigger shows the placeholder "Select a bank..."
        expect(await screen.findByText(/select a bank/i)).toBeInTheDocument();
    });

    it("renders the Import Transactions button", async () => {
        renderWithApp(<ImportPage />);
        expect(
            await screen.findByRole("button", { name: /import transactions/i }),
        ).toBeInTheDocument();
    });

    it("renders the CSV file drop zone", async () => {
        renderWithApp(<ImportPage />);
        // The hidden file input is present in the DOM
        const fileInput = document.querySelector(
            'input[type="file"][accept=".csv"]',
        );
        expect(fileInput).not.toBeNull();
    });

    it("renders Recipients Import card", async () => {
        renderWithApp(<ImportPage />);
        await expandSetupReference();
        expect(
            await screen.findByText(/recipients import/i),
        ).toBeInTheDocument();
    });

    it("renders Categories Import card", async () => {
        renderWithApp(<ImportPage />);
        await expandSetupReference();
        expect(
            await screen.findByText(/categories import/i),
        ).toBeInTheDocument();
    });

    it("renders CSV Export card", async () => {
        renderWithApp(<ImportPage />);
        expect(await screen.findByText(/csv export/i)).toBeInTheDocument();
    });

    it("renders Import History card", async () => {
        renderWithApp(<ImportPage />);
        expect(await screen.findByText(/import history/i)).toBeInTheDocument();
    });

    it("shows empty import history message when no batches exist", async () => {
        renderWithApp(<ImportPage />);
        // MSW returns { items: [], total: 0 } — ImportHistoryCard shows empty message
        expect(await screen.findByText(/no imports yet/i)).toBeInTheDocument();
    });

    it("renders Supported Banks card heading", async () => {
        renderWithApp(<ImportPage />);
        await expandSetupReference();
        // importPage.supportedBanks = "Supported Banks"
        expect(await screen.findByText(/supported banks/i)).toBeInTheDocument();
    });

    it("renders page subtitle text", async () => {
        renderWithApp(<ImportPage />);
        // importPage.subtitle = "Import transactions from your bank or export your data as CSV"
        expect(
            await screen.findByText(/import transactions from your bank/i),
        ).toBeInTheDocument();
    });

    it("renders Can't see your bank hint text", async () => {
        renderWithApp(<ImportPage />);
        await expandSetupReference();
        // importPage.noSupportedBank = "Can't see your bank? Try Custom."
        // MSW returns api/info/banks = [] so this text is shown
        expect(
            await screen.findByText(/can't see your bank/i),
        ).toBeInTheDocument();
    });

    it("renders Import Recipients button in Recipients Import card", async () => {
        renderWithApp(<ImportPage />);
        await expandSetupReference();
        // importPage.importRecipientsBtn = "Import Recipients"
        expect(
            await screen.findByRole("button", { name: /import recipients/i }),
        ).toBeInTheDocument();
    });

    it("renders Import Categories button in Categories Import card", async () => {
        renderWithApp(<ImportPage />);
        await expandSetupReference();
        // importPage.importCategoriesBtn = "Import Categories"
        expect(
            await screen.findByRole("button", { name: /import categories/i }),
        ).toBeInTheDocument();
    });

    it("renders Export CSV button in CSV Export card", async () => {
        renderWithApp(<ImportPage />);
        // importPage.exportBtn = "Export CSV"
        expect(
            await screen.findByRole("button", { name: /^export csv$/i }),
        ).toBeInTheDocument();
    });

    it("renders Export JSON button in CSV Export card", async () => {
        renderWithApp(<ImportPage />);
        // importPage.exportJsonBtn = "Export JSON"
        expect(
            await screen.findByRole("button", { name: /export json/i }),
        ).toBeInTheDocument();
    });

    it("Import Transactions button is disabled when no file is selected", async () => {
        renderWithApp(<ImportPage />);
        const btn = await screen.findByRole("button", {
            name: /import transactions/i,
        });
        // Button requires a file: disabled={!file || loading}
        expect(btn).toBeDisabled();
    });

    it("orders the recurring import task before history and export", async () => {
        renderWithApp(<ImportPage />);

        const transactionImport = await screen.findByText("CSV Import");
        const history = screen.getByText(/import history/i);
        const exportCard = screen.getByText("CSV Export");
        expect(
            transactionImport.compareDocumentPosition(history) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            history.compareDocumentPosition(exportCard) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it("keeps one-time setup and reference tools collapsed until requested", async () => {
        renderWithApp(<ImportPage />);

        const trigger = await screen.findByRole("button", {
            name: /toggle setup and reference/i,
        });
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Recipients Import")).not.toBeInTheDocument();
        expect(screen.queryByText("Categories Import")).not.toBeInTheDocument();
        expect(screen.queryByText("Supported Banks")).not.toBeInTheDocument();

        await userEvent.click(trigger);

        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText("Recipients Import")).toBeInTheDocument();
        expect(screen.getByText("Categories Import")).toBeInTheDocument();
        expect(screen.getByText("Supported Banks")).toBeInTheDocument();
    });

    it("clicking Show Filters reveals export filter controls", async () => {
        const user = userEvent.setup();
        renderWithApp(<ImportPage />);

        await user.click(
            await screen.findByRole("button", { name: /show filters/i }),
        );

        // Button label flips to "Hide Filters" and the filter section appears
        expect(
            screen.getByRole("button", { name: /hide filters/i }),
        ).toBeInTheDocument();
        expect(screen.getByText(/end date/i)).toBeInTheDocument();
    });

    it("clicking Hide Filters collapses the filter section", async () => {
        const user = userEvent.setup();
        renderWithApp(<ImportPage />);

        // Open filters first
        await user.click(
            await screen.findByRole("button", { name: /show filters/i }),
        );
        expect(
            screen.getByRole("button", { name: /hide filters/i }),
        ).toBeInTheDocument();

        // Close again
        await user.click(screen.getByRole("button", { name: /hide filters/i }));
        expect(
            screen.getByRole("button", { name: /show filters/i }),
        ).toBeInTheDocument();
    });

    it("selecting Custom / Other bank source shows custom bank name input", async () => {
        const user = userEvent.setup();
        renderWithApp(<ImportPage />);

        // Open the bank source selector (first combobox on the page)
        const comboboxes = await screen.findAllByRole("combobox");
        await user.click(comboboxes[0]);

        // Select "Custom / Other"
        await user.click(
            await screen.findByRole("option", { name: /custom \/ other/i }),
        );

        // Custom bank name placeholder input and config section appear
        expect(
            screen.getByPlaceholderText(/e\.g\. argenta/i),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/custom csv configuration/i),
        ).toBeInTheDocument();
    });

    it("Export CSV shows success toast when download succeeds", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "success");

        // Stub URL.createObjectURL to avoid JSDOM error during downloadBlob
        URL.createObjectURL = vi.fn(() => "blob:mock-url");
        URL.revokeObjectURL = vi.fn();

        server.use(
            http.get(
                `${API_BASE}/api/transactions/export/csv`,
                () =>
                    new HttpResponse("date,amount,recipient", {
                        status: 200,
                        headers: { "Content-Type": "text/csv" },
                    }),
            ),
        );

        renderWithApp(<ImportPage />);

        await user.click(
            await screen.findByRole("button", { name: /^export csv$/i }),
        );

        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/transactions exported/i),
                expect.anything(),
            ),
        );
    });

    it("Export CSV shows error toast when download fails", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.get(
                `${API_BASE}/api/transactions/export/csv`,
                () => new HttpResponse(null, { status: 500 }),
            ),
        );

        renderWithApp(<ImportPage />);

        await user.click(
            await screen.findByRole("button", { name: /^export csv$/i }),
        );

        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/failed to export transactions/i),
                expect.anything(),
            ),
        );
    });

    it("renders page heading gracefully when import history API fails with 500", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/import/batches`, () =>
                err(500, "db unavailable"),
            ),
        );
        renderWithApp(<ImportPage />);
        expect(
            await screen.findByRole("heading", { name: /import & export/i }),
        ).toBeInTheDocument();
        // apiRequest retries on 500 (MAX_RETRIES=2, ~1.5 s backoff) — needs extended timeout
        expect(
            await screen.findByText(/no imports yet/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("renders page heading gracefully when import history API fails with 403", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/import/batches`, () =>
                err(403, "Forbidden"),
            ),
        );
        renderWithApp(<ImportPage />);
        expect(
            await screen.findByRole("heading", { name: /import & export/i }),
        ).toBeInTheDocument();
        expect(await screen.findByText(/no imports yet/i)).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when batches endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/import/batches`, () =>
                err(404, "Not found"),
            ),
        );
        const { container } = renderWithApp(<ImportPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
