// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http } from "msw";
import { server } from "@/test/msw/server";
import {
    IMPORT_CSV_RESULT_STUB,
    IMPORT_CSV_REVIEW_REQUIRED_STUB,
} from "@/test/msw/handlers";
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

    /** `importRecipientsCSV` / `importCategoriesCSV` plus the route's `status`. */
    const SIMPLE_RESULT = {
        total_processed: 0,
        imported: 0,
        skipped: 0,
        errors: 0,
        status: "completed",
    };

    async function capture(
        path: string,
        run: () => Promise<unknown>,
        response: unknown = path.startsWith("/api/import/csv")
            ? IMPORT_CSV_RESULT_STUB
            : SIMPLE_RESULT,
    ) {
        let url = "";
        let body: FormData | undefined;
        server.use(
            http.post(`${API_BASE}${path}`, async ({ request }) => {
                url = request.url;
                body = await request.formData();
                return ok(response);
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
                "decimal_comma",
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
            number_format: "decimal_comma",
        });
    });

    it("defaults old custom mappings to automatic number parsing", async () => {
        const body = await capture("/api/import/csv/custom", () =>
            importCSVCustom(
                file,
                "generic",
                "YYYY-MM-DD",
                "Date",
                "Recipient",
                "Amount",
            ),
        );
        expect(body.get("number_format")).toBe("auto");
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

    it("accepts the 202 review-required arm of the CSV import", async () => {
        let result: unknown;
        await capture(
            "/api/import/csv",
            async () => {
                result = await importCSV(file, "kbc");
            },
            IMPORT_CSV_REVIEW_REQUIRED_STUB,
        );
        expect(result).toEqual(IMPORT_CSV_REVIEW_REQUIRED_STUB);
    });

    it("rejects a CSV import result whose counts are missing", async () => {
        server.use(
            http.post(`${API_BASE}/api/import/csv`, () =>
                ok({ batch_id: 1, status: "completed" }),
            ),
        );
        await expect(importCSV(file, "kbc")).rejects.toMatchObject({
            name: "ApiContractError",
            endpoint: "POST /api/import/csv",
        });
    });
});
