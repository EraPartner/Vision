import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

// This module prepares a disposable, unauthenticated fixture. It never starts Codex.
// A process-level network boundary and a complete runtime tool catalog remain required.
const DISABLED_FEATURES = Object.freeze([
  "apps",
  "api_key_model_discovery",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "codex_apps_mcp_2026_07_28",
  "hooks",
  "in_app_browser",
  "multi_agent",
  "mcp_2026_07_28",
  "memories",
  "mentions_v2",
  "network_proxy",
  "plugins",
  "remote_plugin",
  "remote_control",
  "shell_tool",
  "unified_exec",
  "tool_suggest",
  "web_search_cached",
  "web_search_request",
]);

const SYNTHETIC_QUESTION =
  "For a fictional household, list general questions to consider before changing a savings goal. Do not use tools or personal data.";
const PROBE_PREFIX = "vision-codex-synthetic-";
const OWNER_FILE = "probe-owner.json";

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export async function cleanupStaleSyntheticCodexProbes(tempParent) {
  if (typeof tempParent !== "string" || !tempParent.startsWith("/"))
    throw new TypeError("Temporary parent must be an absolute path");
  const parent = await realpath(tempParent);
  let removed = 0;
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROBE_PREFIX)) continue;
    const root = join(parent, entry.name);
    let owner;
    try {
      const marker = join(root, OWNER_FILE);
      const details = await lstat(marker);
      if (!details.isFile() || details.size > 512) continue;
      owner = JSON.parse(await readFile(marker, "utf8"));
    } catch {
      continue;
    }
    if (
      owner?.format !== "vision-codex-synthetic-owner-v1" ||
      owner.root !== root ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      !Number.isSafeInteger(owner.createdAt) ||
      owner.createdAt > Date.now() ||
      processIsAlive(owner.pid)
    )
      continue;
    await rm(root, { recursive: true, force: false });
    removed += 1;
  }
  return removed;
}

const CODEX_PROBE_REQUIRED_FEATURES = DISABLED_FEATURES;

function syntheticProbeConfig() {
  return [
    'forced_login_method = "chatgpt"',
    'cli_auth_credentials_store = "ephemeral"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "check_for_update_on_startup = false",
    'file_opener = "none"',
    "allow_login_shell = false",
    "include_environment_context = false",
    "include_apps_instructions = false",
    "include_permissions_instructions = false",
    "include_collaboration_mode_instructions = false",
    "project_doc_max_bytes = 0",
    "project_root_markers = []",
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "",
    "[apps._default]",
    "enabled = false",
    "destructive_enabled = false",
    "open_world_enabled = false",
    "",
    "[mcp_servers]",
    "",
    "[features]",
    ...DISABLED_FEATURES.map((feature) => `${feature} = false`),
    "",
  ].join("\n");
}

// A candidate for a supported administrator policy channel. Placing this
// beside CODEX_HOME does not itself install or enforce managed requirements.
function syntheticProbeManagedRequirements() {
  return [
    'allowed_sandbox_modes = ["read-only"]',
    'allowed_approval_policies = ["never"]',
    'allowed_web_search_modes = ["disabled"]',
    'allowed_login_methods = ["chatgpt"]',
    "allow_browser_and_computer_use = false",
    "allow_remote_control = false",
    "allow_managed_hooks_only = true",
    "",
    "[features]",
    ...DISABLED_FEATURES.map((feature) => `${feature} = false`),
    "",
  ].join("\n");
}

function restrictedProbeSandbox(workspaceDir) {
  if (typeof workspaceDir !== "string" || !workspaceDir.startsWith("/")) {
    throw new TypeError("Synthetic workspace must be an absolute path");
  }
  return {
    type: "readOnly",
    access: {
      type: "restricted",
      includePlatformDefaults: false,
      readableRoots: [resolve(workspaceDir)],
    },
  };
}

export function syntheticProbeEnvironment({ homeDir, workspaceDir }) {
  if (
    ![homeDir, workspaceDir].every(
      (path) => typeof path === "string" && path.startsWith("/"),
    )
  ) {
    throw new TypeError("Synthetic home and workspace must be absolute paths");
  }
  return Object.freeze({
    CODEX_HOME: resolve(homeDir),
    HOME: resolve(homeDir),
    TMPDIR: resolve(workspaceDir),
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
  });
}

