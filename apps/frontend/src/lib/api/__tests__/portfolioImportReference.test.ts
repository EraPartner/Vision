// @vitest-environment node
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
import { applyPortfolioImportReference } from "@/lib/api/portfolioImports";

const endpoint = `${API_BASE}/api/portfolio/import/reconciliation/reference`;
const xml = '<?xml version="1.0"?><client><version>1</version></client>';

function result() {
    return {
        batch_ids: [11, 90, 91],
        matched_reference_rows: 2,
        source_corrections: 1,
        replacement_batches: [{ original_batch_id: 4, review_batch_id: 91 }],
        supplemental_batches: [
            {
                batch_id: 90,
                account_id: 1,
                adapter_name: "portfolio_performance_reference",
                source_filename: "Portfolio Performance reference.xml",
                status: "awaiting_review",
                rows_total: 2,
            },
            {
                batch_id: 91,
                account_id: 3,
                adapter_name: "ibkr_transaction_history",
                source_filename: "Retained IBKR history review",
                status: "awaiting_review",
                rows_total: 2,
                original_batch_id: 4,
            },
        ],
        blockers: [],
    };
}

describe("portfolio reference multipart contract", () => {
    it("preserves the original XML filename and bytes and sends only the explicitly selected source scope and zero policy", async () => {
        let form: FormData | undefined;
        let contentType: string | null = null;
        server.use(
            http.post(endpoint, async ({ request }) => {
                contentType = request.headers.get("content-type");
                form = await request.formData();
                return ok(result());
            }),
        );
        const response = await applyPortfolioImportReference({
            file: new File([xml], "Original reference.xml", {
                type: "application/xml",
            }),
            batchIds: [4, 11],
            placeholderBasisPolicy: "zero",
        });
        expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
        expect(form?.get("batch_ids")).toBe("[4,11]");
        expect(form?.get("placeholder_basis_policy")).toBe("zero");
        const uploaded = form?.get("file") as File;
        expect(uploaded.name).toBe("Original reference.xml");
        expect(uploaded.type).toBe("application/xml");
        expect(await uploaded.text()).toBe(xml);
        expect(response.batch_ids).toEqual([11, 90, 91]);
        expect(response.replacement_batches).toEqual([
            { original_batch_id: 4, review_batch_id: 91 },
        ]);
    });

    it("rejects replacement metadata for an original source outside the selected scope", async () => {
        const invalid = result();
        invalid.replacement_batches[0].original_batch_id = 99;
        invalid.supplemental_batches[1].original_batch_id = 99;
        server.use(http.post(endpoint, () => ok(invalid)));
        await expect(
            applyPortfolioImportReference({
                file: new File([xml], "reference.xml"),
                batchIds: [4, 11],
                placeholderBasisPolicy: "zero",
            }),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });

    it("does not retry staging after a transient server failure", async () => {
        let requests = 0;
        server.use(
            http.post(endpoint, () => {
                requests += 1;
                return new HttpResponse("Unavailable", { status: 503 });
            }),
        );
        await expect(
            applyPortfolioImportReference({
                file: new File([xml], "reference.xml"),
                batchIds: [4, 11],
                placeholderBasisPolicy: "zero",
            }),
        ).rejects.toThrow();
        expect(requests).toBe(1);
    });
});
