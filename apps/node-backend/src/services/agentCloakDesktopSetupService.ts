import settings from "../config/config.ts";
import { detectAgentCloakDesktopSpans } from "./agentCloakPreflight.ts";
import {
  getAgentCloakConfig,
  setAgentCloakDesktopEnabled,
} from "./agentCloakRuntimeConfig.ts";
import { ensureReferenceMappingKey } from "./aiReferenceKeySetup.ts";
import { mappingKey } from "./aiReferenceService.ts";
import {
  UpstreamError,
  AppError,
  ConflictError,
} from "../middleware/errorHandler.ts";

const PROBE_TEXT = "Vision privacy connection check";

async function probeAgentCloakDesktop({
  detect = detectAgentCloakDesktopSpans,
}: { detect?: typeof detectAgentCloakDesktopSpans } = {}) {
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

export { probeAgentCloakDesktop as __probeAgentCloakDesktop };

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

export async function configureAgentCloakDesktop(enabled: boolean) {
  if (enabled) {
    if (!(await probeAgentCloakDesktop()))
      throw new UpstreamError("AgentCloak Desktop is not reachable by Vision", {
        code: "AGENTCLOAK_DESKTOP_UNAVAILABLE",
      });
    try {
      ensureReferenceMappingKey();
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "REFERENCE_KEY_INVALID"
      )
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
