import { apiRequest } from "@/lib/api/client";

export type MonitorStatus =
    | "baseline"
    | "unchanged"
    | "triggered"
    | "cooldown-pending"
    | "partial"
    | "stale"
    | "failed";
export type MonitorKind = "analysis-threshold" | "dossier-evidence";
export type MonitorOperator = "above" | "below";

export interface MonitorObservation {
    id: string;
    monitorId: string;
    status: MonitorStatus;
    previousValue: string | null;
    currentValue: string | null;
    previousEvidenceVersion: number | null;
    currentEvidenceVersion: number | null;
    analysisRunId: string | null;
    historicalAnalysisRunId: string | null;
    coverage: { status: "unknown"; reason: string } | null;
    reason: string | null;
    reasonCode?: string | null;
    checkedAt: string;
}

export interface AnalysisMonitor {
    id: string;
    kind: MonitorKind;
    title: string;
    enabled: boolean;
    savedAnalysisId: string | null;
    dossierId: string | null;
    targetLabel: string;
    fieldId: string | null;
    operator: MonitorOperator | null;
    threshold: string | null;
    intervalMinutes: number;
    cooldownMinutes: number;
    nextDueAt: string | null;
    lastCheckedAt: string | null;
    lastStatus: MonitorStatus | null;
    lastObservation: MonitorObservation | null;
    createdAt: string;
    updatedAt: string;
}

export interface MonitorNotification {
    id: string;
    monitorId: string;
    observationId: string;
    kind: MonitorKind;
    title: string;
    reason: string | null;
    reasonCode?: string | null;
    previousValue: string | null;
    currentValue: string | null;
    createdAt: string;
    readAt: string | null;
}

export interface MonitorPage<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
    unreadCount?: number;
}

export type MonitorCreate =
    | {
          kind: "analysis-threshold";
          title: string;
          savedAnalysisId: string;
          fieldId: string;
          operator: MonitorOperator;
          threshold: string;
          intervalMinutes?: number;
          cooldownMinutes?: number;
      }
    | {
          kind: "dossier-evidence";
          title: string;
          dossierId: string;
          intervalMinutes?: number;
          cooldownMinutes?: number;
      };

export type MonitorUpdate = Partial<
    Pick<
        AnalysisMonitor,
        | "title"
        | "enabled"
        | "fieldId"
        | "operator"
        | "threshold"
        | "intervalMinutes"
        | "cooldownMinutes"
    >
>;

const base = "/api/analysis/monitors";
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
const paging = (offset: number) => `?limit=200&offset=${offset}`;

export const listMonitors = (offset = 0) =>
    apiRequest<MonitorPage<AnalysisMonitor>>(`${base}${paging(offset)}`);
export const createMonitor = (input: MonitorCreate) =>
    apiRequest<AnalysisMonitor>(base, {
        method: "POST",
        body: JSON.stringify(input),
    });
export const updateMonitor = (id: string, patch: MonitorUpdate) =>
    apiRequest<AnalysisMonitor>(path(id), {
        method: "PATCH",
        body: JSON.stringify(patch),
    });
export const deleteMonitor = (id: string) =>
    apiRequest<void>(path(id), { method: "DELETE" });
export const checkMonitor = (id: string) =>
    apiRequest<MonitorObservation>(`${path(id)}/check`, { method: "POST" });
export const listMonitorObservations = (id: string, offset = 0) =>
    apiRequest<MonitorPage<MonitorObservation>>(
        `${path(id)}/observations${paging(offset)}`,
    );
export const listMonitorNotifications = (offset = 0) =>
    apiRequest<MonitorPage<MonitorNotification>>(
        `${base}/notifications${paging(offset)}`,
    );
export const readMonitorNotification = (id: string) =>
    apiRequest<MonitorNotification>(
        `${base}/notifications/${encodeURIComponent(id)}/read`,
        { method: "POST" },
    );
