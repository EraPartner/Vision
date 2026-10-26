import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { must } from "./helpers/must.ts";
import { loose } from "./helpers/partial.ts";

// Mirrors packaging/electron/settings-conflicts.ts, whose compiled output is
// loaded below.
interface SettingsWritePayload {
  value: unknown;
  expected: unknown;
}
type PutSettings = (
  key: string,
  payload: SettingsWritePayload,
) => Promise<unknown>;
interface SettingsWriter {
  loaded(key: string, result: unknown): void;
  save(key: string, value: unknown): Promise<unknown>;
}
const { createSettingsWriter } = loose<{
  createSettingsWriter: (put: PutSettings) => SettingsWriter;
}>(
  createRequire(import.meta.url)(
    "../../../packaging/electron/out/settings-conflicts.js",
  ),
);
describe("Electron conditional settings writer", () => {
  it("refuses saves based on the offline mirror", async () => {
    const put = vi.fn<PutSettings>();
    const writer = createSettingsWriter(put);
    await expect(writer.save("backup_settings", {})).rejects.toThrow(
      "not loaded",
    );
    expect(put).not.toHaveBeenCalled();
  });
  it("uses the loaded baseline and advances it only on acknowledgment", async () => {
    const put = vi.fn<PutSettings>((_key, payload) =>
      Promise.resolve({
        ok: true,
        data: { value: payload.value },
      }),
    );
    const writer = createSettingsWriter(put);
    writer.loaded("backup_settings", { expected: { exists: false } });
    await writer.save("backup_settings", { backupOnQuit: true });
    await writer.save("backup_settings", { backupOnQuit: false });
    expect(must(put.mock.calls[0], "put.mock.calls[0]")[1].expected).toEqual({
      exists: false,
    });
    expect(must(put.mock.calls[1], "put.mock.calls[1]")[1].expected).toEqual({
      exists: true,
      value: { backupOnQuit: true },
    });
  });
  it("fails on conflict, does not refresh the baseline, and blocks queued saves", async () => {
    const put = vi.fn<PutSettings>(() =>
      Promise.resolve({
        ok: false,
        error: { message: "Settings changed" },
      }),
    );
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
