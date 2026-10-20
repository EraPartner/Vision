-- Restores the empty schema 0004_remove_audit_history dropped, with the definitions from
-- 0001_baseline.sql. Chain entries, checkpoints and the database editor, split and broker re-tag
-- change records cannot be restored. The chain head is reset to its empty genesis state.

CREATE FUNCTION "public"."audit_chain_prune_prefix"("p_through" bigint, "p_hash" character) RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $_$
        DECLARE
          current_head RECORD;
          earliest BIGINT;
          boundary_hash CHAR(64);
          deleted_count BIGINT;
        BEGIN
          SELECT last_sequence, last_hash INTO current_head
            FROM public.audit_chain_head WHERE singleton = true FOR UPDATE;
          IF NOT FOUND OR p_through IS NULL OR p_through < 1 OR
             p_through >= current_head.last_sequence OR
             p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
            RAISE EXCEPTION 'invalid audit retention boundary';
          END IF;
          SELECT min(sequence) INTO earliest FROM public.audit_chain_entries;
          IF earliest IS NULL OR earliest > p_through + 1 THEN
            RAISE EXCEPTION 'audit retention prefix is incomplete';
          END IF;
          IF earliest = p_through + 1 THEN
            IF NOT EXISTS (
              SELECT 1 FROM public.audit_chain_entries
               WHERE sequence = earliest AND previous_hash = p_hash
            ) THEN
              RAISE EXCEPTION 'audit retention boundary hash changed';
            END IF;
            RETURN 0;
          END IF;
          SELECT entry_hash INTO boundary_hash FROM public.audit_chain_entries
           WHERE sequence = p_through;
          IF boundary_hash IS DISTINCT FROM p_hash OR
             (SELECT count(*) FROM public.audit_chain_entries
               WHERE sequence BETWEEN earliest AND p_through)
               <> p_through - earliest + 1 OR
             EXISTS (SELECT 1 FROM public.audit_chain_entries
               WHERE sequence BETWEEN earliest AND p_through
                 AND created_at >= now() - interval '1 year') OR
             NOT EXISTS (SELECT 1 FROM public.audit_chain_checkpoints
               WHERE sequence >= p_through
                 AND anchor_kind = 'macos_keychain_witness_hmac_v3') THEN
            RAISE EXCEPTION 'audit retention prefix is not eligible';
          END IF;
          ALTER TABLE public.audit_chain_entries DISABLE TRIGGER audit_chain_entries_immutable;
          DELETE FROM public.audit_chain_entries WHERE sequence <= p_through;
          GET DIAGNOSTICS deleted_count = ROW_COUNT;
          ALTER TABLE public.audit_chain_entries ENABLE TRIGGER audit_chain_entries_immutable;
          IF deleted_count <> p_through - earliest + 1 OR
             NOT EXISTS (SELECT 1 FROM public.audit_chain_entries
               WHERE sequence = p_through + 1 AND previous_hash = p_hash) THEN
            RAISE EXCEPTION 'audit retention successor is invalid';
          END IF;
          RETURN deleted_count;
        END;
        $_$;

CREATE FUNCTION "public"."audit_chain_reject_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        BEGIN
            RAISE EXCEPTION 'audit chain history is append-only';
        END $$;

