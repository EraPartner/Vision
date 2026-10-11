import path from "node:path";

import { appRoot } from "../paths";

export const defaultNativePayloadRoot = path.resolve(appRoot, "native-runtime");

export function resolveNativePayloadRoot(
  configured: unknown = process.env.VISION_NATIVE_PAYLOAD_ROOT,
): string {
  if (configured === undefined) return defaultNativePayloadRoot;
  if (typeof configured !== "string" || configured.trim() === "") {
    throw new Error("VISION_NATIVE_PAYLOAD_ROOT must be a non-empty path");
  }
  if (!path.isAbsolute(configured)) {
    throw new Error("VISION_NATIVE_PAYLOAD_ROOT must be an absolute path");
  }
  return path.resolve(configured);
}
