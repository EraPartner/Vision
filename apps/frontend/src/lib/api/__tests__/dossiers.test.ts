// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
import {
    createDossier,
    exportDossier,
    exportDossiers,
    listDossiers,
    restoreDossierVersion,
    updateDossier,
    type DossierContent,
} from "@/lib/api/dossiers";

afterEach(() => server.resetHandlers());

const content: DossierContent = {
    title: "Question",
    workspace: "research",
    question: "What changed?",
    userThesis: "",
    assumptions: [],
    openQuestions: [],
    conclusion: "",
    reviewDate: null,
    evidence: [],
    links: { categoryIds: [12], investmentIds: [], savedAnalysisIds: [] },
};

describe("research dossier API client", () => {
    it("paginates without losing the total", async () => {
        let url = "";
        server.use(
            http.get(`${API_BASE}/api/research-dossiers`, ({ request }) => {
                url = request.url;
                return ok({ items: [], total: 501, limit: 500, offset: 500 });
            }),
        );
        expect((await listDossiers(500)).total).toBe(501);
        expect(url).toContain("limit=500&offset=500");
    });

    it("sends the full content with an expected version and preserves source provenance", async () => {
        let body: Record<string, unknown> = {};
        server.use(
            http.put(
                `${API_BASE}/api/research-dossiers/d-1`,
                async ({ request }) => {
                    body = (await request.json()) as Record<string, unknown>;
                    return ok({ id: "d-1", version: 3, ...body });
                },
            ),
        );
        await updateDossier("d-1", content, 2);
        expect(body).toMatchObject({
            expectedVersion: 2,
            links: { categoryIds: [12] },
        });
        expect(body).not.toHaveProperty("linkDetails");
    });

    it("restores by version with an expected current version", async () => {
        let body: unknown;
        server.use(
            http.post(
                `${API_BASE}/api/research-dossiers/d-1/restore`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({ id: "d-1", version: 4 });
                },
            ),
        );
        await restoreDossierVersion("d-1", 1, 3);
        expect(body).toEqual({ version: 1, expectedVersion: 3 });
    });

    it("exports one or all as portable JSON without mutating records", async () => {
        const exported = {
            schemaVersion: 1,
            exportedAt: "2026-09-19T00:00:00Z",
            dossiers: [],
        };
        server.use(
            http.get(`${API_BASE}/api/research-dossiers/export`, () =>
                ok(exported),
            ),
        );
        server.use(
            http.get(`${API_BASE}/api/research-dossiers/d-1/export`, () =>
                ok(exported),
            ),
        );
        expect((await exportDossiers()).schemaVersion).toBe(1);
        expect((await exportDossier("d-1")).schemaVersion).toBe(1);
    });

    it("creates only after explicit call", async () => {
        server.use(
            http.post(`${API_BASE}/api/research-dossiers`, () =>
                ok({ id: "d-1", version: 1, ...content }),
            ),
        );
        expect((await createDossier(content)).version).toBe(1);
    });
});
