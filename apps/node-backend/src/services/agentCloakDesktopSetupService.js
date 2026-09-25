import settings from "../config/config.js";
import { detectAgentCloakDesktopSpans } from "./agentCloakPreflight.js";
import {
  getAgentCloakConfig,
  setAgentCloakDesktopEnabled,
} from "./agentCloakRuntimeConfig.js";
import { ensureReferenceMappingKey } from "./aiReferenceKeySetup.js";
import { mappingKey } from "./aiReferenceService.js";
import {
  UpstreamError,
  AppError,
  ConflictError,
} from "../middleware/errorHandler.js";

const PROBE_TEXT = "Vision privacy connection check";

/** @param {object} [options] @param {typeof detectAgentCloakDesktopSpans} [options.detect] */
export async function probeAgentCloakDesktop({
  detect = detectAgentCloakDesktopSpans,
} = {}) {
  const configured = settings.aiResearch.agentCloak;
  try {
    await detect(PROBE_TEXT, {
      config: {
        ...configured,
        enabled: true,
        mode: "desktop",
        timeoutMs: Math.min(configured.timeoutMs, 1500),
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function agentCloakDesktopStatus() {
  const [config, available] = await Promise.all([
    getAgentCloakConfig(),
    probeAgentCloakDesktop(),
  ]);
  return {
    enabled: Boolean(config.enabled && config.mode === "desktop"),
    available,
    mappingKeyConfigured: Boolean(mappingKey()),
    openAiEnabled: Boolean(settings.aiResearch.openai.enabled),
  };
}

/** @param {boolean} enabled */
export async function configureAgentCloakDesktop(enabled) {
  if (enabled) {
    if (!(await probeAgentCloakDesktop()))
      throw new UpstreamError("AgentCloak Desktop is not reachable by Vision", {
        code: "AGENTCLOAK_DESKTOP_UNAVAILABLE",
      });
    try {
      ensureReferenceMappingKey();
    } catch (error) {
      if (error?.code === "REFERENCE_KEY_INVALID")
        throw new ConflictError(
          "The existing reference mapping key is invalid",
          {
            code: "REFERENCE_KEY_INVALID",
          },
        );
      throw new AppError("Could not save the reference mapping key locally", {
        code: "REFERENCE_KEY_STORAGE_UNAVAILABLE",
        status: 503,
      });
    }
  }
  await setAgentCloakDesktopEnabled(enabled);
  return agentCloakDesktopStatus();
}
