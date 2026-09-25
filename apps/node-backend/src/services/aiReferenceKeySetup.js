import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import settings from "../config/config.js";
import envConfig from "../config/env.js";
import { mappingKey } from "./aiReferenceService.js";

const LOCAL_ENV_PATH = fileURLToPath(
  new URL("../../.env.local", import.meta.url),
);

/**
 * Create the installation key outside database backups. Never replace an
 * existing key: old investigation scopes would become unrestorable.
 * @param {{filePath?: string, env?: NodeJS.ProcessEnv, random?: typeof randomBytes}} [options]
 */
export function ensureReferenceMappingKey({
  filePath = envConfig.VISION_NATIVE_ENV_FILE || LOCAL_ENV_PATH,
  env = process.env,
  random = randomBytes,
} = {}) {
  const configured =
    env.AI_REFERENCE_MAPPING_KEY || settings.aiResearch.referenceMappingKey;
  if (mappingKey(configured || "")) return { created: false };
  if (configured)
    throw Object.assign(
      new Error("The existing reference mapping key is invalid"),
      {
        code: "REFERENCE_KEY_INVALID",
        status: 409,
      },
    );

  const existing = existsSync(filePath) ? lstatSync(filePath) : null;
  if (existing && !existing.isFile())
    throw Object.assign(
      new Error("The local environment file is not a regular file"),
      {
        code: "REFERENCE_KEY_STORAGE_UNAVAILABLE",
        status: 503,
      },
    );
  const content = existing ? readFileSync(filePath, "utf8") : "";
  const keyLines = [
    ...content.matchAll(/^[ \t]*AI_REFERENCE_MAPPING_KEY[ \t]*=([^\r\n]*)$/gm),
  ];
  if (keyLines.length > 1 || (keyLines.length === 1 && keyLines[0][1].trim()))
    throw Object.assign(
      new Error("The existing reference mapping key is invalid"),
      {
        code: "REFERENCE_KEY_INVALID",
        status: 409,
      },
    );
  const encoded = random(32).toString("base64");
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  const updated = keyLines.length
    ? content.replace(keyLines[0][0], `AI_REFERENCE_MAPPING_KEY=${encoded}`)
    : `${content}${prefix}AI_REFERENCE_MAPPING_KEY=${encoded}\n`;
  const temporary = `${filePath}.agentcloak-${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    if (!fstatSync(descriptor).isFile())
      throw new Error("Temporary key file is not regular");
    writeFileSync(descriptor, updated);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const current = existsSync(filePath) ? lstatSync(filePath) : null;
    if (
      (existing &&
        (!current ||
          current.ino !== existing.ino ||
          current.mtimeMs !== existing.mtimeMs)) ||
      (!existing && current)
    )
      throw new Error("Local environment file changed during key setup");
    renameSync(temporary, filePath);
    env.AI_REFERENCE_MAPPING_KEY = encoded;
    return { created: true };
  } catch {
    throw Object.assign(
      new Error("Could not save the reference mapping key locally"),
      {
        code: "REFERENCE_KEY_STORAGE_UNAVAILABLE",
        status: 503,
      },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temp file is already renamed or could not be created.
    }
  }
}
