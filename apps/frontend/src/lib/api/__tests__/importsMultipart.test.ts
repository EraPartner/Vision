// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
import {
    importCSV,
    importCSVCustom,
    importCategories,
    importRecipients,
} from "@/lib/api/imports";

afterEach(() => server.resetHandlers());

describe("multipart import request fields", () => {
    const file = new File(["fixture"], "fixture.csv", { type: "text/csv" });

    async function capture(path: string, run: () => Promise<unknown>) {
        let url = "";
        let body: FormData | undefined;
        server.use(
            http.post(`${API_BASE}${path}`, async ({ request }) => {
                url = request.url;
                body = await request.formData();
                return ok({
                    total_processed: 0,
                    imported: 0,
                    skipped: 0,
                    duplicates: 0,
                    errors: 0,
                    status: "completed",
                });
            }),
        );
        await run();
        expect(new URL(url).search).toBe("");
        return body as FormData;
    }

    it("puts the standard bank option in the body", async () => {
        const body = await capture("/api/import/csv", () =>
            importCSV(file, "kbc"),
        );
        expect(body.get("bank_name")).toBe("kbc");
    });

    it("puts every custom mapping option in the body", async () => {
        const body = await capture("/api/import/csv/custom", () =>
            importCSVCustom(
                file,
                "generic",
                "YYYY-MM-DD",
                "Date",
                "Recipient",
                "Amount",
                "Memo",
                ";",
                "latin1",
                2,
            ),
        );
        expect(Object.fromEntries(body.entries())).toMatchObject({
            bank_name: "generic",
            date_format: "YYYY-MM-DD",
            date_column: "Date",
            recipient_column: "Recipient",
            amount_column: "Amount",
            memo_column: "Memo",
            separator: ";",
            encoding: "latin1",
            skip_rows: "2",
        });
    });

    it.each([
        ["recipients", importRecipients],
        ["categories", importCategories],
    ] as const)("puts %s options in the body", async (kind, importer) => {
        const body = await capture(`/api/import/${kind}`, () =>
            importer(file, ";", "latin1"),
        );
        expect(body.get("separator")).toBe(";");
        expect(body.get("encoding")).toBe("latin1");
    });
});