async function prepareSyntheticCodexProbe(tempParent) {
  if (typeof tempParent !== "string" || !tempParent.startsWith("/")) {
    throw new TypeError("Temporary parent must be an absolute path");
  }
  const root = await realpath(
    await mkdtemp(join(resolve(tempParent), PROBE_PREFIX)),
  );
  await writeFile(
    join(root, OWNER_FILE),
    JSON.stringify({
      format: "vision-codex-synthetic-owner-v1",
      root,
      pid: process.pid,
      createdAt: Date.now(),
    }),
    { mode: 0o600, flag: "wx" },
  );
  const homeDir = join(root, "codex-home");
  const workspaceDir = join(root, "workspace");
  await Promise.all([
    mkdir(homeDir, { mode: 0o700 }),
    mkdir(workspaceDir, { mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(join(homeDir, "config.toml"), syntheticProbeConfig(), {
      mode: 0o600,
    }),
    writeFile(join(workspaceDir, "question.txt"), `${SYNTHETIC_QUESTION}\n`, {
      mode: 0o600,
    }),
    writeFile(
      join(root, "requirements.candidate.toml"),
      syntheticProbeManagedRequirements(),
      { mode: 0o600 },
    ),
  ]);
  return Object.freeze({
    root,
    homeDir,
    workspaceDir,
    managedRequirementsCandidate: join(root, "requirements.candidate.toml"),
    environment: syntheticProbeEnvironment({ homeDir, workspaceDir }),
    sandboxPolicy: restrictedProbeSandbox(workspaceDir),
    launchEnabled: false,
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function get(object, dottedKey) {
  return dottedKey
    .split(".")
    .reduce((value, key) => (isRecord(value) ? value[key] : undefined), object);
}

// The caller must supply the result of App Server config/read. A config file on
// disk is not evidence that overrides or inherited managed layers were applied.
function validateEffectiveProbeConfig(configRead) {
  const config = configRead?.result?.config;
  if (!isRecord(config))
    return { ok: false, reasons: ["EFFECTIVE_CONFIG_UNAVAILABLE"] };
  const expected = {
    forced_login_method: "chatgpt",
    cli_auth_credentials_store: "ephemeral",
    approval_policy: "never",
    sandbox_mode: "read-only",
    web_search: "disabled",
    "history.persistence": "none",
    "shell_environment_policy.inherit": "none",
    "apps._default.enabled": false,
    "apps._default.destructive_enabled": false,
    "apps._default.open_world_enabled": false,
    allow_login_shell: false,
    include_environment_context: false,
    include_apps_instructions: false,
    include_permissions_instructions: false,
    include_collaboration_mode_instructions: false,
    project_doc_max_bytes: 0,
  };
  for (const feature of DISABLED_FEATURES)
    expected[`features.${feature}`] = false;
  const reasons = Object.entries(expected)
    .filter(([key, value]) => get(config, key) !== value)
    .map(([key]) => `UNSAFE_CONFIG:${key}`);
  if (
    !Array.isArray(config.project_root_markers) ||
    config.project_root_markers.length !== 0
  ) {
    reasons.push("PROJECT_DISCOVERY_ENABLED");
  }
  if (isRecord(config.features)) {
    for (const [key, value] of Object.entries(config.features)) {
      if (!DISABLED_FEATURES.includes(key) && value === true) {
        reasons.push(`UNREVIEWED_FEATURE:${key}`);
      }
    }
  }
  if (
    !isRecord(config.mcp_servers) ||
    Object.keys(config.mcp_servers).length !== 0
  ) {
    reasons.push("MCP_SERVERS_PRESENT");
  }
  if (
    isRecord(config.apps) &&
    Object.keys(config.apps).some((key) => key !== "_default")
  ) {
    reasons.push("APP_OVERRIDE_PRESENT");
  }
  if (
    config.model_provider != null ||
    (isRecord(config.model_providers) &&
      Object.keys(config.model_providers).length > 0)
  ) {
    reasons.push("CUSTOM_PROVIDER_PRESENT");
  }
  if (config.tools != null || config.tool_suggest != null) {
    reasons.push("UNREVIEWED_TOOL_CONFIG");
  }
  return { ok: reasons.length === 0, reasons };
}

// No documented App Server method currently proves this catalog complete. This
// gate is intentionally impossible to satisfy with only config/read evidence.
function validateProbeToolCatalog(catalog) {
  if (
    !isRecord(catalog) ||
    catalog.complete !== true ||
    !Array.isArray(catalog.tools)
  ) {
    return { ok: false, reasons: ["COMPLETE_TOOL_CATALOG_UNAVAILABLE"] };
  }
  if (catalog.tools.length > 0) {
    return { ok: false, reasons: ["TOOLS_AVAILABLE"] };
  }
  return { ok: true, reasons: [] };
}

function assessSyntheticCodexProbe({
  configRead,
  toolCatalog,
  processBoundary,
}) {
  const config = validateEffectiveProbeConfig(configRead);
  const tools = validateProbeToolCatalog(toolCatalog);
  const reasons = [...config.reasons, ...tools.reasons];
  if (
    processBoundary?.wholeProcessNetworkDenied !== true ||
    processBoundary?.filesystemRestricted !== true ||
    processBoundary?.independentTrafficInspection !== true
  ) {
    reasons.push("OUTER_PROCESS_BOUNDARY_UNPROVEN");
  }
  return {
    allowed: false,
    syntheticChecksPassed: reasons.length === 0,
    reasons,
  };
}

export {
  assessSyntheticCodexProbe as __assessSyntheticCodexProbe,
  CODEX_PROBE_REQUIRED_FEATURES as __CODEX_PROBE_REQUIRED_FEATURES,
  prepareSyntheticCodexProbe as __prepareSyntheticCodexProbe,
  restrictedProbeSandbox as __restrictedProbeSandbox,
  syntheticProbeConfig as __syntheticProbeConfig,
  syntheticProbeManagedRequirements as __syntheticProbeManagedRequirements,
  validateEffectiveProbeConfig as __validateEffectiveProbeConfig,
  validateProbeToolCatalog as __validateProbeToolCatalog,
};
