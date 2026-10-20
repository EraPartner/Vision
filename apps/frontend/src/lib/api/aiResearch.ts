import {
    API_BASE_URL,
    apiRequest,
    checkResponseContract,
    parseEnvelopeError,
    rawFetch,
    unwrapEnvelope,
} from "@/lib/api/client";
import {
    AiInvestigationDetailSchema,
    AiInvestigationSchema,
    ResearchDocumentListSchema,
    ResearchDocumentSchema,
} from "@vision/types/contracts";
import type {
    AccountId,
    CurrencyCode,
    InvestmentId,
} from "@vision/types/brands";

export interface ResearchDocument {
    id: string;
    title: string;
    sourceName: string;
    mediaType: string;
    version: number;
    extractionStatus: "ready" | "failed" | "unsupported";
    extractionError: string | null;
    createdAt: string;
}

export interface AiEvidence {
    id: string;
    kind: string;
    label: string;
    sourceDate: string | null;
    locator: string;
    excerpt: string | null;
    available: boolean;
}
export interface AiAnswer {
    schemaVersion: 1;
    status: "complete" | "qualified" | "abstained" | "partial";
    depth: "quick" | "detailed";
    language: "en" | "nl";
    summary: string;
    facts: Array<{ text: string; evidenceIds: string[] }>;
    calculations: Array<{ text: string; evidenceIds: string[] }>;
    interpretations: Array<{ text: string; evidenceIds: string[] }>;
    assumptions: string[];
    missingInformation: string[];
    conflicts: Array<{ description: string; evidenceIds: string[] }>;
    evidence: AiEvidence[];
    analysisReference: { id: string; version: number } | null;
}
export interface AiInvestigation {
    id: string;
    question: string;
    route: "local";
    depth: "quick" | "detailed";
    language: "en" | "nl";
    state: string;
    plan?: {
        ambiguity?: { material: boolean; question: string | null };
    } | null;
    result?: AiAnswer | null;
    error?: { code?: string; message?: string } | null;
    steps?: Array<{ stepId: string; state: string }>;
}
export interface InvestigationInput {
    question: string;
    route: "local";
    researchMode: "local-only" | "public-providers" | "public-web";
    publicWebQuery: string | null;
    publicSymbols: string[];
    publicMacroQueries: string[];
    clarification: string | null;
    model: string | null;
    depth: "quick" | "detailed";
    language: "en" | "nl";
    scope: {
        workspaces: string[];
        accountIds: AccountId[];
        investmentIds: InvestmentId[];
        dateFrom: string | null;
        dateTo: string | null;
        currency: CurrencyCode;
        constraints: string[];
    };
    savedAnalysisId: null;
}

export const createInvestigation = (body: InvestigationInput) =>
    apiRequest<AiInvestigation>("/api/ai-research/investigations", {
        method: "POST",
        body: JSON.stringify(body),
        schema: AiInvestigationSchema,
    });
export const getInvestigation = (id: string) =>
    apiRequest<AiInvestigation>(
        `/api/ai-research/investigations/${encodeURIComponent(id)}`,
        { schema: AiInvestigationDetailSchema },
    );
export const deleteInvestigation = (id: string) =>
    apiRequest<void>(
        `/api/ai-research/investigations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
    );
export const cancelInvestigation = (id: string) =>
    apiRequest<AiInvestigation>(
        `/api/ai-research/investigations/${encodeURIComponent(id)}/cancel`,
        { method: "POST", schema: AiInvestigationSchema },
    );
export const resumeInvestigation = (
    id: string,
    clarification: string,
    scope: InvestigationInput["scope"],
) =>
    apiRequest<AiInvestigation>(
        `/api/ai-research/investigations/${encodeURIComponent(id)}/resume`,
        {
            method: "POST",
            body: JSON.stringify({ clarification, scope }),
            schema: AiInvestigationSchema,
        },
    );
export const listResearchDocuments = async () =>
    (
        await apiRequest<{ items: ResearchDocument[] }>(
            "/api/ai-research/documents",
            { schema: ResearchDocumentListSchema },
        )
    ).items;

export async function uploadResearchDocument(file: File) {
    const body = new FormData();
    body.append("file", file);
    const response = await rawFetch(
        `${API_BASE_URL}/api/ai-research/documents`,
        {
            method: "POST",
            body,
        },
    );
    if (!response.ok)
        throw await parseEnvelopeError(response, "Document upload failed");
    return checkResponseContract(
        ResearchDocumentSchema,
        unwrapEnvelope<ResearchDocument>(await response.json()),
        "POST /api/ai-research/documents",
    );
}

export const deleteResearchDocument = (id: string) =>
    apiRequest<void>(`/api/ai-research/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
