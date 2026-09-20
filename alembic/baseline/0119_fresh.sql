-- Vision reviewed PostgreSQL 18 fresh-install baseline.
-- Generated from a disposable 0118 database after all six guarded manual contracts.
-- Historical migration files remain available for existing-install upgrades.
--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: vision_analysis; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA "vision_analysis";


--
-- Name: SCHEMA "vision_analysis"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "vision_analysis" IS 'Versioned local financial datasets; grant SELECT only to the isolated analysis executor role.';


--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "public";


--
-- Name: EXTENSION "pg_stat_statements"; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";


--
-- Name: EXTENSION "pg_trgm"; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "public";


--
-- Name: EXTENSION "pgcrypto"; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: account_liquidity_class; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."account_liquidity_class" AS ENUM (
    'liquid',
    'semi_liquid',
    'illiquid'
);


--
-- Name: account_owner; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."account_owner" AS ENUM (
    'me',
    'partner',
    'joint'
);


--
-- Name: account_tax_wrapper; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."account_tax_wrapper" AS ENUM (
    'none',
    'pension',
    'tax_advantaged'
);


--
-- Name: account_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."account_type" AS ENUM (
    'checking',
    'savings',
    'brokerage',
    'crypto_exchange',
    'wallet',
    'pension',
    'liability'
);


--
-- Name: asset_class; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."asset_class" AS ENUM (
    'stock',
    'etf',
    'crypto',
    'metals',
    'real_estate',
    'savings',
    'bond'
);


--
-- Name: portfolio_txn_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."portfolio_txn_type" AS ENUM (
    'buy',
    'sell',
    'dividend',
    'fee',
    'tax',
    'interest',
    'rent_income',
    'appreciation',
    'gift',
    'split',
    'merger',
    'spinoff',
    'return_of_capital'
);


--
-- Name: price_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."price_provider" AS ENUM (
    'manual',
    'binance',
    'yahoo',
    'custom',
    'kinesis'
);


--
-- Name: revolut_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."revolut_state" AS ENUM (
    'COMPLETED',
    'PENDING',
    'REVERTED',
    'DECLINED'
);


--
-- Name: audit_chain_prune_prefix(bigint, character); Type: FUNCTION; Schema: public; Owner: -
--

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


--
-- Name: audit_chain_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."audit_chain_reject_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        BEGIN
            RAISE EXCEPTION 'audit chain history is append-only';
        END $$;


