import { createNativeRuntime, type NativeRuntimeOptions } from "./native";

export const RUNTIME_MODES: ReadonlySet<string> = new Set(["native"]);

export type RuntimeMode = "native";

export interface ResolveRuntimeModeOptions {
  env?: NodeJS.ProcessEnv;
  isDemo?: boolean;
}

export interface RuntimeProviderOptions {
  native: NativeRuntimeOptions;
}

function isRuntimeMode(value: string): value is RuntimeMode {
  return RUNTIME_MODES.has(value);
}

export function normalizeMode(value: unknown): RuntimeMode | undefined {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return isRuntimeMode(mode) ? mode : undefined;
}

export function resolveRuntimeMode({
  env = process.env,
  isDemo = false,
}: ResolveRuntimeModeOptions = {}): RuntimeMode {
  if (isDemo) return "native";
  const requested = normalizeMode(env.VISION_RUNTIME_MODE);
  if (env.VISION_RUNTIME_MODE && !requested) {
    const error: Error & { code?: string } = new Error(
      "VISION_RUNTIME_MODE only supports native",
    );
    error.code = "INVALID_RUNTIME_MODE";
    throw error;
  }
  if (requested) return requested;
  return "native";
}

export function createRuntimeProvider(
  mode: string,
  options: RuntimeProviderOptions,
) {
  if (mode === "native") return createNativeRuntime(options.native);
  throw new Error(`Unsupported Vision runtime mode: ${mode}`);
}
