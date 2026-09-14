import { z } from "zod";

const modelSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  label: z.string().min(1).max(200).optional(),
  inputMicrosPerMillion: z.number().int().positive(),
  outputMicrosPerMillion: z.number().int().positive(),
});

const catalogSchema = z.array(modelSchema).min(1).max(12);

export function parseOpenAiModelCatalog({
  catalogJson,
  legacyModel,
  legacyInputMicrosPerMillion,
  legacyOutputMicrosPerMillion,
}) {
  if (!catalogJson) {
    if (!legacyModel) return [];
    return [
      {
        id: legacyModel,
        label: legacyModel,
        inputMicrosPerMillion: legacyInputMicrosPerMillion,
        outputMicrosPerMillion: legacyOutputMicrosPerMillion,
      },
    ];
  }

  let decoded;
  try {
    decoded = JSON.parse(catalogJson);
  } catch {
    throw new Error("OPENAI_API_MODELS_JSON must be valid JSON");
  }
  const models = catalogSchema.parse(decoded).map((model) => ({
    ...model,
    label: model.label ?? model.id,
  }));
  const ids = new Set(models.map((model) => model.id));
  if (ids.size !== models.length)
    throw new Error("OPENAI_API_MODELS_JSON contains duplicate model ids");
  if (legacyModel && !ids.has(legacyModel))
    throw new Error(
      "OPENAI_API_MODEL must name a model in OPENAI_API_MODELS_JSON",
    );
  return models;
}
