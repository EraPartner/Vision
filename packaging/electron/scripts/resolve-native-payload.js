"use strict";

const path = require("node:path");

const defaultNativePayloadRoot = path.resolve(
  __dirname,
  "..",
  "native-runtime",
);

function resolveNativePayloadRoot(
  configured = process.env.VISION_NATIVE_PAYLOAD_ROOT,
) {
  if (configured === undefined) return defaultNativePayloadRoot;
  if (typeof configured !== "string" || configured.trim() === "") {
    throw new Error("VISION_NATIVE_PAYLOAD_ROOT must be a non-empty path");
  }
  if (!path.isAbsolute(configured)) {
    throw new Error("VISION_NATIVE_PAYLOAD_ROOT must be an absolute path");
  }
  return path.resolve(configured);
}

module.exports = {
  defaultNativePayloadRoot,
  resolveNativePayloadRoot,
};