CREATE TABLE "public"."audit_chain_checkpoints" (
    "id" bigint NOT NULL,
    "sequence" bigint NOT NULL,
    "head_hash" character(64) NOT NULL,
    "anchor_kind" "text" NOT NULL,
    "receipt_id" "text" NOT NULL,
    "receipt_hash" character(64) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_chain_checkpoints_anchor_kind_check" CHECK ((("length"("anchor_kind") >= 1) AND ("length"("anchor_kind") <= 100))),
    CONSTRAINT "audit_chain_checkpoints_head_hash_check" CHECK (("head_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "audit_chain_checkpoints_receipt_hash_check" CHECK (("receipt_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "audit_chain_checkpoints_receipt_id_check" CHECK ((("length"("receipt_id") >= 1) AND ("length"("receipt_id") <= 300))),
    CONSTRAINT "audit_chain_checkpoints_sequence_check" CHECK (("sequence" >= 0)),
    CONSTRAINT "audit_chain_checkpoints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_chain_checkpoints_anchor_kind_receipt_id_key" UNIQUE ("anchor_kind", "receipt_id")
);
ALTER TABLE "public"."audit_chain_checkpoints" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."audit_chain_checkpoints_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE INDEX "idx_audit_chain_checkpoints_sequence" ON "public"."audit_chain_checkpoints" USING "btree" ("sequence" DESC, "id" DESC);

CREATE TABLE "public"."audit_chain_entries" (
    "sequence" bigint NOT NULL,
    "version" smallint NOT NULL,
    "previous_hash" character(64) NOT NULL,
    "entry_hash" character(64) NOT NULL,
    "payload" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_chain_entries_entry_hash_check" CHECK (("entry_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "audit_chain_entries_payload_check" CHECK (("jsonb_typeof"("payload") = 'object'::"text")),
    CONSTRAINT "audit_chain_entries_previous_hash_check" CHECK (("previous_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "audit_chain_entries_sequence_check" CHECK (("sequence" > 0)),
    CONSTRAINT "audit_chain_entries_version_check" CHECK (("version" > 0)),
    CONSTRAINT "audit_chain_entries_pkey" PRIMARY KEY ("sequence")
);
CREATE INDEX "idx_audit_chain_entries_created_at" ON "public"."audit_chain_entries" USING "btree" ("created_at", "sequence");

CREATE TABLE "public"."audit_chain_head" (
    "singleton" boolean DEFAULT true NOT NULL,
    "last_sequence" bigint DEFAULT 0 NOT NULL,
    "last_hash" character(64) DEFAULT "repeat"('0'::"text", 64) NOT NULL,
    "legacy_db_editor_max_id" bigint NOT NULL,
    "legacy_split_max_id" bigint NOT NULL,
    "legacy_retag_max_id" bigint NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_chain_head_check" CHECK ((("last_sequence" <> 0) OR (("last_hash")::"text" = "repeat"('0'::"text", 64)))),
    CONSTRAINT "audit_chain_head_last_hash_check" CHECK (("last_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "audit_chain_head_last_sequence_check" CHECK (("last_sequence" >= 0)),
    CONSTRAINT "audit_chain_head_legacy_db_editor_max_id_check" CHECK (("legacy_db_editor_max_id" >= 0)),
    CONSTRAINT "audit_chain_head_legacy_retag_max_id_check" CHECK (("legacy_retag_max_id" >= 0)),
    CONSTRAINT "audit_chain_head_legacy_split_max_id_check" CHECK (("legacy_split_max_id" >= 0)),
    CONSTRAINT "audit_chain_head_singleton_check" CHECK ("singleton"),
    CONSTRAINT "audit_chain_head_pkey" PRIMARY KEY ("singleton")
);
INSERT INTO "public"."audit_chain_head" ("singleton", "last_sequence", "legacy_db_editor_max_id", "legacy_split_max_id", "legacy_retag_max_id")
    VALUES (true, 0, 0, 0, 0);

CREATE TRIGGER "audit_chain_checkpoints_immutable" BEFORE DELETE OR UPDATE OR TRUNCATE ON "public"."audit_chain_checkpoints" FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_chain_reject_mutation"();
CREATE TRIGGER "audit_chain_entries_immutable" BEFORE DELETE OR UPDATE OR TRUNCATE ON "public"."audit_chain_entries" FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_chain_reject_mutation"();
CREATE TRIGGER "audit_chain_head_no_delete" BEFORE DELETE OR TRUNCATE ON "public"."audit_chain_head" FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_chain_reject_mutation"();

CREATE TABLE "public"."db_editor_audit" (
    "id" bigint NOT NULL,
    "table_name" "text" NOT NULL,
    "op" "text" NOT NULL,
    "pk_json" "jsonb",
    "before_json" "jsonb",
    "after_json" "jsonb",
    "statement" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "db_editor_audit_op_check" CHECK (("op" = ANY (ARRAY['insert'::"text", 'update'::"text", 'delete'::"text"]))),
    CONSTRAINT "db_editor_audit_pkey" PRIMARY KEY ("id")
);
CREATE SEQUENCE "public"."db_editor_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE "public"."db_editor_audit_id_seq" OWNED BY "public"."db_editor_audit"."id";
ALTER TABLE ONLY "public"."db_editor_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."db_editor_audit_id_seq"'::"regclass");
CREATE INDEX "idx_db_editor_audit_table_time" ON "public"."db_editor_audit" USING "btree" ("table_name", "created_at" DESC);

CREATE TABLE "public"."split_audit" (
    "id" bigint NOT NULL,
    "split_id" integer,
    "action" character varying(50) NOT NULL,
    "actor" "text",
    "payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "split_audit_pkey" PRIMARY KEY ("id")
);
CREATE SEQUENCE "public"."split_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE "public"."split_audit_id_seq" OWNED BY "public"."split_audit"."id";
ALTER TABLE ONLY "public"."split_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."split_audit_id_seq"'::"regclass");
CREATE INDEX "idx_split_audit_split_id" ON "public"."split_audit" USING "btree" ("split_id");

CREATE TABLE "public"."portfolio_retag_audit" (
    "id" bigint NOT NULL,
    "idempotency_key" "uuid" NOT NULL,
    "request_fingerprint" character(64) NOT NULL,
    "from_account_id" integer,
    "to_account_id" integer,
    "transaction_ids" "jsonb" NOT NULL,
    "previous_assignments" "jsonb" NOT NULL,
    "selected_count" integer NOT NULL,
    "changed_count" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_portfolio_retag_audit_changed_count" CHECK ((("changed_count" >= 0) AND ("changed_count" <= "selected_count"))),
    CONSTRAINT "chk_portfolio_retag_audit_selected_count" CHECK (("selected_count" > 0)),
    CONSTRAINT "chk_portfolio_retag_previous_assignments_array" CHECK (("jsonb_typeof"("previous_assignments") = 'array'::"text")),
    CONSTRAINT "chk_portfolio_retag_transaction_ids_array" CHECK (("jsonb_typeof"("transaction_ids") = 'array'::"text")),
    CONSTRAINT "portfolio_retag_audit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uq_portfolio_retag_audit_idempotency_key" UNIQUE ("idempotency_key")
);
CREATE SEQUENCE "public"."portfolio_retag_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE "public"."portfolio_retag_audit_id_seq" OWNED BY "public"."portfolio_retag_audit"."id";
ALTER TABLE ONLY "public"."portfolio_retag_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."portfolio_retag_audit_id_seq"'::"regclass");
