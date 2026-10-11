import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const { createSettingsWriter } = createRequire(import.meta.url)(
  "../../../packaging/electron/settings-conflicts.js",
);
describe("Electron conditional settings writer", () => {
  it("refuses saves based on the offline mirror", async () => {
    const put = vi.fn();
    const writer = createSettingsWriter(put);
    await expect(writer.save("backup_settings", {})).rejects.toThrow(
      "not loaded",
    );
    expect(put).not.toHaveBeenCalled();
  });
  it("uses the loaded baseline and advances it only on acknowledgment", async () => {
    const put = vi.fn(async (_key, payload) => ({
      ok: true,
      data: { value: payload.value },
    }));
    const writer = createSettingsWriter(put);
    writer.loaded("backup_settings", { expected: { exists: false } });
    await writer.save("backup_settings", { backupOnQuit: true });
    await writer.save("backup_settings", { backupOnQuit: false });
    expect(put.mock.calls[0]![1].expected).toEqual({ exists: false });
    expect(put.mock.calls[1]![1].expected).toEqual({
      exists: true,
      value: { backupOnQuit: true },
    });
  });
  it("fails on conflict, does not refresh the baseline, and blocks queued saves", async () => {
    const put = vi.fn(async () => ({
      ok: false,
      error: { message: "Settings changed" },
    }));
    const writer = createSettingsWriter(put);
    writer.loaded("services_settings", {
      expected: { exists: true, value: {} },
    });
    await expect(
      writer.save("services_settings", { keepServicesOnQuit: true }),
    ).rejects.toThrow("Settings changed");
    writer.loaded("services_settings", {
      expected: { exists: true, value: { newer: true } },
    });
    await expect(writer.save("services_settings", {})).rejects.toThrow(
      "Settings changed",
    );
    expect(put).toHaveBeenCalledOnce();
  });
});
