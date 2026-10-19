import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function dotenvPaths(moduleUrl: string): string[] {
  const directory = dirname(fileURLToPath(moduleUrl));
  return [
    join(directory, "..", "..", ".env.local"),
    join(directory, "..", "..", "..", "..", ".env"),
  ];
}

export function applyDotenvContent(
  content: string,
  environment: Record<string, string | undefined>,
): void {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    environment[key] ??= value;
  }
}
