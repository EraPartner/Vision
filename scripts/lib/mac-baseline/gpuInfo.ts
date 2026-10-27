/**
 * The chrome://gpu readout for the Mac performance baseline, from the DevTools
 * protocol's SystemInfo.getInfo on the browser target: GPU feature status,
 * the Skia backend (Graphite or Ganesh) and overlay attributes, recorded once
 * per app so later runs know which compositing path was measured.
 */

export interface GpuInfo {
  modelName: string | null;
  modelVersion: string | null;
  /** The browser's command line, so --chromium-switch can be checked. */
  commandLine: string | null;
  devices: {
    vendorString: string;
    deviceString: string;
    driverVendor: string;
    driverVersion: string;
  }[];
  /** chrome://gpu "Graphics Feature Status", e.g. gpu_compositing: enabled. */
  featureStatus: Record<string, string>;
  /** featureStatus.skia_graphite when Chromium reports it. */
  graphite: string | null;
  /** Feature-status and aux attributes that name Skia, Graphite, Ganesh or Dawn. */
  skia: Record<string, unknown>;
  /** Attributes that name overlays or CoreAnimation layers. */
  overlay: Record<string, unknown>;
  auxAttributes: Record<string, unknown>;
  driverBugWorkarounds: string[];
}

const SKIA = /skia|graphite|ganesh|dawn/i;
const OVERLAY = /overlay|ca_?layer|core_?animation|direct_?composition/i;

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Keep what chrome://gpu shows; drop the codec tables. */
export function summarizeGpuInfo(info: unknown): GpuInfo {
  const root = record(info);
  const gpu = record(root.gpu);
  const featureStatus = Object.fromEntries(
    Object.entries(record(gpu.featureStatus)).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
  const auxAttributes = record(gpu.auxAttributes);
  const pick = (pattern: RegExp) =>
    Object.fromEntries(
      [
        ...Object.entries(featureStatus),
        ...Object.entries(auxAttributes),
      ].filter(([key]) => pattern.test(key)),
    );
  return {
    modelName: text(root.modelName),
    modelVersion: text(root.modelVersion),
    commandLine: text(root.commandLine),
    devices: (Array.isArray(gpu.devices) ? gpu.devices : []).map((device) => {
      const entry = record(device);
      return {
        vendorString: text(entry.vendorString) ?? "",
        deviceString: text(entry.deviceString) ?? "",
        driverVendor: text(entry.driverVendor) ?? "",
        driverVersion: text(entry.driverVersion) ?? "",
      };
    }),
    featureStatus,
    graphite: featureStatus.skia_graphite ?? null,
    skia: pick(SKIA),
    overlay: pick(OVERLAY),
    auxAttributes,
    driverBugWorkarounds: (Array.isArray(gpu.driverBugWorkarounds)
      ? gpu.driverBugWorkarounds
      : []
    ).map(String),
  };
}