--
-- Name: category_assert_acyclic(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."category_assert_acyclic"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        BEGIN
          IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
          PERFORM pg_advisory_xact_lock(1128356178, 1);
          IF EXISTS (
            WITH RECURSIVE ancestors(id, parent_id) AS (
              SELECT id, parent_id FROM categories WHERE id = NEW.parent_id
              UNION ALL
              SELECT p.id, p.parent_id
              FROM categories p JOIN ancestors a ON p.id = a.parent_id
            )
            SELECT 1 FROM ancestors WHERE id = NEW.id
          ) THEN
            RAISE EXCEPTION 'Category hierarchy cycle is not allowed'
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END $$;


--
-- Name: category_refresh_path_names(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."category_refresh_path_names"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        BEGIN
          WITH RECURSIVE affected(id, path_name) AS (
            SELECT NEW.id,
                   CASE WHEN NEW.parent_id IS NULL THEN NEW.name
                        ELSE parent.path_name || ':' || NEW.name END
            FROM (SELECT 1) AS seed
            LEFT JOIN categories parent ON parent.id = NEW.parent_id
            UNION ALL
            SELECT child.id, affected.path_name || ':' || child.name
            FROM categories child JOIN affected ON child.parent_id = affected.id
          )
          UPDATE categories c SET path_name=affected.path_name
          FROM affected WHERE c.id=affected.id;
          RETURN NEW;
        END $$;


--
-- Name: category_sync_legacy_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."category_sync_legacy_row"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        DECLARE root_id INTEGER;
        BEGIN
          IF NOT NEW.legacy_compatible THEN RETURN NEW; END IF;
          IF NEW.general IS NULL OR btrim(NEW.general) = ''
             OR NEW.detail IS NULL OR btrim(NEW.detail) = '' THEN
            RAISE EXCEPTION 'Legacy categories require general and detail'
              USING ERRCODE = 'check_violation';
          END IF;
          IF EXISTS (SELECT 1 FROM category_merge_aliases
                     WHERE general=NEW.general AND detail=NEW.detail) THEN
            RAISE EXCEPTION 'Merged legacy category must be resolved through its alias'
              USING ERRCODE = 'check_violation';
          END IF;
          SELECT id INTO root_id FROM categories
          WHERE parent_id IS NULL AND name = NEW.general;
          IF root_id IS NULL THEN
            SELECT target_category_id INTO root_id FROM category_root_aliases
            WHERE general = NEW.general;
          END IF;
          IF root_id IS NULL THEN
            INSERT INTO categories
              (general, detail, name, hierarchy_only, legacy_compatible, is_active)
            VALUES (NEW.general, '', NEW.general, true, false, true)
            ON CONFLICT (general, detail) DO NOTHING;
            SELECT id INTO root_id FROM categories
            WHERE parent_id IS NULL AND name = NEW.general;
          END IF;
          IF root_id IS NULL THEN
            RAISE EXCEPTION 'Legacy category root could not be resolved'
              USING ERRCODE = 'check_violation';
          END IF;
          NEW.parent_id := root_id;
          NEW.name := NEW.detail;
          RETURN NEW;
        END $$;


--
-- Name: enforce_split_within_amount(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."enforce_split_within_amount"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        DECLARE split_sum numeric;
        BEGIN
            IF NEW.amount IS DISTINCT FROM OLD.amount THEN
                SELECT COALESCE(SUM(amount), 0) INTO split_sum
                  FROM transaction_splits WHERE transaction_id = NEW.id;
                IF split_sum > ABS(NEW.amount) + 0.005 THEN
                    RAISE EXCEPTION
                        'transaction % amount % is below its split total %',
                        NEW.id, NEW.amount, split_sum
                        USING ERRCODE = 'check_violation';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$;


--
-- Name: fn_agg_split_outstanding_sync(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."fn_agg_split_outstanding_sync"("p_split_id" integer) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
    DECLARE
        v_recipient_id INTEGER;
        v_original NUMERIC(18, 4);
        v_paid NUMERIC(18, 4);
    BEGIN
        SELECT s.recipient_id, s.amount
        INTO v_recipient_id, v_original
        FROM transaction_splits s
        WHERE s.id = p_split_id;

        IF v_recipient_id IS NULL THEN
            DELETE FROM agg_split_outstanding WHERE split_id = p_split_id;
            RETURN;
        END IF;

        SELECT COALESCE(SUM(amount), 0) INTO v_paid
        FROM split_payments
        WHERE split_id = p_split_id;

        INSERT INTO agg_split_outstanding (
            split_id, recipient_id, original_amount, paid_amount,
            outstanding_amount, updated_at
        ) VALUES (
            p_split_id, v_recipient_id, v_original, v_paid,
            v_original - v_paid, NOW()
        )
        ON CONFLICT (split_id) DO UPDATE
        SET recipient_id = EXCLUDED.recipient_id,
            original_amount = EXCLUDED.original_amount,
            paid_amount = EXCLUDED.paid_amount,
            outstanding_amount = EXCLUDED.outstanding_amount,
            updated_at = NOW();
    END;
    $$;


--
-- Name: fn_trg_split_payment_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."fn_trg_split_payment_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                PERFORM fn_agg_split_outstanding_sync(OLD.split_id);
                RETURN OLD;
            END IF;
            PERFORM fn_agg_split_outstanding_sync(NEW.split_id);
            RETURN NEW;
        END;
        $$;


--
-- Name: fn_trg_split_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."fn_trg_split_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                DELETE FROM agg_split_outstanding WHERE split_id = OLD.id;
                RETURN OLD;
            END IF;
            PERFORM fn_agg_split_outstanding_sync(NEW.id);
            RETURN NEW;
        END;
        $$;


--
-- Name: mark_insight_digest_dirty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."mark_insight_digest_dirty"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        BEGIN
          UPDATE insight_digest_state
             SET dirty_version = dirty_version + 1
           WHERE singleton_id = 1;
          RETURN NULL;
        END;
        $$;


--
-- Name: reject_research_dossier_version_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."reject_research_dossier_version_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        BEGIN
            RAISE EXCEPTION 'research dossier versions are immutable';
        END;
        $$;


--
-- Name: reject_saved_analysis_version_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."reject_saved_analysis_version_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
        BEGIN
            RAISE EXCEPTION 'saved analysis definition versions are immutable';
        END;
        $$;


--
-- Name: touch_ai_conversation_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."touch_ai_conversation_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  UPDATE ai_conversations SET updated_at = NOW() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: account_statement_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."account_statement_balances" (
    "account_id" integer NOT NULL,
    "currency" character varying(3) NOT NULL,
    "balance" numeric(18,4) NOT NULL,
    "balance_date" "date" NOT NULL,
    CONSTRAINT "chk_account_statement_balances_currency_iso" CHECK ((("currency")::"text" ~ '^[A-Z]{3}$'::"text"))
);


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."accounts" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "display_name" "text",
    "institution" "text",
    "currency" character varying(3) DEFAULT 'EUR'::character varying NOT NULL,
    "type" "public"."account_type" DEFAULT 'checking'::"public"."account_type" NOT NULL,
    "liquidity_class" "public"."account_liquidity_class" DEFAULT 'liquid'::"public"."account_liquidity_class" NOT NULL,
    "spendable" boolean DEFAULT true NOT NULL,
    "in_net_worth" boolean DEFAULT true NOT NULL,
    "tax_wrapper" "public"."account_tax_wrapper" DEFAULT 'none'::"public"."account_tax_wrapper" NOT NULL,
    "owner" "public"."account_owner" DEFAULT 'me'::"public"."account_owner" NOT NULL,
    "multi_currency_cash" boolean DEFAULT false NOT NULL,
    "has_cash_sleeve" boolean DEFAULT true NOT NULL,
    "funding_account_id" integer,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "import_identity" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "chk_accounts_active_not_closed" CHECK ((("is_active" = false) OR ("closed_at" IS NULL))),
    CONSTRAINT "chk_accounts_currency_iso" CHECK ((("currency")::"text" ~ '^[A-Z]{3}$'::"text"))
);


--
-- Name: accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."accounts_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."accounts_id_seq" OWNED BY "public"."accounts"."id";


--
-- Name: adr109_legacy_cleanup_marker; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."adr109_legacy_cleanup_marker" (
    "singleton" boolean DEFAULT true NOT NULL,
    "completed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "adr109_legacy_cleanup_marker_singleton_check" CHECK ("singleton")
);


--
-- Name: agg_split_outstanding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agg_split_outstanding" (
    "split_id" integer NOT NULL,
    "recipient_id" integer NOT NULL,
    "original_amount" numeric(18,4) NOT NULL,
    "paid_amount" numeric(18,4) DEFAULT 0 NOT NULL,
    "outstanding_amount" numeric(18,4) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: ai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "model" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: ai_disclosure_grants; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: ai_disclosure_records; Type: TABLE; Schema: public; Owner: -
--

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
    CONSTRAINT "ai_disclosure_records_payload_bytes_check" CHECK (("payload_bytes" >= 0)),
    CONSTRAINT "ai_disclosure_records_payload_sha256_check" CHECK (("payload_sha256" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "ai_disclosure_records_reserved_cost_micros_check" CHECK (("reserved_cost_micros" >= 0)),
    CONSTRAINT "ai_disclosure_records_reserved_output_tokens_check" CHECK (("reserved_output_tokens" >= 0)),
    CONSTRAINT "ai_disclosure_records_status_check" CHECK (("status" = ANY (ARRAY['authorized'::"text", 'sent'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text", 'blocked'::"text"])))
);


--
-- Name: ai_investigation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_investigation_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid",
    "question" "text" NOT NULL,
    "route" "text" NOT NULL,
    "model" "text",
    "depth" "text" NOT NULL,
    "language" "text" NOT NULL,
    "state" "text" NOT NULL,
    "scope_json" "jsonb" NOT NULL,
    "plan_json" "jsonb",
    "checkpoint_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "result_json" "jsonb",
    "error_json" "jsonb",
    "grant_id" "uuid",
    "cancel_requested_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_investigation_jobs_depth_check" CHECK (("depth" = ANY (ARRAY['quick'::"text", 'detailed'::"text"]))),
    CONSTRAINT "ai_investigation_jobs_language_check" CHECK (("language" = ANY (ARRAY['en'::"text", 'nl'::"text"]))),
    CONSTRAINT "ai_investigation_jobs_question_check" CHECK ((("length"("question") >= 1) AND ("length"("question") <= 8000))),
    CONSTRAINT "ai_investigation_jobs_route_check" CHECK (("route" = ANY (ARRAY['local'::"text", 'openai-api'::"text"]))),
    CONSTRAINT "ai_investigation_jobs_state_check" CHECK (("state" = ANY (ARRAY['queued'::"text", 'running'::"text", 'waiting'::"text", 'partial'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


--
-- Name: ai_investigation_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_investigation_steps" (
    "job_id" "uuid" NOT NULL,
    "step_id" "text" NOT NULL,
    "state" "text" NOT NULL,
    "attempt" integer DEFAULT 0 NOT NULL,
    "result_json" "jsonb",
    "error_json" "jsonb",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_investigation_steps_attempt_check" CHECK (("attempt" >= 0)),
    CONSTRAINT "ai_investigation_steps_state_check" CHECK (("state" = ANY (ARRAY['pending'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text", 'skipped'::"text"]))),
    CONSTRAINT "ai_investigation_steps_step_id_check" CHECK ((("length"("step_id") >= 1) AND ("length"("step_id") <= 64)))
);


--
-- Name: ai_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text",
    "tool_name" "text",
    "tool_args" "jsonb",
    "tool_result" "jsonb",
    "status" "text" DEFAULT 'complete'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_ai_messages_role" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'tool'::"text", 'system'::"text"]))),
    CONSTRAINT "chk_ai_messages_status" CHECK (("status" = ANY (ARRAY['complete'::"text", 'streaming'::"text", 'aborted'::"text", 'error'::"text"])))
);


--
-- Name: ai_reference_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_reference_entries" (
    "scope_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "reference_type" "text" NOT NULL,
    "ciphertext" "bytea" NOT NULL,
    "nonce" "bytea" NOT NULL,
    "auth_tag" "bytea" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_reference_entries_auth_tag_check" CHECK (("octet_length"("auth_tag") = 16)),
    CONSTRAINT "ai_reference_entries_nonce_check" CHECK (("octet_length"("nonce") = 12)),
    CONSTRAINT "ai_reference_entries_reference_type_check" CHECK (("reference_type" = ANY (ARRAY['account'::"text", 'recipient'::"text", 'investment'::"text", 'holding'::"text", 'category'::"text", 'document'::"text", 'subject'::"text", 'amount'::"text", 'date'::"text"]))),
    CONSTRAINT "ai_reference_entries_token_check" CHECK (("token" ~ '^\[\[VR1:(account|recipient|investment|holding|category|document|subject|amount|date):[A-Za-z0-9_-]{24}\]\]$'::"text"))
);


--
-- Name: ai_reference_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_reference_scopes" (
    "id" "uuid" NOT NULL,
    "job_id" "uuid",
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "claimed_at" timestamp with time zone,
    CONSTRAINT "ai_reference_scopes_check" CHECK ((("job_id" IS NULL) = ("claimed_at" IS NULL)))
);


--
-- Name: ai_research_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_research_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "source_name" "text" NOT NULL,
    "media_type" "text" NOT NULL,
    "content_sha256" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "extraction_status" "text" NOT NULL,
    "extraction_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_research_documents_content_sha256_check" CHECK (("content_sha256" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "ai_research_documents_extraction_status_check" CHECK (("extraction_status" = ANY (ARRAY['ready'::"text", 'failed'::"text", 'unsupported'::"text"]))),
    CONSTRAINT "ai_research_documents_source_name_check" CHECK ((("length"("source_name") >= 1) AND ("length"("source_name") <= 500))),
    CONSTRAINT "ai_research_documents_title_check" CHECK ((("length"("title") >= 1) AND ("length"("title") <= 300))),
    CONSTRAINT "ai_research_documents_version_check" CHECK (("version" > 0))
);


--
-- Name: ai_research_passages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_research_passages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "ordinal" integer NOT NULL,
    "page_number" integer,
    "section" "text",
    "content" "text" NOT NULL,
    "embedding_json" "jsonb",
    "search_vector" "tsvector" GENERATED ALWAYS AS ("to_tsvector"('"simple"'::"regconfig", ((COALESCE("section", ''::"text") || ' '::"text") || "content"))) STORED,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_research_passages_content_check" CHECK ((("length"("content") >= 1) AND ("length"("content") <= 12000))),
    CONSTRAINT "ai_research_passages_ordinal_check" CHECK (("ordinal" >= 0)),
    CONSTRAINT "ai_research_passages_page_number_check" CHECK (("page_number" > 0))
);


--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."alembic_version" (
    "version_num" character varying(64) NOT NULL
);


--
-- Name: analysis_monitor_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."analysis_monitor_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "monitor_id" "uuid" NOT NULL,
    "observation_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "title" "text" NOT NULL,
    "reason_code" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "previous_value" "text",
    "current_value" "text",
    "episode_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "read_at" timestamp with time zone,
    CONSTRAINT "analysis_monitor_notifications_kind_check" CHECK (("kind" = ANY (ARRAY['analysis-threshold'::"text", 'dossier-evidence'::"text"])))
);


--
-- Name: analysis_monitor_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."analysis_monitor_observations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "monitor_id" "uuid" NOT NULL,
    "status" "text" NOT NULL,
    "previous_value" "text",
    "current_value" "text",
    "previous_evidence_version" integer,
    "current_evidence_version" integer,
    "evidence_hash" "text",
    "condition_revision" integer NOT NULL,
    "analysis_definition_version" integer,
    "analysis_run_id" "text",
    "historical_analysis_run_id" "text",
    "analysis_run_status" "text",
    "analysis_window_json" "jsonb",
    "coverage_json" "jsonb" DEFAULT '{"status": "unknown"}'::"jsonb" NOT NULL,
    "reason_code" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "analysis_monitor_observations_check" CHECK (((("status" = ANY (ARRAY['baseline'::"text", 'unchanged'::"text", 'triggered'::"text", 'cooldown-pending'::"text"])) AND (("current_value" IS NOT NULL) OR ("evidence_hash" IS NOT NULL))) OR ("status" = ANY (ARRAY['partial'::"text", 'stale'::"text", 'failed'::"text"])))),
    CONSTRAINT "analysis_monitor_observations_condition_revision_check" CHECK (("condition_revision" > 0)),
    CONSTRAINT "analysis_monitor_observations_coverage_json_check" CHECK (("jsonb_typeof"("coverage_json") = 'object'::"text")),
    CONSTRAINT "analysis_monitor_observations_reason_check" CHECK ((("length"("reason") >= 1) AND ("length"("reason") <= 1000))),
    CONSTRAINT "analysis_monitor_observations_status_check" CHECK (("status" = ANY (ARRAY['baseline'::"text", 'unchanged'::"text", 'triggered'::"text", 'cooldown-pending'::"text", 'partial'::"text", 'stale'::"text", 'failed'::"text"])))
);


--
-- Name: analysis_monitors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."analysis_monitors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kind" "text" NOT NULL,
    "title" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "saved_analysis_id" "text",
    "dossier_id" "uuid",
    "historical_target_id" "text" NOT NULL,
    "target_label" "text" NOT NULL,
    "field_id" "text",
    "operator" "text",
    "threshold" numeric,
    "interval_minutes" integer DEFAULT 1440 NOT NULL,
    "cooldown_minutes" integer DEFAULT 1440 NOT NULL,
    "next_due_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_checked_at" timestamp with time zone,
    "last_status" "text",
    "condition_revision" integer DEFAULT 1 NOT NULL,
    "active_episode_key" "uuid",
    "pending_signature" "text",
    "pending_since" timestamp with time zone,
    "last_notified_at" timestamp with time zone,
    "lease_token" "uuid",
    "lease_expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "analysis_monitors_check" CHECK ((("lease_token" IS NULL) = ("lease_expires_at" IS NULL))),
    CONSTRAINT "analysis_monitors_check1" CHECK (((("kind" = 'analysis-threshold'::"text") AND ("dossier_id" IS NULL) AND ("field_id" IS NOT NULL) AND (("length"("field_id") >= 1) AND ("length"("field_id") <= 100)) AND ("operator" IS NOT NULL) AND ("threshold" IS NOT NULL)) OR (("kind" = 'dossier-evidence'::"text") AND ("saved_analysis_id" IS NULL) AND ("field_id" IS NULL) AND ("operator" IS NULL) AND ("threshold" IS NULL)))),
    CONSTRAINT "analysis_monitors_condition_revision_check" CHECK (("condition_revision" > 0)),
    CONSTRAINT "analysis_monitors_cooldown_minutes_check" CHECK ((("cooldown_minutes" >= 0) AND ("cooldown_minutes" <= 10080))),
    CONSTRAINT "analysis_monitors_historical_target_id_check" CHECK ((("length"("historical_target_id") >= 1) AND ("length"("historical_target_id") <= 100))),
    CONSTRAINT "analysis_monitors_interval_minutes_check" CHECK ((("interval_minutes" >= 15) AND ("interval_minutes" <= 10080))),
    CONSTRAINT "analysis_monitors_kind_check" CHECK (("kind" = ANY (ARRAY['analysis-threshold'::"text", 'dossier-evidence'::"text"]))),
    CONSTRAINT "analysis_monitors_operator_check" CHECK (("operator" = ANY (ARRAY['above'::"text", 'below'::"text"]))),
    CONSTRAINT "analysis_monitors_target_label_check" CHECK ((("length"("target_label") >= 1) AND ("length"("target_label") <= 300))),
    CONSTRAINT "analysis_monitors_title_check" CHECK ((("length"("title") >= 1) AND ("length"("title") <= 200)))
);


--
-- Name: asset_price_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."asset_price_history" (
    "id" integer NOT NULL,
    "investment_id" integer NOT NULL,
    "price_date" "date" NOT NULL,
    "close_price" numeric(18,6) NOT NULL,
    "source" character varying(50) DEFAULT 'provider'::character varying NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: asset_price_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."asset_price_history_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_price_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."asset_price_history_id_seq" OWNED BY "public"."asset_price_history"."id";


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."attachments" (
    "id" bigint NOT NULL,
    "transaction_id" integer NOT NULL,
    "filename" "text" NOT NULL,
    "stored_path" "text" NOT NULL,
    "mime_type" "text" NOT NULL,
    "size_bytes" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."attachments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."attachments_id_seq" OWNED BY "public"."attachments"."id";


--
-- Name: audit_chain_checkpoints; Type: TABLE; Schema: public; Owner: -
--

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
    CONSTRAINT "audit_chain_checkpoints_sequence_check" CHECK (("sequence" >= 0))
);


--
-- Name: audit_chain_checkpoints_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE "public"."audit_chain_checkpoints" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."audit_chain_checkpoints_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit_chain_entries; Type: TABLE; Schema: public; Owner: -
--

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
    CONSTRAINT "audit_chain_entries_version_check" CHECK (("version" > 0))
);


--
-- Name: audit_chain_head; Type: TABLE; Schema: public; Owner: -
--

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
    CONSTRAINT "audit_chain_head_singleton_check" CHECK ("singleton")
);


--
-- Name: belgian_inflation_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."belgian_inflation_rates" (
    "id" integer NOT NULL,
    "month_date" "date" NOT NULL,
    "monthly_rate" numeric(10,8) NOT NULL,
    "source" character varying(50) DEFAULT 'statbel'::character varying NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: belgian_inflation_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."belgian_inflation_rates_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: belgian_inflation_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."belgian_inflation_rates_id_seq" OWNED BY "public"."belgian_inflation_rates"."id";


--
-- Name: cashflow_forecast_accuracy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cashflow_forecast_accuracy" (
    "id" integer NOT NULL,
    "user_id" "text" DEFAULT 'anonymous'::"text" NOT NULL,
    "method_id" "text" NOT NULL,
    "as_of_month" "date" NOT NULL,
    "mae" double precision,
    "rmse" double precision,
    "mape" double precision,
    "sample_days" integer,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cashflow_forecast_accuracy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."cashflow_forecast_accuracy_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cashflow_forecast_accuracy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."cashflow_forecast_accuracy_id_seq" OWNED BY "public"."cashflow_forecast_accuracy"."id";


--
-- Name: cashflow_forecast_mc; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cashflow_forecast_mc" (
    "id" integer NOT NULL,
    "user_id" "text" DEFAULT 'anonymous'::"text" NOT NULL,
    "month" "date" NOT NULL,
    "filter_hash" "text" NOT NULL,
    "mc_paths" integer DEFAULT 1000 NOT NULL,
    "payload" "jsonb" NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cashflow_forecast_mc_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."cashflow_forecast_mc_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cashflow_forecast_mc_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."cashflow_forecast_mc_id_seq" OWNED BY "public"."cashflow_forecast_mc"."id";


--
-- Name: cashflow_forecast_mc_rolling; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cashflow_forecast_mc_rolling" (
    "id" integer NOT NULL,
    "user_id" "text" DEFAULT 'anonymous'::"text" NOT NULL,
    "today_iso" "date" NOT NULL,
    "days_back" integer NOT NULL,
    "days_forward" integer NOT NULL,
    "filter_hash" "text" NOT NULL,
    "mc_paths" integer DEFAULT 1000 NOT NULL,
    "payload" "jsonb" NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cashflow_forecast_mc_rolling_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."cashflow_forecast_mc_rolling_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cashflow_forecast_mc_rolling_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."cashflow_forecast_mc_rolling_id_seq" OWNED BY "public"."cashflow_forecast_mc_rolling"."id";


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."categories" (
    "id" integer NOT NULL,
    "general" "text" NOT NULL,
    "detail" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "parent_id" integer,
    "name" "text" NOT NULL,
    "hierarchy_only" boolean DEFAULT false NOT NULL,
    "legacy_compatible" boolean DEFAULT true NOT NULL,
    "path_name" "text" DEFAULT ''::"text" NOT NULL,
    CONSTRAINT "ck_categories_hierarchy_only_not_legacy" CHECK (((NOT "hierarchy_only") OR (NOT "legacy_compatible"))),
    CONSTRAINT "ck_categories_name_nonempty" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "ck_categories_not_self_parent" CHECK (("parent_id" IS DISTINCT FROM "id"))
);


--
-- Name: categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."categories_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."categories_id_seq" OWNED BY "public"."categories"."id";


--
-- Name: category_ancestors; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW "public"."category_ancestors" AS
 WITH RECURSIVE "ancestry" AS (
         SELECT "categories"."id" AS "category_id",
            "categories"."id" AS "ancestor_id",
            0 AS "distance"
           FROM "public"."categories"
        UNION ALL
         SELECT "a"."category_id",
            "c"."parent_id",
            ("a"."distance" + 1)
           FROM ("ancestry" "a"
             JOIN "public"."categories" "c" ON (("c"."id" = "a"."ancestor_id")))
          WHERE ("c"."parent_id" IS NOT NULL)
        )
 SELECT "category_id",
    "ancestor_id",
    "distance"
   FROM "ancestry";


--
-- Name: category_merge_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."category_merge_aliases" (
    "general" "text" NOT NULL,
    "detail" "text" NOT NULL,
    "target_category_id" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: category_paths; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW "public"."category_paths" AS
 WITH RECURSIVE "paths" AS (
         SELECT "categories"."id",
            "categories"."parent_id",
            ARRAY["categories"."id"] AS "ids",
            ARRAY["categories"."name"] AS "names"
           FROM "public"."categories"
          WHERE ("categories"."parent_id" IS NULL)
        UNION ALL
         SELECT "c"."id",
            "c"."parent_id",
            ("p"."ids" || "c"."id"),
            ("p"."names" || "c"."name")
           FROM ("public"."categories" "c"
             JOIN "paths" "p" ON (("c"."parent_id" = "p"."id")))
        )
 SELECT "id",
    "parent_id",
    "ids",
    "names",
    "array_to_string"("names", ':'::"text") AS "path_name",
    "cardinality"("ids") AS "depth"
   FROM "paths";


--
-- Name: category_root_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."category_root_aliases" (
    "general" "text" NOT NULL,
    "target_category_id" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: custom_parser_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."custom_parser_configs" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "config_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" "text" DEFAULT 'transaction'::"text" NOT NULL,
    CONSTRAINT "chk_custom_parser_configs_kind" CHECK (("kind" = ANY (ARRAY['transaction'::"text", 'portfolio'::"text"])))
);


--
-- Name: custom_parser_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."custom_parser_configs_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_parser_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."custom_parser_configs_id_seq" OWNED BY "public"."custom_parser_configs"."id";


--
-- Name: db_editor_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."db_editor_audit" (
    "id" bigint NOT NULL,
    "table_name" "text" NOT NULL,
    "op" "text" NOT NULL,
    "pk_json" "jsonb",
    "before_json" "jsonb",
    "after_json" "jsonb",
    "statement" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "db_editor_audit_op_check" CHECK (("op" = ANY (ARRAY['insert'::"text", 'update'::"text", 'delete'::"text"])))
);


--
-- Name: db_editor_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."db_editor_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: db_editor_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."db_editor_audit_id_seq" OWNED BY "public"."db_editor_audit"."id";


--
-- Name: exchange_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."exchange_rates" (
    "id" integer NOT NULL,
    "currency_code" character varying(3) NOT NULL,
    "rate_to_eur" numeric(20,10) NOT NULL,
    "rate_date" "date" NOT NULL,
    "is_latest" boolean DEFAULT false,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."exchange_rates_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."exchange_rates_id_seq" OWNED BY "public"."exchange_rates"."id";


--
-- Name: import_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."import_batches" (
    "id" bigint NOT NULL,
    "adapter_name" "text" NOT NULL,
    "source_filename" "text",
    "source_size_bytes" bigint,
    "custom_config" "jsonb",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "rows_total" integer DEFAULT 0 NOT NULL,
    "rows_imported" integer DEFAULT 0 NOT NULL,
    "rows_duplicate" integer DEFAULT 0 NOT NULL,
    "rows_error" integer DEFAULT 0 NOT NULL,
    "error_summary" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "chk_import_batches_status" CHECK (("status" = ANY (ARRAY['pending'::"text", 'staging'::"text", 'validating'::"text", 'matching'::"text", 'committing'::"text", 'complete'::"text", 'failed'::"text", 'aborted'::"text", 'awaiting_review'::"text"])))
);


--
-- Name: import_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."import_batches_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."import_batches_id_seq" OWNED BY "public"."import_batches"."id";


--
-- Name: import_staging_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."import_staging_rows" (
    "id" bigint NOT NULL,
    "batch_id" bigint NOT NULL,
    "row_index" integer NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "tx_date" "date",
    "bank_account" "text",
    "recipient_raw" "text",
    "memo" "text",
    "amount" numeric(20,4),
    "currency" "text",
    "balance" numeric(20,4),
    "recipient_account" "text",
    "recipient_address" "text",
    "recipient_bank_name" "text",
    "comment" "text",
    "raw_data" "text",
    "resolved_recipient_id" integer,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "match_source" "text",
    "matched_pattern_id" integer,
    "match_similarity" real,
    "user_override_recipient_id" integer,
    "override_category_id" integer,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_transaction_id" "text",
    "source_account_identity" "text",
    "dedup_occurrence" integer,
    "source_record_hash" character(64),
    "dedup_fingerprint" character(64),
    "dedup_fingerprint_version" smallint,
    CONSTRAINT "chk_import_staging_rows_dedup_fingerprint" CHECK ((("dedup_fingerprint" IS NULL) OR ("dedup_fingerprint" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "chk_import_staging_rows_dedup_occurrence" CHECK ((("dedup_occurrence" IS NULL) OR ("dedup_occurrence" > 0))),
    CONSTRAINT "chk_import_staging_rows_dedup_pair" CHECK ((("dedup_fingerprint" IS NULL) = ("dedup_fingerprint_version" IS NULL))),
    CONSTRAINT "chk_import_staging_rows_dedup_version" CHECK ((("dedup_fingerprint_version" IS NULL) OR ("dedup_fingerprint_version" > 0))),
    CONSTRAINT "chk_import_staging_rows_source_record_hash" CHECK ((("source_record_hash" IS NULL) OR ("source_record_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "chk_import_staging_rows_status" CHECK (("status" = ANY (ARRAY['pending'::"text", 'validated'::"text", 'matched'::"text", 'committed'::"text", 'duplicate'::"text", 'error'::"text"]))),
    CONSTRAINT "import_staging_rows_match_source_check" CHECK (("match_source" = ANY (ARRAY['exact'::"text", 'fuzzy'::"text", 'pattern'::"text", 'new'::"text"])))
);


--
-- Name: import_staging_rows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."import_staging_rows_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_staging_rows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."import_staging_rows_id_seq" OWNED BY "public"."import_staging_rows"."id";


--
-- Name: insight_cash_projections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."insight_cash_projections" (
    "month_start" "date" NOT NULL,
    "currency" character(3) NOT NULL,
    "method_id" "text" NOT NULL,
    "month_end_net_cashflow" numeric(20,4) NOT NULL,
    "observed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_insight_cash_projection_month" CHECK (("month_start" = ("date_trunc"('month'::"text", ("month_start")::timestamp with time zone))::"date"))
);


--
-- Name: insight_digest_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."insight_digest_state" (
    "singleton_id" smallint NOT NULL,
    "undismissed_count" integer,
    "dirty_version" bigint DEFAULT 1 NOT NULL,
    "computed_version" bigint DEFAULT 0 NOT NULL,
    "computed_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    CONSTRAINT "chk_insight_digest_count" CHECK ((("undismissed_count" IS NULL) OR ("undismissed_count" >= 0))),
    CONSTRAINT "chk_insight_digest_singleton" CHECK (("singleton_id" = 1))
);


--
-- Name: insight_dismissals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."insight_dismissals" (
    "id" bigint NOT NULL,
    "kind" "text" NOT NULL,
    "recipient_id" integer,
    "category_id" integer,
    "month_start" "date",
    "dismissed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deviation_at_dismiss" double precision,
    CONSTRAINT "chk_insight_dismissals_kind" CHECK (("kind" = ANY (ARRAY['subscription_new'::"text", 'subscription_price_change'::"text", 'category_outlier'::"text"]))),
    CONSTRAINT "chk_insight_dismissals_shape" CHECK (((("kind" = ANY (ARRAY['subscription_new'::"text", 'subscription_price_change'::"text"])) AND ("recipient_id" IS NOT NULL) AND ("category_id" IS NULL) AND ("month_start" IS NULL) AND ("deviation_at_dismiss" IS NULL)) OR (("kind" = 'category_outlier'::"text") AND ("recipient_id" IS NULL) AND ("category_id" IS NOT NULL) AND ("month_start" IS NOT NULL) AND ("deviation_at_dismiss" IS NOT NULL))))
);


--
-- Name: insight_dismissals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."insight_dismissals_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: insight_dismissals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."insight_dismissals_id_seq" OWNED BY "public"."insight_dismissals"."id";


--
-- Name: instrument_provider_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."instrument_provider_map" (
    "id" integer NOT NULL,
    "instrument_key" "text" NOT NULL,
    "key_type" "text" DEFAULT 'isin'::"text" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_symbol" "text",
    "resolved_name" "text",
    "exchange" "text",
    "currency" "text",
    "status" "text" DEFAULT 'auto'::"text" NOT NULL,
    "verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_instrument_provider_map_key_type" CHECK (("key_type" = ANY (ARRAY['isin'::"text", 'internal'::"text"]))),
    CONSTRAINT "chk_instrument_provider_map_status" CHECK (("status" = ANY (ARRAY['confirmed'::"text", 'auto'::"text", 'failed'::"text"])))
);


--
-- Name: instrument_provider_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."instrument_provider_map_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: instrument_provider_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."instrument_provider_map_id_seq" OWNED BY "public"."instrument_provider_map"."id";


--
-- Name: investment_ticker_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."investment_ticker_prefs" (
    "investment_id" integer NOT NULL,
    "show_in_ticker" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: investments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."investments" (
    "id" integer NOT NULL,
    "name" character varying(200) NOT NULL,
    "symbol" character varying(20),
    "asset_class" "public"."asset_class" NOT NULL,
    "currency" character varying(10) DEFAULT 'EUR'::character varying NOT NULL,
    "current_price" numeric(18,6),
    "interest_rate" numeric(8,4),
    "maturity_date" "date",
    "location" character varying(300),
    "municipality" character varying(200),
    "cadastral_income" numeric(12,2),
    "municipality_tax_rate" numeric(8,4),
    "notes" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "price_provider" "public"."price_provider" DEFAULT 'manual'::"public"."price_provider" NOT NULL,
    "price_provider_id" character varying(200),
    "price_provider_url" character varying(500),
    "price_provider_latest_url" character varying(500),
    "price_provider_latest_path" character varying(300),
    "price_provider_history_url" character varying(500),
    "price_provider_history_path" character varying(300),
    "price_provider_history_ts_path" character varying(300),
    "price_provider_history_price_path" character varying(300),
    "price_updated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: investments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."investments_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."investments_id_seq" OWNED BY "public"."investments"."id";


--
-- Name: manual_transaction_dedup_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."manual_transaction_dedup_claims" (
    "deduplication_hash" character(64) NOT NULL,
    "transaction_id" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "manual_transaction_dedup_claims_deduplication_hash_check" CHECK (("deduplication_hash" ~ '^[0-9a-f]{64}$'::"text"))
);


--
-- Name: planned_transaction_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."planned_transaction_executions" (
    "id" integer NOT NULL,
    "planned_transaction_id" integer NOT NULL,
    "executed_transaction_id" integer NOT NULL,
    "execution_date" "date" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: planned_transaction_executions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."planned_transaction_executions_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planned_transaction_executions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."planned_transaction_executions_id_seq" OWNED BY "public"."planned_transaction_executions"."id";


--
-- Name: planned_transaction_loan_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."planned_transaction_loan_schedule" (
    "id" integer NOT NULL,
    "planned_transaction_id" integer CONSTRAINT "planned_transaction_loan_schedu_planned_transaction_id_not_null" NOT NULL,
    "installment_number" integer NOT NULL,
    "due_date" "date" NOT NULL,
    "payment_amount" numeric(18,4) NOT NULL,
    "principal_amount" numeric(18,4) NOT NULL,
    "interest_amount" numeric(18,4) NOT NULL,
    "remaining_principal" numeric(18,4) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: planned_transaction_loan_schedule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."planned_transaction_loan_schedule_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planned_transaction_loan_schedule_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."planned_transaction_loan_schedule_id_seq" OWNED BY "public"."planned_transaction_loan_schedule"."id";


--
-- Name: planned_transaction_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."planned_transaction_tags" (
    "planned_transaction_id" integer NOT NULL,
    "tag_id" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: planned_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."planned_transactions" (
    "id" integer NOT NULL,
    "planned_date" "date" NOT NULL,
    "amount" numeric(18,4) NOT NULL,
    "currency" character varying(3) DEFAULT 'EUR'::character varying NOT NULL,
    "memo" "text",
    "comment" "text",
    "url" "text",
    "recipient_id" integer,
    "category_id" integer,
    "is_recurring" boolean DEFAULT false NOT NULL,
    "recurrence_pattern" "text",
    "is_loan" boolean DEFAULT false NOT NULL,
    "loan_type" "text",
    "loan_principal" numeric(18,4),
    "loan_annual_interest_rate" numeric(8,4),
    "loan_term_months" integer,
    "loan_start_date" "date",
    "loan_payment_day" integer,
    "loan_regular_payment_amount" numeric(18,4),
    "loan_first_payment_date" "date",
    "is_executed" boolean DEFAULT false NOT NULL,
    "last_executed_date" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reminder_days_before" integer,
    "account_id" integer,
    "recurrence_end_date" "date",
    "max_occurrences" integer,
    CONSTRAINT "chk_planned_max_occurrences_positive" CHECK ((("max_occurrences" IS NULL) OR ("max_occurrences" > 0))),
    CONSTRAINT "chk_planned_transactions_currency_iso" CHECK ((("currency")::"text" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "chk_planned_transactions_recurrence_pattern" CHECK ((("recurrence_pattern" IS NULL) OR ("lower"("btrim"("recurrence_pattern")) = ANY (ARRAY['daily'::"text", 'weekly'::"text", 'biweekly'::"text", 'monthly'::"text", 'quarterly'::"text", 'yearly'::"text"])) OR ("lower"("btrim"("recurrence_pattern")) ~ '^every[[:space:]]+0*[1-9][0-9]*[[:space:]]+days?$'::"text")))
);


--
-- Name: COLUMN "planned_transactions"."reminder_days_before"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."planned_transactions"."reminder_days_before" IS 'Days before planned_date to surface as a reminder. NULL = no reminder.';


--
-- Name: planned_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."planned_transactions_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planned_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."planned_transactions_id_seq" OWNED BY "public"."planned_transactions"."id";


--
-- Name: portfolio_broker_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portfolio_broker_snapshots" (
    "snapshot_date" "date" NOT NULL,
    "currency" character varying(3) NOT NULL,
    "account_key" "text" NOT NULL,
    "account_id" integer,
    "account_name" "text" NOT NULL,
    "value" numeric(18,2) NOT NULL,
    "invested" numeric(18,2) NOT NULL,
    "gain_loss" numeric(18,2) NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "portfolio_broker_snapshots_account_key_check" CHECK ((("account_key" = 'unassigned'::"text") OR ("account_key" ~ '^account:[1-9][0-9]*$'::"text"))),
    CONSTRAINT "portfolio_broker_snapshots_check" CHECK (((("account_key" = 'unassigned'::"text") AND ("account_id" IS NULL)) OR ("account_key" = ('account:'::"text" || ("account_id")::"text")))),
    CONSTRAINT "portfolio_broker_snapshots_currency_check" CHECK ((("currency")::"text" ~ '^[A-Z]{3}$'::"text"))
);


--
-- Name: portfolio_exposure_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portfolio_exposure_classifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "investment_id" integer,
    "identifier_type" "text",
    "identifier_value" "text",
    "identifier_exchange" "text",
    "issuer_id" "text" NOT NULL,
    "issuer_name" "text" NOT NULL,
    "sector" "text",
    "issuer_country_code" character(2),
    "source_label" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "portfolio_exposure_classifications_check" CHECK (((("investment_id" IS NOT NULL) AND ("identifier_type" IS NULL) AND ("identifier_value" IS NULL) AND ("identifier_exchange" IS NULL)) OR (("investment_id" IS NULL) AND ("identifier_type" IS NOT NULL) AND ("identifier_value" IS NOT NULL)))),
    CONSTRAINT "portfolio_exposure_classifications_identifier_type_check" CHECK ((("identifier_type" IS NULL) OR ("identifier_type" = ANY (ARRAY['isin'::"text", 'ticker'::"text", 'sedol'::"text", 'cusip'::"text", 'lei'::"text", 'proprietary'::"text"])))),
    CONSTRAINT "portfolio_exposure_classifications_issuer_country_code_check" CHECK (("issuer_country_code" ~ '^[A-Z]{2}$'::"text")),
    CONSTRAINT "portfolio_exposure_classifications_issuer_id_check" CHECK ((("length"("issuer_id") >= 1) AND ("length"("issuer_id") <= 128))),
    CONSTRAINT "portfolio_exposure_classifications_issuer_name_check" CHECK ((("length"("issuer_name") >= 1) AND ("length"("issuer_name") <= 256))),
    CONSTRAINT "portfolio_exposure_classifications_sector_check" CHECK ((("length"("sector") >= 1) AND ("length"("sector") <= 128))),
    CONSTRAINT "portfolio_exposure_classifications_source_label_check" CHECK ((("length"("source_label") >= 1) AND ("length"("source_label") <= 300)))
);


--
-- Name: portfolio_fund_holdings_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portfolio_fund_holdings_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "investment_id" integer NOT NULL,
    "share_class_identifier_json" "jsonb" CONSTRAINT "portfolio_fund_holdings_doc_share_class_identifier_jso_not_null" NOT NULL,
    "document_json" "jsonb" NOT NULL,
    "source_as_of_date" "date" NOT NULL,
    "source_sha256" character(64) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "portfolio_fund_holdings_documents_source_sha256_check" CHECK (("source_sha256" ~ '^[0-9a-f]{64}$'::"text"))
);


--
-- Name: portfolio_import_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portfolio_import_batches" (
    "id" bigint NOT NULL,
    "adapter_name" "text" NOT NULL,
    "source_filename" "text",
    "source_size_bytes" bigint,
    "custom_config" "jsonb",
    "default_asset_class" "public"."asset_class",
    "default_type" "public"."portfolio_txn_type",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "rows_total" integer DEFAULT 0 NOT NULL,
    "rows_imported" integer DEFAULT 0 NOT NULL,
    "rows_duplicate" integer DEFAULT 0 NOT NULL,
    "rows_error" integer DEFAULT 0 NOT NULL,
    "error_summary" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "account_id" integer,
    "is_brokerage" boolean DEFAULT false NOT NULL,
    CONSTRAINT "portfolio_import_batches_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'staging'::"text", 'validating'::"text", 'matching'::"text", 'awaiting_review'::"text", 'committing'::"text", 'complete'::"text", 'failed'::"text", 'aborted'::"text", 'complete_with_errors'::"text"])))
);


--
-- Name: portfolio_import_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."portfolio_import_batches_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_import_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."portfolio_import_batches_id_seq" OWNED BY "public"."portfolio_import_batches"."id";


--
-- Name: portfolio_import_staging_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portfolio_import_staging_rows" (
    "id" bigint NOT NULL,
    "batch_id" bigint NOT NULL,
    "row_index" integer NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "tx_date" "date",
    "type_raw" "text",
    "type" "public"."portfolio_txn_type",
    "symbol_raw" "text",
    "name_raw" "text",
    "units" numeric(18,8),
    "price_per_unit" numeric(18,6),
    "amount" numeric(18,4),
    "fees" numeric(18,4),
    "taxes" numeric(18,4),
    "currency" "text",
    "fx_rate_to_eur" numeric(20,10),
    "note" "text",
    "raw_data" "text",
    "resolved_investment_id" integer,
    "user_override_investment_id" integer,
    "match_source" "text",
    "match_similarity" real,
    "committed_txn_id" integer,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "route" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_transaction_id" "text",
    "source_account_identity" "text",
    "dedup_occurrence" integer,
    "source_record_hash" character(64),
    "dedup_fingerprint" character(64),
    "dedup_fingerprint_version" smallint,
    CONSTRAINT "chk_portfolio_import_staging_rows_dedup_fingerprint" CHECK ((("dedup_fingerprint" IS NULL) OR ("dedup_fingerprint" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "chk_portfolio_import_staging_rows_dedup_occurrence" CHECK ((("dedup_occurrence" IS NULL) OR ("dedup_occurrence" > 0))),
    CONSTRAINT "chk_portfolio_import_staging_rows_dedup_pair" CHECK ((("dedup_fingerprint" IS NULL) = ("dedup_fingerprint_version" IS NULL))),
    CONSTRAINT "chk_portfolio_import_staging_rows_dedup_version" CHECK ((("dedup_fingerprint_version" IS NULL) OR ("dedup_fingerprint_version" > 0))),
    CONSTRAINT "chk_portfolio_import_staging_rows_match_source" CHECK ((("match_source" IS NULL) OR ("match_source" = ANY (ARRAY['symbol'::"text", 'name_exact'::"text"])))),
    CONSTRAINT "chk_portfolio_import_staging_rows_route" CHECK ((("route" IS NULL) OR ("route" = ANY (ARRAY['cash'::"text", 'portfolio'::"text"])))),
    CONSTRAINT "chk_portfolio_import_staging_rows_source_record_hash" CHECK ((("source_record_hash" IS NULL) OR ("source_record_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "portfolio_import_staging_rows_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'validated'::"text", 'matched'::"text", 'committed'::"text", 'duplicate'::"text", 'error'::"text"])))
);


--
-- Name: portfolio_import_staging_rows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."portfolio_import_staging_rows_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_import_staging_rows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."portfolio_import_staging_rows_id_seq" OWNED BY "public"."portfolio_import_staging_rows"."id";


--
-- Name: portfolio_performance_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portfolio_performance_snapshots" (
    "id" integer NOT NULL,
    "snapshot_date" "date" NOT NULL,
    "invested" numeric(18,6) DEFAULT 0 NOT NULL,
    "value" numeric(18,6) DEFAULT 0 NOT NULL,
    "stocks_etfs_value" numeric(18,6) DEFAULT 0 NOT NULL,
    "crypto_value" numeric(18,6) DEFAULT 0 NOT NULL,
    "metals_value" numeric(18,6) DEFAULT 0 NOT NULL,
    "cash_value" numeric(18,6) DEFAULT 0 NOT NULL,
    "gain_loss" numeric(18,6) DEFAULT 0 NOT NULL,
    "return_pct" numeric(10,4) DEFAULT 0 NOT NULL,
    "inflation_adjusted_value" numeric(18,6) DEFAULT 0 CONSTRAINT "portfolio_performance_snapsho_inflation_adjusted_value_not_null" NOT NULL,
    "cumulative_inflation" numeric(10,4) DEFAULT 1 NOT NULL,
    "real_return_pct" numeric(10,4) DEFAULT 0 NOT NULL,
    "currency" character varying(3) DEFAULT 'EUR'::character varying NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "stocks_etfs_invested" numeric(18,6) DEFAULT 0 NOT NULL,
    "crypto_invested" numeric(18,6) DEFAULT 0 NOT NULL,
    "metals_invested" numeric(18,6) DEFAULT 0 NOT NULL,
    "value_fx_neutral" numeric(18,2)
);


--
-- Name: portfolio_performance_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."portfolio_performance_snapshots_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_performance_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."portfolio_performance_snapshots_id_seq" OWNED BY "public"."portfolio_performance_snapshots"."id";


--
-- Name: portfolio_retag_audit; Type: TABLE; Schema: public; Owner: -
--

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
    CONSTRAINT "chk_portfolio_retag_transaction_ids_array" CHECK (("jsonb_typeof"("transaction_ids") = 'array'::"text"))
);


--
-- Name: portfolio_retag_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."portfolio_retag_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_retag_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."portfolio_retag_audit_id_seq" OWNED BY "public"."portfolio_retag_audit"."id";


--
-- Name: portfolio_snapshot_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portfolio_snapshot_accounts" (
    "snapshot_date" "date" NOT NULL,
    "currency" character varying(3) NOT NULL,
    "account_key" "text" NOT NULL,
    "value" numeric(18,2) NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: portfolio_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portfolio_transactions" (
    "id" integer NOT NULL,
    "investment_id" integer NOT NULL,
    "type" "public"."portfolio_txn_type" NOT NULL,
    "date" "date" NOT NULL,
    "amount" numeric(18,4) NOT NULL,
    "units" numeric(18,8),
    "price_per_unit" numeric(18,6),
    "fees" numeric(18,4) DEFAULT 0,
    "taxes" numeric(18,4) DEFAULT 0,
    "currency" character varying(10) DEFAULT 'EUR'::character varying NOT NULL,
    "fx_rate_to_eur" numeric(20,10),
    "note" "text",
    "is_recurring" boolean DEFAULT false NOT NULL,
    "recurrence_interval" "text",
    "recurrence_end_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "account_id" integer,
    "import_batch_id" bigint,
    "dividend_amount_convention" character varying(7) DEFAULT 'unknown'::character varying NOT NULL,
    "source_record_hash" character(64),
    "dedup_fingerprint" character(64),
    "dedup_fingerprint_version" smallint,
    CONSTRAINT "chk_portfolio_transactions_dedup_fingerprint" CHECK ((("dedup_fingerprint" IS NULL) OR ("dedup_fingerprint" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "chk_portfolio_transactions_dedup_pair" CHECK ((("dedup_fingerprint" IS NULL) = ("dedup_fingerprint_version" IS NULL))),
    CONSTRAINT "chk_portfolio_transactions_dedup_version" CHECK ((("dedup_fingerprint_version" IS NULL) OR ("dedup_fingerprint_version" > 0))),
    CONSTRAINT "chk_portfolio_transactions_dividend_amount_convention" CHECK ((("dividend_amount_convention")::"text" = ANY ((ARRAY['gross'::character varying, 'net'::character varying, 'unknown'::character varying])::"text"[]))),
    CONSTRAINT "chk_portfolio_transactions_recurrence_interval" CHECK ((("recurrence_interval" IS NULL) OR ("recurrence_interval" = ANY (ARRAY['daily'::"text", 'weekly'::"text", 'biweekly'::"text", 'monthly'::"text", 'quarterly'::"text", 'yearly'::"text"])))),
    CONSTRAINT "chk_portfolio_transactions_source_record_hash" CHECK ((("source_record_hash" IS NULL) OR ("source_record_hash" ~ '^[0-9a-f]{64}$'::"text")))
);


--
-- Name: portfolio_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."portfolio_transactions_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."portfolio_transactions_id_seq" OWNED BY "public"."portfolio_transactions"."id";


--
-- Name: provider_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."provider_api_keys" (
    "provider" "text" NOT NULL,
    "api_key" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: provider_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."provider_health" (
    "provider" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "last_success_at" timestamp with time zone,
    "last_error_at" timestamp with time zone,
    "last_error" "text",
    "consecutive_failures" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: provider_quota; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."provider_quota" (
    "provider" "text" NOT NULL,
    "window_date" "date" NOT NULL,
    "count" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_provider_quota_count_nonneg" CHECK (("count" >= 0))
);


--
-- Name: recipient_bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."recipient_bank_accounts" (
    "id" integer NOT NULL,
    "recipient_id" integer,
    "account_number" character varying(34) NOT NULL,
    "bank_name" "text",
    "account_label" "text",
    "address" "text",
    "is_primary" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: recipient_bank_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."recipient_bank_accounts_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recipient_bank_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."recipient_bank_accounts_id_seq" OWNED BY "public"."recipient_bank_accounts"."id";


--
-- Name: recipient_match_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."recipient_match_patterns" (
    "id" integer NOT NULL,
    "recipient_id" integer NOT NULL,
    "pattern" "text" NOT NULL,
    "pattern_kind" "text" DEFAULT 'literal_prefix'::"text" NOT NULL,
    "case_sensitive" boolean DEFAULT false NOT NULL,
    "priority" integer DEFAULT 100 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "source" "text" DEFAULT 'user'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "recipient_match_patterns_pattern_kind_check" CHECK (("pattern_kind" = ANY (ARRAY['regex'::"text", 'glob'::"text", 'literal_prefix'::"text"]))),
    CONSTRAINT "recipient_match_patterns_source_check" CHECK (("source" = ANY (ARRAY['user'::"text", 'suggested'::"text", 'system'::"text"])))
);


--
-- Name: recipient_match_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."recipient_match_patterns_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recipient_match_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."recipient_match_patterns_id_seq" OWNED BY "public"."recipient_match_patterns"."id";


--
-- Name: recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."recipients" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "default_category_id" integer,
    "primary_recipient_id" integer,
    "notes" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: recipients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."recipients_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recipients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."recipients_id_seq" OWNED BY "public"."recipients"."id";


--
-- Name: research_dossier_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."research_dossier_links" (
    "dossier_id" "uuid" NOT NULL,
    "link_type" "text" NOT NULL,
    "ordinal" integer NOT NULL,
    "historical_id" "text" NOT NULL,
    "label_snapshot" "text" NOT NULL,
    "category_id" integer,
    "investment_id" integer,
    "saved_analysis_id" "text",
    CONSTRAINT "research_dossier_links_check" CHECK (((("link_type" = 'category'::"text") AND ("investment_id" IS NULL) AND ("saved_analysis_id" IS NULL)) OR (("link_type" = 'investment'::"text") AND ("category_id" IS NULL) AND ("saved_analysis_id" IS NULL)) OR (("link_type" = 'saved-analysis'::"text") AND ("category_id" IS NULL) AND ("investment_id" IS NULL)))),
    CONSTRAINT "research_dossier_links_historical_id_check" CHECK ((("length"("historical_id") >= 1) AND ("length"("historical_id") <= 100))),
    CONSTRAINT "research_dossier_links_label_snapshot_check" CHECK ((("length"("label_snapshot") >= 1) AND ("length"("label_snapshot") <= 500))),
    CONSTRAINT "research_dossier_links_link_type_check" CHECK (("link_type" = ANY (ARRAY['category'::"text", 'investment'::"text", 'saved-analysis'::"text"]))),
    CONSTRAINT "research_dossier_links_ordinal_check" CHECK (("ordinal" >= 0))
);


--
-- Name: research_dossier_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."research_dossier_versions" (
    "dossier_id" "uuid" NOT NULL,
    "version" integer NOT NULL,
    "snapshot_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "research_dossier_versions_snapshot_json_check" CHECK (("jsonb_typeof"("snapshot_json") = 'object'::"text")),
    CONSTRAINT "research_dossier_versions_version_check" CHECK (("version" > 0))
);


--
-- Name: research_dossiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."research_dossiers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "workspace" "text" NOT NULL,
    "title" "text" NOT NULL,
    "content_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "research_dossiers_content_json_check" CHECK (("jsonb_typeof"("content_json") = 'object'::"text")),
    CONSTRAINT "research_dossiers_title_check" CHECK ((("length"("title") >= 1) AND ("length"("title") <= 300))),
    CONSTRAINT "research_dossiers_version_check" CHECK (("version" > 0)),
    CONSTRAINT "research_dossiers_workspace_check" CHECK (("workspace" = ANY (ARRAY['budgeting'::"text", 'portfolio'::"text", 'research'::"text", 'cross-workspace'::"text"])))
);


--
-- Name: saved_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."saved_analyses" (
    "id" "text" NOT NULL,
    "definition_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "workspace" "text" NOT NULL,
    "current_version" integer DEFAULT 1 NOT NULL,
    "refresh_mode" "text" DEFAULT 'live'::"text" NOT NULL,
    "parameters_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "charts_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "source_references_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "refresh_status" "text" DEFAULT 'never-run'::"text" NOT NULL,
    "last_successful_run_id" "text",
    "last_error_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "saved_analyses_current_version_check" CHECK (("current_version" > 0)),
    CONSTRAINT "saved_analyses_name_check" CHECK ((("length"("name") >= 1) AND ("length"("name") <= 200))),
    CONSTRAINT "saved_analyses_refresh_mode_check" CHECK (("refresh_mode" = ANY (ARRAY['live'::"text", 'frozen'::"text"]))),
    CONSTRAINT "saved_analyses_refresh_status_check" CHECK (("refresh_status" = ANY (ARRAY['never-run'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "saved_analyses_workspace_check" CHECK (("workspace" = ANY (ARRAY['budgeting'::"text", 'portfolio'::"text", 'research'::"text", 'cross-workspace'::"text"])))
);


--
-- Name: saved_analysis_definition_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."saved_analysis_definition_versions" (
    "saved_analysis_id" "text" NOT NULL,
    "version" integer NOT NULL,
    "definition_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "state_json" "jsonb",
    CONSTRAINT "saved_analysis_definition_versions_version_check" CHECK (("version" > 0))
);


--
-- Name: saved_analysis_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."saved_analysis_runs" (
    "id" "text" NOT NULL,
    "saved_analysis_id" "text" NOT NULL,
    "definition_version" integer NOT NULL,
    "status" "text" NOT NULL,
    "parameters_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "result_json" "jsonb",
    "error_json" "jsonb",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "saved_analysis_runs_check" CHECK ((("status" = ANY (ARRAY['completed'::"text", 'partial'::"text"])) = ("result_json" IS NOT NULL))),
    CONSTRAINT "saved_analysis_runs_check1" CHECK ((("status" = ANY (ARRAY['failed'::"text", 'cancelled'::"text"])) = ("error_json" IS NOT NULL))),
    CONSTRAINT "saved_analysis_runs_definition_version_check" CHECK (("definition_version" > 0)),
    CONSTRAINT "saved_analysis_runs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'completed'::"text", 'partial'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


--
-- Name: saved_chart_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."saved_chart_categories" (
    "saved_chart_id" integer NOT NULL,
    "category_id" integer NOT NULL
);


--
-- Name: saved_chart_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."saved_chart_recipients" (
    "saved_chart_id" integer NOT NULL,
    "recipient_id" integer NOT NULL
);


--
-- Name: saved_chart_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."saved_chart_tags" (
    "saved_chart_id" integer NOT NULL,
    "tag_id" integer NOT NULL
);


--
-- Name: saved_charts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."saved_charts" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "chart_type" "text" DEFAULT 'line'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "chart_variant" "text" DEFAULT 'default'::"text" NOT NULL,
    "time_bucket" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "date_range_start" "date",
    "date_range_end" "date",
    "all_categories" boolean DEFAULT false NOT NULL,
    "all_recipients" boolean DEFAULT false NOT NULL,
    "all_tags" boolean DEFAULT false NOT NULL
);


--
-- Name: saved_charts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."saved_charts_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: saved_charts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."saved_charts_id_seq" OWNED BY "public"."saved_charts"."id";


--
-- Name: split_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."split_audit" (
    "id" bigint NOT NULL,
    "split_id" integer,
    "action" character varying(50) NOT NULL,
    "actor" "text",
    "payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: split_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."split_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: split_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."split_audit_id_seq" OWNED BY "public"."split_audit"."id";


--
-- Name: split_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."split_payments" (
    "id" integer NOT NULL,
    "split_id" integer NOT NULL,
    "amount" numeric(18,4) NOT NULL,
    "paid_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_split_payment_amount_positive" CHECK (("amount" > (0)::numeric))
);


--
-- Name: split_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."split_payments_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: split_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."split_payments_id_seq" OWNED BY "public"."split_payments"."id";


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tags" (
    "id" integer NOT NULL,
    "slug" "text" NOT NULL,
    "color" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."tags_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."tags_id_seq" OWNED BY "public"."tags"."id";


--
-- Name: transaction_source_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."transaction_source_links" (
    "id" bigint NOT NULL,
    "source_record_id" bigint NOT NULL,
    "transaction_id" integer,
    "legacy_transaction_id" integer,
    "link_status" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "transaction_source_links_link_status_check" CHECK (("link_status" = ANY (ARRAY['linked'::"text", 'dangling-reference'::"text"])))
);


--
-- Name: transaction_source_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."transaction_source_links_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transaction_source_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."transaction_source_links_id_seq" OWNED BY "public"."transaction_source_links"."id";


--
-- Name: transaction_source_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."transaction_source_records" (
    "id" bigint NOT NULL,
    "source_type" "text" NOT NULL,
    "legacy_source_id" bigint NOT NULL,
    "recorded_at" timestamp with time zone NOT NULL,
    "deduplication_hash" "text",
    "raw_csv_line" "text",
    "native_payload" "jsonb" NOT NULL,
    "migration_status" "text" DEFAULT 'linked'::"text" NOT NULL,
    "migrated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "transaction_source_records_migration_status_check" CHECK (("migration_status" = ANY (ARRAY['linked'::"text", 'unlinked'::"text", 'dangling-reference'::"text"])))
);


--
-- Name: transaction_source_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."transaction_source_records_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transaction_source_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."transaction_source_records_id_seq" OWNED BY "public"."transaction_source_records"."id";


--
-- Name: transaction_splits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."transaction_splits" (
    "id" integer NOT NULL,
    "transaction_id" integer NOT NULL,
    "recipient_id" integer NOT NULL,
    "amount" numeric(18,4) NOT NULL,
    "note" "text",
    "is_settled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_split_amount_positive" CHECK (("amount" > (0)::numeric))
);


--
-- Name: transaction_splits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."transaction_splits_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transaction_splits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."transaction_splits_id_seq" OWNED BY "public"."transaction_splits"."id";


--
-- Name: transaction_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."transaction_tags" (
    "transaction_id" integer NOT NULL,
    "tag_id" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."transactions" (
    "id" integer NOT NULL,
    "date" "date" NOT NULL,
    "amount" numeric(18,4) NOT NULL,
    "currency" character varying(3) DEFAULT 'EUR'::character varying NOT NULL,
    "balance" numeric(18,4),
    "memo" "text",
    "comment" "text",
    "recipient_id" integer NOT NULL,
    "recipient_bank_account_id" integer,
    "category_id" integer,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "import_batch_id" bigint,
    "matched_pattern_id" integer,
    "is_transfer" boolean DEFAULT false NOT NULL,
    "transfer_peer_id" integer,
    "transfer_source" "text",
    "account_id" integer,
    "source_record_hash" character(64),
    "dedup_fingerprint" character(64),
    "dedup_fingerprint_version" smallint,
    CONSTRAINT "chk_transactions_currency_iso" CHECK ((("currency")::"text" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "chk_transactions_dedup_fingerprint" CHECK ((("dedup_fingerprint" IS NULL) OR ("dedup_fingerprint" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "chk_transactions_dedup_pair" CHECK ((("dedup_fingerprint" IS NULL) = ("dedup_fingerprint_version" IS NULL))),
    CONSTRAINT "chk_transactions_dedup_version" CHECK ((("dedup_fingerprint_version" IS NULL) OR ("dedup_fingerprint_version" > 0))),
    CONSTRAINT "chk_transactions_source_record_hash" CHECK ((("source_record_hash" IS NULL) OR ("source_record_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "chk_transactions_transfer_source" CHECK ((("transfer_source" IS NULL) OR ("transfer_source" = ANY (ARRAY['auto'::"text", 'manual'::"text", 'opening'::"text", 'adjustment'::"text"]))))
);


--
-- Name: transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."transactions_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."transactions_id_seq" OWNED BY "public"."transactions"."id";


--
-- Name: transfer_dismissals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."transfer_dismissals" (
    "txn_a_id" integer NOT NULL,
    "txn_b_id" integer NOT NULL,
    "dismissed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_transfer_dismissals_ordered" CHECK (("txn_a_id" < "txn_b_id"))
);


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."user_settings" (
    "key" "text" NOT NULL,
    "value" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: watchlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."watchlist" (
    "id" integer NOT NULL,
    "name" character varying(200) NOT NULL,
    "symbol" character varying(20),
    "asset_class" "public"."asset_class" NOT NULL,
    "target_price" numeric(18,6) NOT NULL,
    "currency" character varying(10) DEFAULT 'EUR'::character varying NOT NULL,
    "notes" "text",
    "price_provider_id" character varying(200),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "added_price" numeric(18,6)
);


--
-- Name: watchlist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."watchlist_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watchlist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."watchlist_id_seq" OWNED BY "public"."watchlist"."id";


--
-- Name: accounts_v1; Type: VIEW; Schema: vision_analysis; Owner: -
--

CREATE VIEW "vision_analysis"."accounts_v1" AS
SELECT
    NULL::integer AS "account_id",
    NULL::"text" AS "account_name",
    NULL::"text" AS "display_name",
    NULL::"text" AS "institution",
    NULL::character varying(3) AS "currency",
    NULL::"public"."account_type" AS "account_type",
    NULL::"public"."account_liquidity_class" AS "liquidity_class",
    NULL::boolean AS "spendable",
    NULL::boolean AS "in_net_worth",
    NULL::"public"."account_tax_wrapper" AS "tax_wrapper",
    NULL::"public"."account_owner" AS "owner",
    NULL::boolean AS "multi_currency_cash",
    NULL::boolean AS "has_cash_sleeve",
    NULL::integer AS "funding_account_id",
    NULL::boolean AS "is_active",
    NULL::"jsonb" AS "statement_balances",
    NULL::timestamp with time zone AS "created_at",
    NULL::timestamp with time zone AS "updated_at";


--
-- Name: cash_flows_v1; Type: VIEW; Schema: vision_analysis; Owner: -
--

CREATE VIEW "vision_analysis"."cash_flows_v1" WITH ("security_barrier"='true') AS
 SELECT "t"."id" AS "cash_flow_id",
    "t"."date" AS "cash_flow_date",
    "t"."account_id",
    "a"."name" AS "account_name",
    "t"."currency",
    "t"."amount" AS "signed_amount",
        CASE
            WHEN "t"."is_transfer" THEN 'transfer'::"text"
            WHEN ("t"."amount" < (0)::numeric) THEN 'expense'::"text"
            ELSE 'income_or_refund'::"text"
        END AS "flow_type",
        CASE
            WHEN ((NOT "t"."is_transfer") AND ("t"."amount" < (0)::numeric)) THEN (- "t"."amount")
            ELSE (0)::numeric
        END AS "spending_amount",
        CASE
            WHEN ((NOT "t"."is_transfer") AND ("t"."amount" > (0)::numeric)) THEN "t"."amount"
            ELSE (0)::numeric
        END AS "positive_flow_amount",
    "t"."is_transfer",
    "t"."transfer_peer_id",
    "t"."recipient_id",
    "r"."name" AS "recipient_name",
    "t"."category_id",
    "c"."general" AS "category_general",
    "c"."detail" AS "category_detail",
    "t"."is_active",
    "t"."updated_at"
   FROM ((("public"."transactions" "t"
     LEFT JOIN "public"."accounts" "a" ON (("a"."id" = "t"."account_id")))
     LEFT JOIN "public"."recipients" "r" ON (("r"."id" = "t"."recipient_id")))
     LEFT JOIN "public"."categories" "c" ON (("c"."id" = "t"."category_id")));


--
-- Name: cash_flows_v2; Type: VIEW; Schema: vision_analysis; Owner: -
--

CREATE VIEW "vision_analysis"."cash_flows_v2" WITH ("security_barrier"='true') AS
 SELECT "v1"."cash_flow_id",
    "v1"."cash_flow_date",
    "v1"."account_id",
    "v1"."account_name",
    "v1"."currency",
    "v1"."signed_amount",
    "v1"."flow_type",
    "v1"."spending_amount",
    "v1"."positive_flow_amount",
    "v1"."is_transfer",
    "v1"."transfer_peer_id",
    "v1"."recipient_id",
    "v1"."recipient_name",
    "v1"."category_id",
    "v1"."category_general",
    "v1"."category_detail",
    "v1"."is_active",
    "v1"."updated_at",
    "c"."path_name" AS "category_path",
    "p"."names" AS "category_path_segments",
    "p"."ids" AS "category_path_ids"
   FROM (("vision_analysis"."cash_flows_v1" "v1"
     LEFT JOIN "public"."categories" "c" ON (("c"."id" = "v1"."category_id")))
     LEFT JOIN "public"."category_paths" "p" ON (("p"."id" = "v1"."category_id")));


--
-- Name: holding_events_v1; Type: VIEW; Schema: vision_analysis; Owner: -
--

CREATE VIEW "vision_analysis"."holding_events_v1" WITH ("security_barrier"='true') AS
 SELECT "pt"."id" AS "event_id",
    "pt"."investment_id",
    "i"."name" AS "investment_name",
    "i"."symbol",
    "i"."asset_class",
    "pt"."account_id",
    "a"."name" AS "account_name",
    "pt"."type" AS "event_type",
    "pt"."date" AS "event_date",
    "pt"."amount",
    "pt"."units",
    "pt"."price_per_unit",
    COALESCE("pt"."fees", (0)::numeric) AS "fees",
    COALESCE("pt"."taxes", (0)::numeric) AS "taxes",
    "pt"."currency",
    "pt"."fx_rate_to_eur",
    "pt"."is_recurring",
    "pt"."recurrence_interval",
    "pt"."recurrence_end_date",
    "pt"."import_batch_id",
    "pt"."created_at",
    "pt"."updated_at"
   FROM (("public"."portfolio_transactions" "pt"
     JOIN "public"."investments" "i" ON (("i"."id" = "pt"."investment_id")))
     LEFT JOIN "public"."accounts" "a" ON (("a"."id" = "pt"."account_id")));


--
-- Name: transactions_v1; Type: VIEW; Schema: vision_analysis; Owner: -
--

CREATE VIEW "vision_analysis"."transactions_v1" WITH ("security_barrier"='true') AS
 SELECT "t"."id" AS "transaction_id",
    "t"."date" AS "transaction_date",
    "t"."amount",
    "t"."currency",
    "t"."account_id",
    "a"."name" AS "account_name",
    "a"."display_name" AS "account_display_name",
    "t"."recipient_id",
    "r"."name" AS "recipient_name",
    "t"."category_id",
    "c"."general" AS "category_general",
    "c"."detail" AS "category_detail",
    "t"."memo",
    "t"."comment",
    "t"."is_transfer",
    "t"."transfer_peer_id",
    "t"."transfer_source",
    "t"."is_active",
    "t"."import_batch_id",
    "t"."created_at",
    "t"."updated_at"
   FROM ((("public"."transactions" "t"
     LEFT JOIN "public"."accounts" "a" ON (("a"."id" = "t"."account_id")))
     LEFT JOIN "public"."recipients" "r" ON (("r"."id" = "t"."recipient_id")))
     LEFT JOIN "public"."categories" "c" ON (("c"."id" = "t"."category_id")));


--
-- Name: transactions_v2; Type: VIEW; Schema: vision_analysis; Owner: -
--

CREATE VIEW "vision_analysis"."transactions_v2" WITH ("security_barrier"='true') AS
 SELECT "v1"."transaction_id",
    "v1"."transaction_date",
    "v1"."amount",
    "v1"."currency",
    "v1"."account_id",
    "v1"."account_name",
    "v1"."account_display_name",
    "v1"."recipient_id",
    "v1"."recipient_name",
    "v1"."category_id",
    "v1"."category_general",
    "v1"."category_detail",
    "v1"."memo",
    "v1"."comment",
    "v1"."is_transfer",
    "v1"."transfer_peer_id",
    "v1"."transfer_source",
    "v1"."is_active",
    "v1"."import_batch_id",
    "v1"."created_at",
    "v1"."updated_at",
    "c"."path_name" AS "category_path",
    "p"."names" AS "category_path_segments",
    "p"."ids" AS "category_path_ids"
   FROM (("vision_analysis"."transactions_v1" "v1"
     LEFT JOIN "public"."categories" "c" ON (("c"."id" = "v1"."category_id")))
     LEFT JOIN "public"."category_paths" "p" ON (("p"."id" = "v1"."category_id")));


--
-- Name: accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."accounts_id_seq"'::"regclass");


--
-- Name: asset_price_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."asset_price_history" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."asset_price_history_id_seq"'::"regclass");


--
-- Name: attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attachments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."attachments_id_seq"'::"regclass");


--
-- Name: belgian_inflation_rates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."belgian_inflation_rates" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."belgian_inflation_rates_id_seq"'::"regclass");


--
-- Name: cashflow_forecast_accuracy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cashflow_forecast_accuracy" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cashflow_forecast_accuracy_id_seq"'::"regclass");


--
-- Name: cashflow_forecast_mc id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cashflow_forecast_mc" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cashflow_forecast_mc_id_seq"'::"regclass");


--
-- Name: cashflow_forecast_mc_rolling id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cashflow_forecast_mc_rolling" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cashflow_forecast_mc_rolling_id_seq"'::"regclass");


--
-- Name: categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."categories" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."categories_id_seq"'::"regclass");


--
-- Name: custom_parser_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."custom_parser_configs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."custom_parser_configs_id_seq"'::"regclass");


--
-- Name: db_editor_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."db_editor_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."db_editor_audit_id_seq"'::"regclass");


--
-- Name: exchange_rates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rates" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."exchange_rates_id_seq"'::"regclass");


--
-- Name: import_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_batches" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."import_batches_id_seq"'::"regclass");


--
-- Name: import_staging_rows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_staging_rows" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."import_staging_rows_id_seq"'::"regclass");


--
-- Name: insight_dismissals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."insight_dismissals" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."insight_dismissals_id_seq"'::"regclass");


--
-- Name: instrument_provider_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."instrument_provider_map" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."instrument_provider_map_id_seq"'::"regclass");


--
-- Name: investments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."investments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."investments_id_seq"'::"regclass");


--
-- Name: planned_transaction_executions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_executions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."planned_transaction_executions_id_seq"'::"regclass");


--
-- Name: planned_transaction_loan_schedule id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_loan_schedule" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."planned_transaction_loan_schedule_id_seq"'::"regclass");


--
-- Name: planned_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transactions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."planned_transactions_id_seq"'::"regclass");


--
-- Name: portfolio_import_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_import_batches" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."portfolio_import_batches_id_seq"'::"regclass");


--
-- Name: portfolio_import_staging_rows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_import_staging_rows" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."portfolio_import_staging_rows_id_seq"'::"regclass");


--
-- Name: portfolio_performance_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_performance_snapshots" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."portfolio_performance_snapshots_id_seq"'::"regclass");


--
-- Name: portfolio_retag_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_retag_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."portfolio_retag_audit_id_seq"'::"regclass");


--
-- Name: portfolio_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_transactions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."portfolio_transactions_id_seq"'::"regclass");


--
-- Name: recipient_bank_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipient_bank_accounts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."recipient_bank_accounts_id_seq"'::"regclass");


--
-- Name: recipient_match_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipient_match_patterns" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."recipient_match_patterns_id_seq"'::"regclass");


--
-- Name: recipients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipients" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."recipients_id_seq"'::"regclass");


--
-- Name: saved_charts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_charts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."saved_charts_id_seq"'::"regclass");


--
-- Name: split_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."split_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."split_audit_id_seq"'::"regclass");


--
-- Name: split_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."split_payments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."split_payments_id_seq"'::"regclass");


--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tags" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."tags_id_seq"'::"regclass");


--
-- Name: transaction_source_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_source_links" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."transaction_source_links_id_seq"'::"regclass");


--
-- Name: transaction_source_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_source_records" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."transaction_source_records_id_seq"'::"regclass");


--
-- Name: transaction_splits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_splits" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."transaction_splits_id_seq"'::"regclass");


--
-- Name: transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."transactions_id_seq"'::"regclass");


--
-- Name: watchlist id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."watchlist" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."watchlist_id_seq"'::"regclass");


--
-- Data for Name: account_statement_balances; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: accounts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: adr109_legacy_cleanup_marker; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."adr109_legacy_cleanup_marker" VALUES (true, now());


--
-- Data for Name: agg_split_outstanding; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_conversations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_disclosure_grants; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_disclosure_records; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_investigation_jobs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_investigation_steps; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_messages; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_reference_entries; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_reference_scopes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_research_documents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_research_passages; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: alembic_version; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."alembic_version" VALUES ('0119_squashed_baseline');


--
-- Data for Name: analysis_monitor_notifications; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: analysis_monitor_observations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: analysis_monitors; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: asset_price_history; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: attachments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: audit_chain_checkpoints; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: audit_chain_entries; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."audit_chain_entries" ("sequence", "version", "previous_hash", "entry_hash", "payload") VALUES (1, 1, '0000000000000000000000000000000000000000000000000000000000000000', 'cdf2d2905aaca3a8f907b01196116caf01c2f50cbac9511cdf17a7a9649d21f8', '{"stream":"schema_migration","event":"baseline_installed","direction":"bootstrap","revision":"0119_squashed_baseline","heads":["0119_squashed_baseline"]}'::jsonb);


--
-- Data for Name: audit_chain_head; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."audit_chain_head" ("singleton", "last_sequence", "last_hash", "legacy_db_editor_max_id", "legacy_split_max_id", "legacy_retag_max_id") VALUES (true, 1, 'cdf2d2905aaca3a8f907b01196116caf01c2f50cbac9511cdf17a7a9649d21f8', 0, 0, 0);


--
-- Data for Name: belgian_inflation_rates; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: cashflow_forecast_accuracy; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: cashflow_forecast_mc; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: cashflow_forecast_mc_rolling; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: category_merge_aliases; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: category_root_aliases; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: custom_parser_configs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: db_editor_audit; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: exchange_rates; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: import_batches; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: import_staging_rows; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: insight_cash_projections; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: insight_digest_state; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."insight_digest_state" VALUES (1, NULL, 4, 0, NULL, NULL);


--
-- Data for Name: insight_dismissals; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: instrument_provider_map; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: investment_ticker_prefs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: investments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: manual_transaction_dedup_claims; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: planned_transaction_executions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: planned_transaction_loan_schedule; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: planned_transaction_tags; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: planned_transactions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: portfolio_broker_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: portfolio_exposure_classifications; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: portfolio_fund_holdings_documents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: portfolio_import_batches; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: portfolio_import_staging_rows; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: portfolio_performance_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: portfolio_retag_audit; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: portfolio_snapshot_accounts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: portfolio_transactions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: provider_api_keys; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: provider_health; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: provider_quota; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: recipient_bank_accounts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: recipient_match_patterns; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: recipients; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: research_dossier_links; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: research_dossier_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: research_dossiers; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: saved_analyses; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: saved_analysis_definition_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: saved_analysis_runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: saved_chart_categories; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: saved_chart_recipients; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: saved_chart_tags; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: saved_charts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: split_audit; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: split_payments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tags; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: transaction_source_links; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: transaction_source_records; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: transaction_splits; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: transaction_tags; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: transactions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: transfer_dismissals; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: user_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: watchlist; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."accounts_id_seq"', 1, false);


--
-- Name: asset_price_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."asset_price_history_id_seq"', 1, false);


--
-- Name: attachments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."attachments_id_seq"', 1, false);


--
-- Name: audit_chain_checkpoints_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."audit_chain_checkpoints_id_seq"', 1, false);


--
-- Name: belgian_inflation_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."belgian_inflation_rates_id_seq"', 1, false);


--
-- Name: cashflow_forecast_accuracy_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."cashflow_forecast_accuracy_id_seq"', 1, false);


--
-- Name: cashflow_forecast_mc_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."cashflow_forecast_mc_id_seq"', 1, false);


--
-- Name: cashflow_forecast_mc_rolling_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."cashflow_forecast_mc_rolling_id_seq"', 1, false);


--
-- Name: categories_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."categories_id_seq"', 1, false);


--
-- Name: custom_parser_configs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."custom_parser_configs_id_seq"', 1, false);


--
-- Name: db_editor_audit_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."db_editor_audit_id_seq"', 1, false);


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."exchange_rates_id_seq"', 1, false);


--
-- Name: import_batches_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."import_batches_id_seq"', 1, false);


--
-- Name: import_staging_rows_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."import_staging_rows_id_seq"', 1, false);


--
-- Name: insight_dismissals_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."insight_dismissals_id_seq"', 1, false);


--
-- Name: instrument_provider_map_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."instrument_provider_map_id_seq"', 1, false);


--
-- Name: investments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."investments_id_seq"', 1, false);


--
-- Name: planned_transaction_executions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."planned_transaction_executions_id_seq"', 1, false);


--
-- Name: planned_transaction_loan_schedule_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."planned_transaction_loan_schedule_id_seq"', 1, false);


--
-- Name: planned_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."planned_transactions_id_seq"', 1, false);


--
-- Name: portfolio_import_batches_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."portfolio_import_batches_id_seq"', 1, false);


--
-- Name: portfolio_import_staging_rows_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."portfolio_import_staging_rows_id_seq"', 1, false);


--
-- Name: portfolio_performance_snapshots_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."portfolio_performance_snapshots_id_seq"', 1, false);


--
-- Name: portfolio_retag_audit_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."portfolio_retag_audit_id_seq"', 1, false);


--
-- Name: portfolio_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."portfolio_transactions_id_seq"', 1, false);


--
-- Name: recipient_bank_accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."recipient_bank_accounts_id_seq"', 1, false);


--
-- Name: recipient_match_patterns_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."recipient_match_patterns_id_seq"', 1, false);


--
-- Name: recipients_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."recipients_id_seq"', 1, false);


--
-- Name: saved_charts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."saved_charts_id_seq"', 1, false);


--
-- Name: split_audit_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."split_audit_id_seq"', 1, false);


--
-- Name: split_payments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."split_payments_id_seq"', 1, false);


--
-- Name: tags_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."tags_id_seq"', 1, false);


--
-- Name: transaction_source_links_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."transaction_source_links_id_seq"', 1, false);


--
-- Name: transaction_source_records_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."transaction_source_records_id_seq"', 1, false);


--
-- Name: transaction_splits_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."transaction_splits_id_seq"', 1, false);


--
-- Name: transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."transactions_id_seq"', 1, false);


--
-- Name: watchlist_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('"public"."watchlist_id_seq"', 1, false);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_pkey" PRIMARY KEY ("id");


--
-- Name: adr109_legacy_cleanup_marker adr109_legacy_cleanup_marker_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."adr109_legacy_cleanup_marker"
    ADD CONSTRAINT "adr109_legacy_cleanup_marker_pkey" PRIMARY KEY ("singleton");


--
-- Name: agg_split_outstanding agg_split_outstanding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agg_split_outstanding"
    ADD CONSTRAINT "agg_split_outstanding_pkey" PRIMARY KEY ("split_id");


--
-- Name: ai_conversations ai_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_conversations"
    ADD CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id");


--
-- Name: ai_disclosure_grants ai_disclosure_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_disclosure_grants"
    ADD CONSTRAINT "ai_disclosure_grants_pkey" PRIMARY KEY ("id");


--
-- Name: ai_disclosure_records ai_disclosure_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_disclosure_records"
    ADD CONSTRAINT "ai_disclosure_records_pkey" PRIMARY KEY ("id");


--
-- Name: ai_investigation_jobs ai_investigation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_investigation_jobs"
    ADD CONSTRAINT "ai_investigation_jobs_pkey" PRIMARY KEY ("id");


--
-- Name: ai_investigation_steps ai_investigation_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_investigation_steps"
    ADD CONSTRAINT "ai_investigation_steps_pkey" PRIMARY KEY ("job_id", "step_id");


--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_messages"
    ADD CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id");


--
-- Name: ai_reference_entries ai_reference_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_reference_entries"
    ADD CONSTRAINT "ai_reference_entries_pkey" PRIMARY KEY ("scope_id", "token");


--
-- Name: ai_reference_entries ai_reference_entries_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_reference_entries"
    ADD CONSTRAINT "ai_reference_entries_token_key" UNIQUE ("token");


--
-- Name: ai_reference_scopes ai_reference_scopes_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_reference_scopes"
    ADD CONSTRAINT "ai_reference_scopes_job_id_key" UNIQUE ("job_id");


--
-- Name: ai_reference_scopes ai_reference_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_reference_scopes"
    ADD CONSTRAINT "ai_reference_scopes_pkey" PRIMARY KEY ("id");


--
-- Name: ai_research_documents ai_research_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_research_documents"
    ADD CONSTRAINT "ai_research_documents_pkey" PRIMARY KEY ("id");


--
-- Name: ai_research_documents ai_research_documents_source_name_content_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_research_documents"
    ADD CONSTRAINT "ai_research_documents_source_name_content_sha256_key" UNIQUE ("source_name", "content_sha256");


--
-- Name: ai_research_documents ai_research_documents_source_name_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_research_documents"
    ADD CONSTRAINT "ai_research_documents_source_name_version_key" UNIQUE ("source_name", "version");


--
-- Name: ai_research_passages ai_research_passages_document_id_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_research_passages"
    ADD CONSTRAINT "ai_research_passages_document_id_ordinal_key" UNIQUE ("document_id", "ordinal");


--
-- Name: ai_research_passages ai_research_passages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_research_passages"
    ADD CONSTRAINT "ai_research_passages_pkey" PRIMARY KEY ("id");


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."alembic_version"
    ADD CONSTRAINT "alembic_version_pkc" PRIMARY KEY ("version_num");


--
-- Name: analysis_monitor_notifications analysis_monitor_notifications_monitor_id_episode_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitor_notifications"
    ADD CONSTRAINT "analysis_monitor_notifications_monitor_id_episode_key_key" UNIQUE ("monitor_id", "episode_key");


--
-- Name: analysis_monitor_notifications analysis_monitor_notifications_observation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitor_notifications"
    ADD CONSTRAINT "analysis_monitor_notifications_observation_id_key" UNIQUE ("observation_id");


--
-- Name: analysis_monitor_notifications analysis_monitor_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitor_notifications"
    ADD CONSTRAINT "analysis_monitor_notifications_pkey" PRIMARY KEY ("id");


--
-- Name: analysis_monitor_observations analysis_monitor_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitor_observations"
    ADD CONSTRAINT "analysis_monitor_observations_pkey" PRIMARY KEY ("id");


--
-- Name: analysis_monitors analysis_monitors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitors"
    ADD CONSTRAINT "analysis_monitors_pkey" PRIMARY KEY ("id");


--
-- Name: asset_price_history asset_price_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."asset_price_history"
    ADD CONSTRAINT "asset_price_history_pkey" PRIMARY KEY ("id");


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attachments"
    ADD CONSTRAINT "attachments_pkey" PRIMARY KEY ("id");


--
-- Name: audit_chain_checkpoints audit_chain_checkpoints_anchor_kind_receipt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_chain_checkpoints"
    ADD CONSTRAINT "audit_chain_checkpoints_anchor_kind_receipt_id_key" UNIQUE ("anchor_kind", "receipt_id");


--
-- Name: audit_chain_checkpoints audit_chain_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_chain_checkpoints"
    ADD CONSTRAINT "audit_chain_checkpoints_pkey" PRIMARY KEY ("id");


--
-- Name: audit_chain_entries audit_chain_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_chain_entries"
    ADD CONSTRAINT "audit_chain_entries_pkey" PRIMARY KEY ("sequence");


--
-- Name: audit_chain_head audit_chain_head_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_chain_head"
    ADD CONSTRAINT "audit_chain_head_pkey" PRIMARY KEY ("singleton");


--
-- Name: belgian_inflation_rates belgian_inflation_rates_month_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."belgian_inflation_rates"
    ADD CONSTRAINT "belgian_inflation_rates_month_date_key" UNIQUE ("month_date");


--
-- Name: belgian_inflation_rates belgian_inflation_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."belgian_inflation_rates"
    ADD CONSTRAINT "belgian_inflation_rates_pkey" PRIMARY KEY ("id");


--
-- Name: cashflow_forecast_accuracy cashflow_forecast_accuracy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cashflow_forecast_accuracy"
    ADD CONSTRAINT "cashflow_forecast_accuracy_pkey" PRIMARY KEY ("id");


--
-- Name: cashflow_forecast_mc cashflow_forecast_mc_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cashflow_forecast_mc"
    ADD CONSTRAINT "cashflow_forecast_mc_pkey" PRIMARY KEY ("id");


--
-- Name: cashflow_forecast_mc_rolling cashflow_forecast_mc_rolling_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cashflow_forecast_mc_rolling"
    ADD CONSTRAINT "cashflow_forecast_mc_rolling_pkey" PRIMARY KEY ("id");


--
-- Name: cashflow_forecast_mc_rolling cashflow_forecast_mc_rolling_user_id_today_iso_days_back_da_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cashflow_forecast_mc_rolling"
    ADD CONSTRAINT "cashflow_forecast_mc_rolling_user_id_today_iso_days_back_da_key" UNIQUE ("user_id", "today_iso", "days_back", "days_forward", "filter_hash");


--
-- Name: cashflow_forecast_mc cashflow_forecast_mc_user_id_month_filter_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cashflow_forecast_mc"
    ADD CONSTRAINT "cashflow_forecast_mc_user_id_month_filter_hash_key" UNIQUE ("user_id", "month", "filter_hash");


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");


--
-- Name: category_merge_aliases category_merge_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."category_merge_aliases"
    ADD CONSTRAINT "category_merge_aliases_pkey" PRIMARY KEY ("general", "detail");


--
-- Name: category_root_aliases category_root_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."category_root_aliases"
    ADD CONSTRAINT "category_root_aliases_pkey" PRIMARY KEY ("general");


--
-- Name: custom_parser_configs custom_parser_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."custom_parser_configs"
    ADD CONSTRAINT "custom_parser_configs_pkey" PRIMARY KEY ("id");


--
-- Name: db_editor_audit db_editor_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."db_editor_audit"
    ADD CONSTRAINT "db_editor_audit_pkey" PRIMARY KEY ("id");


--
-- Name: exchange_rates exchange_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id");


--
-- Name: import_batches import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id");


--
-- Name: import_staging_rows import_staging_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_staging_rows"
    ADD CONSTRAINT "import_staging_rows_pkey" PRIMARY KEY ("id");


--
-- Name: insight_cash_projections insight_cash_projections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."insight_cash_projections"
    ADD CONSTRAINT "insight_cash_projections_pkey" PRIMARY KEY ("month_start", "currency", "method_id");


--
-- Name: insight_digest_state insight_digest_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."insight_digest_state"
    ADD CONSTRAINT "insight_digest_state_pkey" PRIMARY KEY ("singleton_id");


--
-- Name: insight_dismissals insight_dismissals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."insight_dismissals"
    ADD CONSTRAINT "insight_dismissals_pkey" PRIMARY KEY ("id");


--
-- Name: instrument_provider_map instrument_provider_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."instrument_provider_map"
    ADD CONSTRAINT "instrument_provider_map_pkey" PRIMARY KEY ("id");


--
-- Name: investment_ticker_prefs investment_ticker_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."investment_ticker_prefs"
    ADD CONSTRAINT "investment_ticker_prefs_pkey" PRIMARY KEY ("investment_id");


--
-- Name: investments investments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."investments"
    ADD CONSTRAINT "investments_pkey" PRIMARY KEY ("id");


--
-- Name: manual_transaction_dedup_claims manual_transaction_dedup_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."manual_transaction_dedup_claims"
    ADD CONSTRAINT "manual_transaction_dedup_claims_pkey" PRIMARY KEY ("deduplication_hash");


--
-- Name: account_statement_balances pk_account_statement_balances; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."account_statement_balances"
    ADD CONSTRAINT "pk_account_statement_balances" PRIMARY KEY ("account_id", "currency");


--
-- Name: saved_chart_categories pk_saved_chart_categories; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_chart_categories"
    ADD CONSTRAINT "pk_saved_chart_categories" PRIMARY KEY ("saved_chart_id", "category_id");


--
-- Name: saved_chart_recipients pk_saved_chart_recipients; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_chart_recipients"
    ADD CONSTRAINT "pk_saved_chart_recipients" PRIMARY KEY ("saved_chart_id", "recipient_id");


--
-- Name: saved_chart_tags pk_saved_chart_tags; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_chart_tags"
    ADD CONSTRAINT "pk_saved_chart_tags" PRIMARY KEY ("saved_chart_id", "tag_id");


--
-- Name: planned_transaction_executions planned_transaction_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_executions"
    ADD CONSTRAINT "planned_transaction_executions_pkey" PRIMARY KEY ("id");


--
-- Name: planned_transaction_loan_schedule planned_transaction_loan_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_loan_schedule"
    ADD CONSTRAINT "planned_transaction_loan_schedule_pkey" PRIMARY KEY ("id");


--
-- Name: planned_transaction_tags planned_transaction_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_tags"
    ADD CONSTRAINT "planned_transaction_tags_pkey" PRIMARY KEY ("planned_transaction_id", "tag_id");


--
-- Name: planned_transactions planned_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transactions"
    ADD CONSTRAINT "planned_transactions_pkey" PRIMARY KEY ("id");


--
-- Name: portfolio_broker_snapshots portfolio_broker_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_broker_snapshots"
    ADD CONSTRAINT "portfolio_broker_snapshots_pkey" PRIMARY KEY ("snapshot_date", "currency", "account_key");


--
-- Name: portfolio_exposure_classifications portfolio_exposure_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_exposure_classifications"
    ADD CONSTRAINT "portfolio_exposure_classifications_pkey" PRIMARY KEY ("id");


--
-- Name: portfolio_fund_holdings_documents portfolio_fund_holdings_documents_investment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_fund_holdings_documents"
    ADD CONSTRAINT "portfolio_fund_holdings_documents_investment_id_key" UNIQUE ("investment_id");


--
-- Name: portfolio_fund_holdings_documents portfolio_fund_holdings_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_fund_holdings_documents"
    ADD CONSTRAINT "portfolio_fund_holdings_documents_pkey" PRIMARY KEY ("id");


--
-- Name: portfolio_import_batches portfolio_import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_import_batches"
    ADD CONSTRAINT "portfolio_import_batches_pkey" PRIMARY KEY ("id");


--
-- Name: portfolio_import_staging_rows portfolio_import_staging_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_import_staging_rows"
    ADD CONSTRAINT "portfolio_import_staging_rows_pkey" PRIMARY KEY ("id");


--
-- Name: portfolio_performance_snapshots portfolio_performance_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_performance_snapshots"
    ADD CONSTRAINT "portfolio_performance_snapshots_pkey" PRIMARY KEY ("id");


--
-- Name: portfolio_retag_audit portfolio_retag_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_retag_audit"
    ADD CONSTRAINT "portfolio_retag_audit_pkey" PRIMARY KEY ("id");


--
-- Name: portfolio_snapshot_accounts portfolio_snapshot_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_snapshot_accounts"
    ADD CONSTRAINT "portfolio_snapshot_accounts_pkey" PRIMARY KEY ("snapshot_date", "currency", "account_key");


--
-- Name: portfolio_transactions portfolio_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_transactions"
    ADD CONSTRAINT "portfolio_transactions_pkey" PRIMARY KEY ("id");


--
-- Name: provider_api_keys provider_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_api_keys"
    ADD CONSTRAINT "provider_api_keys_pkey" PRIMARY KEY ("provider");


--
-- Name: provider_health provider_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_health"
    ADD CONSTRAINT "provider_health_pkey" PRIMARY KEY ("provider");


--
-- Name: provider_quota provider_quota_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_quota"
    ADD CONSTRAINT "provider_quota_pkey" PRIMARY KEY ("provider", "window_date");


--
-- Name: recipient_bank_accounts recipient_bank_accounts_account_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipient_bank_accounts"
    ADD CONSTRAINT "recipient_bank_accounts_account_number_key" UNIQUE ("account_number");


--
-- Name: recipient_bank_accounts recipient_bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipient_bank_accounts"
    ADD CONSTRAINT "recipient_bank_accounts_pkey" PRIMARY KEY ("id");


--
-- Name: recipient_match_patterns recipient_match_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipient_match_patterns"
    ADD CONSTRAINT "recipient_match_patterns_pkey" PRIMARY KEY ("id");


--
-- Name: recipients recipients_normalized_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipients"
    ADD CONSTRAINT "recipients_normalized_name_key" UNIQUE ("normalized_name");


--
-- Name: recipients recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipients"
    ADD CONSTRAINT "recipients_pkey" PRIMARY KEY ("id");


--
-- Name: research_dossier_links research_dossier_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."research_dossier_links"
    ADD CONSTRAINT "research_dossier_links_pkey" PRIMARY KEY ("dossier_id", "link_type", "ordinal");


--
-- Name: research_dossier_versions research_dossier_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."research_dossier_versions"
    ADD CONSTRAINT "research_dossier_versions_pkey" PRIMARY KEY ("dossier_id", "version");


--
-- Name: research_dossiers research_dossiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."research_dossiers"
    ADD CONSTRAINT "research_dossiers_pkey" PRIMARY KEY ("id");


--
-- Name: saved_analyses saved_analyses_definition_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_analyses"
    ADD CONSTRAINT "saved_analyses_definition_id_key" UNIQUE ("definition_id");


--
-- Name: saved_analyses saved_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_analyses"
    ADD CONSTRAINT "saved_analyses_pkey" PRIMARY KEY ("id");


--
-- Name: saved_analysis_definition_versions saved_analysis_definition_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_analysis_definition_versions"
    ADD CONSTRAINT "saved_analysis_definition_versions_pkey" PRIMARY KEY ("saved_analysis_id", "version");


--
-- Name: saved_analysis_runs saved_analysis_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_analysis_runs"
    ADD CONSTRAINT "saved_analysis_runs_pkey" PRIMARY KEY ("id");


--
-- Name: saved_charts saved_charts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_charts"
    ADD CONSTRAINT "saved_charts_pkey" PRIMARY KEY ("id");


--
-- Name: split_audit split_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."split_audit"
    ADD CONSTRAINT "split_audit_pkey" PRIMARY KEY ("id");


--
-- Name: split_payments split_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."split_payments"
    ADD CONSTRAINT "split_payments_pkey" PRIMARY KEY ("id");


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");


--
-- Name: transaction_source_links transaction_source_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_source_links"
    ADD CONSTRAINT "transaction_source_links_pkey" PRIMARY KEY ("id");


--
-- Name: transaction_source_records transaction_source_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_source_records"
    ADD CONSTRAINT "transaction_source_records_pkey" PRIMARY KEY ("id");


--
-- Name: transaction_splits transaction_splits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_splits"
    ADD CONSTRAINT "transaction_splits_pkey" PRIMARY KEY ("id");


--
-- Name: transaction_tags transaction_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_tags"
    ADD CONSTRAINT "transaction_tags_pkey" PRIMARY KEY ("transaction_id", "tag_id");


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_pkey" PRIMARY KEY ("id");


--
-- Name: transfer_dismissals transfer_dismissals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transfer_dismissals"
    ADD CONSTRAINT "transfer_dismissals_pkey" PRIMARY KEY ("txn_a_id", "txn_b_id");


--
-- Name: asset_price_history uq_asset_price_history_investment_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."asset_price_history"
    ADD CONSTRAINT "uq_asset_price_history_investment_date" UNIQUE ("investment_id", "price_date");


--
-- Name: cashflow_forecast_accuracy uq_cfa_user_method_month; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cashflow_forecast_accuracy"
    ADD CONSTRAINT "uq_cfa_user_method_month" UNIQUE ("user_id", "method_id", "as_of_month");


--
-- Name: exchange_rates uq_currency_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "uq_currency_date" UNIQUE ("currency_code", "rate_date");


--
-- Name: categories uq_general_detail; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "uq_general_detail" UNIQUE ("general", "detail");


--
-- Name: portfolio_retag_audit uq_portfolio_retag_audit_idempotency_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_retag_audit"
    ADD CONSTRAINT "uq_portfolio_retag_audit_idempotency_key" UNIQUE ("idempotency_key");


--
-- Name: portfolio_performance_snapshots uq_pps_date_currency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_performance_snapshots"
    ADD CONSTRAINT "uq_pps_date_currency" UNIQUE ("snapshot_date", "currency");


--
-- Name: planned_transaction_loan_schedule uq_ptls_planned_installment; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_loan_schedule"
    ADD CONSTRAINT "uq_ptls_planned_installment" UNIQUE ("planned_transaction_id", "installment_number");


--
-- Name: transaction_source_links uq_transaction_source_link; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_source_links"
    ADD CONSTRAINT "uq_transaction_source_link" UNIQUE ("source_record_id", "legacy_transaction_id");


--
-- Name: transaction_source_records uq_transaction_source_record; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_source_records"
    ADD CONSTRAINT "uq_transaction_source_record" UNIQUE ("source_type", "legacy_source_id");


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_pkey" PRIMARY KEY ("key");


--
-- Name: watchlist watchlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."watchlist"
    ADD CONSTRAINT "watchlist_pkey" PRIMARY KEY ("id");


--
-- Name: idx_agg_split_outstanding_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agg_split_outstanding_open" ON "public"."agg_split_outstanding" USING "btree" ("recipient_id") WHERE ("outstanding_amount" <> (0)::numeric);


--
-- Name: idx_agg_split_outstanding_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agg_split_outstanding_recipient" ON "public"."agg_split_outstanding" USING "btree" ("recipient_id");


--
-- Name: idx_ai_conversations_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_conversations_updated_at" ON "public"."ai_conversations" USING "btree" ("updated_at" DESC);


--
-- Name: idx_ai_disclosure_records_grant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_disclosure_records_grant_created" ON "public"."ai_disclosure_records" USING "btree" ("grant_id", "created_at" DESC);


--
-- Name: idx_ai_disclosure_records_job_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_disclosure_records_job_created" ON "public"."ai_disclosure_records" USING "btree" ("job_id", "created_at" DESC);


--
-- Name: idx_ai_investigation_jobs_state_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_investigation_jobs_state_updated" ON "public"."ai_investigation_jobs" USING "btree" ("state", "updated_at" DESC);


--
-- Name: idx_ai_messages_conv_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_messages_conv_created" ON "public"."ai_messages" USING "btree" ("conversation_id", "created_at");


--
-- Name: idx_ai_reference_scopes_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_reference_scopes_expiry" ON "public"."ai_reference_scopes" USING "btree" ("expires_at");


--
-- Name: idx_ai_research_passages_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_research_passages_document" ON "public"."ai_research_passages" USING "btree" ("document_id", "ordinal");


--
-- Name: idx_ai_research_passages_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_research_passages_search" ON "public"."ai_research_passages" USING "gin" ("search_vector");


--
-- Name: idx_analysis_monitor_notifications_inbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analysis_monitor_notifications_inbox" ON "public"."analysis_monitor_notifications" USING "btree" ("created_at" DESC, "id" DESC);


--
-- Name: idx_analysis_monitor_observations_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analysis_monitor_observations_history" ON "public"."analysis_monitor_observations" USING "btree" ("monitor_id", "checked_at" DESC, "id" DESC);


--
-- Name: idx_analysis_monitors_dossier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analysis_monitors_dossier" ON "public"."analysis_monitors" USING "btree" ("dossier_id") WHERE ("dossier_id" IS NOT NULL);


--
-- Name: idx_analysis_monitors_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analysis_monitors_due" ON "public"."analysis_monitors" USING "btree" ("next_due_at", "id") WHERE "enabled";


--
-- Name: idx_analysis_monitors_saved_analysis; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analysis_monitors_saved_analysis" ON "public"."analysis_monitors" USING "btree" ("saved_analysis_id") WHERE ("saved_analysis_id" IS NOT NULL);


--
-- Name: idx_asset_price_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_asset_price_history_date" ON "public"."asset_price_history" USING "btree" ("price_date");


--
-- Name: idx_attachments_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_attachments_transaction_id" ON "public"."attachments" USING "btree" ("transaction_id");


--
-- Name: idx_audit_chain_checkpoints_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_chain_checkpoints_sequence" ON "public"."audit_chain_checkpoints" USING "btree" ("sequence" DESC, "id" DESC);


--
-- Name: idx_audit_chain_entries_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_chain_entries_created_at" ON "public"."audit_chain_entries" USING "btree" ("created_at", "sequence");


--
-- Name: idx_belgian_inflation_month_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_belgian_inflation_month_date" ON "public"."belgian_inflation_rates" USING "btree" ("month_date");


--
-- Name: idx_categories_detail; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_categories_detail" ON "public"."categories" USING "btree" ("detail");


--
-- Name: idx_categories_general; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_categories_general" ON "public"."categories" USING "btree" ("general");


--
-- Name: idx_categories_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_categories_parent_id" ON "public"."categories" USING "btree" ("parent_id");


--
-- Name: idx_category_merge_aliases_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_category_merge_aliases_target" ON "public"."category_merge_aliases" USING "btree" ("target_category_id");


--
-- Name: idx_cfa_as_of_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cfa_as_of_month" ON "public"."cashflow_forecast_accuracy" USING "btree" ("as_of_month");


--
-- Name: idx_cfa_user_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cfa_user_method" ON "public"."cashflow_forecast_accuracy" USING "btree" ("user_id", "method_id");


--
-- Name: idx_cfmc_user_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cfmc_user_month" ON "public"."cashflow_forecast_mc" USING "btree" ("user_id", "month");


--
-- Name: idx_cfmcr_user_today; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cfmcr_user_today" ON "public"."cashflow_forecast_mc_rolling" USING "btree" ("user_id", "today_iso");


--
-- Name: idx_db_editor_audit_table_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_db_editor_audit_table_time" ON "public"."db_editor_audit" USING "btree" ("table_name", "created_at" DESC);


--
-- Name: idx_exchange_rates_currency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exchange_rates_currency" ON "public"."exchange_rates" USING "btree" ("currency_code");


--
-- Name: idx_exchange_rates_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exchange_rates_date" ON "public"."exchange_rates" USING "btree" ("rate_date");


--
-- Name: idx_exchange_rates_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exchange_rates_latest" ON "public"."exchange_rates" USING "btree" ("is_latest");


--
-- Name: idx_import_batches_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_import_batches_started_at" ON "public"."import_batches" USING "btree" ("started_at" DESC);


--
-- Name: idx_import_batches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_import_batches_status" ON "public"."import_batches" USING "btree" ("status") WHERE ("status" <> ALL (ARRAY['complete'::"text", 'failed'::"text", 'aborted'::"text"]));


--
-- Name: idx_import_staging_rows_dedup_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_import_staging_rows_dedup_fingerprint" ON "public"."import_staging_rows" USING "btree" ("batch_id", "dedup_fingerprint_version", "dedup_fingerprint") WHERE ("dedup_fingerprint" IS NOT NULL);


--
-- Name: idx_import_staging_rows_matched_pattern_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_import_staging_rows_matched_pattern_id" ON "public"."import_staging_rows" USING "btree" ("matched_pattern_id") WHERE ("matched_pattern_id" IS NOT NULL);


--
-- Name: idx_import_staging_rows_resolved_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_import_staging_rows_resolved_recipient_id" ON "public"."import_staging_rows" USING "btree" ("resolved_recipient_id") WHERE ("resolved_recipient_id" IS NOT NULL);


--
-- Name: idx_import_staging_rows_user_override_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_import_staging_rows_user_override_recipient_id" ON "public"."import_staging_rows" USING "btree" ("user_override_recipient_id") WHERE ("user_override_recipient_id" IS NOT NULL);


--
-- Name: idx_instrument_provider_map_provider_symbol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_instrument_provider_map_provider_symbol" ON "public"."instrument_provider_map" USING "btree" ("provider", "provider_symbol");


--
-- Name: idx_investments_asset_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_investments_asset_class" ON "public"."investments" USING "btree" ("asset_class");


--
-- Name: idx_investments_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_investments_is_active" ON "public"."investments" USING "btree" ("is_active");


--
-- Name: idx_pf_staging_batch_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pf_staging_batch_status" ON "public"."portfolio_import_staging_rows" USING "btree" ("batch_id", "status");


--
-- Name: idx_ph_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ph_kind" ON "public"."provider_health" USING "btree" ("kind");


--
-- Name: idx_planned_active_executed_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_planned_active_executed_date" ON "public"."planned_transactions" USING "btree" ("is_active", "is_executed", "planned_date");


--
-- Name: idx_planned_transaction_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_planned_transaction_tags_tag" ON "public"."planned_transaction_tags" USING "btree" ("tag_id");


--
-- Name: idx_planned_transactions_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_planned_transactions_account_id" ON "public"."planned_transactions" USING "btree" ("account_id");


--
-- Name: idx_portfolio_broker_snapshots_currency_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_broker_snapshots_currency_date" ON "public"."portfolio_broker_snapshots" USING "btree" ("currency", "snapshot_date");


--
-- Name: idx_portfolio_fund_holdings_as_of; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_fund_holdings_as_of" ON "public"."portfolio_fund_holdings_documents" USING "btree" ("source_as_of_date" DESC);


--
-- Name: idx_portfolio_import_batches_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_import_batches_account_id" ON "public"."portfolio_import_batches" USING "btree" ("account_id");


--
-- Name: idx_portfolio_import_batches_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_import_batches_started_at" ON "public"."portfolio_import_batches" USING "btree" ("started_at" DESC);


--
-- Name: idx_portfolio_import_batches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_import_batches_status" ON "public"."portfolio_import_batches" USING "btree" ("status") WHERE ("status" <> ALL (ARRAY['complete'::"text", 'failed'::"text", 'aborted'::"text"]));


--
-- Name: idx_portfolio_import_staging_rows_dedup_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_import_staging_rows_dedup_fingerprint" ON "public"."portfolio_import_staging_rows" USING "btree" ("batch_id", "dedup_fingerprint_version", "dedup_fingerprint") WHERE ("dedup_fingerprint" IS NOT NULL);


--
-- Name: idx_portfolio_import_staging_rows_resolved_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_import_staging_rows_resolved_investment_id" ON "public"."portfolio_import_staging_rows" USING "btree" ("resolved_investment_id") WHERE ("resolved_investment_id" IS NOT NULL);


--
-- Name: idx_portfolio_import_staging_rows_user_override_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_import_staging_rows_user_override_investment_id" ON "public"."portfolio_import_staging_rows" USING "btree" ("user_override_investment_id") WHERE ("user_override_investment_id" IS NOT NULL);


--
-- Name: idx_portfolio_performance_snapshots_currency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_performance_snapshots_currency" ON "public"."portfolio_performance_snapshots" USING "btree" ("currency");


--
-- Name: idx_portfolio_transactions_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_transactions_account_id" ON "public"."portfolio_transactions" USING "btree" ("account_id");


--
-- Name: idx_portfolio_transactions_import_batch_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_transactions_import_batch_id" ON "public"."portfolio_transactions" USING "btree" ("import_batch_id") WHERE ("import_batch_id" IS NOT NULL);


--
-- Name: idx_portfolio_txn_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_txn_date" ON "public"."portfolio_transactions" USING "btree" ("date");


--
-- Name: idx_portfolio_txn_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_txn_investment_id" ON "public"."portfolio_transactions" USING "btree" ("investment_id");


--
-- Name: idx_portfolio_txn_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_portfolio_txn_type" ON "public"."portfolio_transactions" USING "btree" ("type");


--
-- Name: idx_pt_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pt_category_id" ON "public"."planned_transactions" USING "btree" ("category_id");


--
-- Name: idx_pt_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pt_is_active" ON "public"."planned_transactions" USING "btree" ("is_active");


--
-- Name: idx_pt_is_executed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pt_is_executed" ON "public"."planned_transactions" USING "btree" ("is_executed");


--
-- Name: idx_pt_is_loan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pt_is_loan" ON "public"."planned_transactions" USING "btree" ("is_loan");


--
-- Name: idx_pt_is_recurring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pt_is_recurring" ON "public"."planned_transactions" USING "btree" ("is_recurring");


--
-- Name: idx_pt_planned_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pt_planned_date" ON "public"."planned_transactions" USING "btree" ("planned_date");


--
-- Name: idx_pt_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pt_recipient_id" ON "public"."planned_transactions" USING "btree" ("recipient_id");


--
-- Name: idx_pte_executed_tx_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pte_executed_tx_id" ON "public"."planned_transaction_executions" USING "btree" ("executed_transaction_id");


--
-- Name: idx_pte_planned_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pte_planned_id" ON "public"."planned_transaction_executions" USING "btree" ("planned_transaction_id");


--
-- Name: idx_ptls_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ptls_due_date" ON "public"."planned_transaction_loan_schedule" USING "btree" ("due_date");


--
-- Name: idx_ptls_planned_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ptls_planned_transaction_id" ON "public"."planned_transaction_loan_schedule" USING "btree" ("planned_transaction_id");


--
-- Name: idx_ptxn_investment_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ptxn_investment_account" ON "public"."portfolio_transactions" USING "btree" ("investment_id", "account_id");


--
-- Name: idx_ptxn_investment_date_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ptxn_investment_date_id" ON "public"."portfolio_transactions" USING "btree" ("investment_id", "date", "id");


--
-- Name: idx_rba_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rba_recipient_id" ON "public"."recipient_bank_accounts" USING "btree" ("recipient_id");


--
-- Name: idx_recipients_default_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_recipients_default_category_id" ON "public"."recipients" USING "btree" ("default_category_id");


--
-- Name: idx_recipients_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_recipients_name" ON "public"."recipients" USING "btree" ("name");


--
-- Name: idx_recipients_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_recipients_name_trgm" ON "public"."recipients" USING "gin" ("name" "public"."gin_trgm_ops");


--
-- Name: idx_recipients_primary_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_recipients_primary_recipient_id" ON "public"."recipients" USING "btree" ("primary_recipient_id");


--
-- Name: idx_research_dossier_links_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_research_dossier_links_category" ON "public"."research_dossier_links" USING "btree" ("category_id") WHERE ("category_id" IS NOT NULL);


--
-- Name: idx_research_dossier_links_investment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_research_dossier_links_investment" ON "public"."research_dossier_links" USING "btree" ("investment_id") WHERE ("investment_id" IS NOT NULL);


--
-- Name: idx_research_dossier_links_saved_analysis; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_research_dossier_links_saved_analysis" ON "public"."research_dossier_links" USING "btree" ("saved_analysis_id") WHERE ("saved_analysis_id" IS NOT NULL);


--
-- Name: idx_research_dossiers_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_research_dossiers_workspace_updated" ON "public"."research_dossiers" USING "btree" ("workspace", "updated_at" DESC, "id");


--
-- Name: idx_rmp_active_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rmp_active_priority" ON "public"."recipient_match_patterns" USING "btree" ("priority") WHERE ("is_active" = true);


--
-- Name: idx_rmp_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rmp_recipient" ON "public"."recipient_match_patterns" USING "btree" ("recipient_id");


--
-- Name: idx_saved_analyses_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_saved_analyses_workspace_updated" ON "public"."saved_analyses" USING "btree" ("workspace", "updated_at" DESC);


--
-- Name: idx_saved_analysis_runs_analysis_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_saved_analysis_runs_analysis_created" ON "public"."saved_analysis_runs" USING "btree" ("saved_analysis_id", "created_at" DESC);


--
-- Name: idx_saved_chart_categories_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_saved_chart_categories_category" ON "public"."saved_chart_categories" USING "btree" ("category_id");


--
-- Name: idx_saved_chart_recipients_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_saved_chart_recipients_recipient" ON "public"."saved_chart_recipients" USING "btree" ("recipient_id");


--
-- Name: idx_saved_chart_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_saved_chart_tags_tag" ON "public"."saved_chart_tags" USING "btree" ("tag_id");


--
-- Name: idx_snapshot_accounts_currency_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_snapshot_accounts_currency_date" ON "public"."portfolio_snapshot_accounts" USING "btree" ("currency", "snapshot_date");


--
-- Name: idx_split_audit_split_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_split_audit_split_id" ON "public"."split_audit" USING "btree" ("split_id");


--
-- Name: idx_split_payments_split; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_split_payments_split" ON "public"."split_payments" USING "btree" ("split_id");


--
-- Name: idx_splits_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_splits_recipient" ON "public"."transaction_splits" USING "btree" ("recipient_id");


--
-- Name: idx_splits_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_splits_transaction" ON "public"."transaction_splits" USING "btree" ("transaction_id");


--
-- Name: idx_splits_unsettled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_splits_unsettled" ON "public"."transaction_splits" USING "btree" ("is_settled") WHERE ("is_settled" = false);


--
-- Name: idx_staging_batch_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_staging_batch_status" ON "public"."import_staging_rows" USING "btree" ("batch_id", "status");


--
-- Name: idx_staging_override_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_staging_override_category" ON "public"."import_staging_rows" USING "btree" ("override_category_id") WHERE ("override_category_id" IS NOT NULL);


--
-- Name: idx_tags_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tags_active" ON "public"."tags" USING "btree" ("is_active") WHERE ("is_active" = true);


--
-- Name: idx_transaction_date_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transaction_date_recipient" ON "public"."transactions" USING "btree" ("date", "recipient_id");


--
-- Name: idx_transaction_source_links_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transaction_source_links_transaction_id" ON "public"."transaction_source_links" USING "btree" ("transaction_id") WHERE ("transaction_id" IS NOT NULL);


--
-- Name: idx_transaction_source_records_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transaction_source_records_hash" ON "public"."transaction_source_records" USING "btree" ("source_type", "deduplication_hash") WHERE ("deduplication_hash" IS NOT NULL);


--
-- Name: idx_transaction_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transaction_tags_tag" ON "public"."transaction_tags" USING "btree" ("tag_id");


--
-- Name: idx_transactions_abs_amount_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_abs_amount_date" ON "public"."transactions" USING "btree" ("abs"("amount"), "date");


--
-- Name: idx_transactions_account_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_account_date_active" ON "public"."transactions" USING "btree" ("account_id", "date" DESC) WHERE ("is_active" = true);


--
-- Name: idx_transactions_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_account_id" ON "public"."transactions" USING "btree" ("account_id");


--
-- Name: idx_transactions_account_stamped; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_account_stamped" ON "public"."transactions" USING "btree" ("account_id", "date" DESC, "id" DESC) WHERE (("is_active" = true) AND ("balance" IS NOT NULL));


--
-- Name: idx_transactions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_active" ON "public"."transactions" USING "btree" ("date" DESC, "id" DESC) WHERE ("is_active" = true);


--
-- Name: idx_transactions_amount_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_amount_date" ON "public"."transactions" USING "btree" ("amount", "date");


--
-- Name: idx_transactions_category_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_category_date" ON "public"."transactions" USING "btree" ("category_id", "date" DESC);


--
-- Name: idx_transactions_category_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_category_date_active" ON "public"."transactions" USING "btree" ("category_id", "date" DESC) WHERE ("is_active" = true);


--
-- Name: idx_transactions_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_category_id" ON "public"."transactions" USING "btree" ("category_id");


--
-- Name: idx_transactions_category_recipient_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_category_recipient_active" ON "public"."transactions" USING "btree" ("category_id", "recipient_id") WHERE ("is_active" = true);


--
-- Name: idx_transactions_comment_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_comment_trgm" ON "public"."transactions" USING "gin" ("comment" "public"."gin_trgm_ops");


--
-- Name: idx_transactions_import_batch_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_import_batch_id" ON "public"."transactions" USING "btree" ("import_batch_id") WHERE ("import_batch_id" IS NOT NULL);


--
-- Name: idx_transactions_matched_pattern; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_matched_pattern" ON "public"."transactions" USING "btree" ("matched_pattern_id") WHERE ("matched_pattern_id" IS NOT NULL);


--
-- Name: idx_transactions_memo_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_memo_trgm" ON "public"."transactions" USING "gin" ("memo" "public"."gin_trgm_ops");


--
-- Name: idx_transactions_recipient_bank_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_recipient_bank_account_id" ON "public"."transactions" USING "btree" ("recipient_bank_account_id");


--
-- Name: idx_transactions_recipient_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_recipient_date" ON "public"."transactions" USING "btree" ("recipient_id", "date" DESC);


--
-- Name: idx_transactions_recipient_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_recipient_date_active" ON "public"."transactions" USING "btree" ("recipient_id", "date" DESC) WHERE ("is_active" = true);


--
-- Name: idx_transactions_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_recipient_id" ON "public"."transactions" USING "btree" ("recipient_id");


--
-- Name: idx_transactions_transfer_peer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_transfer_peer" ON "public"."transactions" USING "btree" ("transfer_peer_id") WHERE ("transfer_peer_id" IS NOT NULL);


--
-- Name: idx_transfer_dismissals_b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transfer_dismissals_b" ON "public"."transfer_dismissals" USING "btree" ("txn_b_id");


--
-- Name: idx_watchlist_asset_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_watchlist_asset_class" ON "public"."watchlist" USING "btree" ("asset_class");


--
-- Name: uq_accounts_import_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_accounts_import_identity" ON "public"."accounts" USING "btree" ("import_identity");


--
-- Name: uq_accounts_name_norm; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_accounts_name_norm" ON "public"."accounts" USING "btree" ("lower"("btrim"("name")));


--
-- Name: uq_categories_root_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_categories_root_name" ON "public"."categories" USING "btree" ("name") WHERE ("parent_id" IS NULL);


--
-- Name: uq_categories_sibling_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_categories_sibling_name" ON "public"."categories" USING "btree" ("parent_id", "name") WHERE ("parent_id" IS NOT NULL);


--
-- Name: uq_custom_parser_configs_name_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_custom_parser_configs_name_kind" ON "public"."custom_parser_configs" USING "btree" ("name", "kind");


--
-- Name: uq_insight_dismissals_outlier; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_insight_dismissals_outlier" ON "public"."insight_dismissals" USING "btree" ("category_id", "month_start") WHERE ("kind" = 'category_outlier'::"text");


--
-- Name: uq_insight_dismissals_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_insight_dismissals_subscription" ON "public"."insight_dismissals" USING "btree" ("kind", "recipient_id") WHERE ("kind" = ANY (ARRAY['subscription_new'::"text", 'subscription_price_change'::"text"]));


--
-- Name: uq_instrument_provider_map_key_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_instrument_provider_map_key_provider" ON "public"."instrument_provider_map" USING "btree" ("instrument_key", "key_type", "provider");


--
-- Name: uq_portfolio_exposure_classification_identifier; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_portfolio_exposure_classification_identifier" ON "public"."portfolio_exposure_classifications" USING "btree" ("identifier_type", "identifier_value", COALESCE("identifier_exchange", ''::"text")) WHERE ("investment_id" IS NULL);


--
-- Name: uq_portfolio_exposure_classification_investment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_portfolio_exposure_classification_investment" ON "public"."portfolio_exposure_classifications" USING "btree" ("investment_id") WHERE ("investment_id" IS NOT NULL);


--
-- Name: uq_portfolio_transactions_dedup_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_portfolio_transactions_dedup_fingerprint" ON "public"."portfolio_transactions" USING "btree" ("dedup_fingerprint_version", "dedup_fingerprint") WHERE ("dedup_fingerprint" IS NOT NULL);


--
-- Name: uq_pte_planned_executed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_pte_planned_executed" ON "public"."planned_transaction_executions" USING "btree" ("planned_transaction_id", "executed_transaction_id");


--
-- Name: uq_recipient_primary_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_recipient_primary_account" ON "public"."recipient_bank_accounts" USING "btree" ("recipient_id") WHERE "is_primary";


--
-- Name: uq_tags_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_tags_slug" ON "public"."tags" USING "btree" ("slug");


--
-- Name: uq_transactions_dedup_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_transactions_dedup_fingerprint" ON "public"."transactions" USING "btree" ("dedup_fingerprint_version", "dedup_fingerprint") WHERE ("dedup_fingerprint" IS NOT NULL);


--
-- Name: uq_transactions_opening_anchor; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_transactions_opening_anchor" ON "public"."transactions" USING "btree" ("account_id", "currency") WHERE ("transfer_source" = 'opening'::"text");


--
-- Name: accounts_v1 _RETURN; Type: RULE; Schema: vision_analysis; Owner: -
--

CREATE OR REPLACE VIEW "vision_analysis"."accounts_v1" WITH ("security_barrier"='true') AS
 SELECT "a"."id" AS "account_id",
    "a"."name" AS "account_name",
    "a"."display_name",
    "a"."institution",
    "a"."currency",
    "a"."type" AS "account_type",
    "a"."liquidity_class",
    "a"."spendable",
    "a"."in_net_worth",
    "a"."tax_wrapper",
    "a"."owner",
    "a"."multi_currency_cash",
    "a"."has_cash_sleeve",
    "a"."funding_account_id",
    "a"."is_active",
    COALESCE("jsonb_agg"("jsonb_build_object"('currency', "sb"."currency", 'balance', "sb"."balance", 'balance_date', "sb"."balance_date") ORDER BY "sb"."currency") FILTER (WHERE ("sb"."account_id" IS NOT NULL)), '[]'::"jsonb") AS "statement_balances",
    "a"."created_at",
    "a"."updated_at"
   FROM ("public"."accounts" "a"
     LEFT JOIN "public"."account_statement_balances" "sb" ON (("sb"."account_id" = "a"."id")))
  GROUP BY "a"."id";


--
-- Name: audit_chain_checkpoints audit_chain_checkpoints_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_chain_checkpoints_immutable" BEFORE DELETE OR UPDATE OR TRUNCATE ON "public"."audit_chain_checkpoints" FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_chain_reject_mutation"();


--
-- Name: audit_chain_entries audit_chain_entries_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_chain_entries_immutable" BEFORE DELETE OR UPDATE OR TRUNCATE ON "public"."audit_chain_entries" FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_chain_reject_mutation"();


--
-- Name: audit_chain_head audit_chain_head_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_chain_head_no_delete" BEFORE DELETE OR TRUNCATE ON "public"."audit_chain_head" FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_chain_reject_mutation"();


--
-- Name: ai_messages trg_ai_messages_touch_conversation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_ai_messages_touch_conversation" AFTER INSERT ON "public"."ai_messages" FOR EACH ROW EXECUTE FUNCTION "public"."touch_ai_conversation_updated_at"();


--
-- Name: categories trg_categories_0_sync_legacy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_categories_0_sync_legacy" BEFORE INSERT OR UPDATE OF "general", "detail" ON "public"."categories" FOR EACH ROW EXECUTE FUNCTION "public"."category_sync_legacy_row"();


--
-- Name: categories trg_categories_acyclic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_categories_acyclic" BEFORE INSERT OR UPDATE OF "parent_id" ON "public"."categories" FOR EACH ROW EXECUTE FUNCTION "public"."category_assert_acyclic"();


--
-- Name: categories trg_categories_insight_digest_dirty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_categories_insight_digest_dirty" AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."categories" FOR EACH STATEMENT EXECUTE FUNCTION "public"."mark_insight_digest_dirty"();


--
-- Name: categories trg_categories_refresh_path_names; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_categories_refresh_path_names" AFTER INSERT OR UPDATE OF "name", "parent_id" ON "public"."categories" FOR EACH ROW EXECUTE FUNCTION "public"."category_refresh_path_names"();


--
-- Name: transactions trg_enforce_split_within_amount; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_enforce_split_within_amount" BEFORE UPDATE ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_split_within_amount"();


--
-- Name: insight_dismissals trg_insight_dismissals_digest_dirty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_insight_dismissals_digest_dirty" AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."insight_dismissals" FOR EACH STATEMENT EXECUTE FUNCTION "public"."mark_insight_digest_dirty"();


--
-- Name: planned_transactions trg_planned_transactions_insight_digest_dirty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_planned_transactions_insight_digest_dirty" AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."planned_transactions" FOR EACH STATEMENT EXECUTE FUNCTION "public"."mark_insight_digest_dirty"();


--
-- Name: recipients trg_recipients_insight_digest_dirty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_recipients_insight_digest_dirty" AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."recipients" FOR EACH STATEMENT EXECUTE FUNCTION "public"."mark_insight_digest_dirty"();


--
-- Name: research_dossier_versions trg_research_dossier_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_research_dossier_version_immutable" BEFORE UPDATE ON "public"."research_dossier_versions" FOR EACH ROW EXECUTE FUNCTION "public"."reject_research_dossier_version_update"();


--
-- Name: saved_analysis_definition_versions trg_saved_analysis_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_saved_analysis_version_immutable" BEFORE UPDATE ON "public"."saved_analysis_definition_versions" FOR EACH ROW EXECUTE FUNCTION "public"."reject_saved_analysis_version_update"();


--
-- Name: transaction_splits trg_split_outstanding_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_split_outstanding_sync" AFTER INSERT OR DELETE OR UPDATE ON "public"."transaction_splits" FOR EACH ROW EXECUTE FUNCTION "public"."fn_trg_split_sync"();


--
-- Name: split_payments trg_split_payment_outstanding_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_split_payment_outstanding_sync" AFTER INSERT OR DELETE OR UPDATE ON "public"."split_payments" FOR EACH ROW EXECUTE FUNCTION "public"."fn_trg_split_payment_sync"();


--
-- Name: transactions trg_transactions_insight_digest_dirty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_transactions_insight_digest_dirty" AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."transactions" FOR EACH STATEMENT EXECUTE FUNCTION "public"."mark_insight_digest_dirty"();


--
-- Name: accounts update_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_accounts_updated_at" BEFORE UPDATE ON "public"."accounts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: ai_conversations update_ai_conversations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_ai_conversations_updated_at" BEFORE UPDATE ON "public"."ai_conversations" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: asset_price_history update_asset_price_history_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_asset_price_history_updated_at" BEFORE UPDATE ON "public"."asset_price_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: belgian_inflation_rates update_belgian_inflation_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_belgian_inflation_updated_at" BEFORE UPDATE ON "public"."belgian_inflation_rates" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: categories update_categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_categories_updated_at" BEFORE UPDATE ON "public"."categories" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: custom_parser_configs update_custom_parser_configs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_custom_parser_configs_updated_at" BEFORE UPDATE ON "public"."custom_parser_configs" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: exchange_rates update_exchange_rates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_exchange_rates_updated_at" BEFORE UPDATE ON "public"."exchange_rates" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: import_staging_rows update_import_staging_rows_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_import_staging_rows_updated_at" BEFORE UPDATE ON "public"."import_staging_rows" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: instrument_provider_map update_instrument_provider_map_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_instrument_provider_map_updated_at" BEFORE UPDATE ON "public"."instrument_provider_map" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: investment_ticker_prefs update_investment_ticker_prefs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_investment_ticker_prefs_updated_at" BEFORE UPDATE ON "public"."investment_ticker_prefs" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: investments update_investments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_investments_updated_at" BEFORE UPDATE ON "public"."investments" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: portfolio_import_staging_rows update_portfolio_import_staging_rows_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_portfolio_import_staging_rows_updated_at" BEFORE UPDATE ON "public"."portfolio_import_staging_rows" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: portfolio_transactions update_portfolio_txn_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_portfolio_txn_updated_at" BEFORE UPDATE ON "public"."portfolio_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: provider_api_keys update_provider_api_keys_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_provider_api_keys_updated_at" BEFORE UPDATE ON "public"."provider_api_keys" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: provider_health update_provider_health_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_provider_health_updated_at" BEFORE UPDATE ON "public"."provider_health" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: provider_quota update_provider_quota_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_provider_quota_updated_at" BEFORE UPDATE ON "public"."provider_quota" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: planned_transactions update_pt_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_pt_updated_at" BEFORE UPDATE ON "public"."planned_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: planned_transaction_loan_schedule update_ptls_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_ptls_updated_at" BEFORE UPDATE ON "public"."planned_transaction_loan_schedule" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: recipient_bank_accounts update_rba_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_rba_updated_at" BEFORE UPDATE ON "public"."recipient_bank_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: recipient_match_patterns update_recipient_match_patterns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_recipient_match_patterns_updated_at" BEFORE UPDATE ON "public"."recipient_match_patterns" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: recipients update_recipients_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_recipients_updated_at" BEFORE UPDATE ON "public"."recipients" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: saved_charts update_saved_charts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_saved_charts_updated_at" BEFORE UPDATE ON "public"."saved_charts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: tags update_tags_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_tags_updated_at" BEFORE UPDATE ON "public"."tags" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: transaction_splits update_transaction_splits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_transaction_splits_updated_at" BEFORE UPDATE ON "public"."transaction_splits" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: transactions update_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_transactions_updated_at" BEFORE UPDATE ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: user_settings update_user_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_user_settings_updated_at" BEFORE UPDATE ON "public"."user_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: watchlist update_watchlist_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_watchlist_updated_at" BEFORE UPDATE ON "public"."watchlist" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: accounts accounts_funding_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounts"
    ADD CONSTRAINT "accounts_funding_account_id_fkey" FOREIGN KEY ("funding_account_id") REFERENCES "public"."accounts"("id") ON DELETE SET NULL;


--
-- Name: agg_split_outstanding agg_split_outstanding_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agg_split_outstanding"
    ADD CONSTRAINT "agg_split_outstanding_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE CASCADE;


--
-- Name: agg_split_outstanding agg_split_outstanding_split_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agg_split_outstanding"
    ADD CONSTRAINT "agg_split_outstanding_split_id_fkey" FOREIGN KEY ("split_id") REFERENCES "public"."transaction_splits"("id") ON DELETE CASCADE;


--
-- Name: ai_disclosure_records ai_disclosure_records_grant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_disclosure_records"
    ADD CONSTRAINT "ai_disclosure_records_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "public"."ai_disclosure_grants"("id") ON DELETE CASCADE;


--
-- Name: ai_disclosure_records ai_disclosure_records_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_disclosure_records"
    ADD CONSTRAINT "ai_disclosure_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_investigation_jobs"("id") ON DELETE SET NULL;


--
-- Name: ai_investigation_jobs ai_investigation_jobs_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_investigation_jobs"
    ADD CONSTRAINT "ai_investigation_jobs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE SET NULL;


--
-- Name: ai_investigation_steps ai_investigation_steps_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_investigation_steps"
    ADD CONSTRAINT "ai_investigation_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_investigation_jobs"("id") ON DELETE CASCADE;


--
-- Name: ai_messages ai_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_messages"
    ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE CASCADE;


--
-- Name: ai_reference_entries ai_reference_entries_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_reference_entries"
    ADD CONSTRAINT "ai_reference_entries_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "public"."ai_reference_scopes"("id") ON DELETE CASCADE;


--
-- Name: ai_reference_scopes ai_reference_scopes_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_reference_scopes"
    ADD CONSTRAINT "ai_reference_scopes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_investigation_jobs"("id") ON DELETE CASCADE;


--
-- Name: ai_research_passages ai_research_passages_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_research_passages"
    ADD CONSTRAINT "ai_research_passages_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."ai_research_documents"("id") ON DELETE CASCADE;


--
-- Name: analysis_monitor_notifications analysis_monitor_notifications_monitor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitor_notifications"
    ADD CONSTRAINT "analysis_monitor_notifications_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "public"."analysis_monitors"("id") ON DELETE CASCADE;


--
-- Name: analysis_monitor_notifications analysis_monitor_notifications_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitor_notifications"
    ADD CONSTRAINT "analysis_monitor_notifications_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "public"."analysis_monitor_observations"("id") ON DELETE CASCADE;


--
-- Name: analysis_monitor_observations analysis_monitor_observations_analysis_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitor_observations"
    ADD CONSTRAINT "analysis_monitor_observations_analysis_run_id_fkey" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."saved_analysis_runs"("id") ON DELETE SET NULL;


--
-- Name: analysis_monitor_observations analysis_monitor_observations_monitor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitor_observations"
    ADD CONSTRAINT "analysis_monitor_observations_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "public"."analysis_monitors"("id") ON DELETE CASCADE;


--
-- Name: analysis_monitors analysis_monitors_dossier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitors"
    ADD CONSTRAINT "analysis_monitors_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."research_dossiers"("id") ON DELETE SET NULL;


--
-- Name: analysis_monitors analysis_monitors_saved_analysis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analysis_monitors"
    ADD CONSTRAINT "analysis_monitors_saved_analysis_id_fkey" FOREIGN KEY ("saved_analysis_id") REFERENCES "public"."saved_analyses"("id") ON DELETE SET NULL;


--
-- Name: attachments attachments_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attachments"
    ADD CONSTRAINT "attachments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE CASCADE;


--
-- Name: categories categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE RESTRICT;


--
-- Name: category_merge_aliases category_merge_aliases_target_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."category_merge_aliases"
    ADD CONSTRAINT "category_merge_aliases_target_category_id_fkey" FOREIGN KEY ("target_category_id") REFERENCES "public"."categories"("id") ON DELETE RESTRICT;


--
-- Name: category_root_aliases category_root_aliases_target_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."category_root_aliases"
    ADD CONSTRAINT "category_root_aliases_target_category_id_fkey" FOREIGN KEY ("target_category_id") REFERENCES "public"."categories"("id") ON DELETE RESTRICT;


--
-- Name: account_statement_balances fk_account_statement_balances_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."account_statement_balances"
    ADD CONSTRAINT "fk_account_statement_balances_account" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE CASCADE;


--
-- Name: ai_investigation_jobs fk_ai_investigation_jobs_grant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_investigation_jobs"
    ADD CONSTRAINT "fk_ai_investigation_jobs_grant" FOREIGN KEY ("grant_id") REFERENCES "public"."ai_disclosure_grants"("id") ON DELETE SET NULL;


--
-- Name: asset_price_history fk_aph_investment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."asset_price_history"
    ADD CONSTRAINT "fk_aph_investment" FOREIGN KEY ("investment_id") REFERENCES "public"."investments"("id") ON DELETE CASCADE;


--
-- Name: import_staging_rows fk_import_staging_rows_resolved_recipient; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_staging_rows"
    ADD CONSTRAINT "fk_import_staging_rows_resolved_recipient" FOREIGN KEY ("resolved_recipient_id") REFERENCES "public"."recipients"("id") ON DELETE SET NULL;


--
-- Name: insight_dismissals fk_insight_dismissals_category_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."insight_dismissals"
    ADD CONSTRAINT "fk_insight_dismissals_category_id" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE CASCADE;


--
-- Name: insight_dismissals fk_insight_dismissals_recipient_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."insight_dismissals"
    ADD CONSTRAINT "fk_insight_dismissals_recipient_id" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE CASCADE;


--
-- Name: portfolio_import_staging_rows fk_pf_staging_override_investment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_import_staging_rows"
    ADD CONSTRAINT "fk_pf_staging_override_investment" FOREIGN KEY ("user_override_investment_id") REFERENCES "public"."investments"("id") ON DELETE SET NULL;


--
-- Name: portfolio_import_staging_rows fk_pf_staging_resolved_investment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_import_staging_rows"
    ADD CONSTRAINT "fk_pf_staging_resolved_investment" FOREIGN KEY ("resolved_investment_id") REFERENCES "public"."investments"("id") ON DELETE SET NULL;


--
-- Name: saved_analyses fk_saved_analyses_last_successful_run; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_analyses"
    ADD CONSTRAINT "fk_saved_analyses_last_successful_run" FOREIGN KEY ("last_successful_run_id") REFERENCES "public"."saved_analysis_runs"("id") ON DELETE SET NULL;


--
-- Name: saved_chart_categories fk_saved_chart_categories_chart; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_chart_categories"
    ADD CONSTRAINT "fk_saved_chart_categories_chart" FOREIGN KEY ("saved_chart_id") REFERENCES "public"."saved_charts"("id") ON DELETE CASCADE;


--
-- Name: saved_chart_categories fk_saved_chart_categories_entity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_chart_categories"
    ADD CONSTRAINT "fk_saved_chart_categories_entity" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE CASCADE;


--
-- Name: saved_chart_recipients fk_saved_chart_recipients_chart; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_chart_recipients"
    ADD CONSTRAINT "fk_saved_chart_recipients_chart" FOREIGN KEY ("saved_chart_id") REFERENCES "public"."saved_charts"("id") ON DELETE CASCADE;


--
-- Name: saved_chart_recipients fk_saved_chart_recipients_entity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_chart_recipients"
    ADD CONSTRAINT "fk_saved_chart_recipients_entity" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE CASCADE;


--
-- Name: saved_chart_tags fk_saved_chart_tags_chart; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_chart_tags"
    ADD CONSTRAINT "fk_saved_chart_tags_chart" FOREIGN KEY ("saved_chart_id") REFERENCES "public"."saved_charts"("id") ON DELETE CASCADE;


--
-- Name: saved_chart_tags fk_saved_chart_tags_entity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_chart_tags"
    ADD CONSTRAINT "fk_saved_chart_tags_entity" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;


--
-- Name: transactions fk_transactions_transfer_peer; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "fk_transactions_transfer_peer" FOREIGN KEY ("transfer_peer_id") REFERENCES "public"."transactions"("id") ON DELETE SET NULL;


--
-- Name: import_staging_rows import_staging_rows_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_staging_rows"
    ADD CONSTRAINT "import_staging_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE CASCADE;


--
-- Name: import_staging_rows import_staging_rows_matched_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_staging_rows"
    ADD CONSTRAINT "import_staging_rows_matched_pattern_id_fkey" FOREIGN KEY ("matched_pattern_id") REFERENCES "public"."recipient_match_patterns"("id") ON DELETE SET NULL;


--
-- Name: import_staging_rows import_staging_rows_override_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_staging_rows"
    ADD CONSTRAINT "import_staging_rows_override_category_id_fkey" FOREIGN KEY ("override_category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;


--
-- Name: import_staging_rows import_staging_rows_user_override_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_staging_rows"
    ADD CONSTRAINT "import_staging_rows_user_override_recipient_id_fkey" FOREIGN KEY ("user_override_recipient_id") REFERENCES "public"."recipients"("id") ON DELETE SET NULL;


--
-- Name: manual_transaction_dedup_claims manual_transaction_dedup_claims_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."manual_transaction_dedup_claims"
    ADD CONSTRAINT "manual_transaction_dedup_claims_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE SET NULL;


--
-- Name: planned_transaction_executions planned_transaction_executions_executed_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_executions"
    ADD CONSTRAINT "planned_transaction_executions_executed_transaction_id_fkey" FOREIGN KEY ("executed_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE CASCADE;


--
-- Name: planned_transaction_executions planned_transaction_executions_planned_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_executions"
    ADD CONSTRAINT "planned_transaction_executions_planned_transaction_id_fkey" FOREIGN KEY ("planned_transaction_id") REFERENCES "public"."planned_transactions"("id") ON DELETE CASCADE;


--
-- Name: planned_transaction_loan_schedule planned_transaction_loan_schedule_planned_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_loan_schedule"
    ADD CONSTRAINT "planned_transaction_loan_schedule_planned_transaction_id_fkey" FOREIGN KEY ("planned_transaction_id") REFERENCES "public"."planned_transactions"("id") ON DELETE CASCADE;


--
-- Name: planned_transaction_tags planned_transaction_tags_planned_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_tags"
    ADD CONSTRAINT "planned_transaction_tags_planned_transaction_id_fkey" FOREIGN KEY ("planned_transaction_id") REFERENCES "public"."planned_transactions"("id") ON DELETE CASCADE;


--
-- Name: planned_transaction_tags planned_transaction_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transaction_tags"
    ADD CONSTRAINT "planned_transaction_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;


--
-- Name: planned_transactions planned_transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transactions"
    ADD CONSTRAINT "planned_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE RESTRICT;


--
-- Name: planned_transactions planned_transactions_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transactions"
    ADD CONSTRAINT "planned_transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;


--
-- Name: planned_transactions planned_transactions_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."planned_transactions"
    ADD CONSTRAINT "planned_transactions_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id");


--
-- Name: portfolio_exposure_classifications portfolio_exposure_classifications_investment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_exposure_classifications"
    ADD CONSTRAINT "portfolio_exposure_classifications_investment_id_fkey" FOREIGN KEY ("investment_id") REFERENCES "public"."investments"("id") ON DELETE CASCADE;


--
-- Name: portfolio_fund_holdings_documents portfolio_fund_holdings_documents_investment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_fund_holdings_documents"
    ADD CONSTRAINT "portfolio_fund_holdings_documents_investment_id_fkey" FOREIGN KEY ("investment_id") REFERENCES "public"."investments"("id") ON DELETE CASCADE;


--
-- Name: portfolio_import_batches portfolio_import_batches_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_import_batches"
    ADD CONSTRAINT "portfolio_import_batches_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE SET NULL;


--
-- Name: portfolio_import_staging_rows portfolio_import_staging_rows_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_import_staging_rows"
    ADD CONSTRAINT "portfolio_import_staging_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."portfolio_import_batches"("id") ON DELETE CASCADE;


--
-- Name: portfolio_transactions portfolio_transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_transactions"
    ADD CONSTRAINT "portfolio_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE RESTRICT;


--
-- Name: portfolio_transactions portfolio_transactions_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_transactions"
    ADD CONSTRAINT "portfolio_transactions_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."portfolio_import_batches"("id") ON DELETE SET NULL;


--
-- Name: portfolio_transactions portfolio_transactions_investment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portfolio_transactions"
    ADD CONSTRAINT "portfolio_transactions_investment_id_fkey" FOREIGN KEY ("investment_id") REFERENCES "public"."investments"("id") ON DELETE CASCADE;


--
-- Name: recipient_bank_accounts recipient_bank_accounts_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipient_bank_accounts"
    ADD CONSTRAINT "recipient_bank_accounts_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id");


--
-- Name: recipient_match_patterns recipient_match_patterns_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipient_match_patterns"
    ADD CONSTRAINT "recipient_match_patterns_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE CASCADE;


--
-- Name: recipients recipients_default_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipients"
    ADD CONSTRAINT "recipients_default_category_id_fkey" FOREIGN KEY ("default_category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;


--
-- Name: recipients recipients_primary_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recipients"
    ADD CONSTRAINT "recipients_primary_recipient_id_fkey" FOREIGN KEY ("primary_recipient_id") REFERENCES "public"."recipients"("id") ON DELETE SET NULL;


--
-- Name: research_dossier_links research_dossier_links_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."research_dossier_links"
    ADD CONSTRAINT "research_dossier_links_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;


--
-- Name: research_dossier_links research_dossier_links_dossier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."research_dossier_links"
    ADD CONSTRAINT "research_dossier_links_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."research_dossiers"("id") ON DELETE CASCADE;


--
-- Name: research_dossier_links research_dossier_links_investment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."research_dossier_links"
    ADD CONSTRAINT "research_dossier_links_investment_id_fkey" FOREIGN KEY ("investment_id") REFERENCES "public"."investments"("id") ON DELETE SET NULL;


--
-- Name: research_dossier_links research_dossier_links_saved_analysis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."research_dossier_links"
    ADD CONSTRAINT "research_dossier_links_saved_analysis_id_fkey" FOREIGN KEY ("saved_analysis_id") REFERENCES "public"."saved_analyses"("id") ON DELETE SET NULL;


--
-- Name: research_dossier_versions research_dossier_versions_dossier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."research_dossier_versions"
    ADD CONSTRAINT "research_dossier_versions_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."research_dossiers"("id") ON DELETE CASCADE;


--
-- Name: saved_analysis_definition_versions saved_analysis_definition_versions_saved_analysis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_analysis_definition_versions"
    ADD CONSTRAINT "saved_analysis_definition_versions_saved_analysis_id_fkey" FOREIGN KEY ("saved_analysis_id") REFERENCES "public"."saved_analyses"("id") ON DELETE CASCADE;


--
-- Name: saved_analysis_runs saved_analysis_runs_saved_analysis_id_definition_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_analysis_runs"
    ADD CONSTRAINT "saved_analysis_runs_saved_analysis_id_definition_version_fkey" FOREIGN KEY ("saved_analysis_id", "definition_version") REFERENCES "public"."saved_analysis_definition_versions"("saved_analysis_id", "version");


--
-- Name: saved_analysis_runs saved_analysis_runs_saved_analysis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."saved_analysis_runs"
    ADD CONSTRAINT "saved_analysis_runs_saved_analysis_id_fkey" FOREIGN KEY ("saved_analysis_id") REFERENCES "public"."saved_analyses"("id") ON DELETE CASCADE;


--
-- Name: split_payments split_payments_split_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."split_payments"
    ADD CONSTRAINT "split_payments_split_id_fkey" FOREIGN KEY ("split_id") REFERENCES "public"."transaction_splits"("id") ON DELETE CASCADE;


--
-- Name: transaction_source_links transaction_source_links_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_source_links"
    ADD CONSTRAINT "transaction_source_links_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "public"."transaction_source_records"("id") ON DELETE CASCADE;


--
-- Name: transaction_source_links transaction_source_links_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_source_links"
    ADD CONSTRAINT "transaction_source_links_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE SET NULL;


--
-- Name: transaction_splits transaction_splits_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_splits"
    ADD CONSTRAINT "transaction_splits_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE CASCADE;


--
-- Name: transaction_splits transaction_splits_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_splits"
    ADD CONSTRAINT "transaction_splits_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE CASCADE;


--
-- Name: transaction_tags transaction_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_tags"
    ADD CONSTRAINT "transaction_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;


--
-- Name: transaction_tags transaction_tags_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transaction_tags"
    ADD CONSTRAINT "transaction_tags_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE CASCADE;


--
-- Name: transactions transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE RESTRICT;


--
-- Name: transactions transactions_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;


--
-- Name: transactions transactions_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE SET NULL;


--
-- Name: transactions transactions_matched_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_matched_pattern_id_fkey" FOREIGN KEY ("matched_pattern_id") REFERENCES "public"."recipient_match_patterns"("id") ON DELETE SET NULL;


--
-- Name: transactions transactions_recipient_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_recipient_bank_account_id_fkey" FOREIGN KEY ("recipient_bank_account_id") REFERENCES "public"."recipient_bank_accounts"("id");


--
-- Name: transactions transactions_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id");


--
-- Name: transfer_dismissals transfer_dismissals_txn_a_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transfer_dismissals"
    ADD CONSTRAINT "transfer_dismissals_txn_a_id_fkey" FOREIGN KEY ("txn_a_id") REFERENCES "public"."transactions"("id") ON DELETE CASCADE;


--
-- Name: transfer_dismissals transfer_dismissals_txn_b_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transfer_dismissals"
    ADD CONSTRAINT "transfer_dismissals_txn_b_id_fkey" FOREIGN KEY ("txn_b_id") REFERENCES "public"."transactions"("id") ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
