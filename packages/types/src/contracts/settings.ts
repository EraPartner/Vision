import { z } from "zod";

/**
 * The optimistic-concurrency baseline `settingsRepository` returns: whether
 * the row exists and, when it does, its stored JSONB value.
 */
export const SettingBaselineSchema = z.looseObject({
  exists: z.boolean(),
  value: z.unknown().optional(),
});

/** `GET /api/settings?withBaselines=true` (`getAllWithBaselines`). */
export const SettingsWithBaselinesSchema = z.looseObject({
  settings: z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), SettingBaselineSchema),
});

/**
 * `GET /api/settings/:key` and `PUT /api/settings/:key`. `value` is any JSON
 * value (a stored row's value, or the route's default for an unsaved key).
 */
export const SettingRecordSchema = z.looseObject({
  key: z.string(),
  value: z.unknown(),
  expected: SettingBaselineSchema,
});
