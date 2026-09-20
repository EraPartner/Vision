import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __assessSyntheticCodexProbe as assessSyntheticCodexProbe,
  __CODEX_PROBE_REQUIRED_FEATURES as CODEX_PROBE_REQUIRED_FEATURES,
  __prepareSyntheticCodexProbe as prepareSyntheticCodexProbe,
  __restrictedProbeSandbox as restrictedProbeSandbox,
  __syntheticProbeConfig as syntheticProbeConfig,
  __syntheticProbeManagedRequirements as syntheticProbeManagedRequirements,
  __validateEffectiveProbeConfig as validateEffectiveProbeConfig,
  __validateProbeToolCatalog as validateProbeToolCatalog,
  cleanupStaleSyntheticCodexProbes,
} from "../src/integrations/codex/syntheticProbe.js";

const scratch = [];
afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function safeConfigRead() {
  return {
    result: {
      config: {
        forced_login_method: "chatgpt",
        cli_auth_credentials_store: "ephemeral",
        approval_policy: "never",
        sandbox_mode: "read-only",
        web_search: "disabled",
        allow_login_shell: false,
        include_environment_context: false,
        include_apps_instructions: false,
        include_permissions_instructions: false,
        include_collaboration_mode_instructions: false,
        project_doc_max_bytes: 0,
        project_root_markers: [],
        history: { persistence: "none" },
        shell_environment_policy: { inherit: "none" },
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
        mcp_servers: {},
        features: Object.fromEntries(
          CODEX_PROBE_REQUIRED_FEATURES.map((key) => [key, false]),
        ),
      },
    },
  };
}

describe("disabled synthetic Codex App Server probe", () => {
  it("creates fresh private state with a synthetic-only workspace and sanitized environment", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vision-codex-probe-test-"));
    scratch.push(parent);
    const first = await prepareSyntheticCodexProbe(parent);
    const second = await prepareSyntheticCodexProbe(parent);
    expect(first.root).not.toBe(second.root);
    expect(first.launchEnabled).toBe(false);
    expect(Object.keys(first.environment).sort()).toEqual([
      "CODEX_HOME",
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
    ]);
    expect(first.environment.CODEX_HOME).toBe(first.homeDir);
    expect(first.environment.HOME).toBe(first.homeDir);
    expect(first.sandboxPolicy).toEqual(
      restrictedProbeSandbox(first.workspaceDir),
    );
    expect(
      await readFile(join(first.workspaceDir, "question.txt"), "utf8"),
    ).toContain("fictional household");
    expect(await readFile(join(first.homeDir, "config.toml"), "utf8")).toBe(
      syntheticProbeConfig(),
    );
    expect(await readFile(first.managedRequirementsCandidate, "utf8")).toBe(
      syntheticProbeManagedRequirements(),
    );
    expect((await stat(first.homeDir)).mode & 0o077).toBe(0);
    expect((await stat(join(first.homeDir, "config.toml"))).mode & 0o077).toBe(
      0,
    );
  });

  it("removes only abandoned marked Codex roots after a process crash", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vision-codex-cleanup-test-"));
    scratch.push(parent);
    const stale = await prepareSyntheticCodexProbe(parent);
    const active = await prepareSyntheticCodexProbe(parent);
    const unrelated = join(parent, "vision-codex-synthetic-unmarked");
    await mkdir(unrelated);
    await writeFile(
      join(stale.homeDir, "synthetic-credential-remnant"),
      "dummy",
    );
    await writeFile(
      join(stale.root, "probe-owner.json"),
      JSON.stringify({
        format: "vision-codex-synthetic-owner-v1",
        root: stale.root,
        pid: 999999,
        createdAt: Date.now() - 1000,
      }),
    );

    expect(await cleanupStaleSyntheticCodexProbes(parent)).toBe(1);
    await expect(stat(stale.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(active.root)).resolves.toBeDefined();
    await expect(stat(unrelated)).resolves.toBeDefined();
  });

  it("refuses relative workspace paths and missing effective config", () => {
    expect(() => restrictedProbeSandbox("workspace")).toThrow();
    expect(validateEffectiveProbeConfig({})).toEqual({
      ok: false,
      reasons: ["EFFECTIVE_CONFIG_UNAVAILABLE"],
    });
  });

  it("fails closed when any effective tool or authentication control changes", () => {
    const snapshot = safeConfigRead();
    expect(validateEffectiveProbeConfig(snapshot)).toEqual({
      ok: true,
      reasons: [],
    });
    snapshot.result.config.features.shell_tool = true;
    snapshot.result.config.features.new_browser_tool = true;
    snapshot.result.config.mcp_servers.files = { enabled: true };
    snapshot.result.config.forced_login_method = "api";
    snapshot.result.config.tool_suggest = { discoverables: [] };
    const result = validateEffectiveProbeConfig(snapshot);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "UNSAFE_CONFIG:features.shell_tool",
        "UNSAFE_CONFIG:forced_login_method",
        "UNREVIEWED_FEATURE:new_browser_tool",
        "MCP_SERVERS_PRESENT",
        "UNREVIEWED_TOOL_CONFIG",
      ]),
    );
  });

  it("rejects an absent, incomplete, or nonempty runtime tool catalog", () => {
    expect(validateProbeToolCatalog(undefined).ok).toBe(false);
    expect(validateProbeToolCatalog({ complete: false, tools: [] }).ok).toBe(
      false,
    );
    expect(
      validateProbeToolCatalog({ complete: true, tools: ["web_search"] }).ok,
    ).toBe(false);
    expect(validateProbeToolCatalog({ complete: true, tools: [] }).ok).toBe(
      true,
    );
  });

  it("never enables an outbound route even with hypothetical passing snapshots", () => {
    const result = assessSyntheticCodexProbe({
      configRead: safeConfigRead(),
      toolCatalog: { complete: true, tools: [] },
      processBoundary: {
        wholeProcessNetworkDenied: true,
        filesystemRestricted: true,
        independentTrafficInspection: true,
      },
    });
    expect(result).toEqual({
      allowed: false,
      syntheticChecksPassed: true,
      reasons: [],
    });
    expect(
      assessSyntheticCodexProbe({ configRead: safeConfigRead() }).reasons,
    ).toContain("OUTER_PROCESS_BOUNDARY_UNPROVEN");
  });
});
