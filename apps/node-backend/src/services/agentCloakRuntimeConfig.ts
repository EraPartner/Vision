import settings from "../config/config.ts";
import settingsRepository from "../repositories/settingsRepository.ts";

const DESKTOP_PREFERENCE_KEY = "agentcloak_desktop_enabled";

export interface AgentCloakConfig {
  enabled: boolean;
  mode: "mcp" | "desktop";
  url?: string;
  apiKey?: string;
  desktopUrl: string;
  timeoutMs: number;
}

export async function setAgentCloakDesktopEnabled(enabled: boolean) {
  await settingsRepository.set(DESKTOP_PREFERENCE_KEY, enabled);
}

export async function getAgentCloakConfig(): Promise<AgentCloakConfig> {
  const configured: AgentCloakConfig = {
    ...settings.aiResearch.agentCloak,
    mode: settings.aiResearch.agentCloak.mode === "desktop" ? "desktop" : "mcp",
  };
  const desktopPreference = await settingsRepository.get(
    DESKTOP_PREFERENCE_KEY,
  );
  if (desktopPreference === true)
    return { ...configured, enabled: true, mode: "desktop" };
  if (desktopPreference === false && configured.mode === "desktop")
    return { ...configured, enabled: false };
  return configured;
}
