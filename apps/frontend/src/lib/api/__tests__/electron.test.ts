/**
 * @vitest-environment jsdom
 *
 * The electron bridge exposes capability-gated helpers: each reads a
 * `window.electron*` object and returns null/no-ops when absent. We toggle the
 * injected globals to exercise both the "present" and "absent" branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isElectron,
  isElectronMac,
  setDockBadge,
  setNativeLanguage,
  persistSplashTheme,
  getSystemAccentColor,
  triggerDockerUpdate,
  installShellUpdate,
  preUpdateBackup,
  runBackup,
  selectBackupFile,
  restoreBackup,
  isBackupEncrypted,
  selectBackupDir,
  getBackupEncryptionStatus,
  setBackupPassphrase,
} from "@/lib/api/electron";

/** The real Window already declares these bridges; cast to a loose record so the
 *  tests can inject/clear mocks without re-declaring the global interface. */
const win = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete win.electronUpdater;
  delete win.electronBackup;
  delete win.electronAPI;
  vi.restoreAllMocks();
});

describe("electron capability detection (absent branch)", () => {
  it("isElectron is false without the updater bridge", () => {
    expect(isElectron()).toBe(false);
  });

  it("isElectronMac is false without electronAPI", () => {
    expect(isElectronMac()).toBe(false);
  });

  it("native UI setters are safe no-ops outside Electron", () => {
    expect(() => setDockBadge(3)).not.toThrow();
    expect(() => setNativeLanguage("nl")).not.toThrow();
    expect(() => persistSplashTheme({ background: "0 0% 0%", foreground: "0 0% 100%" })).not.toThrow();
  });

  it("getSystemAccentColor returns null without electronAPI", async () => {
    expect(await getSystemAccentColor()).toBeNull();
  });

  it("update/backup helpers return null when no bridge is present", async () => {
    expect(await triggerDockerUpdate()).toBeNull();
    expect(await installShellUpdate()).toBeNull();
    expect(await preUpdateBackup()).toBeNull();
    expect(await runBackup("/tmp")).toBeNull();
    expect(await selectBackupFile()).toBeNull();
    expect(await restoreBackup("/tmp/x")).toBeNull();
    expect(await isBackupEncrypted("/tmp/x")).toBe(false);
    expect(await selectBackupDir()).toBeNull();
    expect(await getBackupEncryptionStatus()).toBeNull();
    expect(await setBackupPassphrase("pw")).toBeNull();
  });
});

describe("electron capability detection (present branch)", () => {
  beforeEach(() => {
    win.electronUpdater = {
      pullImage: vi.fn().mockResolvedValue({ success: true, wasNew: true }),
      installShellUpdate: vi.fn().mockResolvedValue({ success: true, version: "1.2.3" }),
      getMode: vi.fn().mockResolvedValue({ mode: "docker", is_packaged: true, use_repo_mode: false }),
      preUpdateBackup: vi.fn().mockResolvedValue({ success: true, file: "/b.sql" }),
    };
    win.electronBackup = {
      runBackup: vi.fn().mockResolvedValue({ success: true, file: "/b.visionbak" }),
      selectFile: vi.fn().mockResolvedValue("/picked"),
      restoreBackup: vi.fn().mockResolvedValue({ success: true }),
      isEncrypted: vi.fn().mockResolvedValue(true),
      selectDir: vi.fn().mockResolvedValue("/dir"),
      getEncryptionStatus: vi.fn().mockResolvedValue({
        success: true,
        secureStorageAvailable: true,
        hasStoredPassphrase: false,
        hasEnvPassphrase: false,
      }),
      setPassphrase: vi.fn().mockResolvedValue({ success: true, available: true }),
    };
    win.electronAPI = {
      platform: "darwin",
      setDockBadge: vi.fn().mockResolvedValue({ success: true }),
      setLanguage: vi.fn().mockResolvedValue({ success: true }),
      getAccentColor: vi.fn().mockResolvedValue("FF0000FF"),
      persistSplashTheme: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  it("isElectron / isElectronMac are true with the bridges injected", () => {
    expect(isElectron()).toBe(true);
    expect(isElectronMac()).toBe(true);
  });

  it("native UI setters call through to the bridge", () => {
    setDockBadge(5);
    setNativeLanguage("nl");
    persistSplashTheme({ background: "x", foreground: "y" });
    expect(win.electronAPI).toBeTruthy();
    expect((win.electronAPI as { setLanguage: ReturnType<typeof vi.fn> }).setLanguage).toHaveBeenCalledWith("nl");
  });

  it("getSystemAccentColor returns the native accent", async () => {
    expect(await getSystemAccentColor()).toBe("FF0000FF");
  });

  it("update helpers delegate to the updater bridge", async () => {
    expect(await triggerDockerUpdate()).toMatchObject({ success: true, wasNew: true });
    expect(await installShellUpdate()).toMatchObject({ version: "1.2.3" });
    expect(await preUpdateBackup()).toMatchObject({ file: "/b.sql" });
  });

  it("backup helpers delegate to the backup bridge", async () => {
    expect(await runBackup("/dest", "{}")).toMatchObject({ file: "/b.visionbak" });
    expect(await selectBackupFile()).toBe("/picked");
    expect(await restoreBackup("/f", { passphrase: "pw" })).toMatchObject({ success: true });
    expect(await isBackupEncrypted("/f")).toBe(true);
    expect(await selectBackupDir()).toBe("/dir");
    expect(await getBackupEncryptionStatus()).toMatchObject({ secureStorageAvailable: true });
    expect(await setBackupPassphrase("pw")).toMatchObject({ available: true });
  });

  it("getSystemAccentColor swallows a bridge error and returns null", async () => {
    win.electronAPI = {
      platform: "darwin",
      getAccentColor: vi.fn().mockRejectedValue(new Error("boom")),
    };
    expect(await getSystemAccentColor()).toBeNull();
  });

  it("does not crash in an older shell without the language bridge", () => {
    win.electronAPI = { platform: "darwin" };
    expect(() => setNativeLanguage("nl")).not.toThrow();
  });

  it("isBackupEncrypted returns false when the bridge throws", async () => {
    win.electronBackup = {
      isEncrypted: vi.fn().mockRejectedValue(new Error("boom")),
    };
    expect(await isBackupEncrypted("/f")).toBe(false);
  });
});
