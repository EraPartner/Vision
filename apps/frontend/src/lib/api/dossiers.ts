import { apiRequest } from "@/lib/api/client";
import type { AnalysisWorkspace } from "@/lib/api/analysis";

export type EvidenceStance = "support" | "oppose" | "context";
export type EvidenceOrigin = "user" | "ai-draft";

export interface DossierEvidence {
    id: string;
    stance: EvidenceStance;
    origin: EvidenceOrigin;
    claim: string;
    source: {
        title: string;
        reference: string;
        sourceDate: string | null;
        accessedAt: string | null;
        documentId?: string;
        documentVersion?: number;
        passageOrdinal?: number;
        contentSha256?: string;
    };
    notes: string;
}

export interface DossierContent {
    title: string;
    workspace: AnalysisWorkspace;
    question: string;
    userThesis: string;
    assumptions: string[];
    openQuestions: string[];
    conclusion: string;
    reviewDate: string | null;
    evidence: DossierEvidence[];
    links: {
        categoryIds: number[];
        investmentIds: number[];
        savedAnalysisIds: string[];
    };
}

export interface Dossier extends DossierContent {
    id: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    linkDetails?: Array<{
        kind: "category" | "investment" | "saved-analysis";
        historicalId: string;
        labelSnapshot: string;
        liveId: string | number | null;
        status: "live" | "deleted";
    }>;
}

export type DossierListItem = Pick<
    Dossier,
    "id" | "title" | "workspace" | "version" | "createdAt" | "updatedAt"
>;

export interface DossierVersion {
    version: number;
    snapshot: DossierContent;
    createdAt: string;
}

export interface DossierExport {
    schemaVersion: 1;
    exportedAt: string;
    dossiers: Array<Dossier & { versions: DossierVersion[] }>;
}

const base = "/api/research-dossiers";
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;

export async function listDossiers(
    offset = 0,
): Promise<{ items: DossierListItem[]; total: number }> {
    return apiRequest<{ items: DossierListItem[]; total: number }>(
        `${base}?limit=500&offset=${offset}`,
    );
}

export const getDossier = (id: string) => apiRequest<Dossier>(path(id));
export const createDossier = (content: DossierContent) =>
    apiRequest<Dossier>(base, {
        method: "POST",
        body: JSON.stringify(content),
    });
export const updateDossier = (
    id: string,
    content: DossierContent,
    expectedVersion: number,
) =>
    apiRequest<Dossier>(path(id), {
        method: "PUT",
        body: JSON.stringify({ ...content, expectedVersion }),
    });
export const deleteDossier = (id: string) =>
    apiRequest<void>(path(id), { method: "DELETE" });
export async function listDossierVersions(
    id: string,
): Promise<DossierVersion[]> {
    return (
        await apiRequest<{ items: DossierVersion[] }>(`${path(id)}/versions`)
    ).items;
}
export const restoreDossierVersion = (
    id: string,
    version: number,
    expectedVersion: number,
) =>
    apiRequest<Dossier>(`${path(id)}/restore`, {
        method: "POST",
        body: JSON.stringify({ version, expectedVersion }),
    });
export const exportDossiers = () => apiRequest<DossierExport>(`${base}/export`);
export const exportDossier = (id: string) =>
    apiRequest<DossierExport>(`${path(id)}/export`);
