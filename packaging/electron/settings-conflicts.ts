/** Body of a conditional settings write: the new value and the loaded baseline. */
export interface SettingsWritePayload {
  value: unknown;
  expected: unknown;
}

export interface SettingsWriter {
  loaded(key: string, result: unknown): void;
  save(key: string, value: unknown): Promise<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const message = body.error.message;
  return typeof message === "string" ? message : undefined;
}

// Preserve the baseline from the load that produced the displayed settings.
// A fallback local mirror never authorizes replacing unknown database state.
export function createSettingsWriter(
  put: (key: string, payload: SettingsWritePayload) => Promise<unknown>,
): SettingsWriter {
  const baselines = new Map<string, unknown>();
  const pending = new Map<string, Promise<unknown>>();
  return {
    loaded(key, result) {
      if (isRecord(result) && result.expected && !baselines.has(key))
        baselines.set(key, result.expected);
    },
    save(key, value) {
      const next = (pending.get(key) ?? Promise.resolve()).then(async () => {
        const expected = baselines.get(key);
        if (!expected)
          throw new Error(
            "Settings were not loaded. Reopen Vision before saving.",
          );
        const body = await put(key, { value, expected });
        if (!isRecord(body) || body.ok !== true)
          throw new Error(errorMessage(body) || "Could not save settings");
        // An acknowledgment without data cannot advance the baseline.
        const data = body.data;
        if (data === undefined || data === null)
          throw new Error("Could not save settings");
        baselines.set(key, {
          exists: true,
          value: isRecord(data) ? data.value : undefined,
        });
        return body;
      });
      pending.set(key, next);
      return next;
    },
  };
}
