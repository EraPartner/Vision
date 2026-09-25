import {
    API_BASE_URL,
    apiRequest,
    parseEnvelopeError,
    rawFetch,
    unwrapEnvelope,
} from "@/lib/api/client";

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
    route: "local" | "openai-api";
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
export interface OpenAiResearchModel {
    id: string;
    label: string;
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
    isDefault: boolean;
}
export interface AiResearchStatus {
    openai: {
        enabled: boolean;
        model: string | null;
        models: OpenAiResearchModel[];
        reversibleReferences?: {
            configured: boolean;
            markerSyntax: string;
            classification: "pseudonymized-not-anonymous";
        };
        agentCloakPreflight?: {
            enabled: boolean;
            mode: "block-on-change" | "protect-and-block";
            location: "operator-managed-loopback" | "desktop-loopback";
        };
    };
}
export interface AgentCloakDesktopStatus {
    enabled: boolean;
    available: boolean;
    mappingKeyConfigured: boolean;
    openAiEnabled: boolean;
}
export interface InvestigationInput {
    question: string;
    route: "local" | "openai-api";
    researchMode: "local-only" | "public-providers" | "public-web";
    publicQuestion: string | null;
    publicWebQuery: string | null;
    publicSymbols: string[];
    publicMacroQueries: string[];
    clarification: string | null;
    model: string | null;
    depth: "quick" | "detailed";
    language: "en" | "nl";
    scope: {
        workspaces: string[];
        accountIds: number[];
        investmentIds: number[];
        dateFrom: string | null;
        dateTo: string | null;
        currency: string;
        constraints: string[];
    };
    grantId: string | null;
    selectedSummary: string | null;
    selectedEvidence: string | null;
    referenceScopeId: string | null;
    savedAnalysisId: null;
}

export const getAiResearchStatus = () =>
    apiRequest<AiResearchStatus>("/api/ai-research/status");

export const getAgentCloakDesktopStatus = () =>
    apiRequest<AgentCloakDesktopStatus>("/api/ai-research/agentcloak-desktop");

export const setAgentCloakDesktopEnabled = (enabled: boolean) =>
    apiRequest<AgentCloakDesktopStatus>("/api/ai-research/agentcloak-desktop", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
    });

export const createInvestigation = (body: InvestigationInput) =>
    apiRequest<AiInvestigation>("/api/ai-research/investigations", {
        method: "POST",
        body: JSON.stringify(body),
    });
export const getInvestigation = (id: string) =>
    apiRequest<AiInvestigation>(
        `/api/ai-research/investigations/${encodeURIComponent(id)}`,
    );
export const deleteInvestigation = (id: string) =>
    apiRequest<void>(
        `/api/ai-research/investigations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
    );
export const cancelInvestigation = (id: string) =>
    apiRequest<AiInvestigation>(
        `/api/ai-research/investigations/${encodeURIComponent(id)}/cancel`,
        { method: "POST" },
    );
export const resumeInvestigation = (
    id: string,
    clarification: string,
    scope: InvestigationInput["scope"],
) =>
    apiRequest<AiInvestigation>(
        `/api/ai-research/investigations/${encodeURIComponent(id)}/resume`,
        { method: "POST", body: JSON.stringify({ clarification, scope }) },
    );
export const previewDisclosure = (body: InvestigationInput) =>
    apiRequest<{
        payload: Record<string, unknown>;
        payloadSha256: string;
        payloadBytes: number;
        fieldManifest: string[];
        disclosureUnits: string[];
        referenceScope: {
            id: string;
            expiresAt: string;
            count: number;
        } | null;
        outboundRequest: InvestigationInput;
        agentCloakPreflight: { enabled: boolean; status?: "passed" };
    }>("/api/ai-research/disclosures/preview", {
        method: "POST",
        body: JSON.stringify(body),
    });
export const createDisclosureGrant = (body: Record<string, unknown>) =>
    apiRequest<{ id: string }>("/api/ai-research/disclosures/grants", {
        method: "POST",
        body: JSON.stringify(body),
    });
export const listDisclosureGrants = () =>
    apiRequest<{ items: Array<Record<string, unknown>>; total: number }>(
        "/api/ai-research/disclosures/grants",
    );
export const revokeDisclosureGrant = (id: string) =>
    apiRequest<{ revoked: boolean }>(
        `/api/ai-research/disclosures/grants/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
    );
export const listDisclosureRecords = () =>
    apiRequest<{ items: Array<Record<string, unknown>>; total: number }>(
        "/api/ai-research/disclosures/records",
    );
export const deleteDisclosureRecords = () =>
    apiRequest<{ deleted: { records: number; grants: number } }>(
        "/api/ai-research/disclosures/records",
        { method: "DELETE" },
    );

export const listResearchDocuments = async () =>
    (
        await apiRequest<{ items: ResearchDocument[] }>(
            "/api/ai-research/documents",
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
    return unwrapEnvelope<ResearchDocument>(await response.json());
}

export const deleteResearchDocument = (id: string) =>
    apiRequest<void>(`/api/ai-research/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
