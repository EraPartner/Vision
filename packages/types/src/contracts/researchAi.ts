import { z } from "zod";

/*
 * Wire contracts for /api/ai-research (routes/aiResearch.ts and
 * routes/aiResearchDocuments.ts). Row shapes follow the backend's row
 * schemas in database/rows/ai.ts; JSONB columns whose deep shape changed
 * over time (scope, result, error, policy snapshot) stay unchecked here
 * because the backend narrows them itself.
 */

const CountSchema = z.number().int().nonnegative();
/** A BIGINT column: node-postgres returns a digit string. */
const PgBigintStringSchema = z.string().regex(/^\d+$/);
const RouteSchema = z.enum(["local", "openai-api"]);

/** `GET /api/ai-research/status`. */
export const AiResearchStatusSchema = z.looseObject({
  defaultRoute: z.string(),
  providers: z.array(
    z.looseObject({
      id: z.string(),
      route: RouteSchema,
      status: z.string(),
      models: z.array(z.unknown()),
    }),
  ),
  openai: z.looseObject({
    enabled: z.boolean(),
    model: z.string().nullable(),
    models: z.array(
      z.looseObject({
        id: z.string(),
        label: z.string(),
        inputMicrosPerMillion: z.number(),
        outputMicrosPerMillion: z.number(),
        isDefault: z.boolean(),
      }),
    ),
    storageRequested: z.boolean(),
    hostedToolsEnabled: z.boolean(),
    disclosureModes: z.array(
      z.looseObject({
        id: z.string(),
        capability: z.string(),
        disclosedField: z.string(),
      }),
    ),
    monthlyBudgetMicros: z.number(),
    reversibleReferences: z.looseObject({
      configured: z.boolean(),
      markerSyntax: z.string(),
      classification: z.literal("pseudonymized-not-anonymous"),
    }),
    agentCloakPreflight: z.looseObject({
      enabled: z.boolean(),
      mode: z.enum(["block-on-change", "protect-and-block"]),
      location: z.enum(["operator-managed-loopback", "desktop-loopback"]),
    }),
  }),
  web: z.looseObject({ enabled: z.boolean() }),
  localDocuments: z.looseObject({
    supportedMediaTypes: z.array(z.string()),
    pdfSupported: z.boolean(),
  }),
  orchestration: z.looseObject({}),
});

/** `GET` and `PUT /api/ai-research/agentcloak-desktop`. */
export const AgentCloakDesktopStatusSchema = z.looseObject({
  enabled: z.boolean(),
  available: z.boolean(),
  mappingKeyConfigured: z.boolean(),
  openAiEnabled: z.boolean(),
});

/** aiInvestigationRepository's `COLUMNS` projection. */
export const AiInvestigationSchema = z.looseObject({
  id: z.string(),
  conversationId: z.string().nullable(),
  question: z.string(),
  route: RouteSchema,
  model: z.string().nullable(),
  depth: z.enum(["quick", "detailed"]),
  language: z.enum(["en", "nl"]),
  state: z.string(),
  scope: z.unknown(),
  plan: z.looseObject({}).nullable(),
  checkpoint: z.record(z.string(), z.unknown()),
  result: z.unknown(),
  error: z.unknown(),
  grantId: z.string().nullable(),
  cancelRequestedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `GET /api/ai-research/investigations/:id` — the job plus its steps. */
export const AiInvestigationDetailSchema = AiInvestigationSchema.extend({
  steps: z.array(
    z.looseObject({
      stepId: z.string(),
      state: z.string(),
      attempt: CountSchema,
      result: z.unknown(),
      error: z.unknown(),
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
    }),
  ),
});

/** `POST /api/ai-research/disclosures/preview`. */
export const AiDisclosurePreviewSchema = z.looseObject({
  payload: z.record(z.string(), z.unknown()),
  payloadSha256: z.string(),
  payloadBytes: CountSchema,
  inputCharacters: CountSchema,
  fieldManifest: z.array(z.string()),
  disclosureUnits: z.array(z.string()),
  referenceScope: z
    .looseObject({ id: z.string(), expiresAt: z.string(), count: CountSchema })
    .nullable(),
  outboundRequest: z.looseObject({}),
  agentCloakPreflight: z.looseObject({ enabled: z.boolean() }),
});

/** An `ai_disclosure_grants` row (`SELECT *` / `RETURNING *`). */
export const AiDisclosureGrantSchema = z.looseObject({
  id: z.string(),
  route: z.string(),
  mode: z.string(),
  purpose: z.string(),
  preview_payload_sha256: z.string(),
  allowed_fields_json: z.array(z.string()),
  max_requests: CountSchema,
  max_input_characters: CountSchema,
  max_output_tokens: CountSchema,
  max_cost_micros: PgBigintStringSchema,
  max_disclosure_units: CountSchema,
  used_requests: CountSchema,
  used_input_characters: PgBigintStringSchema,
  used_output_tokens: PgBigintStringSchema,
  used_cost_micros: PgBigintStringSchema,
  policy_version: z.number().int(),
  retain_exact_payload: z.boolean(),
  expires_at: z.string(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** `GET /api/ai-research/disclosures/grants` — `{items, total}`. */
export const AiDisclosureGrantListSchema = z.looseObject({
  items: z.array(AiDisclosureGrantSchema),
  total: CountSchema,
});

/** An `ai_disclosure_records` row (`SELECT *`). */
export const AiDisclosureRecordSchema = z.looseObject({
  id: z.string(),
  grant_id: z.string(),
  job_id: z.string().nullable(),
  route: z.string(),
  mode: z.string(),
  purpose: z.string(),
  field_manifest_json: z.array(z.string()),
  disclosure_units_json: z.array(z.string()),
  payload_sha256: z.string(),
  payload_bytes: CountSchema,
  reserved_output_tokens: CountSchema,
  reserved_cost_micros: PgBigintStringSchema,
  actual_input_tokens: CountSchema.nullable(),
  actual_output_tokens: CountSchema.nullable(),
  actual_cost_micros: PgBigintStringSchema.nullable(),
  status: z.string(),
  provider_request_id: z.string().nullable(),
  policy_snapshot_json: z.unknown(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

/** `GET /api/ai-research/disclosures/records` — `{items, total}`. */
export const AiDisclosureRecordListSchema = z.looseObject({
  items: z.array(AiDisclosureRecordSchema),
  total: CountSchema,
});

/** `POST /api/ai-research/disclosures/grants/:id/revoke`. */
export const AiDisclosureRevokeSchema = z.looseObject({
  revoked: z.literal(true),
});

/** `DELETE /api/ai-research/disclosures/records`. */
export const AiDisclosureDeleteSchema = z.looseObject({
  deleted: z.looseObject({ records: CountSchema, grants: CountSchema }),
});

/** aiResearchDocumentRepository's `DOCUMENT_COLUMNS`. */
export const ResearchDocumentSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  sourceName: z.string(),
  mediaType: z.string(),
  contentSha256: z.string(),
  version: z.number().int().positive(),
  extractionStatus: z.enum(["ready", "failed", "unsupported"]),
  extractionError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `GET /api/ai-research/documents` — `{items, total}`. */
export const ResearchDocumentListSchema = z.looseObject({
  items: z.array(ResearchDocumentSchema),
  total: CountSchema,
});
