"use strict";

// Preserve the baseline from the load that produced the displayed settings.
// A fallback local mirror never authorizes replacing unknown database state.
function createSettingsWriter(put) {
  const baselines = new Map();
  const pending = new Map();
  return {
    loaded(key, result) {
      if (result?.expected && !baselines.has(key))
        baselines.set(key, result.expected);
    },
    save(key, value) {
      const next = (pending.get(key) || Promise.resolve()).then(async () => {
        const expected = baselines.get(key);
        if (!expected)
          throw new Error(
            "Settings were not loaded. Reopen Vision before saving.",
          );
        const body = await put(key, { value, expected });
        if (body?.ok !== true)
          throw new Error(body?.error?.message || "Could not save settings");
        baselines.set(key, { exists: true, value: body.data.value });
        return body;
      });
      pending.set(key, next);
      return next;
    },
  };
}
module.exports = { createSettingsWriter };
