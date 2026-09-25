import settings from "../config/config.js";
import settingsRepository from "../repositories/settingsRepository.js";

const DESKTOP_PREFERENCE_KEY = "agentcloak_desktop_enabled";

/** @param {boolean} enabled */
export async function setAgentCloakDesktopEnabled(enabled) {
  await settingsRepository.set(DESKTOP_PREFERENCE_KEY, enabled);
}

/** @returns {Promise<{enabled: boolean, mode: "mcp" | "desktop", url: string, apiKey: string, desktopUrl: string, timeoutMs: number}>} */
export async function getAgentCloakConfig() {
  const configured = {
    ...settings.aiResearch.agentCloak,
    mode: /** @type {"mcp" | "desktop"} */ (
      settings.aiResearch.agentCloak.mode === "desktop" ? "desktop" : "mcp"
    ),
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
