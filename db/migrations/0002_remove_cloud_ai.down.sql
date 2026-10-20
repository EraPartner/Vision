-- Restores the empty schema 0002_remove_cloud_ai dropped. Deleted rows (cloud jobs, disclosure
-- grants and records, reference scopes, the AgentCloak preference) cannot be restored.

CREATE TABLE "public"."ai_disclosure_grants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route" "text" NOT NULL,
    "mode" "text" NOT NULL,
    "purpose" "text" NOT NULL,
    "preview_payload_sha256" "text" NOT NULL,
    "allowed_fields_json" "jsonb" NOT NULL,
    "max_requests" integer NOT NULL,
    "max_input_characters" integer NOT NULL,
    "max_output_tokens" integer NOT NULL,
    "max_cost_micros" bigint NOT NULL,
    "max_disclosure_units" integer NOT NULL,
    "used_requests" integer DEFAULT 0 NOT NULL,
    "used_input_characters" bigint DEFAULT 0 NOT NULL,
    "used_output_tokens" bigint DEFAULT 0 NOT NULL,
    "used_cost_micros" bigint DEFAULT 0 NOT NULL,
    "policy_version" integer DEFAULT 1 NOT NULL,
    "retain_exact_payload" boolean DEFAULT false NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_disclosure_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_disclosure_grants_max_cost_micros_check" CHECK (("max_cost_micros" >= 0)),
    CONSTRAINT "ai_disclosure_grants_max_disclosure_units_check" CHECK ((("max_disclosure_units" >= 1) AND ("max_disclosure_units" <= 10000))),
    CONSTRAINT "ai_disclosure_grants_max_input_characters_check" CHECK ((("max_input_characters" >= 100) AND ("max_input_characters" <= 200000))),
    CONSTRAINT "ai_disclosure_grants_max_output_tokens_check" CHECK ((("max_output_tokens" >= 64) AND ("max_output_tokens" <= 32000))),
    CONSTRAINT "ai_disclosure_grants_max_requests_check" CHECK ((("max_requests" >= 1) AND ("max_requests" <= 50))),
    CONSTRAINT "ai_disclosure_grants_mode_check" CHECK (("mode" = ANY (ARRAY['cloud-plan-public'::"text", 'selected-summary'::"text", 'cloud-synthesis-selected'::"text"]))),
    CONSTRAINT "ai_disclosure_grants_preview_payload_sha256_check" CHECK (("preview_payload_sha256" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "ai_disclosure_grants_purpose_check" CHECK ((("length"("purpose") >= 1) AND ("length"("purpose") <= 500))),
    CONSTRAINT "ai_disclosure_grants_retain_exact_payload_check" CHECK (("retain_exact_payload" = false)),
    CONSTRAINT "ai_disclosure_grants_route_check" CHECK (("route" = 'openai-api'::"text")),
    CONSTRAINT "ai_disclosure_grants_used_cost_micros_check" CHECK (("used_cost_micros" >= 0)),
    CONSTRAINT "ai_disclosure_grants_used_input_characters_check" CHECK (("used_input_characters" >= 0)),
    CONSTRAINT "ai_disclosure_grants_used_output_tokens_check" CHECK (("used_output_tokens" >= 0)),
    CONSTRAINT "ai_disclosure_grants_used_requests_check" CHECK (("used_requests" >= 0))
);

CREATE TABLE "public"."ai_disclosure_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "grant_id" "uuid" NOT NULL,
    "job_id" "uuid",
    "route" "text" NOT NULL,
    "mode" "text" NOT NULL,
    "purpose" "text" NOT NULL,
    "field_manifest_json" "jsonb" NOT NULL,
    "disclosure_units_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "payload_sha256" "text" NOT NULL,
    "payload_bytes" integer NOT NULL,
    "reserved_output_tokens" integer NOT NULL,
    "reserved_cost_micros" bigint NOT NULL,
    "actual_input_tokens" integer,
    "actual_output_tokens" integer,
    "actual_cost_micros" bigint,
    "status" "text" NOT NULL,
    "provider_request_id" "text",
    "policy_snapshot_json" "jsonb" NOT NULL,
    "error_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "ai_disclosure_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_disclosure_records_payload_bytes_check" CHECK (("payload_bytes" >= 0)),
    CONSTRAINT "ai_disclosure_records_payload_sha256_check" CHECK (("payload_sha256" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "ai_disclosure_records_reserved_cost_micros_check" CHECK (("reserved_cost_micros" >= 0)),
    CONSTRAINT "ai_disclosure_records_reserved_output_tokens_check" CHECK (("reserved_output_tokens" >= 0)),
    CONSTRAINT "ai_disclosure_records_status_check" CHECK (("status" = ANY (ARRAY['authorized'::"text", 'sent'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text", 'blocked'::"text"]))),
    CONSTRAINT "ai_disclosure_records_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "public"."ai_disclosure_grants"("id") ON DELETE CASCADE,
    CONSTRAINT "ai_disclosure_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_investigation_jobs"("id") ON DELETE SET NULL
);
CREATE INDEX "idx_ai_disclosure_records_grant_created" ON "public"."ai_disclosure_records" USING "btree" ("grant_id", "created_at" DESC);
CREATE INDEX "idx_ai_disclosure_records_job_created" ON "public"."ai_disclosure_records" USING "btree" ("job_id", "created_at" DESC);

CREATE TABLE "public"."ai_reference_scopes" (
    "id" "uuid" NOT NULL,
    "job_id" "uuid",
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "claimed_at" timestamp with time zone,
    CONSTRAINT "ai_reference_scopes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_reference_scopes_job_id_key" UNIQUE ("job_id"),
    CONSTRAINT "ai_reference_scopes_check" CHECK ((("job_id" IS NULL) = ("claimed_at" IS NULL))),
    CONSTRAINT "ai_reference_scopes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_investigation_jobs"("id") ON DELETE CASCADE
);
CREATE INDEX "idx_ai_reference_scopes_expiry" ON "public"."ai_reference_scopes" USING "btree" ("expires_at");

CREATE TABLE "public"."ai_reference_entries" (
    "scope_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "reference_type" "text" NOT NULL,
    "ciphertext" "bytea" NOT NULL,
    "nonce" "bytea" NOT NULL,
    "auth_tag" "bytea" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_reference_entries_pkey" PRIMARY KEY ("scope_id", "token"),
    CONSTRAINT "ai_reference_entries_token_key" UNIQUE ("token"),
    CONSTRAINT "ai_reference_entries_auth_tag_check" CHECK (("octet_length"("auth_tag") = 16)),
    CONSTRAINT "ai_reference_entries_nonce_check" CHECK (("octet_length"("nonce") = 12)),
    CONSTRAINT "ai_reference_entries_reference_type_check" CHECK (("reference_type" = ANY (ARRAY['account'::"text", 'recipient'::"text", 'investment'::"text", 'holding'::"text", 'category'::"text", 'document'::"text", 'subject'::"text", 'amount'::"text", 'date'::"text"]))),
    CONSTRAINT "ai_reference_entries_token_check" CHECK (("token" ~ '^\[\[VR1:(account|recipient|investment|holding|category|document|subject|amount|date):[A-Za-z0-9_-]{24}\]\]$'::"text")),
    CONSTRAINT "ai_reference_entries_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "public"."ai_reference_scopes"("id") ON DELETE CASCADE
);

ALTER TABLE "public"."ai_investigation_jobs"
    ADD COLUMN "grant_id" "uuid",
    ADD CONSTRAINT "fk_ai_investigation_jobs_grant" FOREIGN KEY ("grant_id") REFERENCES "public"."ai_disclosure_grants"("id") ON DELETE SET NULL,
    DROP CONSTRAINT "ai_investigation_jobs_route_check",
    ADD CONSTRAINT "ai_investigation_jobs_route_check" CHECK (("route" = ANY (ARRAY['local'::"text", 'openai-api'::"text"])));
