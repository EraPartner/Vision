--
-- PostgreSQL database dump
--

\restrict lIUeEldabT1bi4Gqw6ZKRZblxp2XaOkmTxE4Q1XpUi3FsG1R5Ze49ONbhv5uEvS

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4 (Homebrew)

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
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: account_liquidity_class; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_liquidity_class AS ENUM (
    'liquid',
    'semi_liquid',
    'illiquid'
);


--
-- Name: account_owner; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_owner AS ENUM (
    'me',
    'partner',
    'joint'
);


--
-- Name: account_tax_wrapper; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_tax_wrapper AS ENUM (
    'none',
    'pension',
    'tax_advantaged'
);


--
-- Name: account_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_type AS ENUM (
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

CREATE TYPE public.asset_class AS ENUM (
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

CREATE TYPE public.portfolio_txn_type AS ENUM (
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

CREATE TYPE public.price_provider AS ENUM (
    'manual',
    'binance',
    'yahoo',
    'custom',
    'kinesis'
);


--
-- Name: recurrence_interval; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.recurrence_interval AS ENUM (
    'daily',
    'weekly',
    'bi-weekly',
    'monthly',
    'quarterly',
    'yearly'
);


--
-- Name: revolut_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.revolut_state AS ENUM (
    'COMPLETED',
    'PENDING',
    'REVERTED',
    'DECLINED'
);


--
-- Name: fn_agg_recipient_totals_apply(integer, character, numeric, integer, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_agg_recipient_totals_apply(p_recipient_id integer, p_currency character, p_amount numeric, p_count_delta integer, p_tx_date date) RETURNS void
    LANGUAGE plpgsql
    AS $$
        BEGIN
            IF p_recipient_id IS NULL OR p_currency IS NULL THEN
                RETURN;
            END IF;

            INSERT INTO agg_recipient_totals (
                recipient_id, currency, total_amount, transaction_count,
                last_transaction_date, updated_at
            ) VALUES (
                p_recipient_id, p_currency, p_amount, p_count_delta,
                p_tx_date, NOW()
            )
            ON CONFLICT (recipient_id, currency) DO UPDATE
            SET total_amount = agg_recipient_totals.total_amount + EXCLUDED.total_amount,
                transaction_count = agg_recipient_totals.transaction_count + EXCLUDED.transaction_count,
                last_transaction_date = GREATEST(
                    agg_recipient_totals.last_transaction_date,
                    EXCLUDED.last_transaction_date
                ),
                updated_at = NOW();
        END;
        $$;


--
-- Name: fn_agg_recipient_totals_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_agg_recipient_totals_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                IF NEW.is_active AND NOT NEW.is_transfer THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        NEW.recipient_id, NEW.currency, NEW.amount, 1, NEW.date
                    );
                END IF;
                RETURN NEW;
            ELSIF TG_OP = 'DELETE' THEN
                IF OLD.is_active AND NOT OLD.is_transfer THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        OLD.recipient_id, OLD.currency, -OLD.amount, -1, NULL
                    );
                END IF;
                RETURN OLD;
            ELSIF TG_OP = 'UPDATE' THEN
                IF OLD.is_active AND NOT OLD.is_transfer THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        OLD.recipient_id, OLD.currency, -OLD.amount, -1, NULL
                    );
                END IF;
                IF NEW.is_active AND NOT NEW.is_transfer THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        NEW.recipient_id, NEW.currency, NEW.amount, 1, NEW.date
                    );
                END IF;
                RETURN NEW;
            END IF;
            RETURN NULL;
        END;
        $$;


--
-- Name: fn_agg_split_outstanding_sync(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_agg_split_outstanding_sync(p_split_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
        DECLARE
            v_recipient_id INTEGER;
            v_original NUMERIC(15, 2);
            v_paid NUMERIC(15, 2);
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

CREATE FUNCTION public.fn_trg_split_payment_sync() RETURNS trigger
    LANGUAGE plpgsql
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

CREATE FUNCTION public.fn_trg_split_sync() RETURNS trigger
    LANGUAGE plpgsql
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
-- Name: sync_account_id_from_bank_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_account_id_from_bank_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE acct_name text;
        BEGIN
            acct_name := btrim(NEW.bank_account);
            IF acct_name IS NOT NULL AND acct_name <> '' THEN
                IF TG_OP = 'INSERT'
                   OR NEW.bank_account IS DISTINCT FROM OLD.bank_account
                   OR NEW.account_id IS NULL THEN
                    INSERT INTO accounts (name, display_name)
                        VALUES (acct_name, acct_name)
                        ON CONFLICT (name) DO NOTHING;
                    SELECT id INTO NEW.account_id FROM accounts WHERE name = acct_name;
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$;


--
-- Name: touch_ai_conversation_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_ai_conversation_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE ai_conversations SET updated_at = NOW() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id integer NOT NULL,
    name text NOT NULL,
    display_name text,
    institution text,
    currency character varying(3) DEFAULT 'EUR'::character varying NOT NULL,
    type public.account_type DEFAULT 'checking'::public.account_type NOT NULL,
    liquidity_class public.account_liquidity_class DEFAULT 'liquid'::public.account_liquidity_class NOT NULL,
    spendable boolean DEFAULT true NOT NULL,
    in_net_worth boolean DEFAULT true NOT NULL,
    tax_wrapper public.account_tax_wrapper DEFAULT 'none'::public.account_tax_wrapper NOT NULL,
    owner public.account_owner DEFAULT 'me'::public.account_owner NOT NULL,
    multi_currency_cash boolean DEFAULT false NOT NULL,
    has_cash_sleeve boolean DEFAULT true NOT NULL,
    funding_account_id integer,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    statement_balance numeric(15,2),
    statement_balance_date date,
    CONSTRAINT chk_accounts_currency_iso CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))
);


--
-- Name: accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;


--
-- Name: agg_recipient_totals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agg_recipient_totals (
    recipient_id integer NOT NULL,
    currency character(3) NOT NULL,
    total_amount numeric(18,2) DEFAULT 0 NOT NULL,
    transaction_count integer DEFAULT 0 NOT NULL,
    last_transaction_date date,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agg_split_outstanding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agg_split_outstanding (
    split_id integer NOT NULL,
    recipient_id integer NOT NULL,
    original_amount numeric(15,2) NOT NULL,
    paid_amount numeric(15,2) DEFAULT 0 NOT NULL,
    outstanding_amount numeric(15,2) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text,
    tool_name text,
    tool_args jsonb,
    tool_result jsonb,
    status text DEFAULT 'complete'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'tool'::text, 'system'::text]))),
    CONSTRAINT ai_messages_status_check CHECK ((status = ANY (ARRAY['complete'::text, 'streaming'::text, 'aborted'::text, 'error'::text])))
);


--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(128) NOT NULL
);


--
-- Name: asset_price_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_price_history (
    id integer NOT NULL,
    investment_id integer NOT NULL,
    price_date date NOT NULL,
    close_price numeric(18,6) NOT NULL,
    source character varying(50) DEFAULT 'provider'::character varying NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: asset_price_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_price_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_price_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_price_history_id_seq OWNED BY public.asset_price_history.id;


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id bigint NOT NULL,
    transaction_id integer NOT NULL,
    filename text NOT NULL,
    stored_path text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attachments_id_seq OWNED BY public.attachments.id;


--
-- Name: belfius_raw_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.belfius_raw_transactions (
    id integer NOT NULL,
    deduplication_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_number character varying(34) NOT NULL,
    transaction_date date NOT NULL,
    statement_number character varying(50),
    transaction_number character varying(50),
    recipient_account character varying(34),
    recipient_name text,
    recipient_street text,
    recipient_location text,
    recipient_bic character varying(11),
    recipient_country character varying(2),
    transaction_description text,
    value_date date,
    amount numeric(15,2) NOT NULL,
    currency character varying(3) NOT NULL,
    balance numeric(15,2),
    additional_message text,
    raw_csv_line text NOT NULL
);


--
-- Name: belfius_raw_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.belfius_raw_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: belfius_raw_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.belfius_raw_transactions_id_seq OWNED BY public.belfius_raw_transactions.id;


--
-- Name: belgian_inflation_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.belgian_inflation_rates (
    id integer NOT NULL,
    month_date date NOT NULL,
    monthly_rate numeric(10,8) NOT NULL,
    source character varying(50) DEFAULT 'statbel'::character varying NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: belgian_inflation_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.belgian_inflation_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: belgian_inflation_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.belgian_inflation_rates_id_seq OWNED BY public.belgian_inflation_rates.id;


--
-- Name: cashflow_forecast_accuracy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_forecast_accuracy (
    id integer NOT NULL,
    user_id text DEFAULT 'anonymous'::text NOT NULL,
    method_id text NOT NULL,
    as_of_month text NOT NULL,
    mae double precision,
    rmse double precision,
    mape double precision,
    sample_days integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cashflow_forecast_accuracy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cashflow_forecast_accuracy_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cashflow_forecast_accuracy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cashflow_forecast_accuracy_id_seq OWNED BY public.cashflow_forecast_accuracy.id;


--
-- Name: cashflow_forecast_mc; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_forecast_mc (
    id integer NOT NULL,
    user_id text DEFAULT 'anonymous'::text NOT NULL,
    month text NOT NULL,
    filter_hash text NOT NULL,
    mc_paths integer DEFAULT 1000 NOT NULL,
    payload jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cashflow_forecast_mc_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cashflow_forecast_mc_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cashflow_forecast_mc_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cashflow_forecast_mc_id_seq OWNED BY public.cashflow_forecast_mc.id;


--
-- Name: cashflow_forecast_mc_rolling; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_forecast_mc_rolling (
    id integer NOT NULL,
    user_id text DEFAULT 'anonymous'::text NOT NULL,
    today_iso text NOT NULL,
    days_back integer NOT NULL,
    days_forward integer NOT NULL,
    filter_hash text NOT NULL,
    mc_paths integer DEFAULT 1000 NOT NULL,
    payload jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cashflow_forecast_mc_rolling_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cashflow_forecast_mc_rolling_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cashflow_forecast_mc_rolling_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cashflow_forecast_mc_rolling_id_seq OWNED BY public.cashflow_forecast_mc_rolling.id;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id integer NOT NULL,
    general text NOT NULL,
    detail text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;


--
-- Name: custom_parser_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_parser_configs (
    id integer NOT NULL,
    name text NOT NULL,
    config_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'transaction'::text NOT NULL,
    CONSTRAINT ck_custom_parser_configs_kind CHECK ((kind = ANY (ARRAY['transaction'::text, 'portfolio'::text])))
);


--
-- Name: custom_parser_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.custom_parser_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_parser_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custom_parser_configs_id_seq OWNED BY public.custom_parser_configs.id;


--
-- Name: custom_raw_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_raw_transactions (
    id integer NOT NULL,
    deduplication_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    date timestamp with time zone NOT NULL,
    description text NOT NULL,
    amount numeric(15,2) NOT NULL,
    currency character varying(3) NOT NULL,
    counterparty_name text NOT NULL,
    counterparty_account character varying(34) NOT NULL,
    balance numeric(15,2),
    category_name text,
    comments text,
    raw_csv_line text,
    raw_metadata jsonb
);


--
-- Name: custom_raw_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.custom_raw_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_raw_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custom_raw_transactions_id_seq OWNED BY public.custom_raw_transactions.id;


--
-- Name: db_editor_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.db_editor_audit (
    id bigint NOT NULL,
    table_name text NOT NULL,
    op text NOT NULL,
    pk_json jsonb,
    before_json jsonb,
    after_json jsonb,
    statement text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT db_editor_audit_op_check CHECK ((op = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])))
);


--
-- Name: db_editor_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.db_editor_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: db_editor_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.db_editor_audit_id_seq OWNED BY public.db_editor_audit.id;


--
-- Name: exchange_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exchange_rates (
    id integer NOT NULL,
    currency_code character varying(3) NOT NULL,
    rate_to_eur numeric(20,10) NOT NULL,
    rate_date date NOT NULL,
    is_latest boolean DEFAULT false,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.exchange_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.exchange_rates_id_seq OWNED BY public.exchange_rates.id;


--
-- Name: import_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_batches (
    id bigint NOT NULL,
    adapter_name text NOT NULL,
    source_filename text,
    source_size_bytes bigint,
    custom_config jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    rows_total integer DEFAULT 0 NOT NULL,
    rows_imported integer DEFAULT 0 NOT NULL,
    rows_duplicate integer DEFAULT 0 NOT NULL,
    rows_error integer DEFAULT 0 NOT NULL,
    error_summary text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT import_batches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'staging'::text, 'validating'::text, 'matching'::text, 'committing'::text, 'complete'::text, 'failed'::text, 'aborted'::text, 'awaiting_review'::text])))
);


--
-- Name: import_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.import_batches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.import_batches_id_seq OWNED BY public.import_batches.id;


--
-- Name: import_staging_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_staging_rows (
    id bigint NOT NULL,
    batch_id bigint NOT NULL,
    row_index integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    tx_date date,
    bank_account text,
    recipient_raw text,
    memo text,
    amount numeric(20,4),
    currency text,
    balance numeric(20,4),
    recipient_account text,
    recipient_address text,
    recipient_bank_name text,
    comment text,
    raw_data text,
    tx_hash text,
    resolved_recipient_id integer,
    resolved_bank_account_id integer,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    match_source text,
    matched_pattern_id integer,
    match_similarity real,
    user_override_recipient_id integer,
    override_category_id integer,
    CONSTRAINT import_staging_rows_match_source_check CHECK ((match_source = ANY (ARRAY['exact'::text, 'fuzzy'::text, 'pattern'::text, 'new'::text]))),
    CONSTRAINT import_staging_rows_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'validated'::text, 'matched'::text, 'committed'::text, 'duplicate'::text, 'error'::text])))
);


--
-- Name: import_staging_rows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.import_staging_rows_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_staging_rows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.import_staging_rows_id_seq OWNED BY public.import_staging_rows.id;


--
-- Name: instrument_provider_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instrument_provider_map (
    id integer NOT NULL,
    instrument_key text NOT NULL,
    key_type text DEFAULT 'isin'::text NOT NULL,
    provider text NOT NULL,
    provider_symbol text,
    resolved_name text,
    exchange text,
    currency text,
    status text DEFAULT 'auto'::text NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_instrument_provider_map_key_type CHECK ((key_type = ANY (ARRAY['isin'::text, 'internal'::text]))),
    CONSTRAINT ck_instrument_provider_map_status CHECK ((status = ANY (ARRAY['confirmed'::text, 'auto'::text, 'failed'::text])))
);


--
-- Name: instrument_provider_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.instrument_provider_map_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: instrument_provider_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.instrument_provider_map_id_seq OWNED BY public.instrument_provider_map.id;


--
-- Name: investments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investments (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    symbol character varying(20),
    asset_class public.asset_class NOT NULL,
    currency character varying(10) DEFAULT 'EUR'::character varying NOT NULL,
    current_price numeric(18,6),
    interest_rate numeric(8,4),
    maturity_date date,
    location character varying(300),
    municipality character varying(200),
    cadastral_income numeric(12,2),
    municipality_tax_rate numeric(8,4),
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    price_provider public.price_provider DEFAULT 'manual'::public.price_provider NOT NULL,
    price_provider_id character varying(200),
    price_provider_url character varying(500),
    price_provider_latest_url character varying(500),
    price_provider_latest_path character varying(300),
    price_provider_history_url character varying(500),
    price_provider_history_path character varying(300),
    price_provider_history_ts_path character varying(300),
    price_provider_history_price_path character varying(300),
    price_updated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: investments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investments_id_seq OWNED BY public.investments.id;


--
-- Name: kbc_raw_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kbc_raw_transactions (
    id integer NOT NULL,
    deduplication_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_number character varying(34) NOT NULL,
    category_name text,
    account_holder_name text,
    currency character varying(3) NOT NULL,
    statement_number character varying(50),
    transaction_date date NOT NULL,
    value_date date,
    description text,
    amount numeric(15,2) NOT NULL,
    balance numeric(15,2),
    credit_amount numeric(15,2),
    debit_amount numeric(15,2),
    counterparty_account character varying(34),
    counterparty_bic character varying(11),
    counterparty_name text,
    counterparty_address text,
    structured_communication text,
    free_communication text,
    raw_csv_line text NOT NULL
);


--
-- Name: kbc_raw_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.kbc_raw_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kbc_raw_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.kbc_raw_transactions_id_seq OWNED BY public.kbc_raw_transactions.id;


--
-- Name: manual_raw_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manual_raw_transactions (
    id integer NOT NULL,
    deduplication_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    transaction_id integer,
    date date NOT NULL,
    bank_account character varying(100),
    recipient_id integer,
    amount numeric(15,2) NOT NULL,
    memo text,
    currency character varying(3),
    category_id integer,
    comment text
);


--
-- Name: manual_raw_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.manual_raw_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: manual_raw_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.manual_raw_transactions_id_seq OWNED BY public.manual_raw_transactions.id;


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id integer NOT NULL,
    date date NOT NULL,
    amount numeric(18,4) NOT NULL,
    currency character varying(3) DEFAULT 'EUR'::character varying NOT NULL,
    balance numeric(15,2),
    memo text,
    comment text,
    bank_account text,
    recipient_id integer NOT NULL,
    recipient_bank_account_id integer,
    category_id integer,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    import_batch_id bigint,
    matched_pattern_id integer,
    tx_hash text,
    is_transfer boolean DEFAULT false NOT NULL,
    transfer_peer_id integer,
    transfer_source text,
    account_id integer,
    portfolio_transaction_id integer,
    CONSTRAINT chk_transactions_currency_iso CHECK (((currency)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT ck_transactions_transfer_source CHECK (((transfer_source IS NULL) OR (transfer_source = ANY (ARRAY['auto'::text, 'manual'::text, 'trade'::text]))))
);


--
-- Name: mv_bank_balances; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_bank_balances AS
 SELECT bank_account,
    currency,
    count(*) AS transaction_count,
    min(date) AS first_transaction,
    max(date) AS last_transaction,
    sum(amount) AS balance
   FROM public.transactions t
  WHERE ((is_active = true) AND (bank_account IS NOT NULL))
  GROUP BY bank_account, currency
  ORDER BY bank_account
  WITH NO DATA;


--
-- Name: planned_transaction_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planned_transaction_executions (
    id integer NOT NULL,
    planned_transaction_id integer NOT NULL,
    executed_transaction_id integer NOT NULL,
    execution_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: planned_transaction_executions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.planned_transaction_executions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planned_transaction_executions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.planned_transaction_executions_id_seq OWNED BY public.planned_transaction_executions.id;


--
-- Name: planned_transaction_loan_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planned_transaction_loan_schedule (
    id integer NOT NULL,
    planned_transaction_id integer CONSTRAINT planned_transaction_loan_schedu_planned_transaction_id_not_null NOT NULL,
    installment_number integer NOT NULL,
    due_date date NOT NULL,
    payment_amount numeric(15,2) NOT NULL,
    principal_amount numeric(15,2) NOT NULL,
    interest_amount numeric(15,2) NOT NULL,
    remaining_principal numeric(15,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: planned_transaction_loan_schedule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.planned_transaction_loan_schedule_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planned_transaction_loan_schedule_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.planned_transaction_loan_schedule_id_seq OWNED BY public.planned_transaction_loan_schedule.id;


--
-- Name: planned_transaction_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planned_transaction_tags (
    planned_transaction_id integer NOT NULL,
    tag_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: planned_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planned_transactions (
    id integer NOT NULL,
    planned_date date NOT NULL,
    amount numeric(15,2) NOT NULL,
    currency character varying(3) DEFAULT 'EUR'::character varying NOT NULL,
    memo text,
    comment text,
    url text,
    bank_account text,
    recipient_id integer,
    category_id integer,
    is_recurring boolean DEFAULT false NOT NULL,
    recurrence_pattern text,
    is_loan boolean DEFAULT false NOT NULL,
    loan_type text,
    loan_principal numeric(15,2),
    loan_annual_interest_rate numeric(8,4),
    loan_term_months integer,
    loan_start_date date,
    loan_payment_day integer,
    loan_regular_payment_amount numeric(15,2),
    loan_first_payment_date date,
    is_executed boolean DEFAULT false NOT NULL,
    last_executed_date date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reminder_days_before integer,
    account_id integer,
    CONSTRAINT chk_planned_transactions_currency_iso CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))
);


--
-- Name: COLUMN planned_transactions.reminder_days_before; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.planned_transactions.reminder_days_before IS 'Days before planned_date to surface as a reminder. NULL = no reminder.';


--
-- Name: planned_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.planned_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planned_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.planned_transactions_id_seq OWNED BY public.planned_transactions.id;


--
-- Name: portfolio_import_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio_import_batches (
    id bigint NOT NULL,
    adapter_name text NOT NULL,
    source_filename text,
    source_size_bytes bigint,
    custom_config jsonb,
    default_asset_class public.asset_class,
    default_type public.portfolio_txn_type,
    status text DEFAULT 'pending'::text NOT NULL,
    rows_total integer DEFAULT 0 NOT NULL,
    rows_imported integer DEFAULT 0 NOT NULL,
    rows_duplicate integer DEFAULT 0 NOT NULL,
    rows_error integer DEFAULT 0 NOT NULL,
    error_summary text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    account_id integer,
    is_brokerage boolean DEFAULT false NOT NULL,
    CONSTRAINT portfolio_import_batches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'staging'::text, 'validating'::text, 'matching'::text, 'awaiting_review'::text, 'committing'::text, 'complete'::text, 'failed'::text, 'aborted'::text])))
);


--
-- Name: portfolio_import_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portfolio_import_batches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_import_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portfolio_import_batches_id_seq OWNED BY public.portfolio_import_batches.id;


--
-- Name: portfolio_import_staging_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio_import_staging_rows (
    id bigint NOT NULL,
    batch_id bigint NOT NULL,
    row_index integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    tx_date date,
    type_raw text,
    type public.portfolio_txn_type,
    symbol_raw text,
    name_raw text,
    units numeric(18,8),
    price_per_unit numeric(18,6),
    amount numeric(18,4),
    fees numeric(18,4),
    taxes numeric(18,4),
    currency text,
    fx_rate_to_eur numeric(20,10),
    note text,
    raw_data text,
    tx_hash text,
    resolved_investment_id integer,
    user_override_investment_id integer,
    match_source text,
    match_similarity real,
    committed_txn_id integer,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    route text,
    CONSTRAINT portfolio_import_staging_rows_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'validated'::text, 'matched'::text, 'committed'::text, 'duplicate'::text, 'error'::text])))
);


--
-- Name: portfolio_import_staging_rows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portfolio_import_staging_rows_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_import_staging_rows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portfolio_import_staging_rows_id_seq OWNED BY public.portfolio_import_staging_rows.id;


--
-- Name: portfolio_performance_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio_performance_snapshots (
    id integer NOT NULL,
    snapshot_date date NOT NULL,
    invested numeric(18,6) DEFAULT 0 NOT NULL,
    value numeric(18,6) DEFAULT 0 NOT NULL,
    stocks_etfs_value numeric(18,6) DEFAULT 0 NOT NULL,
    crypto_value numeric(18,6) DEFAULT 0 NOT NULL,
    metals_value numeric(18,6) DEFAULT 0 NOT NULL,
    cash_value numeric(18,6) DEFAULT 0 NOT NULL,
    gain_loss numeric(18,6) DEFAULT 0 NOT NULL,
    return_pct numeric(10,4) DEFAULT 0 NOT NULL,
    inflation_adjusted_value numeric(18,6) DEFAULT 0 CONSTRAINT portfolio_performance_snapsho_inflation_adjusted_value_not_null NOT NULL,
    cumulative_inflation numeric(10,4) DEFAULT 1 NOT NULL,
    real_return_pct numeric(10,4) DEFAULT 0 NOT NULL,
    currency character varying(3) DEFAULT 'EUR'::character varying NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    stocks_etfs_invested numeric(18,6) DEFAULT 0 NOT NULL,
    crypto_invested numeric(18,6) DEFAULT 0 NOT NULL,
    metals_invested numeric(18,6) DEFAULT 0 NOT NULL,
    value_fx_neutral numeric(18,2)
);


--
-- Name: portfolio_performance_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portfolio_performance_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_performance_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portfolio_performance_snapshots_id_seq OWNED BY public.portfolio_performance_snapshots.id;


--
-- Name: portfolio_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio_transactions (
    id integer NOT NULL,
    investment_id integer NOT NULL,
    type public.portfolio_txn_type NOT NULL,
    date date NOT NULL,
    amount numeric(18,4) NOT NULL,
    units numeric(18,8),
    price_per_unit numeric(18,6),
    fees numeric(18,4) DEFAULT 0,
    taxes numeric(18,4) DEFAULT 0,
    currency character varying(10) DEFAULT 'EUR'::character varying NOT NULL,
    fx_rate_to_eur numeric(20,10),
    note text,
    is_recurring boolean DEFAULT false NOT NULL,
    recurrence_interval public.recurrence_interval,
    recurrence_end_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id integer
);


--
-- Name: portfolio_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portfolio_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portfolio_transactions_id_seq OWNED BY public.portfolio_transactions.id;


--
-- Name: provider_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_api_keys (
    provider text NOT NULL,
    api_key text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_health (
    provider text NOT NULL,
    kind text NOT NULL,
    last_success_at timestamp with time zone,
    last_error_at timestamp with time zone,
    last_error text,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_quota; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_quota (
    provider text NOT NULL,
    window_date date NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_provider_quota_count_nonneg CHECK ((count >= 0))
);


--
-- Name: recipient_bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipient_bank_accounts (
    id integer NOT NULL,
    recipient_id integer,
    account_number character varying(34) NOT NULL,
    bank_name text,
    account_label text,
    address text,
    is_primary boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recipient_bank_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recipient_bank_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recipient_bank_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recipient_bank_accounts_id_seq OWNED BY public.recipient_bank_accounts.id;


--
-- Name: recipient_match_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipient_match_patterns (
    id integer NOT NULL,
    recipient_id integer NOT NULL,
    pattern text NOT NULL,
    pattern_kind text DEFAULT 'literal_prefix'::text NOT NULL,
    case_sensitive boolean DEFAULT false NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    source text DEFAULT 'user'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recipient_match_patterns_pattern_kind_check CHECK ((pattern_kind = ANY (ARRAY['regex'::text, 'glob'::text, 'literal_prefix'::text]))),
    CONSTRAINT recipient_match_patterns_source_check CHECK ((source = ANY (ARRAY['user'::text, 'suggested'::text, 'system'::text])))
);


--
-- Name: recipient_match_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recipient_match_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recipient_match_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recipient_match_patterns_id_seq OWNED BY public.recipient_match_patterns.id;


--
-- Name: recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipients (
    id integer NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    default_category_id integer,
    primary_recipient_id integer,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recipients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recipients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recipients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recipients_id_seq OWNED BY public.recipients.id;


--
-- Name: revolut_raw_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revolut_raw_transactions (
    id integer NOT NULL,
    deduplication_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    transaction_type character varying(50) NOT NULL,
    product character varying(50) NOT NULL,
    started_date timestamp with time zone,
    completed_date timestamp with time zone NOT NULL,
    description text NOT NULL,
    amount numeric(15,2) NOT NULL,
    fee numeric(15,2) DEFAULT 0,
    currency character varying(3) NOT NULL,
    state public.revolut_state NOT NULL,
    balance numeric(15,2),
    raw_csv_line text NOT NULL
);


--
-- Name: revolut_raw_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.revolut_raw_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: revolut_raw_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.revolut_raw_transactions_id_seq OWNED BY public.revolut_raw_transactions.id;


--
-- Name: sabb_raw_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sabb_raw_transactions (
    id integer NOT NULL,
    deduplication_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    transaction_date date NOT NULL,
    posting_date date,
    description text,
    amount numeric(15,2) NOT NULL,
    currency character varying(3) NOT NULL,
    status character varying(50),
    amount_other_currency text,
    raw_csv_line text NOT NULL
);


--
-- Name: sabb_raw_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sabb_raw_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sabb_raw_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sabb_raw_transactions_id_seq OWNED BY public.sabb_raw_transactions.id;


--
-- Name: saved_charts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_charts (
    id integer NOT NULL,
    name text NOT NULL,
    chart_type text DEFAULT 'line'::text NOT NULL,
    category_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recipient_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    chart_variant text DEFAULT 'default'::text NOT NULL,
    time_bucket text DEFAULT 'monthly'::text NOT NULL,
    date_range_start date,
    date_range_end date
);


--
-- Name: saved_charts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.saved_charts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: saved_charts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.saved_charts_id_seq OWNED BY public.saved_charts.id;


--
-- Name: split_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.split_audit (
    id bigint NOT NULL,
    split_id integer,
    action character varying(50) NOT NULL,
    actor text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: split_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.split_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: split_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.split_audit_id_seq OWNED BY public.split_audit.id;


--
-- Name: split_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.split_payments (
    id integer NOT NULL,
    split_id integer NOT NULL,
    amount numeric(15,2) NOT NULL,
    paid_at date DEFAULT CURRENT_DATE NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_split_payment_amount_positive CHECK ((amount > (0)::numeric))
);


--
-- Name: split_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.split_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: split_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.split_payments_id_seq OWNED BY public.split_payments.id;


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id integer NOT NULL,
    slug text NOT NULL,
    color text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;


--
-- Name: transaction_raw_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_raw_references (
    id integer NOT NULL,
    transaction_id integer NOT NULL,
    raw_source_type character varying(20) NOT NULL,
    raw_source_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: transaction_raw_references_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transaction_raw_references_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transaction_raw_references_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transaction_raw_references_id_seq OWNED BY public.transaction_raw_references.id;


--
-- Name: transaction_splits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_splits (
    id integer NOT NULL,
    transaction_id integer NOT NULL,
    recipient_id integer NOT NULL,
    amount numeric(15,2) NOT NULL,
    note text,
    is_settled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_split_amount_positive CHECK ((amount > (0)::numeric))
);


--
-- Name: transaction_splits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transaction_splits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transaction_splits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transaction_splits_id_seq OWNED BY public.transaction_splits.id;


--
-- Name: transaction_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_tags (
    transaction_id integer NOT NULL,
    tag_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transactions_id_seq OWNED BY public.transactions.id;


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_settings (
    key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vision_raw_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vision_raw_transactions (
    id integer NOT NULL,
    deduplication_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    transaction_date date NOT NULL,
    bank_account character varying(100),
    recipient text,
    memo text,
    amount numeric(15,2) NOT NULL,
    currency character varying(3) NOT NULL,
    balance numeric(15,2),
    category text,
    comment text,
    raw_csv_line text NOT NULL
);


--
-- Name: vision_raw_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vision_raw_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vision_raw_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vision_raw_transactions_id_seq OWNED BY public.vision_raw_transactions.id;


--
-- Name: watchlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watchlist (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    symbol character varying(20),
    asset_class public.asset_class NOT NULL,
    target_price numeric(18,6) NOT NULL,
    currency character varying(10) DEFAULT 'EUR'::character varying NOT NULL,
    notes text,
    price_provider_id character varying(200),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    added_price numeric(18,6)
);


--
-- Name: watchlist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.watchlist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watchlist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.watchlist_id_seq OWNED BY public.watchlist.id;


--
-- Name: wise_raw_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wise_raw_transactions (
    id integer NOT NULL,
    deduplication_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    transfer_id text,
    direction character varying(20),
    status character varying(50) NOT NULL,
    finished_on timestamp with time zone,
    source_name text,
    source_amount numeric(15,2),
    source_currency character varying(3),
    target_name text,
    target_amount numeric(15,2),
    target_currency character varying(3),
    exchange_rate numeric(20,10),
    source_fee_amount numeric(15,2),
    source_fee_currency character varying(3),
    reference text,
    batch text,
    raw_csv_line text NOT NULL
);


--
-- Name: wise_raw_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wise_raw_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wise_raw_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wise_raw_transactions_id_seq OWNED BY public.wise_raw_transactions.id;


--
-- Name: accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);


--
-- Name: asset_price_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_price_history ALTER COLUMN id SET DEFAULT nextval('public.asset_price_history_id_seq'::regclass);


--
-- Name: attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments ALTER COLUMN id SET DEFAULT nextval('public.attachments_id_seq'::regclass);


--
-- Name: belfius_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belfius_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.belfius_raw_transactions_id_seq'::regclass);


--
-- Name: belgian_inflation_rates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belgian_inflation_rates ALTER COLUMN id SET DEFAULT nextval('public.belgian_inflation_rates_id_seq'::regclass);


--
-- Name: cashflow_forecast_accuracy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast_accuracy ALTER COLUMN id SET DEFAULT nextval('public.cashflow_forecast_accuracy_id_seq'::regclass);


--
-- Name: cashflow_forecast_mc id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast_mc ALTER COLUMN id SET DEFAULT nextval('public.cashflow_forecast_mc_id_seq'::regclass);


--
-- Name: cashflow_forecast_mc_rolling id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast_mc_rolling ALTER COLUMN id SET DEFAULT nextval('public.cashflow_forecast_mc_rolling_id_seq'::regclass);


--
-- Name: categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);


--
-- Name: custom_parser_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_parser_configs ALTER COLUMN id SET DEFAULT nextval('public.custom_parser_configs_id_seq'::regclass);


--
-- Name: custom_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.custom_raw_transactions_id_seq'::regclass);


--
-- Name: db_editor_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_editor_audit ALTER COLUMN id SET DEFAULT nextval('public.db_editor_audit_id_seq'::regclass);


--
-- Name: exchange_rates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates ALTER COLUMN id SET DEFAULT nextval('public.exchange_rates_id_seq'::regclass);


--
-- Name: import_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches ALTER COLUMN id SET DEFAULT nextval('public.import_batches_id_seq'::regclass);


--
-- Name: import_staging_rows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_staging_rows ALTER COLUMN id SET DEFAULT nextval('public.import_staging_rows_id_seq'::regclass);


--
-- Name: instrument_provider_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_provider_map ALTER COLUMN id SET DEFAULT nextval('public.instrument_provider_map_id_seq'::regclass);


--
-- Name: investments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investments ALTER COLUMN id SET DEFAULT nextval('public.investments_id_seq'::regclass);


--
-- Name: kbc_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kbc_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.kbc_raw_transactions_id_seq'::regclass);


--
-- Name: manual_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.manual_raw_transactions_id_seq'::regclass);


--
-- Name: planned_transaction_executions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_executions ALTER COLUMN id SET DEFAULT nextval('public.planned_transaction_executions_id_seq'::regclass);


--
-- Name: planned_transaction_loan_schedule id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_loan_schedule ALTER COLUMN id SET DEFAULT nextval('public.planned_transaction_loan_schedule_id_seq'::regclass);


--
-- Name: planned_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transactions ALTER COLUMN id SET DEFAULT nextval('public.planned_transactions_id_seq'::regclass);


--
-- Name: portfolio_import_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_import_batches ALTER COLUMN id SET DEFAULT nextval('public.portfolio_import_batches_id_seq'::regclass);


--
-- Name: portfolio_import_staging_rows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_import_staging_rows ALTER COLUMN id SET DEFAULT nextval('public.portfolio_import_staging_rows_id_seq'::regclass);


--
-- Name: portfolio_performance_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_performance_snapshots ALTER COLUMN id SET DEFAULT nextval('public.portfolio_performance_snapshots_id_seq'::regclass);


--
-- Name: portfolio_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_transactions ALTER COLUMN id SET DEFAULT nextval('public.portfolio_transactions_id_seq'::regclass);


--
-- Name: recipient_bank_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_bank_accounts ALTER COLUMN id SET DEFAULT nextval('public.recipient_bank_accounts_id_seq'::regclass);


--
-- Name: recipient_match_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_match_patterns ALTER COLUMN id SET DEFAULT nextval('public.recipient_match_patterns_id_seq'::regclass);


--
-- Name: recipients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipients ALTER COLUMN id SET DEFAULT nextval('public.recipients_id_seq'::regclass);


--
-- Name: revolut_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revolut_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.revolut_raw_transactions_id_seq'::regclass);


--
-- Name: sabb_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sabb_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.sabb_raw_transactions_id_seq'::regclass);


--
-- Name: saved_charts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_charts ALTER COLUMN id SET DEFAULT nextval('public.saved_charts_id_seq'::regclass);


--
-- Name: split_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.split_audit ALTER COLUMN id SET DEFAULT nextval('public.split_audit_id_seq'::regclass);


--
-- Name: split_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.split_payments ALTER COLUMN id SET DEFAULT nextval('public.split_payments_id_seq'::regclass);


--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);


--
-- Name: transaction_raw_references id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_raw_references ALTER COLUMN id SET DEFAULT nextval('public.transaction_raw_references_id_seq'::regclass);


--
-- Name: transaction_splits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_splits ALTER COLUMN id SET DEFAULT nextval('public.transaction_splits_id_seq'::regclass);


--
-- Name: transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions ALTER COLUMN id SET DEFAULT nextval('public.transactions_id_seq'::regclass);


--
-- Name: vision_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.vision_raw_transactions_id_seq'::regclass);


--
-- Name: watchlist id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchlist ALTER COLUMN id SET DEFAULT nextval('public.watchlist_id_seq'::regclass);


--
-- Name: wise_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wise_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.wise_raw_transactions_id_seq'::regclass);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: agg_recipient_totals agg_recipient_totals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agg_recipient_totals
    ADD CONSTRAINT agg_recipient_totals_pkey PRIMARY KEY (recipient_id, currency);


--
-- Name: agg_split_outstanding agg_split_outstanding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agg_split_outstanding
    ADD CONSTRAINT agg_split_outstanding_pkey PRIMARY KEY (split_id);


--
-- Name: ai_conversations ai_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_pkey PRIMARY KEY (id);


--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (id);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: asset_price_history asset_price_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_price_history
    ADD CONSTRAINT asset_price_history_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: belfius_raw_transactions belfius_raw_transactions_deduplication_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belfius_raw_transactions
    ADD CONSTRAINT belfius_raw_transactions_deduplication_hash_key UNIQUE (deduplication_hash);


--
-- Name: belfius_raw_transactions belfius_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belfius_raw_transactions
    ADD CONSTRAINT belfius_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: belgian_inflation_rates belgian_inflation_rates_month_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belgian_inflation_rates
    ADD CONSTRAINT belgian_inflation_rates_month_date_key UNIQUE (month_date);


--
-- Name: belgian_inflation_rates belgian_inflation_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belgian_inflation_rates
    ADD CONSTRAINT belgian_inflation_rates_pkey PRIMARY KEY (id);


--
-- Name: cashflow_forecast_accuracy cashflow_forecast_accuracy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast_accuracy
    ADD CONSTRAINT cashflow_forecast_accuracy_pkey PRIMARY KEY (id);


--
-- Name: cashflow_forecast_mc cashflow_forecast_mc_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast_mc
    ADD CONSTRAINT cashflow_forecast_mc_pkey PRIMARY KEY (id);


--
-- Name: cashflow_forecast_mc_rolling cashflow_forecast_mc_rolling_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast_mc_rolling
    ADD CONSTRAINT cashflow_forecast_mc_rolling_pkey PRIMARY KEY (id);


--
-- Name: cashflow_forecast_mc_rolling cashflow_forecast_mc_rolling_user_id_today_iso_days_back_da_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast_mc_rolling
    ADD CONSTRAINT cashflow_forecast_mc_rolling_user_id_today_iso_days_back_da_key UNIQUE (user_id, today_iso, days_back, days_forward, filter_hash);


--
-- Name: cashflow_forecast_mc cashflow_forecast_mc_user_id_month_filter_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast_mc
    ADD CONSTRAINT cashflow_forecast_mc_user_id_month_filter_hash_key UNIQUE (user_id, month, filter_hash);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: custom_parser_configs custom_parser_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_parser_configs
    ADD CONSTRAINT custom_parser_configs_pkey PRIMARY KEY (id);


--
-- Name: custom_raw_transactions custom_raw_transactions_deduplication_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_raw_transactions
    ADD CONSTRAINT custom_raw_transactions_deduplication_hash_key UNIQUE (deduplication_hash);


--
-- Name: custom_raw_transactions custom_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_raw_transactions
    ADD CONSTRAINT custom_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: db_editor_audit db_editor_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_editor_audit
    ADD CONSTRAINT db_editor_audit_pkey PRIMARY KEY (id);


--
-- Name: exchange_rates exchange_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_pkey PRIMARY KEY (id);


--
-- Name: import_batches import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);


--
-- Name: import_staging_rows import_staging_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_staging_rows
    ADD CONSTRAINT import_staging_rows_pkey PRIMARY KEY (id);


--
-- Name: instrument_provider_map instrument_provider_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_provider_map
    ADD CONSTRAINT instrument_provider_map_pkey PRIMARY KEY (id);


--
-- Name: investments investments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investments
    ADD CONSTRAINT investments_pkey PRIMARY KEY (id);


--
-- Name: kbc_raw_transactions kbc_raw_transactions_deduplication_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kbc_raw_transactions
    ADD CONSTRAINT kbc_raw_transactions_deduplication_hash_key UNIQUE (deduplication_hash);


--
-- Name: kbc_raw_transactions kbc_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kbc_raw_transactions
    ADD CONSTRAINT kbc_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: manual_raw_transactions manual_raw_transactions_deduplication_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_raw_transactions
    ADD CONSTRAINT manual_raw_transactions_deduplication_hash_key UNIQUE (deduplication_hash);


--
-- Name: manual_raw_transactions manual_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_raw_transactions
    ADD CONSTRAINT manual_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: planned_transaction_executions planned_transaction_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_executions
    ADD CONSTRAINT planned_transaction_executions_pkey PRIMARY KEY (id);


--
-- Name: planned_transaction_loan_schedule planned_transaction_loan_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_loan_schedule
    ADD CONSTRAINT planned_transaction_loan_schedule_pkey PRIMARY KEY (id);


--
-- Name: planned_transaction_tags planned_transaction_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_tags
    ADD CONSTRAINT planned_transaction_tags_pkey PRIMARY KEY (planned_transaction_id, tag_id);


--
-- Name: planned_transactions planned_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transactions
    ADD CONSTRAINT planned_transactions_pkey PRIMARY KEY (id);


--
-- Name: portfolio_import_batches portfolio_import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_import_batches
    ADD CONSTRAINT portfolio_import_batches_pkey PRIMARY KEY (id);


--
-- Name: portfolio_import_staging_rows portfolio_import_staging_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_import_staging_rows
    ADD CONSTRAINT portfolio_import_staging_rows_pkey PRIMARY KEY (id);


--
-- Name: portfolio_performance_snapshots portfolio_performance_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_performance_snapshots
    ADD CONSTRAINT portfolio_performance_snapshots_pkey PRIMARY KEY (id);


--
-- Name: portfolio_transactions portfolio_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_transactions
    ADD CONSTRAINT portfolio_transactions_pkey PRIMARY KEY (id);


--
-- Name: provider_api_keys provider_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_api_keys
    ADD CONSTRAINT provider_api_keys_pkey PRIMARY KEY (provider);


--
-- Name: provider_health provider_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health
    ADD CONSTRAINT provider_health_pkey PRIMARY KEY (provider);


--
-- Name: provider_quota provider_quota_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_quota
    ADD CONSTRAINT provider_quota_pkey PRIMARY KEY (provider, window_date);


--
-- Name: recipient_bank_accounts recipient_bank_accounts_account_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_bank_accounts
    ADD CONSTRAINT recipient_bank_accounts_account_number_key UNIQUE (account_number);


--
-- Name: recipient_bank_accounts recipient_bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_bank_accounts
    ADD CONSTRAINT recipient_bank_accounts_pkey PRIMARY KEY (id);


--
-- Name: recipient_match_patterns recipient_match_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_match_patterns
    ADD CONSTRAINT recipient_match_patterns_pkey PRIMARY KEY (id);


--
-- Name: recipients recipients_normalized_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipients
    ADD CONSTRAINT recipients_normalized_name_key UNIQUE (normalized_name);


--
-- Name: recipients recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipients
    ADD CONSTRAINT recipients_pkey PRIMARY KEY (id);


--
-- Name: revolut_raw_transactions revolut_raw_transactions_deduplication_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revolut_raw_transactions
    ADD CONSTRAINT revolut_raw_transactions_deduplication_hash_key UNIQUE (deduplication_hash);


--
-- Name: revolut_raw_transactions revolut_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revolut_raw_transactions
    ADD CONSTRAINT revolut_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: sabb_raw_transactions sabb_raw_transactions_deduplication_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sabb_raw_transactions
    ADD CONSTRAINT sabb_raw_transactions_deduplication_hash_key UNIQUE (deduplication_hash);


--
-- Name: sabb_raw_transactions sabb_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sabb_raw_transactions
    ADD CONSTRAINT sabb_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: saved_charts saved_charts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_charts
    ADD CONSTRAINT saved_charts_pkey PRIMARY KEY (id);


--
-- Name: split_audit split_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.split_audit
    ADD CONSTRAINT split_audit_pkey PRIMARY KEY (id);


--
-- Name: split_payments split_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.split_payments
    ADD CONSTRAINT split_payments_pkey PRIMARY KEY (id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: transaction_raw_references transaction_raw_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_raw_references
    ADD CONSTRAINT transaction_raw_references_pkey PRIMARY KEY (id);


--
-- Name: transaction_splits transaction_splits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_pkey PRIMARY KEY (id);


--
-- Name: transaction_tags transaction_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_tags
    ADD CONSTRAINT transaction_tags_pkey PRIMARY KEY (transaction_id, tag_id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: accounts uq_accounts_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT uq_accounts_name UNIQUE (name);


--
-- Name: asset_price_history uq_asset_price_history_investment_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_price_history
    ADD CONSTRAINT uq_asset_price_history_investment_date UNIQUE (investment_id, price_date);


--
-- Name: cashflow_forecast_accuracy uq_cfa_user_method_month; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast_accuracy
    ADD CONSTRAINT uq_cfa_user_method_month UNIQUE (user_id, method_id, as_of_month);


--
-- Name: exchange_rates uq_currency_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT uq_currency_date UNIQUE (currency_code, rate_date);


--
-- Name: categories uq_general_detail; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT uq_general_detail UNIQUE (general, detail);


--
-- Name: portfolio_performance_snapshots uq_pps_date_currency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_performance_snapshots
    ADD CONSTRAINT uq_pps_date_currency UNIQUE (snapshot_date, currency);


--
-- Name: planned_transaction_loan_schedule uq_ptls_planned_installment; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_loan_schedule
    ADD CONSTRAINT uq_ptls_planned_installment UNIQUE (planned_transaction_id, installment_number);


--
-- Name: transaction_raw_references uq_raw_ref_txn_source; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_raw_references
    ADD CONSTRAINT uq_raw_ref_txn_source UNIQUE (transaction_id, raw_source_type, raw_source_id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (key);


--
-- Name: vision_raw_transactions vision_raw_transactions_deduplication_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_raw_transactions
    ADD CONSTRAINT vision_raw_transactions_deduplication_hash_key UNIQUE (deduplication_hash);


--
-- Name: vision_raw_transactions vision_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_raw_transactions
    ADD CONSTRAINT vision_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: watchlist watchlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchlist
    ADD CONSTRAINT watchlist_pkey PRIMARY KEY (id);


--
-- Name: wise_raw_transactions wise_raw_transactions_deduplication_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wise_raw_transactions
    ADD CONSTRAINT wise_raw_transactions_deduplication_hash_key UNIQUE (deduplication_hash);


--
-- Name: wise_raw_transactions wise_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wise_raw_transactions
    ADD CONSTRAINT wise_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: db_editor_audit_table_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX db_editor_audit_table_time_idx ON public.db_editor_audit USING btree (table_name, created_at DESC);


--
-- Name: idx_agg_recipient_totals_currency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agg_recipient_totals_currency ON public.agg_recipient_totals USING btree (currency);


--
-- Name: idx_agg_split_outstanding_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agg_split_outstanding_open ON public.agg_split_outstanding USING btree (recipient_id) WHERE (outstanding_amount <> (0)::numeric);


--
-- Name: idx_agg_split_outstanding_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agg_split_outstanding_recipient ON public.agg_split_outstanding USING btree (recipient_id);


--
-- Name: idx_ai_conversations_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_conversations_updated_at ON public.ai_conversations USING btree (updated_at DESC);


--
-- Name: idx_ai_messages_conv_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_messages_conv_created ON public.ai_messages USING btree (conversation_id, created_at);


--
-- Name: idx_asset_price_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asset_price_history_date ON public.asset_price_history USING btree (price_date);


--
-- Name: idx_asset_price_history_investment_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asset_price_history_investment_date ON public.asset_price_history USING btree (investment_id, price_date);


--
-- Name: idx_attachments_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachments_transaction_id ON public.attachments USING btree (transaction_id);


--
-- Name: idx_belfius_account_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_belfius_account_date ON public.belfius_raw_transactions USING btree (account_number, transaction_date);


--
-- Name: idx_belfius_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_belfius_hash ON public.belfius_raw_transactions USING btree (deduplication_hash);


--
-- Name: idx_belgian_inflation_month_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_belgian_inflation_month_date ON public.belgian_inflation_rates USING btree (month_date);


--
-- Name: idx_categories_detail; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_detail ON public.categories USING btree (detail);


--
-- Name: idx_categories_general; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_general ON public.categories USING btree (general);


--
-- Name: idx_cfa_as_of_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfa_as_of_month ON public.cashflow_forecast_accuracy USING btree (as_of_month);


--
-- Name: idx_cfa_user_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfa_user_method ON public.cashflow_forecast_accuracy USING btree (user_id, method_id);


--
-- Name: idx_cfmc_user_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfmc_user_month ON public.cashflow_forecast_mc USING btree (user_id, month);


--
-- Name: idx_cfmcr_user_today; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfmcr_user_today ON public.cashflow_forecast_mc_rolling USING btree (user_id, today_iso);


--
-- Name: idx_custom_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_date ON public.custom_raw_transactions USING btree (date);


--
-- Name: idx_custom_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_hash ON public.custom_raw_transactions USING btree (deduplication_hash);


--
-- Name: idx_exchange_rates_currency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exchange_rates_currency ON public.exchange_rates USING btree (currency_code);


--
-- Name: idx_exchange_rates_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exchange_rates_date ON public.exchange_rates USING btree (rate_date);


--
-- Name: idx_exchange_rates_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exchange_rates_latest ON public.exchange_rates USING btree (is_latest);


--
-- Name: idx_import_batches_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_batches_started_at ON public.import_batches USING btree (started_at DESC);


--
-- Name: idx_import_batches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_batches_status ON public.import_batches USING btree (status) WHERE (status <> ALL (ARRAY['complete'::text, 'failed'::text, 'aborted'::text]));


--
-- Name: idx_investments_asset_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_investments_asset_class ON public.investments USING btree (asset_class);


--
-- Name: idx_investments_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_investments_is_active ON public.investments USING btree (is_active);


--
-- Name: idx_kbc_account_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kbc_account_date ON public.kbc_raw_transactions USING btree (account_number, transaction_date);


--
-- Name: idx_kbc_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kbc_hash ON public.kbc_raw_transactions USING btree (deduplication_hash);


--
-- Name: idx_kbc_statement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kbc_statement ON public.kbc_raw_transactions USING btree (statement_number);


--
-- Name: idx_manual_date_amount; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_date_amount ON public.manual_raw_transactions USING btree (date, amount);


--
-- Name: idx_manual_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_hash ON public.manual_raw_transactions USING btree (deduplication_hash);


--
-- Name: idx_manual_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manual_transaction_id ON public.manual_raw_transactions USING btree (transaction_id);


--
-- Name: idx_pf_staging_batch_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pf_staging_batch_status ON public.portfolio_import_staging_rows USING btree (batch_id, status);


--
-- Name: idx_pf_staging_tx_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pf_staging_tx_hash ON public.portfolio_import_staging_rows USING btree (tx_hash) WHERE (tx_hash IS NOT NULL);


--
-- Name: idx_ph_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ph_kind ON public.provider_health USING btree (kind);


--
-- Name: idx_planned_transaction_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_transaction_tags_tag ON public.planned_transaction_tags USING btree (tag_id);


--
-- Name: idx_planned_transactions_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planned_transactions_account_id ON public.planned_transactions USING btree (account_id);


--
-- Name: idx_portfolio_import_batches_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_import_batches_account_id ON public.portfolio_import_batches USING btree (account_id);


--
-- Name: idx_portfolio_import_batches_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_import_batches_started_at ON public.portfolio_import_batches USING btree (started_at DESC);


--
-- Name: idx_portfolio_import_batches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_import_batches_status ON public.portfolio_import_batches USING btree (status) WHERE (status <> ALL (ARRAY['complete'::text, 'failed'::text, 'aborted'::text]));


--
-- Name: idx_portfolio_performance_snapshots_currency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_performance_snapshots_currency ON public.portfolio_performance_snapshots USING btree (currency);


--
-- Name: idx_portfolio_transactions_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_transactions_account_id ON public.portfolio_transactions USING btree (account_id);


--
-- Name: idx_portfolio_txn_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_txn_date ON public.portfolio_transactions USING btree (date);


--
-- Name: idx_portfolio_txn_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_txn_investment_id ON public.portfolio_transactions USING btree (investment_id);


--
-- Name: idx_portfolio_txn_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_txn_type ON public.portfolio_transactions USING btree (type);


--
-- Name: idx_pps_date_currency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pps_date_currency ON public.portfolio_performance_snapshots USING btree (snapshot_date, currency);


--
-- Name: idx_pt_bank_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pt_bank_account ON public.planned_transactions USING btree (bank_account);


--
-- Name: idx_pt_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pt_category_id ON public.planned_transactions USING btree (category_id);


--
-- Name: idx_pt_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pt_is_active ON public.planned_transactions USING btree (is_active);


--
-- Name: idx_pt_is_executed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pt_is_executed ON public.planned_transactions USING btree (is_executed);


--
-- Name: idx_pt_is_loan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pt_is_loan ON public.planned_transactions USING btree (is_loan);


--
-- Name: idx_pt_is_recurring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pt_is_recurring ON public.planned_transactions USING btree (is_recurring);


--
-- Name: idx_pt_planned_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pt_planned_date ON public.planned_transactions USING btree (planned_date);


--
-- Name: idx_pt_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pt_recipient_id ON public.planned_transactions USING btree (recipient_id);


--
-- Name: idx_pte_executed_tx_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pte_executed_tx_id ON public.planned_transaction_executions USING btree (executed_transaction_id);


--
-- Name: idx_pte_planned_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pte_planned_id ON public.planned_transaction_executions USING btree (planned_transaction_id);


--
-- Name: idx_ptls_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ptls_due_date ON public.planned_transaction_loan_schedule USING btree (due_date);


--
-- Name: idx_ptls_planned_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ptls_planned_transaction_id ON public.planned_transaction_loan_schedule USING btree (planned_transaction_id);


--
-- Name: idx_raw_ref_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_raw_ref_source ON public.transaction_raw_references USING btree (raw_source_type, raw_source_id);


--
-- Name: idx_raw_ref_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_raw_ref_transaction_id ON public.transaction_raw_references USING btree (transaction_id);


--
-- Name: idx_rba_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rba_recipient_id ON public.recipient_bank_accounts USING btree (recipient_id);


--
-- Name: idx_recipients_default_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_default_category_id ON public.recipients USING btree (default_category_id);


--
-- Name: idx_recipients_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_name ON public.recipients USING btree (name);


--
-- Name: idx_recipients_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_name_trgm ON public.recipients USING gin (name public.gin_trgm_ops);


--
-- Name: idx_recipients_primary_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_primary_recipient_id ON public.recipients USING btree (primary_recipient_id);


--
-- Name: idx_revolut_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revolut_hash ON public.revolut_raw_transactions USING btree (deduplication_hash);


--
-- Name: idx_revolut_product_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revolut_product_date ON public.revolut_raw_transactions USING btree (product, completed_date);


--
-- Name: idx_revolut_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revolut_state ON public.revolut_raw_transactions USING btree (state);


--
-- Name: idx_rmp_active_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rmp_active_priority ON public.recipient_match_patterns USING btree (priority) WHERE (is_active = true);


--
-- Name: idx_rmp_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rmp_recipient ON public.recipient_match_patterns USING btree (recipient_id);


--
-- Name: idx_sabb_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sabb_date ON public.sabb_raw_transactions USING btree (transaction_date);


--
-- Name: idx_sabb_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sabb_hash ON public.sabb_raw_transactions USING btree (deduplication_hash);


--
-- Name: idx_split_audit_split_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_split_audit_split_id ON public.split_audit USING btree (split_id);


--
-- Name: idx_split_payments_split; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_split_payments_split ON public.split_payments USING btree (split_id);


--
-- Name: idx_splits_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_splits_recipient ON public.transaction_splits USING btree (recipient_id);


--
-- Name: idx_splits_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_splits_transaction ON public.transaction_splits USING btree (transaction_id);


--
-- Name: idx_splits_unsettled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_splits_unsettled ON public.transaction_splits USING btree (is_settled) WHERE (is_settled = false);


--
-- Name: idx_staging_batch_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_batch_status ON public.import_staging_rows USING btree (batch_id, status);


--
-- Name: idx_staging_override_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_override_category ON public.import_staging_rows USING btree (override_category_id) WHERE (override_category_id IS NOT NULL);


--
-- Name: idx_staging_tx_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_tx_hash ON public.import_staging_rows USING btree (tx_hash) WHERE (tx_hash IS NOT NULL);


--
-- Name: idx_tags_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_active ON public.tags USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_transaction_date_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_date_recipient ON public.transactions USING btree (date, recipient_id);


--
-- Name: idx_transaction_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_tags_tag ON public.transaction_tags USING btree (tag_id);


--
-- Name: idx_transactions_account_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_account_date_active ON public.transactions USING btree (account_id, date DESC) WHERE (is_active = true);


--
-- Name: idx_transactions_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_account_id ON public.transactions USING btree (account_id);


--
-- Name: idx_transactions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_active ON public.transactions USING btree (date DESC, id DESC) WHERE (is_active = true);


--
-- Name: idx_transactions_amount_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_amount_date ON public.transactions USING btree (amount, date);


--
-- Name: idx_transactions_bank_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_bank_account ON public.transactions USING btree (bank_account);


--
-- Name: idx_transactions_bank_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_bank_date ON public.transactions USING btree (bank_account, date DESC);


--
-- Name: idx_transactions_bank_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_bank_date_active ON public.transactions USING btree (bank_account, date DESC) WHERE (is_active = true);


--
-- Name: idx_transactions_category_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_category_date ON public.transactions USING btree (category_id, date DESC);


--
-- Name: idx_transactions_category_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_category_date_active ON public.transactions USING btree (category_id, date DESC) WHERE (is_active = true);


--
-- Name: idx_transactions_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_category_id ON public.transactions USING btree (category_id);


--
-- Name: idx_transactions_category_recipient_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_category_recipient_active ON public.transactions USING btree (category_id, recipient_id) WHERE (is_active = true);


--
-- Name: idx_transactions_comment_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_comment_trgm ON public.transactions USING gin (comment public.gin_trgm_ops);


--
-- Name: idx_transactions_import_batch_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_import_batch_id ON public.transactions USING btree (import_batch_id) WHERE (import_batch_id IS NOT NULL);


--
-- Name: idx_transactions_matched_pattern; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_matched_pattern ON public.transactions USING btree (matched_pattern_id) WHERE (matched_pattern_id IS NOT NULL);


--
-- Name: idx_transactions_memo_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_memo_trgm ON public.transactions USING gin (memo public.gin_trgm_ops);


--
-- Name: idx_transactions_portfolio_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_portfolio_txn ON public.transactions USING btree (portfolio_transaction_id) WHERE (portfolio_transaction_id IS NOT NULL);


--
-- Name: idx_transactions_recipient_bank_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_recipient_bank_account_id ON public.transactions USING btree (recipient_bank_account_id);


--
-- Name: idx_transactions_recipient_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_recipient_date ON public.transactions USING btree (recipient_id, date DESC);


--
-- Name: idx_transactions_recipient_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_recipient_date_active ON public.transactions USING btree (recipient_id, date DESC) WHERE (is_active = true);


--
-- Name: idx_transactions_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_recipient_id ON public.transactions USING btree (recipient_id);


--
-- Name: idx_transactions_transfer_peer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_transfer_peer ON public.transactions USING btree (transfer_peer_id) WHERE (transfer_peer_id IS NOT NULL);


--
-- Name: idx_vision_bank_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vision_bank_account ON public.vision_raw_transactions USING btree (bank_account);


--
-- Name: idx_vision_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vision_date ON public.vision_raw_transactions USING btree (transaction_date);


--
-- Name: idx_vision_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vision_hash ON public.vision_raw_transactions USING btree (deduplication_hash);


--
-- Name: idx_watchlist_asset_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchlist_asset_class ON public.watchlist USING btree (asset_class);


--
-- Name: idx_wise_finished_on; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wise_finished_on ON public.wise_raw_transactions USING btree (finished_on);


--
-- Name: idx_wise_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wise_hash ON public.wise_raw_transactions USING btree (deduplication_hash);


--
-- Name: idx_wise_transfer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wise_transfer_id ON public.wise_raw_transactions USING btree (transfer_id);


--
-- Name: ix_instrument_provider_map_provider_symbol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_instrument_provider_map_provider_symbol ON public.instrument_provider_map USING btree (provider, provider_symbol);


--
-- Name: mv_bank_balances_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mv_bank_balances_idx ON public.mv_bank_balances USING btree (bank_account, currency);


--
-- Name: uniq_pte_planned_executed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_pte_planned_executed ON public.planned_transaction_executions USING btree (planned_transaction_id, executed_transaction_id);


--
-- Name: uniq_transactions_tx_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_transactions_tx_hash ON public.transactions USING btree (tx_hash) WHERE (tx_hash IS NOT NULL);


--
-- Name: uq_custom_parser_configs_name_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_custom_parser_configs_name_kind ON public.custom_parser_configs USING btree (name, kind);


--
-- Name: uq_instrument_provider_map_key_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_instrument_provider_map_key_provider ON public.instrument_provider_map USING btree (instrument_key, key_type, provider);


--
-- Name: uq_recipient_primary_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_recipient_primary_account ON public.recipient_bank_accounts USING btree (recipient_id) WHERE is_primary;


--
-- Name: uq_tags_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_tags_slug ON public.tags USING btree (slug);


--
-- Name: transactions trg_agg_recipient_totals_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_agg_recipient_totals_sync AFTER INSERT OR DELETE OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.fn_agg_recipient_totals_sync();


--
-- Name: ai_messages trg_ai_messages_touch_conversation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ai_messages_touch_conversation AFTER INSERT ON public.ai_messages FOR EACH ROW EXECUTE FUNCTION public.touch_ai_conversation_updated_at();


--
-- Name: planned_transactions trg_planned_transactions_account_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_planned_transactions_account_sync BEFORE INSERT OR UPDATE ON public.planned_transactions FOR EACH ROW EXECUTE FUNCTION public.sync_account_id_from_bank_account();


--
-- Name: transaction_splits trg_split_outstanding_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_split_outstanding_sync AFTER INSERT OR DELETE OR UPDATE ON public.transaction_splits FOR EACH ROW EXECUTE FUNCTION public.fn_trg_split_sync();


--
-- Name: split_payments trg_split_payment_outstanding_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_split_payment_outstanding_sync AFTER INSERT OR DELETE OR UPDATE ON public.split_payments FOR EACH ROW EXECUTE FUNCTION public.fn_trg_split_payment_sync();


--
-- Name: transactions trg_transactions_account_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_transactions_account_sync BEFORE INSERT OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.sync_account_id_from_bank_account();


--
-- Name: accounts update_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: asset_price_history update_asset_price_history_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_asset_price_history_updated_at BEFORE UPDATE ON public.asset_price_history FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: belgian_inflation_rates update_belgian_inflation_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_belgian_inflation_updated_at BEFORE UPDATE ON public.belgian_inflation_rates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: categories update_categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: custom_parser_configs update_custom_parser_configs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_custom_parser_configs_updated_at BEFORE UPDATE ON public.custom_parser_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: instrument_provider_map update_instrument_provider_map_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_instrument_provider_map_updated_at BEFORE UPDATE ON public.instrument_provider_map FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: investments update_investments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_investments_updated_at BEFORE UPDATE ON public.investments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: portfolio_transactions update_portfolio_txn_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_portfolio_txn_updated_at BEFORE UPDATE ON public.portfolio_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: provider_api_keys update_provider_api_keys_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_provider_api_keys_updated_at BEFORE UPDATE ON public.provider_api_keys FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: provider_quota update_provider_quota_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_provider_quota_updated_at BEFORE UPDATE ON public.provider_quota FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: planned_transactions update_pt_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_pt_updated_at BEFORE UPDATE ON public.planned_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: planned_transaction_loan_schedule update_ptls_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_ptls_updated_at BEFORE UPDATE ON public.planned_transaction_loan_schedule FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: recipient_bank_accounts update_rba_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_rba_updated_at BEFORE UPDATE ON public.recipient_bank_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: recipient_match_patterns update_recipient_match_patterns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_recipient_match_patterns_updated_at BEFORE UPDATE ON public.recipient_match_patterns FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: recipients update_recipients_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_recipients_updated_at BEFORE UPDATE ON public.recipients FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: saved_charts update_saved_charts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_saved_charts_updated_at BEFORE UPDATE ON public.saved_charts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tags update_tags_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_tags_updated_at BEFORE UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: transaction_splits update_transaction_splits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_transaction_splits_updated_at BEFORE UPDATE ON public.transaction_splits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: transactions update_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: watchlist update_watchlist_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_watchlist_updated_at BEFORE UPDATE ON public.watchlist FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: accounts accounts_funding_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_funding_account_id_fkey FOREIGN KEY (funding_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: agg_recipient_totals agg_recipient_totals_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agg_recipient_totals
    ADD CONSTRAINT agg_recipient_totals_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.recipients(id) ON DELETE CASCADE;


--
-- Name: agg_split_outstanding agg_split_outstanding_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agg_split_outstanding
    ADD CONSTRAINT agg_split_outstanding_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.recipients(id) ON DELETE CASCADE;


--
-- Name: agg_split_outstanding agg_split_outstanding_split_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agg_split_outstanding
    ADD CONSTRAINT agg_split_outstanding_split_id_fkey FOREIGN KEY (split_id) REFERENCES public.transaction_splits(id) ON DELETE CASCADE;


--
-- Name: ai_messages ai_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE CASCADE;


--
-- Name: attachments attachments_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: asset_price_history fk_aph_investment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_price_history
    ADD CONSTRAINT fk_aph_investment FOREIGN KEY (investment_id) REFERENCES public.investments(id) ON DELETE CASCADE;


--
-- Name: manual_raw_transactions fk_mrt_category; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_raw_transactions
    ADD CONSTRAINT fk_mrt_category FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: manual_raw_transactions fk_mrt_recipient; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_raw_transactions
    ADD CONSTRAINT fk_mrt_recipient FOREIGN KEY (recipient_id) REFERENCES public.recipients(id) ON DELETE SET NULL;


--
-- Name: manual_raw_transactions fk_mrt_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_raw_transactions
    ADD CONSTRAINT fk_mrt_transaction FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;


--
-- Name: portfolio_import_staging_rows fk_pf_staging_override_investment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_import_staging_rows
    ADD CONSTRAINT fk_pf_staging_override_investment FOREIGN KEY (user_override_investment_id) REFERENCES public.investments(id) ON DELETE SET NULL;


--
-- Name: portfolio_import_staging_rows fk_pf_staging_resolved_investment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_import_staging_rows
    ADD CONSTRAINT fk_pf_staging_resolved_investment FOREIGN KEY (resolved_investment_id) REFERENCES public.investments(id) ON DELETE SET NULL;


--
-- Name: transactions fk_transactions_transfer_peer; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT fk_transactions_transfer_peer FOREIGN KEY (transfer_peer_id) REFERENCES public.transactions(id) ON DELETE SET NULL;


--
-- Name: import_staging_rows import_staging_rows_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_staging_rows
    ADD CONSTRAINT import_staging_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.import_batches(id) ON DELETE CASCADE;


--
-- Name: import_staging_rows import_staging_rows_matched_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_staging_rows
    ADD CONSTRAINT import_staging_rows_matched_pattern_id_fkey FOREIGN KEY (matched_pattern_id) REFERENCES public.recipient_match_patterns(id) ON DELETE SET NULL;


--
-- Name: import_staging_rows import_staging_rows_override_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_staging_rows
    ADD CONSTRAINT import_staging_rows_override_category_id_fkey FOREIGN KEY (override_category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: import_staging_rows import_staging_rows_user_override_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_staging_rows
    ADD CONSTRAINT import_staging_rows_user_override_recipient_id_fkey FOREIGN KEY (user_override_recipient_id) REFERENCES public.recipients(id) ON DELETE SET NULL;


--
-- Name: planned_transaction_executions planned_transaction_executions_executed_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_executions
    ADD CONSTRAINT planned_transaction_executions_executed_transaction_id_fkey FOREIGN KEY (executed_transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: planned_transaction_executions planned_transaction_executions_planned_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_executions
    ADD CONSTRAINT planned_transaction_executions_planned_transaction_id_fkey FOREIGN KEY (planned_transaction_id) REFERENCES public.planned_transactions(id) ON DELETE CASCADE;


--
-- Name: planned_transaction_loan_schedule planned_transaction_loan_schedule_planned_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_loan_schedule
    ADD CONSTRAINT planned_transaction_loan_schedule_planned_transaction_id_fkey FOREIGN KEY (planned_transaction_id) REFERENCES public.planned_transactions(id) ON DELETE CASCADE;


--
-- Name: planned_transaction_tags planned_transaction_tags_planned_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_tags
    ADD CONSTRAINT planned_transaction_tags_planned_transaction_id_fkey FOREIGN KEY (planned_transaction_id) REFERENCES public.planned_transactions(id) ON DELETE CASCADE;


--
-- Name: planned_transaction_tags planned_transaction_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transaction_tags
    ADD CONSTRAINT planned_transaction_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: planned_transactions planned_transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transactions
    ADD CONSTRAINT planned_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: planned_transactions planned_transactions_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transactions
    ADD CONSTRAINT planned_transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: planned_transactions planned_transactions_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transactions
    ADD CONSTRAINT planned_transactions_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.recipients(id);


--
-- Name: portfolio_import_batches portfolio_import_batches_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_import_batches
    ADD CONSTRAINT portfolio_import_batches_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: portfolio_import_staging_rows portfolio_import_staging_rows_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_import_staging_rows
    ADD CONSTRAINT portfolio_import_staging_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.portfolio_import_batches(id) ON DELETE CASCADE;


--
-- Name: portfolio_transactions portfolio_transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_transactions
    ADD CONSTRAINT portfolio_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: portfolio_transactions portfolio_transactions_investment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_transactions
    ADD CONSTRAINT portfolio_transactions_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES public.investments(id) ON DELETE CASCADE;


--
-- Name: recipient_bank_accounts recipient_bank_accounts_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_bank_accounts
    ADD CONSTRAINT recipient_bank_accounts_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.recipients(id);


--
-- Name: recipient_match_patterns recipient_match_patterns_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_match_patterns
    ADD CONSTRAINT recipient_match_patterns_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.recipients(id) ON DELETE CASCADE;


--
-- Name: recipients recipients_default_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipients
    ADD CONSTRAINT recipients_default_category_id_fkey FOREIGN KEY (default_category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: recipients recipients_primary_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipients
    ADD CONSTRAINT recipients_primary_recipient_id_fkey FOREIGN KEY (primary_recipient_id) REFERENCES public.recipients(id) ON DELETE SET NULL;


--
-- Name: split_audit split_audit_split_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.split_audit
    ADD CONSTRAINT split_audit_split_id_fkey FOREIGN KEY (split_id) REFERENCES public.transaction_splits(id) ON DELETE SET NULL;


--
-- Name: split_payments split_payments_split_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.split_payments
    ADD CONSTRAINT split_payments_split_id_fkey FOREIGN KEY (split_id) REFERENCES public.transaction_splits(id) ON DELETE CASCADE;


--
-- Name: transaction_raw_references transaction_raw_references_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_raw_references
    ADD CONSTRAINT transaction_raw_references_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: transaction_splits transaction_splits_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.recipients(id) ON DELETE CASCADE;


--
-- Name: transaction_splits transaction_splits_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: transaction_tags transaction_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_tags
    ADD CONSTRAINT transaction_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: transaction_tags transaction_tags_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_tags
    ADD CONSTRAINT transaction_tags_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: transactions transactions_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: transactions transactions_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES public.import_batches(id) ON DELETE SET NULL;


--
-- Name: transactions transactions_matched_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_matched_pattern_id_fkey FOREIGN KEY (matched_pattern_id) REFERENCES public.recipient_match_patterns(id) ON DELETE SET NULL;


--
-- Name: transactions transactions_recipient_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_recipient_bank_account_id_fkey FOREIGN KEY (recipient_bank_account_id) REFERENCES public.recipient_bank_accounts(id);


--
-- Name: transactions transactions_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.recipients(id);


--
-- PostgreSQL database dump complete
--

\unrestrict lIUeEldabT1bi4Gqw6ZKRZblxp2XaOkmTxE4Q1XpUi3FsG1R5Ze49ONbhv5uEvS

--
-- PostgreSQL database dump
--

\restrict XgzPvPqaGo5JoLzMZlRORrNEitMz7Ruz8APrkQ2NBEaxb7mdoAYERSr8frdLPYj

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4 (Homebrew)

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
-- Data for Name: accounts; Type: TABLE DATA; Schema: public; Owner: -
--

SET SESSION AUTHORIZATION DEFAULT;

ALTER TABLE public.accounts DISABLE TRIGGER ALL;

COPY public.accounts (id, name, display_name, institution, currency, type, liquidity_class, spendable, in_net_worth, tax_wrapper, owner, multi_currency_cash, has_cash_sleeve, funding_account_id, is_active, created_at, updated_at, statement_balance, statement_balance_date) FROM stdin;
1	BE76 7340 1234 5678	KBC Zichtrekening	KBC	EUR	checking	liquid	t	t	none	joint	f	t	\N	t	2026-06-19 10:30:17.134678+00	2026-06-19 10:30:17.134678+00	28003.32	2026-06-18
2	BE12 0688 1947 5532	KBC Spaarrekening	KBC	EUR	savings	semi_liquid	t	t	none	joint	f	t	\N	t	2026-06-19 10:30:17.135662+00	2026-06-19 10:30:17.135662+00	40097.65	2026-06-18
3	DEGIRO Beleggingsrekening	DEGIRO	DEGIRO	EUR	brokerage	liquid	t	t	none	me	f	t	\N	t	2026-06-19 10:30:17.136187+00	2026-06-19 10:30:17.136187+00	\N	\N
4	Interactive Brokers	IBKR	Interactive Brokers	EUR	brokerage	liquid	t	t	none	partner	f	t	\N	t	2026-06-19 10:30:17.136651+00	2026-06-19 10:30:17.136651+00	\N	\N
5	KBC Woonkrediet	Hypotheek woning Gent	KBC	EUR	liability	illiquid	f	t	none	joint	f	f	\N	t	2026-06-19 10:30:17.137162+00	2026-06-19 10:30:17.137162+00	\N	\N
6	Bitvavo	Bitvavo	Bitvavo	EUR	crypto_exchange	liquid	t	t	none	me	f	t	\N	t	2026-06-19 10:30:17.137631+00	2026-06-19 10:30:17.137631+00	\N	\N
\.


ALTER TABLE public.accounts ENABLE TRIGGER ALL;

--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.categories DISABLE TRIGGER ALL;

COPY public.categories (id, general, detail, description, is_active, created_at, updated_at) FROM stdin;
1	INCOME	SALARY	\N	t	2026-06-19 10:30:17.068389+00	2026-06-19 10:30:17.068389+00
2	INCOME	BONUS	\N	t	2026-06-19 10:30:17.071677+00	2026-06-19 10:30:17.071677+00
3	INCOME	REFUND	\N	t	2026-06-19 10:30:17.072615+00	2026-06-19 10:30:17.072615+00
4	INCOME	INTEREST	\N	t	2026-06-19 10:30:17.07346+00	2026-06-19 10:30:17.07346+00
5	INCOME	GIFT	\N	t	2026-06-19 10:30:17.075275+00	2026-06-19 10:30:17.075275+00
6	HOUSING	RENT	\N	t	2026-06-19 10:30:17.076439+00	2026-06-19 10:30:17.076439+00
7	HOUSING	MORTGAGE	\N	t	2026-06-19 10:30:17.07787+00	2026-06-19 10:30:17.07787+00
8	HOUSING	UTILITIES	\N	t	2026-06-19 10:30:17.078747+00	2026-06-19 10:30:17.078747+00
9	HOUSING	INTERNET	\N	t	2026-06-19 10:30:17.079498+00	2026-06-19 10:30:17.079498+00
10	HOUSING	INSURANCE	\N	t	2026-06-19 10:30:17.080205+00	2026-06-19 10:30:17.080205+00
11	FOOD	GROCERIES	\N	t	2026-06-19 10:30:17.080771+00	2026-06-19 10:30:17.080771+00
12	FOOD	RESTAURANT	\N	t	2026-06-19 10:30:17.081457+00	2026-06-19 10:30:17.081457+00
13	FOOD	TAKEAWAY	\N	t	2026-06-19 10:30:17.08255+00	2026-06-19 10:30:17.08255+00
14	FOOD	COFFEE	\N	t	2026-06-19 10:30:17.083539+00	2026-06-19 10:30:17.083539+00
15	TRANSPORT	FUEL	\N	t	2026-06-19 10:30:17.084187+00	2026-06-19 10:30:17.084187+00
16	TRANSPORT	PUBLIC	\N	t	2026-06-19 10:30:17.084883+00	2026-06-19 10:30:17.084883+00
17	TRANSPORT	CAR	\N	t	2026-06-19 10:30:17.085412+00	2026-06-19 10:30:17.085412+00
18	TRANSPORT	PARKING	\N	t	2026-06-19 10:30:17.085856+00	2026-06-19 10:30:17.085856+00
19	HEALTH	PHARMACY	\N	t	2026-06-19 10:30:17.086339+00	2026-06-19 10:30:17.086339+00
20	HEALTH	DOCTOR	\N	t	2026-06-19 10:30:17.086814+00	2026-06-19 10:30:17.086814+00
21	HEALTH	INSURANCE	\N	t	2026-06-19 10:30:17.087268+00	2026-06-19 10:30:17.087268+00
22	LEISURE	STREAMING	\N	t	2026-06-19 10:30:17.087732+00	2026-06-19 10:30:17.087732+00
23	LEISURE	SPORT	\N	t	2026-06-19 10:30:17.088158+00	2026-06-19 10:30:17.088158+00
24	LEISURE	HOBBIES	\N	t	2026-06-19 10:30:17.08861+00	2026-06-19 10:30:17.08861+00
25	LEISURE	TRAVEL	\N	t	2026-06-19 10:30:17.089059+00	2026-06-19 10:30:17.089059+00
26	SHOPPING	CLOTHING	\N	t	2026-06-19 10:30:17.089519+00	2026-06-19 10:30:17.089519+00
27	SHOPPING	ELECTRONICS	\N	t	2026-06-19 10:30:17.090095+00	2026-06-19 10:30:17.090095+00
28	SHOPPING	HOME	\N	t	2026-06-19 10:30:17.090694+00	2026-06-19 10:30:17.090694+00
29	FINANCE	SAVINGS	\N	t	2026-06-19 10:30:17.091656+00	2026-06-19 10:30:17.091656+00
30	FINANCE	INVESTMENT	\N	t	2026-06-19 10:30:17.092367+00	2026-06-19 10:30:17.092367+00
31	FINANCE	FEES	\N	t	2026-06-19 10:30:17.093046+00	2026-06-19 10:30:17.093046+00
32	FINANCE	TAX	\N	t	2026-06-19 10:30:17.093912+00	2026-06-19 10:30:17.093912+00
33	TELECOM	MOBILE	\N	t	2026-06-19 10:30:17.094579+00	2026-06-19 10:30:17.094579+00
\.


ALTER TABLE public.categories ENABLE TRIGGER ALL;

--
-- Data for Name: recipients; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.recipients DISABLE TRIGGER ALL;

COPY public.recipients (id, name, normalized_name, default_category_id, primary_recipient_id, notes, is_active, created_at, updated_at) FROM stdin;
1	Tech Solutions BVBA	TECH SOLUTIONS BVBA	1	\N	\N	t	2026-06-19 10:30:17.09501+00	2026-06-19 10:30:17.09501+00
2	Creatief Bureau BVBA	CREATIEF BUREAU BVBA	1	\N	\N	t	2026-06-19 10:30:17.097025+00	2026-06-19 10:30:17.097025+00
3	Freelance Klant Vander	FREELANCE KLANT VANDER	2	\N	\N	t	2026-06-19 10:30:17.097685+00	2026-06-19 10:30:17.097685+00
4	Engie Electrabel	ENGIE ELECTRABEL	8	\N	\N	t	2026-06-19 10:30:17.098431+00	2026-06-19 10:30:17.098431+00
5	Farys	FARYS	8	\N	\N	t	2026-06-19 10:30:17.099183+00	2026-06-19 10:30:17.099183+00
6	Telenet	TELENET	9	\N	\N	t	2026-06-19 10:30:17.1+00	2026-06-19 10:30:17.1+00
7	Proximus	PROXIMUS	33	\N	\N	t	2026-06-19 10:30:17.100743+00	2026-06-19 10:30:17.100743+00
8	Netflix	NETFLIX	22	\N	\N	t	2026-06-19 10:30:17.101658+00	2026-06-19 10:30:17.101658+00
9	Spotify	SPOTIFY	22	\N	\N	t	2026-06-19 10:30:17.102345+00	2026-06-19 10:30:17.102345+00
10	Disney Plus	DISNEY PLUS	22	\N	\N	t	2026-06-19 10:30:17.10285+00	2026-06-19 10:30:17.10285+00
11	Basic-Fit	BASIC FIT	23	\N	\N	t	2026-06-19 10:30:17.103311+00	2026-06-19 10:30:17.103311+00
12	AG Insurance	AG INSURANCE	10	\N	\N	t	2026-06-19 10:30:17.103742+00	2026-06-19 10:30:17.103742+00
13	DKV Belgium	DKV BELGIUM	21	\N	\N	t	2026-06-19 10:30:17.10427+00	2026-06-19 10:30:17.10427+00
14	De Lijn	DE LIJN	16	\N	\N	t	2026-06-19 10:30:17.104719+00	2026-06-19 10:30:17.104719+00
15	NMBS	NMBS	16	\N	\N	t	2026-06-19 10:30:17.105205+00	2026-06-19 10:30:17.105205+00
16	DEGIRO	DEGIRO	30	\N	\N	t	2026-06-19 10:30:17.105719+00	2026-06-19 10:30:17.105719+00
17	KBC Bank	KBC BANK	4	\N	\N	t	2026-06-19 10:30:17.106388+00	2026-06-19 10:30:17.106388+00
18	FOD Financien	FOD FINANCIEN	32	\N	\N	t	2026-06-19 10:30:17.10701+00	2026-06-19 10:30:17.10701+00
19	Eigen Spaarrekening	EIGEN SPAARREKENING	29	\N	\N	t	2026-06-19 10:30:17.107754+00	2026-06-19 10:30:17.107754+00
20	Onbekende Begunstigde	ONBEKENDE BEGUNSTIGDE	\N	\N	\N	t	2026-06-19 10:30:17.108375+00	2026-06-19 10:30:17.108375+00
21	Colruyt	COLRUYT	11	\N	\N	t	2026-06-19 10:30:17.108914+00	2026-06-19 10:30:17.108914+00
22	Delhaize	DELHAIZE	11	\N	\N	t	2026-06-19 10:30:17.109599+00	2026-06-19 10:30:17.109599+00
23	Carrefour	CARREFOUR	11	\N	\N	t	2026-06-19 10:30:17.110267+00	2026-06-19 10:30:17.110267+00
24	Albert Heijn	ALBERT HEIJN	11	\N	\N	t	2026-06-19 10:30:17.11084+00	2026-06-19 10:30:17.11084+00
25	Aldi	ALDI	11	\N	\N	t	2026-06-19 10:30:17.111342+00	2026-06-19 10:30:17.111342+00
26	Lidl	LIDL	11	\N	\N	t	2026-06-19 10:30:17.111808+00	2026-06-19 10:30:17.111808+00
27	Q8	Q8	15	\N	\N	t	2026-06-19 10:30:17.112257+00	2026-06-19 10:30:17.112257+00
28	Total	TOTAL	15	\N	\N	t	2026-06-19 10:30:17.112795+00	2026-06-19 10:30:17.112795+00
29	Shell	SHELL	15	\N	\N	t	2026-06-19 10:30:17.113281+00	2026-06-19 10:30:17.113281+00
30	Restaurant De Vis	RESTAURANT DE VIS	12	\N	\N	t	2026-06-19 10:30:17.113765+00	2026-06-19 10:30:17.113765+00
31	Pizza Napoli	PIZZA NAPOLI	12	\N	\N	t	2026-06-19 10:30:17.114206+00	2026-06-19 10:30:17.114206+00
32	Brasserie Central	BRASSERIE CENTRAL	12	\N	\N	t	2026-06-19 10:30:17.114879+00	2026-06-19 10:30:17.114879+00
33	Starbucks	STARBUCKS	14	\N	\N	t	2026-06-19 10:30:17.115667+00	2026-06-19 10:30:17.115667+00
34	Bar Mocca	BAR MOCCA	14	\N	\N	t	2026-06-19 10:30:17.116563+00	2026-06-19 10:30:17.116563+00
35	Bolt Food	BOLT FOOD	13	\N	\N	t	2026-06-19 10:30:17.117081+00	2026-06-19 10:30:17.117081+00
36	Deliveroo	DELIVEROO	13	\N	\N	t	2026-06-19 10:30:17.117571+00	2026-06-19 10:30:17.117571+00
37	Apotheek Centrum	APOTHEEK CENTRUM	19	\N	\N	t	2026-06-19 10:30:17.118086+00	2026-06-19 10:30:17.118086+00
38	Dr. Janssens	DR JANSSENS	20	\N	\N	t	2026-06-19 10:30:17.118647+00	2026-06-19 10:30:17.118647+00
39	Parking Gent	PARKING GENT	18	\N	\N	t	2026-06-19 10:30:17.119126+00	2026-06-19 10:30:17.119126+00
40	Bol.com	BOL COM	27	\N	\N	t	2026-06-19 10:30:17.120421+00	2026-06-19 10:30:17.120421+00
41	Coolblue	COOLBLUE	27	\N	\N	t	2026-06-19 10:30:17.120939+00	2026-06-19 10:30:17.120939+00
42	MediaMarkt	MEDIAMARKT	27	\N	\N	t	2026-06-19 10:30:17.121462+00	2026-06-19 10:30:17.121462+00
43	Zalando	ZALANDO	26	\N	\N	t	2026-06-19 10:30:17.121965+00	2026-06-19 10:30:17.121965+00
44	H&M	H M	26	\N	\N	t	2026-06-19 10:30:17.122646+00	2026-06-19 10:30:17.122646+00
45	IKEA	IKEA	28	\N	\N	t	2026-06-19 10:30:17.123643+00	2026-06-19 10:30:17.123643+00
46	Booking.com	BOOKING COM	25	\N	\N	t	2026-06-19 10:30:17.124496+00	2026-06-19 10:30:17.124496+00
47	Brussels Airlines	BRUSSELS AIRLINES	25	\N	\N	t	2026-06-19 10:30:17.125194+00	2026-06-19 10:30:17.125194+00
48	Decathlon	DECATHLON	24	\N	\N	t	2026-06-19 10:30:17.125848+00	2026-06-19 10:30:17.125848+00
49	Standaard Boekhandel	STANDAARD BOEKHANDEL	24	\N	\N	t	2026-06-19 10:30:17.126819+00	2026-06-19 10:30:17.126819+00
50	Thomas Peeters	THOMAS PEETERS	12	\N	\N	t	2026-06-19 10:30:17.127536+00	2026-06-19 10:30:17.127536+00
51	Sarah Maes	SARAH MAES	12	\N	\N	t	2026-06-19 10:30:17.128135+00	2026-06-19 10:30:17.128135+00
52	Lukas De Smet	LUKAS DE SMET	25	\N	\N	t	2026-06-19 10:30:17.128689+00	2026-06-19 10:30:17.128689+00
53	KBC Woonkrediet	KBC WOONKREDIET	7	\N	\N	t	2026-06-19 10:30:17.129272+00	2026-06-19 10:30:17.129272+00
\.


ALTER TABLE public.recipients ENABLE TRIGGER ALL;

--
-- Data for Name: agg_recipient_totals; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.agg_recipient_totals DISABLE TRIGGER ALL;

COPY public.agg_recipient_totals (recipient_id, currency, total_amount, transaction_count, last_transaction_date, updated_at) FROM stdin;
1	EUR	103893.00	31	2026-05-25	2026-06-19 10:30:17.959522+00
19	EUR	0.00	58	2026-05-28	2026-06-19 10:30:17.962141+00
5	EUR	-574.91	10	2026-05-15	2026-06-19 10:30:17.963958+00
25	EUR	-1877.04	23	2026-03-30	2026-06-19 10:30:17.917614+00
16	EUR	-21750.00	29	2026-05-27	2026-06-19 10:30:17.970841+00
21	EUR	-1632.60	21	2026-05-11	2026-06-19 10:30:17.972255+00
26	EUR	-1710.26	24	2026-05-18	2026-06-19 10:30:17.973515+00
42	EUR	-1617.85	3	2025-03-11	2026-06-19 10:30:17.602438+00
27	EUR	-1115.92	17	2026-05-26	2026-06-19 10:30:17.974913+00
32	EUR	-1317.33	23	2026-05-11	2026-06-19 10:30:17.97558+00
44	EUR	-708.74	7	2025-05-09	2026-06-19 10:30:17.661987+00
38	EUR	-88.21	2	2026-03-07	2026-06-19 10:30:17.929321+00
17	EUR	197.63	10	2026-04-02	2026-06-19 10:30:17.931843+00
15	EUR	-258.24	9	2026-04-16	2026-06-19 10:30:17.943169+00
37	EUR	-415.82	17	2026-05-06	2026-06-19 10:30:17.983535+00
39	EUR	-123.61	13	2026-05-20	2026-06-19 10:30:17.984292+00
2	EUR	43007.00	30	2026-06-05	2026-06-19 10:30:17.985102+00
3	EUR	5214.72	9	2026-06-15	2026-06-19 10:30:17.985961+00
24	EUR	-1398.06	19	2025-12-25	2026-06-19 10:30:17.847286+00
53	EUR	-27974.40	30	2026-06-03	2026-06-19 10:30:17.98662+00
4	EUR	-3584.67	30	2026-06-10	2026-06-19 10:30:17.987257+00
6	EUR	-1620.00	30	2026-06-12	2026-06-19 10:30:17.988013+00
7	EUR	-660.00	30	2026-06-12	2026-06-19 10:30:17.98869+00
12	EUR	-1350.00	30	2026-06-06	2026-06-19 10:30:17.989411+00
13	EUR	-1140.00	30	2026-06-06	2026-06-19 10:30:17.990132+00
29	EUR	-811.00	12	2026-04-09	2026-06-19 10:30:17.947674+00
8	EUR	-419.70	30	2026-06-18	2026-06-19 10:30:17.990907+00
9	EUR	-329.70	30	2026-06-05	2026-06-19 10:30:17.99163+00
48	EUR	-120.33	3	2025-10-04	2026-06-19 10:30:17.807947+00
10	EUR	-161.82	18	2026-06-05	2026-06-19 10:30:17.992389+00
11	EUR	-899.70	30	2026-06-02	2026-06-19 10:30:17.993205+00
18	EUR	-2020.67	3	2025-10-15	2026-06-19 10:30:17.808962+00
14	EUR	-1470.00	30	2026-06-03	2026-06-19 10:30:17.993902+00
23	EUR	-2090.24	25	2026-06-09	2026-06-19 10:30:17.995969+00
22	EUR	-2009.64	23	2026-06-05	2026-06-19 10:30:17.997018+00
28	EUR	-1067.45	16	2026-06-06	2026-06-19 10:30:17.998875+00
33	EUR	-309.34	61	2026-04-27	2026-06-19 10:30:17.953435+00
45	EUR	-1410.02	6	2026-02-08	2026-06-19 10:30:17.903108+00
30	EUR	-1385.65	25	2026-06-04	2026-06-19 10:30:18.001036+00
31	EUR	-1759.62	30	2026-06-13	2026-06-19 10:30:18.002348+00
34	EUR	-356.05	69	2026-06-16	2026-06-19 10:30:18.004664+00
36	EUR	-842.95	29	2026-06-09	2026-06-19 10:30:18.005393+00
46	EUR	-399.11	1	2024-08-10	2026-06-19 10:30:17.389522+00
35	EUR	-768.39	28	2026-06-01	2026-06-19 10:30:18.006105+00
41	EUR	-2312.24	6	2026-06-14	2026-06-19 10:30:18.006863+00
43	EUR	-588.55	5	2026-06-04	2026-06-19 10:30:18.007714+00
47	EUR	-1726.59	4	2026-06-01	2026-06-19 10:30:18.009369+00
40	EUR	-1603.59	5	2026-04-30	2026-06-19 10:30:17.957307+00
49	EUR	-264.78	6	2026-04-08	2026-06-19 10:30:17.957913+00
20	EUR	-382.00	11	2026-04-22	2026-06-19 10:30:17.958865+00
\.


ALTER TABLE public.agg_recipient_totals ENABLE TRIGGER ALL;

--
-- Data for Name: import_batches; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.import_batches DISABLE TRIGGER ALL;

COPY public.import_batches (id, adapter_name, source_filename, source_size_bytes, custom_config, status, rows_total, rows_imported, rows_duplicate, rows_error, error_summary, started_at, completed_at) FROM stdin;
\.


ALTER TABLE public.import_batches ENABLE TRIGGER ALL;

--
-- Data for Name: recipient_bank_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.recipient_bank_accounts DISABLE TRIGGER ALL;

COPY public.recipient_bank_accounts (id, recipient_id, account_number, bank_name, account_label, address, is_primary, is_active, created_at, updated_at) FROM stdin;
1	2	BE68 5390 0754 7034	KBC	\N	\N	t	t	2026-06-19 10:30:17.129768+00	2026-06-19 10:30:17.129768+00
2	1	BE71 0961 2345 6769	BNP Paribas Fortis	\N	\N	t	t	2026-06-19 10:30:17.131011+00	2026-06-19 10:30:17.131011+00
3	53	BE62 5100 0754 7061	KBC	\N	\N	t	t	2026-06-19 10:30:17.131618+00	2026-06-19 10:30:17.131618+00
\.


ALTER TABLE public.recipient_bank_accounts ENABLE TRIGGER ALL;

--
-- Data for Name: recipient_match_patterns; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.recipient_match_patterns DISABLE TRIGGER ALL;

COPY public.recipient_match_patterns (id, recipient_id, pattern, pattern_kind, case_sensitive, priority, is_active, source, notes, created_at, updated_at) FROM stdin;
1	21	COLRUYT	literal_prefix	f	10	t	user	\N	2026-06-19 10:30:17.132626+00	2026-06-19 10:30:17.132626+00
2	1	SALARIS TECH SOLUTIONS	literal_prefix	f	10	t	user	\N	2026-06-19 10:30:17.134093+00	2026-06-19 10:30:17.134093+00
\.


ALTER TABLE public.recipient_match_patterns ENABLE TRIGGER ALL;

--
-- Data for Name: transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.transactions DISABLE TRIGGER ALL;

COPY public.transactions (id, date, amount, currency, balance, memo, comment, bank_account, recipient_id, recipient_bank_account_id, category_id, is_active, created_at, updated_at, import_batch_id, matched_pattern_id, tx_hash, is_transfer, transfer_peer_id, transfer_source, account_id, portfolio_transaction_id) FROM stdin;
1	2024-01-25	3404.0000	EUR	7157.95	Loon januari 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.138111+00	2026-06-19 10:30:17.138111+00	\N	\N	\N	f	\N	\N	1	\N
2	2024-01-05	1387.0000	EUR	4431.00	Loon partner januari 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.14305+00	2026-06-19 10:30:17.14305+00	\N	\N	\N	f	\N	\N	1	\N
3	2024-01-02	24.5143	EUR	8024.51	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.144506+00	2026-06-19 10:30:17.144506+00	\N	\N	\N	f	\N	\N	2	\N
4	2024-01-28	-1100.0000	EUR	5164.19	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.145985+00	2026-06-19 10:30:17.145985+00	\N	\N	\N	f	\N	\N	1	\N
5	2024-01-28	1100.0000	EUR	9124.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.14717+00	2026-06-19 10:30:17.14717+00	\N	\N	\N	f	\N	\N	2	\N
6	2024-01-03	-932.4795	EUR	3210.57	Hypotheek aflossing januari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.148332+00	2026-06-19 10:30:17.148332+00	\N	\N	\N	f	\N	\N	1	\N
7	2024-01-09	-120.5354	EUR	4129.05	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.150352+00	2026-06-19 10:30:17.150352+00	\N	\N	\N	f	\N	\N	1	\N
8	2024-01-12	-54.0000	EUR	3943.09	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.151397+00	2026-06-19 10:30:17.151397+00	\N	\N	\N	f	\N	\N	1	\N
9	2024-01-12	-22.0000	EUR	3921.09	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.152086+00	2026-06-19 10:30:17.152086+00	\N	\N	\N	f	\N	\N	1	\N
10	2024-01-06	-45.0000	EUR	4375.01	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.152872+00	2026-06-19 10:30:17.152872+00	\N	\N	\N	f	\N	\N	1	\N
11	2024-01-06	-38.0000	EUR	4337.01	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.153615+00	2026-06-19 10:30:17.153615+00	\N	\N	\N	f	\N	\N	1	\N
12	2024-01-18	-13.9900	EUR	3761.27	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.154279+00	2026-06-19 10:30:17.154279+00	\N	\N	\N	f	\N	\N	1	\N
13	2024-01-05	-10.9900	EUR	4420.01	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.154878+00	2026-06-19 10:30:17.154878+00	\N	\N	\N	f	\N	\N	1	\N
14	2024-01-02	-29.9900	EUR	4170.01	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.155499+00	2026-06-19 10:30:17.155499+00	\N	\N	\N	f	\N	\N	1	\N
15	2024-01-03	-49.0000	EUR	3161.57	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.156092+00	2026-06-19 10:30:17.156092+00	\N	\N	\N	f	\N	\N	1	\N
16	2024-01-27	-750.0000	EUR	6407.95	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.156883+00	2026-06-19 10:30:17.156883+00	\N	\N	\N	f	\N	\N	1	\N
17	2024-01-15	-52.5459	EUR	3809.77	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.158125+00	2026-06-19 10:30:17.158125+00	\N	\N	\N	f	\N	\N	1	\N
18	2024-01-31	-57.7418	EUR	5099.88	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.159191+00	2026-06-19 10:30:17.159191+00	\N	\N	\N	f	\N	\N	1	\N
19	2024-01-03	-33.9709	EUR	3127.60	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.160206+00	2026-06-19 10:30:17.160206+00	\N	\N	\N	f	\N	\N	1	\N
20	2024-01-04	-83.5986	EUR	3044.00	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.161418+00	2026-06-19 10:30:17.161418+00	\N	\N	\N	f	\N	\N	1	\N
21	2024-01-10	-127.0979	EUR	3997.09	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.162396+00	2026-06-19 10:30:17.162396+00	\N	\N	\N	f	\N	\N	1	\N
22	2024-01-13	-58.7818	EUR	3862.31	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.163231+00	2026-06-19 10:30:17.163231+00	\N	\N	\N	f	\N	\N	1	\N
23	2024-01-08	-73.3710	EUR	4249.59	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.164147+00	2026-06-19 10:30:17.164147+00	\N	\N	\N	f	\N	\N	1	\N
24	2024-01-31	-66.8117	EUR	5033.07	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.165128+00	2026-06-19 10:30:17.165128+00	\N	\N	\N	f	\N	\N	1	\N
25	2024-01-19	-7.3248	EUR	3753.95	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.166976+00	2026-06-19 10:30:17.166976+00	\N	\N	\N	f	\N	\N	1	\N
26	2024-01-30	-6.5687	EUR	5157.62	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.16836+00	2026-06-19 10:30:17.16836+00	\N	\N	\N	f	\N	\N	1	\N
27	2024-01-17	-6.2067	EUR	3803.56	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.169255+00	2026-06-19 10:30:17.169255+00	\N	\N	\N	f	\N	\N	1	\N
28	2024-01-09	-4.8619	EUR	4124.19	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.170082+00	2026-06-19 10:30:17.170082+00	\N	\N	\N	f	\N	\N	1	\N
29	2024-01-31	-21.4197	EUR	5011.65	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.171371+00	2026-06-19 10:30:17.171371+00	\N	\N	\N	f	\N	\N	1	\N
30	2024-01-02	-26.9624	EUR	4143.05	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.172084+00	2026-06-19 10:30:17.172084+00	\N	\N	\N	f	\N	\N	1	\N
31	2024-01-17	-28.2962	EUR	3775.26	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.172783+00	2026-06-19 10:30:17.172783+00	\N	\N	\N	f	\N	\N	1	\N
32	2024-01-27	-143.7558	EUR	6264.19	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-19 10:30:17.173613+00	2026-06-19 10:30:17.173613+00	\N	\N	\N	f	\N	\N	1	\N
33	2024-01-07	-14.0490	EUR	4322.96	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.175036+00	2026-06-19 10:30:17.175036+00	\N	\N	\N	f	\N	\N	1	\N
34	2024-02-25	3404.0000	EUR	7749.13	Loon februari 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.176142+00	2026-06-19 10:30:17.176142+00	\N	\N	\N	f	\N	\N	1	\N
35	2024-02-05	1400.0000	EUR	5130.14	Loon partner februari 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.177437+00	2026-06-19 10:30:17.177437+00	\N	\N	\N	f	\N	\N	1	\N
36	2024-02-28	-1100.0000	EUR	5761.73	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.178467+00	2026-06-19 10:30:17.178467+00	\N	\N	\N	f	\N	\N	1	\N
37	2024-02-28	1100.0000	EUR	10224.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.179212+00	2026-06-19 10:30:17.179212+00	\N	\N	\N	f	\N	\N	2	\N
38	2024-02-03	-932.4795	EUR	3860.84	Hypotheek aflossing februari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.179869+00	2026-06-19 10:30:17.179869+00	\N	\N	\N	f	\N	\N	1	\N
39	2024-02-11	-94.8291	EUR	4672.42	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.180545+00	2026-06-19 10:30:17.180545+00	\N	\N	\N	f	\N	\N	1	\N
40	2024-02-15	-51.3546	EUR	4512.19	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.181281+00	2026-06-19 10:30:17.181281+00	\N	\N	\N	f	\N	\N	1	\N
41	2024-02-12	-54.0000	EUR	4618.42	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.181972+00	2026-06-19 10:30:17.181972+00	\N	\N	\N	f	\N	\N	1	\N
42	2024-02-12	-22.0000	EUR	4596.42	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.182877+00	2026-06-19 10:30:17.182877+00	\N	\N	\N	f	\N	\N	1	\N
43	2024-02-06	-45.0000	EUR	5030.88	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.183852+00	2026-06-19 10:30:17.183852+00	\N	\N	\N	f	\N	\N	1	\N
44	2024-02-06	-38.0000	EUR	4992.88	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.184847+00	2026-06-19 10:30:17.184847+00	\N	\N	\N	f	\N	\N	1	\N
45	2024-02-18	-13.9900	EUR	4492.25	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.185854+00	2026-06-19 10:30:17.185854+00	\N	\N	\N	f	\N	\N	1	\N
46	2024-02-05	-10.9900	EUR	5119.15	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.18657+00	2026-06-19 10:30:17.18657+00	\N	\N	\N	f	\N	\N	1	\N
47	2024-02-02	-29.9900	EUR	4981.66	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.18726+00	2026-06-19 10:30:17.18726+00	\N	\N	\N	f	\N	\N	1	\N
48	2024-02-03	-49.0000	EUR	3811.84	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.187924+00	2026-06-19 10:30:17.187924+00	\N	\N	\N	f	\N	\N	1	\N
49	2024-02-27	-750.0000	EUR	6861.73	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.188562+00	2026-06-19 10:30:17.188562+00	\N	\N	\N	f	\N	\N	1	\N
50	2024-02-10	-89.3653	EUR	4770.96	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.189189+00	2026-06-19 10:30:17.189189+00	\N	\N	\N	f	\N	\N	1	\N
51	2024-02-02	-99.5338	EUR	4882.13	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.189845+00	2026-06-19 10:30:17.189845+00	\N	\N	\N	f	\N	\N	1	\N
52	2024-02-14	-32.8773	EUR	4563.54	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.19075+00	2026-06-19 10:30:17.19075+00	\N	\N	\N	f	\N	\N	1	\N
53	2024-02-05	-43.2755	EUR	5075.88	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.191863+00	2026-06-19 10:30:17.191863+00	\N	\N	\N	f	\N	\N	1	\N
54	2024-02-04	-66.0827	EUR	3745.75	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.192989+00	2026-06-19 10:30:17.192989+00	\N	\N	\N	f	\N	\N	1	\N
55	2024-02-24	-79.4823	EUR	4345.13	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.193795+00	2026-06-19 10:30:17.193795+00	\N	\N	\N	f	\N	\N	1	\N
56	2024-02-02	-88.8098	EUR	4793.32	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.194476+00	2026-06-19 10:30:17.194476+00	\N	\N	\N	f	\N	\N	1	\N
57	2024-02-18	-60.9502	EUR	4431.29	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.195208+00	2026-06-19 10:30:17.195208+00	\N	\N	\N	f	\N	\N	1	\N
58	2024-02-26	-5.9483	EUR	7743.18	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.195827+00	2026-06-19 10:30:17.195827+00	\N	\N	\N	f	\N	\N	1	\N
59	2024-02-20	-6.6837	EUR	4424.61	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.196524+00	2026-06-19 10:30:17.196524+00	\N	\N	\N	f	\N	\N	1	\N
60	2024-02-06	-4.0740	EUR	4988.80	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.197144+00	2026-06-19 10:30:17.197144+00	\N	\N	\N	f	\N	\N	1	\N
61	2024-02-17	-5.9542	EUR	4506.24	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.197892+00	2026-06-19 10:30:17.197892+00	\N	\N	\N	f	\N	\N	1	\N
62	2024-02-10	-3.7078	EUR	4767.25	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.198828+00	2026-06-19 10:30:17.198828+00	\N	\N	\N	f	\N	\N	1	\N
63	2024-02-07	-7.3505	EUR	4963.78	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.200995+00	2026-06-19 10:30:17.200995+00	\N	\N	\N	f	\N	\N	1	\N
64	2024-02-06	-17.6667	EUR	4971.14	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.202343+00	2026-06-19 10:30:17.202343+00	\N	\N	\N	f	\N	\N	1	\N
65	2024-02-04	-15.6132	EUR	3730.14	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.203163+00	2026-06-19 10:30:17.203163+00	\N	\N	\N	f	\N	\N	1	\N
66	2024-02-29	-25.5958	EUR	5736.14	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.203783+00	2026-06-19 10:30:17.203783+00	\N	\N	\N	f	\N	\N	1	\N
67	2024-02-09	-103.4613	EUR	4860.32	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-19 10:30:17.204355+00	2026-06-19 10:30:17.204355+00	\N	\N	\N	f	\N	\N	1	\N
68	2024-02-26	-131.4486	EUR	7611.73	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-19 10:30:17.204969+00	2026-06-19 10:30:17.204969+00	\N	\N	\N	f	\N	\N	1	\N
69	2024-03-25	3382.0000	EUR	8960.68	Loon maart 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.205529+00	2026-06-19 10:30:17.205529+00	\N	\N	\N	f	\N	\N	1	\N
70	2024-03-05	1391.0000	EUR	6045.59	Loon partner maart 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.206085+00	2026-06-19 10:30:17.206085+00	\N	\N	\N	f	\N	\N	1	\N
71	2024-03-16	851.0739	EUR	5706.41	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-19 10:30:17.206753+00	2026-06-19 10:30:17.206753+00	\N	\N	\N	f	\N	\N	1	\N
72	2024-03-28	-1100.0000	EUR	7110.68	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.207683+00	2026-06-19 10:30:17.207683+00	\N	\N	\N	f	\N	\N	1	\N
73	2024-03-28	1100.0000	EUR	11324.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.209057+00	2026-06-19 10:30:17.209057+00	\N	\N	\N	f	\N	\N	2	\N
74	2024-03-03	-932.4795	EUR	4773.67	Hypotheek aflossing maart	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.210113+00	2026-06-19 10:30:17.210113+00	\N	\N	\N	f	\N	\N	1	\N
75	2024-03-08	-124.1874	EUR	5786.91	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.211019+00	2026-06-19 10:30:17.211019+00	\N	\N	\N	f	\N	\N	1	\N
76	2024-03-12	-54.0000	EUR	5003.58	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.211775+00	2026-06-19 10:30:17.211775+00	\N	\N	\N	f	\N	\N	1	\N
77	2024-03-12	-22.0000	EUR	4981.58	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.21248+00	2026-06-19 10:30:17.21248+00	\N	\N	\N	f	\N	\N	1	\N
78	2024-03-06	-45.0000	EUR	5985.65	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.213156+00	2026-06-19 10:30:17.213156+00	\N	\N	\N	f	\N	\N	1	\N
79	2024-03-06	-38.0000	EUR	5947.65	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.213761+00	2026-06-19 10:30:17.213761+00	\N	\N	\N	f	\N	\N	1	\N
80	2024-03-18	-13.9900	EUR	5692.42	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.214374+00	2026-06-19 10:30:17.214374+00	\N	\N	\N	f	\N	\N	1	\N
81	2024-03-05	-10.9900	EUR	6034.60	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.214974+00	2026-06-19 10:30:17.214974+00	\N	\N	\N	f	\N	\N	1	\N
82	2024-03-02	-29.9900	EUR	5706.15	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.215898+00	2026-06-19 10:30:17.215898+00	\N	\N	\N	f	\N	\N	1	\N
83	2024-03-03	-49.0000	EUR	4724.67	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.21659+00	2026-06-19 10:30:17.21659+00	\N	\N	\N	f	\N	\N	1	\N
84	2024-03-27	-750.0000	EUR	8210.68	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.217259+00	2026-06-19 10:30:17.217259+00	\N	\N	\N	f	\N	\N	1	\N
85	2024-03-11	-90.0415	EUR	5095.58	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.218157+00	2026-06-19 10:30:17.218157+00	\N	\N	\N	f	\N	\N	1	\N
86	2024-03-21	-57.7379	EUR	5634.68	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.218948+00	2026-06-19 10:30:17.218948+00	\N	\N	\N	f	\N	\N	1	\N
87	2024-03-31	-119.8679	EUR	6954.02	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.219584+00	2026-06-19 10:30:17.219584+00	\N	\N	\N	f	\N	\N	1	\N
88	2024-03-07	-36.5538	EUR	5911.10	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.220211+00	2026-06-19 10:30:17.220211+00	\N	\N	\N	f	\N	\N	1	\N
89	2024-03-04	-48.4374	EUR	4676.23	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.220811+00	2026-06-19 10:30:17.220811+00	\N	\N	\N	f	\N	\N	1	\N
90	2024-03-24	-51.2115	EUR	5583.47	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.221408+00	2026-06-19 10:30:17.221408+00	\N	\N	\N	f	\N	\N	1	\N
91	2024-03-12	-42.3732	EUR	4939.21	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.221991+00	2026-06-19 10:30:17.221991+00	\N	\N	\N	f	\N	\N	1	\N
92	2024-03-15	-78.2127	EUR	4855.34	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.222602+00	2026-06-19 10:30:17.222602+00	\N	\N	\N	f	\N	\N	1	\N
93	2024-03-31	-75.2213	EUR	6878.80	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.223272+00	2026-06-19 10:30:17.223272+00	\N	\N	\N	f	\N	\N	1	\N
94	2024-03-24	-4.7938	EUR	5578.68	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.224088+00	2026-06-19 10:30:17.224088+00	\N	\N	\N	f	\N	\N	1	\N
95	2024-03-28	-6.0116	EUR	7104.67	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.224892+00	2026-06-19 10:30:17.224892+00	\N	\N	\N	f	\N	\N	1	\N
96	2024-03-05	-3.9440	EUR	6030.65	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.225816+00	2026-06-19 10:30:17.225816+00	\N	\N	\N	f	\N	\N	1	\N
97	2024-03-13	-5.6605	EUR	4933.55	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.22666+00	2026-06-19 10:30:17.22666+00	\N	\N	\N	f	\N	\N	1	\N
98	2024-03-28	-21.5584	EUR	7083.11	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.227305+00	2026-06-19 10:30:17.227305+00	\N	\N	\N	f	\N	\N	1	\N
99	2024-03-04	-21.6427	EUR	4654.59	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.22789+00	2026-06-19 10:30:17.22789+00	\N	\N	\N	f	\N	\N	1	\N
100	2024-03-10	-601.2883	EUR	5185.62	Electronica	\N	BE76 7340 1234 5678	42	\N	27	t	2026-06-19 10:30:17.228602+00	2026-06-19 10:30:17.228602+00	\N	\N	\N	f	\N	\N	1	\N
101	2024-03-28	-9.2162	EUR	7073.89	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.229262+00	2026-06-19 10:30:17.229262+00	\N	\N	\N	f	\N	\N	1	\N
102	2024-03-11	-37.9987	EUR	5057.58	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-19 10:30:17.229858+00	2026-06-19 10:30:17.229858+00	\N	\N	\N	f	\N	\N	1	\N
103	2024-04-25	3399.0000	EUR	9451.06	Loon april 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.230522+00	2026-06-19 10:30:17.230522+00	\N	\N	\N	f	\N	\N	1	\N
104	2024-04-05	1410.0000	EUR	6851.56	Loon partner april 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.23118+00	2026-06-19 10:30:17.23118+00	\N	\N	\N	f	\N	\N	1	\N
105	2024-04-02	9.5322	EUR	11334.05	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.231829+00	2026-06-19 10:30:17.231829+00	\N	\N	\N	f	\N	\N	2	\N
106	2024-04-28	-1100.0000	EUR	7601.06	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.232888+00	2026-06-19 10:30:17.232888+00	\N	\N	\N	f	\N	\N	1	\N
107	2024-04-28	1100.0000	EUR	12434.05	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.23368+00	2026-06-19 10:30:17.23368+00	\N	\N	\N	f	\N	\N	2	\N
108	2024-04-03	-932.4795	EUR	5916.33	Hypotheek aflossing april	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.234723+00	2026-06-19 10:30:17.234723+00	\N	\N	\N	f	\N	\N	1	\N
109	2024-04-10	-140.3360	EUR	6456.97	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.23556+00	2026-06-19 10:30:17.23556+00	\N	\N	\N	f	\N	\N	1	\N
110	2024-04-12	-54.0000	EUR	6402.97	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.237409+00	2026-06-19 10:30:17.237409+00	\N	\N	\N	f	\N	\N	1	\N
111	2024-04-12	-22.0000	EUR	6380.97	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.238055+00	2026-06-19 10:30:17.238055+00	\N	\N	\N	f	\N	\N	1	\N
112	2024-04-06	-45.0000	EUR	6702.73	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.238695+00	2026-06-19 10:30:17.238695+00	\N	\N	\N	f	\N	\N	1	\N
113	2024-04-06	-38.0000	EUR	6664.73	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.239321+00	2026-06-19 10:30:17.239321+00	\N	\N	\N	f	\N	\N	1	\N
114	2024-04-18	-13.9900	EUR	6181.93	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.240016+00	2026-06-19 10:30:17.240016+00	\N	\N	\N	f	\N	\N	1	\N
115	2024-04-05	-10.9900	EUR	6840.57	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.24082+00	2026-06-19 10:30:17.24082+00	\N	\N	\N	f	\N	\N	1	\N
116	2024-04-02	-29.9900	EUR	6848.81	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.242012+00	2026-06-19 10:30:17.242012+00	\N	\N	\N	f	\N	\N	1	\N
117	2024-04-03	-49.0000	EUR	5867.33	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.24336+00	2026-06-19 10:30:17.24336+00	\N	\N	\N	f	\N	\N	1	\N
118	2024-04-27	-750.0000	EUR	8701.06	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.244265+00	2026-06-19 10:30:17.244265+00	\N	\N	\N	f	\N	\N	1	\N
119	2024-04-12	-92.9070	EUR	6288.06	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.24499+00	2026-06-19 10:30:17.24499+00	\N	\N	\N	f	\N	\N	1	\N
120	2024-04-24	-60.1740	EUR	6052.06	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.245637+00	2026-06-19 10:30:17.245637+00	\N	\N	\N	f	\N	\N	1	\N
121	2024-04-05	-92.8353	EUR	6747.73	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.246299+00	2026-06-19 10:30:17.246299+00	\N	\N	\N	f	\N	\N	1	\N
122	2024-04-28	-82.2814	EUR	7518.78	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.247+00	2026-06-19 10:30:17.247+00	\N	\N	\N	f	\N	\N	1	\N
123	2024-04-19	-62.9387	EUR	6118.99	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.247614+00	2026-06-19 10:30:17.247614+00	\N	\N	\N	f	\N	\N	1	\N
124	2024-04-08	-67.4246	EUR	6597.31	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.248227+00	2026-06-19 10:30:17.248227+00	\N	\N	\N	f	\N	\N	1	\N
125	2024-04-03	-35.7214	EUR	5831.61	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.249009+00	2026-06-19 10:30:17.249009+00	\N	\N	\N	f	\N	\N	1	\N
126	2024-04-15	-77.7665	EUR	6210.30	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.249824+00	2026-06-19 10:30:17.249824+00	\N	\N	\N	f	\N	\N	1	\N
127	2024-04-16	-6.8889	EUR	6195.92	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.250582+00	2026-06-19 10:30:17.250582+00	\N	\N	\N	f	\N	\N	1	\N
128	2024-04-20	-6.7630	EUR	6112.23	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.251497+00	2026-06-19 10:30:17.251497+00	\N	\N	\N	f	\N	\N	1	\N
129	2024-04-15	-7.4852	EUR	6202.81	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.252199+00	2026-06-19 10:30:17.252199+00	\N	\N	\N	f	\N	\N	1	\N
130	2024-04-28	-4.6788	EUR	7514.10	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.252803+00	2026-06-19 10:30:17.252803+00	\N	\N	\N	f	\N	\N	1	\N
131	2024-04-29	-20.1202	EUR	7493.98	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.253426+00	2026-06-19 10:30:17.253426+00	\N	\N	\N	f	\N	\N	1	\N
132	2024-04-03	-390.0551	EUR	5441.56	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-19 10:30:17.253992+00	2026-06-19 10:30:17.253992+00	\N	\N	\N	f	\N	\N	1	\N
133	2024-04-30	-18.4068	EUR	7475.57	Hobby	\N	BE76 7340 1234 5678	48	\N	24	t	2026-06-19 10:30:17.254642+00	2026-06-19 10:30:17.254642+00	\N	\N	\N	f	\N	\N	1	\N
134	2024-05-25	3396.0000	EUR	10316.99	Loon mei 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.255207+00	2026-06-19 10:30:17.255207+00	\N	\N	\N	f	\N	\N	1	\N
135	2024-05-05	1408.0000	EUR	7761.57	Loon partner mei 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.255788+00	2026-06-19 10:30:17.255788+00	\N	\N	\N	f	\N	\N	1	\N
136	2024-05-28	-1100.0000	EUR	8442.15	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.256369+00	2026-06-19 10:30:17.256369+00	\N	\N	\N	f	\N	\N	1	\N
137	2024-05-28	1100.0000	EUR	13534.05	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.257073+00	2026-06-19 10:30:17.257073+00	\N	\N	\N	f	\N	\N	2	\N
138	2024-05-03	-932.4795	EUR	6402.57	Hypotheek aflossing mei	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.257921+00	2026-06-19 10:30:17.257921+00	\N	\N	\N	f	\N	\N	1	\N
139	2024-05-08	-108.3275	EUR	7559.26	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.258875+00	2026-06-19 10:30:17.258875+00	\N	\N	\N	f	\N	\N	1	\N
140	2024-05-15	-44.8126	EUR	7291.59	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.259753+00	2026-06-19 10:30:17.259753+00	\N	\N	\N	f	\N	\N	1	\N
141	2024-05-12	-54.0000	EUR	7408.88	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.260458+00	2026-06-19 10:30:17.260458+00	\N	\N	\N	f	\N	\N	1	\N
142	2024-05-12	-22.0000	EUR	7386.88	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.261148+00	2026-06-19 10:30:17.261148+00	\N	\N	\N	f	\N	\N	1	\N
143	2024-05-06	-45.0000	EUR	7705.58	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.262263+00	2026-06-19 10:30:17.262263+00	\N	\N	\N	f	\N	\N	1	\N
144	2024-05-06	-38.0000	EUR	7667.58	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.262947+00	2026-06-19 10:30:17.262947+00	\N	\N	\N	f	\N	\N	1	\N
145	2024-05-18	-13.9900	EUR	7231.54	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.263678+00	2026-06-19 10:30:17.263678+00	\N	\N	\N	f	\N	\N	1	\N
146	2024-05-05	-10.9900	EUR	7750.58	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.264304+00	2026-06-19 10:30:17.264304+00	\N	\N	\N	f	\N	\N	1	\N
147	2024-05-02	-29.9900	EUR	7346.26	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.26496+00	2026-06-19 10:30:17.26496+00	\N	\N	\N	f	\N	\N	1	\N
148	2024-05-03	-49.0000	EUR	6353.57	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.265874+00	2026-06-19 10:30:17.265874+00	\N	\N	\N	f	\N	\N	1	\N
149	2024-05-15	-41.5240	EUR	7250.07	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-19 10:30:17.266656+00	2026-06-19 10:30:17.266656+00	\N	\N	\N	f	\N	\N	1	\N
150	2024-05-27	-750.0000	EUR	9566.99	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.267331+00	2026-06-19 10:30:17.267331+00	\N	\N	\N	f	\N	\N	1	\N
151	2024-05-01	-99.3161	EUR	7376.25	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.268334+00	2026-06-19 10:30:17.268334+00	\N	\N	\N	f	\N	\N	1	\N
152	2024-05-08	-56.5421	EUR	7502.71	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.269113+00	2026-06-19 10:30:17.269113+00	\N	\N	\N	f	\N	\N	1	\N
153	2024-05-18	-95.6012	EUR	7135.94	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.269747+00	2026-06-19 10:30:17.269747+00	\N	\N	\N	f	\N	\N	1	\N
154	2024-05-31	-33.6144	EUR	7968.03	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.270317+00	2026-06-19 10:30:17.270317+00	\N	\N	\N	f	\N	\N	1	\N
155	2024-05-18	-76.9165	EUR	7059.02	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.270907+00	2026-06-19 10:30:17.270907+00	\N	\N	\N	f	\N	\N	1	\N
156	2024-05-31	-72.6779	EUR	7895.35	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.271508+00	2026-06-19 10:30:17.271508+00	\N	\N	\N	f	\N	\N	1	\N
157	2024-05-19	-33.9358	EUR	7025.09	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.272056+00	2026-06-19 10:30:17.272056+00	\N	\N	\N	f	\N	\N	1	\N
158	2024-05-29	-60.9188	EUR	8368.05	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.272691+00	2026-06-19 10:30:17.272691+00	\N	\N	\N	f	\N	\N	1	\N
159	2024-05-02	-5.0595	EUR	7341.20	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.273405+00	2026-06-19 10:30:17.273405+00	\N	\N	\N	f	\N	\N	1	\N
160	2024-05-24	-3.3058	EUR	6920.99	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.274155+00	2026-06-19 10:30:17.274155+00	\N	\N	\N	f	\N	\N	1	\N
161	2024-05-02	-6.1497	EUR	7335.05	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.2752+00	2026-06-19 10:30:17.2752+00	\N	\N	\N	f	\N	\N	1	\N
162	2024-05-16	-4.5384	EUR	7245.53	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.276538+00	2026-06-19 10:30:17.276538+00	\N	\N	\N	f	\N	\N	1	\N
163	2024-05-10	-39.8361	EUR	7462.88	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.277475+00	2026-06-19 10:30:17.277475+00	\N	\N	\N	f	\N	\N	1	\N
164	2024-05-27	-24.8379	EUR	9542.15	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.278141+00	2026-06-19 10:30:17.278141+00	\N	\N	\N	f	\N	\N	1	\N
165	2024-05-14	-27.5148	EUR	7336.41	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.278776+00	2026-06-19 10:30:17.278776+00	\N	\N	\N	f	\N	\N	1	\N
166	2024-05-29	-366.4105	EUR	8001.64	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-19 10:30:17.279511+00	2026-06-19 10:30:17.279511+00	\N	\N	\N	f	\N	\N	1	\N
167	2024-05-20	-100.7894	EUR	6924.30	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-19 10:30:17.28014+00	2026-06-19 10:30:17.28014+00	\N	\N	\N	f	\N	\N	1	\N
168	2024-05-13	-22.9578	EUR	7363.92	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.280808+00	2026-06-19 10:30:17.280808+00	\N	\N	\N	f	\N	\N	1	\N
169	2024-05-28	-13.1814	EUR	8428.97	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.28146+00	2026-06-19 10:30:17.28146+00	\N	\N	\N	f	\N	\N	1	\N
170	2024-05-31	-49.6889	EUR	7845.66	Hobby	\N	BE76 7340 1234 5678	48	\N	24	t	2026-06-19 10:30:17.282044+00	2026-06-19 10:30:17.282044+00	\N	\N	\N	f	\N	\N	1	\N
171	2024-06-25	3394.0000	EUR	10277.27	Loon juni 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.2828+00	2026-06-19 10:30:17.2828+00	\N	\N	\N	f	\N	\N	1	\N
172	2024-06-05	1399.0000	EUR	8080.92	Loon partner juni 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.283726+00	2026-06-19 10:30:17.283726+00	\N	\N	\N	f	\N	\N	1	\N
173	2024-06-28	-1100.0000	EUR	8422.54	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.284846+00	2026-06-19 10:30:17.284846+00	\N	\N	\N	f	\N	\N	1	\N
174	2024-06-28	1100.0000	EUR	14634.05	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.285568+00	2026-06-19 10:30:17.285568+00	\N	\N	\N	f	\N	\N	2	\N
175	2024-06-03	-932.4795	EUR	6763.38	Hypotheek aflossing juni	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.286206+00	2026-06-19 10:30:17.286206+00	\N	\N	\N	f	\N	\N	1	\N
176	2024-06-09	-124.4610	EUR	7862.47	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.28683+00	2026-06-19 10:30:17.28683+00	\N	\N	\N	f	\N	\N	1	\N
177	2024-06-12	-54.0000	EUR	7709.71	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.287458+00	2026-06-19 10:30:17.287458+00	\N	\N	\N	f	\N	\N	1	\N
178	2024-06-12	-22.0000	EUR	7687.71	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.288049+00	2026-06-19 10:30:17.288049+00	\N	\N	\N	f	\N	\N	1	\N
179	2024-06-06	-45.0000	EUR	8024.93	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.288683+00	2026-06-19 10:30:17.288683+00	\N	\N	\N	f	\N	\N	1	\N
180	2024-06-06	-38.0000	EUR	7986.93	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.289334+00	2026-06-19 10:30:17.289334+00	\N	\N	\N	f	\N	\N	1	\N
181	2024-06-18	-13.9900	EUR	7355.92	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.290026+00	2026-06-19 10:30:17.290026+00	\N	\N	\N	f	\N	\N	1	\N
182	2024-06-05	-10.9900	EUR	8069.93	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.290833+00	2026-06-19 10:30:17.290833+00	\N	\N	\N	f	\N	\N	1	\N
183	2024-06-02	-29.9900	EUR	7695.86	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.291917+00	2026-06-19 10:30:17.291917+00	\N	\N	\N	f	\N	\N	1	\N
184	2024-06-03	-49.0000	EUR	6714.38	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.292856+00	2026-06-19 10:30:17.292856+00	\N	\N	\N	f	\N	\N	1	\N
185	2024-06-03	-32.4644	EUR	6681.92	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-19 10:30:17.293633+00	2026-06-19 10:30:17.293633+00	\N	\N	\N	f	\N	\N	1	\N
186	2024-06-27	-750.0000	EUR	9527.27	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.294376+00	2026-06-19 10:30:17.294376+00	\N	\N	\N	f	\N	\N	1	\N
187	2024-06-22	-68.0252	EUR	7257.52	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.295047+00	2026-06-19 10:30:17.295047+00	\N	\N	\N	f	\N	\N	1	\N
188	2024-06-28	-54.5232	EUR	8368.02	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.2957+00	2026-06-19 10:30:17.2957+00	\N	\N	\N	f	\N	\N	1	\N
189	2024-06-23	-54.7984	EUR	7202.72	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.29649+00	2026-06-19 10:30:17.29649+00	\N	\N	\N	f	\N	\N	1	\N
190	2024-06-01	-119.8099	EUR	7725.85	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.297271+00	2026-06-19 10:30:17.297271+00	\N	\N	\N	f	\N	\N	1	\N
191	2024-06-10	-66.1857	EUR	7796.28	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.298018+00	2026-06-19 10:30:17.298018+00	\N	\N	\N	f	\N	\N	1	\N
192	2024-06-12	-79.4161	EUR	7608.29	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.29869+00	2026-06-19 10:30:17.29869+00	\N	\N	\N	f	\N	\N	1	\N
193	2024-06-10	-32.5735	EUR	7763.71	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.299735+00	2026-06-19 10:30:17.299735+00	\N	\N	\N	f	\N	\N	1	\N
194	2024-06-16	-76.6034	EUR	7518.88	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.300657+00	2026-06-19 10:30:17.300657+00	\N	\N	\N	f	\N	\N	1	\N
195	2024-06-27	-4.7331	EUR	9522.54	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.301726+00	2026-06-19 10:30:17.301726+00	\N	\N	\N	f	\N	\N	1	\N
196	2024-06-19	-5.4086	EUR	7350.51	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.302487+00	2026-06-19 10:30:17.302487+00	\N	\N	\N	f	\N	\N	1	\N
197	2024-06-12	-7.1574	EUR	7601.14	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.303122+00	2026-06-19 10:30:17.303122+00	\N	\N	\N	f	\N	\N	1	\N
198	2024-06-13	-5.6545	EUR	7595.48	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.303784+00	2026-06-19 10:30:17.303784+00	\N	\N	\N	f	\N	\N	1	\N
199	2024-06-29	-5.6491	EUR	8362.37	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.304392+00	2026-06-19 10:30:17.304392+00	\N	\N	\N	f	\N	\N	1	\N
200	2024-06-19	-4.6885	EUR	7345.82	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.304958+00	2026-06-19 10:30:17.304958+00	\N	\N	\N	f	\N	\N	1	\N
201	2024-06-20	-20.2781	EUR	7325.54	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.305551+00	2026-06-19 10:30:17.305551+00	\N	\N	\N	f	\N	\N	1	\N
202	2024-06-17	-127.9313	EUR	7369.91	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-19 10:30:17.306192+00	2026-06-19 10:30:17.306192+00	\N	\N	\N	f	\N	\N	1	\N
203	2024-06-16	-21.0368	EUR	7497.84	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.306933+00	2026-06-19 10:30:17.306933+00	\N	\N	\N	f	\N	\N	1	\N
204	2024-06-24	-319.4455	EUR	6883.27	Reis / vakantie	\N	BE76 7340 1234 5678	47	\N	25	t	2026-06-19 10:30:17.30782+00	2026-06-19 10:30:17.30782+00	\N	\N	\N	f	\N	\N	1	\N
205	2024-07-25	3412.0000	EUR	10745.05	Loon juli 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.309048+00	2026-06-19 10:30:17.309048+00	\N	\N	\N	f	\N	\N	1	\N
206	2024-07-05	1386.0000	EUR	8723.73	Loon partner juli 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.310019+00	2026-06-19 10:30:17.310019+00	\N	\N	\N	f	\N	\N	1	\N
207	2024-07-02	24.9234	EUR	14658.97	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.310716+00	2026-06-19 10:30:17.310716+00	\N	\N	\N	f	\N	\N	2	\N
208	2024-07-28	-1100.0000	EUR	8324.36	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.311482+00	2026-06-19 10:30:17.311482+00	\N	\N	\N	f	\N	\N	1	\N
209	2024-07-28	1100.0000	EUR	15758.97	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.312241+00	2026-06-19 10:30:17.312241+00	\N	\N	\N	f	\N	\N	2	\N
210	2024-07-03	-932.4795	EUR	7386.73	Hypotheek aflossing juli	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.312871+00	2026-06-19 10:30:17.312871+00	\N	\N	\N	f	\N	\N	1	\N
211	2024-07-09	-120.7088	EUR	8344.06	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.31351+00	2026-06-19 10:30:17.31351+00	\N	\N	\N	f	\N	\N	1	\N
212	2024-07-12	-54.0000	EUR	7600.34	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.314216+00	2026-06-19 10:30:17.314216+00	\N	\N	\N	f	\N	\N	1	\N
213	2024-07-12	-22.0000	EUR	7578.34	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.314879+00	2026-06-19 10:30:17.314879+00	\N	\N	\N	f	\N	\N	1	\N
214	2024-07-06	-45.0000	EUR	8556.24	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.315729+00	2026-06-19 10:30:17.315729+00	\N	\N	\N	f	\N	\N	1	\N
215	2024-07-06	-38.0000	EUR	8518.24	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.31659+00	2026-06-19 10:30:17.31659+00	\N	\N	\N	f	\N	\N	1	\N
216	2024-07-18	-13.9900	EUR	7486.40	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.317359+00	2026-06-19 10:30:17.317359+00	\N	\N	\N	f	\N	\N	1	\N
217	2024-07-05	-10.9900	EUR	8712.74	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.31837+00	2026-06-19 10:30:17.31837+00	\N	\N	\N	f	\N	\N	1	\N
218	2024-07-02	-29.9900	EUR	8319.21	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.319172+00	2026-06-19 10:30:17.319172+00	\N	\N	\N	f	\N	\N	1	\N
219	2024-07-03	-49.0000	EUR	7337.73	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.319779+00	2026-06-19 10:30:17.319779+00	\N	\N	\N	f	\N	\N	1	\N
220	2024-07-27	-750.0000	EUR	9428.00	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.320423+00	2026-06-19 10:30:17.320423+00	\N	\N	\N	f	\N	\N	1	\N
221	2024-07-25	-89.1446	EUR	10655.91	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.320991+00	2026-06-19 10:30:17.320991+00	\N	\N	\N	f	\N	\N	1	\N
222	2024-07-28	-40.1238	EUR	8284.23	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.321602+00	2026-06-19 10:30:17.321602+00	\N	\N	\N	f	\N	\N	1	\N
223	2024-07-10	-113.8188	EUR	8230.25	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.3222+00	2026-06-19 10:30:17.3222+00	\N	\N	\N	f	\N	\N	1	\N
224	2024-07-06	-53.4616	EUR	8464.77	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.348874+00	2026-06-19 10:30:17.348874+00	\N	\N	\N	f	\N	\N	1	\N
225	2024-07-05	-58.5518	EUR	8654.19	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.350383+00	2026-06-19 10:30:17.350383+00	\N	\N	\N	f	\N	\N	1	\N
226	2024-07-18	-86.1475	EUR	7400.25	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.35242+00	2026-06-19 10:30:17.35242+00	\N	\N	\N	f	\N	\N	1	\N
227	2024-07-15	-66.6353	EUR	7504.54	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.353369+00	2026-06-19 10:30:17.353369+00	\N	\N	\N	f	\N	\N	1	\N
228	2024-07-29	-59.9196	EUR	8224.31	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.354081+00	2026-06-19 10:30:17.354081+00	\N	\N	\N	f	\N	\N	1	\N
229	2024-07-27	-3.6467	EUR	9424.36	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.354691+00	2026-06-19 10:30:17.354691+00	\N	\N	\N	f	\N	\N	1	\N
230	2024-07-12	-7.1600	EUR	7571.18	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.35527+00	2026-06-19 10:30:17.35527+00	\N	\N	\N	f	\N	\N	1	\N
231	2024-07-20	-4.2394	EUR	7396.01	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.355877+00	2026-06-19 10:30:17.355877+00	\N	\N	\N	f	\N	\N	1	\N
232	2024-07-16	-4.1534	EUR	7500.39	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.356572+00	2026-06-19 10:30:17.356572+00	\N	\N	\N	f	\N	\N	1	\N
233	2024-07-20	-36.9855	EUR	7359.03	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.357543+00	2026-06-19 10:30:17.357543+00	\N	\N	\N	f	\N	\N	1	\N
234	2024-07-23	-25.9773	EUR	7333.05	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.358718+00	2026-06-19 10:30:17.358718+00	\N	\N	\N	f	\N	\N	1	\N
235	2024-07-10	-575.9071	EUR	7654.34	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-19 10:30:17.359847+00	2026-06-19 10:30:17.359847+00	\N	\N	\N	f	\N	\N	1	\N
236	2024-07-25	-477.9019	EUR	10178.00	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-19 10:30:17.360663+00	2026-06-19 10:30:17.360663+00	\N	\N	\N	f	\N	\N	1	\N
237	2024-07-01	-13.1708	EUR	8349.20	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.361446+00	2026-06-19 10:30:17.361446+00	\N	\N	\N	f	\N	\N	1	\N
238	2024-07-05	-52.9522	EUR	8601.24	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-19 10:30:17.362236+00	2026-06-19 10:30:17.362236+00	\N	\N	\N	f	\N	\N	1	\N
239	2024-08-25	3380.0000	EUR	10569.49	Loon augustus 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.362868+00	2026-06-19 10:30:17.362868+00	\N	\N	\N	f	\N	\N	1	\N
240	2024-08-05	1400.0000	EUR	8600.52	Loon partner augustus 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.363547+00	2026-06-19 10:30:17.363547+00	\N	\N	\N	f	\N	\N	1	\N
241	2024-08-28	-1100.0000	EUR	8594.52	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.36417+00	2026-06-19 10:30:17.36417+00	\N	\N	\N	f	\N	\N	1	\N
242	2024-08-28	1100.0000	EUR	16858.97	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.364816+00	2026-06-19 10:30:17.364816+00	\N	\N	\N	f	\N	\N	2	\N
243	2024-08-03	-932.4795	EUR	7261.84	Hypotheek aflossing augustus	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.365451+00	2026-06-19 10:30:17.365451+00	\N	\N	\N	f	\N	\N	1	\N
244	2024-08-10	-116.6258	EUR	7934.29	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.366293+00	2026-06-19 10:30:17.366293+00	\N	\N	\N	f	\N	\N	1	\N
245	2024-08-15	-57.2254	EUR	7382.67	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.367171+00	2026-06-19 10:30:17.367171+00	\N	\N	\N	f	\N	\N	1	\N
246	2024-08-12	-54.0000	EUR	7461.89	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.367857+00	2026-06-19 10:30:17.367857+00	\N	\N	\N	f	\N	\N	1	\N
247	2024-08-12	-22.0000	EUR	7439.89	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.368542+00	2026-06-19 10:30:17.368542+00	\N	\N	\N	f	\N	\N	1	\N
248	2024-08-06	-45.0000	EUR	8538.22	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.369205+00	2026-06-19 10:30:17.369205+00	\N	\N	\N	f	\N	\N	1	\N
249	2024-08-06	-38.0000	EUR	8500.22	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.369847+00	2026-06-19 10:30:17.369847+00	\N	\N	\N	f	\N	\N	1	\N
250	2024-08-18	-13.9900	EUR	7368.68	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.370498+00	2026-06-19 10:30:17.370498+00	\N	\N	\N	f	\N	\N	1	\N
251	2024-08-05	-10.9900	EUR	8589.53	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.371159+00	2026-06-19 10:30:17.371159+00	\N	\N	\N	f	\N	\N	1	\N
252	2024-08-02	-29.9900	EUR	8194.32	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.371818+00	2026-06-19 10:30:17.371818+00	\N	\N	\N	f	\N	\N	1	\N
253	2024-08-03	-49.0000	EUR	7212.84	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.372495+00	2026-06-19 10:30:17.372495+00	\N	\N	\N	f	\N	\N	1	\N
254	2024-08-27	-750.0000	EUR	9757.86	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.373295+00	2026-06-19 10:30:17.373295+00	\N	\N	\N	f	\N	\N	1	\N
255	2024-08-06	-94.2939	EUR	8405.93	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.374025+00	2026-06-19 10:30:17.374025+00	\N	\N	\N	f	\N	\N	1	\N
256	2024-08-07	-117.7241	EUR	8182.82	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.375236+00	2026-06-19 10:30:17.375236+00	\N	\N	\N	f	\N	\N	1	\N
257	2024-08-08	-101.4372	EUR	8081.39	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.376973+00	2026-06-19 10:30:17.376973+00	\N	\N	\N	f	\N	\N	1	\N
258	2024-08-27	-63.3358	EUR	9694.52	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.37788+00	2026-06-19 10:30:17.37788+00	\N	\N	\N	f	\N	\N	1	\N
259	2024-08-06	-69.0402	EUR	8336.89	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.378616+00	2026-06-19 10:30:17.378616+00	\N	\N	\N	f	\N	\N	1	\N
260	2024-08-24	-80.7455	EUR	7194.49	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.379295+00	2026-06-19 10:30:17.379295+00	\N	\N	\N	f	\N	\N	1	\N
261	2024-08-06	-36.3393	EUR	8300.55	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.37993+00	2026-06-19 10:30:17.37993+00	\N	\N	\N	f	\N	\N	1	\N
262	2024-08-23	-86.4696	EUR	7275.24	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.380549+00	2026-06-19 10:30:17.380549+00	\N	\N	\N	f	\N	\N	1	\N
263	2024-08-18	-3.6620	EUR	7365.01	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.381238+00	2026-06-19 10:30:17.381238+00	\N	\N	\N	f	\N	\N	1	\N
264	2024-08-11	-6.8645	EUR	7528.32	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.381905+00	2026-06-19 10:30:17.381905+00	\N	\N	\N	f	\N	\N	1	\N
265	2024-08-05	-6.3081	EUR	8583.22	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.382953+00	2026-06-19 10:30:17.382953+00	\N	\N	\N	f	\N	\N	1	\N
266	2024-08-28	-4.1241	EUR	8590.40	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.384238+00	2026-06-19 10:30:17.384238+00	\N	\N	\N	f	\N	\N	1	\N
267	2024-08-24	-5.0015	EUR	7189.49	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.385055+00	2026-06-19 10:30:17.385055+00	\N	\N	\N	f	\N	\N	1	\N
268	2024-08-18	-3.3086	EUR	7361.71	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.385733+00	2026-06-19 10:30:17.385733+00	\N	\N	\N	f	\N	\N	1	\N
269	2024-08-08	-30.4717	EUR	8050.92	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.386411+00	2026-06-19 10:30:17.386411+00	\N	\N	\N	f	\N	\N	1	\N
270	2024-08-04	-12.3246	EUR	7200.52	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.387332+00	2026-06-19 10:30:17.387332+00	\N	\N	\N	f	\N	\N	1	\N
271	2024-08-26	-61.6303	EUR	10507.86	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-19 10:30:17.38816+00	2026-06-19 10:30:17.38816+00	\N	\N	\N	f	\N	\N	1	\N
272	2024-08-11	-12.4259	EUR	7515.89	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.388824+00	2026-06-19 10:30:17.388824+00	\N	\N	\N	f	\N	\N	1	\N
273	2024-08-10	-399.1079	EUR	7535.18	Reis / vakantie	\N	BE76 7340 1234 5678	46	\N	25	t	2026-06-19 10:30:17.389522+00	2026-06-19 10:30:17.389522+00	\N	\N	\N	f	\N	\N	1	\N
274	2024-09-25	3412.0000	EUR	11769.90	Loon september 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.390311+00	2026-06-19 10:30:17.390311+00	\N	\N	\N	f	\N	\N	1	\N
275	2024-09-05	1402.0000	EUR	8675.57	Loon partner september 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.39133+00	2026-06-19 10:30:17.39133+00	\N	\N	\N	f	\N	\N	1	\N
276	2024-09-16	872.7241	EUR	8717.93	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-19 10:30:17.392688+00	2026-06-19 10:30:17.392688+00	\N	\N	\N	f	\N	\N	1	\N
277	2024-09-28	-1100.0000	EUR	9706.20	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.393662+00	2026-06-19 10:30:17.393662+00	\N	\N	\N	f	\N	\N	1	\N
278	2024-09-28	1100.0000	EUR	17958.97	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.394421+00	2026-06-19 10:30:17.394421+00	\N	\N	\N	f	\N	\N	2	\N
279	2024-09-03	-932.4795	EUR	7391.83	Hypotheek aflossing september	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.39521+00	2026-06-19 10:30:17.39521+00	\N	\N	\N	f	\N	\N	1	\N
280	2024-09-09	-120.9180	EUR	8331.34	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.395925+00	2026-06-19 10:30:17.395925+00	\N	\N	\N	f	\N	\N	1	\N
281	2024-09-12	-54.0000	EUR	8211.56	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.396634+00	2026-06-19 10:30:17.396634+00	\N	\N	\N	f	\N	\N	1	\N
282	2024-09-12	-22.0000	EUR	8189.56	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.397329+00	2026-06-19 10:30:17.397329+00	\N	\N	\N	f	\N	\N	1	\N
283	2024-09-06	-45.0000	EUR	8545.31	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.398031+00	2026-06-19 10:30:17.398031+00	\N	\N	\N	f	\N	\N	1	\N
284	2024-09-06	-38.0000	EUR	8507.31	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.398748+00	2026-06-19 10:30:17.398748+00	\N	\N	\N	f	\N	\N	1	\N
285	2024-09-18	-13.9900	EUR	8652.45	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.399599+00	2026-06-19 10:30:17.399599+00	\N	\N	\N	f	\N	\N	1	\N
286	2024-09-05	-10.9900	EUR	8664.58	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.400406+00	2026-06-19 10:30:17.400406+00	\N	\N	\N	f	\N	\N	1	\N
287	2024-09-02	-29.9900	EUR	8324.31	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.401363+00	2026-06-19 10:30:17.401363+00	\N	\N	\N	f	\N	\N	1	\N
288	2024-09-03	-49.0000	EUR	7342.83	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.40243+00	2026-06-19 10:30:17.40243+00	\N	\N	\N	f	\N	\N	1	\N
289	2024-09-27	-750.0000	EUR	10806.20	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.403069+00	2026-06-19 10:30:17.403069+00	\N	\N	\N	f	\N	\N	1	\N
290	2024-09-05	-68.1103	EUR	8596.47	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.403707+00	2026-06-19 10:30:17.403707+00	\N	\N	\N	f	\N	\N	1	\N
291	2024-09-21	-100.1488	EUR	8546.68	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.404308+00	2026-06-19 10:30:17.404308+00	\N	\N	\N	f	\N	\N	1	\N
292	2024-09-01	-110.0810	EUR	8480.32	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.404892+00	2026-06-19 10:30:17.404892+00	\N	\N	\N	f	\N	\N	1	\N
293	2024-09-01	-126.0145	EUR	8354.30	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.405686+00	2026-06-19 10:30:17.405686+00	\N	\N	\N	f	\N	\N	1	\N
294	2024-09-23	-122.8845	EUR	8357.90	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.406321+00	2026-06-19 10:30:17.406321+00	\N	\N	\N	f	\N	\N	1	\N
295	2024-09-26	-68.1256	EUR	11561.78	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.407147+00	2026-06-19 10:30:17.407147+00	\N	\N	\N	f	\N	\N	1	\N
296	2024-09-03	-69.2606	EUR	7273.57	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.408351+00	2026-06-19 10:30:17.408351+00	\N	\N	\N	f	\N	\N	1	\N
297	2024-09-17	-51.4814	EUR	8666.44	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.409544+00	2026-06-19 10:30:17.409544+00	\N	\N	\N	f	\N	\N	1	\N
298	2024-09-08	-55.0488	EUR	8452.26	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.410437+00	2026-06-19 10:30:17.410437+00	\N	\N	\N	f	\N	\N	1	\N
299	2024-09-25	-80.0932	EUR	11689.80	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.41124+00	2026-06-19 10:30:17.41124+00	\N	\N	\N	f	\N	\N	1	\N
300	2024-09-29	-69.2286	EUR	9636.97	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.411995+00	2026-06-19 10:30:17.411995+00	\N	\N	\N	f	\N	\N	1	\N
301	2024-09-26	-5.5874	EUR	11556.20	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.412627+00	2026-06-19 10:30:17.412627+00	\N	\N	\N	f	\N	\N	1	\N
302	2024-09-21	-3.6526	EUR	8543.03	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.413279+00	2026-06-19 10:30:17.413279+00	\N	\N	\N	f	\N	\N	1	\N
303	2024-09-18	-5.6210	EUR	8646.83	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.413949+00	2026-06-19 10:30:17.413949+00	\N	\N	\N	f	\N	\N	1	\N
304	2024-09-05	-6.1619	EUR	8590.31	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.414784+00	2026-06-19 10:30:17.414784+00	\N	\N	\N	f	\N	\N	1	\N
305	2024-09-10	-32.7190	EUR	8298.62	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.41558+00	2026-06-19 10:30:17.41558+00	\N	\N	\N	f	\N	\N	1	\N
306	2024-09-22	-62.2523	EUR	8480.78	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-19 10:30:17.416744+00	2026-06-19 10:30:17.416744+00	\N	\N	\N	f	\N	\N	1	\N
307	2024-09-13	-344.3622	EUR	7845.20	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-19 10:30:17.417532+00	2026-06-19 10:30:17.417532+00	\N	\N	\N	f	\N	\N	1	\N
308	2024-09-10	-33.0610	EUR	8265.56	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.418486+00	2026-06-19 10:30:17.418486+00	\N	\N	\N	f	\N	\N	1	\N
309	2024-09-25	-59.8934	EUR	11629.91	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.419389+00	2026-06-19 10:30:17.419389+00	\N	\N	\N	f	\N	\N	1	\N
310	2024-10-25	3403.0000	EUR	11570.55	Loon oktober 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.420043+00	2026-06-19 10:30:17.420043+00	\N	\N	\N	f	\N	\N	1	\N
311	2024-10-05	1396.0000	EUR	9861.83	Loon partner oktober 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.420694+00	2026-06-19 10:30:17.420694+00	\N	\N	\N	f	\N	\N	1	\N
312	2024-10-15	362.1312	EUR	9787.59	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-19 10:30:17.421367+00	2026-06-19 10:30:17.421367+00	\N	\N	\N	f	\N	\N	1	\N
313	2024-10-02	29.5424	EUR	17988.51	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.421949+00	2026-06-19 10:30:17.421949+00	\N	\N	\N	f	\N	\N	2	\N
314	2024-10-28	-1100.0000	EUR	9628.49	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.422682+00	2026-06-19 10:30:17.422682+00	\N	\N	\N	f	\N	\N	1	\N
315	2024-10-28	1100.0000	EUR	19088.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.423412+00	2026-06-19 10:30:17.423412+00	\N	\N	\N	f	\N	\N	2	\N
316	2024-10-03	-932.4795	EUR	8514.83	Hypotheek aflossing oktober	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.424278+00	2026-06-19 10:30:17.424278+00	\N	\N	\N	f	\N	\N	1	\N
317	2024-10-08	-102.1255	EUR	9556.04	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.425363+00	2026-06-19 10:30:17.425363+00	\N	\N	\N	f	\N	\N	1	\N
318	2024-10-12	-54.0000	EUR	9502.04	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.426413+00	2026-06-19 10:30:17.426413+00	\N	\N	\N	f	\N	\N	1	\N
319	2024-10-12	-22.0000	EUR	9480.04	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.427165+00	2026-06-19 10:30:17.427165+00	\N	\N	\N	f	\N	\N	1	\N
320	2024-10-06	-45.0000	EUR	9805.84	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.427866+00	2026-06-19 10:30:17.427866+00	\N	\N	\N	f	\N	\N	1	\N
321	2024-10-06	-38.0000	EUR	9767.84	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.428578+00	2026-06-19 10:30:17.428578+00	\N	\N	\N	f	\N	\N	1	\N
322	2024-10-18	-13.9900	EUR	8379.78	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.42928+00	2026-06-19 10:30:17.42928+00	\N	\N	\N	f	\N	\N	1	\N
323	2024-10-05	-10.9900	EUR	9850.84	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.4308+00	2026-06-19 10:30:17.4308+00	\N	\N	\N	f	\N	\N	1	\N
324	2024-10-02	-29.9900	EUR	9447.31	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.432073+00	2026-06-19 10:30:17.432073+00	\N	\N	\N	f	\N	\N	1	\N
325	2024-10-03	-49.0000	EUR	8465.83	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.433448+00	2026-06-19 10:30:17.433448+00	\N	\N	\N	f	\N	\N	1	\N
326	2024-10-27	-750.0000	EUR	10728.49	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.434806+00	2026-06-19 10:30:17.434806+00	\N	\N	\N	f	\N	\N	1	\N
327	2024-10-20	-80.8714	EUR	8298.91	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.436347+00	2026-06-19 10:30:17.436347+00	\N	\N	\N	f	\N	\N	1	\N
328	2024-10-25	-82.2244	EUR	11488.33	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.43734+00	2026-06-19 10:30:17.43734+00	\N	\N	\N	f	\N	\N	1	\N
329	2024-10-07	-84.0315	EUR	9662.67	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.438155+00	2026-06-19 10:30:17.438155+00	\N	\N	\N	f	\N	\N	1	\N
330	2024-10-01	-107.2536	EUR	9529.71	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.439283+00	2026-06-19 10:30:17.439283+00	\N	\N	\N	f	\N	\N	1	\N
331	2024-10-28	-58.5872	EUR	9569.90	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.440162+00	2026-06-19 10:30:17.440162+00	\N	\N	\N	f	\N	\N	1	\N
332	2024-10-28	-66.7803	EUR	9503.12	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.441072+00	2026-06-19 10:30:17.441072+00	\N	\N	\N	f	\N	\N	1	\N
333	2024-10-01	-52.4124	EUR	9477.30	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.442534+00	2026-06-19 10:30:17.442534+00	\N	\N	\N	f	\N	\N	1	\N
334	2024-10-14	-28.6046	EUR	9451.43	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.443624+00	2026-06-19 10:30:17.443624+00	\N	\N	\N	f	\N	\N	1	\N
335	2024-10-31	-34.2087	EUR	9461.57	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.44442+00	2026-06-19 10:30:17.44442+00	\N	\N	\N	f	\N	\N	1	\N
336	2024-10-30	-7.3449	EUR	9495.78	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.445175+00	2026-06-19 10:30:17.445175+00	\N	\N	\N	f	\N	\N	1	\N
337	2024-10-07	-4.5024	EUR	9658.16	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.445911+00	2026-06-19 10:30:17.445911+00	\N	\N	\N	f	\N	\N	1	\N
338	2024-10-21	-3.4609	EUR	8203.88	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.446683+00	2026-06-19 10:30:17.446683+00	\N	\N	\N	f	\N	\N	1	\N
339	2024-10-20	-3.2952	EUR	8295.61	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.447571+00	2026-06-19 10:30:17.447571+00	\N	\N	\N	f	\N	\N	1	\N
340	2024-10-06	-21.1426	EUR	9746.70	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.448467+00	2026-06-19 10:30:17.448467+00	\N	\N	\N	f	\N	\N	1	\N
341	2024-10-21	-36.3291	EUR	8167.55	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.449292+00	2026-06-19 10:30:17.449292+00	\N	\N	\N	f	\N	\N	1	\N
342	2024-10-20	-88.2694	EUR	8207.34	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-19 10:30:17.450015+00	2026-06-19 10:30:17.450015+00	\N	\N	\N	f	\N	\N	1	\N
343	2024-10-14	-25.9735	EUR	9425.46	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.450796+00	2026-06-19 10:30:17.450796+00	\N	\N	\N	f	\N	\N	1	\N
344	2024-10-25	-9.8367	EUR	11478.49	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.451992+00	2026-06-19 10:30:17.451992+00	\N	\N	\N	f	\N	\N	1	\N
345	2024-10-15	-1393.8255	EUR	8393.77	Personenbelasting afrekening	\N	BE76 7340 1234 5678	18	\N	32	t	2026-06-19 10:30:17.452826+00	2026-06-19 10:30:17.452826+00	\N	\N	\N	f	\N	\N	1	\N
346	2024-11-25	3392.0000	EUR	12667.93	Loon november 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.453578+00	2026-06-19 10:30:17.453578+00	\N	\N	\N	f	\N	\N	1	\N
347	2024-11-05	1399.0000	EUR	9753.89	Loon partner november 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.454379+00	2026-06-19 10:30:17.454379+00	\N	\N	\N	f	\N	\N	1	\N
348	2024-11-18	517.4891	EUR	9625.76	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-19 10:30:17.456234+00	2026-06-19 10:30:17.456234+00	\N	\N	\N	f	\N	\N	1	\N
349	2024-11-28	-1100.0000	EUR	10813.90	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.457786+00	2026-06-19 10:30:17.457786+00	\N	\N	\N	f	\N	\N	1	\N
350	2024-11-28	1100.0000	EUR	20188.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.460171+00	2026-06-19 10:30:17.460171+00	\N	\N	\N	f	\N	\N	2	\N
351	2024-11-03	-932.4795	EUR	8467.08	Hypotheek aflossing november	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.461735+00	2026-06-19 10:30:17.461735+00	\N	\N	\N	f	\N	\N	1	\N
352	2024-11-11	-146.6524	EUR	9428.51	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.462718+00	2026-06-19 10:30:17.462718+00	\N	\N	\N	f	\N	\N	1	\N
353	2024-11-15	-67.5915	EUR	9260.19	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.463585+00	2026-06-19 10:30:17.463585+00	\N	\N	\N	f	\N	\N	1	\N
354	2024-11-12	-54.0000	EUR	9374.51	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.464421+00	2026-06-19 10:30:17.464421+00	\N	\N	\N	f	\N	\N	1	\N
355	2024-11-12	-22.0000	EUR	9352.51	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.465253+00	2026-06-19 10:30:17.465253+00	\N	\N	\N	f	\N	\N	1	\N
356	2024-11-06	-45.0000	EUR	9613.16	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.466053+00	2026-06-19 10:30:17.466053+00	\N	\N	\N	f	\N	\N	1	\N
357	2024-11-06	-38.0000	EUR	9575.16	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.467335+00	2026-06-19 10:30:17.467335+00	\N	\N	\N	f	\N	\N	1	\N
358	2024-11-18	-13.9900	EUR	9611.77	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.468383+00	2026-06-19 10:30:17.468383+00	\N	\N	\N	f	\N	\N	1	\N
359	2024-11-05	-10.9900	EUR	9742.90	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.469269+00	2026-06-19 10:30:17.469269+00	\N	\N	\N	f	\N	\N	1	\N
360	2024-11-02	-29.9900	EUR	9399.56	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.46996+00	2026-06-19 10:30:17.46996+00	\N	\N	\N	f	\N	\N	1	\N
361	2024-11-03	-49.0000	EUR	8418.08	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.470617+00	2026-06-19 10:30:17.470617+00	\N	\N	\N	f	\N	\N	1	\N
362	2024-11-27	-750.0000	EUR	11913.90	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.471265+00	2026-06-19 10:30:17.471265+00	\N	\N	\N	f	\N	\N	1	\N
363	2024-11-23	-71.7960	EUR	9357.78	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.472132+00	2026-06-19 10:30:17.472132+00	\N	\N	\N	f	\N	\N	1	\N
364	2024-11-15	-95.7994	EUR	9164.39	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.47285+00	2026-06-19 10:30:17.47285+00	\N	\N	\N	f	\N	\N	1	\N
365	2024-11-24	-63.6644	EUR	9275.93	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.47369+00	2026-06-19 10:30:17.47369+00	\N	\N	\N	f	\N	\N	1	\N
366	2024-11-01	-32.0185	EUR	9429.55	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.474661+00	2026-06-19 10:30:17.474661+00	\N	\N	\N	f	\N	\N	1	\N
367	2024-11-21	-91.4881	EUR	9429.57	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.475787+00	2026-06-19 10:30:17.475787+00	\N	\N	\N	f	\N	\N	1	\N
368	2024-11-05	-52.2914	EUR	9690.61	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.476859+00	2026-06-19 10:30:17.476859+00	\N	\N	\N	f	\N	\N	1	\N
369	2024-11-18	-81.4024	EUR	9530.36	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.477906+00	2026-06-19 10:30:17.477906+00	\N	\N	\N	f	\N	\N	1	\N
370	2024-11-05	-32.4408	EUR	9658.16	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.47875+00	2026-06-19 10:30:17.47875+00	\N	\N	\N	f	\N	\N	1	\N
371	2024-11-03	-63.1937	EUR	8354.89	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.479513+00	2026-06-19 10:30:17.479513+00	\N	\N	\N	f	\N	\N	1	\N
372	2024-11-25	-4.0266	EUR	12663.90	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.480373+00	2026-06-19 10:30:17.480373+00	\N	\N	\N	f	\N	\N	1	\N
373	2024-11-18	-5.9273	EUR	9524.44	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.481155+00	2026-06-19 10:30:17.481155+00	\N	\N	\N	f	\N	\N	1	\N
374	2024-11-18	-3.3763	EUR	9521.06	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.481834+00	2026-06-19 10:30:17.481834+00	\N	\N	\N	f	\N	\N	1	\N
375	2024-11-23	-18.1841	EUR	9339.59	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.482611+00	2026-06-19 10:30:17.482611+00	\N	\N	\N	f	\N	\N	1	\N
376	2024-11-16	-56.1202	EUR	9108.27	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-19 10:30:17.48334+00	2026-06-19 10:30:17.48334+00	\N	\N	\N	f	\N	\N	1	\N
377	2024-11-12	-24.7332	EUR	9327.78	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.484003+00	2026-06-19 10:30:17.484003+00	\N	\N	\N	f	\N	\N	1	\N
378	2024-11-29	-75.4221	EUR	10738.48	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.484788+00	2026-06-19 10:30:17.484788+00	\N	\N	\N	f	\N	\N	1	\N
379	2024-12-25	3414.0000	EUR	14686.66	Loon december 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.48579+00	2026-06-19 10:30:17.48579+00	\N	\N	\N	f	\N	\N	1	\N
380	2024-12-05	1391.0000	EUR	11096.71	Loon partner december 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.486509+00	2026-06-19 10:30:17.486509+00	\N	\N	\N	f	\N	\N	1	\N
381	2024-12-20	1500.0000	EUR	11278.85	Eindejaarsbonus 2024	\N	BE76 7340 1234 5678	1	\N	2	t	2026-06-19 10:30:17.487247+00	2026-06-19 10:30:17.487247+00	\N	\N	\N	f	\N	\N	1	\N
382	2024-12-28	-1100.0000	EUR	12836.66	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.487956+00	2026-06-19 10:30:17.487956+00	\N	\N	\N	f	\N	\N	1	\N
383	2024-12-28	1100.0000	EUR	21288.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.488676+00	2026-06-19 10:30:17.488676+00	\N	\N	\N	f	\N	\N	2	\N
384	2024-12-03	-932.4795	EUR	9776.01	Hypotheek aflossing december	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.489381+00	2026-06-19 10:30:17.489381+00	\N	\N	\N	f	\N	\N	1	\N
385	2024-12-09	-112.8597	EUR	10687.88	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.49015+00	2026-06-19 10:30:17.49015+00	\N	\N	\N	f	\N	\N	1	\N
386	2024-12-12	-54.0000	EUR	10489.85	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.490988+00	2026-06-19 10:30:17.490988+00	\N	\N	\N	f	\N	\N	1	\N
387	2024-12-12	-22.0000	EUR	10467.85	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.491877+00	2026-06-19 10:30:17.491877+00	\N	\N	\N	f	\N	\N	1	\N
388	2024-12-06	-45.0000	EUR	11040.72	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.492827+00	2026-06-19 10:30:17.492827+00	\N	\N	\N	f	\N	\N	1	\N
389	2024-12-06	-38.0000	EUR	11002.72	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.493699+00	2026-06-19 10:30:17.493699+00	\N	\N	\N	f	\N	\N	1	\N
390	2024-12-18	-13.9900	EUR	9835.34	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.494413+00	2026-06-19 10:30:17.494413+00	\N	\N	\N	f	\N	\N	1	\N
391	2024-12-05	-10.9900	EUR	11085.72	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.495093+00	2026-06-19 10:30:17.495093+00	\N	\N	\N	f	\N	\N	1	\N
392	2024-12-02	-29.9900	EUR	10708.49	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.495888+00	2026-06-19 10:30:17.495888+00	\N	\N	\N	f	\N	\N	1	\N
393	2024-12-03	-49.0000	EUR	9727.01	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.496639+00	2026-06-19 10:30:17.496639+00	\N	\N	\N	f	\N	\N	1	\N
394	2024-12-06	-23.2221	EUR	10979.50	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-19 10:30:17.497322+00	2026-06-19 10:30:17.497322+00	\N	\N	\N	f	\N	\N	1	\N
395	2024-12-27	-750.0000	EUR	13936.66	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.498008+00	2026-06-19 10:30:17.498008+00	\N	\N	\N	f	\N	\N	1	\N
396	2024-12-06	-95.7898	EUR	10883.71	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.498742+00	2026-06-19 10:30:17.498742+00	\N	\N	\N	f	\N	\N	1	\N
397	2024-12-18	-56.4908	EUR	9778.85	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.499502+00	2026-06-19 10:30:17.499502+00	\N	\N	\N	f	\N	\N	1	\N
398	2024-12-10	-66.7924	EUR	10617.66	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.500695+00	2026-06-19 10:30:17.500695+00	\N	\N	\N	f	\N	\N	1	\N
399	2024-12-07	-82.9638	EUR	10800.74	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.501694+00	2026-06-19 10:30:17.501694+00	\N	\N	\N	f	\N	\N	1	\N
400	2024-12-10	-73.8082	EUR	10543.85	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.50245+00	2026-06-19 10:30:17.50245+00	\N	\N	\N	f	\N	\N	1	\N
401	2024-12-17	-50.2428	EUR	9864.73	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.503075+00	2026-06-19 10:30:17.503075+00	\N	\N	\N	f	\N	\N	1	\N
402	2024-12-29	-39.6682	EUR	12636.78	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.503755+00	2026-06-19 10:30:17.503755+00	\N	\N	\N	f	\N	\N	1	\N
403	2024-12-29	-4.3402	EUR	12632.44	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.504427+00	2026-06-19 10:30:17.504427+00	\N	\N	\N	f	\N	\N	1	\N
404	2024-12-30	-3.3347	EUR	12624.21	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.505089+00	2026-06-19 10:30:17.505089+00	\N	\N	\N	f	\N	\N	1	\N
405	2024-12-29	-4.8914	EUR	12627.54	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.505715+00	2026-06-19 10:30:17.505715+00	\N	\N	\N	f	\N	\N	1	\N
406	2024-12-09	-3.4339	EUR	10684.45	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.506368+00	2026-06-19 10:30:17.506368+00	\N	\N	\N	f	\N	\N	1	\N
407	2024-12-22	-6.1840	EUR	11272.66	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.50717+00	2026-06-19 10:30:17.50717+00	\N	\N	\N	f	\N	\N	1	\N
408	2024-12-04	-21.3011	EUR	9705.71	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.508005+00	2026-06-19 10:30:17.508005+00	\N	\N	\N	f	\N	\N	1	\N
409	2024-12-16	-552.8775	EUR	9914.97	Electronica	\N	BE76 7340 1234 5678	42	\N	27	t	2026-06-19 10:30:17.50932+00	2026-06-19 10:30:17.50932+00	\N	\N	\N	f	\N	\N	1	\N
410	2024-12-28	-160.2192	EUR	12676.44	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-19 10:30:17.510267+00	2026-06-19 10:30:17.510267+00	\N	\N	\N	f	\N	\N	1	\N
411	2024-12-17	-15.4001	EUR	9849.33	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.511111+00	2026-06-19 10:30:17.511111+00	\N	\N	\N	f	\N	\N	1	\N
412	2025-01-25	3514.0000	EUR	15487.18	Loon januari 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.512073+00	2026-06-19 10:30:17.512073+00	\N	\N	\N	f	\N	\N	1	\N
413	2025-01-05	1438.0000	EUR	12965.60	Loon partner januari 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.513168+00	2026-06-19 10:30:17.513168+00	\N	\N	\N	f	\N	\N	1	\N
414	2025-01-02	17.6734	EUR	21306.19	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.513986+00	2026-06-19 10:30:17.513986+00	\N	\N	\N	f	\N	\N	2	\N
415	2025-01-28	-1100.0000	EUR	13637.18	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.514705+00	2026-06-19 10:30:17.514705+00	\N	\N	\N	f	\N	\N	1	\N
416	2025-01-28	1100.0000	EUR	22406.19	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.51566+00	2026-06-19 10:30:17.51566+00	\N	\N	\N	f	\N	\N	2	\N
417	2025-01-03	-932.4795	EUR	11576.60	Hypotheek aflossing januari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.517512+00	2026-06-19 10:30:17.517512+00	\N	\N	\N	f	\N	\N	1	\N
418	2025-01-11	-136.0822	EUR	12559.04	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.518314+00	2026-06-19 10:30:17.518314+00	\N	\N	\N	f	\N	\N	1	\N
419	2025-01-12	-54.0000	EUR	12380.39	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.518985+00	2026-06-19 10:30:17.518985+00	\N	\N	\N	f	\N	\N	1	\N
420	2025-01-12	-22.0000	EUR	12358.39	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.519706+00	2026-06-19 10:30:17.519706+00	\N	\N	\N	f	\N	\N	1	\N
421	2025-01-06	-45.0000	EUR	12900.62	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.520411+00	2026-06-19 10:30:17.520411+00	\N	\N	\N	f	\N	\N	1	\N
422	2025-01-06	-38.0000	EUR	12862.62	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.521156+00	2026-06-19 10:30:17.521156+00	\N	\N	\N	f	\N	\N	1	\N
423	2025-01-18	-13.9900	EUR	12158.29	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.521781+00	2026-06-19 10:30:17.521781+00	\N	\N	\N	f	\N	\N	1	\N
424	2025-01-05	-10.9900	EUR	12954.61	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.522392+00	2026-06-19 10:30:17.522392+00	\N	\N	\N	f	\N	\N	1	\N
425	2025-01-05	-8.9900	EUR	12945.62	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.523037+00	2026-06-19 10:30:17.523037+00	\N	\N	\N	f	\N	\N	1	\N
426	2025-01-02	-29.9900	EUR	12594.22	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.523796+00	2026-06-19 10:30:17.523796+00	\N	\N	\N	f	\N	\N	1	\N
427	2025-01-03	-49.0000	EUR	11527.60	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.52466+00	2026-06-19 10:30:17.52466+00	\N	\N	\N	f	\N	\N	1	\N
428	2025-01-15	-27.8896	EUR	12284.59	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-19 10:30:17.526556+00	2026-06-19 10:30:17.526556+00	\N	\N	\N	f	\N	\N	1	\N
429	2025-01-27	-750.0000	EUR	14737.18	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.527407+00	2026-06-19 10:30:17.527407+00	\N	\N	\N	f	\N	\N	1	\N
430	2025-01-19	-107.2632	EUR	11973.18	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.52824+00	2026-06-19 10:30:17.52824+00	\N	\N	\N	f	\N	\N	1	\N
431	2025-01-06	-51.8155	EUR	12810.80	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.529206+00	2026-06-19 10:30:17.529206+00	\N	\N	\N	f	\N	\N	1	\N
432	2025-01-18	-77.8484	EUR	12080.44	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.529979+00	2026-06-19 10:30:17.529979+00	\N	\N	\N	f	\N	\N	1	\N
433	2025-01-02	-85.1436	EUR	12509.08	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.530762+00	2026-06-19 10:30:17.530762+00	\N	\N	\N	f	\N	\N	1	\N
434	2025-01-30	-70.3455	EUR	13566.83	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.531531+00	2026-06-19 10:30:17.531531+00	\N	\N	\N	f	\N	\N	1	\N
435	2025-01-11	-65.3987	EUR	12493.64	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.532377+00	2026-06-19 10:30:17.532377+00	\N	\N	\N	f	\N	\N	1	\N
436	2025-01-17	-76.7193	EUR	12172.28	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.533027+00	2026-06-19 10:30:17.533027+00	\N	\N	\N	f	\N	\N	1	\N
437	2025-01-11	-59.2519	EUR	12434.39	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.534226+00	2026-06-19 10:30:17.534226+00	\N	\N	\N	f	\N	\N	1	\N
438	2025-01-15	-35.5957	EUR	12249.00	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.535311+00	2026-06-19 10:30:17.535311+00	\N	\N	\N	f	\N	\N	1	\N
439	2025-01-14	-7.2051	EUR	12351.19	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.536156+00	2026-06-19 10:30:17.536156+00	\N	\N	\N	f	\N	\N	1	\N
440	2025-01-08	-3.9248	EUR	12742.51	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.536952+00	2026-06-19 10:30:17.536952+00	\N	\N	\N	f	\N	\N	1	\N
441	2025-01-08	-6.7654	EUR	12735.75	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.537643+00	2026-06-19 10:30:17.537643+00	\N	\N	\N	f	\N	\N	1	\N
442	2025-01-06	-4.1944	EUR	12806.61	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.538277+00	2026-06-19 10:30:17.538277+00	\N	\N	\N	f	\N	\N	1	\N
443	2025-01-30	-20.8916	EUR	13545.94	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.53895+00	2026-06-19 10:30:17.53895+00	\N	\N	\N	f	\N	\N	1	\N
444	2025-01-14	-38.7025	EUR	12312.48	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.539765+00	2026-06-19 10:30:17.539765+00	\N	\N	\N	f	\N	\N	1	\N
445	2025-01-08	-40.6226	EUR	12695.12	Consultatie huisarts	\N	BE76 7340 1234 5678	38	\N	20	t	2026-06-19 10:30:17.540565+00	2026-06-19 10:30:17.540565+00	\N	\N	\N	f	\N	\N	1	\N
446	2025-01-07	-60.1711	EUR	12746.44	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.541823+00	2026-06-19 10:30:17.541823+00	\N	\N	\N	f	\N	\N	1	\N
447	2025-02-25	3508.0000	EUR	16325.53	Loon februari 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.543149+00	2026-06-19 10:30:17.543149+00	\N	\N	\N	f	\N	\N	1	\N
448	2025-02-05	1434.0000	EUR	13927.68	Loon partner februari 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.544054+00	2026-06-19 10:30:17.544054+00	\N	\N	\N	f	\N	\N	1	\N
449	2025-02-28	-1100.0000	EUR	14383.84	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.544835+00	2026-06-19 10:30:17.544835+00	\N	\N	\N	f	\N	\N	1	\N
450	2025-02-28	1100.0000	EUR	23506.19	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.545681+00	2026-06-19 10:30:17.545681+00	\N	\N	\N	f	\N	\N	2	\N
451	2025-02-03	-932.4795	EUR	12579.11	Hypotheek aflossing februari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.546565+00	2026-06-19 10:30:17.546565+00	\N	\N	\N	f	\N	\N	1	\N
452	2025-02-10	-112.0335	EUR	13431.39	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.547349+00	2026-06-19 10:30:17.547349+00	\N	\N	\N	f	\N	\N	1	\N
453	2025-02-15	-60.6746	EUR	13113.50	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.548143+00	2026-06-19 10:30:17.548143+00	\N	\N	\N	f	\N	\N	1	\N
454	2025-02-12	-54.0000	EUR	13373.73	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.549077+00	2026-06-19 10:30:17.549077+00	\N	\N	\N	f	\N	\N	1	\N
455	2025-02-12	-22.0000	EUR	13351.73	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.550195+00	2026-06-19 10:30:17.550195+00	\N	\N	\N	f	\N	\N	1	\N
456	2025-02-06	-45.0000	EUR	13862.70	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.550956+00	2026-06-19 10:30:17.550956+00	\N	\N	\N	f	\N	\N	1	\N
457	2025-02-06	-38.0000	EUR	13824.70	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.551735+00	2026-06-19 10:30:17.551735+00	\N	\N	\N	f	\N	\N	1	\N
458	2025-02-18	-13.9900	EUR	12952.53	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.552449+00	2026-06-19 10:30:17.552449+00	\N	\N	\N	f	\N	\N	1	\N
459	2025-02-05	-10.9900	EUR	13916.69	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.553144+00	2026-06-19 10:30:17.553144+00	\N	\N	\N	f	\N	\N	1	\N
460	2025-02-05	-8.9900	EUR	13907.70	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.553971+00	2026-06-19 10:30:17.553971+00	\N	\N	\N	f	\N	\N	1	\N
461	2025-02-02	-29.9900	EUR	13511.59	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.554602+00	2026-06-19 10:30:17.554602+00	\N	\N	\N	f	\N	\N	1	\N
462	2025-02-03	-49.0000	EUR	12530.11	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.555278+00	2026-06-19 10:30:17.555278+00	\N	\N	\N	f	\N	\N	1	\N
463	2025-02-27	-750.0000	EUR	15533.64	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.555966+00	2026-06-19 10:30:17.555966+00	\N	\N	\N	f	\N	\N	1	\N
464	2025-02-16	-115.3774	EUR	12998.12	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.556706+00	2026-06-19 10:30:17.556706+00	\N	\N	\N	f	\N	\N	1	\N
465	2025-02-21	-124.7812	EUR	12827.75	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.557585+00	2026-06-19 10:30:17.557585+00	\N	\N	\N	f	\N	\N	1	\N
466	2025-02-08	-47.0057	EUR	13659.24	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.558526+00	2026-06-19 10:30:17.558526+00	\N	\N	\N	f	\N	\N	1	\N
467	2025-02-14	-101.3634	EUR	13179.27	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.559624+00	2026-06-19 10:30:17.559624+00	\N	\N	\N	f	\N	\N	1	\N
468	2025-02-09	-95.3304	EUR	13547.89	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.560616+00	2026-06-19 10:30:17.560616+00	\N	\N	\N	f	\N	\N	1	\N
469	2025-02-13	-71.1015	EUR	13280.63	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.561862+00	2026-06-19 10:30:17.561862+00	\N	\N	\N	f	\N	\N	1	\N
470	2025-02-27	-49.8015	EUR	15483.84	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.562846+00	2026-06-19 10:30:17.562846+00	\N	\N	\N	f	\N	\N	1	\N
471	2025-02-07	-75.9092	EUR	13706.24	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.563602+00	2026-06-19 10:30:17.563602+00	\N	\N	\N	f	\N	\N	1	\N
472	2025-02-26	-41.8862	EUR	16283.64	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.564349+00	2026-06-19 10:30:17.564349+00	\N	\N	\N	f	\N	\N	1	\N
473	2025-02-01	-4.3628	EUR	13541.58	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.565207+00	2026-06-19 10:30:17.565207+00	\N	\N	\N	f	\N	\N	1	\N
474	2025-02-09	-4.4691	EUR	13543.42	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.566004+00	2026-06-19 10:30:17.566004+00	\N	\N	\N	f	\N	\N	1	\N
475	2025-02-21	-4.0969	EUR	12823.65	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.566688+00	2026-06-19 10:30:17.566688+00	\N	\N	\N	f	\N	\N	1	\N
476	2025-02-24	-6.1232	EUR	12817.53	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.567494+00	2026-06-19 10:30:17.567494+00	\N	\N	\N	f	\N	\N	1	\N
477	2025-02-14	-5.0935	EUR	13174.18	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.568546+00	2026-06-19 10:30:17.568546+00	\N	\N	\N	f	\N	\N	1	\N
478	2025-02-16	-31.6038	EUR	12966.52	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.569433+00	2026-06-19 10:30:17.569433+00	\N	\N	\N	f	\N	\N	1	\N
479	2025-02-08	-16.0178	EUR	13643.22	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.570185+00	2026-06-19 10:30:17.570185+00	\N	\N	\N	f	\N	\N	1	\N
480	2025-02-04	-36.4220	EUR	12493.68	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-19 10:30:17.570853+00	2026-06-19 10:30:17.570853+00	\N	\N	\N	f	\N	\N	1	\N
481	2025-02-06	-42.5532	EUR	13782.15	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.571557+00	2026-06-19 10:30:17.571557+00	\N	\N	\N	f	\N	\N	1	\N
482	2025-02-11	-3.6512	EUR	13427.73	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.572242+00	2026-06-19 10:30:17.572242+00	\N	\N	\N	f	\N	\N	1	\N
483	2025-03-25	3490.0000	EUR	16609.61	Loon maart 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.572896+00	2026-06-19 10:30:17.572896+00	\N	\N	\N	f	\N	\N	1	\N
484	2025-03-05	1440.0000	EUR	14578.73	Loon partner maart 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.573716+00	2026-06-19 10:30:17.573716+00	\N	\N	\N	f	\N	\N	1	\N
485	2025-03-28	-1100.0000	EUR	14676.08	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.574707+00	2026-06-19 10:30:17.574707+00	\N	\N	\N	f	\N	\N	1	\N
486	2025-03-28	1100.0000	EUR	24606.19	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.576038+00	2026-06-19 10:30:17.576038+00	\N	\N	\N	f	\N	\N	2	\N
487	2025-03-03	-932.4795	EUR	13421.37	Hypotheek aflossing maart	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.577029+00	2026-06-19 10:30:17.577029+00	\N	\N	\N	f	\N	\N	1	\N
488	2025-03-08	-95.2326	EUR	14064.32	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.578031+00	2026-06-19 10:30:17.578031+00	\N	\N	\N	f	\N	\N	1	\N
489	2025-03-12	-54.0000	EUR	13502.68	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.578804+00	2026-06-19 10:30:17.578804+00	\N	\N	\N	f	\N	\N	1	\N
490	2025-03-12	-22.0000	EUR	13480.68	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.579521+00	2026-06-19 10:30:17.579521+00	\N	\N	\N	f	\N	\N	1	\N
491	2025-03-06	-45.0000	EUR	14389.02	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.580238+00	2026-06-19 10:30:17.580238+00	\N	\N	\N	f	\N	\N	1	\N
492	2025-03-06	-38.0000	EUR	14351.02	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.580968+00	2026-06-19 10:30:17.580968+00	\N	\N	\N	f	\N	\N	1	\N
493	2025-03-18	-13.9900	EUR	13217.79	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.581811+00	2026-06-19 10:30:17.581811+00	\N	\N	\N	f	\N	\N	1	\N
494	2025-03-05	-10.9900	EUR	14567.74	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.583414+00	2026-06-19 10:30:17.583414+00	\N	\N	\N	f	\N	\N	1	\N
495	2025-03-05	-8.9900	EUR	14558.75	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.584321+00	2026-06-19 10:30:17.584321+00	\N	\N	\N	f	\N	\N	1	\N
496	2025-03-02	-29.9900	EUR	14353.85	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.584962+00	2026-06-19 10:30:17.584962+00	\N	\N	\N	f	\N	\N	1	\N
497	2025-03-03	-49.0000	EUR	13372.37	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.586284+00	2026-06-19 10:30:17.586284+00	\N	\N	\N	f	\N	\N	1	\N
498	2025-03-27	-750.0000	EUR	15776.08	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.587034+00	2026-06-19 10:30:17.587034+00	\N	\N	\N	f	\N	\N	1	\N
499	2025-03-07	-93.1857	EUR	14257.84	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.587717+00	2026-06-19 10:30:17.587717+00	\N	\N	\N	f	\N	\N	1	\N
500	2025-03-05	-124.7274	EUR	14434.02	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.588385+00	2026-06-19 10:30:17.588385+00	\N	\N	\N	f	\N	\N	1	\N
501	2025-03-03	-119.9115	EUR	13252.46	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.589039+00	2026-06-19 10:30:17.589039+00	\N	\N	\N	f	\N	\N	1	\N
502	2025-03-07	-57.1094	EUR	14200.73	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.589798+00	2026-06-19 10:30:17.589798+00	\N	\N	\N	f	\N	\N	1	\N
503	2025-03-03	-109.9045	EUR	13142.56	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.590742+00	2026-06-19 10:30:17.590742+00	\N	\N	\N	f	\N	\N	1	\N
504	2025-03-26	-83.5345	EUR	16526.08	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.591971+00	2026-06-19 10:30:17.591971+00	\N	\N	\N	f	\N	\N	1	\N
505	2025-03-14	-61.9767	EUR	13412.58	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.593241+00	2026-06-19 10:30:17.593241+00	\N	\N	\N	f	\N	\N	1	\N
506	2025-03-23	-43.3865	EUR	13119.61	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.59435+00	2026-06-19 10:30:17.59435+00	\N	\N	\N	f	\N	\N	1	\N
507	2025-03-18	-54.7936	EUR	13163.00	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.595177+00	2026-06-19 10:30:17.595177+00	\N	\N	\N	f	\N	\N	1	\N
508	2025-03-10	-3.9944	EUR	14060.32	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.595991+00	2026-06-19 10:30:17.595991+00	\N	\N	\N	f	\N	\N	1	\N
509	2025-03-12	-6.1201	EUR	13474.56	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.59677+00	2026-06-19 10:30:17.59677+00	\N	\N	\N	f	\N	\N	1	\N
510	2025-03-07	-5.2688	EUR	14195.46	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.597501+00	2026-06-19 10:30:17.597501+00	\N	\N	\N	f	\N	\N	1	\N
511	2025-03-03	-3.8240	EUR	13138.73	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.598377+00	2026-06-19 10:30:17.598377+00	\N	\N	\N	f	\N	\N	1	\N
512	2025-03-11	-39.9685	EUR	14020.35	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.599343+00	2026-06-19 10:30:17.599343+00	\N	\N	\N	f	\N	\N	1	\N
513	2025-03-17	-26.9515	EUR	13231.78	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.600685+00	2026-06-19 10:30:17.600685+00	\N	\N	\N	f	\N	\N	1	\N
514	2025-03-14	-153.8489	EUR	13258.73	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-19 10:30:17.601416+00	2026-06-19 10:30:17.601416+00	\N	\N	\N	f	\N	\N	1	\N
515	2025-03-11	-463.6756	EUR	13556.68	Electronica	\N	BE76 7340 1234 5678	42	\N	27	t	2026-06-19 10:30:17.602438+00	2026-06-19 10:30:17.602438+00	\N	\N	\N	f	\N	\N	1	\N
516	2025-03-07	-35.9112	EUR	14159.55	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.603152+00	2026-06-19 10:30:17.603152+00	\N	\N	\N	f	\N	\N	1	\N
517	2025-03-31	-6.8321	EUR	14669.24	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.603831+00	2026-06-19 10:30:17.603831+00	\N	\N	\N	f	\N	\N	1	\N
518	2025-04-25	3498.0000	EUR	17763.61	Loon april 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.60451+00	2026-06-19 10:30:17.60451+00	\N	\N	\N	f	\N	\N	1	\N
519	2025-04-05	1432.0000	EUR	14957.53	Loon partner april 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.605199+00	2026-06-19 10:30:17.605199+00	\N	\N	\N	f	\N	\N	1	\N
520	2025-04-02	16.3031	EUR	24622.49	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.605829+00	2026-06-19 10:30:17.605829+00	\N	\N	\N	f	\N	\N	2	\N
521	2025-04-28	-1100.0000	EUR	15853.81	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.606541+00	2026-06-19 10:30:17.606541+00	\N	\N	\N	f	\N	\N	1	\N
522	2025-04-28	1100.0000	EUR	25722.49	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.607389+00	2026-06-19 10:30:17.607389+00	\N	\N	\N	f	\N	\N	2	\N
523	2025-04-03	-932.4795	EUR	13702.50	Hypotheek aflossing april	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.608565+00	2026-06-19 10:30:17.608565+00	\N	\N	\N	f	\N	\N	1	\N
524	2025-04-10	-112.8322	EUR	14676.45	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.60973+00	2026-06-19 10:30:17.60973+00	\N	\N	\N	f	\N	\N	1	\N
525	2025-04-12	-54.0000	EUR	14622.45	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.610778+00	2026-06-19 10:30:17.610778+00	\N	\N	\N	f	\N	\N	1	\N
526	2025-04-12	-22.0000	EUR	14600.45	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.611576+00	2026-06-19 10:30:17.611576+00	\N	\N	\N	f	\N	\N	1	\N
527	2025-04-06	-45.0000	EUR	14864.25	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.612393+00	2026-06-19 10:30:17.612393+00	\N	\N	\N	f	\N	\N	1	\N
528	2025-04-06	-38.0000	EUR	14826.25	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.613108+00	2026-06-19 10:30:17.613108+00	\N	\N	\N	f	\N	\N	1	\N
529	2025-04-18	-13.9900	EUR	14385.68	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.613801+00	2026-06-19 10:30:17.613801+00	\N	\N	\N	f	\N	\N	1	\N
530	2025-04-05	-10.9900	EUR	14946.54	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.614534+00	2026-06-19 10:30:17.614534+00	\N	\N	\N	f	\N	\N	1	\N
531	2025-04-05	-8.9900	EUR	14937.55	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.615349+00	2026-06-19 10:30:17.615349+00	\N	\N	\N	f	\N	\N	1	\N
532	2025-04-02	-29.9900	EUR	14639.25	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.616125+00	2026-06-19 10:30:17.616125+00	\N	\N	\N	f	\N	\N	1	\N
533	2025-04-03	-49.0000	EUR	13653.50	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.61677+00	2026-06-19 10:30:17.61677+00	\N	\N	\N	f	\N	\N	1	\N
534	2025-04-27	-750.0000	EUR	16953.81	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.617485+00	2026-06-19 10:30:17.617485+00	\N	\N	\N	f	\N	\N	1	\N
535	2025-04-04	-54.6200	EUR	13592.60	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.618692+00	2026-06-19 10:30:17.618692+00	\N	\N	\N	f	\N	\N	1	\N
536	2025-04-14	-58.0732	EUR	14542.38	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.619494+00	2026-06-19 10:30:17.619494+00	\N	\N	\N	f	\N	\N	1	\N
537	2025-04-07	-36.9660	EUR	14789.28	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.620252+00	2026-06-19 10:30:17.620252+00	\N	\N	\N	f	\N	\N	1	\N
538	2025-04-16	-71.2411	EUR	14406.95	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.620975+00	2026-06-19 10:30:17.620975+00	\N	\N	\N	f	\N	\N	1	\N
539	2025-04-14	-64.1917	EUR	14478.19	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.621679+00	2026-06-19 10:30:17.621679+00	\N	\N	\N	f	\N	\N	1	\N
540	2025-04-04	-67.0668	EUR	13525.53	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.622394+00	2026-06-19 10:30:17.622394+00	\N	\N	\N	f	\N	\N	1	\N
541	2025-04-22	-94.3016	EUR	14265.61	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.623035+00	2026-06-19 10:30:17.623035+00	\N	\N	\N	f	\N	\N	1	\N
542	2025-04-05	-28.2978	EUR	14909.25	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.623852+00	2026-06-19 10:30:17.623852+00	\N	\N	\N	f	\N	\N	1	\N
543	2025-04-26	-53.6950	EUR	17709.92	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.625246+00	2026-06-19 10:30:17.625246+00	\N	\N	\N	f	\N	\N	1	\N
544	2025-04-19	-7.4936	EUR	14378.19	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.626427+00	2026-06-19 10:30:17.626427+00	\N	\N	\N	f	\N	\N	1	\N
545	2025-04-03	-6.2845	EUR	13647.22	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.627273+00	2026-06-19 10:30:17.627273+00	\N	\N	\N	f	\N	\N	1	\N
546	2025-04-16	-7.2717	EUR	14399.67	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.628072+00	2026-06-19 10:30:17.628072+00	\N	\N	\N	f	\N	\N	1	\N
547	2025-04-28	-4.6306	EUR	15849.18	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.628801+00	2026-06-19 10:30:17.628801+00	\N	\N	\N	f	\N	\N	1	\N
548	2025-04-02	-4.2753	EUR	14634.98	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.629547+00	2026-06-19 10:30:17.629547+00	\N	\N	\N	f	\N	\N	1	\N
549	2025-04-26	-6.1096	EUR	17703.81	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.630275+00	2026-06-19 10:30:17.630275+00	\N	\N	\N	f	\N	\N	1	\N
550	2025-04-19	-18.2750	EUR	14359.92	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.631041+00	2026-06-19 10:30:17.631041+00	\N	\N	\N	f	\N	\N	1	\N
551	2025-04-28	-20.3268	EUR	15828.85	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.632038+00	2026-06-19 10:30:17.632038+00	\N	\N	\N	f	\N	\N	1	\N
552	2025-05-25	3513.0000	EUR	18435.59	Loon mei 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.63283+00	2026-06-19 10:30:17.63283+00	\N	\N	\N	f	\N	\N	1	\N
553	2025-05-05	1457.0000	EUR	16218.45	Loon partner mei 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.633601+00	2026-06-19 10:30:17.633601+00	\N	\N	\N	f	\N	\N	1	\N
554	2025-05-28	-1100.0000	EUR	16505.33	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.634464+00	2026-06-19 10:30:17.634464+00	\N	\N	\N	f	\N	\N	1	\N
555	2025-05-28	1100.0000	EUR	26822.49	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.635153+00	2026-06-19 10:30:17.635153+00	\N	\N	\N	f	\N	\N	2	\N
556	2025-05-03	-932.4795	EUR	14823.06	Hypotheek aflossing mei	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.63577+00	2026-06-19 10:30:17.63577+00	\N	\N	\N	f	\N	\N	1	\N
557	2025-05-09	-132.9070	EUR	15876.04	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.636447+00	2026-06-19 10:30:17.636447+00	\N	\N	\N	f	\N	\N	1	\N
558	2025-05-15	-63.0172	EUR	15433.36	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.637108+00	2026-06-19 10:30:17.637108+00	\N	\N	\N	f	\N	\N	1	\N
559	2025-05-12	-54.0000	EUR	15523.53	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.637724+00	2026-06-19 10:30:17.637724+00	\N	\N	\N	f	\N	\N	1	\N
560	2025-05-12	-22.0000	EUR	15501.53	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.638334+00	2026-06-19 10:30:17.638334+00	\N	\N	\N	f	\N	\N	1	\N
561	2025-05-06	-45.0000	EUR	16046.95	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.639015+00	2026-06-19 10:30:17.639015+00	\N	\N	\N	f	\N	\N	1	\N
562	2025-05-06	-38.0000	EUR	16008.95	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.63971+00	2026-06-19 10:30:17.63971+00	\N	\N	\N	f	\N	\N	1	\N
563	2025-05-18	-13.9900	EUR	15213.48	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.640563+00	2026-06-19 10:30:17.640563+00	\N	\N	\N	f	\N	\N	1	\N
564	2025-05-05	-10.9900	EUR	16207.46	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.641467+00	2026-06-19 10:30:17.641467+00	\N	\N	\N	f	\N	\N	1	\N
565	2025-05-05	-8.9900	EUR	16198.47	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.642498+00	2026-06-19 10:30:17.642498+00	\N	\N	\N	f	\N	\N	1	\N
566	2025-05-02	-29.9900	EUR	15798.86	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.643482+00	2026-06-19 10:30:17.643482+00	\N	\N	\N	f	\N	\N	1	\N
567	2025-05-03	-49.0000	EUR	14774.06	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.644317+00	2026-06-19 10:30:17.644317+00	\N	\N	\N	f	\N	\N	1	\N
568	2025-05-27	-27.2928	EUR	18355.33	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-19 10:30:17.645068+00	2026-06-19 10:30:17.645068+00	\N	\N	\N	f	\N	\N	1	\N
569	2025-05-27	-750.0000	EUR	17605.33	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.645815+00	2026-06-19 10:30:17.645815+00	\N	\N	\N	f	\N	\N	1	\N
570	2025-05-15	-96.2305	EUR	15337.13	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.646572+00	2026-06-19 10:30:17.646572+00	\N	\N	\N	f	\N	\N	1	\N
571	2025-05-18	-121.3832	EUR	15092.09	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.647274+00	2026-06-19 10:30:17.647274+00	\N	\N	\N	f	\N	\N	1	\N
572	2025-05-17	-75.1604	EUR	15227.47	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.648016+00	2026-06-19 10:30:17.648016+00	\N	\N	\N	f	\N	\N	1	\N
573	2025-05-05	-106.5251	EUR	16091.95	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.651786+00	2026-06-19 10:30:17.651786+00	\N	\N	\N	f	\N	\N	1	\N
574	2025-05-18	-93.2113	EUR	14998.88	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.652597+00	2026-06-19 10:30:17.652597+00	\N	\N	\N	f	\N	\N	1	\N
575	2025-05-09	-76.5791	EUR	15799.46	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.653276+00	2026-06-19 10:30:17.653276+00	\N	\N	\N	f	\N	\N	1	\N
576	2025-05-02	-43.3246	EUR	15755.54	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.653934+00	2026-06-19 10:30:17.653934+00	\N	\N	\N	f	\N	\N	1	\N
577	2025-05-25	-52.9673	EUR	18382.62	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.654606+00	2026-06-19 10:30:17.654606+00	\N	\N	\N	f	\N	\N	1	\N
578	2025-05-19	-6.6015	EUR	14992.28	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.655354+00	2026-06-19 10:30:17.655354+00	\N	\N	\N	f	\N	\N	1	\N
579	2025-05-24	-3.5717	EUR	14922.59	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.656025+00	2026-06-19 10:30:17.656025+00	\N	\N	\N	f	\N	\N	1	\N
580	2025-05-15	-6.0880	EUR	15331.05	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.656786+00	2026-06-19 10:30:17.656786+00	\N	\N	\N	f	\N	\N	1	\N
581	2025-05-14	-5.1439	EUR	15496.38	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.657695+00	2026-06-19 10:30:17.657695+00	\N	\N	\N	f	\N	\N	1	\N
582	2025-05-22	-35.3279	EUR	14926.16	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.658601+00	2026-06-19 10:30:17.658601+00	\N	\N	\N	f	\N	\N	1	\N
583	2025-05-19	-30.7901	EUR	14961.49	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.659643+00	2026-06-19 10:30:17.659643+00	\N	\N	\N	f	\N	\N	1	\N
584	2025-05-15	-28.4209	EUR	15302.63	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.660502+00	2026-06-19 10:30:17.660502+00	\N	\N	\N	f	\N	\N	1	\N
585	2025-05-09	-87.5830	EUR	15711.88	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-19 10:30:17.661306+00	2026-06-19 10:30:17.661306+00	\N	\N	\N	f	\N	\N	1	\N
586	2025-05-09	-134.3546	EUR	15577.53	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-19 10:30:17.661987+00	2026-06-19 10:30:17.661987+00	\N	\N	\N	f	\N	\N	1	\N
587	2025-05-04	-12.6039	EUR	14761.45	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.662761+00	2026-06-19 10:30:17.662761+00	\N	\N	\N	f	\N	\N	1	\N
588	2025-06-25	3494.0000	EUR	19001.27	Loon juni 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.663487+00	2026-06-19 10:30:17.663487+00	\N	\N	\N	f	\N	\N	1	\N
589	2025-06-05	1441.0000	EUR	16775.19	Loon partner juni 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.664256+00	2026-06-19 10:30:17.664256+00	\N	\N	\N	f	\N	\N	1	\N
590	2025-06-28	-1100.0000	EUR	17151.27	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.665134+00	2026-06-19 10:30:17.665134+00	\N	\N	\N	f	\N	\N	1	\N
591	2025-06-28	1100.0000	EUR	27922.49	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.666016+00	2026-06-19 10:30:17.666016+00	\N	\N	\N	f	\N	\N	2	\N
592	2025-06-03	-932.4795	EUR	15542.86	Hypotheek aflossing juni	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.666685+00	2026-06-19 10:30:17.666685+00	\N	\N	\N	f	\N	\N	1	\N
593	2025-06-08	-134.0192	EUR	16538.20	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.667557+00	2026-06-19 10:30:17.667557+00	\N	\N	\N	f	\N	\N	1	\N
594	2025-06-12	-54.0000	EUR	16454.49	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.668263+00	2026-06-19 10:30:17.668263+00	\N	\N	\N	f	\N	\N	1	\N
595	2025-06-12	-22.0000	EUR	16432.49	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.668954+00	2026-06-19 10:30:17.668954+00	\N	\N	\N	f	\N	\N	1	\N
596	2025-06-06	-45.0000	EUR	16710.21	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.669642+00	2026-06-19 10:30:17.669642+00	\N	\N	\N	f	\N	\N	1	\N
597	2025-06-06	-38.0000	EUR	16672.21	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.670312+00	2026-06-19 10:30:17.670312+00	\N	\N	\N	f	\N	\N	1	\N
598	2025-06-18	-13.9900	EUR	16245.97	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.670997+00	2026-06-19 10:30:17.670997+00	\N	\N	\N	f	\N	\N	1	\N
599	2025-06-05	-10.9900	EUR	16764.20	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.671671+00	2026-06-19 10:30:17.671671+00	\N	\N	\N	f	\N	\N	1	\N
600	2025-06-05	-8.9900	EUR	16755.21	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.672293+00	2026-06-19 10:30:17.672293+00	\N	\N	\N	f	\N	\N	1	\N
601	2025-06-02	-29.9900	EUR	16475.34	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.672948+00	2026-06-19 10:30:17.672948+00	\N	\N	\N	f	\N	\N	1	\N
602	2025-06-03	-49.0000	EUR	15493.86	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.673676+00	2026-06-19 10:30:17.673676+00	\N	\N	\N	f	\N	\N	1	\N
603	2025-06-27	-750.0000	EUR	18251.27	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.674563+00	2026-06-19 10:30:17.674563+00	\N	\N	\N	f	\N	\N	1	\N
604	2025-06-03	-100.9903	EUR	15392.87	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.675528+00	2026-06-19 10:30:17.675528+00	\N	\N	\N	f	\N	\N	1	\N
605	2025-06-16	-60.3723	EUR	16263.56	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.676399+00	2026-06-19 10:30:17.676399+00	\N	\N	\N	f	\N	\N	1	\N
606	2025-06-04	-58.6749	EUR	15334.19	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.677143+00	2026-06-19 10:30:17.677143+00	\N	\N	\N	f	\N	\N	1	\N
607	2025-06-18	-68.5823	EUR	16177.39	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.677878+00	2026-06-19 10:30:17.677878+00	\N	\N	\N	f	\N	\N	1	\N
608	2025-06-29	-48.5821	EUR	16636.15	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.678716+00	2026-06-19 10:30:17.678716+00	\N	\N	\N	f	\N	\N	1	\N
609	2025-06-23	-81.4279	EUR	15511.23	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.679428+00	2026-06-19 10:30:17.679428+00	\N	\N	\N	f	\N	\N	1	\N
610	2025-06-08	-29.7027	EUR	16508.49	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.680136+00	2026-06-19 10:30:17.680136+00	\N	\N	\N	f	\N	\N	1	\N
611	2025-06-12	-60.6071	EUR	16371.89	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.680908+00	2026-06-19 10:30:17.680908+00	\N	\N	\N	f	\N	\N	1	\N
612	2025-06-21	-4.7223	EUR	15618.87	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.681821+00	2026-06-19 10:30:17.681821+00	\N	\N	\N	f	\N	\N	1	\N
613	2025-06-13	-7.4147	EUR	16323.94	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.682483+00	2026-06-19 10:30:17.682483+00	\N	\N	\N	f	\N	\N	1	\N
614	2025-06-23	-3.9622	EUR	15507.27	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.683094+00	2026-06-19 10:30:17.683094+00	\N	\N	\N	f	\N	\N	1	\N
615	2025-06-16	-3.6007	EUR	16259.96	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.68433+00	2026-06-19 10:30:17.68433+00	\N	\N	\N	f	\N	\N	1	\N
616	2025-06-30	-31.5068	EUR	16604.65	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.685215+00	2026-06-19 10:30:17.685215+00	\N	\N	\N	f	\N	\N	1	\N
617	2025-06-12	-40.5347	EUR	16331.35	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.68595+00	2026-06-19 10:30:17.68595+00	\N	\N	\N	f	\N	\N	1	\N
618	2025-06-18	-553.8011	EUR	15623.59	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-19 10:30:17.686659+00	2026-06-19 10:30:17.686659+00	\N	\N	\N	f	\N	\N	1	\N
619	2025-06-22	-26.2096	EUR	15592.66	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.687449+00	2026-06-19 10:30:17.687449+00	\N	\N	\N	f	\N	\N	1	\N
620	2025-06-28	-466.5334	EUR	16684.73	Reis / vakantie	\N	BE76 7340 1234 5678	47	\N	25	t	2026-06-19 10:30:17.688086+00	2026-06-19 10:30:17.688086+00	\N	\N	\N	f	\N	\N	1	\N
621	2025-06-30	517.5312	EUR	17122.18	Belastingteruggave	\N	BE76 7340 1234 5678	18	\N	3	t	2026-06-19 10:30:17.688708+00	2026-06-19 10:30:17.688708+00	\N	\N	\N	f	\N	\N	1	\N
622	2025-07-25	3502.0000	EUR	19922.76	Loon juli 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.689345+00	2026-06-19 10:30:17.689345+00	\N	\N	\N	f	\N	\N	1	\N
623	2025-07-05	1451.0000	EUR	17260.42	Loon partner juli 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.690043+00	2026-06-19 10:30:17.690043+00	\N	\N	\N	f	\N	\N	1	\N
624	2025-07-02	14.6287	EUR	27937.12	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.690962+00	2026-06-19 10:30:17.690962+00	\N	\N	\N	f	\N	\N	2	\N
625	2025-07-28	-1100.0000	EUR	17976.22	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.691967+00	2026-06-19 10:30:17.691967+00	\N	\N	\N	f	\N	\N	1	\N
626	2025-07-28	1100.0000	EUR	29037.12	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.692983+00	2026-06-19 10:30:17.692983+00	\N	\N	\N	f	\N	\N	2	\N
627	2025-07-03	-932.4795	EUR	15894.86	Hypotheek aflossing juli	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.69389+00	2026-06-19 10:30:17.69389+00	\N	\N	\N	f	\N	\N	1	\N
628	2025-07-09	-121.3960	EUR	16847.26	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.694667+00	2026-06-19 10:30:17.694667+00	\N	\N	\N	f	\N	\N	1	\N
629	2025-07-12	-54.0000	EUR	16793.26	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.695454+00	2026-06-19 10:30:17.695454+00	\N	\N	\N	f	\N	\N	1	\N
630	2025-07-12	-22.0000	EUR	16771.26	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.696303+00	2026-06-19 10:30:17.696303+00	\N	\N	\N	f	\N	\N	1	\N
631	2025-07-06	-45.0000	EUR	17006.65	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.697055+00	2026-06-19 10:30:17.697055+00	\N	\N	\N	f	\N	\N	1	\N
632	2025-07-06	-38.0000	EUR	16968.65	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.697877+00	2026-06-19 10:30:17.697877+00	\N	\N	\N	f	\N	\N	1	\N
633	2025-07-18	-13.9900	EUR	16532.71	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.698748+00	2026-06-19 10:30:17.698748+00	\N	\N	\N	f	\N	\N	1	\N
634	2025-07-05	-10.9900	EUR	17249.43	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.699746+00	2026-06-19 10:30:17.699746+00	\N	\N	\N	f	\N	\N	1	\N
635	2025-07-05	-8.9900	EUR	17240.44	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.700648+00	2026-06-19 10:30:17.700648+00	\N	\N	\N	f	\N	\N	1	\N
636	2025-07-02	-29.9900	EUR	17092.19	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.701355+00	2026-06-19 10:30:17.701355+00	\N	\N	\N	f	\N	\N	1	\N
637	2025-07-03	-49.0000	EUR	15845.86	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.701992+00	2026-06-19 10:30:17.701992+00	\N	\N	\N	f	\N	\N	1	\N
638	2025-07-27	-750.0000	EUR	19076.22	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.702632+00	2026-06-19 10:30:17.702632+00	\N	\N	\N	f	\N	\N	1	\N
639	2025-07-19	-49.4205	EUR	16425.50	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.703275+00	2026-06-19 10:30:17.703275+00	\N	\N	\N	f	\N	\N	1	\N
640	2025-07-05	-120.0334	EUR	17120.41	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.703912+00	2026-06-19 10:30:17.703912+00	\N	\N	\N	f	\N	\N	1	\N
641	2025-07-14	-90.0806	EUR	16681.18	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.704612+00	2026-06-19 10:30:17.704612+00	\N	\N	\N	f	\N	\N	1	\N
642	2025-07-26	-87.3143	EUR	19835.44	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.705258+00	2026-06-19 10:30:17.705258+00	\N	\N	\N	f	\N	\N	1	\N
643	2025-07-15	-58.2281	EUR	16622.95	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.705936+00	2026-06-19 10:30:17.705936+00	\N	\N	\N	f	\N	\N	1	\N
644	2025-07-18	-54.1654	EUR	16478.55	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.706617+00	2026-06-19 10:30:17.706617+00	\N	\N	\N	f	\N	\N	1	\N
645	2025-07-29	-62.8526	EUR	17913.37	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.70745+00	2026-06-19 10:30:17.70745+00	\N	\N	\N	f	\N	\N	1	\N
646	2025-07-17	-70.4718	EUR	16546.70	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.708409+00	2026-06-19 10:30:17.708409+00	\N	\N	\N	f	\N	\N	1	\N
647	2025-07-05	-68.7583	EUR	17051.65	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.709382+00	2026-06-19 10:30:17.709382+00	\N	\N	\N	f	\N	\N	1	\N
648	2025-07-18	-3.6238	EUR	16474.93	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.710229+00	2026-06-19 10:30:17.710229+00	\N	\N	\N	f	\N	\N	1	\N
649	2025-07-16	-5.7719	EUR	16617.18	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.710942+00	2026-06-19 10:30:17.710942+00	\N	\N	\N	f	\N	\N	1	\N
650	2025-07-23	-4.7460	EUR	16420.76	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.711683+00	2026-06-19 10:30:17.711683+00	\N	\N	\N	f	\N	\N	1	\N
651	2025-07-03	-36.4382	EUR	15809.42	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.712373+00	2026-06-19 10:30:17.712373+00	\N	\N	\N	f	\N	\N	1	\N
652	2025-07-26	-9.2246	EUR	19826.22	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.713133+00	2026-06-19 10:30:17.713133+00	\N	\N	\N	f	\N	\N	1	\N
653	2025-07-02	-264.8443	EUR	16827.34	Reis / vakantie	\N	BE76 7340 1234 5678	47	\N	25	t	2026-06-19 10:30:17.714018+00	2026-06-19 10:30:17.714018+00	\N	\N	\N	f	\N	\N	1	\N
654	2025-08-25	3513.0000	EUR	21251.62	Loon augustus 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.714856+00	2026-06-19 10:30:17.714856+00	\N	\N	\N	f	\N	\N	1	\N
655	2025-08-05	1436.0000	EUR	18228.42	Loon partner augustus 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.715778+00	2026-06-19 10:30:17.715778+00	\N	\N	\N	f	\N	\N	1	\N
656	2025-08-15	463.6951	EUR	17962.26	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-19 10:30:17.716516+00	2026-06-19 10:30:17.716516+00	\N	\N	\N	f	\N	\N	1	\N
657	2025-08-28	-1100.0000	EUR	19392.96	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.718374+00	2026-06-19 10:30:17.718374+00	\N	\N	\N	f	\N	\N	1	\N
658	2025-08-28	1100.0000	EUR	30137.12	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.71907+00	2026-06-19 10:30:17.71907+00	\N	\N	\N	f	\N	\N	2	\N
659	2025-08-03	-932.4795	EUR	16950.90	Hypotheek aflossing augustus	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.719833+00	2026-06-19 10:30:17.719833+00	\N	\N	\N	f	\N	\N	1	\N
660	2025-08-08	-138.5930	EUR	17978.54	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.720503+00	2026-06-19 10:30:17.720503+00	\N	\N	\N	f	\N	\N	1	\N
661	2025-08-15	-58.6284	EUR	17903.63	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.721285+00	2026-06-19 10:30:17.721285+00	\N	\N	\N	f	\N	\N	1	\N
662	2025-08-12	-54.0000	EUR	17681.66	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.721954+00	2026-06-19 10:30:17.721954+00	\N	\N	\N	f	\N	\N	1	\N
663	2025-08-12	-22.0000	EUR	17659.66	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.722637+00	2026-06-19 10:30:17.722637+00	\N	\N	\N	f	\N	\N	1	\N
664	2025-08-06	-45.0000	EUR	18163.44	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.723395+00	2026-06-19 10:30:17.723395+00	\N	\N	\N	f	\N	\N	1	\N
665	2025-08-06	-38.0000	EUR	18125.44	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.724322+00	2026-06-19 10:30:17.724322+00	\N	\N	\N	f	\N	\N	1	\N
666	2025-08-18	-13.9900	EUR	17741.96	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.725368+00	2026-06-19 10:30:17.725368+00	\N	\N	\N	f	\N	\N	1	\N
667	2025-08-05	-10.9900	EUR	18217.43	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.726431+00	2026-06-19 10:30:17.726431+00	\N	\N	\N	f	\N	\N	1	\N
668	2025-08-05	-8.9900	EUR	18208.44	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.727297+00	2026-06-19 10:30:17.727297+00	\N	\N	\N	f	\N	\N	1	\N
669	2025-08-02	-29.9900	EUR	17883.38	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.72802+00	2026-06-19 10:30:17.72802+00	\N	\N	\N	f	\N	\N	1	\N
670	2025-08-03	-49.0000	EUR	16901.90	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.728724+00	2026-06-19 10:30:17.728724+00	\N	\N	\N	f	\N	\N	1	\N
671	2025-08-27	-750.0000	EUR	20501.62	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.729473+00	2026-06-19 10:30:17.729473+00	\N	\N	\N	f	\N	\N	1	\N
672	2025-08-30	-58.5612	EUR	19286.07	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.730194+00	2026-06-19 10:30:17.730194+00	\N	\N	\N	f	\N	\N	1	\N
673	2025-08-13	-117.7317	EUR	17541.93	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.730914+00	2026-06-19 10:30:17.730914+00	\N	\N	\N	f	\N	\N	1	\N
674	2025-08-03	-109.4744	EUR	16792.42	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.731795+00	2026-06-19 10:30:17.731795+00	\N	\N	\N	f	\N	\N	1	\N
675	2025-08-13	-43.3630	EUR	17498.56	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.732572+00	2026-06-19 10:30:17.732572+00	\N	\N	\N	f	\N	\N	1	\N
676	2025-08-10	-108.6248	EUR	17735.66	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.733423+00	2026-06-19 10:30:17.733423+00	\N	\N	\N	f	\N	\N	1	\N
677	2025-08-09	-61.7653	EUR	17873.48	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.734109+00	2026-06-19 10:30:17.734109+00	\N	\N	\N	f	\N	\N	1	\N
678	2025-08-16	-56.0098	EUR	17755.95	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.734751+00	2026-06-19 10:30:17.734751+00	\N	\N	\N	f	\N	\N	1	\N
679	2025-08-28	-48.3264	EUR	19344.63	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.735403+00	2026-06-19 10:30:17.735403+00	\N	\N	\N	f	\N	\N	1	\N
680	2025-08-15	-91.6754	EUR	17811.95	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.736028+00	2026-06-19 10:30:17.736028+00	\N	\N	\N	f	\N	\N	1	\N
681	2025-08-22	-3.3375	EUR	17738.62	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.736669+00	2026-06-19 10:30:17.736669+00	\N	\N	\N	f	\N	\N	1	\N
682	2025-08-07	-3.4986	EUR	18121.94	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.73731+00	2026-06-19 10:30:17.73731+00	\N	\N	\N	f	\N	\N	1	\N
683	2025-08-07	-4.8127	EUR	18117.13	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.737923+00	2026-06-19 10:30:17.737923+00	\N	\N	\N	f	\N	\N	1	\N
684	2025-08-31	-5.1840	EUR	19275.44	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.738568+00	2026-06-19 10:30:17.738568+00	\N	\N	\N	f	\N	\N	1	\N
685	2025-08-30	-5.4499	EUR	19280.62	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.739201+00	2026-06-19 10:30:17.739201+00	\N	\N	\N	f	\N	\N	1	\N
686	2025-08-09	-29.2014	EUR	17844.28	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.739888+00	2026-06-19 10:30:17.739888+00	\N	\N	\N	f	\N	\N	1	\N
687	2025-08-08	-43.2889	EUR	17935.25	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.740683+00	2026-06-19 10:30:17.740683+00	\N	\N	\N	f	\N	\N	1	\N
688	2025-08-27	-8.6581	EUR	20492.96	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.741598+00	2026-06-19 10:30:17.741598+00	\N	\N	\N	f	\N	\N	1	\N
689	2025-08-31	-14.0310	EUR	19261.41	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.742662+00	2026-06-19 10:30:17.742662+00	\N	\N	\N	f	\N	\N	1	\N
690	2025-09-25	3499.0000	EUR	22324.35	Loon september 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.74348+00	2026-06-19 10:30:17.74348+00	\N	\N	\N	f	\N	\N	1	\N
691	2025-09-05	1431.0000	EUR	19430.55	Loon partner september 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.744298+00	2026-06-19 10:30:17.744298+00	\N	\N	\N	f	\N	\N	1	\N
692	2025-09-28	-1100.0000	EUR	20399.89	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.745073+00	2026-06-19 10:30:17.745073+00	\N	\N	\N	f	\N	\N	1	\N
693	2025-09-28	1100.0000	EUR	31237.12	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.745867+00	2026-06-19 10:30:17.745867+00	\N	\N	\N	f	\N	\N	2	\N
694	2025-09-03	-932.4795	EUR	18116.22	Hypotheek aflossing september	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.746622+00	2026-06-19 10:30:17.746622+00	\N	\N	\N	f	\N	\N	1	\N
695	2025-09-11	-90.6374	EUR	19162.79	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.747384+00	2026-06-19 10:30:17.747384+00	\N	\N	\N	f	\N	\N	1	\N
696	2025-09-12	-54.0000	EUR	19108.79	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.748226+00	2026-06-19 10:30:17.748226+00	\N	\N	\N	f	\N	\N	1	\N
697	2025-09-12	-22.0000	EUR	19086.79	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.749092+00	2026-06-19 10:30:17.749092+00	\N	\N	\N	f	\N	\N	1	\N
698	2025-09-06	-45.0000	EUR	19296.58	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.749756+00	2026-06-19 10:30:17.749756+00	\N	\N	\N	f	\N	\N	1	\N
699	2025-09-06	-38.0000	EUR	19258.58	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.750738+00	2026-06-19 10:30:17.750738+00	\N	\N	\N	f	\N	\N	1	\N
700	2025-09-18	-13.9900	EUR	19059.61	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.751401+00	2026-06-19 10:30:17.751401+00	\N	\N	\N	f	\N	\N	1	\N
701	2025-09-05	-10.9900	EUR	19419.56	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.752082+00	2026-06-19 10:30:17.752082+00	\N	\N	\N	f	\N	\N	1	\N
702	2025-09-05	-8.9900	EUR	19410.57	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.752735+00	2026-06-19 10:30:17.752735+00	\N	\N	\N	f	\N	\N	1	\N
703	2025-09-02	-29.9900	EUR	19186.18	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.753368+00	2026-06-19 10:30:17.753368+00	\N	\N	\N	f	\N	\N	1	\N
704	2025-09-03	-49.0000	EUR	18067.22	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.753988+00	2026-06-19 10:30:17.753988+00	\N	\N	\N	f	\N	\N	1	\N
705	2025-09-27	-750.0000	EUR	21574.35	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.754641+00	2026-06-19 10:30:17.754641+00	\N	\N	\N	f	\N	\N	1	\N
706	2025-09-03	-67.6740	EUR	17999.55	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.755245+00	2026-06-19 10:30:17.755245+00	\N	\N	\N	f	\N	\N	1	\N
707	2025-09-02	-36.3506	EUR	19149.83	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.755889+00	2026-06-19 10:30:17.755889+00	\N	\N	\N	f	\N	\N	1	\N
708	2025-09-05	-68.9845	EUR	19341.58	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.756604+00	2026-06-19 10:30:17.756604+00	\N	\N	\N	f	\N	\N	1	\N
709	2025-09-21	-88.7001	EUR	18938.63	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.757424+00	2026-06-19 10:30:17.757424+00	\N	\N	\N	f	\N	\N	1	\N
710	2025-09-02	-101.1289	EUR	19048.70	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.758276+00	2026-06-19 10:30:17.758276+00	\N	\N	\N	f	\N	\N	1	\N
711	2025-09-27	-74.4557	EUR	21499.89	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.75941+00	2026-06-19 10:30:17.75941+00	\N	\N	\N	f	\N	\N	1	\N
712	2025-09-21	-78.5726	EUR	18860.06	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.760306+00	2026-06-19 10:30:17.760306+00	\N	\N	\N	f	\N	\N	1	\N
713	2025-09-01	-45.2377	EUR	19216.17	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.76103+00	2026-06-19 10:30:17.76103+00	\N	\N	\N	f	\N	\N	1	\N
714	2025-09-08	-5.1574	EUR	19253.42	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.761754+00	2026-06-19 10:30:17.761754+00	\N	\N	\N	f	\N	\N	1	\N
715	2025-09-14	-3.2765	EUR	19080.14	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.762467+00	2026-06-19 10:30:17.762467+00	\N	\N	\N	f	\N	\N	1	\N
716	2025-09-21	-7.3054	EUR	18852.75	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.763132+00	2026-06-19 10:30:17.763132+00	\N	\N	\N	f	\N	\N	1	\N
717	2025-09-13	-3.3680	EUR	19083.42	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.763849+00	2026-06-19 10:30:17.763849+00	\N	\N	\N	f	\N	\N	1	\N
718	2025-09-16	-6.5380	EUR	19073.60	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.764709+00	2026-06-19 10:30:17.764709+00	\N	\N	\N	f	\N	\N	1	\N
719	2025-09-19	-32.2847	EUR	19027.33	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.765766+00	2026-06-19 10:30:17.765766+00	\N	\N	\N	f	\N	\N	1	\N
720	2025-09-23	-27.4066	EUR	18825.35	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.766518+00	2026-06-19 10:30:17.766518+00	\N	\N	\N	f	\N	\N	1	\N
721	2025-10-25	3508.0000	EUR	23055.28	Loon oktober 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.768108+00	2026-06-19 10:30:17.768108+00	\N	\N	\N	f	\N	\N	1	\N
722	2025-10-05	1455.0000	EUR	20761.99	Loon partner oktober 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.768802+00	2026-06-19 10:30:17.768802+00	\N	\N	\N	f	\N	\N	1	\N
723	2025-10-20	751.9837	EUR	19811.51	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-19 10:30:17.769425+00	2026-06-19 10:30:17.769425+00	\N	\N	\N	f	\N	\N	1	\N
724	2025-10-02	13.2866	EUR	31250.40	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.770074+00	2026-06-19 10:30:17.770074+00	\N	\N	\N	f	\N	\N	2	\N
725	2025-10-28	-1100.0000	EUR	21159.64	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.770751+00	2026-06-19 10:30:17.770751+00	\N	\N	\N	f	\N	\N	1	\N
726	2025-10-28	1100.0000	EUR	32350.40	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.771369+00	2026-06-19 10:30:17.771369+00	\N	\N	\N	f	\N	\N	2	\N
727	2025-10-03	-932.4795	EUR	19433.01	Hypotheek aflossing oktober	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.772001+00	2026-06-19 10:30:17.772001+00	\N	\N	\N	f	\N	\N	1	\N
728	2025-10-11	-93.7301	EUR	20351.12	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.772668+00	2026-06-19 10:30:17.772668+00	\N	\N	\N	f	\N	\N	1	\N
729	2025-10-12	-54.0000	EUR	20297.12	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.773384+00	2026-06-19 10:30:17.773384+00	\N	\N	\N	f	\N	\N	1	\N
730	2025-10-12	-22.0000	EUR	20275.12	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.77424+00	2026-06-19 10:30:17.77424+00	\N	\N	\N	f	\N	\N	1	\N
731	2025-10-06	-45.0000	EUR	20617.57	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.77524+00	2026-06-19 10:30:17.77524+00	\N	\N	\N	f	\N	\N	1	\N
732	2025-10-06	-38.0000	EUR	20579.57	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.776296+00	2026-06-19 10:30:17.776296+00	\N	\N	\N	f	\N	\N	1	\N
733	2025-10-18	-13.9900	EUR	19059.52	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.777109+00	2026-06-19 10:30:17.777109+00	\N	\N	\N	f	\N	\N	1	\N
734	2025-10-05	-10.9900	EUR	20751.00	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.777916+00	2026-06-19 10:30:17.777916+00	\N	\N	\N	f	\N	\N	1	\N
735	2025-10-05	-8.9900	EUR	20742.01	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.778662+00	2026-06-19 10:30:17.778662+00	\N	\N	\N	f	\N	\N	1	\N
736	2025-10-02	-29.9900	EUR	20369.90	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.779373+00	2026-06-19 10:30:17.779373+00	\N	\N	\N	f	\N	\N	1	\N
737	2025-10-03	-49.0000	EUR	19384.01	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.780088+00	2026-06-19 10:30:17.780088+00	\N	\N	\N	f	\N	\N	1	\N
738	2025-10-27	-750.0000	EUR	22305.28	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.780797+00	2026-06-19 10:30:17.780797+00	\N	\N	\N	f	\N	\N	1	\N
739	2025-10-22	-34.0731	EUR	19672.94	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.781863+00	2026-06-19 10:30:17.781863+00	\N	\N	\N	f	\N	\N	1	\N
740	2025-10-08	-45.4796	EUR	20534.09	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.782908+00	2026-06-19 10:30:17.782908+00	\N	\N	\N	f	\N	\N	1	\N
741	2025-10-17	-51.9130	EUR	19073.51	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.793292+00	2026-06-19 10:30:17.793292+00	\N	\N	\N	f	\N	\N	1	\N
742	2025-10-20	-47.6650	EUR	19763.84	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.794673+00	2026-06-19 10:30:17.794673+00	\N	\N	\N	f	\N	\N	1	\N
743	2025-10-23	-61.2451	EUR	19611.69	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.795755+00	2026-06-19 10:30:17.795755+00	\N	\N	\N	f	\N	\N	1	\N
744	2025-10-08	-64.0111	EUR	20470.08	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.796681+00	2026-06-19 10:30:17.796681+00	\N	\N	\N	f	\N	\N	1	\N
745	2025-10-21	-56.8324	EUR	19707.01	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.797552+00	2026-06-19 10:30:17.797552+00	\N	\N	\N	f	\N	\N	1	\N
746	2025-10-24	-29.2901	EUR	19547.28	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.798426+00	2026-06-19 10:30:17.798426+00	\N	\N	\N	f	\N	\N	1	\N
747	2025-10-23	-35.1162	EUR	19576.57	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.799271+00	2026-06-19 10:30:17.799271+00	\N	\N	\N	f	\N	\N	1	\N
748	2025-10-05	-66.6138	EUR	20675.40	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.800096+00	2026-06-19 10:30:17.800096+00	\N	\N	\N	f	\N	\N	1	\N
749	2025-10-05	-7.4007	EUR	20668.00	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.802432+00	2026-06-19 10:30:17.802432+00	\N	\N	\N	f	\N	\N	1	\N
750	2025-10-05	-5.4294	EUR	20662.57	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.803154+00	2026-06-19 10:30:17.803154+00	\N	\N	\N	f	\N	\N	1	\N
751	2025-10-02	-4.4126	EUR	20365.49	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.803865+00	2026-06-19 10:30:17.803865+00	\N	\N	\N	f	\N	\N	1	\N
752	2025-10-14	-5.3325	EUR	20269.79	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.804605+00	2026-06-19 10:30:17.804605+00	\N	\N	\N	f	\N	\N	1	\N
753	2025-10-27	-37.9488	EUR	22267.34	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.805242+00	2026-06-19 10:30:17.805242+00	\N	\N	\N	f	\N	\N	1	\N
754	2025-10-03	-24.7817	EUR	19359.23	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.805887+00	2026-06-19 10:30:17.805887+00	\N	\N	\N	f	\N	\N	1	\N
755	2025-10-08	-25.2257	EUR	20444.85	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.806517+00	2026-06-19 10:30:17.806517+00	\N	\N	\N	f	\N	\N	1	\N
756	2025-10-27	-7.6945	EUR	22259.64	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.807227+00	2026-06-19 10:30:17.807227+00	\N	\N	\N	f	\N	\N	1	\N
757	2025-10-04	-52.2323	EUR	19306.99	Hobby	\N	BE76 7340 1234 5678	48	\N	24	t	2026-06-19 10:30:17.807947+00	2026-06-19 10:30:17.807947+00	\N	\N	\N	f	\N	\N	1	\N
758	2025-10-15	-1144.3652	EUR	19125.43	Personenbelasting afrekening	\N	BE76 7340 1234 5678	18	\N	32	t	2026-06-19 10:30:17.808962+00	2026-06-19 10:30:17.808962+00	\N	\N	\N	f	\N	\N	1	\N
759	2025-11-25	3493.0000	EUR	23654.68	Loon november 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.809941+00	2026-06-19 10:30:17.809941+00	\N	\N	\N	f	\N	\N	1	\N
760	2025-11-05	1443.0000	EUR	21511.61	Loon partner november 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.810775+00	2026-06-19 10:30:17.810775+00	\N	\N	\N	f	\N	\N	1	\N
761	2025-11-28	-1100.0000	EUR	21690.85	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.811441+00	2026-06-19 10:30:17.811441+00	\N	\N	\N	f	\N	\N	1	\N
762	2025-11-28	1100.0000	EUR	33450.40	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.812141+00	2026-06-19 10:30:17.812141+00	\N	\N	\N	f	\N	\N	2	\N
763	2025-11-03	-932.4795	EUR	20125.75	Hypotheek aflossing november	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.812839+00	2026-06-19 10:30:17.812839+00	\N	\N	\N	f	\N	\N	1	\N
764	2025-11-08	-106.1839	EUR	21206.98	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.813511+00	2026-06-19 10:30:17.813511+00	\N	\N	\N	f	\N	\N	1	\N
765	2025-11-15	-42.9410	EUR	20460.19	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.814187+00	2026-06-19 10:30:17.814187+00	\N	\N	\N	f	\N	\N	1	\N
766	2025-11-12	-54.0000	EUR	20641.26	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.814824+00	2026-06-19 10:30:17.814824+00	\N	\N	\N	f	\N	\N	1	\N
767	2025-11-12	-22.0000	EUR	20619.26	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.815513+00	2026-06-19 10:30:17.815513+00	\N	\N	\N	f	\N	\N	1	\N
768	2025-11-06	-45.0000	EUR	21423.87	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.816189+00	2026-06-19 10:30:17.816189+00	\N	\N	\N	f	\N	\N	1	\N
769	2025-11-06	-38.0000	EUR	21385.87	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.816817+00	2026-06-19 10:30:17.816817+00	\N	\N	\N	f	\N	\N	1	\N
770	2025-11-18	-13.9900	EUR	20398.73	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.817662+00	2026-06-19 10:30:17.817662+00	\N	\N	\N	f	\N	\N	1	\N
771	2025-11-05	-10.9900	EUR	21500.62	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.81832+00	2026-06-19 10:30:17.81832+00	\N	\N	\N	f	\N	\N	1	\N
772	2025-11-05	-8.9900	EUR	21491.63	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.81892+00	2026-06-19 10:30:17.81892+00	\N	\N	\N	f	\N	\N	1	\N
773	2025-11-02	-29.9900	EUR	21129.65	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.819631+00	2026-06-19 10:30:17.819631+00	\N	\N	\N	f	\N	\N	1	\N
774	2025-11-03	-49.0000	EUR	20076.75	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.820312+00	2026-06-19 10:30:17.820312+00	\N	\N	\N	f	\N	\N	1	\N
775	2025-11-27	-750.0000	EUR	22790.85	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.820998+00	2026-06-19 10:30:17.820998+00	\N	\N	\N	f	\N	\N	1	\N
776	2025-11-14	-112.8624	EUR	20503.13	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.821649+00	2026-06-19 10:30:17.821649+00	\N	\N	\N	f	\N	\N	1	\N
777	2025-11-30	-102.8426	EUR	21390.81	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.822268+00	2026-06-19 10:30:17.822268+00	\N	\N	\N	f	\N	\N	1	\N
778	2025-11-29	-109.6790	EUR	21564.52	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.822897+00	2026-06-19 10:30:17.822897+00	\N	\N	\N	f	\N	\N	1	\N
779	2025-11-24	-47.0896	EUR	20161.68	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.823548+00	2026-06-19 10:30:17.823548+00	\N	\N	\N	f	\N	\N	1	\N
780	2025-11-25	-113.8366	EUR	23540.85	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.824305+00	2026-06-19 10:30:17.824305+00	\N	\N	\N	f	\N	\N	1	\N
781	2025-11-07	-72.7031	EUR	21313.16	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.825035+00	2026-06-19 10:30:17.825035+00	\N	\N	\N	f	\N	\N	1	\N
782	2025-11-23	-81.6091	EUR	20208.77	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.825837+00	2026-06-19 10:30:17.825837+00	\N	\N	\N	f	\N	\N	1	\N
783	2025-11-02	-71.4222	EUR	21058.23	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.826629+00	2026-06-19 10:30:17.826629+00	\N	\N	\N	f	\N	\N	1	\N
784	2025-11-21	-94.6604	EUR	20299.84	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.827305+00	2026-06-19 10:30:17.827305+00	\N	\N	\N	f	\N	\N	1	\N
785	2025-11-19	-4.2267	EUR	20394.50	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.827938+00	2026-06-19 10:30:17.827938+00	\N	\N	\N	f	\N	\N	1	\N
786	2025-11-22	-4.7055	EUR	20295.14	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.828579+00	2026-06-19 10:30:17.828579+00	\N	\N	\N	f	\N	\N	1	\N
787	2025-11-22	-4.7542	EUR	20290.38	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.829201+00	2026-06-19 10:30:17.829201+00	\N	\N	\N	f	\N	\N	1	\N
788	2025-11-13	-3.2620	EUR	20615.99	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.829798+00	2026-06-19 10:30:17.829798+00	\N	\N	\N	f	\N	\N	1	\N
789	2025-11-17	-6.9152	EUR	20412.72	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.830413+00	2026-06-19 10:30:17.830413+00	\N	\N	\N	f	\N	\N	1	\N
790	2025-11-08	-26.9154	EUR	21180.07	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.831045+00	2026-06-19 10:30:17.831045+00	\N	\N	\N	f	\N	\N	1	\N
791	2025-11-15	-40.5555	EUR	20419.63	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.831707+00	2026-06-19 10:30:17.831707+00	\N	\N	\N	f	\N	\N	1	\N
792	2025-11-29	-70.8736	EUR	21493.65	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-19 10:30:17.832364+00	2026-06-19 10:30:17.832364+00	\N	\N	\N	f	\N	\N	1	\N
793	2025-11-08	-484.8099	EUR	20695.26	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-19 10:30:17.832983+00	2026-06-19 10:30:17.832983+00	\N	\N	\N	f	\N	\N	1	\N
794	2025-11-05	-22.7586	EUR	21468.87	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.834172+00	2026-06-19 10:30:17.834172+00	\N	\N	\N	f	\N	\N	1	\N
795	2025-11-04	-8.1431	EUR	20068.61	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.834793+00	2026-06-19 10:30:17.834793+00	\N	\N	\N	f	\N	\N	1	\N
796	2025-11-28	-16.6451	EUR	21674.20	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.835668+00	2026-06-19 10:30:17.835668+00	\N	\N	\N	f	\N	\N	1	\N
797	2025-12-25	3513.0000	EUR	25210.89	Loon december 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.836247+00	2026-06-19 10:30:17.836247+00	\N	\N	\N	f	\N	\N	1	\N
798	2025-12-05	1457.0000	EUR	21469.28	Loon partner december 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.836872+00	2026-06-19 10:30:17.836872+00	\N	\N	\N	f	\N	\N	1	\N
799	2025-12-20	1500.0000	EUR	21710.57	Eindejaarsbonus 2025	\N	BE76 7340 1234 5678	1	\N	2	t	2026-06-19 10:30:17.837542+00	2026-06-19 10:30:17.837542+00	\N	\N	\N	f	\N	\N	1	\N
800	2025-12-28	-1100.0000	EUR	23181.52	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.83815+00	2026-06-19 10:30:17.83815+00	\N	\N	\N	f	\N	\N	1	\N
801	2025-12-28	1100.0000	EUR	34550.40	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.838714+00	2026-06-19 10:30:17.838714+00	\N	\N	\N	f	\N	\N	2	\N
802	2025-12-03	-932.4795	EUR	20061.28	Hypotheek aflossing december	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.839295+00	2026-06-19 10:30:17.839295+00	\N	\N	\N	f	\N	\N	1	\N
803	2025-12-09	-139.7368	EUR	20986.29	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.839879+00	2026-06-19 10:30:17.839879+00	\N	\N	\N	f	\N	\N	1	\N
804	2025-12-12	-54.0000	EUR	20890.67	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.840462+00	2026-06-19 10:30:17.840462+00	\N	\N	\N	f	\N	\N	1	\N
805	2025-12-12	-22.0000	EUR	20868.67	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.841065+00	2026-06-19 10:30:17.841065+00	\N	\N	\N	f	\N	\N	1	\N
806	2025-12-06	-45.0000	EUR	21342.08	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.84167+00	2026-06-19 10:30:17.84167+00	\N	\N	\N	f	\N	\N	1	\N
807	2025-12-06	-38.0000	EUR	21304.08	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.842373+00	2026-06-19 10:30:17.842373+00	\N	\N	\N	f	\N	\N	1	\N
808	2025-12-18	-13.9900	EUR	20360.29	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.843022+00	2026-06-19 10:30:17.843022+00	\N	\N	\N	f	\N	\N	1	\N
809	2025-12-05	-10.9900	EUR	21458.29	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.843641+00	2026-06-19 10:30:17.843641+00	\N	\N	\N	f	\N	\N	1	\N
810	2025-12-05	-8.9900	EUR	21449.30	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.844229+00	2026-06-19 10:30:17.844229+00	\N	\N	\N	f	\N	\N	1	\N
811	2025-12-02	-29.9900	EUR	21021.95	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.844824+00	2026-06-19 10:30:17.844824+00	\N	\N	\N	f	\N	\N	1	\N
812	2025-12-03	-49.0000	EUR	20012.28	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.845398+00	2026-06-19 10:30:17.845398+00	\N	\N	\N	f	\N	\N	1	\N
813	2025-12-27	-750.0000	EUR	24281.52	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.846062+00	2026-06-19 10:30:17.846062+00	\N	\N	\N	f	\N	\N	1	\N
814	2025-12-25	-104.6095	EUR	25106.28	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.846685+00	2026-06-19 10:30:17.846685+00	\N	\N	\N	f	\N	\N	1	\N
815	2025-12-08	-51.8484	EUR	21252.23	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-19 10:30:17.847286+00	2026-06-19 10:30:17.847286+00	\N	\N	\N	f	\N	\N	1	\N
816	2025-12-05	-62.2151	EUR	21387.08	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.847889+00	2026-06-19 10:30:17.847889+00	\N	\N	\N	f	\N	\N	1	\N
817	2025-12-01	-47.7805	EUR	21343.03	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.848521+00	2026-06-19 10:30:17.848521+00	\N	\N	\N	f	\N	\N	1	\N
818	2025-12-18	-77.1983	EUR	20283.09	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.849147+00	2026-06-19 10:30:17.849147+00	\N	\N	\N	f	\N	\N	1	\N
819	2025-12-29	-54.7517	EUR	23126.77	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.850095+00	2026-06-19 10:30:17.850095+00	\N	\N	\N	f	\N	\N	1	\N
820	2025-12-18	-72.5281	EUR	20210.57	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.850776+00	2026-06-19 10:30:17.850776+00	\N	\N	\N	f	\N	\N	1	\N
821	2025-12-26	-74.7625	EUR	25031.52	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.851387+00	2026-06-19 10:30:17.851387+00	\N	\N	\N	f	\N	\N	1	\N
822	2025-12-02	-28.1978	EUR	20993.75	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.852002+00	2026-06-19 10:30:17.852002+00	\N	\N	\N	f	\N	\N	1	\N
823	2025-12-08	-70.2838	EUR	21181.95	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.852661+00	2026-06-19 10:30:17.852661+00	\N	\N	\N	f	\N	\N	1	\N
824	2025-12-09	-41.6244	EUR	20944.67	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.853277+00	2026-06-19 10:30:17.853277+00	\N	\N	\N	f	\N	\N	1	\N
825	2025-12-22	-4.2213	EUR	21697.89	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.853933+00	2026-06-19 10:30:17.853933+00	\N	\N	\N	f	\N	\N	1	\N
826	2025-12-12	-4.5568	EUR	20864.11	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.854576+00	2026-06-19 10:30:17.854576+00	\N	\N	\N	f	\N	\N	1	\N
827	2025-12-31	-5.5933	EUR	23086.81	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.855241+00	2026-06-19 10:30:17.855241+00	\N	\N	\N	f	\N	\N	1	\N
828	2025-12-08	-25.1500	EUR	21156.80	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.855909+00	2026-06-19 10:30:17.855909+00	\N	\N	\N	f	\N	\N	1	\N
829	2025-12-08	-30.7692	EUR	21126.03	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.856531+00	2026-06-19 10:30:17.856531+00	\N	\N	\N	f	\N	\N	1	\N
830	2025-12-01	-291.0836	EUR	21051.94	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-19 10:30:17.857141+00	2026-06-19 10:30:17.857141+00	\N	\N	\N	f	\N	\N	1	\N
831	2025-12-16	-402.3938	EUR	20408.57	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-19 10:30:17.85779+00	2026-06-19 10:30:17.85779+00	\N	\N	\N	f	\N	\N	1	\N
832	2025-12-30	-34.3623	EUR	23092.41	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.858402+00	2026-06-19 10:30:17.858402+00	\N	\N	\N	f	\N	\N	1	\N
833	2025-12-21	-8.4510	EUR	21702.12	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.859107+00	2026-06-19 10:30:17.859107+00	\N	\N	\N	f	\N	\N	1	\N
834	2025-12-17	-34.2896	EUR	20374.28	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-19 10:30:17.859745+00	2026-06-19 10:30:17.859745+00	\N	\N	\N	f	\N	\N	1	\N
835	2025-12-14	-53.1445	EUR	20810.97	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.860407+00	2026-06-19 10:30:17.860407+00	\N	\N	\N	f	\N	\N	1	\N
836	2026-01-25	3611.0000	EUR	26263.24	Loon januari 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.861024+00	2026-06-19 10:30:17.861024+00	\N	\N	\N	f	\N	\N	1	\N
837	2026-01-05	1496.0000	EUR	23405.36	Loon partner januari 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.861648+00	2026-06-19 10:30:17.861648+00	\N	\N	\N	f	\N	\N	1	\N
838	2026-01-02	25.4605	EUR	34575.86	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.862273+00	2026-06-19 10:30:17.862273+00	\N	\N	\N	f	\N	\N	2	\N
839	2026-01-28	-1100.0000	EUR	24413.24	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.862872+00	2026-06-19 10:30:17.862872+00	\N	\N	\N	f	\N	\N	1	\N
840	2026-01-28	1100.0000	EUR	35675.86	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.863491+00	2026-06-19 10:30:17.863491+00	\N	\N	\N	f	\N	\N	2	\N
841	2026-01-03	-932.4795	EUR	22124.34	Hypotheek aflossing januari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.864142+00	2026-06-19 10:30:17.864142+00	\N	\N	\N	f	\N	\N	1	\N
842	2026-01-11	-105.7967	EUR	23170.12	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.864816+00	2026-06-19 10:30:17.864816+00	\N	\N	\N	f	\N	\N	1	\N
843	2026-01-12	-54.0000	EUR	23112.46	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.865538+00	2026-06-19 10:30:17.865538+00	\N	\N	\N	f	\N	\N	1	\N
844	2026-01-12	-22.0000	EUR	23090.46	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.866159+00	2026-06-19 10:30:17.866159+00	\N	\N	\N	f	\N	\N	1	\N
845	2026-01-06	-45.0000	EUR	23340.38	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.866876+00	2026-06-19 10:30:17.866876+00	\N	\N	\N	f	\N	\N	1	\N
846	2026-01-06	-38.0000	EUR	23302.38	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.867577+00	2026-06-19 10:30:17.867577+00	\N	\N	\N	f	\N	\N	1	\N
847	2026-01-18	-13.9900	EUR	22958.10	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.868211+00	2026-06-19 10:30:17.868211+00	\N	\N	\N	f	\N	\N	1	\N
848	2026-01-05	-10.9900	EUR	23394.37	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.868883+00	2026-06-19 10:30:17.868883+00	\N	\N	\N	f	\N	\N	1	\N
849	2026-01-05	-8.9900	EUR	23385.38	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.869505+00	2026-06-19 10:30:17.869505+00	\N	\N	\N	f	\N	\N	1	\N
850	2026-01-02	-29.9900	EUR	23056.82	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.870159+00	2026-06-19 10:30:17.870159+00	\N	\N	\N	f	\N	\N	1	\N
851	2026-01-03	-49.0000	EUR	22075.34	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.87084+00	2026-06-19 10:30:17.87084+00	\N	\N	\N	f	\N	\N	1	\N
852	2026-01-22	-44.3448	EUR	22816.79	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-19 10:30:17.871503+00	2026-06-19 10:30:17.871503+00	\N	\N	\N	f	\N	\N	1	\N
853	2026-01-27	-750.0000	EUR	25513.24	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.872126+00	2026-06-19 10:30:17.872126+00	\N	\N	\N	f	\N	\N	1	\N
854	2026-01-03	-87.7979	EUR	21987.55	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.873355+00	2026-06-19 10:30:17.873355+00	\N	\N	\N	f	\N	\N	1	\N
855	2026-01-22	-100.1718	EUR	22716.62	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.874096+00	2026-06-19 10:30:17.874096+00	\N	\N	\N	f	\N	\N	1	\N
856	2026-01-30	-90.3522	EUR	24322.89	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.874821+00	2026-06-19 10:30:17.874821+00	\N	\N	\N	f	\N	\N	1	\N
857	2026-01-16	-43.0256	EUR	22986.27	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.875508+00	2026-06-19 10:30:17.875508+00	\N	\N	\N	f	\N	\N	1	\N
858	2026-01-23	-64.3790	EUR	22652.24	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.876189+00	2026-06-19 10:30:17.876189+00	\N	\N	\N	f	\N	\N	1	\N
859	2026-01-30	-29.2910	EUR	24293.60	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.876845+00	2026-06-19 10:30:17.876845+00	\N	\N	\N	f	\N	\N	1	\N
860	2026-01-03	-55.4768	EUR	21932.07	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.877442+00	2026-06-19 10:30:17.877442+00	\N	\N	\N	f	\N	\N	1	\N
861	2026-01-15	-61.1675	EUR	23029.29	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.878237+00	2026-06-19 10:30:17.878237+00	\N	\N	\N	f	\N	\N	1	\N
862	2026-01-20	-93.5080	EUR	22861.13	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.878849+00	2026-06-19 10:30:17.878849+00	\N	\N	\N	f	\N	\N	1	\N
863	2026-01-11	-3.6610	EUR	23166.46	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.879477+00	2026-06-19 10:30:17.879477+00	\N	\N	\N	f	\N	\N	1	\N
864	2026-01-08	-6.4520	EUR	23275.92	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.880107+00	2026-06-19 10:30:17.880107+00	\N	\N	\N	f	\N	\N	1	\N
865	2026-01-18	-3.4605	EUR	22954.64	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.880702+00	2026-06-19 10:30:17.880702+00	\N	\N	\N	f	\N	\N	1	\N
866	2026-01-07	-20.0118	EUR	23282.37	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.881358+00	2026-06-19 10:30:17.881358+00	\N	\N	\N	f	\N	\N	1	\N
867	2026-01-17	-14.1761	EUR	22972.09	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.881993+00	2026-06-19 10:30:17.881993+00	\N	\N	\N	f	\N	\N	1	\N
868	2026-01-03	-22.7071	EUR	21909.36	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-19 10:30:17.882654+00	2026-06-19 10:30:17.882654+00	\N	\N	\N	f	\N	\N	1	\N
869	2026-02-25	3592.0000	EUR	27273.58	Loon februari 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.883488+00	2026-06-19 10:30:17.883488+00	\N	\N	\N	f	\N	\N	1	\N
870	2026-02-05	1474.0000	EUR	24713.26	Loon partner februari 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.884186+00	2026-06-19 10:30:17.884186+00	\N	\N	\N	f	\N	\N	1	\N
871	2026-02-28	-1100.0000	EUR	25264.22	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.884787+00	2026-06-19 10:30:17.884787+00	\N	\N	\N	f	\N	\N	1	\N
872	2026-02-28	1100.0000	EUR	36775.86	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.885417+00	2026-06-19 10:30:17.885417+00	\N	\N	\N	f	\N	\N	2	\N
873	2026-02-03	-932.4795	EUR	23325.23	Hypotheek aflossing februari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.886029+00	2026-06-19 10:30:17.886029+00	\N	\N	\N	f	\N	\N	1	\N
874	2026-02-09	-144.1475	EUR	24146.65	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.886631+00	2026-06-19 10:30:17.886631+00	\N	\N	\N	f	\N	\N	1	\N
875	2026-02-15	-63.1131	EUR	23986.33	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.88724+00	2026-06-19 10:30:17.88724+00	\N	\N	\N	f	\N	\N	1	\N
876	2026-02-12	-54.0000	EUR	24071.44	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.887863+00	2026-06-19 10:30:17.887863+00	\N	\N	\N	f	\N	\N	1	\N
877	2026-02-12	-22.0000	EUR	24049.44	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.888468+00	2026-06-19 10:30:17.888468+00	\N	\N	\N	f	\N	\N	1	\N
878	2026-02-06	-45.0000	EUR	24648.28	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.889096+00	2026-06-19 10:30:17.889096+00	\N	\N	\N	f	\N	\N	1	\N
879	2026-02-06	-38.0000	EUR	24610.28	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.889725+00	2026-06-19 10:30:17.889725+00	\N	\N	\N	f	\N	\N	1	\N
880	2026-02-18	-13.9900	EUR	23875.36	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.890325+00	2026-06-19 10:30:17.890325+00	\N	\N	\N	f	\N	\N	1	\N
881	2026-02-05	-10.9900	EUR	24702.27	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.891012+00	2026-06-19 10:30:17.891012+00	\N	\N	\N	f	\N	\N	1	\N
882	2026-02-05	-8.9900	EUR	24693.28	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.891706+00	2026-06-19 10:30:17.891706+00	\N	\N	\N	f	\N	\N	1	\N
883	2026-02-02	-29.9900	EUR	24257.71	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.892432+00	2026-06-19 10:30:17.892432+00	\N	\N	\N	f	\N	\N	1	\N
884	2026-02-03	-49.0000	EUR	23276.23	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.893134+00	2026-06-19 10:30:17.893134+00	\N	\N	\N	f	\N	\N	1	\N
885	2026-02-11	-15.6967	EUR	24125.44	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-19 10:30:17.893842+00	2026-06-19 10:30:17.893842+00	\N	\N	\N	f	\N	\N	1	\N
886	2026-02-27	-750.0000	EUR	26523.58	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.894517+00	2026-06-19 10:30:17.894517+00	\N	\N	\N	f	\N	\N	1	\N
887	2026-02-19	-83.0046	EUR	23792.36	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.895179+00	2026-06-19 10:30:17.895179+00	\N	\N	\N	f	\N	\N	1	\N
888	2026-02-27	-115.1598	EUR	26408.42	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.895802+00	2026-06-19 10:30:17.895802+00	\N	\N	\N	f	\N	\N	1	\N
889	2026-02-15	-90.5217	EUR	23895.81	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.896437+00	2026-06-19 10:30:17.896437+00	\N	\N	\N	f	\N	\N	1	\N
890	2026-02-07	-52.1534	EUR	24500.99	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.897047+00	2026-06-19 10:30:17.897047+00	\N	\N	\N	f	\N	\N	1	\N
891	2026-02-21	-73.6264	EUR	23718.73	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.897701+00	2026-06-19 10:30:17.897701+00	\N	\N	\N	f	\N	\N	1	\N
892	2026-02-27	-44.1998	EUR	26364.22	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.898323+00	2026-06-19 10:30:17.898323+00	\N	\N	\N	f	\N	\N	1	\N
893	2026-02-06	-57.1403	EUR	24553.14	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.89892+00	2026-06-19 10:30:17.89892+00	\N	\N	\N	f	\N	\N	1	\N
894	2026-02-01	-5.8958	EUR	24287.70	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.899537+00	2026-06-19 10:30:17.899537+00	\N	\N	\N	f	\N	\N	1	\N
895	2026-02-09	-5.5107	EUR	24141.14	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.900153+00	2026-06-19 10:30:17.900153+00	\N	\N	\N	f	\N	\N	1	\N
896	2026-02-16	-6.4538	EUR	23889.35	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.901108+00	2026-06-19 10:30:17.901108+00	\N	\N	\N	f	\N	\N	1	\N
897	2026-02-24	-37.1537	EUR	23681.58	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.901748+00	2026-06-19 10:30:17.901748+00	\N	\N	\N	f	\N	\N	1	\N
898	2026-02-03	-36.9660	EUR	23239.26	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.902493+00	2026-06-19 10:30:17.902493+00	\N	\N	\N	f	\N	\N	1	\N
899	2026-02-08	-210.1941	EUR	24290.80	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-19 10:30:17.903108+00	2026-06-19 10:30:17.903108+00	\N	\N	\N	f	\N	\N	1	\N
900	2026-03-25	3617.0000	EUR	28893.98	Loon maart 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.903746+00	2026-06-19 10:30:17.903746+00	\N	\N	\N	f	\N	\N	1	\N
901	2026-03-05	1494.0000	EUR	25554.72	Loon partner maart 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.90437+00	2026-06-19 10:30:17.90437+00	\N	\N	\N	f	\N	\N	1	\N
902	2026-03-16	641.8209	EUR	25552.72	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-19 10:30:17.904979+00	2026-06-19 10:30:17.904979+00	\N	\N	\N	f	\N	\N	1	\N
903	2026-03-28	-1100.0000	EUR	27007.84	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.905638+00	2026-06-19 10:30:17.905638+00	\N	\N	\N	f	\N	\N	1	\N
904	2026-03-28	1100.0000	EUR	37875.86	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.906252+00	2026-06-19 10:30:17.906252+00	\N	\N	\N	f	\N	\N	2	\N
905	2026-03-03	-932.4795	EUR	24109.72	Hypotheek aflossing maart	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.906867+00	2026-06-19 10:30:17.906867+00	\N	\N	\N	f	\N	\N	1	\N
906	2026-03-09	-97.2089	EUR	25208.45	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.907555+00	2026-06-19 10:30:17.907555+00	\N	\N	\N	f	\N	\N	1	\N
907	2026-03-12	-54.0000	EUR	25074.01	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.908231+00	2026-06-19 10:30:17.908231+00	\N	\N	\N	f	\N	\N	1	\N
908	2026-03-12	-22.0000	EUR	25052.01	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.908855+00	2026-06-19 10:30:17.908855+00	\N	\N	\N	f	\N	\N	1	\N
909	2026-03-06	-45.0000	EUR	25489.74	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.909576+00	2026-06-19 10:30:17.909576+00	\N	\N	\N	f	\N	\N	1	\N
910	2026-03-06	-38.0000	EUR	25451.74	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.910364+00	2026-06-19 10:30:17.910364+00	\N	\N	\N	f	\N	\N	1	\N
911	2026-03-18	-13.9900	EUR	25462.96	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.911079+00	2026-06-19 10:30:17.911079+00	\N	\N	\N	f	\N	\N	1	\N
912	2026-03-05	-10.9900	EUR	25543.73	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.911749+00	2026-06-19 10:30:17.911749+00	\N	\N	\N	f	\N	\N	1	\N
913	2026-03-05	-8.9900	EUR	25534.74	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.912514+00	2026-06-19 10:30:17.912514+00	\N	\N	\N	f	\N	\N	1	\N
914	2026-03-02	-29.9900	EUR	25123.58	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.913149+00	2026-06-19 10:30:17.913149+00	\N	\N	\N	f	\N	\N	1	\N
915	2026-03-03	-49.0000	EUR	24060.72	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.913927+00	2026-06-19 10:30:17.913927+00	\N	\N	\N	f	\N	\N	1	\N
916	2026-03-23	-27.8307	EUR	25288.96	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-19 10:30:17.91462+00	2026-06-19 10:30:17.91462+00	\N	\N	\N	f	\N	\N	1	\N
917	2026-03-27	-750.0000	EUR	28107.84	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.915222+00	2026-06-19 10:30:17.915222+00	\N	\N	\N	f	\N	\N	1	\N
918	2026-03-22	-52.0257	EUR	25316.79	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.91582+00	2026-06-19 10:30:17.91582+00	\N	\N	\N	f	\N	\N	1	\N
919	2026-03-30	-61.6948	EUR	26946.15	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.916568+00	2026-06-19 10:30:17.916568+00	\N	\N	\N	f	\N	\N	1	\N
920	2026-03-12	-113.8674	EUR	24938.14	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-19 10:30:17.917614+00	2026-06-19 10:30:17.917614+00	\N	\N	\N	f	\N	\N	1	\N
921	2026-03-21	-37.3150	EUR	25425.64	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.918377+00	2026-06-19 10:30:17.918377+00	\N	\N	\N	f	\N	\N	1	\N
922	2026-03-21	-56.8251	EUR	25368.82	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.919001+00	2026-06-19 10:30:17.919001+00	\N	\N	\N	f	\N	\N	1	\N
923	2026-03-01	-80.5177	EUR	25183.70	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.919643+00	2026-06-19 10:30:17.919643+00	\N	\N	\N	f	\N	\N	1	\N
924	2026-03-08	-41.5721	EUR	25362.58	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.920244+00	2026-06-19 10:30:17.920244+00	\N	\N	\N	f	\N	\N	1	\N
925	2026-03-09	-38.3741	EUR	25170.08	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.920876+00	2026-06-19 10:30:17.920876+00	\N	\N	\N	f	\N	\N	1	\N
926	2026-03-02	-81.3830	EUR	25042.20	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.921555+00	2026-06-19 10:30:17.921555+00	\N	\N	\N	f	\N	\N	1	\N
927	2026-03-08	-56.9158	EUR	25305.66	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.922175+00	2026-06-19 10:30:17.922175+00	\N	\N	\N	f	\N	\N	1	\N
928	2026-03-23	-7.3613	EUR	25281.60	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.922776+00	2026-06-19 10:30:17.922776+00	\N	\N	\N	f	\N	\N	1	\N
929	2026-03-23	-4.6233	EUR	25276.98	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.923422+00	2026-06-19 10:30:17.923422+00	\N	\N	\N	f	\N	\N	1	\N
930	2026-03-09	-3.2939	EUR	25166.79	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.924042+00	2026-06-19 10:30:17.924042+00	\N	\N	\N	f	\N	\N	1	\N
931	2026-03-30	-6.6447	EUR	26939.50	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.92466+00	2026-06-19 10:30:17.92466+00	\N	\N	\N	f	\N	\N	1	\N
932	2026-03-26	-3.5103	EUR	28857.84	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.925338+00	2026-06-19 10:30:17.925338+00	\N	\N	\N	f	\N	\N	1	\N
933	2026-03-11	-38.7730	EUR	25128.01	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.926052+00	2026-06-19 10:30:17.926052+00	\N	\N	\N	f	\N	\N	1	\N
934	2026-03-01	-19.8634	EUR	25163.84	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.926786+00	2026-06-19 10:30:17.926786+00	\N	\N	\N	f	\N	\N	1	\N
935	2026-03-25	-32.6234	EUR	28861.35	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.927433+00	2026-06-19 10:30:17.927433+00	\N	\N	\N	f	\N	\N	1	\N
936	2026-03-16	-75.7750	EUR	25476.95	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-19 10:30:17.928082+00	2026-06-19 10:30:17.928082+00	\N	\N	\N	f	\N	\N	1	\N
937	2026-03-14	-27.2426	EUR	24910.90	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.928686+00	2026-06-19 10:30:17.928686+00	\N	\N	\N	f	\N	\N	1	\N
938	2026-03-07	-47.5911	EUR	25404.15	Consultatie huisarts	\N	BE76 7340 1234 5678	38	\N	20	t	2026-06-19 10:30:17.929321+00	2026-06-19 10:30:17.929321+00	\N	\N	\N	f	\N	\N	1	\N
939	2026-03-01	-10.2633	EUR	25153.57	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.929988+00	2026-06-19 10:30:17.929988+00	\N	\N	\N	f	\N	\N	1	\N
940	2026-04-25	3618.0000	EUR	29759.15	Loon april 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.930608+00	2026-06-19 10:30:17.930608+00	\N	\N	\N	f	\N	\N	1	\N
941	2026-04-05	1488.0000	EUR	27084.77	Loon partner april 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.931237+00	2026-06-19 10:30:17.931237+00	\N	\N	\N	f	\N	\N	1	\N
942	2026-04-02	21.7840	EUR	37897.65	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-19 10:30:17.931843+00	2026-06-19 10:30:17.931843+00	\N	\N	\N	f	\N	\N	2	\N
943	2026-04-28	-1100.0000	EUR	27895.97	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.932497+00	2026-06-19 10:30:17.932497+00	\N	\N	\N	f	\N	\N	1	\N
944	2026-04-28	1100.0000	EUR	38997.65	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.933178+00	2026-06-19 10:30:17.933178+00	\N	\N	\N	f	\N	\N	2	\N
945	2026-04-03	-932.4795	EUR	25936.57	Hypotheek aflossing april	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.934426+00	2026-06-19 10:30:17.934426+00	\N	\N	\N	f	\N	\N	1	\N
946	2026-04-08	-125.7493	EUR	26754.83	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.935084+00	2026-06-19 10:30:17.935084+00	\N	\N	\N	f	\N	\N	1	\N
947	2026-04-12	-54.0000	EUR	26488.80	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.93575+00	2026-06-19 10:30:17.93575+00	\N	\N	\N	f	\N	\N	1	\N
948	2026-04-12	-22.0000	EUR	26466.80	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.936414+00	2026-06-19 10:30:17.936414+00	\N	\N	\N	f	\N	\N	1	\N
949	2026-04-06	-45.0000	EUR	27019.79	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.938398+00	2026-06-19 10:30:17.938398+00	\N	\N	\N	f	\N	\N	1	\N
950	2026-04-06	-38.0000	EUR	26981.79	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.939163+00	2026-06-19 10:30:17.939163+00	\N	\N	\N	f	\N	\N	1	\N
951	2026-04-18	-13.9900	EUR	26356.34	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.939777+00	2026-06-19 10:30:17.939777+00	\N	\N	\N	f	\N	\N	1	\N
952	2026-04-05	-10.9900	EUR	27073.78	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.940431+00	2026-06-19 10:30:17.940431+00	\N	\N	\N	f	\N	\N	1	\N
953	2026-04-05	-8.9900	EUR	27064.79	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.941029+00	2026-06-19 10:30:17.941029+00	\N	\N	\N	f	\N	\N	1	\N
954	2026-04-02	-29.9900	EUR	26909.51	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.941755+00	2026-06-19 10:30:17.941755+00	\N	\N	\N	f	\N	\N	1	\N
955	2026-04-03	-49.0000	EUR	25887.57	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.94251+00	2026-06-19 10:30:17.94251+00	\N	\N	\N	f	\N	\N	1	\N
956	2026-04-16	-17.9928	EUR	26370.33	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-19 10:30:17.943169+00	2026-06-19 10:30:17.943169+00	\N	\N	\N	f	\N	\N	1	\N
957	2026-04-27	-750.0000	EUR	29000.06	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.943875+00	2026-06-19 10:30:17.943875+00	\N	\N	\N	f	\N	\N	1	\N
958	2026-04-19	-104.4068	EUR	26251.94	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.944511+00	2026-06-19 10:30:17.944511+00	\N	\N	\N	f	\N	\N	1	\N
959	2026-04-03	-122.0560	EUR	25765.52	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.94512+00	2026-06-19 10:30:17.94512+00	\N	\N	\N	f	\N	\N	1	\N
960	2026-04-08	-101.2731	EUR	26653.56	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.945754+00	2026-06-19 10:30:17.945754+00	\N	\N	\N	f	\N	\N	1	\N
961	2026-04-02	-36.3912	EUR	26873.12	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.946447+00	2026-06-19 10:30:17.946447+00	\N	\N	\N	f	\N	\N	1	\N
962	2026-04-07	-66.1720	EUR	26915.61	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.94705+00	2026-06-19 10:30:17.94705+00	\N	\N	\N	f	\N	\N	1	\N
963	2026-04-09	-55.5587	EUR	26542.80	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-19 10:30:17.947674+00	2026-06-19 10:30:17.947674+00	\N	\N	\N	f	\N	\N	1	\N
964	2026-04-12	-32.4716	EUR	26434.33	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.948341+00	2026-06-19 10:30:17.948341+00	\N	\N	\N	f	\N	\N	1	\N
965	2026-04-21	-54.8567	EUR	26168.77	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:17.949348+00	2026-06-19 10:30:17.949348+00	\N	\N	\N	f	\N	\N	1	\N
966	2026-04-02	-4.0701	EUR	26869.05	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.950052+00	2026-06-19 10:30:17.950052+00	\N	\N	\N	f	\N	\N	1	\N
967	2026-04-25	-5.7557	EUR	29753.39	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.951476+00	2026-06-19 10:30:17.951476+00	\N	\N	\N	f	\N	\N	1	\N
968	2026-04-19	-6.9075	EUR	26245.03	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.952136+00	2026-06-19 10:30:17.952136+00	\N	\N	\N	f	\N	\N	1	\N
969	2026-04-12	-7.4842	EUR	26426.84	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.952788+00	2026-06-19 10:30:17.952788+00	\N	\N	\N	f	\N	\N	1	\N
970	2026-04-27	-4.0912	EUR	28995.97	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-19 10:30:17.953435+00	2026-06-19 10:30:17.953435+00	\N	\N	\N	f	\N	\N	1	\N
971	2026-04-25	-3.3306	EUR	29750.06	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.954131+00	2026-06-19 10:30:17.954131+00	\N	\N	\N	f	\N	\N	1	\N
972	2026-04-20	-21.3983	EUR	26223.63	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.954736+00	2026-06-19 10:30:17.954736+00	\N	\N	\N	f	\N	\N	1	\N
973	2026-04-12	-38.5166	EUR	26388.33	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.955421+00	2026-06-19 10:30:17.955421+00	\N	\N	\N	f	\N	\N	1	\N
974	2026-04-07	-35.0316	EUR	26880.58	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.956025+00	2026-06-19 10:30:17.956025+00	\N	\N	\N	f	\N	\N	1	\N
975	2026-04-03	-168.7508	EUR	25596.77	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-19 10:30:17.956692+00	2026-06-19 10:30:17.956692+00	\N	\N	\N	f	\N	\N	1	\N
976	2026-04-30	-368.2721	EUR	27527.70	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-19 10:30:17.957307+00	2026-06-19 10:30:17.957307+00	\N	\N	\N	f	\N	\N	1	\N
977	2026-04-08	-55.2038	EUR	26598.36	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-19 10:30:17.957913+00	2026-06-19 10:30:17.957913+00	\N	\N	\N	f	\N	\N	1	\N
978	2026-04-22	-27.6230	EUR	26141.15	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-19 10:30:17.958865+00	2026-06-19 10:30:17.958865+00	\N	\N	\N	f	\N	\N	1	\N
979	2026-05-25	3618.0000	EUR	31147.14	Loon mei 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-19 10:30:17.959522+00	2026-06-19 10:30:17.959522+00	\N	\N	\N	f	\N	\N	1	\N
980	2026-05-05	1476.0000	EUR	27923.03	Loon partner mei 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.960132+00	2026-06-19 10:30:17.960132+00	\N	\N	\N	f	\N	\N	1	\N
981	2026-05-10	359.4717	EUR	27965.42	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-19 10:30:17.960769+00	2026-06-19 10:30:17.960769+00	\N	\N	\N	f	\N	\N	1	\N
982	2026-05-28	-1100.0000	EUR	29230.61	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-19 10:30:17.961487+00	2026-06-19 10:30:17.961487+00	\N	\N	\N	f	\N	\N	1	\N
983	2026-05-28	1100.0000	EUR	40097.65	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-19 10:30:17.962141+00	2026-06-19 10:30:17.962141+00	\N	\N	\N	f	\N	\N	2	\N
984	2026-05-03	-932.4795	EUR	26565.23	Hypotheek aflossing mei	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.962763+00	2026-06-19 10:30:17.962763+00	\N	\N	\N	f	\N	\N	1	\N
985	2026-05-08	-129.4922	EUR	27609.96	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.963359+00	2026-06-19 10:30:17.963359+00	\N	\N	\N	f	\N	\N	1	\N
986	2026-05-15	-65.5589	EUR	27630.31	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-19 10:30:17.963958+00	2026-06-19 10:30:17.963958+00	\N	\N	\N	f	\N	\N	1	\N
987	2026-05-12	-54.0000	EUR	27739.72	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.964606+00	2026-06-19 10:30:17.964606+00	\N	\N	\N	f	\N	\N	1	\N
988	2026-05-12	-22.0000	EUR	27717.72	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.965203+00	2026-06-19 10:30:17.965203+00	\N	\N	\N	f	\N	\N	1	\N
989	2026-05-06	-45.0000	EUR	27858.05	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.965792+00	2026-06-19 10:30:17.965792+00	\N	\N	\N	f	\N	\N	1	\N
990	2026-05-06	-38.0000	EUR	27820.05	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.966596+00	2026-06-19 10:30:17.966596+00	\N	\N	\N	f	\N	\N	1	\N
991	2026-05-18	-13.9900	EUR	27611.50	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.967598+00	2026-06-19 10:30:17.967598+00	\N	\N	\N	f	\N	\N	1	\N
992	2026-05-05	-10.9900	EUR	27912.04	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.968225+00	2026-06-19 10:30:17.968225+00	\N	\N	\N	f	\N	\N	1	\N
993	2026-05-05	-8.9900	EUR	27903.05	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.96883+00	2026-06-19 10:30:17.96883+00	\N	\N	\N	f	\N	\N	1	\N
994	2026-05-02	-29.9900	EUR	27497.71	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.969461+00	2026-06-19 10:30:17.969461+00	\N	\N	\N	f	\N	\N	1	\N
995	2026-05-03	-49.0000	EUR	26516.23	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.970104+00	2026-06-19 10:30:17.970104+00	\N	\N	\N	f	\N	\N	1	\N
996	2026-05-27	-750.0000	EUR	30330.61	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-19 10:30:17.970841+00	2026-06-19 10:30:17.970841+00	\N	\N	\N	f	\N	\N	1	\N
997	2026-05-18	-38.7290	EUR	27572.77	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.971543+00	2026-06-19 10:30:17.971543+00	\N	\N	\N	f	\N	\N	1	\N
998	2026-05-11	-100.7704	EUR	27824.73	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-19 10:30:17.972255+00	2026-06-19 10:30:17.972255+00	\N	\N	\N	f	\N	\N	1	\N
999	2026-05-10	-39.9229	EUR	27925.50	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.972893+00	2026-06-19 10:30:17.972893+00	\N	\N	\N	f	\N	\N	1	\N
1000	2026-05-07	-69.2848	EUR	27739.45	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-19 10:30:17.973515+00	2026-06-19 10:30:17.973515+00	\N	\N	\N	f	\N	\N	1	\N
1001	2026-05-03	-69.2014	EUR	26447.03	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.974266+00	2026-06-19 10:30:17.974266+00	\N	\N	\N	f	\N	\N	1	\N
1002	2026-05-26	-61.9286	EUR	31085.21	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-19 10:30:17.974913+00	2026-06-19 10:30:17.974913+00	\N	\N	\N	f	\N	\N	1	\N
1003	2026-05-11	-26.4074	EUR	27798.32	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-19 10:30:17.97558+00	2026-06-19 10:30:17.97558+00	\N	\N	\N	f	\N	\N	1	\N
1004	2026-05-24	-37.5499	EUR	27529.14	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:17.977196+00	2026-06-19 10:30:17.977196+00	\N	\N	\N	f	\N	\N	1	\N
1005	2026-05-08	-4.0036	EUR	27605.95	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.978317+00	2026-06-19 10:30:17.978317+00	\N	\N	\N	f	\N	\N	1	\N
1006	2026-05-17	-4.8138	EUR	27625.49	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.979147+00	2026-06-19 10:30:17.979147+00	\N	\N	\N	f	\N	\N	1	\N
1007	2026-05-11	-4.6002	EUR	27793.72	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.979827+00	2026-06-19 10:30:17.979827+00	\N	\N	\N	f	\N	\N	1	\N
1008	2026-05-26	-4.5979	EUR	31080.61	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:17.980531+00	2026-06-19 10:30:17.980531+00	\N	\N	\N	f	\N	\N	1	\N
1009	2026-05-29	-32.3843	EUR	29198.23	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:17.981192+00	2026-06-19 10:30:17.981192+00	\N	\N	\N	f	\N	\N	1	\N
1010	2026-05-12	-21.8577	EUR	27695.86	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.981873+00	2026-06-19 10:30:17.981873+00	\N	\N	\N	f	\N	\N	1	\N
1011	2026-05-30	-41.0042	EUR	29157.23	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:17.982579+00	2026-06-19 10:30:17.982579+00	\N	\N	\N	f	\N	\N	1	\N
1012	2026-05-06	-11.3171	EUR	27808.73	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-19 10:30:17.983535+00	2026-06-19 10:30:17.983535+00	\N	\N	\N	f	\N	\N	1	\N
1013	2026-05-20	-6.0824	EUR	27566.69	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-19 10:30:17.984292+00	2026-06-19 10:30:17.984292+00	\N	\N	\N	f	\N	\N	1	\N
1014	2026-06-05	1495.0000	EUR	28667.28	Loon partner juni 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-19 10:30:17.985102+00	2026-06-19 10:30:17.985102+00	\N	\N	\N	f	\N	\N	1	\N
1015	2026-06-15	394.3382	EUR	28005.67	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-19 10:30:17.985961+00	2026-06-19 10:30:17.985961+00	\N	\N	\N	f	\N	\N	1	\N
1016	2026-06-03	-932.4795	EUR	27503.81	Hypotheek aflossing juni	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-19 10:30:17.98662+00	2026-06-19 10:30:17.98662+00	\N	\N	\N	f	\N	\N	1	\N
1017	2026-06-10	-136.3005	EUR	28110.75	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-19 10:30:17.987257+00	2026-06-19 10:30:17.987257+00	\N	\N	\N	f	\N	\N	1	\N
1018	2026-06-12	-54.0000	EUR	28048.01	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-19 10:30:17.988013+00	2026-06-19 10:30:17.988013+00	\N	\N	\N	f	\N	\N	1	\N
1019	2026-06-12	-22.0000	EUR	28026.01	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-19 10:30:17.98869+00	2026-06-19 10:30:17.98869+00	\N	\N	\N	f	\N	\N	1	\N
1020	2026-06-06	-45.0000	EUR	28563.31	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-19 10:30:17.989411+00	2026-06-19 10:30:17.989411+00	\N	\N	\N	f	\N	\N	1	\N
1021	2026-06-06	-38.0000	EUR	28525.31	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-19 10:30:17.990132+00	2026-06-19 10:30:17.990132+00	\N	\N	\N	f	\N	\N	1	\N
1022	2026-06-18	-13.9900	EUR	27987.82	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-19 10:30:17.990907+00	2026-06-19 10:30:17.990907+00	\N	\N	\N	f	\N	\N	1	\N
1023	2026-06-05	-10.9900	EUR	28656.29	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-19 10:30:17.99163+00	2026-06-19 10:30:17.99163+00	\N	\N	\N	f	\N	\N	1	\N
1024	2026-06-05	-8.9900	EUR	28647.30	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-19 10:30:17.992389+00	2026-06-19 10:30:17.992389+00	\N	\N	\N	f	\N	\N	1	\N
1025	2026-06-02	-29.9900	EUR	28436.29	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-19 10:30:17.993205+00	2026-06-19 10:30:17.993205+00	\N	\N	\N	f	\N	\N	1	\N
1026	2026-06-03	-49.0000	EUR	27454.81	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-19 10:30:17.993902+00	2026-06-19 10:30:17.993902+00	\N	\N	\N	f	\N	\N	1	\N
1027	2026-06-05	-38.9828	EUR	28608.31	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.994602+00	2026-06-19 10:30:17.994602+00	\N	\N	\N	f	\N	\N	1	\N
1028	2026-06-09	-124.7852	EUR	28264.92	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.995267+00	2026-06-19 10:30:17.995267+00	\N	\N	\N	f	\N	\N	1	\N
1029	2026-06-08	-64.9342	EUR	28389.71	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-19 10:30:17.995969+00	2026-06-19 10:30:17.995969+00	\N	\N	\N	f	\N	\N	1	\N
1030	2026-06-03	-115.1156	EUR	27339.70	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-19 10:30:17.997018+00	2026-06-19 10:30:17.997018+00	\N	\N	\N	f	\N	\N	1	\N
1031	2026-06-06	-70.6739	EUR	28454.64	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-19 10:30:17.998875+00	2026-06-19 10:30:17.998875+00	\N	\N	\N	f	\N	\N	1	\N
1032	2026-06-04	-53.0481	EUR	27286.65	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-19 10:30:18.001036+00	2026-06-19 10:30:18.001036+00	\N	\N	\N	f	\N	\N	1	\N
1033	2026-06-13	-72.9380	EUR	27953.08	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-19 10:30:18.002348+00	2026-06-19 10:30:18.002348+00	\N	\N	\N	f	\N	\N	1	\N
1034	2026-06-16	-3.8595	EUR	28001.81	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:18.003204+00	2026-06-19 10:30:18.003204+00	\N	\N	\N	f	\N	\N	1	\N
1035	2026-06-11	-3.8970	EUR	28102.01	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:18.003912+00	2026-06-19 10:30:18.003912+00	\N	\N	\N	f	\N	\N	1	\N
1036	2026-06-10	-4.8338	EUR	28105.91	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-19 10:30:18.004664+00	2026-06-19 10:30:18.004664+00	\N	\N	\N	f	\N	\N	1	\N
1037	2026-06-09	-17.8744	EUR	28247.05	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-19 10:30:18.005393+00	2026-06-19 10:30:18.005393+00	\N	\N	\N	f	\N	\N	1	\N
1038	2026-06-01	-15.1727	EUR	29142.05	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-19 10:30:18.006105+00	2026-06-19 10:30:18.006105+00	\N	\N	\N	f	\N	\N	1	\N
1039	2026-06-14	-341.7421	EUR	27611.33	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-19 10:30:18.006863+00	2026-06-19 10:30:18.006863+00	\N	\N	\N	f	\N	\N	1	\N
1040	2026-06-04	-114.3723	EUR	27172.28	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-19 10:30:18.007714+00	2026-06-19 10:30:18.007714+00	\N	\N	\N	f	\N	\N	1	\N
1041	2026-06-01	-675.7711	EUR	28466.28	Reis / vakantie	\N	BE76 7340 1234 5678	47	\N	25	t	2026-06-19 10:30:18.009369+00	2026-06-19 10:30:18.009369+00	\N	\N	\N	f	\N	\N	1	\N
1042	2024-01-01	1975.0000	EUR	-203025.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.010745+00	2026-06-19 10:30:18.010745+00	\N	\N	\N	t	\N	manual	5	\N
1043	2024-04-01	1975.0000	EUR	-201050.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.011937+00	2026-06-19 10:30:18.011937+00	\N	\N	\N	t	\N	manual	5	\N
1044	2024-07-01	1975.0000	EUR	-199075.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.012991+00	2026-06-19 10:30:18.012991+00	\N	\N	\N	t	\N	manual	5	\N
1045	2024-10-01	1975.0000	EUR	-197100.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.013723+00	2026-06-19 10:30:18.013723+00	\N	\N	\N	t	\N	manual	5	\N
1046	2025-01-01	1975.0000	EUR	-195125.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.014419+00	2026-06-19 10:30:18.014419+00	\N	\N	\N	t	\N	manual	5	\N
1047	2025-04-01	1975.0000	EUR	-193150.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.015081+00	2026-06-19 10:30:18.015081+00	\N	\N	\N	t	\N	manual	5	\N
1048	2025-07-01	1975.0000	EUR	-191175.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.015766+00	2026-06-19 10:30:18.015766+00	\N	\N	\N	t	\N	manual	5	\N
1049	2025-10-01	1975.0000	EUR	-189200.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.016446+00	2026-06-19 10:30:18.016446+00	\N	\N	\N	t	\N	manual	5	\N
1050	2026-01-01	1975.0000	EUR	-187225.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.01713+00	2026-06-19 10:30:18.01713+00	\N	\N	\N	t	\N	manual	5	\N
1051	2026-04-01	1975.0000	EUR	-185250.00	Kapitaalaflossing hypotheek	\N	KBC Woonkrediet	53	\N	7	t	2026-06-19 10:30:18.017893+00	2026-06-19 10:30:18.017893+00	\N	\N	\N	t	\N	manual	5	\N
\.


ALTER TABLE public.transactions ENABLE TRIGGER ALL;

--
-- Data for Name: transaction_splits; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.transaction_splits DISABLE TRIGGER ALL;

COPY public.transaction_splits (id, transaction_id, recipient_id, amount, note, is_settled, created_at, updated_at) FROM stdin;
1	23	50	36.69	Gedeelde rekening met Thomas Peeters	t	2026-06-19 10:30:18.142382+00	2026-06-19 10:30:18.142382+00
2	192	51	39.71	Gedeelde rekening met Sarah Maes	f	2026-06-19 10:30:18.145362+00	2026-06-19 10:30:18.145362+00
3	298	52	27.52	Gedeelde rekening met Lukas De Smet	f	2026-06-19 10:30:18.146716+00	2026-06-19 10:30:18.146716+00
4	540	50	33.53	Gedeelde rekening met Thomas Peeters	t	2026-06-19 10:30:18.147419+00	2026-06-19 10:30:18.147419+00
5	653	51	132.42	Gedeelde rekening met Sarah Maes	f	2026-06-19 10:30:18.148599+00	2026-06-19 10:30:18.148599+00
6	821	52	37.38	Gedeelde rekening met Lukas De Smet	f	2026-06-19 10:30:18.149756+00	2026-06-19 10:30:18.149756+00
\.


ALTER TABLE public.transaction_splits ENABLE TRIGGER ALL;

--
-- Data for Name: agg_split_outstanding; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.agg_split_outstanding DISABLE TRIGGER ALL;

COPY public.agg_split_outstanding (split_id, recipient_id, original_amount, paid_amount, outstanding_amount, updated_at) FROM stdin;
1	50	36.69	36.69	0.00	2026-06-19 10:30:18.144566+00
2	51	39.71	19.86	19.85	2026-06-19 10:30:18.146133+00
3	52	27.52	0.00	27.52	2026-06-19 10:30:18.146716+00
4	50	33.53	33.53	0.00	2026-06-19 10:30:18.148083+00
5	51	132.42	66.21	66.21	2026-06-19 10:30:18.149231+00
6	52	37.38	0.00	37.38	2026-06-19 10:30:18.149756+00
\.


ALTER TABLE public.agg_split_outstanding ENABLE TRIGGER ALL;

--
-- Data for Name: ai_conversations; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.ai_conversations DISABLE TRIGGER ALL;

COPY public.ai_conversations (id, title, model, created_at, updated_at) FROM stdin;
\.


ALTER TABLE public.ai_conversations ENABLE TRIGGER ALL;

--
-- Data for Name: ai_messages; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.ai_messages DISABLE TRIGGER ALL;

COPY public.ai_messages (id, conversation_id, role, content, tool_name, tool_args, tool_result, status, created_at) FROM stdin;
\.


ALTER TABLE public.ai_messages ENABLE TRIGGER ALL;

--
-- Data for Name: alembic_version; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.alembic_version DISABLE TRIGGER ALL;

COPY public.alembic_version (version_num) FROM stdin;
0060_brokerage_import_routing
\.


ALTER TABLE public.alembic_version ENABLE TRIGGER ALL;

--
-- Data for Name: investments; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.investments DISABLE TRIGGER ALL;

COPY public.investments (id, name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, is_active, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, price_updated_at, created_at, updated_at) FROM stdin;
1	iShares Core MSCI World UCITS ETF	IWDA	etf	EUR	103.217482	\N	\N	\N	\N	\N	\N	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.380039+00	2026-06-19 10:30:18.380039+00
2	Vanguard FTSE All-World UCITS ETF	VWCE	etf	EUR	104.665924	\N	\N	\N	\N	\N	\N	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.456962+00	2026-06-19 10:30:18.456962+00
3	Apple Inc.	AAPL	stock	USD	197.160661	\N	\N	\N	\N	\N	\N	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.537281+00	2026-06-19 10:30:18.537281+00
4	ASML Holding NV	ASML	stock	EUR	554.977262	\N	\N	\N	\N	\N	\N	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.63001+00	2026-06-19 10:30:18.63001+00
5	Bitcoin	BTC	crypto	EUR	48274.360294	\N	\N	\N	\N	\N	\N	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.694437+00	2026-06-19 10:30:18.694437+00
6	Ethereum	ETH	crypto	EUR	6088.962184	\N	\N	\N	\N	\N	\N	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.762476+00	2026-06-19 10:30:18.762476+00
7	Physical Gold (XAU)	XAU	metals	EUR	1801.771090	\N	\N	\N	\N	\N	\N	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.832802+00	2026-06-19 10:30:18.832802+00
8	KBC Termijnrekening	\N	savings	EUR	15250.000000	2.5000	\N	\N	\N	\N	\N	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.905441+00	2026-06-19 10:30:18.905441+00
9	Belgische Staatsbon 2027	\N	bond	EUR	5000.000000	2.8500	2027-09-04	\N	\N	\N	\N	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.907508+00	2026-06-19 10:30:18.907508+00
10	Appartement Gent	\N	real_estate	EUR	325000.000000	\N	\N	Korenmarkt, Gent	Gent	1450.00	7.5000	\N	t	manual	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-06-19 10:30:18.909254+00	2026-06-19 10:30:18.909254+00
\.


ALTER TABLE public.investments ENABLE TRIGGER ALL;

--
-- Data for Name: asset_price_history; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.asset_price_history DISABLE TRIGGER ALL;

COPY public.asset_price_history (id, investment_id, price_date, close_price, source, fetched_at, updated_at) FROM stdin;
1	1	2024-01-01	71.252899	manual	2026-06-19 10:30:18.38085+00	2026-06-19 10:30:18.38085+00
2	1	2024-01-08	72.249798	manual	2026-06-19 10:30:18.381843+00	2026-06-19 10:30:18.381843+00
3	1	2024-01-15	71.145072	manual	2026-06-19 10:30:18.382291+00	2026-06-19 10:30:18.382291+00
4	1	2024-01-22	70.234886	manual	2026-06-19 10:30:18.382722+00	2026-06-19 10:30:18.382722+00
5	1	2024-01-29	70.351336	manual	2026-06-19 10:30:18.3833+00	2026-06-19 10:30:18.3833+00
6	1	2024-02-05	71.442103	manual	2026-06-19 10:30:18.383814+00	2026-06-19 10:30:18.383814+00
7	1	2024-02-12	71.913414	manual	2026-06-19 10:30:18.384344+00	2026-06-19 10:30:18.384344+00
8	1	2024-02-19	72.221122	manual	2026-06-19 10:30:18.384759+00	2026-06-19 10:30:18.384759+00
9	1	2024-02-26	73.187559	manual	2026-06-19 10:30:18.385188+00	2026-06-19 10:30:18.385188+00
10	1	2024-03-04	72.490240	manual	2026-06-19 10:30:18.38562+00	2026-06-19 10:30:18.38562+00
11	1	2024-03-11	72.382433	manual	2026-06-19 10:30:18.386053+00	2026-06-19 10:30:18.386053+00
12	1	2024-03-18	72.256851	manual	2026-06-19 10:30:18.386481+00	2026-06-19 10:30:18.386481+00
13	1	2024-03-25	72.564274	manual	2026-06-19 10:30:18.386903+00	2026-06-19 10:30:18.386903+00
14	1	2024-04-01	72.163848	manual	2026-06-19 10:30:18.387342+00	2026-06-19 10:30:18.387342+00
15	1	2024-04-08	72.085381	manual	2026-06-19 10:30:18.387765+00	2026-06-19 10:30:18.387765+00
16	1	2024-04-15	72.542167	manual	2026-06-19 10:30:18.388186+00	2026-06-19 10:30:18.388186+00
17	1	2024-04-22	72.893955	manual	2026-06-19 10:30:18.388607+00	2026-06-19 10:30:18.388607+00
18	1	2024-04-29	73.362717	manual	2026-06-19 10:30:18.389024+00	2026-06-19 10:30:18.389024+00
19	1	2024-05-06	73.544992	manual	2026-06-19 10:30:18.389445+00	2026-06-19 10:30:18.389445+00
20	1	2024-05-13	73.609761	manual	2026-06-19 10:30:18.389863+00	2026-06-19 10:30:18.389863+00
21	1	2024-05-20	72.729713	manual	2026-06-19 10:30:18.390269+00	2026-06-19 10:30:18.390269+00
22	1	2024-05-27	73.854531	manual	2026-06-19 10:30:18.390718+00	2026-06-19 10:30:18.390718+00
23	1	2024-06-03	74.350777	manual	2026-06-19 10:30:18.391176+00	2026-06-19 10:30:18.391176+00
24	1	2024-06-10	75.187676	manual	2026-06-19 10:30:18.392305+00	2026-06-19 10:30:18.392305+00
25	1	2024-06-17	75.213624	manual	2026-06-19 10:30:18.392771+00	2026-06-19 10:30:18.392771+00
26	1	2024-06-24	75.759129	manual	2026-06-19 10:30:18.393203+00	2026-06-19 10:30:18.393203+00
27	1	2024-07-01	75.870909	manual	2026-06-19 10:30:18.393637+00	2026-06-19 10:30:18.393637+00
28	1	2024-07-08	76.875870	manual	2026-06-19 10:30:18.394075+00	2026-06-19 10:30:18.394075+00
29	1	2024-07-15	78.226405	manual	2026-06-19 10:30:18.394516+00	2026-06-19 10:30:18.394516+00
30	1	2024-07-22	77.007983	manual	2026-06-19 10:30:18.394954+00	2026-06-19 10:30:18.394954+00
31	1	2024-07-29	77.000982	manual	2026-06-19 10:30:18.395408+00	2026-06-19 10:30:18.395408+00
32	1	2024-08-05	76.746260	manual	2026-06-19 10:30:18.395837+00	2026-06-19 10:30:18.395837+00
33	1	2024-08-12	77.328793	manual	2026-06-19 10:30:18.396246+00	2026-06-19 10:30:18.396246+00
34	1	2024-08-19	76.107844	manual	2026-06-19 10:30:18.396668+00	2026-06-19 10:30:18.396668+00
35	1	2024-08-26	75.683272	manual	2026-06-19 10:30:18.397096+00	2026-06-19 10:30:18.397096+00
36	1	2024-09-02	76.533025	manual	2026-06-19 10:30:18.397516+00	2026-06-19 10:30:18.397516+00
37	1	2024-09-09	77.584700	manual	2026-06-19 10:30:18.397938+00	2026-06-19 10:30:18.397938+00
38	1	2024-09-16	77.348197	manual	2026-06-19 10:30:18.398364+00	2026-06-19 10:30:18.398364+00
39	1	2024-09-23	77.601341	manual	2026-06-19 10:30:18.398772+00	2026-06-19 10:30:18.398772+00
40	1	2024-09-30	77.313663	manual	2026-06-19 10:30:18.399194+00	2026-06-19 10:30:18.399194+00
41	1	2024-10-07	77.741108	manual	2026-06-19 10:30:18.399638+00	2026-06-19 10:30:18.399638+00
42	1	2024-10-14	76.635230	manual	2026-06-19 10:30:18.400269+00	2026-06-19 10:30:18.400269+00
43	1	2024-10-21	78.081614	manual	2026-06-19 10:30:18.400718+00	2026-06-19 10:30:18.400718+00
44	1	2024-10-28	78.203082	manual	2026-06-19 10:30:18.401287+00	2026-06-19 10:30:18.401287+00
45	1	2024-11-04	79.260638	manual	2026-06-19 10:30:18.401761+00	2026-06-19 10:30:18.401761+00
46	1	2024-11-11	78.511741	manual	2026-06-19 10:30:18.402183+00	2026-06-19 10:30:18.402183+00
47	1	2024-11-18	77.293640	manual	2026-06-19 10:30:18.402618+00	2026-06-19 10:30:18.402618+00
48	1	2024-11-25	77.818851	manual	2026-06-19 10:30:18.403067+00	2026-06-19 10:30:18.403067+00
49	1	2024-12-02	78.642784	manual	2026-06-19 10:30:18.403543+00	2026-06-19 10:30:18.403543+00
50	1	2024-12-09	78.197145	manual	2026-06-19 10:30:18.403975+00	2026-06-19 10:30:18.403975+00
51	1	2024-12-16	79.340618	manual	2026-06-19 10:30:18.40441+00	2026-06-19 10:30:18.40441+00
52	1	2024-12-23	79.662665	manual	2026-06-19 10:30:18.404826+00	2026-06-19 10:30:18.404826+00
53	1	2024-12-30	80.430825	manual	2026-06-19 10:30:18.405242+00	2026-06-19 10:30:18.405242+00
54	1	2025-01-06	80.069987	manual	2026-06-19 10:30:18.405668+00	2026-06-19 10:30:18.405668+00
55	1	2025-01-13	80.171882	manual	2026-06-19 10:30:18.406093+00	2026-06-19 10:30:18.406093+00
56	1	2025-01-20	79.607130	manual	2026-06-19 10:30:18.406523+00	2026-06-19 10:30:18.406523+00
57	1	2025-01-27	80.759528	manual	2026-06-19 10:30:18.406934+00	2026-06-19 10:30:18.406934+00
58	1	2025-02-03	80.761674	manual	2026-06-19 10:30:18.407406+00	2026-06-19 10:30:18.407406+00
59	1	2025-02-10	81.427354	manual	2026-06-19 10:30:18.407829+00	2026-06-19 10:30:18.407829+00
60	1	2025-02-17	81.489697	manual	2026-06-19 10:30:18.408256+00	2026-06-19 10:30:18.408256+00
61	1	2025-02-24	80.937944	manual	2026-06-19 10:30:18.408685+00	2026-06-19 10:30:18.408685+00
62	1	2025-03-03	81.182576	manual	2026-06-19 10:30:18.409111+00	2026-06-19 10:30:18.409111+00
63	1	2025-03-10	80.079827	manual	2026-06-19 10:30:18.409542+00	2026-06-19 10:30:18.409542+00
64	1	2025-03-17	80.516277	manual	2026-06-19 10:30:18.40994+00	2026-06-19 10:30:18.40994+00
65	1	2025-03-24	79.719202	manual	2026-06-19 10:30:18.41037+00	2026-06-19 10:30:18.41037+00
66	1	2025-03-31	78.866700	manual	2026-06-19 10:30:18.410815+00	2026-06-19 10:30:18.410815+00
67	1	2025-04-07	79.669102	manual	2026-06-19 10:30:18.411243+00	2026-06-19 10:30:18.411243+00
68	1	2025-04-14	80.956476	manual	2026-06-19 10:30:18.411685+00	2026-06-19 10:30:18.411685+00
69	1	2025-04-21	79.833404	manual	2026-06-19 10:30:18.412137+00	2026-06-19 10:30:18.412137+00
70	1	2025-04-28	80.139621	manual	2026-06-19 10:30:18.412556+00	2026-06-19 10:30:18.412556+00
71	1	2025-05-05	79.318435	manual	2026-06-19 10:30:18.412962+00	2026-06-19 10:30:18.412962+00
72	1	2025-05-12	80.471421	manual	2026-06-19 10:30:18.413386+00	2026-06-19 10:30:18.413386+00
73	1	2025-05-19	81.911172	manual	2026-06-19 10:30:18.413811+00	2026-06-19 10:30:18.413811+00
74	1	2025-05-26	82.852977	manual	2026-06-19 10:30:18.414223+00	2026-06-19 10:30:18.414223+00
75	1	2025-06-02	83.906920	manual	2026-06-19 10:30:18.414647+00	2026-06-19 10:30:18.414647+00
76	1	2025-06-09	83.267625	manual	2026-06-19 10:30:18.415058+00	2026-06-19 10:30:18.415058+00
77	1	2025-06-16	83.488898	manual	2026-06-19 10:30:18.4155+00	2026-06-19 10:30:18.4155+00
78	1	2025-06-23	84.379861	manual	2026-06-19 10:30:18.415933+00	2026-06-19 10:30:18.415933+00
79	1	2025-06-30	84.806867	manual	2026-06-19 10:30:18.416366+00	2026-06-19 10:30:18.416366+00
80	1	2025-07-07	86.394201	manual	2026-06-19 10:30:18.416826+00	2026-06-19 10:30:18.416826+00
81	1	2025-07-14	85.599237	manual	2026-06-19 10:30:18.41755+00	2026-06-19 10:30:18.41755+00
82	1	2025-07-21	85.191753	manual	2026-06-19 10:30:18.418036+00	2026-06-19 10:30:18.418036+00
83	1	2025-07-28	85.900154	manual	2026-06-19 10:30:18.418447+00	2026-06-19 10:30:18.418447+00
84	1	2025-08-04	84.661236	manual	2026-06-19 10:30:18.41888+00	2026-06-19 10:30:18.41888+00
85	1	2025-08-11	86.237075	manual	2026-06-19 10:30:18.419338+00	2026-06-19 10:30:18.419338+00
86	1	2025-08-18	87.225788	manual	2026-06-19 10:30:18.419833+00	2026-06-19 10:30:18.419833+00
87	1	2025-08-25	86.025574	manual	2026-06-19 10:30:18.420306+00	2026-06-19 10:30:18.420306+00
88	1	2025-09-01	86.308034	manual	2026-06-19 10:30:18.420748+00	2026-06-19 10:30:18.420748+00
89	1	2025-09-08	85.618020	manual	2026-06-19 10:30:18.421177+00	2026-06-19 10:30:18.421177+00
90	1	2025-09-15	84.280339	manual	2026-06-19 10:30:18.421607+00	2026-06-19 10:30:18.421607+00
91	1	2025-09-22	85.605076	manual	2026-06-19 10:30:18.422027+00	2026-06-19 10:30:18.422027+00
92	1	2025-09-29	86.211025	manual	2026-06-19 10:30:18.422433+00	2026-06-19 10:30:18.422433+00
93	1	2025-10-06	86.287641	manual	2026-06-19 10:30:18.422834+00	2026-06-19 10:30:18.422834+00
94	1	2025-10-13	86.135481	manual	2026-06-19 10:30:18.423293+00	2026-06-19 10:30:18.423293+00
95	1	2025-10-20	87.506732	manual	2026-06-19 10:30:18.423687+00	2026-06-19 10:30:18.423687+00
96	1	2025-10-27	87.221921	manual	2026-06-19 10:30:18.424094+00	2026-06-19 10:30:18.424094+00
97	1	2025-11-03	87.417990	manual	2026-06-19 10:30:18.424522+00	2026-06-19 10:30:18.424522+00
98	1	2025-11-10	87.505487	manual	2026-06-19 10:30:18.424946+00	2026-06-19 10:30:18.424946+00
99	1	2025-11-17	86.808188	manual	2026-06-19 10:30:18.425492+00	2026-06-19 10:30:18.425492+00
100	1	2025-11-24	87.372372	manual	2026-06-19 10:30:18.426194+00	2026-06-19 10:30:18.426194+00
101	1	2025-12-01	87.632460	manual	2026-06-19 10:30:18.426661+00	2026-06-19 10:30:18.426661+00
102	1	2025-12-08	89.075361	manual	2026-06-19 10:30:18.427139+00	2026-06-19 10:30:18.427139+00
103	1	2025-12-15	90.445105	manual	2026-06-19 10:30:18.42829+00	2026-06-19 10:30:18.42829+00
104	1	2025-12-22	89.068662	manual	2026-06-19 10:30:18.428791+00	2026-06-19 10:30:18.428791+00
105	1	2025-12-29	87.777197	manual	2026-06-19 10:30:18.429277+00	2026-06-19 10:30:18.429277+00
106	1	2026-01-05	88.921006	manual	2026-06-19 10:30:18.429735+00	2026-06-19 10:30:18.429735+00
107	1	2026-01-12	89.579352	manual	2026-06-19 10:30:18.430169+00	2026-06-19 10:30:18.430169+00
108	1	2026-01-19	89.948686	manual	2026-06-19 10:30:18.430607+00	2026-06-19 10:30:18.430607+00
109	1	2026-01-26	91.511828	manual	2026-06-19 10:30:18.431221+00	2026-06-19 10:30:18.431221+00
110	1	2026-02-02	90.333680	manual	2026-06-19 10:30:18.431698+00	2026-06-19 10:30:18.431698+00
111	1	2026-02-09	90.358229	manual	2026-06-19 10:30:18.432121+00	2026-06-19 10:30:18.432121+00
112	1	2026-02-16	90.957617	manual	2026-06-19 10:30:18.432563+00	2026-06-19 10:30:18.432563+00
113	1	2026-02-23	90.658831	manual	2026-06-19 10:30:18.433015+00	2026-06-19 10:30:18.433015+00
114	1	2026-03-02	91.393337	manual	2026-06-19 10:30:18.43372+00	2026-06-19 10:30:18.43372+00
115	1	2026-03-09	92.760165	manual	2026-06-19 10:30:18.434173+00	2026-06-19 10:30:18.434173+00
116	1	2026-03-16	94.130679	manual	2026-06-19 10:30:18.434701+00	2026-06-19 10:30:18.434701+00
117	1	2026-03-23	95.247468	manual	2026-06-19 10:30:18.435178+00	2026-06-19 10:30:18.435178+00
118	1	2026-03-30	96.613393	manual	2026-06-19 10:30:18.435636+00	2026-06-19 10:30:18.435636+00
119	1	2026-04-06	97.643460	manual	2026-06-19 10:30:18.436091+00	2026-06-19 10:30:18.436091+00
120	1	2026-04-13	97.752738	manual	2026-06-19 10:30:18.436541+00	2026-06-19 10:30:18.436541+00
121	1	2026-04-20	99.032002	manual	2026-06-19 10:30:18.436992+00	2026-06-19 10:30:18.436992+00
122	1	2026-04-27	97.616212	manual	2026-06-19 10:30:18.437451+00	2026-06-19 10:30:18.437451+00
123	1	2026-05-04	98.614368	manual	2026-06-19 10:30:18.437912+00	2026-06-19 10:30:18.437912+00
124	1	2026-05-11	98.718080	manual	2026-06-19 10:30:18.438378+00	2026-06-19 10:30:18.438378+00
125	1	2026-05-18	99.891532	manual	2026-06-19 10:30:18.43884+00	2026-06-19 10:30:18.43884+00
126	1	2026-05-25	101.158178	manual	2026-06-19 10:30:18.439311+00	2026-06-19 10:30:18.439311+00
127	1	2026-06-01	100.262096	manual	2026-06-19 10:30:18.439766+00	2026-06-19 10:30:18.439766+00
128	1	2026-06-08	101.516916	manual	2026-06-19 10:30:18.440218+00	2026-06-19 10:30:18.440218+00
129	1	2026-06-15	103.217482	manual	2026-06-19 10:30:18.440686+00	2026-06-19 10:30:18.440686+00
130	2	2024-01-01	93.706676	manual	2026-06-19 10:30:18.457444+00	2026-06-19 10:30:18.457444+00
131	2	2024-01-08	92.461700	manual	2026-06-19 10:30:18.457927+00	2026-06-19 10:30:18.457927+00
132	2	2024-01-15	91.313156	manual	2026-06-19 10:30:18.458392+00	2026-06-19 10:30:18.458392+00
133	2	2024-01-22	92.016983	manual	2026-06-19 10:30:18.458873+00	2026-06-19 10:30:18.458873+00
134	2	2024-01-29	91.396677	manual	2026-06-19 10:30:18.459318+00	2026-06-19 10:30:18.459318+00
135	2	2024-02-05	92.286193	manual	2026-06-19 10:30:18.459766+00	2026-06-19 10:30:18.459766+00
136	2	2024-02-12	92.206873	manual	2026-06-19 10:30:18.460244+00	2026-06-19 10:30:18.460244+00
137	2	2024-02-19	90.756890	manual	2026-06-19 10:30:18.460717+00	2026-06-19 10:30:18.460717+00
138	2	2024-02-26	91.226377	manual	2026-06-19 10:30:18.461212+00	2026-06-19 10:30:18.461212+00
139	2	2024-03-04	89.821797	manual	2026-06-19 10:30:18.461668+00	2026-06-19 10:30:18.461668+00
140	2	2024-03-11	89.089420	manual	2026-06-19 10:30:18.462158+00	2026-06-19 10:30:18.462158+00
141	2	2024-03-18	88.986201	manual	2026-06-19 10:30:18.4626+00	2026-06-19 10:30:18.4626+00
142	2	2024-03-25	87.581209	manual	2026-06-19 10:30:18.463059+00	2026-06-19 10:30:18.463059+00
143	2	2024-04-01	87.904055	manual	2026-06-19 10:30:18.463559+00	2026-06-19 10:30:18.463559+00
144	2	2024-04-08	87.824307	manual	2026-06-19 10:30:18.464026+00	2026-06-19 10:30:18.464026+00
145	2	2024-04-15	88.466995	manual	2026-06-19 10:30:18.464485+00	2026-06-19 10:30:18.464485+00
146	2	2024-04-22	89.016722	manual	2026-06-19 10:30:18.464925+00	2026-06-19 10:30:18.464925+00
147	2	2024-04-29	89.561846	manual	2026-06-19 10:30:18.4654+00	2026-06-19 10:30:18.4654+00
148	2	2024-05-06	90.727844	manual	2026-06-19 10:30:18.465857+00	2026-06-19 10:30:18.465857+00
149	2	2024-05-13	89.291110	manual	2026-06-19 10:30:18.466358+00	2026-06-19 10:30:18.466358+00
150	2	2024-05-20	90.877803	manual	2026-06-19 10:30:18.466914+00	2026-06-19 10:30:18.466914+00
151	2	2024-05-27	91.903227	manual	2026-06-19 10:30:18.467387+00	2026-06-19 10:30:18.467387+00
152	2	2024-06-03	91.654156	manual	2026-06-19 10:30:18.468045+00	2026-06-19 10:30:18.468045+00
153	2	2024-06-10	91.914611	manual	2026-06-19 10:30:18.468497+00	2026-06-19 10:30:18.468497+00
154	2	2024-06-17	93.099766	manual	2026-06-19 10:30:18.468997+00	2026-06-19 10:30:18.468997+00
155	2	2024-06-24	91.843007	manual	2026-06-19 10:30:18.46948+00	2026-06-19 10:30:18.46948+00
156	2	2024-07-01	92.194179	manual	2026-06-19 10:30:18.469929+00	2026-06-19 10:30:18.469929+00
157	2	2024-07-08	90.904557	manual	2026-06-19 10:30:18.470386+00	2026-06-19 10:30:18.470386+00
158	2	2024-07-15	89.575863	manual	2026-06-19 10:30:18.470859+00	2026-06-19 10:30:18.470859+00
159	2	2024-07-22	88.695154	manual	2026-06-19 10:30:18.471354+00	2026-06-19 10:30:18.471354+00
160	2	2024-07-29	89.380875	manual	2026-06-19 10:30:18.471823+00	2026-06-19 10:30:18.471823+00
161	2	2024-08-05	89.514089	manual	2026-06-19 10:30:18.472285+00	2026-06-19 10:30:18.472285+00
162	2	2024-08-12	90.465004	manual	2026-06-19 10:30:18.47274+00	2026-06-19 10:30:18.47274+00
163	2	2024-08-19	90.996905	manual	2026-06-19 10:30:18.473187+00	2026-06-19 10:30:18.473187+00
164	2	2024-08-26	91.286094	manual	2026-06-19 10:30:18.473621+00	2026-06-19 10:30:18.473621+00
165	2	2024-09-02	90.775226	manual	2026-06-19 10:30:18.474054+00	2026-06-19 10:30:18.474054+00
166	2	2024-09-09	91.489262	manual	2026-06-19 10:30:18.474522+00	2026-06-19 10:30:18.474522+00
167	2	2024-09-16	93.103065	manual	2026-06-19 10:30:18.47497+00	2026-06-19 10:30:18.47497+00
168	2	2024-09-23	91.958986	manual	2026-06-19 10:30:18.475419+00	2026-06-19 10:30:18.475419+00
169	2	2024-09-30	92.730308	manual	2026-06-19 10:30:18.475895+00	2026-06-19 10:30:18.475895+00
170	2	2024-10-07	93.140134	manual	2026-06-19 10:30:18.476407+00	2026-06-19 10:30:18.476407+00
171	2	2024-10-14	93.576669	manual	2026-06-19 10:30:18.476903+00	2026-06-19 10:30:18.476903+00
172	2	2024-10-21	94.649946	manual	2026-06-19 10:30:18.477449+00	2026-06-19 10:30:18.477449+00
173	2	2024-10-28	93.484509	manual	2026-06-19 10:30:18.477913+00	2026-06-19 10:30:18.477913+00
174	2	2024-11-04	94.025236	manual	2026-06-19 10:30:18.478391+00	2026-06-19 10:30:18.478391+00
175	2	2024-11-11	95.132848	manual	2026-06-19 10:30:18.478839+00	2026-06-19 10:30:18.478839+00
176	2	2024-11-18	93.677685	manual	2026-06-19 10:30:18.479305+00	2026-06-19 10:30:18.479305+00
177	2	2024-11-25	93.210639	manual	2026-06-19 10:30:18.479758+00	2026-06-19 10:30:18.479758+00
178	2	2024-12-02	92.811738	manual	2026-06-19 10:30:18.480196+00	2026-06-19 10:30:18.480196+00
179	2	2024-12-09	91.444321	manual	2026-06-19 10:30:18.480628+00	2026-06-19 10:30:18.480628+00
180	2	2024-12-16	90.231784	manual	2026-06-19 10:30:18.481068+00	2026-06-19 10:30:18.481068+00
181	2	2024-12-23	90.148675	manual	2026-06-19 10:30:18.481519+00	2026-06-19 10:30:18.481519+00
182	2	2024-12-30	90.894675	manual	2026-06-19 10:30:18.481984+00	2026-06-19 10:30:18.481984+00
183	2	2025-01-06	91.852165	manual	2026-06-19 10:30:18.48244+00	2026-06-19 10:30:18.48244+00
184	2	2025-01-13	92.484533	manual	2026-06-19 10:30:18.48289+00	2026-06-19 10:30:18.48289+00
185	2	2025-01-20	91.303033	manual	2026-06-19 10:30:18.483329+00	2026-06-19 10:30:18.483329+00
186	2	2025-01-27	91.796464	manual	2026-06-19 10:30:18.483775+00	2026-06-19 10:30:18.483775+00
187	2	2025-02-03	92.740314	manual	2026-06-19 10:30:18.484651+00	2026-06-19 10:30:18.484651+00
188	2	2025-02-10	91.844660	manual	2026-06-19 10:30:18.48511+00	2026-06-19 10:30:18.48511+00
189	2	2025-02-17	91.730903	manual	2026-06-19 10:30:18.485549+00	2026-06-19 10:30:18.485549+00
190	2	2025-02-24	93.050094	manual	2026-06-19 10:30:18.486061+00	2026-06-19 10:30:18.486061+00
191	2	2025-03-03	93.199437	manual	2026-06-19 10:30:18.486526+00	2026-06-19 10:30:18.486526+00
192	2	2025-03-10	94.649604	manual	2026-06-19 10:30:18.486977+00	2026-06-19 10:30:18.486977+00
193	2	2025-03-17	95.318440	manual	2026-06-19 10:30:18.487455+00	2026-06-19 10:30:18.487455+00
194	2	2025-03-24	93.804631	manual	2026-06-19 10:30:18.487975+00	2026-06-19 10:30:18.487975+00
195	2	2025-03-31	94.569806	manual	2026-06-19 10:30:18.488441+00	2026-06-19 10:30:18.488441+00
196	2	2025-04-07	93.820626	manual	2026-06-19 10:30:18.488879+00	2026-06-19 10:30:18.488879+00
197	2	2025-04-14	94.567124	manual	2026-06-19 10:30:18.489309+00	2026-06-19 10:30:18.489309+00
198	2	2025-04-21	95.885029	manual	2026-06-19 10:30:18.489767+00	2026-06-19 10:30:18.489767+00
199	2	2025-04-28	94.730389	manual	2026-06-19 10:30:18.490287+00	2026-06-19 10:30:18.490287+00
200	2	2025-05-05	93.423953	manual	2026-06-19 10:30:18.490745+00	2026-06-19 10:30:18.490745+00
201	2	2025-05-12	93.324689	manual	2026-06-19 10:30:18.491239+00	2026-06-19 10:30:18.491239+00
202	2	2025-05-19	94.714131	manual	2026-06-19 10:30:18.491699+00	2026-06-19 10:30:18.491699+00
203	2	2025-05-26	95.542138	manual	2026-06-19 10:30:18.492191+00	2026-06-19 10:30:18.492191+00
204	2	2025-06-02	97.245514	manual	2026-06-19 10:30:18.492698+00	2026-06-19 10:30:18.492698+00
205	2	2025-06-09	96.370910	manual	2026-06-19 10:30:18.494413+00	2026-06-19 10:30:18.494413+00
206	2	2025-06-16	97.614862	manual	2026-06-19 10:30:18.494944+00	2026-06-19 10:30:18.494944+00
207	2	2025-06-23	96.205891	manual	2026-06-19 10:30:18.495409+00	2026-06-19 10:30:18.495409+00
208	2	2025-06-30	97.806117	manual	2026-06-19 10:30:18.495879+00	2026-06-19 10:30:18.495879+00
209	2	2025-07-07	96.577997	manual	2026-06-19 10:30:18.49633+00	2026-06-19 10:30:18.49633+00
210	2	2025-07-14	96.604939	manual	2026-06-19 10:30:18.496772+00	2026-06-19 10:30:18.496772+00
211	2	2025-07-21	97.885702	manual	2026-06-19 10:30:18.497228+00	2026-06-19 10:30:18.497228+00
212	2	2025-07-28	97.764998	manual	2026-06-19 10:30:18.497677+00	2026-06-19 10:30:18.497677+00
213	2	2025-08-04	97.409859	manual	2026-06-19 10:30:18.498138+00	2026-06-19 10:30:18.498138+00
214	2	2025-08-11	97.928860	manual	2026-06-19 10:30:18.498603+00	2026-06-19 10:30:18.498603+00
215	2	2025-08-18	99.632474	manual	2026-06-19 10:30:18.499062+00	2026-06-19 10:30:18.499062+00
216	2	2025-08-25	98.148987	manual	2026-06-19 10:30:18.499528+00	2026-06-19 10:30:18.499528+00
217	2	2025-09-01	99.190046	manual	2026-06-19 10:30:18.499994+00	2026-06-19 10:30:18.499994+00
218	2	2025-09-08	99.547648	manual	2026-06-19 10:30:18.500428+00	2026-06-19 10:30:18.500428+00
219	2	2025-09-15	99.411039	manual	2026-06-19 10:30:18.500924+00	2026-06-19 10:30:18.500924+00
220	2	2025-09-22	100.505308	manual	2026-06-19 10:30:18.501511+00	2026-06-19 10:30:18.501511+00
221	2	2025-09-29	101.155182	manual	2026-06-19 10:30:18.502006+00	2026-06-19 10:30:18.502006+00
222	2	2025-10-06	101.400776	manual	2026-06-19 10:30:18.502469+00	2026-06-19 10:30:18.502469+00
223	2	2025-10-13	100.975535	manual	2026-06-19 10:30:18.502904+00	2026-06-19 10:30:18.502904+00
224	2	2025-10-20	100.626888	manual	2026-06-19 10:30:18.503414+00	2026-06-19 10:30:18.503414+00
225	2	2025-10-27	99.867170	manual	2026-06-19 10:30:18.503871+00	2026-06-19 10:30:18.503871+00
226	2	2025-11-03	98.573541	manual	2026-06-19 10:30:18.50434+00	2026-06-19 10:30:18.50434+00
227	2	2025-11-10	98.453051	manual	2026-06-19 10:30:18.504791+00	2026-06-19 10:30:18.504791+00
228	2	2025-11-17	97.361546	manual	2026-06-19 10:30:18.505246+00	2026-06-19 10:30:18.505246+00
229	2	2025-11-24	96.574588	manual	2026-06-19 10:30:18.505682+00	2026-06-19 10:30:18.505682+00
230	2	2025-12-01	97.391800	manual	2026-06-19 10:30:18.506159+00	2026-06-19 10:30:18.506159+00
231	2	2025-12-08	98.744020	manual	2026-06-19 10:30:18.506606+00	2026-06-19 10:30:18.506606+00
232	2	2025-12-15	97.798646	manual	2026-06-19 10:30:18.507043+00	2026-06-19 10:30:18.507043+00
233	2	2025-12-22	98.320280	manual	2026-06-19 10:30:18.507529+00	2026-06-19 10:30:18.507529+00
234	2	2025-12-29	99.725936	manual	2026-06-19 10:30:18.507962+00	2026-06-19 10:30:18.507962+00
235	2	2026-01-05	99.361085	manual	2026-06-19 10:30:18.508418+00	2026-06-19 10:30:18.508418+00
236	2	2026-01-12	101.056257	manual	2026-06-19 10:30:18.509059+00	2026-06-19 10:30:18.509059+00
237	2	2026-01-19	102.353144	manual	2026-06-19 10:30:18.509536+00	2026-06-19 10:30:18.509536+00
238	2	2026-01-26	103.964845	manual	2026-06-19 10:30:18.510043+00	2026-06-19 10:30:18.510043+00
239	2	2026-02-02	104.429434	manual	2026-06-19 10:30:18.510506+00	2026-06-19 10:30:18.510506+00
240	2	2026-02-09	105.957952	manual	2026-06-19 10:30:18.51099+00	2026-06-19 10:30:18.51099+00
241	2	2026-02-16	106.446019	manual	2026-06-19 10:30:18.511463+00	2026-06-19 10:30:18.511463+00
242	2	2026-02-23	105.502645	manual	2026-06-19 10:30:18.511931+00	2026-06-19 10:30:18.511931+00
243	2	2026-03-02	105.274151	manual	2026-06-19 10:30:18.512393+00	2026-06-19 10:30:18.512393+00
244	2	2026-03-09	106.669526	manual	2026-06-19 10:30:18.512861+00	2026-06-19 10:30:18.512861+00
245	2	2026-03-16	106.529148	manual	2026-06-19 10:30:18.513326+00	2026-06-19 10:30:18.513326+00
246	2	2026-03-23	105.965222	manual	2026-06-19 10:30:18.513862+00	2026-06-19 10:30:18.513862+00
247	2	2026-03-30	107.426991	manual	2026-06-19 10:30:18.514301+00	2026-06-19 10:30:18.514301+00
248	2	2026-04-06	108.204511	manual	2026-06-19 10:30:18.514769+00	2026-06-19 10:30:18.514769+00
249	2	2026-04-13	106.865307	manual	2026-06-19 10:30:18.515219+00	2026-06-19 10:30:18.515219+00
250	2	2026-04-20	108.078624	manual	2026-06-19 10:30:18.51566+00	2026-06-19 10:30:18.51566+00
251	2	2026-04-27	106.651657	manual	2026-06-19 10:30:18.516135+00	2026-06-19 10:30:18.516135+00
252	2	2026-05-04	108.337717	manual	2026-06-19 10:30:18.516587+00	2026-06-19 10:30:18.516587+00
253	2	2026-05-11	107.958945	manual	2026-06-19 10:30:18.517031+00	2026-06-19 10:30:18.517031+00
254	2	2026-05-18	107.633924	manual	2026-06-19 10:30:18.517491+00	2026-06-19 10:30:18.517491+00
255	2	2026-05-25	106.034184	manual	2026-06-19 10:30:18.519621+00	2026-06-19 10:30:18.519621+00
256	2	2026-06-01	104.531249	manual	2026-06-19 10:30:18.520051+00	2026-06-19 10:30:18.520051+00
257	2	2026-06-08	105.109425	manual	2026-06-19 10:30:18.520523+00	2026-06-19 10:30:18.520523+00
258	2	2026-06-15	104.665924	manual	2026-06-19 10:30:18.52103+00	2026-06-19 10:30:18.52103+00
259	3	2024-01-01	166.041866	manual	2026-06-19 10:30:18.537743+00	2026-06-19 10:30:18.537743+00
260	3	2024-01-08	164.057918	manual	2026-06-19 10:30:18.538195+00	2026-06-19 10:30:18.538195+00
261	3	2024-01-15	160.832665	manual	2026-06-19 10:30:18.538648+00	2026-06-19 10:30:18.538648+00
262	3	2024-01-22	162.838033	manual	2026-06-19 10:30:18.53911+00	2026-06-19 10:30:18.53911+00
263	3	2024-01-29	163.367360	manual	2026-06-19 10:30:18.53956+00	2026-06-19 10:30:18.53956+00
264	3	2024-02-05	161.566411	manual	2026-06-19 10:30:18.540017+00	2026-06-19 10:30:18.540017+00
265	3	2024-02-12	164.720442	manual	2026-06-19 10:30:18.540473+00	2026-06-19 10:30:18.540473+00
266	3	2024-02-19	166.730899	manual	2026-06-19 10:30:18.540916+00	2026-06-19 10:30:18.540916+00
267	3	2024-02-26	168.909016	manual	2026-06-19 10:30:18.541398+00	2026-06-19 10:30:18.541398+00
268	3	2024-03-04	167.209766	manual	2026-06-19 10:30:18.541845+00	2026-06-19 10:30:18.541845+00
269	3	2024-03-11	168.854421	manual	2026-06-19 10:30:18.543437+00	2026-06-19 10:30:18.543437+00
270	3	2024-03-18	165.575312	manual	2026-06-19 10:30:18.543918+00	2026-06-19 10:30:18.543918+00
271	3	2024-03-25	165.425064	manual	2026-06-19 10:30:18.544389+00	2026-06-19 10:30:18.544389+00
272	3	2024-04-01	168.910773	manual	2026-06-19 10:30:18.54488+00	2026-06-19 10:30:18.54488+00
273	3	2024-04-08	169.981357	manual	2026-06-19 10:30:18.545378+00	2026-06-19 10:30:18.545378+00
274	3	2024-04-15	171.898881	manual	2026-06-19 10:30:18.545908+00	2026-06-19 10:30:18.545908+00
275	3	2024-04-22	169.594990	manual	2026-06-19 10:30:18.546407+00	2026-06-19 10:30:18.546407+00
276	3	2024-04-29	172.259508	manual	2026-06-19 10:30:18.546904+00	2026-06-19 10:30:18.546904+00
277	3	2024-05-06	169.533447	manual	2026-06-19 10:30:18.547356+00	2026-06-19 10:30:18.547356+00
278	3	2024-05-13	171.239062	manual	2026-06-19 10:30:18.547794+00	2026-06-19 10:30:18.547794+00
279	3	2024-05-20	175.486723	manual	2026-06-19 10:30:18.548229+00	2026-06-19 10:30:18.548229+00
280	3	2024-05-27	177.766119	manual	2026-06-19 10:30:18.548673+00	2026-06-19 10:30:18.548673+00
281	3	2024-06-03	178.298466	manual	2026-06-19 10:30:18.549126+00	2026-06-19 10:30:18.549126+00
282	3	2024-06-10	179.078474	manual	2026-06-19 10:30:18.550309+00	2026-06-19 10:30:18.550309+00
283	3	2024-06-17	175.854888	manual	2026-06-19 10:30:18.550967+00	2026-06-19 10:30:18.550967+00
284	3	2024-06-24	178.485457	manual	2026-06-19 10:30:18.55196+00	2026-06-19 10:30:18.55196+00
285	3	2024-07-01	181.921723	manual	2026-06-19 10:30:18.552419+00	2026-06-19 10:30:18.552419+00
286	3	2024-07-08	182.297044	manual	2026-06-19 10:30:18.552896+00	2026-06-19 10:30:18.552896+00
287	3	2024-07-15	183.359297	manual	2026-06-19 10:30:18.553398+00	2026-06-19 10:30:18.553398+00
288	3	2024-07-22	183.389642	manual	2026-06-19 10:30:18.553905+00	2026-06-19 10:30:18.553905+00
289	3	2024-07-29	184.355524	manual	2026-06-19 10:30:18.554364+00	2026-06-19 10:30:18.554364+00
290	3	2024-08-05	180.207797	manual	2026-06-19 10:30:18.554827+00	2026-06-19 10:30:18.554827+00
291	3	2024-08-12	184.430906	manual	2026-06-19 10:30:18.555294+00	2026-06-19 10:30:18.555294+00
292	3	2024-08-19	183.048084	manual	2026-06-19 10:30:18.555804+00	2026-06-19 10:30:18.555804+00
293	3	2024-08-26	186.452211	manual	2026-06-19 10:30:18.557393+00	2026-06-19 10:30:18.557393+00
294	3	2024-09-02	183.958462	manual	2026-06-19 10:30:18.55791+00	2026-06-19 10:30:18.55791+00
295	3	2024-09-09	185.079208	manual	2026-06-19 10:30:18.558349+00	2026-06-19 10:30:18.558349+00
296	3	2024-09-16	180.896505	manual	2026-06-19 10:30:18.5588+00	2026-06-19 10:30:18.5588+00
297	3	2024-09-23	177.946485	manual	2026-06-19 10:30:18.559549+00	2026-06-19 10:30:18.559549+00
298	3	2024-09-30	178.488190	manual	2026-06-19 10:30:18.560037+00	2026-06-19 10:30:18.560037+00
299	3	2024-10-07	177.441566	manual	2026-06-19 10:30:18.561764+00	2026-06-19 10:30:18.561764+00
300	3	2024-10-14	173.523189	manual	2026-06-19 10:30:18.565594+00	2026-06-19 10:30:18.565594+00
301	3	2024-10-21	177.760946	manual	2026-06-19 10:30:18.56627+00	2026-06-19 10:30:18.56627+00
302	3	2024-10-28	175.019519	manual	2026-06-19 10:30:18.567974+00	2026-06-19 10:30:18.567974+00
303	3	2024-11-04	174.829385	manual	2026-06-19 10:30:18.568448+00	2026-06-19 10:30:18.568448+00
304	3	2024-11-11	176.014487	manual	2026-06-19 10:30:18.568936+00	2026-06-19 10:30:18.568936+00
305	3	2024-11-18	173.876708	manual	2026-06-19 10:30:18.56944+00	2026-06-19 10:30:18.56944+00
306	3	2024-11-25	178.420307	manual	2026-06-19 10:30:18.569965+00	2026-06-19 10:30:18.569965+00
307	3	2024-12-02	177.623236	manual	2026-06-19 10:30:18.570462+00	2026-06-19 10:30:18.570462+00
308	3	2024-12-09	180.426005	manual	2026-06-19 10:30:18.570979+00	2026-06-19 10:30:18.570979+00
309	3	2024-12-16	181.740386	manual	2026-06-19 10:30:18.571473+00	2026-06-19 10:30:18.571473+00
310	3	2024-12-23	186.314523	manual	2026-06-19 10:30:18.57194+00	2026-06-19 10:30:18.57194+00
311	3	2024-12-30	182.548374	manual	2026-06-19 10:30:18.572426+00	2026-06-19 10:30:18.572426+00
312	3	2025-01-06	181.857853	manual	2026-06-19 10:30:18.572961+00	2026-06-19 10:30:18.572961+00
313	3	2025-01-13	181.051441	manual	2026-06-19 10:30:18.573476+00	2026-06-19 10:30:18.573476+00
314	3	2025-01-20	179.779105	manual	2026-06-19 10:30:18.574184+00	2026-06-19 10:30:18.574184+00
315	3	2025-01-27	182.199706	manual	2026-06-19 10:30:18.57469+00	2026-06-19 10:30:18.57469+00
316	3	2025-02-03	185.175169	manual	2026-06-19 10:30:18.57525+00	2026-06-19 10:30:18.57525+00
317	3	2025-02-10	186.181728	manual	2026-06-19 10:30:18.576121+00	2026-06-19 10:30:18.576121+00
318	3	2025-02-17	182.854900	manual	2026-06-19 10:30:18.576677+00	2026-06-19 10:30:18.576677+00
319	3	2025-02-24	181.013207	manual	2026-06-19 10:30:18.578398+00	2026-06-19 10:30:18.578398+00
320	3	2025-03-03	177.109174	manual	2026-06-19 10:30:18.578986+00	2026-06-19 10:30:18.578986+00
321	3	2025-03-10	176.110699	manual	2026-06-19 10:30:18.579491+00	2026-06-19 10:30:18.579491+00
322	3	2025-03-17	175.673736	manual	2026-06-19 10:30:18.58134+00	2026-06-19 10:30:18.58134+00
323	3	2025-03-24	176.335488	manual	2026-06-19 10:30:18.581884+00	2026-06-19 10:30:18.581884+00
324	3	2025-03-31	177.421848	manual	2026-06-19 10:30:18.582408+00	2026-06-19 10:30:18.582408+00
325	3	2025-04-07	174.137845	manual	2026-06-19 10:30:18.583079+00	2026-06-19 10:30:18.583079+00
326	3	2025-04-14	172.804413	manual	2026-06-19 10:30:18.584226+00	2026-06-19 10:30:18.584226+00
327	3	2025-04-21	170.999943	manual	2026-06-19 10:30:18.586363+00	2026-06-19 10:30:18.586363+00
328	3	2025-04-28	174.767415	manual	2026-06-19 10:30:18.586852+00	2026-06-19 10:30:18.586852+00
329	3	2025-05-05	174.057825	manual	2026-06-19 10:30:18.587335+00	2026-06-19 10:30:18.587335+00
330	3	2025-05-12	170.288383	manual	2026-06-19 10:30:18.587809+00	2026-06-19 10:30:18.587809+00
331	3	2025-05-19	168.599796	manual	2026-06-19 10:30:18.588286+00	2026-06-19 10:30:18.588286+00
332	3	2025-05-26	168.180219	manual	2026-06-19 10:30:18.588824+00	2026-06-19 10:30:18.588824+00
333	3	2025-06-02	167.527275	manual	2026-06-19 10:30:18.589296+00	2026-06-19 10:30:18.589296+00
334	3	2025-06-09	166.580906	manual	2026-06-19 10:30:18.589759+00	2026-06-19 10:30:18.589759+00
335	3	2025-06-16	168.531790	manual	2026-06-19 10:30:18.590287+00	2026-06-19 10:30:18.590287+00
336	3	2025-06-23	170.544553	manual	2026-06-19 10:30:18.59086+00	2026-06-19 10:30:18.59086+00
337	3	2025-06-30	172.650060	manual	2026-06-19 10:30:18.594476+00	2026-06-19 10:30:18.594476+00
338	3	2025-07-07	173.295904	manual	2026-06-19 10:30:18.594962+00	2026-06-19 10:30:18.594962+00
339	3	2025-07-14	177.027802	manual	2026-06-19 10:30:18.595422+00	2026-06-19 10:30:18.595422+00
340	3	2025-07-21	173.186102	manual	2026-06-19 10:30:18.595866+00	2026-06-19 10:30:18.595866+00
341	3	2025-07-28	175.008339	manual	2026-06-19 10:30:18.596317+00	2026-06-19 10:30:18.596317+00
342	3	2025-08-04	172.896515	manual	2026-06-19 10:30:18.600703+00	2026-06-19 10:30:18.600703+00
343	3	2025-08-11	170.501173	manual	2026-06-19 10:30:18.601414+00	2026-06-19 10:30:18.601414+00
344	3	2025-08-18	168.380556	manual	2026-06-19 10:30:18.601955+00	2026-06-19 10:30:18.601955+00
345	3	2025-08-25	171.793002	manual	2026-06-19 10:30:18.60243+00	2026-06-19 10:30:18.60243+00
346	3	2025-09-01	168.230074	manual	2026-06-19 10:30:18.602904+00	2026-06-19 10:30:18.602904+00
347	3	2025-09-08	171.609633	manual	2026-06-19 10:30:18.603387+00	2026-06-19 10:30:18.603387+00
348	3	2025-09-15	174.232468	manual	2026-06-19 10:30:18.603886+00	2026-06-19 10:30:18.603886+00
349	3	2025-09-22	174.228053	manual	2026-06-19 10:30:18.604389+00	2026-06-19 10:30:18.604389+00
350	3	2025-09-29	175.971510	manual	2026-06-19 10:30:18.604809+00	2026-06-19 10:30:18.604809+00
351	3	2025-10-06	178.522316	manual	2026-06-19 10:30:18.60523+00	2026-06-19 10:30:18.60523+00
352	3	2025-10-13	176.552844	manual	2026-06-19 10:30:18.605681+00	2026-06-19 10:30:18.605681+00
353	3	2025-10-20	173.683997	manual	2026-06-19 10:30:18.606129+00	2026-06-19 10:30:18.606129+00
354	3	2025-10-27	173.025325	manual	2026-06-19 10:30:18.606583+00	2026-06-19 10:30:18.606583+00
355	3	2025-11-03	175.585124	manual	2026-06-19 10:30:18.607029+00	2026-06-19 10:30:18.607029+00
356	3	2025-11-10	179.371768	manual	2026-06-19 10:30:18.607499+00	2026-06-19 10:30:18.607499+00
357	3	2025-11-17	175.932491	manual	2026-06-19 10:30:18.607985+00	2026-06-19 10:30:18.607985+00
358	3	2025-11-24	173.668004	manual	2026-06-19 10:30:18.608475+00	2026-06-19 10:30:18.608475+00
359	3	2025-12-01	173.027053	manual	2026-06-19 10:30:18.609013+00	2026-06-19 10:30:18.609013+00
360	3	2025-12-08	173.262667	manual	2026-06-19 10:30:18.609506+00	2026-06-19 10:30:18.609506+00
361	3	2025-12-15	176.060646	manual	2026-06-19 10:30:18.610044+00	2026-06-19 10:30:18.610044+00
362	3	2025-12-22	176.708100	manual	2026-06-19 10:30:18.610547+00	2026-06-19 10:30:18.610547+00
363	3	2025-12-29	180.233138	manual	2026-06-19 10:30:18.611015+00	2026-06-19 10:30:18.611015+00
364	3	2026-01-05	179.670311	manual	2026-06-19 10:30:18.61151+00	2026-06-19 10:30:18.61151+00
365	3	2026-01-12	180.350552	manual	2026-06-19 10:30:18.611959+00	2026-06-19 10:30:18.611959+00
366	3	2026-01-19	179.749873	manual	2026-06-19 10:30:18.612415+00	2026-06-19 10:30:18.612415+00
367	3	2026-01-26	182.854105	manual	2026-06-19 10:30:18.612892+00	2026-06-19 10:30:18.612892+00
368	3	2026-02-02	183.326434	manual	2026-06-19 10:30:18.613332+00	2026-06-19 10:30:18.613332+00
369	3	2026-02-09	186.121712	manual	2026-06-19 10:30:18.613775+00	2026-06-19 10:30:18.613775+00
370	3	2026-02-16	187.482787	manual	2026-06-19 10:30:18.614233+00	2026-06-19 10:30:18.614233+00
371	3	2026-02-23	185.278249	manual	2026-06-19 10:30:18.614733+00	2026-06-19 10:30:18.614733+00
372	3	2026-03-02	188.224472	manual	2026-06-19 10:30:18.615191+00	2026-06-19 10:30:18.615191+00
373	3	2026-03-09	190.110907	manual	2026-06-19 10:30:18.615688+00	2026-06-19 10:30:18.615688+00
374	3	2026-03-16	193.085729	manual	2026-06-19 10:30:18.616136+00	2026-06-19 10:30:18.616136+00
375	3	2026-03-23	193.109314	manual	2026-06-19 10:30:18.616607+00	2026-06-19 10:30:18.616607+00
376	3	2026-03-30	192.272320	manual	2026-06-19 10:30:18.617062+00	2026-06-19 10:30:18.617062+00
377	3	2026-04-06	194.444725	manual	2026-06-19 10:30:18.617616+00	2026-06-19 10:30:18.617616+00
378	3	2026-04-13	190.935364	manual	2026-06-19 10:30:18.618123+00	2026-06-19 10:30:18.618123+00
379	3	2026-04-20	187.832984	manual	2026-06-19 10:30:18.618637+00	2026-06-19 10:30:18.618637+00
380	3	2026-04-27	192.324956	manual	2026-06-19 10:30:18.619227+00	2026-06-19 10:30:18.619227+00
381	3	2026-05-04	194.045673	manual	2026-06-19 10:30:18.620214+00	2026-06-19 10:30:18.620214+00
382	3	2026-05-11	192.557998	manual	2026-06-19 10:30:18.62069+00	2026-06-19 10:30:18.62069+00
383	3	2026-05-18	196.808332	manual	2026-06-19 10:30:18.621144+00	2026-06-19 10:30:18.621144+00
384	3	2026-05-25	193.871581	manual	2026-06-19 10:30:18.62161+00	2026-06-19 10:30:18.62161+00
385	3	2026-06-01	196.638769	manual	2026-06-19 10:30:18.622055+00	2026-06-19 10:30:18.622055+00
386	3	2026-06-08	194.697563	manual	2026-06-19 10:30:18.622597+00	2026-06-19 10:30:18.622597+00
387	3	2026-06-15	197.160661	manual	2026-06-19 10:30:18.623145+00	2026-06-19 10:30:18.623145+00
388	4	2024-01-01	724.036060	manual	2026-06-19 10:30:18.630446+00	2026-06-19 10:30:18.630446+00
389	4	2024-01-08	721.110099	manual	2026-06-19 10:30:18.630878+00	2026-06-19 10:30:18.630878+00
390	4	2024-01-15	704.243557	manual	2026-06-19 10:30:18.63132+00	2026-06-19 10:30:18.63132+00
391	4	2024-01-22	725.573770	manual	2026-06-19 10:30:18.631748+00	2026-06-19 10:30:18.631748+00
392	4	2024-01-29	719.194101	manual	2026-06-19 10:30:18.632193+00	2026-06-19 10:30:18.632193+00
393	4	2024-02-05	719.204929	manual	2026-06-19 10:30:18.632626+00	2026-06-19 10:30:18.632626+00
394	4	2024-02-12	702.212702	manual	2026-06-19 10:30:18.633033+00	2026-06-19 10:30:18.633033+00
395	4	2024-02-19	694.677871	manual	2026-06-19 10:30:18.633524+00	2026-06-19 10:30:18.633524+00
396	4	2024-02-26	680.432831	manual	2026-06-19 10:30:18.633999+00	2026-06-19 10:30:18.633999+00
397	4	2024-03-04	683.721075	manual	2026-06-19 10:30:18.634545+00	2026-06-19 10:30:18.634545+00
398	4	2024-03-11	688.967208	manual	2026-06-19 10:30:18.63509+00	2026-06-19 10:30:18.63509+00
399	4	2024-03-18	690.700634	manual	2026-06-19 10:30:18.635542+00	2026-06-19 10:30:18.635542+00
400	4	2024-03-25	683.046386	manual	2026-06-19 10:30:18.635966+00	2026-06-19 10:30:18.635966+00
401	4	2024-04-01	669.192640	manual	2026-06-19 10:30:18.636383+00	2026-06-19 10:30:18.636383+00
402	4	2024-04-08	684.391637	manual	2026-06-19 10:30:18.636806+00	2026-06-19 10:30:18.636806+00
403	4	2024-04-15	687.814671	manual	2026-06-19 10:30:18.637223+00	2026-06-19 10:30:18.637223+00
404	4	2024-04-22	677.332409	manual	2026-06-19 10:30:18.637644+00	2026-06-19 10:30:18.637644+00
405	4	2024-04-29	690.613727	manual	2026-06-19 10:30:18.638084+00	2026-06-19 10:30:18.638084+00
406	4	2024-05-06	685.057864	manual	2026-06-19 10:30:18.638537+00	2026-06-19 10:30:18.638537+00
407	4	2024-05-13	696.871085	manual	2026-06-19 10:30:18.638985+00	2026-06-19 10:30:18.638985+00
408	4	2024-05-20	704.968352	manual	2026-06-19 10:30:18.639433+00	2026-06-19 10:30:18.639433+00
409	4	2024-05-27	690.348622	manual	2026-06-19 10:30:18.640094+00	2026-06-19 10:30:18.640094+00
410	4	2024-06-03	684.744318	manual	2026-06-19 10:30:18.640656+00	2026-06-19 10:30:18.640656+00
411	4	2024-06-10	691.919570	manual	2026-06-19 10:30:18.641142+00	2026-06-19 10:30:18.641142+00
412	4	2024-06-17	690.537097	manual	2026-06-19 10:30:18.64167+00	2026-06-19 10:30:18.64167+00
413	4	2024-06-24	677.613929	manual	2026-06-19 10:30:18.64224+00	2026-06-19 10:30:18.64224+00
414	4	2024-07-01	687.762314	manual	2026-06-19 10:30:18.642734+00	2026-06-19 10:30:18.642734+00
415	4	2024-07-08	674.112732	manual	2026-06-19 10:30:18.643208+00	2026-06-19 10:30:18.643208+00
416	4	2024-07-15	674.462159	manual	2026-06-19 10:30:18.6437+00	2026-06-19 10:30:18.6437+00
417	4	2024-07-22	691.007552	manual	2026-06-19 10:30:18.644238+00	2026-06-19 10:30:18.644238+00
418	4	2024-07-29	674.883548	manual	2026-06-19 10:30:18.644729+00	2026-06-19 10:30:18.644729+00
419	4	2024-08-05	660.758629	manual	2026-06-19 10:30:18.645265+00	2026-06-19 10:30:18.645265+00
420	4	2024-08-12	669.761585	manual	2026-06-19 10:30:18.645783+00	2026-06-19 10:30:18.645783+00
421	4	2024-08-19	687.633045	manual	2026-06-19 10:30:18.64624+00	2026-06-19 10:30:18.64624+00
422	4	2024-08-26	707.670221	manual	2026-06-19 10:30:18.646673+00	2026-06-19 10:30:18.646673+00
423	4	2024-09-02	709.777554	manual	2026-06-19 10:30:18.647108+00	2026-06-19 10:30:18.647108+00
424	4	2024-09-09	713.360652	manual	2026-06-19 10:30:18.64755+00	2026-06-19 10:30:18.64755+00
425	4	2024-09-16	698.744951	manual	2026-06-19 10:30:18.647981+00	2026-06-19 10:30:18.647981+00
426	4	2024-09-23	681.693246	manual	2026-06-19 10:30:18.648451+00	2026-06-19 10:30:18.648451+00
427	4	2024-09-30	693.436712	manual	2026-06-19 10:30:18.648894+00	2026-06-19 10:30:18.648894+00
428	4	2024-10-07	707.441953	manual	2026-06-19 10:30:18.649329+00	2026-06-19 10:30:18.649329+00
429	4	2024-10-14	693.761781	manual	2026-06-19 10:30:18.649754+00	2026-06-19 10:30:18.649754+00
430	4	2024-10-21	676.908301	manual	2026-06-19 10:30:18.650515+00	2026-06-19 10:30:18.650515+00
431	4	2024-10-28	664.004811	manual	2026-06-19 10:30:18.651014+00	2026-06-19 10:30:18.651014+00
432	4	2024-11-04	661.051751	manual	2026-06-19 10:30:18.651476+00	2026-06-19 10:30:18.651476+00
433	4	2024-11-11	666.317549	manual	2026-06-19 10:30:18.652387+00	2026-06-19 10:30:18.652387+00
434	4	2024-11-18	678.548721	manual	2026-06-19 10:30:18.652846+00	2026-06-19 10:30:18.652846+00
435	4	2024-11-25	669.631722	manual	2026-06-19 10:30:18.653282+00	2026-06-19 10:30:18.653282+00
436	4	2024-12-02	662.607091	manual	2026-06-19 10:30:18.653704+00	2026-06-19 10:30:18.653704+00
437	4	2024-12-09	662.643751	manual	2026-06-19 10:30:18.654158+00	2026-06-19 10:30:18.654158+00
438	4	2024-12-16	663.253210	manual	2026-06-19 10:30:18.654584+00	2026-06-19 10:30:18.654584+00
439	4	2024-12-23	649.416893	manual	2026-06-19 10:30:18.655012+00	2026-06-19 10:30:18.655012+00
440	4	2024-12-30	638.601499	manual	2026-06-19 10:30:18.655424+00	2026-06-19 10:30:18.655424+00
441	4	2025-01-06	625.938666	manual	2026-06-19 10:30:18.655842+00	2026-06-19 10:30:18.655842+00
442	4	2025-01-13	609.656119	manual	2026-06-19 10:30:18.656236+00	2026-06-19 10:30:18.656236+00
443	4	2025-01-20	616.795562	manual	2026-06-19 10:30:18.656657+00	2026-06-19 10:30:18.656657+00
444	4	2025-01-27	611.805766	manual	2026-06-19 10:30:18.657068+00	2026-06-19 10:30:18.657068+00
445	4	2025-02-03	601.246647	manual	2026-06-19 10:30:18.657516+00	2026-06-19 10:30:18.657516+00
446	4	2025-02-10	586.224895	manual	2026-06-19 10:30:18.657985+00	2026-06-19 10:30:18.657985+00
447	4	2025-02-17	571.222475	manual	2026-06-19 10:30:18.658466+00	2026-06-19 10:30:18.658466+00
448	4	2025-02-24	585.329922	manual	2026-06-19 10:30:18.658949+00	2026-06-19 10:30:18.658949+00
449	4	2025-03-03	590.200055	manual	2026-06-19 10:30:18.659403+00	2026-06-19 10:30:18.659403+00
450	4	2025-03-10	606.790306	manual	2026-06-19 10:30:18.660176+00	2026-06-19 10:30:18.660176+00
451	4	2025-03-17	610.070101	manual	2026-06-19 10:30:18.660729+00	2026-06-19 10:30:18.660729+00
452	4	2025-03-24	609.317658	manual	2026-06-19 10:30:18.661298+00	2026-06-19 10:30:18.661298+00
453	4	2025-03-31	608.932158	manual	2026-06-19 10:30:18.661775+00	2026-06-19 10:30:18.661775+00
454	4	2025-04-07	601.650024	manual	2026-06-19 10:30:18.662252+00	2026-06-19 10:30:18.662252+00
455	4	2025-04-14	598.775561	manual	2026-06-19 10:30:18.662731+00	2026-06-19 10:30:18.662731+00
456	4	2025-04-21	612.785661	manual	2026-06-19 10:30:18.663212+00	2026-06-19 10:30:18.663212+00
457	4	2025-04-28	608.699224	manual	2026-06-19 10:30:18.663677+00	2026-06-19 10:30:18.663677+00
458	4	2025-05-05	615.079975	manual	2026-06-19 10:30:18.664148+00	2026-06-19 10:30:18.664148+00
459	4	2025-05-12	631.058454	manual	2026-06-19 10:30:18.664614+00	2026-06-19 10:30:18.664614+00
460	4	2025-05-19	621.179140	manual	2026-06-19 10:30:18.665037+00	2026-06-19 10:30:18.665037+00
461	4	2025-05-26	618.581062	manual	2026-06-19 10:30:18.665502+00	2026-06-19 10:30:18.665502+00
462	4	2025-06-02	634.615870	manual	2026-06-19 10:30:18.665954+00	2026-06-19 10:30:18.665954+00
463	4	2025-06-09	630.080057	manual	2026-06-19 10:30:18.666412+00	2026-06-19 10:30:18.666412+00
464	4	2025-06-16	625.638495	manual	2026-06-19 10:30:18.666974+00	2026-06-19 10:30:18.666974+00
465	4	2025-06-23	615.136370	manual	2026-06-19 10:30:18.667652+00	2026-06-19 10:30:18.667652+00
466	4	2025-06-30	617.180132	manual	2026-06-19 10:30:18.668103+00	2026-06-19 10:30:18.668103+00
467	4	2025-07-07	611.104529	manual	2026-06-19 10:30:18.668549+00	2026-06-19 10:30:18.668549+00
468	4	2025-07-14	626.487477	manual	2026-06-19 10:30:18.669003+00	2026-06-19 10:30:18.669003+00
469	4	2025-07-21	623.908937	manual	2026-06-19 10:30:18.669451+00	2026-06-19 10:30:18.669451+00
470	4	2025-07-28	625.097404	manual	2026-06-19 10:30:18.669894+00	2026-06-19 10:30:18.669894+00
471	4	2025-08-04	616.576207	manual	2026-06-19 10:30:18.67033+00	2026-06-19 10:30:18.67033+00
472	4	2025-08-11	621.671138	manual	2026-06-19 10:30:18.670796+00	2026-06-19 10:30:18.670796+00
473	4	2025-08-18	617.466424	manual	2026-06-19 10:30:18.671285+00	2026-06-19 10:30:18.671285+00
474	4	2025-08-25	635.271387	manual	2026-06-19 10:30:18.671745+00	2026-06-19 10:30:18.671745+00
475	4	2025-09-01	647.015310	manual	2026-06-19 10:30:18.672202+00	2026-06-19 10:30:18.672202+00
476	4	2025-09-08	645.843082	manual	2026-06-19 10:30:18.672679+00	2026-06-19 10:30:18.672679+00
477	4	2025-09-15	637.115083	manual	2026-06-19 10:30:18.673147+00	2026-06-19 10:30:18.673147+00
478	4	2025-09-22	636.732836	manual	2026-06-19 10:30:18.673586+00	2026-06-19 10:30:18.673586+00
479	4	2025-09-29	636.373639	manual	2026-06-19 10:30:18.674044+00	2026-06-19 10:30:18.674044+00
480	4	2025-10-06	646.501938	manual	2026-06-19 10:30:18.674506+00	2026-06-19 10:30:18.674506+00
481	4	2025-10-13	638.622742	manual	2026-06-19 10:30:18.674958+00	2026-06-19 10:30:18.674958+00
482	4	2025-10-20	632.788377	manual	2026-06-19 10:30:18.675437+00	2026-06-19 10:30:18.675437+00
483	4	2025-10-27	640.291964	manual	2026-06-19 10:30:18.675899+00	2026-06-19 10:30:18.675899+00
484	4	2025-11-03	623.414873	manual	2026-06-19 10:30:18.676367+00	2026-06-19 10:30:18.676367+00
485	4	2025-11-10	615.965235	manual	2026-06-19 10:30:18.676831+00	2026-06-19 10:30:18.676831+00
486	4	2025-11-17	602.637191	manual	2026-06-19 10:30:18.677281+00	2026-06-19 10:30:18.677281+00
487	4	2025-11-24	586.569512	manual	2026-06-19 10:30:18.677787+00	2026-06-19 10:30:18.677787+00
488	4	2025-12-01	580.287102	manual	2026-06-19 10:30:18.678231+00	2026-06-19 10:30:18.678231+00
489	4	2025-12-08	568.140557	manual	2026-06-19 10:30:18.678691+00	2026-06-19 10:30:18.678691+00
490	4	2025-12-15	571.203953	manual	2026-06-19 10:30:18.679151+00	2026-06-19 10:30:18.679151+00
491	4	2025-12-22	567.613514	manual	2026-06-19 10:30:18.679652+00	2026-06-19 10:30:18.679652+00
492	4	2025-12-29	577.831155	manual	2026-06-19 10:30:18.680131+00	2026-06-19 10:30:18.680131+00
493	4	2026-01-05	567.196289	manual	2026-06-19 10:30:18.680624+00	2026-06-19 10:30:18.680624+00
494	4	2026-01-12	563.757080	manual	2026-06-19 10:30:18.681095+00	2026-06-19 10:30:18.681095+00
495	4	2026-01-19	568.624745	manual	2026-06-19 10:30:18.681576+00	2026-06-19 10:30:18.681576+00
496	4	2026-01-26	568.598483	manual	2026-06-19 10:30:18.682063+00	2026-06-19 10:30:18.682063+00
497	4	2026-02-02	571.140302	manual	2026-06-19 10:30:18.682527+00	2026-06-19 10:30:18.682527+00
498	4	2026-02-09	561.603211	manual	2026-06-19 10:30:18.683025+00	2026-06-19 10:30:18.683025+00
499	4	2026-02-16	561.250863	manual	2026-06-19 10:30:18.683495+00	2026-06-19 10:30:18.683495+00
500	4	2026-02-23	561.269578	manual	2026-06-19 10:30:18.683946+00	2026-06-19 10:30:18.683946+00
501	4	2026-03-02	551.039749	manual	2026-06-19 10:30:18.684714+00	2026-06-19 10:30:18.684714+00
502	4	2026-03-09	536.015134	manual	2026-06-19 10:30:18.685183+00	2026-06-19 10:30:18.685183+00
503	4	2026-03-16	541.697755	manual	2026-06-19 10:30:18.68564+00	2026-06-19 10:30:18.68564+00
504	4	2026-03-23	539.527222	manual	2026-06-19 10:30:18.686077+00	2026-06-19 10:30:18.686077+00
505	4	2026-03-30	555.809830	manual	2026-06-19 10:30:18.686538+00	2026-06-19 10:30:18.686538+00
506	4	2026-04-06	565.956698	manual	2026-06-19 10:30:18.686974+00	2026-06-19 10:30:18.686974+00
507	4	2026-04-13	575.515896	manual	2026-06-19 10:30:18.687436+00	2026-06-19 10:30:18.687436+00
508	4	2026-04-20	580.947701	manual	2026-06-19 10:30:18.687881+00	2026-06-19 10:30:18.687881+00
509	4	2026-04-27	578.465391	manual	2026-06-19 10:30:18.688343+00	2026-06-19 10:30:18.688343+00
510	4	2026-05-04	564.151982	manual	2026-06-19 10:30:18.688801+00	2026-06-19 10:30:18.688801+00
511	4	2026-05-11	561.218649	manual	2026-06-19 10:30:18.689239+00	2026-06-19 10:30:18.689239+00
512	4	2026-05-18	556.456758	manual	2026-06-19 10:30:18.689693+00	2026-06-19 10:30:18.689693+00
513	4	2026-05-25	559.617122	manual	2026-06-19 10:30:18.690212+00	2026-06-19 10:30:18.690212+00
514	4	2026-06-01	554.533927	manual	2026-06-19 10:30:18.690681+00	2026-06-19 10:30:18.690681+00
515	4	2026-06-08	544.272432	manual	2026-06-19 10:30:18.691207+00	2026-06-19 10:30:18.691207+00
516	4	2026-06-15	554.977262	manual	2026-06-19 10:30:18.691674+00	2026-06-19 10:30:18.691674+00
517	5	2024-01-01	53429.414960	manual	2026-06-19 10:30:18.694929+00	2026-06-19 10:30:18.694929+00
518	5	2024-01-08	56111.848760	manual	2026-06-19 10:30:18.695399+00	2026-06-19 10:30:18.695399+00
519	5	2024-01-15	53953.812214	manual	2026-06-19 10:30:18.695854+00	2026-06-19 10:30:18.695854+00
520	5	2024-01-22	54522.212234	manual	2026-06-19 10:30:18.696305+00	2026-06-19 10:30:18.696305+00
521	5	2024-01-29	54867.655060	manual	2026-06-19 10:30:18.696763+00	2026-06-19 10:30:18.696763+00
522	5	2024-02-05	53496.559414	manual	2026-06-19 10:30:18.697211+00	2026-06-19 10:30:18.697211+00
523	5	2024-02-12	53079.767871	manual	2026-06-19 10:30:18.697666+00	2026-06-19 10:30:18.697666+00
524	5	2024-02-19	51138.824246	manual	2026-06-19 10:30:18.698127+00	2026-06-19 10:30:18.698127+00
525	5	2024-02-26	53635.322296	manual	2026-06-19 10:30:18.69857+00	2026-06-19 10:30:18.69857+00
526	5	2024-03-04	52813.179597	manual	2026-06-19 10:30:18.699019+00	2026-06-19 10:30:18.699019+00
527	5	2024-03-11	50682.015328	manual	2026-06-19 10:30:18.69948+00	2026-06-19 10:30:18.69948+00
528	5	2024-03-18	49741.356946	manual	2026-06-19 10:30:18.699919+00	2026-06-19 10:30:18.699919+00
529	5	2024-03-25	49050.215605	manual	2026-06-19 10:30:18.701748+00	2026-06-19 10:30:18.701748+00
530	5	2024-04-01	51695.933083	manual	2026-06-19 10:30:18.702295+00	2026-06-19 10:30:18.702295+00
531	5	2024-04-08	53713.433278	manual	2026-06-19 10:30:18.702761+00	2026-06-19 10:30:18.702761+00
532	5	2024-04-15	53400.082092	manual	2026-06-19 10:30:18.703231+00	2026-06-19 10:30:18.703231+00
533	5	2024-04-22	55522.718867	manual	2026-06-19 10:30:18.703707+00	2026-06-19 10:30:18.703707+00
534	5	2024-04-29	57379.562543	manual	2026-06-19 10:30:18.704189+00	2026-06-19 10:30:18.704189+00
535	5	2024-05-06	56907.682963	manual	2026-06-19 10:30:18.704671+00	2026-06-19 10:30:18.704671+00
536	5	2024-05-13	55757.956179	manual	2026-06-19 10:30:18.705143+00	2026-06-19 10:30:18.705143+00
537	5	2024-05-20	53340.123543	manual	2026-06-19 10:30:18.705626+00	2026-06-19 10:30:18.705626+00
538	5	2024-05-27	53811.913863	manual	2026-06-19 10:30:18.706086+00	2026-06-19 10:30:18.706086+00
539	5	2024-06-03	51502.637936	manual	2026-06-19 10:30:18.706563+00	2026-06-19 10:30:18.706563+00
540	5	2024-06-10	52718.258778	manual	2026-06-19 10:30:18.707023+00	2026-06-19 10:30:18.707023+00
541	5	2024-06-17	54236.912447	manual	2026-06-19 10:30:18.707509+00	2026-06-19 10:30:18.707509+00
542	5	2024-06-24	57077.567589	manual	2026-06-19 10:30:18.707974+00	2026-06-19 10:30:18.707974+00
543	5	2024-07-01	56576.106608	manual	2026-06-19 10:30:18.708453+00	2026-06-19 10:30:18.708453+00
544	5	2024-07-08	57382.752263	manual	2026-06-19 10:30:18.708924+00	2026-06-19 10:30:18.708924+00
545	5	2024-07-15	58440.731343	manual	2026-06-19 10:30:18.709402+00	2026-06-19 10:30:18.709402+00
546	5	2024-07-22	56210.088640	manual	2026-06-19 10:30:18.709859+00	2026-06-19 10:30:18.709859+00
547	5	2024-07-29	55895.971091	manual	2026-06-19 10:30:18.710327+00	2026-06-19 10:30:18.710327+00
548	5	2024-08-05	55686.693954	manual	2026-06-19 10:30:18.710796+00	2026-06-19 10:30:18.710796+00
549	5	2024-08-12	53398.234576	manual	2026-06-19 10:30:18.711278+00	2026-06-19 10:30:18.711278+00
550	5	2024-08-19	52784.597789	manual	2026-06-19 10:30:18.711754+00	2026-06-19 10:30:18.711754+00
551	5	2024-08-26	51867.757366	manual	2026-06-19 10:30:18.712217+00	2026-06-19 10:30:18.712217+00
552	5	2024-09-02	52222.578481	manual	2026-06-19 10:30:18.71267+00	2026-06-19 10:30:18.71267+00
553	5	2024-09-09	54982.153617	manual	2026-06-19 10:30:18.713133+00	2026-06-19 10:30:18.713133+00
554	5	2024-09-16	56863.718188	manual	2026-06-19 10:30:18.713601+00	2026-06-19 10:30:18.713601+00
555	5	2024-09-23	59530.792501	manual	2026-06-19 10:30:18.714067+00	2026-06-19 10:30:18.714067+00
556	5	2024-09-30	59187.082470	manual	2026-06-19 10:30:18.714549+00	2026-06-19 10:30:18.714549+00
557	5	2024-10-07	61025.821711	manual	2026-06-19 10:30:18.715018+00	2026-06-19 10:30:18.715018+00
558	5	2024-10-14	63304.401053	manual	2026-06-19 10:30:18.715549+00	2026-06-19 10:30:18.715549+00
559	5	2024-10-21	63787.157501	manual	2026-06-19 10:30:18.716008+00	2026-06-19 10:30:18.716008+00
560	5	2024-10-28	62410.944643	manual	2026-06-19 10:30:18.716522+00	2026-06-19 10:30:18.716522+00
561	5	2024-11-04	60399.842506	manual	2026-06-19 10:30:18.716977+00	2026-06-19 10:30:18.716977+00
562	5	2024-11-11	58876.302410	manual	2026-06-19 10:30:18.717449+00	2026-06-19 10:30:18.717449+00
563	5	2024-11-18	56250.864599	manual	2026-06-19 10:30:18.718497+00	2026-06-19 10:30:18.718497+00
564	5	2024-11-25	54457.996239	manual	2026-06-19 10:30:18.719261+00	2026-06-19 10:30:18.719261+00
565	5	2024-12-02	55447.977367	manual	2026-06-19 10:30:18.719822+00	2026-06-19 10:30:18.719822+00
566	5	2024-12-09	55918.137370	manual	2026-06-19 10:30:18.720299+00	2026-06-19 10:30:18.720299+00
567	5	2024-12-16	55245.451422	manual	2026-06-19 10:30:18.720752+00	2026-06-19 10:30:18.720752+00
568	5	2024-12-23	56039.092996	manual	2026-06-19 10:30:18.721203+00	2026-06-19 10:30:18.721203+00
569	5	2024-12-30	53917.199618	manual	2026-06-19 10:30:18.721656+00	2026-06-19 10:30:18.721656+00
570	5	2025-01-06	55951.476674	manual	2026-06-19 10:30:18.722097+00	2026-06-19 10:30:18.722097+00
571	5	2025-01-13	55158.464161	manual	2026-06-19 10:30:18.722562+00	2026-06-19 10:30:18.722562+00
572	5	2025-01-20	55712.034976	manual	2026-06-19 10:30:18.723108+00	2026-06-19 10:30:18.723108+00
573	5	2025-01-27	53837.687972	manual	2026-06-19 10:30:18.72356+00	2026-06-19 10:30:18.72356+00
574	5	2025-02-03	51689.202403	manual	2026-06-19 10:30:18.724025+00	2026-06-19 10:30:18.724025+00
575	5	2025-02-10	54164.348400	manual	2026-06-19 10:30:18.724496+00	2026-06-19 10:30:18.724496+00
576	5	2025-02-17	53084.455408	manual	2026-06-19 10:30:18.724962+00	2026-06-19 10:30:18.724962+00
577	5	2025-02-24	52347.259894	manual	2026-06-19 10:30:18.725422+00	2026-06-19 10:30:18.725422+00
578	5	2025-03-03	53028.082746	manual	2026-06-19 10:30:18.725876+00	2026-06-19 10:30:18.725876+00
579	5	2025-03-10	50651.404298	manual	2026-06-19 10:30:18.726325+00	2026-06-19 10:30:18.726325+00
580	5	2025-03-17	51518.222069	manual	2026-06-19 10:30:18.726796+00	2026-06-19 10:30:18.726796+00
581	5	2025-03-24	52968.487157	manual	2026-06-19 10:30:18.727281+00	2026-06-19 10:30:18.727281+00
582	5	2025-03-31	54664.347345	manual	2026-06-19 10:30:18.727774+00	2026-06-19 10:30:18.727774+00
583	5	2025-04-07	52610.097534	manual	2026-06-19 10:30:18.728285+00	2026-06-19 10:30:18.728285+00
584	5	2025-04-14	53811.591615	manual	2026-06-19 10:30:18.728742+00	2026-06-19 10:30:18.728742+00
585	5	2025-04-21	55022.786241	manual	2026-06-19 10:30:18.729211+00	2026-06-19 10:30:18.729211+00
586	5	2025-04-28	54593.163580	manual	2026-06-19 10:30:18.729667+00	2026-06-19 10:30:18.729667+00
587	5	2025-05-05	53787.787966	manual	2026-06-19 10:30:18.730118+00	2026-06-19 10:30:18.730118+00
588	5	2025-05-12	52499.690350	manual	2026-06-19 10:30:18.730558+00	2026-06-19 10:30:18.730558+00
589	5	2025-05-19	51598.153577	manual	2026-06-19 10:30:18.731012+00	2026-06-19 10:30:18.731012+00
590	5	2025-05-26	51739.838158	manual	2026-06-19 10:30:18.731495+00	2026-06-19 10:30:18.731495+00
591	5	2025-06-02	50734.191208	manual	2026-06-19 10:30:18.73196+00	2026-06-19 10:30:18.73196+00
592	5	2025-06-09	49949.344706	manual	2026-06-19 10:30:18.732474+00	2026-06-19 10:30:18.732474+00
593	5	2025-06-16	50629.366391	manual	2026-06-19 10:30:18.732928+00	2026-06-19 10:30:18.732928+00
594	5	2025-06-23	50363.664546	manual	2026-06-19 10:30:18.733399+00	2026-06-19 10:30:18.733399+00
595	5	2025-06-30	51576.883783	manual	2026-06-19 10:30:18.73388+00	2026-06-19 10:30:18.73388+00
596	5	2025-07-07	53816.838370	manual	2026-06-19 10:30:18.734348+00	2026-06-19 10:30:18.734348+00
597	5	2025-07-14	51788.100452	manual	2026-06-19 10:30:18.734965+00	2026-06-19 10:30:18.734965+00
598	5	2025-07-21	51828.005142	manual	2026-06-19 10:30:18.735428+00	2026-06-19 10:30:18.735428+00
599	5	2025-07-28	51993.826747	manual	2026-06-19 10:30:18.735883+00	2026-06-19 10:30:18.735883+00
600	5	2025-08-04	53541.925833	manual	2026-06-19 10:30:18.736398+00	2026-06-19 10:30:18.736398+00
601	5	2025-08-11	53390.418720	manual	2026-06-19 10:30:18.736861+00	2026-06-19 10:30:18.736861+00
602	5	2025-08-18	51995.815337	manual	2026-06-19 10:30:18.7373+00	2026-06-19 10:30:18.7373+00
603	5	2025-08-25	52186.976726	manual	2026-06-19 10:30:18.737743+00	2026-06-19 10:30:18.737743+00
604	5	2025-09-01	52260.904005	manual	2026-06-19 10:30:18.738204+00	2026-06-19 10:30:18.738204+00
605	5	2025-09-08	54520.087069	manual	2026-06-19 10:30:18.738643+00	2026-06-19 10:30:18.738643+00
606	5	2025-09-15	54600.412157	manual	2026-06-19 10:30:18.73908+00	2026-06-19 10:30:18.73908+00
607	5	2025-09-22	53368.669681	manual	2026-06-19 10:30:18.739537+00	2026-06-19 10:30:18.739537+00
608	5	2025-09-29	53529.634000	manual	2026-06-19 10:30:18.739975+00	2026-06-19 10:30:18.739975+00
609	5	2025-10-06	51632.531843	manual	2026-06-19 10:30:18.740433+00	2026-06-19 10:30:18.740433+00
610	5	2025-10-13	50697.150336	manual	2026-06-19 10:30:18.740881+00	2026-06-19 10:30:18.740881+00
611	5	2025-10-20	49555.853687	manual	2026-06-19 10:30:18.741357+00	2026-06-19 10:30:18.741357+00
612	5	2025-10-27	50350.821154	manual	2026-06-19 10:30:18.741819+00	2026-06-19 10:30:18.741819+00
613	5	2025-11-03	50611.328975	manual	2026-06-19 10:30:18.742332+00	2026-06-19 10:30:18.742332+00
614	5	2025-11-10	53062.670024	manual	2026-06-19 10:30:18.742814+00	2026-06-19 10:30:18.742814+00
615	5	2025-11-17	51749.916678	manual	2026-06-19 10:30:18.743276+00	2026-06-19 10:30:18.743276+00
616	5	2025-11-24	49675.315021	manual	2026-06-19 10:30:18.743731+00	2026-06-19 10:30:18.743731+00
617	5	2025-12-01	50120.766492	manual	2026-06-19 10:30:18.744187+00	2026-06-19 10:30:18.744187+00
618	5	2025-12-08	49249.210030	manual	2026-06-19 10:30:18.744662+00	2026-06-19 10:30:18.744662+00
619	5	2025-12-15	47178.820994	manual	2026-06-19 10:30:18.745145+00	2026-06-19 10:30:18.745145+00
620	5	2025-12-22	47992.363825	manual	2026-06-19 10:30:18.745598+00	2026-06-19 10:30:18.745598+00
621	5	2025-12-29	45944.224829	manual	2026-06-19 10:30:18.746033+00	2026-06-19 10:30:18.746033+00
622	5	2026-01-05	45973.860199	manual	2026-06-19 10:30:18.746475+00	2026-06-19 10:30:18.746475+00
623	5	2026-01-12	45774.339166	manual	2026-06-19 10:30:18.746926+00	2026-06-19 10:30:18.746926+00
624	5	2026-01-19	45935.356763	manual	2026-06-19 10:30:18.747378+00	2026-06-19 10:30:18.747378+00
625	5	2026-01-26	48312.676453	manual	2026-06-19 10:30:18.747832+00	2026-06-19 10:30:18.747832+00
626	5	2026-02-02	48114.933276	manual	2026-06-19 10:30:18.748313+00	2026-06-19 10:30:18.748313+00
627	5	2026-02-09	49763.049236	manual	2026-06-19 10:30:18.749254+00	2026-06-19 10:30:18.749254+00
628	5	2026-02-16	49670.745295	manual	2026-06-19 10:30:18.749723+00	2026-06-19 10:30:18.749723+00
629	5	2026-02-23	50361.568308	manual	2026-06-19 10:30:18.75021+00	2026-06-19 10:30:18.75021+00
630	5	2026-03-02	51574.875960	manual	2026-06-19 10:30:18.750718+00	2026-06-19 10:30:18.750718+00
631	5	2026-03-09	51954.978985	manual	2026-06-19 10:30:18.751649+00	2026-06-19 10:30:18.751649+00
632	5	2026-03-16	54699.740965	manual	2026-06-19 10:30:18.752134+00	2026-06-19 10:30:18.752134+00
633	5	2026-03-23	52378.031943	manual	2026-06-19 10:30:18.752582+00	2026-06-19 10:30:18.752582+00
634	5	2026-03-30	54084.051101	manual	2026-06-19 10:30:18.753024+00	2026-06-19 10:30:18.753024+00
635	5	2026-04-06	53838.351107	manual	2026-06-19 10:30:18.753465+00	2026-06-19 10:30:18.753465+00
636	5	2026-04-13	52195.999494	manual	2026-06-19 10:30:18.753905+00	2026-06-19 10:30:18.753905+00
637	5	2026-04-20	51482.713596	manual	2026-06-19 10:30:18.754353+00	2026-06-19 10:30:18.754353+00
638	5	2026-04-27	49776.930492	manual	2026-06-19 10:30:18.754778+00	2026-06-19 10:30:18.754778+00
639	5	2026-05-04	51811.613427	manual	2026-06-19 10:30:18.755217+00	2026-06-19 10:30:18.755217+00
640	5	2026-05-11	52554.048915	manual	2026-06-19 10:30:18.755648+00	2026-06-19 10:30:18.755648+00
641	5	2026-05-18	52627.721229	manual	2026-06-19 10:30:18.756122+00	2026-06-19 10:30:18.756122+00
642	5	2026-05-25	54643.210537	manual	2026-06-19 10:30:18.756623+00	2026-06-19 10:30:18.756623+00
643	5	2026-06-01	52261.849703	manual	2026-06-19 10:30:18.757124+00	2026-06-19 10:30:18.757124+00
644	5	2026-06-08	50070.151705	manual	2026-06-19 10:30:18.758283+00	2026-06-19 10:30:18.758283+00
645	5	2026-06-15	48274.360294	manual	2026-06-19 10:30:18.758776+00	2026-06-19 10:30:18.758776+00
646	6	2024-01-01	2494.810810	manual	2026-06-19 10:30:18.762912+00	2026-06-19 10:30:18.762912+00
647	6	2024-01-08	2499.435653	manual	2026-06-19 10:30:18.763371+00	2026-06-19 10:30:18.763371+00
648	6	2024-01-15	2392.206930	manual	2026-06-19 10:30:18.763841+00	2026-06-19 10:30:18.763841+00
649	6	2024-01-22	2441.713326	manual	2026-06-19 10:30:18.764291+00	2026-06-19 10:30:18.764291+00
650	6	2024-01-29	2356.064225	manual	2026-06-19 10:30:18.76476+00	2026-06-19 10:30:18.76476+00
651	6	2024-02-05	2419.474458	manual	2026-06-19 10:30:18.765224+00	2026-06-19 10:30:18.765224+00
652	6	2024-02-12	2541.695183	manual	2026-06-19 10:30:18.765707+00	2026-06-19 10:30:18.765707+00
653	6	2024-02-19	2687.730011	manual	2026-06-19 10:30:18.766153+00	2026-06-19 10:30:18.766153+00
654	6	2024-02-26	2653.323771	manual	2026-06-19 10:30:18.766605+00	2026-06-19 10:30:18.766605+00
655	6	2024-03-04	2623.872000	manual	2026-06-19 10:30:18.767056+00	2026-06-19 10:30:18.767056+00
656	6	2024-03-11	2567.787798	manual	2026-06-19 10:30:18.767571+00	2026-06-19 10:30:18.767571+00
657	6	2024-03-18	2660.877239	manual	2026-06-19 10:30:18.768366+00	2026-06-19 10:30:18.768366+00
658	6	2024-03-25	2655.913950	manual	2026-06-19 10:30:18.768859+00	2026-06-19 10:30:18.768859+00
659	6	2024-04-01	2736.599088	manual	2026-06-19 10:30:18.769327+00	2026-06-19 10:30:18.769327+00
660	6	2024-04-08	2825.121030	manual	2026-06-19 10:30:18.769884+00	2026-06-19 10:30:18.769884+00
661	6	2024-04-15	2810.285375	manual	2026-06-19 10:30:18.770349+00	2026-06-19 10:30:18.770349+00
662	6	2024-04-22	2682.103020	manual	2026-06-19 10:30:18.7708+00	2026-06-19 10:30:18.7708+00
663	6	2024-04-29	2747.902973	manual	2026-06-19 10:30:18.771271+00	2026-06-19 10:30:18.771271+00
664	6	2024-05-06	2858.828467	manual	2026-06-19 10:30:18.771725+00	2026-06-19 10:30:18.771725+00
665	6	2024-05-13	3007.376376	manual	2026-06-19 10:30:18.772203+00	2026-06-19 10:30:18.772203+00
666	6	2024-05-20	3016.962304	manual	2026-06-19 10:30:18.772653+00	2026-06-19 10:30:18.772653+00
667	6	2024-05-27	2885.412512	manual	2026-06-19 10:30:18.773095+00	2026-06-19 10:30:18.773095+00
668	6	2024-06-03	3027.637972	manual	2026-06-19 10:30:18.773561+00	2026-06-19 10:30:18.773561+00
669	6	2024-06-10	3192.210099	manual	2026-06-19 10:30:18.774007+00	2026-06-19 10:30:18.774007+00
670	6	2024-06-17	3347.486115	manual	2026-06-19 10:30:18.774456+00	2026-06-19 10:30:18.774456+00
671	6	2024-06-24	3511.261970	manual	2026-06-19 10:30:18.77491+00	2026-06-19 10:30:18.77491+00
672	6	2024-07-01	3437.382376	manual	2026-06-19 10:30:18.775361+00	2026-06-19 10:30:18.775361+00
673	6	2024-07-08	3586.026736	manual	2026-06-19 10:30:18.775827+00	2026-06-19 10:30:18.775827+00
674	6	2024-07-15	3735.576396	manual	2026-06-19 10:30:18.776293+00	2026-06-19 10:30:18.776293+00
675	6	2024-07-22	3599.618704	manual	2026-06-19 10:30:18.776825+00	2026-06-19 10:30:18.776825+00
676	6	2024-07-29	3725.354138	manual	2026-06-19 10:30:18.777272+00	2026-06-19 10:30:18.777272+00
677	6	2024-08-05	3853.980441	manual	2026-06-19 10:30:18.777742+00	2026-06-19 10:30:18.777742+00
678	6	2024-08-12	3985.674994	manual	2026-06-19 10:30:18.778207+00	2026-06-19 10:30:18.778207+00
679	6	2024-08-19	4090.934013	manual	2026-06-19 10:30:18.778701+00	2026-06-19 10:30:18.778701+00
680	6	2024-08-26	4257.229586	manual	2026-06-19 10:30:18.779137+00	2026-06-19 10:30:18.779137+00
681	6	2024-09-02	4061.030333	manual	2026-06-19 10:30:18.779584+00	2026-06-19 10:30:18.779584+00
682	6	2024-09-09	3866.453572	manual	2026-06-19 10:30:18.780035+00	2026-06-19 10:30:18.780035+00
683	6	2024-09-16	3996.192118	manual	2026-06-19 10:30:18.780486+00	2026-06-19 10:30:18.780486+00
684	6	2024-09-23	3992.872748	manual	2026-06-19 10:30:18.780949+00	2026-06-19 10:30:18.780949+00
685	6	2024-09-30	3827.006408	manual	2026-06-19 10:30:18.781469+00	2026-06-19 10:30:18.781469+00
686	6	2024-10-07	3848.072026	manual	2026-06-19 10:30:18.781927+00	2026-06-19 10:30:18.781927+00
687	6	2024-10-14	3678.760298	manual	2026-06-19 10:30:18.782432+00	2026-06-19 10:30:18.782432+00
688	6	2024-10-21	3758.260075	manual	2026-06-19 10:30:18.782945+00	2026-06-19 10:30:18.782945+00
689	6	2024-10-28	3978.177560	manual	2026-06-19 10:30:18.783411+00	2026-06-19 10:30:18.783411+00
690	6	2024-11-04	4090.434277	manual	2026-06-19 10:30:18.78413+00	2026-06-19 10:30:18.78413+00
691	6	2024-11-11	4238.211106	manual	2026-06-19 10:30:18.785534+00	2026-06-19 10:30:18.785534+00
692	6	2024-11-18	4163.561328	manual	2026-06-19 10:30:18.785994+00	2026-06-19 10:30:18.785994+00
693	6	2024-11-25	4025.269387	manual	2026-06-19 10:30:18.78646+00	2026-06-19 10:30:18.78646+00
694	6	2024-12-02	4155.805910	manual	2026-06-19 10:30:18.78709+00	2026-06-19 10:30:18.78709+00
695	6	2024-12-09	4045.184831	manual	2026-06-19 10:30:18.787563+00	2026-06-19 10:30:18.787563+00
696	6	2024-12-16	3922.284175	manual	2026-06-19 10:30:18.788004+00	2026-06-19 10:30:18.788004+00
697	6	2024-12-23	4114.186887	manual	2026-06-19 10:30:18.788468+00	2026-06-19 10:30:18.788468+00
698	6	2024-12-30	4148.086052	manual	2026-06-19 10:30:18.788921+00	2026-06-19 10:30:18.788921+00
699	6	2025-01-06	4377.886028	manual	2026-06-19 10:30:18.789383+00	2026-06-19 10:30:18.789383+00
700	6	2025-01-13	4461.862723	manual	2026-06-19 10:30:18.789852+00	2026-06-19 10:30:18.789852+00
701	6	2025-01-20	4612.982076	manual	2026-06-19 10:30:18.790323+00	2026-06-19 10:30:18.790323+00
702	6	2025-01-27	4731.744433	manual	2026-06-19 10:30:18.790805+00	2026-06-19 10:30:18.790805+00
703	6	2025-02-03	4545.136455	manual	2026-06-19 10:30:18.791406+00	2026-06-19 10:30:18.791406+00
704	6	2025-02-10	4647.809158	manual	2026-06-19 10:30:18.791932+00	2026-06-19 10:30:18.791932+00
705	6	2025-02-17	4928.523993	manual	2026-06-19 10:30:18.792473+00	2026-06-19 10:30:18.792473+00
706	6	2025-02-24	4791.188720	manual	2026-06-19 10:30:18.792987+00	2026-06-19 10:30:18.792987+00
707	6	2025-03-03	4930.520011	manual	2026-06-19 10:30:18.793476+00	2026-06-19 10:30:18.793476+00
708	6	2025-03-10	5001.022669	manual	2026-06-19 10:30:18.793924+00	2026-06-19 10:30:18.793924+00
709	6	2025-03-17	5221.591099	manual	2026-06-19 10:30:18.794403+00	2026-06-19 10:30:18.794403+00
710	6	2025-03-24	5447.547942	manual	2026-06-19 10:30:18.794888+00	2026-06-19 10:30:18.794888+00
711	6	2025-03-31	5574.941103	manual	2026-06-19 10:30:18.795362+00	2026-06-19 10:30:18.795362+00
712	6	2025-04-07	5675.469678	manual	2026-06-19 10:30:18.795804+00	2026-06-19 10:30:18.795804+00
713	6	2025-04-14	5599.066932	manual	2026-06-19 10:30:18.796253+00	2026-06-19 10:30:18.796253+00
714	6	2025-04-21	5816.636577	manual	2026-06-19 10:30:18.796703+00	2026-06-19 10:30:18.796703+00
715	6	2025-04-28	5961.958717	manual	2026-06-19 10:30:18.797165+00	2026-06-19 10:30:18.797165+00
716	6	2025-05-05	6161.439217	manual	2026-06-19 10:30:18.797627+00	2026-06-19 10:30:18.797627+00
717	6	2025-05-12	6129.089874	manual	2026-06-19 10:30:18.798081+00	2026-06-19 10:30:18.798081+00
718	6	2025-05-19	6091.416524	manual	2026-06-19 10:30:18.798576+00	2026-06-19 10:30:18.798576+00
719	6	2025-05-26	6187.183397	manual	2026-06-19 10:30:18.799034+00	2026-06-19 10:30:18.799034+00
720	6	2025-06-02	6057.768282	manual	2026-06-19 10:30:18.799539+00	2026-06-19 10:30:18.799539+00
721	6	2025-06-09	6267.063229	manual	2026-06-19 10:30:18.800063+00	2026-06-19 10:30:18.800063+00
722	6	2025-06-16	6444.225542	manual	2026-06-19 10:30:18.80074+00	2026-06-19 10:30:18.80074+00
723	6	2025-06-23	6536.357521	manual	2026-06-19 10:30:18.802534+00	2026-06-19 10:30:18.802534+00
724	6	2025-06-30	6492.055251	manual	2026-06-19 10:30:18.803881+00	2026-06-19 10:30:18.803881+00
725	6	2025-07-07	6306.467273	manual	2026-06-19 10:30:18.804364+00	2026-06-19 10:30:18.804364+00
726	6	2025-07-14	6032.255036	manual	2026-06-19 10:30:18.804927+00	2026-06-19 10:30:18.804927+00
727	6	2025-07-21	5857.814033	manual	2026-06-19 10:30:18.805426+00	2026-06-19 10:30:18.805426+00
728	6	2025-07-28	6148.199655	manual	2026-06-19 10:30:18.805919+00	2026-06-19 10:30:18.805919+00
729	6	2025-08-04	6419.177644	manual	2026-06-19 10:30:18.806411+00	2026-06-19 10:30:18.806411+00
730	6	2025-08-11	6120.706346	manual	2026-06-19 10:30:18.806911+00	2026-06-19 10:30:18.806911+00
731	6	2025-08-18	6424.239981	manual	2026-06-19 10:30:18.807418+00	2026-06-19 10:30:18.807418+00
732	6	2025-08-25	6337.282515	manual	2026-06-19 10:30:18.807938+00	2026-06-19 10:30:18.807938+00
733	6	2025-09-01	6601.668645	manual	2026-06-19 10:30:18.80844+00	2026-06-19 10:30:18.80844+00
734	6	2025-09-08	6324.432385	manual	2026-06-19 10:30:18.808912+00	2026-06-19 10:30:18.808912+00
735	6	2025-09-15	6157.471913	manual	2026-06-19 10:30:18.809418+00	2026-06-19 10:30:18.809418+00
736	6	2025-09-22	5978.818988	manual	2026-06-19 10:30:18.809902+00	2026-06-19 10:30:18.809902+00
737	6	2025-09-29	6073.286388	manual	2026-06-19 10:30:18.810366+00	2026-06-19 10:30:18.810366+00
738	6	2025-10-06	6353.452766	manual	2026-06-19 10:30:18.810828+00	2026-06-19 10:30:18.810828+00
739	6	2025-10-13	6578.694144	manual	2026-06-19 10:30:18.811315+00	2026-06-19 10:30:18.811315+00
740	6	2025-10-20	6368.747762	manual	2026-06-19 10:30:18.811787+00	2026-06-19 10:30:18.811787+00
741	6	2025-10-27	6674.636231	manual	2026-06-19 10:30:18.812263+00	2026-06-19 10:30:18.812263+00
742	6	2025-11-03	6715.840107	manual	2026-06-19 10:30:18.812735+00	2026-06-19 10:30:18.812735+00
743	6	2025-11-10	6871.482214	manual	2026-06-19 10:30:18.813257+00	2026-06-19 10:30:18.813257+00
744	6	2025-11-17	6866.738450	manual	2026-06-19 10:30:18.813745+00	2026-06-19 10:30:18.813745+00
745	6	2025-11-24	7270.522279	manual	2026-06-19 10:30:18.814248+00	2026-06-19 10:30:18.814248+00
746	6	2025-12-01	7421.648704	manual	2026-06-19 10:30:18.814701+00	2026-06-19 10:30:18.814701+00
747	6	2025-12-08	7574.962236	manual	2026-06-19 10:30:18.815173+00	2026-06-19 10:30:18.815173+00
748	6	2025-12-15	7859.356433	manual	2026-06-19 10:30:18.815634+00	2026-06-19 10:30:18.815634+00
749	6	2025-12-22	7633.752160	manual	2026-06-19 10:30:18.816088+00	2026-06-19 10:30:18.816088+00
750	6	2025-12-29	7576.317385	manual	2026-06-19 10:30:18.816542+00	2026-06-19 10:30:18.816542+00
751	6	2026-01-05	7240.072893	manual	2026-06-19 10:30:18.817358+00	2026-06-19 10:30:18.817358+00
752	6	2026-01-12	7120.803914	manual	2026-06-19 10:30:18.817872+00	2026-06-19 10:30:18.817872+00
753	6	2026-01-19	7521.323653	manual	2026-06-19 10:30:18.818672+00	2026-06-19 10:30:18.818672+00
754	6	2026-01-26	7387.582753	manual	2026-06-19 10:30:18.819207+00	2026-06-19 10:30:18.819207+00
755	6	2026-02-02	7722.446698	manual	2026-06-19 10:30:18.819781+00	2026-06-19 10:30:18.819781+00
756	6	2026-02-09	7353.813604	manual	2026-06-19 10:30:18.82043+00	2026-06-19 10:30:18.82043+00
757	6	2026-02-16	7122.658179	manual	2026-06-19 10:30:18.820881+00	2026-06-19 10:30:18.820881+00
758	6	2026-02-23	7234.701067	manual	2026-06-19 10:30:18.821458+00	2026-06-19 10:30:18.821458+00
759	6	2026-03-02	7379.570024	manual	2026-06-19 10:30:18.821965+00	2026-06-19 10:30:18.821965+00
760	6	2026-03-09	7179.321678	manual	2026-06-19 10:30:18.822439+00	2026-06-19 10:30:18.822439+00
761	6	2026-03-16	7079.857369	manual	2026-06-19 10:30:18.822918+00	2026-06-19 10:30:18.822918+00
762	6	2026-03-23	7029.049254	manual	2026-06-19 10:30:18.823398+00	2026-06-19 10:30:18.823398+00
763	6	2026-03-30	6730.844657	manual	2026-06-19 10:30:18.823914+00	2026-06-19 10:30:18.823914+00
764	6	2026-04-06	6704.556812	manual	2026-06-19 10:30:18.824454+00	2026-06-19 10:30:18.824454+00
765	6	2026-04-13	6910.525104	manual	2026-06-19 10:30:18.824937+00	2026-06-19 10:30:18.824937+00
766	6	2026-04-20	6848.937569	manual	2026-06-19 10:30:18.825429+00	2026-06-19 10:30:18.825429+00
767	6	2026-04-27	6671.242137	manual	2026-06-19 10:30:18.825919+00	2026-06-19 10:30:18.825919+00
768	6	2026-05-04	6468.615861	manual	2026-06-19 10:30:18.826402+00	2026-06-19 10:30:18.826402+00
769	6	2026-05-11	6188.895074	manual	2026-06-19 10:30:18.826861+00	2026-06-19 10:30:18.826861+00
770	6	2026-05-18	6151.438654	manual	2026-06-19 10:30:18.827355+00	2026-06-19 10:30:18.827355+00
771	6	2026-05-25	6041.557279	manual	2026-06-19 10:30:18.827811+00	2026-06-19 10:30:18.827811+00
772	6	2026-06-01	6122.926459	manual	2026-06-19 10:30:18.828279+00	2026-06-19 10:30:18.828279+00
773	6	2026-06-08	5889.633824	manual	2026-06-19 10:30:18.828745+00	2026-06-19 10:30:18.828745+00
774	6	2026-06-15	6088.962184	manual	2026-06-19 10:30:18.829207+00	2026-06-19 10:30:18.829207+00
775	7	2024-01-01	1666.483947	manual	2026-06-19 10:30:18.833268+00	2026-06-19 10:30:18.833268+00
776	7	2024-01-08	1650.825753	manual	2026-06-19 10:30:18.833871+00	2026-06-19 10:30:18.833871+00
777	7	2024-01-15	1666.164607	manual	2026-06-19 10:30:18.834377+00	2026-06-19 10:30:18.834377+00
778	7	2024-01-22	1671.784105	manual	2026-06-19 10:30:18.835078+00	2026-06-19 10:30:18.835078+00
779	7	2024-01-29	1691.691734	manual	2026-06-19 10:30:18.83558+00	2026-06-19 10:30:18.83558+00
780	7	2024-02-05	1679.262021	manual	2026-06-19 10:30:18.83607+00	2026-06-19 10:30:18.83607+00
781	7	2024-02-12	1687.454009	manual	2026-06-19 10:30:18.836565+00	2026-06-19 10:30:18.836565+00
782	7	2024-02-19	1695.605634	manual	2026-06-19 10:30:18.83704+00	2026-06-19 10:30:18.83704+00
783	7	2024-02-26	1694.306359	manual	2026-06-19 10:30:18.837515+00	2026-06-19 10:30:18.837515+00
784	7	2024-03-04	1703.901595	manual	2026-06-19 10:30:18.837969+00	2026-06-19 10:30:18.837969+00
785	7	2024-03-11	1693.788844	manual	2026-06-19 10:30:18.838438+00	2026-06-19 10:30:18.838438+00
786	7	2024-03-18	1711.593619	manual	2026-06-19 10:30:18.838897+00	2026-06-19 10:30:18.838897+00
787	7	2024-03-25	1737.185269	manual	2026-06-19 10:30:18.839378+00	2026-06-19 10:30:18.839378+00
788	7	2024-04-01	1748.734183	manual	2026-06-19 10:30:18.840429+00	2026-06-19 10:30:18.840429+00
789	7	2024-04-08	1743.483664	manual	2026-06-19 10:30:18.842376+00	2026-06-19 10:30:18.842376+00
790	7	2024-04-15	1755.899821	manual	2026-06-19 10:30:18.843002+00	2026-06-19 10:30:18.843002+00
791	7	2024-04-22	1780.424086	manual	2026-06-19 10:30:18.843504+00	2026-06-19 10:30:18.843504+00
792	7	2024-04-29	1808.387392	manual	2026-06-19 10:30:18.843958+00	2026-06-19 10:30:18.843958+00
793	7	2024-05-06	1793.604386	manual	2026-06-19 10:30:18.844574+00	2026-06-19 10:30:18.844574+00
794	7	2024-05-13	1812.830573	manual	2026-06-19 10:30:18.845044+00	2026-06-19 10:30:18.845044+00
795	7	2024-05-20	1797.242282	manual	2026-06-19 10:30:18.845507+00	2026-06-19 10:30:18.845507+00
796	7	2024-05-27	1796.508299	manual	2026-06-19 10:30:18.845973+00	2026-06-19 10:30:18.845973+00
797	7	2024-06-03	1809.139607	manual	2026-06-19 10:30:18.846523+00	2026-06-19 10:30:18.846523+00
798	7	2024-06-10	1785.807734	manual	2026-06-19 10:30:18.846974+00	2026-06-19 10:30:18.846974+00
799	7	2024-06-17	1770.612324	manual	2026-06-19 10:30:18.847427+00	2026-06-19 10:30:18.847427+00
800	7	2024-06-24	1784.341659	manual	2026-06-19 10:30:18.847897+00	2026-06-19 10:30:18.847897+00
801	7	2024-07-01	1773.110415	manual	2026-06-19 10:30:18.848491+00	2026-06-19 10:30:18.848491+00
802	7	2024-07-08	1757.120700	manual	2026-06-19 10:30:18.848963+00	2026-06-19 10:30:18.848963+00
803	7	2024-07-15	1774.243419	manual	2026-06-19 10:30:18.849395+00	2026-06-19 10:30:18.849395+00
804	7	2024-07-22	1790.383916	manual	2026-06-19 10:30:18.849842+00	2026-06-19 10:30:18.849842+00
805	7	2024-07-29	1775.838495	manual	2026-06-19 10:30:18.850519+00	2026-06-19 10:30:18.850519+00
806	7	2024-08-05	1786.556427	manual	2026-06-19 10:30:18.851055+00	2026-06-19 10:30:18.851055+00
807	7	2024-08-12	1765.401904	manual	2026-06-19 10:30:18.851731+00	2026-06-19 10:30:18.851731+00
808	7	2024-08-19	1754.677633	manual	2026-06-19 10:30:18.852236+00	2026-06-19 10:30:18.852236+00
809	7	2024-08-26	1764.106574	manual	2026-06-19 10:30:18.853293+00	2026-06-19 10:30:18.853293+00
810	7	2024-09-02	1776.838914	manual	2026-06-19 10:30:18.853766+00	2026-06-19 10:30:18.853766+00
811	7	2024-09-09	1769.886540	manual	2026-06-19 10:30:18.854234+00	2026-06-19 10:30:18.854234+00
812	7	2024-09-16	1789.926461	manual	2026-06-19 10:30:18.854711+00	2026-06-19 10:30:18.854711+00
813	7	2024-09-23	1771.267082	manual	2026-06-19 10:30:18.855218+00	2026-06-19 10:30:18.855218+00
814	7	2024-09-30	1779.611203	manual	2026-06-19 10:30:18.855773+00	2026-06-19 10:30:18.855773+00
815	7	2024-10-07	1770.524148	manual	2026-06-19 10:30:18.856412+00	2026-06-19 10:30:18.856412+00
816	7	2024-10-14	1775.397255	manual	2026-06-19 10:30:18.85691+00	2026-06-19 10:30:18.85691+00
817	7	2024-10-21	1754.831080	manual	2026-06-19 10:30:18.857426+00	2026-06-19 10:30:18.857426+00
818	7	2024-10-28	1744.879141	manual	2026-06-19 10:30:18.85799+00	2026-06-19 10:30:18.85799+00
819	7	2024-11-04	1769.437156	manual	2026-06-19 10:30:18.858488+00	2026-06-19 10:30:18.858488+00
820	7	2024-11-11	1754.843952	manual	2026-06-19 10:30:18.858956+00	2026-06-19 10:30:18.858956+00
821	7	2024-11-18	1775.646791	manual	2026-06-19 10:30:18.859504+00	2026-06-19 10:30:18.859504+00
822	7	2024-11-25	1797.039417	manual	2026-06-19 10:30:18.859947+00	2026-06-19 10:30:18.859947+00
823	7	2024-12-02	1773.196229	manual	2026-06-19 10:30:18.860426+00	2026-06-19 10:30:18.860426+00
824	7	2024-12-09	1751.684629	manual	2026-06-19 10:30:18.860878+00	2026-06-19 10:30:18.860878+00
825	7	2024-12-16	1742.747304	manual	2026-06-19 10:30:18.861354+00	2026-06-19 10:30:18.861354+00
826	7	2024-12-23	1743.859972	manual	2026-06-19 10:30:18.861953+00	2026-06-19 10:30:18.861953+00
827	7	2024-12-30	1721.927424	manual	2026-06-19 10:30:18.862418+00	2026-06-19 10:30:18.862418+00
828	7	2025-01-06	1716.364398	manual	2026-06-19 10:30:18.862872+00	2026-06-19 10:30:18.862872+00
829	7	2025-01-13	1694.178700	manual	2026-06-19 10:30:18.863344+00	2026-06-19 10:30:18.863344+00
830	7	2025-01-20	1718.026703	manual	2026-06-19 10:30:18.863799+00	2026-06-19 10:30:18.863799+00
831	7	2025-01-27	1737.519627	manual	2026-06-19 10:30:18.864284+00	2026-06-19 10:30:18.864284+00
832	7	2025-02-03	1743.717085	manual	2026-06-19 10:30:18.864733+00	2026-06-19 10:30:18.864733+00
833	7	2025-02-10	1755.120977	manual	2026-06-19 10:30:18.865187+00	2026-06-19 10:30:18.865187+00
834	7	2025-02-17	1759.164831	manual	2026-06-19 10:30:18.865663+00	2026-06-19 10:30:18.865663+00
835	7	2025-02-24	1748.819703	manual	2026-06-19 10:30:18.866156+00	2026-06-19 10:30:18.866156+00
836	7	2025-03-03	1773.602453	manual	2026-06-19 10:30:18.866607+00	2026-06-19 10:30:18.866607+00
837	7	2025-03-10	1796.273459	manual	2026-06-19 10:30:18.867053+00	2026-06-19 10:30:18.867053+00
838	7	2025-03-17	1788.849022	manual	2026-06-19 10:30:18.867572+00	2026-06-19 10:30:18.867572+00
839	7	2025-03-24	1772.389117	manual	2026-06-19 10:30:18.868696+00	2026-06-19 10:30:18.868696+00
840	7	2025-03-31	1791.100299	manual	2026-06-19 10:30:18.869162+00	2026-06-19 10:30:18.869162+00
841	7	2025-04-07	1778.405417	manual	2026-06-19 10:30:18.870357+00	2026-06-19 10:30:18.870357+00
842	7	2025-04-14	1775.654796	manual	2026-06-19 10:30:18.870867+00	2026-06-19 10:30:18.870867+00
843	7	2025-04-21	1782.152927	manual	2026-06-19 10:30:18.871335+00	2026-06-19 10:30:18.871335+00
844	7	2025-04-28	1802.381205	manual	2026-06-19 10:30:18.871781+00	2026-06-19 10:30:18.871781+00
845	7	2025-05-05	1822.083516	manual	2026-06-19 10:30:18.872241+00	2026-06-19 10:30:18.872241+00
846	7	2025-05-12	1851.508765	manual	2026-06-19 10:30:18.872704+00	2026-06-19 10:30:18.872704+00
847	7	2025-05-19	1827.742514	manual	2026-06-19 10:30:18.873177+00	2026-06-19 10:30:18.873177+00
848	7	2025-05-26	1812.529769	manual	2026-06-19 10:30:18.873729+00	2026-06-19 10:30:18.873729+00
849	7	2025-06-02	1832.550153	manual	2026-06-19 10:30:18.874315+00	2026-06-19 10:30:18.874315+00
850	7	2025-06-09	1818.908921	manual	2026-06-19 10:30:18.874873+00	2026-06-19 10:30:18.874873+00
851	7	2025-06-16	1816.772340	manual	2026-06-19 10:30:18.875482+00	2026-06-19 10:30:18.875482+00
852	7	2025-06-23	1815.422806	manual	2026-06-19 10:30:18.875966+00	2026-06-19 10:30:18.875966+00
853	7	2025-06-30	1797.836363	manual	2026-06-19 10:30:18.876446+00	2026-06-19 10:30:18.876446+00
854	7	2025-07-07	1800.887798	manual	2026-06-19 10:30:18.876927+00	2026-06-19 10:30:18.876927+00
855	7	2025-07-14	1782.857549	manual	2026-06-19 10:30:18.877433+00	2026-06-19 10:30:18.877433+00
856	7	2025-07-21	1808.260395	manual	2026-06-19 10:30:18.877908+00	2026-06-19 10:30:18.877908+00
857	7	2025-07-28	1815.265758	manual	2026-06-19 10:30:18.878359+00	2026-06-19 10:30:18.878359+00
858	7	2025-08-04	1800.845337	manual	2026-06-19 10:30:18.878838+00	2026-06-19 10:30:18.878838+00
859	7	2025-08-11	1781.672325	manual	2026-06-19 10:30:18.879291+00	2026-06-19 10:30:18.879291+00
860	7	2025-08-18	1762.647093	manual	2026-06-19 10:30:18.879798+00	2026-06-19 10:30:18.879798+00
861	7	2025-08-25	1776.162062	manual	2026-06-19 10:30:18.880247+00	2026-06-19 10:30:18.880247+00
862	7	2025-09-01	1783.852098	manual	2026-06-19 10:30:18.8807+00	2026-06-19 10:30:18.8807+00
863	7	2025-09-08	1796.112693	manual	2026-06-19 10:30:18.881154+00	2026-06-19 10:30:18.881154+00
864	7	2025-09-15	1786.743078	manual	2026-06-19 10:30:18.881595+00	2026-06-19 10:30:18.881595+00
865	7	2025-09-22	1779.855985	manual	2026-06-19 10:30:18.882116+00	2026-06-19 10:30:18.882116+00
866	7	2025-09-29	1798.783867	manual	2026-06-19 10:30:18.882562+00	2026-06-19 10:30:18.882562+00
867	7	2025-10-06	1790.495690	manual	2026-06-19 10:30:18.883026+00	2026-06-19 10:30:18.883026+00
868	7	2025-10-13	1774.460617	manual	2026-06-19 10:30:18.883494+00	2026-06-19 10:30:18.883494+00
869	7	2025-10-20	1793.599544	manual	2026-06-19 10:30:18.884625+00	2026-06-19 10:30:18.884625+00
870	7	2025-10-27	1804.373777	manual	2026-06-19 10:30:18.885179+00	2026-06-19 10:30:18.885179+00
871	7	2025-11-03	1825.421197	manual	2026-06-19 10:30:18.88564+00	2026-06-19 10:30:18.88564+00
872	7	2025-11-10	1833.924988	manual	2026-06-19 10:30:18.886113+00	2026-06-19 10:30:18.886113+00
873	7	2025-11-17	1828.145114	manual	2026-06-19 10:30:18.886548+00	2026-06-19 10:30:18.886548+00
874	7	2025-11-24	1811.305829	manual	2026-06-19 10:30:18.887133+00	2026-06-19 10:30:18.887133+00
875	7	2025-12-01	1807.926356	manual	2026-06-19 10:30:18.887577+00	2026-06-19 10:30:18.887577+00
876	7	2025-12-08	1807.055734	manual	2026-06-19 10:30:18.888023+00	2026-06-19 10:30:18.888023+00
877	7	2025-12-15	1786.369098	manual	2026-06-19 10:30:18.888483+00	2026-06-19 10:30:18.888483+00
878	7	2025-12-22	1784.435467	manual	2026-06-19 10:30:18.888922+00	2026-06-19 10:30:18.888922+00
879	7	2025-12-29	1764.268142	manual	2026-06-19 10:30:18.889363+00	2026-06-19 10:30:18.889363+00
880	7	2026-01-05	1772.629138	manual	2026-06-19 10:30:18.889839+00	2026-06-19 10:30:18.889839+00
881	7	2026-01-12	1751.024731	manual	2026-06-19 10:30:18.890321+00	2026-06-19 10:30:18.890321+00
882	7	2026-01-19	1774.372060	manual	2026-06-19 10:30:18.890817+00	2026-06-19 10:30:18.890817+00
883	7	2026-01-26	1801.637756	manual	2026-06-19 10:30:18.891368+00	2026-06-19 10:30:18.891368+00
884	7	2026-02-02	1787.866015	manual	2026-06-19 10:30:18.891854+00	2026-06-19 10:30:18.891854+00
885	7	2026-02-09	1799.625491	manual	2026-06-19 10:30:18.892334+00	2026-06-19 10:30:18.892334+00
886	7	2026-02-16	1793.552447	manual	2026-06-19 10:30:18.89286+00	2026-06-19 10:30:18.89286+00
887	7	2026-02-23	1778.456687	manual	2026-06-19 10:30:18.893331+00	2026-06-19 10:30:18.893331+00
888	7	2026-03-02	1795.136715	manual	2026-06-19 10:30:18.893798+00	2026-06-19 10:30:18.893798+00
889	7	2026-03-09	1815.245235	manual	2026-06-19 10:30:18.894252+00	2026-06-19 10:30:18.894252+00
890	7	2026-03-16	1835.815100	manual	2026-06-19 10:30:18.894728+00	2026-06-19 10:30:18.894728+00
891	7	2026-03-23	1858.944861	manual	2026-06-19 10:30:18.895229+00	2026-06-19 10:30:18.895229+00
892	7	2026-03-30	1860.543881	manual	2026-06-19 10:30:18.895699+00	2026-06-19 10:30:18.895699+00
893	7	2026-04-06	1846.673507	manual	2026-06-19 10:30:18.896194+00	2026-06-19 10:30:18.896194+00
894	7	2026-04-13	1869.995367	manual	2026-06-19 10:30:18.896678+00	2026-06-19 10:30:18.896678+00
895	7	2026-04-20	1858.075592	manual	2026-06-19 10:30:18.897154+00	2026-06-19 10:30:18.897154+00
896	7	2026-04-27	1849.847970	manual	2026-06-19 10:30:18.897635+00	2026-06-19 10:30:18.897635+00
897	7	2026-05-04	1826.498386	manual	2026-06-19 10:30:18.898112+00	2026-06-19 10:30:18.898112+00
898	7	2026-05-11	1807.273096	manual	2026-06-19 10:30:18.898589+00	2026-06-19 10:30:18.898589+00
899	7	2026-05-18	1829.402967	manual	2026-06-19 10:30:18.89907+00	2026-06-19 10:30:18.89907+00
900	7	2026-05-25	1808.508764	manual	2026-06-19 10:30:18.899541+00	2026-06-19 10:30:18.899541+00
901	7	2026-06-01	1795.428981	manual	2026-06-19 10:30:18.900018+00	2026-06-19 10:30:18.900018+00
902	7	2026-06-08	1802.860859	manual	2026-06-19 10:30:18.900535+00	2026-06-19 10:30:18.900535+00
903	7	2026-06-15	1801.771090	manual	2026-06-19 10:30:18.900996+00	2026-06-19 10:30:18.900996+00
\.


ALTER TABLE public.asset_price_history ENABLE TRIGGER ALL;

--
-- Data for Name: attachments; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.attachments DISABLE TRIGGER ALL;

COPY public.attachments (id, transaction_id, filename, stored_path, mime_type, size_bytes, created_at) FROM stdin;
\.


ALTER TABLE public.attachments ENABLE TRIGGER ALL;

--
-- Data for Name: belfius_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.belfius_raw_transactions DISABLE TRIGGER ALL;

COPY public.belfius_raw_transactions (id, deduplication_hash, created_at, account_number, transaction_date, statement_number, transaction_number, recipient_account, recipient_name, recipient_street, recipient_location, recipient_bic, recipient_country, transaction_description, value_date, amount, currency, balance, additional_message, raw_csv_line) FROM stdin;
\.


ALTER TABLE public.belfius_raw_transactions ENABLE TRIGGER ALL;

--
-- Data for Name: belgian_inflation_rates; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.belgian_inflation_rates DISABLE TRIGGER ALL;

COPY public.belgian_inflation_rates (id, month_date, monthly_rate, source, fetched_at, updated_at) FROM stdin;
\.


ALTER TABLE public.belgian_inflation_rates ENABLE TRIGGER ALL;

--
-- Data for Name: cashflow_forecast_accuracy; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.cashflow_forecast_accuracy DISABLE TRIGGER ALL;

COPY public.cashflow_forecast_accuracy (id, user_id, method_id, as_of_month, mae, rmse, mape, sample_days, recorded_at) FROM stdin;
\.


ALTER TABLE public.cashflow_forecast_accuracy ENABLE TRIGGER ALL;

--
-- Data for Name: cashflow_forecast_mc; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.cashflow_forecast_mc DISABLE TRIGGER ALL;

COPY public.cashflow_forecast_mc (id, user_id, month, filter_hash, mc_paths, payload, computed_at) FROM stdin;
\.


ALTER TABLE public.cashflow_forecast_mc ENABLE TRIGGER ALL;

--
-- Data for Name: cashflow_forecast_mc_rolling; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.cashflow_forecast_mc_rolling DISABLE TRIGGER ALL;

COPY public.cashflow_forecast_mc_rolling (id, user_id, today_iso, days_back, days_forward, filter_hash, mc_paths, payload, computed_at) FROM stdin;
\.


ALTER TABLE public.cashflow_forecast_mc_rolling ENABLE TRIGGER ALL;

--
-- Data for Name: custom_parser_configs; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.custom_parser_configs DISABLE TRIGGER ALL;

COPY public.custom_parser_configs (id, name, config_json, created_at, updated_at, kind) FROM stdin;
\.


ALTER TABLE public.custom_parser_configs ENABLE TRIGGER ALL;

--
-- Data for Name: custom_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.custom_raw_transactions DISABLE TRIGGER ALL;

COPY public.custom_raw_transactions (id, deduplication_hash, created_at, date, description, amount, currency, counterparty_name, counterparty_account, balance, category_name, comments, raw_csv_line, raw_metadata) FROM stdin;
\.


ALTER TABLE public.custom_raw_transactions ENABLE TRIGGER ALL;

--
-- Data for Name: db_editor_audit; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.db_editor_audit DISABLE TRIGGER ALL;

COPY public.db_editor_audit (id, table_name, op, pk_json, before_json, after_json, statement, created_at) FROM stdin;
\.


ALTER TABLE public.db_editor_audit ENABLE TRIGGER ALL;

--
-- Data for Name: exchange_rates; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.exchange_rates DISABLE TRIGGER ALL;

COPY public.exchange_rates (id, currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) FROM stdin;
1	USD	0.9118610352	2024-01-01	f	2026-06-19 10:30:18.314604+00	2026-06-19 10:30:18.314604+00
2	USD	0.9031582054	2024-01-08	f	2026-06-19 10:30:18.31553+00	2026-06-19 10:30:18.31553+00
3	USD	0.8967868894	2024-01-15	f	2026-06-19 10:30:18.315974+00	2026-06-19 10:30:18.315974+00
4	USD	0.8893809931	2024-01-22	f	2026-06-19 10:30:18.316426+00	2026-06-19 10:30:18.316426+00
5	USD	0.8940772059	2024-01-29	f	2026-06-19 10:30:18.316866+00	2026-06-19 10:30:18.316866+00
6	USD	0.8888122327	2024-02-05	f	2026-06-19 10:30:18.317297+00	2026-06-19 10:30:18.317297+00
7	USD	0.8937491141	2024-02-12	f	2026-06-19 10:30:18.318413+00	2026-06-19 10:30:18.318413+00
8	USD	0.8976912368	2024-02-19	f	2026-06-19 10:30:18.318863+00	2026-06-19 10:30:18.318863+00
9	USD	0.8910760817	2024-02-26	f	2026-06-19 10:30:18.31932+00	2026-06-19 10:30:18.31932+00
10	USD	0.8886438569	2024-03-04	f	2026-06-19 10:30:18.319753+00	2026-06-19 10:30:18.319753+00
11	USD	0.8884082906	2024-03-11	f	2026-06-19 10:30:18.320208+00	2026-06-19 10:30:18.320208+00
12	USD	0.8854392794	2024-03-18	f	2026-06-19 10:30:18.320644+00	2026-06-19 10:30:18.320644+00
13	USD	0.8783362213	2024-03-25	f	2026-06-19 10:30:18.321122+00	2026-06-19 10:30:18.321122+00
14	USD	0.8771657625	2024-04-01	f	2026-06-19 10:30:18.321623+00	2026-06-19 10:30:18.321623+00
15	USD	0.8749523555	2024-04-08	f	2026-06-19 10:30:18.322103+00	2026-06-19 10:30:18.322103+00
16	USD	0.8694378768	2024-04-15	f	2026-06-19 10:30:18.322531+00	2026-06-19 10:30:18.322531+00
17	USD	0.8734079044	2024-04-22	f	2026-06-19 10:30:18.322963+00	2026-06-19 10:30:18.322963+00
18	USD	0.8817148202	2024-04-29	f	2026-06-19 10:30:18.323413+00	2026-06-19 10:30:18.323413+00
19	USD	0.8819068056	2024-05-06	f	2026-06-19 10:30:18.323861+00	2026-06-19 10:30:18.323861+00
20	USD	0.8756607776	2024-05-13	f	2026-06-19 10:30:18.324312+00	2026-06-19 10:30:18.324312+00
21	USD	0.8717756947	2024-05-20	f	2026-06-19 10:30:18.324777+00	2026-06-19 10:30:18.324777+00
22	USD	0.8693017212	2024-05-27	f	2026-06-19 10:30:18.325192+00	2026-06-19 10:30:18.325192+00
23	USD	0.8718296775	2024-06-03	f	2026-06-19 10:30:18.325672+00	2026-06-19 10:30:18.325672+00
24	USD	0.8734675170	2024-06-10	f	2026-06-19 10:30:18.326149+00	2026-06-19 10:30:18.326149+00
25	USD	0.8676354663	2024-06-17	f	2026-06-19 10:30:18.326605+00	2026-06-19 10:30:18.326605+00
26	USD	0.8751303179	2024-06-24	f	2026-06-19 10:30:18.327074+00	2026-06-19 10:30:18.327074+00
27	USD	0.8811893995	2024-07-01	f	2026-06-19 10:30:18.327519+00	2026-06-19 10:30:18.327519+00
28	USD	0.8852291997	2024-07-08	f	2026-06-19 10:30:18.327961+00	2026-06-19 10:30:18.327961+00
29	USD	0.8779941916	2024-07-15	f	2026-06-19 10:30:18.328431+00	2026-06-19 10:30:18.328431+00
30	USD	0.8800441354	2024-07-22	f	2026-06-19 10:30:18.328879+00	2026-06-19 10:30:18.328879+00
31	USD	0.8771805102	2024-07-29	f	2026-06-19 10:30:18.32932+00	2026-06-19 10:30:18.32932+00
32	USD	0.8689820327	2024-08-05	f	2026-06-19 10:30:18.329754+00	2026-06-19 10:30:18.329754+00
33	USD	0.8692599120	2024-08-12	f	2026-06-19 10:30:18.330189+00	2026-06-19 10:30:18.330189+00
34	USD	0.8757967872	2024-08-19	f	2026-06-19 10:30:18.330629+00	2026-06-19 10:30:18.330629+00
35	USD	0.8681544449	2024-08-26	f	2026-06-19 10:30:18.331078+00	2026-06-19 10:30:18.331078+00
36	USD	0.8647367633	2024-09-02	f	2026-06-19 10:30:18.331504+00	2026-06-19 10:30:18.331504+00
37	USD	0.8578257193	2024-09-09	f	2026-06-19 10:30:18.331947+00	2026-06-19 10:30:18.331947+00
38	USD	0.8659393323	2024-09-16	f	2026-06-19 10:30:18.332397+00	2026-06-19 10:30:18.332397+00
39	USD	0.8642551065	2024-09-23	f	2026-06-19 10:30:18.332837+00	2026-06-19 10:30:18.332837+00
40	USD	0.8723543156	2024-09-30	f	2026-06-19 10:30:18.33328+00	2026-06-19 10:30:18.33328+00
41	USD	0.8720641317	2024-10-07	f	2026-06-19 10:30:18.333746+00	2026-06-19 10:30:18.333746+00
42	USD	0.8677464004	2024-10-14	f	2026-06-19 10:30:18.334707+00	2026-06-19 10:30:18.334707+00
43	USD	0.8700826048	2024-10-21	f	2026-06-19 10:30:18.335239+00	2026-06-19 10:30:18.335239+00
44	USD	0.8650776471	2024-10-28	f	2026-06-19 10:30:18.33568+00	2026-06-19 10:30:18.33568+00
45	USD	0.8588172155	2024-11-04	f	2026-06-19 10:30:18.336104+00	2026-06-19 10:30:18.336104+00
46	USD	0.8513259185	2024-11-11	f	2026-06-19 10:30:18.336533+00	2026-06-19 10:30:18.336533+00
47	USD	0.8512806229	2024-11-18	f	2026-06-19 10:30:18.337048+00	2026-06-19 10:30:18.337048+00
48	USD	0.8536267857	2024-11-25	f	2026-06-19 10:30:18.337483+00	2026-06-19 10:30:18.337483+00
49	USD	0.8512816361	2024-12-02	f	2026-06-19 10:30:18.337916+00	2026-06-19 10:30:18.337916+00
50	USD	0.8555438768	2024-12-09	f	2026-06-19 10:30:18.338346+00	2026-06-19 10:30:18.338346+00
51	USD	0.8626684729	2024-12-16	f	2026-06-19 10:30:18.338773+00	2026-06-19 10:30:18.338773+00
52	USD	0.8661706118	2024-12-23	f	2026-06-19 10:30:18.339225+00	2026-06-19 10:30:18.339225+00
53	USD	0.8591213802	2024-12-30	f	2026-06-19 10:30:18.339658+00	2026-06-19 10:30:18.339658+00
54	USD	0.8571425084	2025-01-06	f	2026-06-19 10:30:18.340104+00	2026-06-19 10:30:18.340104+00
55	USD	0.8646804102	2025-01-13	f	2026-06-19 10:30:18.340553+00	2026-06-19 10:30:18.340553+00
56	USD	0.8634152984	2025-01-20	f	2026-06-19 10:30:18.340978+00	2026-06-19 10:30:18.340978+00
57	USD	0.8551473767	2025-01-27	f	2026-06-19 10:30:18.341438+00	2026-06-19 10:30:18.341438+00
58	USD	0.8586484826	2025-02-03	f	2026-06-19 10:30:18.341882+00	2026-06-19 10:30:18.341882+00
59	USD	0.8584299189	2025-02-10	f	2026-06-19 10:30:18.342389+00	2026-06-19 10:30:18.342389+00
60	USD	0.8640882652	2025-02-17	f	2026-06-19 10:30:18.342852+00	2026-06-19 10:30:18.342852+00
61	USD	0.8676927382	2025-02-24	f	2026-06-19 10:30:18.343318+00	2026-06-19 10:30:18.343318+00
62	USD	0.8739873508	2025-03-03	f	2026-06-19 10:30:18.343747+00	2026-06-19 10:30:18.343747+00
63	USD	0.8824480340	2025-03-10	f	2026-06-19 10:30:18.344189+00	2026-06-19 10:30:18.344189+00
64	USD	0.8855612702	2025-03-17	f	2026-06-19 10:30:18.34464+00	2026-06-19 10:30:18.34464+00
65	USD	0.8884428241	2025-03-24	f	2026-06-19 10:30:18.345064+00	2026-06-19 10:30:18.345064+00
66	USD	0.8892710358	2025-03-31	f	2026-06-19 10:30:18.346417+00	2026-06-19 10:30:18.346417+00
67	USD	0.8885734840	2025-04-07	f	2026-06-19 10:30:18.346969+00	2026-06-19 10:30:18.346969+00
68	USD	0.8973660914	2025-04-14	f	2026-06-19 10:30:18.347419+00	2026-06-19 10:30:18.347419+00
69	USD	0.8941870921	2025-04-21	f	2026-06-19 10:30:18.347897+00	2026-06-19 10:30:18.347897+00
70	USD	0.8926408211	2025-04-28	f	2026-06-19 10:30:18.348328+00	2026-06-19 10:30:18.348328+00
71	USD	0.9013213673	2025-05-05	f	2026-06-19 10:30:18.348798+00	2026-06-19 10:30:18.348798+00
72	USD	0.8924943819	2025-05-12	f	2026-06-19 10:30:18.349244+00	2026-06-19 10:30:18.349244+00
73	USD	0.8925512156	2025-05-19	f	2026-06-19 10:30:18.34967+00	2026-06-19 10:30:18.34967+00
74	USD	0.8881311534	2025-05-26	f	2026-06-19 10:30:18.350328+00	2026-06-19 10:30:18.350328+00
75	USD	0.8938167398	2025-06-02	f	2026-06-19 10:30:18.350857+00	2026-06-19 10:30:18.350857+00
76	USD	0.8918278513	2025-06-09	f	2026-06-19 10:30:18.351316+00	2026-06-19 10:30:18.351316+00
77	USD	0.8830864498	2025-06-16	f	2026-06-19 10:30:18.351793+00	2026-06-19 10:30:18.351793+00
78	USD	0.8759192511	2025-06-23	f	2026-06-19 10:30:18.352283+00	2026-06-19 10:30:18.352283+00
79	USD	0.8784091631	2025-06-30	f	2026-06-19 10:30:18.352716+00	2026-06-19 10:30:18.352716+00
80	USD	0.8746657579	2025-07-07	f	2026-06-19 10:30:18.353139+00	2026-06-19 10:30:18.353139+00
81	USD	0.8763052227	2025-07-14	f	2026-06-19 10:30:18.353552+00	2026-06-19 10:30:18.353552+00
82	USD	0.8744933422	2025-07-21	f	2026-06-19 10:30:18.354053+00	2026-06-19 10:30:18.354053+00
83	USD	0.8685279295	2025-07-28	f	2026-06-19 10:30:18.354533+00	2026-06-19 10:30:18.354533+00
84	USD	0.8685218517	2025-08-04	f	2026-06-19 10:30:18.355017+00	2026-06-19 10:30:18.355017+00
85	USD	0.8651527800	2025-08-11	f	2026-06-19 10:30:18.35548+00	2026-06-19 10:30:18.35548+00
86	USD	0.8572946764	2025-08-18	f	2026-06-19 10:30:18.35597+00	2026-06-19 10:30:18.35597+00
87	USD	0.8633259641	2025-08-25	f	2026-06-19 10:30:18.356582+00	2026-06-19 10:30:18.356582+00
88	USD	0.8640566592	2025-09-01	f	2026-06-19 10:30:18.357884+00	2026-06-19 10:30:18.357884+00
89	USD	0.8724369324	2025-09-08	f	2026-06-19 10:30:18.358424+00	2026-06-19 10:30:18.358424+00
90	USD	0.8649910668	2025-09-15	f	2026-06-19 10:30:18.359949+00	2026-06-19 10:30:18.359949+00
91	USD	0.8613783036	2025-09-22	f	2026-06-19 10:30:18.360385+00	2026-06-19 10:30:18.360385+00
92	USD	0.8604117685	2025-09-29	f	2026-06-19 10:30:18.360816+00	2026-06-19 10:30:18.360816+00
93	USD	0.8576441756	2025-10-06	f	2026-06-19 10:30:18.361269+00	2026-06-19 10:30:18.361269+00
94	USD	0.8590913015	2025-10-13	f	2026-06-19 10:30:18.361687+00	2026-06-19 10:30:18.361687+00
95	USD	0.8632390043	2025-10-20	f	2026-06-19 10:30:18.362138+00	2026-06-19 10:30:18.362138+00
96	USD	0.8700032264	2025-10-27	f	2026-06-19 10:30:18.363317+00	2026-06-19 10:30:18.363317+00
97	USD	0.8714159139	2025-11-03	f	2026-06-19 10:30:18.363859+00	2026-06-19 10:30:18.363859+00
98	USD	0.8672895216	2025-11-10	f	2026-06-19 10:30:18.364353+00	2026-06-19 10:30:18.364353+00
99	USD	0.8597488995	2025-11-17	f	2026-06-19 10:30:18.364765+00	2026-06-19 10:30:18.364765+00
100	USD	0.8600511057	2025-11-24	f	2026-06-19 10:30:18.366468+00	2026-06-19 10:30:18.366468+00
101	USD	0.8684742176	2025-12-01	f	2026-06-19 10:30:18.366966+00	2026-06-19 10:30:18.366966+00
102	USD	0.8643719294	2025-12-08	f	2026-06-19 10:30:18.36807+00	2026-06-19 10:30:18.36807+00
103	USD	0.8698448335	2025-12-15	f	2026-06-19 10:30:18.368732+00	2026-06-19 10:30:18.368732+00
104	USD	0.8699531866	2025-12-22	f	2026-06-19 10:30:18.369184+00	2026-06-19 10:30:18.369184+00
105	USD	0.8629792305	2025-12-29	f	2026-06-19 10:30:18.369611+00	2026-06-19 10:30:18.369611+00
106	USD	0.8566174247	2026-01-05	f	2026-06-19 10:30:18.370027+00	2026-06-19 10:30:18.370027+00
107	USD	0.8524281070	2026-01-12	f	2026-06-19 10:30:18.370445+00	2026-06-19 10:30:18.370445+00
108	USD	0.8497147094	2026-01-19	f	2026-06-19 10:30:18.370858+00	2026-06-19 10:30:18.370858+00
109	USD	0.8428594244	2026-01-26	f	2026-06-19 10:30:18.371425+00	2026-06-19 10:30:18.371425+00
110	USD	0.8400000000	2026-02-02	f	2026-06-19 10:30:18.371832+00	2026-06-19 10:30:18.371832+00
111	USD	0.8472823755	2026-02-09	f	2026-06-19 10:30:18.372247+00	2026-06-19 10:30:18.372247+00
112	USD	0.8447455796	2026-02-16	f	2026-06-19 10:30:18.372693+00	2026-06-19 10:30:18.372693+00
113	USD	0.8457657775	2026-02-23	f	2026-06-19 10:30:18.373107+00	2026-06-19 10:30:18.373107+00
114	USD	0.8533011620	2026-03-02	f	2026-06-19 10:30:18.373513+00	2026-06-19 10:30:18.373513+00
115	USD	0.8495349254	2026-03-09	f	2026-06-19 10:30:18.373919+00	2026-06-19 10:30:18.373919+00
116	USD	0.8523118891	2026-03-16	f	2026-06-19 10:30:18.374315+00	2026-06-19 10:30:18.374315+00
117	USD	0.8607038416	2026-03-23	f	2026-06-19 10:30:18.374739+00	2026-06-19 10:30:18.374739+00
118	USD	0.8653152676	2026-03-30	f	2026-06-19 10:30:18.375185+00	2026-06-19 10:30:18.375185+00
119	USD	0.8704484157	2026-04-06	f	2026-06-19 10:30:18.375605+00	2026-06-19 10:30:18.375605+00
120	USD	0.8673166150	2026-04-13	f	2026-06-19 10:30:18.376003+00	2026-06-19 10:30:18.376003+00
121	USD	0.8744641827	2026-04-20	f	2026-06-19 10:30:18.376414+00	2026-06-19 10:30:18.376414+00
122	USD	0.8787145828	2026-04-27	f	2026-06-19 10:30:18.376816+00	2026-06-19 10:30:18.376816+00
123	USD	0.8867327161	2026-05-04	f	2026-06-19 10:30:18.377217+00	2026-06-19 10:30:18.377217+00
124	USD	0.8917498199	2026-05-11	f	2026-06-19 10:30:18.377629+00	2026-06-19 10:30:18.377629+00
125	USD	0.8905752880	2026-05-18	f	2026-06-19 10:30:18.378035+00	2026-06-19 10:30:18.378035+00
126	USD	0.8991855351	2026-05-25	f	2026-06-19 10:30:18.378451+00	2026-06-19 10:30:18.378451+00
127	USD	0.8907634303	2026-06-01	f	2026-06-19 10:30:18.37884+00	2026-06-19 10:30:18.37884+00
128	USD	0.8828150755	2026-06-08	f	2026-06-19 10:30:18.379237+00	2026-06-19 10:30:18.379237+00
129	USD	0.8889830928	2026-06-15	t	2026-06-19 10:30:18.379627+00	2026-06-19 10:30:18.379627+00
\.


ALTER TABLE public.exchange_rates ENABLE TRIGGER ALL;

--
-- Data for Name: import_staging_rows; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.import_staging_rows DISABLE TRIGGER ALL;

COPY public.import_staging_rows (id, batch_id, row_index, status, tx_date, bank_account, recipient_raw, memo, amount, currency, balance, recipient_account, recipient_address, recipient_bank_name, comment, raw_data, tx_hash, resolved_recipient_id, resolved_bank_account_id, error_message, created_at, match_source, matched_pattern_id, match_similarity, user_override_recipient_id, override_category_id) FROM stdin;
\.


ALTER TABLE public.import_staging_rows ENABLE TRIGGER ALL;

--
-- Data for Name: instrument_provider_map; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.instrument_provider_map DISABLE TRIGGER ALL;

COPY public.instrument_provider_map (id, instrument_key, key_type, provider, provider_symbol, resolved_name, exchange, currency, status, verified_at, created_at, updated_at) FROM stdin;
\.


ALTER TABLE public.instrument_provider_map ENABLE TRIGGER ALL;

--
-- Data for Name: kbc_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.kbc_raw_transactions DISABLE TRIGGER ALL;

COPY public.kbc_raw_transactions (id, deduplication_hash, created_at, account_number, category_name, account_holder_name, currency, statement_number, transaction_date, value_date, description, amount, balance, credit_amount, debit_amount, counterparty_account, counterparty_bic, counterparty_name, counterparty_address, structured_communication, free_communication, raw_csv_line) FROM stdin;
\.


ALTER TABLE public.kbc_raw_transactions ENABLE TRIGGER ALL;

--
-- Data for Name: manual_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.manual_raw_transactions DISABLE TRIGGER ALL;

COPY public.manual_raw_transactions (id, deduplication_hash, created_at, transaction_id, date, bank_account, recipient_id, amount, memo, currency, category_id, comment) FROM stdin;
\.


ALTER TABLE public.manual_raw_transactions ENABLE TRIGGER ALL;

--
-- Data for Name: planned_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.planned_transactions DISABLE TRIGGER ALL;

COPY public.planned_transactions (id, planned_date, amount, currency, memo, comment, url, bank_account, recipient_id, category_id, is_recurring, recurrence_pattern, is_loan, loan_type, loan_principal, loan_annual_interest_rate, loan_term_months, loan_start_date, loan_payment_day, loan_regular_payment_amount, loan_first_payment_date, is_executed, last_executed_date, is_active, created_at, updated_at, reminder_days_before, account_id) FROM stdin;
1	2026-06-25	3502.00	EUR	Loon (gepland)	\N	\N	\N	1	1	t	monthly	f	\N	\N	\N	\N	\N	\N	\N	\N	f	\N	t	2026-06-19 10:30:18.150658+00	2026-06-19 10:30:18.150658+00	\N	\N
2	2026-07-05	1442.00	EUR	Loon partner (gepland)	\N	\N	\N	2	1	t	monthly	f	\N	\N	\N	\N	\N	\N	\N	\N	f	\N	t	2026-06-19 10:30:18.152043+00	2026-06-19 10:30:18.152043+00	\N	\N
3	2026-06-18	-13.99	EUR	Netflix (gepland)	\N	\N	\N	8	22	t	monthly	f	\N	\N	\N	\N	\N	\N	\N	\N	f	\N	t	2026-06-19 10:30:18.152591+00	2026-06-19 10:30:18.152591+00	\N	\N
4	2026-07-02	-29.99	EUR	Fitness (gepland)	\N	\N	\N	11	23	t	monthly	f	\N	\N	\N	\N	\N	\N	\N	\N	f	\N	t	2026-06-19 10:30:18.153155+00	2026-06-19 10:30:18.153155+00	\N	\N
5	2026-06-20	-500.00	EUR	Maandelijkse belegging	\N	\N	\N	16	30	t	monthly	f	\N	\N	\N	\N	\N	\N	\N	\N	f	\N	t	2026-06-19 10:30:18.153701+00	2026-06-19 10:30:18.153701+00	\N	\N
6	2026-08-14	-612.40	EUR	Autoverzekering jaarpremie	\N	\N	\N	12	10	f	\N	f	\N	\N	\N	\N	\N	\N	\N	\N	f	\N	t	2026-06-19 10:30:18.154287+00	2026-06-19 10:30:18.154287+00	7	\N
7	2026-10-15	-1180.00	EUR	Personenbelasting (verwacht)	\N	\N	\N	18	32	f	\N	f	\N	\N	\N	\N	\N	\N	\N	\N	f	\N	t	2026-06-19 10:30:18.154819+00	2026-06-19 10:30:18.154819+00	14	\N
8	2026-07-01	-932.48	EUR	Hypotheek woning Gent	\N	\N	\N	53	7	t	monthly	t	annuity	220000.00	2.0000	300	2018-05-01	3	932.48	2018-05-01	f	\N	t	2026-06-19 10:30:18.155308+00	2026-06-19 10:30:18.155308+00	\N	\N
\.


ALTER TABLE public.planned_transactions ENABLE TRIGGER ALL;

--
-- Data for Name: planned_transaction_executions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.planned_transaction_executions DISABLE TRIGGER ALL;

COPY public.planned_transaction_executions (id, planned_transaction_id, executed_transaction_id, execution_date, created_at) FROM stdin;
\.


ALTER TABLE public.planned_transaction_executions ENABLE TRIGGER ALL;

--
-- Data for Name: planned_transaction_loan_schedule; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.planned_transaction_loan_schedule DISABLE TRIGGER ALL;

COPY public.planned_transaction_loan_schedule (id, planned_transaction_id, installment_number, due_date, payment_amount, principal_amount, interest_amount, remaining_principal, created_at, updated_at) FROM stdin;
1	8	1	2018-06-01	932.48	565.81	366.67	219434.19	2026-06-19 10:30:18.155814+00	2026-06-19 10:30:18.155814+00
2	8	2	2018-07-01	932.48	566.76	365.72	218867.43	2026-06-19 10:30:18.156784+00	2026-06-19 10:30:18.156784+00
3	8	3	2018-08-01	932.48	567.70	364.78	218299.73	2026-06-19 10:30:18.157258+00	2026-06-19 10:30:18.157258+00
4	8	4	2018-09-01	932.48	568.65	363.83	217731.08	2026-06-19 10:30:18.157842+00	2026-06-19 10:30:18.157842+00
5	8	5	2018-10-01	932.48	569.59	362.89	217161.49	2026-06-19 10:30:18.158321+00	2026-06-19 10:30:18.158321+00
6	8	6	2018-11-01	932.48	570.54	361.94	216590.95	2026-06-19 10:30:18.158842+00	2026-06-19 10:30:18.158842+00
7	8	7	2018-12-01	932.48	571.49	360.98	216019.45	2026-06-19 10:30:18.159312+00	2026-06-19 10:30:18.159312+00
8	8	8	2019-01-01	932.48	572.45	360.03	215447.00	2026-06-19 10:30:18.159788+00	2026-06-19 10:30:18.159788+00
9	8	9	2019-02-01	932.48	573.40	359.08	214873.60	2026-06-19 10:30:18.160283+00	2026-06-19 10:30:18.160283+00
10	8	10	2019-03-01	932.48	574.36	358.12	214299.25	2026-06-19 10:30:18.160817+00	2026-06-19 10:30:18.160817+00
11	8	11	2019-04-01	932.48	575.31	357.17	213723.93	2026-06-19 10:30:18.161374+00	2026-06-19 10:30:18.161374+00
12	8	12	2019-05-01	932.48	576.27	356.21	213147.66	2026-06-19 10:30:18.161861+00	2026-06-19 10:30:18.161861+00
13	8	13	2019-06-01	932.48	577.23	355.25	212570.43	2026-06-19 10:30:18.16231+00	2026-06-19 10:30:18.16231+00
14	8	14	2019-07-01	932.48	578.20	354.28	211992.23	2026-06-19 10:30:18.163158+00	2026-06-19 10:30:18.163158+00
15	8	15	2019-08-01	932.48	579.16	353.32	211413.07	2026-06-19 10:30:18.163631+00	2026-06-19 10:30:18.163631+00
16	8	16	2019-09-01	932.48	580.12	352.36	210832.95	2026-06-19 10:30:18.164104+00	2026-06-19 10:30:18.164104+00
17	8	17	2019-10-01	932.48	581.09	351.39	210251.86	2026-06-19 10:30:18.164579+00	2026-06-19 10:30:18.164579+00
18	8	18	2019-11-01	932.48	582.06	350.42	209669.80	2026-06-19 10:30:18.165053+00	2026-06-19 10:30:18.165053+00
19	8	19	2019-12-01	932.48	583.03	349.45	209086.77	2026-06-19 10:30:18.165573+00	2026-06-19 10:30:18.165573+00
20	8	20	2020-01-01	932.48	584.00	348.48	208502.76	2026-06-19 10:30:18.166049+00	2026-06-19 10:30:18.166049+00
21	8	21	2020-02-01	932.48	584.97	347.50	207917.79	2026-06-19 10:30:18.166845+00	2026-06-19 10:30:18.166845+00
22	8	22	2020-03-01	932.48	585.95	346.53	207331.84	2026-06-19 10:30:18.167314+00	2026-06-19 10:30:18.167314+00
23	8	23	2020-04-01	932.48	586.93	345.55	206744.91	2026-06-19 10:30:18.167766+00	2026-06-19 10:30:18.167766+00
24	8	24	2020-05-01	932.48	587.90	344.57	206157.01	2026-06-19 10:30:18.168217+00	2026-06-19 10:30:18.168217+00
25	8	25	2020-06-01	932.48	588.88	343.60	205568.12	2026-06-19 10:30:18.16867+00	2026-06-19 10:30:18.16867+00
26	8	26	2020-07-01	932.48	589.87	342.61	204978.26	2026-06-19 10:30:18.169128+00	2026-06-19 10:30:18.169128+00
27	8	27	2020-08-01	932.48	590.85	341.63	204387.41	2026-06-19 10:30:18.169579+00	2026-06-19 10:30:18.169579+00
28	8	28	2020-09-01	932.48	591.83	340.65	203795.57	2026-06-19 10:30:18.17002+00	2026-06-19 10:30:18.17002+00
29	8	29	2020-10-01	932.48	592.82	339.66	203202.75	2026-06-19 10:30:18.170494+00	2026-06-19 10:30:18.170494+00
30	8	30	2020-11-01	932.48	593.81	338.67	202608.95	2026-06-19 10:30:18.170919+00	2026-06-19 10:30:18.170919+00
31	8	31	2020-12-01	932.48	594.80	337.68	202014.15	2026-06-19 10:30:18.171394+00	2026-06-19 10:30:18.171394+00
32	8	32	2021-01-01	932.48	595.79	336.69	201418.36	2026-06-19 10:30:18.17185+00	2026-06-19 10:30:18.17185+00
33	8	33	2021-02-01	932.48	596.78	335.70	200821.58	2026-06-19 10:30:18.172297+00	2026-06-19 10:30:18.172297+00
34	8	34	2021-03-01	932.48	597.78	334.70	200223.80	2026-06-19 10:30:18.172784+00	2026-06-19 10:30:18.172784+00
35	8	35	2021-04-01	932.48	598.77	333.71	199625.03	2026-06-19 10:30:18.173238+00	2026-06-19 10:30:18.173238+00
36	8	36	2021-05-01	932.48	599.77	332.71	199025.25	2026-06-19 10:30:18.173686+00	2026-06-19 10:30:18.173686+00
37	8	37	2021-06-01	932.48	600.77	331.71	198424.48	2026-06-19 10:30:18.174146+00	2026-06-19 10:30:18.174146+00
38	8	38	2021-07-01	932.48	601.77	330.71	197822.71	2026-06-19 10:30:18.174609+00	2026-06-19 10:30:18.174609+00
39	8	39	2021-08-01	932.48	602.78	329.70	197219.94	2026-06-19 10:30:18.175091+00	2026-06-19 10:30:18.175091+00
40	8	40	2021-09-01	932.48	603.78	328.70	196616.16	2026-06-19 10:30:18.175711+00	2026-06-19 10:30:18.175711+00
41	8	41	2021-10-01	932.48	604.79	327.69	196011.37	2026-06-19 10:30:18.176174+00	2026-06-19 10:30:18.176174+00
42	8	42	2021-11-01	932.48	605.79	326.69	195405.58	2026-06-19 10:30:18.176625+00	2026-06-19 10:30:18.176625+00
43	8	43	2021-12-01	932.48	606.80	325.68	194798.77	2026-06-19 10:30:18.177079+00	2026-06-19 10:30:18.177079+00
44	8	44	2022-01-01	932.48	607.81	324.66	194190.96	2026-06-19 10:30:18.177542+00	2026-06-19 10:30:18.177542+00
45	8	45	2022-02-01	932.48	608.83	323.65	193582.13	2026-06-19 10:30:18.178004+00	2026-06-19 10:30:18.178004+00
46	8	46	2022-03-01	932.48	609.84	322.64	192972.29	2026-06-19 10:30:18.178481+00	2026-06-19 10:30:18.178481+00
47	8	47	2022-04-01	932.48	610.86	321.62	192361.43	2026-06-19 10:30:18.178929+00	2026-06-19 10:30:18.178929+00
48	8	48	2022-05-01	932.48	611.88	320.60	191749.55	2026-06-19 10:30:18.179409+00	2026-06-19 10:30:18.179409+00
49	8	49	2022-06-01	932.48	612.90	319.58	191136.66	2026-06-19 10:30:18.179868+00	2026-06-19 10:30:18.179868+00
50	8	50	2022-07-01	932.48	613.92	318.56	190522.74	2026-06-19 10:30:18.180306+00	2026-06-19 10:30:18.180306+00
51	8	51	2022-08-01	932.48	614.94	317.54	189907.80	2026-06-19 10:30:18.180762+00	2026-06-19 10:30:18.180762+00
52	8	52	2022-09-01	932.48	615.97	316.51	189291.83	2026-06-19 10:30:18.181237+00	2026-06-19 10:30:18.181237+00
53	8	53	2022-10-01	932.48	616.99	315.49	188674.84	2026-06-19 10:30:18.181719+00	2026-06-19 10:30:18.181719+00
54	8	54	2022-11-01	932.48	618.02	314.46	188056.81	2026-06-19 10:30:18.182201+00	2026-06-19 10:30:18.182201+00
55	8	55	2022-12-01	932.48	619.05	313.43	187437.76	2026-06-19 10:30:18.18266+00	2026-06-19 10:30:18.18266+00
56	8	56	2023-01-01	932.48	620.08	312.40	186817.68	2026-06-19 10:30:18.18312+00	2026-06-19 10:30:18.18312+00
57	8	57	2023-02-01	932.48	621.12	311.36	186196.56	2026-06-19 10:30:18.183568+00	2026-06-19 10:30:18.183568+00
58	8	58	2023-03-01	932.48	622.15	310.33	185574.41	2026-06-19 10:30:18.184412+00	2026-06-19 10:30:18.184412+00
59	8	59	2023-04-01	932.48	623.19	309.29	184951.22	2026-06-19 10:30:18.184908+00	2026-06-19 10:30:18.184908+00
60	8	60	2023-05-01	932.48	624.23	308.25	184326.99	2026-06-19 10:30:18.18537+00	2026-06-19 10:30:18.18537+00
61	8	61	2023-06-01	932.48	625.27	307.21	183701.73	2026-06-19 10:30:18.185801+00	2026-06-19 10:30:18.185801+00
62	8	62	2023-07-01	932.48	626.31	306.17	183075.42	2026-06-19 10:30:18.186261+00	2026-06-19 10:30:18.186261+00
63	8	63	2023-08-01	932.48	627.35	305.13	182448.06	2026-06-19 10:30:18.186699+00	2026-06-19 10:30:18.186699+00
64	8	64	2023-09-01	932.48	628.40	304.08	181819.66	2026-06-19 10:30:18.187158+00	2026-06-19 10:30:18.187158+00
65	8	65	2023-10-01	932.48	629.45	303.03	181190.22	2026-06-19 10:30:18.187672+00	2026-06-19 10:30:18.187672+00
66	8	66	2023-11-01	932.48	630.50	301.98	180559.72	2026-06-19 10:30:18.188135+00	2026-06-19 10:30:18.188135+00
67	8	67	2023-12-01	932.48	631.55	300.93	179928.17	2026-06-19 10:30:18.188568+00	2026-06-19 10:30:18.188568+00
68	8	68	2024-01-01	932.48	632.60	299.88	179295.57	2026-06-19 10:30:18.189011+00	2026-06-19 10:30:18.189011+00
69	8	69	2024-02-01	932.48	633.65	298.83	178661.92	2026-06-19 10:30:18.189454+00	2026-06-19 10:30:18.189454+00
70	8	70	2024-03-01	932.48	634.71	297.77	178027.21	2026-06-19 10:30:18.189943+00	2026-06-19 10:30:18.189943+00
71	8	71	2024-04-01	932.48	635.77	296.71	177391.44	2026-06-19 10:30:18.190384+00	2026-06-19 10:30:18.190384+00
72	8	72	2024-05-01	932.48	636.83	295.65	176754.62	2026-06-19 10:30:18.190892+00	2026-06-19 10:30:18.190892+00
73	8	73	2024-06-01	932.48	637.89	294.59	176116.73	2026-06-19 10:30:18.191366+00	2026-06-19 10:30:18.191366+00
74	8	74	2024-07-01	932.48	638.95	293.53	175477.78	2026-06-19 10:30:18.191831+00	2026-06-19 10:30:18.191831+00
75	8	75	2024-08-01	932.48	640.02	292.46	174837.76	2026-06-19 10:30:18.192428+00	2026-06-19 10:30:18.192428+00
76	8	76	2024-09-01	932.48	641.08	291.40	174196.68	2026-06-19 10:30:18.192901+00	2026-06-19 10:30:18.192901+00
77	8	77	2024-10-01	932.48	642.15	290.33	173554.52	2026-06-19 10:30:18.193366+00	2026-06-19 10:30:18.193366+00
78	8	78	2024-11-01	932.48	643.22	289.26	172911.30	2026-06-19 10:30:18.19404+00	2026-06-19 10:30:18.19404+00
79	8	79	2024-12-01	932.48	644.29	288.19	172267.01	2026-06-19 10:30:18.194517+00	2026-06-19 10:30:18.194517+00
80	8	80	2025-01-01	932.48	645.37	287.11	171621.64	2026-06-19 10:30:18.194975+00	2026-06-19 10:30:18.194975+00
81	8	81	2025-02-01	932.48	646.44	286.04	170975.20	2026-06-19 10:30:18.19543+00	2026-06-19 10:30:18.19543+00
82	8	82	2025-03-01	932.48	647.52	284.96	170327.68	2026-06-19 10:30:18.195888+00	2026-06-19 10:30:18.195888+00
83	8	83	2025-04-01	932.48	648.60	283.88	169679.08	2026-06-19 10:30:18.196335+00	2026-06-19 10:30:18.196335+00
84	8	84	2025-05-01	932.48	649.68	282.80	169029.40	2026-06-19 10:30:18.196779+00	2026-06-19 10:30:18.196779+00
85	8	85	2025-06-01	932.48	650.76	281.72	168378.63	2026-06-19 10:30:18.197228+00	2026-06-19 10:30:18.197228+00
86	8	86	2025-07-01	932.48	651.85	280.63	167726.78	2026-06-19 10:30:18.197668+00	2026-06-19 10:30:18.197668+00
87	8	87	2025-08-01	932.48	652.93	279.54	167073.85	2026-06-19 10:30:18.198124+00	2026-06-19 10:30:18.198124+00
88	8	88	2025-09-01	932.48	654.02	278.46	166419.82	2026-06-19 10:30:18.198582+00	2026-06-19 10:30:18.198582+00
89	8	89	2025-10-01	932.48	655.11	277.37	165764.71	2026-06-19 10:30:18.199033+00	2026-06-19 10:30:18.199033+00
90	8	90	2025-11-01	932.48	656.21	276.27	165108.51	2026-06-19 10:30:18.199599+00	2026-06-19 10:30:18.199599+00
91	8	91	2025-12-01	932.48	657.30	275.18	164451.21	2026-06-19 10:30:18.200297+00	2026-06-19 10:30:18.200297+00
92	8	92	2026-01-01	932.48	658.39	274.09	163792.81	2026-06-19 10:30:18.200794+00	2026-06-19 10:30:18.200794+00
93	8	93	2026-02-01	932.48	659.49	272.99	163133.32	2026-06-19 10:30:18.201239+00	2026-06-19 10:30:18.201239+00
94	8	94	2026-03-01	932.48	660.59	271.89	162472.73	2026-06-19 10:30:18.201715+00	2026-06-19 10:30:18.201715+00
95	8	95	2026-04-01	932.48	661.69	270.79	161811.04	2026-06-19 10:30:18.202182+00	2026-06-19 10:30:18.202182+00
96	8	96	2026-05-01	932.48	662.79	269.69	161148.25	2026-06-19 10:30:18.202649+00	2026-06-19 10:30:18.202649+00
97	8	97	2026-06-01	932.48	663.90	268.58	160484.35	2026-06-19 10:30:18.203096+00	2026-06-19 10:30:18.203096+00
98	8	98	2026-07-01	932.48	665.01	267.47	159819.34	2026-06-19 10:30:18.2036+00	2026-06-19 10:30:18.2036+00
99	8	99	2026-08-01	932.48	666.11	266.37	159153.23	2026-06-19 10:30:18.204045+00	2026-06-19 10:30:18.204045+00
100	8	100	2026-09-01	932.48	667.22	265.26	158486.00	2026-06-19 10:30:18.204534+00	2026-06-19 10:30:18.204534+00
101	8	101	2026-10-01	932.48	668.34	264.14	157817.67	2026-06-19 10:30:18.204982+00	2026-06-19 10:30:18.204982+00
102	8	102	2026-11-01	932.48	669.45	263.03	157148.22	2026-06-19 10:30:18.205459+00	2026-06-19 10:30:18.205459+00
103	8	103	2026-12-01	932.48	670.57	261.91	156477.65	2026-06-19 10:30:18.205902+00	2026-06-19 10:30:18.205902+00
104	8	104	2027-01-01	932.48	671.68	260.80	155805.97	2026-06-19 10:30:18.206349+00	2026-06-19 10:30:18.206349+00
105	8	105	2027-02-01	932.48	672.80	259.68	155133.16	2026-06-19 10:30:18.206849+00	2026-06-19 10:30:18.206849+00
106	8	106	2027-03-01	932.48	673.92	258.56	154459.24	2026-06-19 10:30:18.207314+00	2026-06-19 10:30:18.207314+00
107	8	107	2027-04-01	932.48	675.05	257.43	153784.19	2026-06-19 10:30:18.207781+00	2026-06-19 10:30:18.207781+00
108	8	108	2027-05-01	932.48	676.17	256.31	153108.02	2026-06-19 10:30:18.208256+00	2026-06-19 10:30:18.208256+00
109	8	109	2027-06-01	932.48	677.30	255.18	152430.72	2026-06-19 10:30:18.208883+00	2026-06-19 10:30:18.208883+00
110	8	110	2027-07-01	932.48	678.43	254.05	151752.29	2026-06-19 10:30:18.209403+00	2026-06-19 10:30:18.209403+00
111	8	111	2027-08-01	932.48	679.56	252.92	151072.73	2026-06-19 10:30:18.209957+00	2026-06-19 10:30:18.209957+00
112	8	112	2027-09-01	932.48	680.69	251.79	150392.04	2026-06-19 10:30:18.210481+00	2026-06-19 10:30:18.210481+00
113	8	113	2027-10-01	932.48	681.83	250.65	149710.21	2026-06-19 10:30:18.211223+00	2026-06-19 10:30:18.211223+00
114	8	114	2027-11-01	932.48	682.96	249.52	149027.25	2026-06-19 10:30:18.21182+00	2026-06-19 10:30:18.21182+00
115	8	115	2027-12-01	932.48	684.10	248.38	148343.15	2026-06-19 10:30:18.212289+00	2026-06-19 10:30:18.212289+00
116	8	116	2028-01-01	932.48	685.24	247.24	147657.91	2026-06-19 10:30:18.212733+00	2026-06-19 10:30:18.212733+00
117	8	117	2028-02-01	932.48	686.38	246.10	146971.53	2026-06-19 10:30:18.213201+00	2026-06-19 10:30:18.213201+00
118	8	118	2028-03-01	932.48	687.53	244.95	146284.00	2026-06-19 10:30:18.213647+00	2026-06-19 10:30:18.213647+00
119	8	119	2028-04-01	932.48	688.67	243.81	145595.33	2026-06-19 10:30:18.214105+00	2026-06-19 10:30:18.214105+00
120	8	120	2028-05-01	932.48	689.82	242.66	144905.51	2026-06-19 10:30:18.214551+00	2026-06-19 10:30:18.214551+00
121	8	121	2028-06-01	932.48	690.97	241.51	144214.54	2026-06-19 10:30:18.215077+00	2026-06-19 10:30:18.215077+00
122	8	122	2028-07-01	932.48	692.12	240.36	143522.41	2026-06-19 10:30:18.215562+00	2026-06-19 10:30:18.215562+00
123	8	123	2028-08-01	932.48	693.28	239.20	142829.14	2026-06-19 10:30:18.216005+00	2026-06-19 10:30:18.216005+00
124	8	124	2028-09-01	932.48	694.43	238.05	142134.71	2026-06-19 10:30:18.216461+00	2026-06-19 10:30:18.216461+00
125	8	125	2028-10-01	932.48	695.59	236.89	141439.12	2026-06-19 10:30:18.216911+00	2026-06-19 10:30:18.216911+00
126	8	126	2028-11-01	932.48	696.75	235.73	140742.37	2026-06-19 10:30:18.217414+00	2026-06-19 10:30:18.217414+00
127	8	127	2028-12-01	932.48	697.91	234.57	140044.46	2026-06-19 10:30:18.218208+00	2026-06-19 10:30:18.218208+00
128	8	128	2029-01-01	932.48	699.07	233.41	139345.39	2026-06-19 10:30:18.218654+00	2026-06-19 10:30:18.218654+00
129	8	129	2029-02-01	932.48	700.24	232.24	138645.15	2026-06-19 10:30:18.219108+00	2026-06-19 10:30:18.219108+00
130	8	130	2029-03-01	932.48	701.40	231.08	137943.75	2026-06-19 10:30:18.219569+00	2026-06-19 10:30:18.219569+00
131	8	131	2029-04-01	932.48	702.57	229.91	137241.18	2026-06-19 10:30:18.220012+00	2026-06-19 10:30:18.220012+00
132	8	132	2029-05-01	932.48	703.74	228.74	136537.43	2026-06-19 10:30:18.220522+00	2026-06-19 10:30:18.220522+00
133	8	133	2029-06-01	932.48	704.92	227.56	135832.51	2026-06-19 10:30:18.221052+00	2026-06-19 10:30:18.221052+00
134	8	134	2029-07-01	932.48	706.09	226.39	135126.42	2026-06-19 10:30:18.22159+00	2026-06-19 10:30:18.22159+00
135	8	135	2029-08-01	932.48	707.27	225.21	134419.15	2026-06-19 10:30:18.222061+00	2026-06-19 10:30:18.222061+00
136	8	136	2029-09-01	932.48	708.45	224.03	133710.71	2026-06-19 10:30:18.22253+00	2026-06-19 10:30:18.22253+00
137	8	137	2029-10-01	932.48	709.63	222.85	133001.08	2026-06-19 10:30:18.222973+00	2026-06-19 10:30:18.222973+00
138	8	138	2029-11-01	932.48	710.81	221.67	132290.27	2026-06-19 10:30:18.223417+00	2026-06-19 10:30:18.223417+00
139	8	139	2029-12-01	932.48	712.00	220.48	131578.27	2026-06-19 10:30:18.223859+00	2026-06-19 10:30:18.223859+00
140	8	140	2030-01-01	932.48	713.18	219.30	130865.09	2026-06-19 10:30:18.224302+00	2026-06-19 10:30:18.224302+00
141	8	141	2030-02-01	932.48	714.37	218.11	130150.72	2026-06-19 10:30:18.225372+00	2026-06-19 10:30:18.225372+00
142	8	142	2030-03-01	932.48	715.56	216.92	129435.16	2026-06-19 10:30:18.226354+00	2026-06-19 10:30:18.226354+00
143	8	143	2030-04-01	932.48	716.75	215.73	128718.40	2026-06-19 10:30:18.22689+00	2026-06-19 10:30:18.22689+00
144	8	144	2030-05-01	932.48	717.95	214.53	128000.45	2026-06-19 10:30:18.227607+00	2026-06-19 10:30:18.227607+00
145	8	145	2030-06-01	932.48	719.15	213.33	127281.31	2026-06-19 10:30:18.228148+00	2026-06-19 10:30:18.228148+00
146	8	146	2030-07-01	932.48	720.34	212.14	126560.96	2026-06-19 10:30:18.22867+00	2026-06-19 10:30:18.22867+00
147	8	147	2030-08-01	932.48	721.54	210.93	125839.42	2026-06-19 10:30:18.230406+00	2026-06-19 10:30:18.230406+00
148	8	148	2030-09-01	932.48	722.75	209.73	125116.67	2026-06-19 10:30:18.230951+00	2026-06-19 10:30:18.230951+00
149	8	149	2030-10-01	932.48	723.95	208.53	124392.72	2026-06-19 10:30:18.231438+00	2026-06-19 10:30:18.231438+00
150	8	150	2030-11-01	932.48	725.16	207.32	123667.56	2026-06-19 10:30:18.231886+00	2026-06-19 10:30:18.231886+00
151	8	151	2030-12-01	932.48	726.37	206.11	122941.19	2026-06-19 10:30:18.23234+00	2026-06-19 10:30:18.23234+00
152	8	152	2031-01-01	932.48	727.58	204.90	122213.62	2026-06-19 10:30:18.232808+00	2026-06-19 10:30:18.232808+00
153	8	153	2031-02-01	932.48	728.79	203.69	121484.83	2026-06-19 10:30:18.23324+00	2026-06-19 10:30:18.23324+00
154	8	154	2031-03-01	932.48	730.00	202.47	120754.82	2026-06-19 10:30:18.233731+00	2026-06-19 10:30:18.233731+00
155	8	155	2031-04-01	932.48	731.22	201.26	120023.60	2026-06-19 10:30:18.234458+00	2026-06-19 10:30:18.234458+00
156	8	156	2031-05-01	932.48	732.44	200.04	119291.16	2026-06-19 10:30:18.234921+00	2026-06-19 10:30:18.234921+00
157	8	157	2031-06-01	932.48	733.66	198.82	118557.50	2026-06-19 10:30:18.235381+00	2026-06-19 10:30:18.235381+00
158	8	158	2031-07-01	932.48	734.88	197.60	117822.62	2026-06-19 10:30:18.235838+00	2026-06-19 10:30:18.235838+00
159	8	159	2031-08-01	932.48	736.11	196.37	117086.51	2026-06-19 10:30:18.236307+00	2026-06-19 10:30:18.236307+00
160	8	160	2031-09-01	932.48	737.34	195.14	116349.17	2026-06-19 10:30:18.236795+00	2026-06-19 10:30:18.236795+00
161	8	161	2031-10-01	932.48	738.56	193.92	115610.61	2026-06-19 10:30:18.237305+00	2026-06-19 10:30:18.237305+00
162	8	162	2031-11-01	932.48	739.80	192.68	114870.81	2026-06-19 10:30:18.237773+00	2026-06-19 10:30:18.237773+00
163	8	163	2031-12-01	932.48	741.03	191.45	114129.78	2026-06-19 10:30:18.238241+00	2026-06-19 10:30:18.238241+00
164	8	164	2032-01-01	932.48	742.26	190.22	113387.52	2026-06-19 10:30:18.238682+00	2026-06-19 10:30:18.238682+00
165	8	165	2032-02-01	932.48	743.50	188.98	112644.02	2026-06-19 10:30:18.239163+00	2026-06-19 10:30:18.239163+00
166	8	166	2032-03-01	932.48	744.74	187.74	111899.28	2026-06-19 10:30:18.239633+00	2026-06-19 10:30:18.239633+00
167	8	167	2032-04-01	932.48	745.98	186.50	111153.30	2026-06-19 10:30:18.240924+00	2026-06-19 10:30:18.240924+00
168	8	168	2032-05-01	932.48	747.22	185.26	110406.08	2026-06-19 10:30:18.241541+00	2026-06-19 10:30:18.241541+00
169	8	169	2032-06-01	932.48	748.47	184.01	109657.61	2026-06-19 10:30:18.242041+00	2026-06-19 10:30:18.242041+00
170	8	170	2032-07-01	932.48	749.72	182.76	108907.89	2026-06-19 10:30:18.242626+00	2026-06-19 10:30:18.242626+00
171	8	171	2032-08-01	932.48	750.97	181.51	108156.92	2026-06-19 10:30:18.243167+00	2026-06-19 10:30:18.243167+00
172	8	172	2032-09-01	932.48	752.22	180.26	107404.71	2026-06-19 10:30:18.244069+00	2026-06-19 10:30:18.244069+00
173	8	173	2032-10-01	932.48	753.47	179.01	106651.23	2026-06-19 10:30:18.244622+00	2026-06-19 10:30:18.244622+00
174	8	174	2032-11-01	932.48	754.73	177.75	105896.51	2026-06-19 10:30:18.24516+00	2026-06-19 10:30:18.24516+00
175	8	175	2032-12-01	932.48	755.99	176.49	105140.52	2026-06-19 10:30:18.24635+00	2026-06-19 10:30:18.24635+00
176	8	176	2033-01-01	932.48	757.25	175.23	104383.28	2026-06-19 10:30:18.246882+00	2026-06-19 10:30:18.246882+00
177	8	177	2033-02-01	932.48	758.51	173.97	103624.77	2026-06-19 10:30:18.247332+00	2026-06-19 10:30:18.247332+00
178	8	178	2033-03-01	932.48	759.77	172.71	102865.00	2026-06-19 10:30:18.247815+00	2026-06-19 10:30:18.247815+00
179	8	179	2033-04-01	932.48	761.04	171.44	102103.96	2026-06-19 10:30:18.248265+00	2026-06-19 10:30:18.248265+00
180	8	180	2033-05-01	932.48	762.31	170.17	101341.65	2026-06-19 10:30:18.248741+00	2026-06-19 10:30:18.248741+00
181	8	181	2033-06-01	932.48	763.58	168.90	100578.08	2026-06-19 10:30:18.249222+00	2026-06-19 10:30:18.249222+00
182	8	182	2033-07-01	932.48	764.85	167.63	99813.23	2026-06-19 10:30:18.249693+00	2026-06-19 10:30:18.249693+00
183	8	183	2033-08-01	932.48	766.12	166.36	99047.10	2026-06-19 10:30:18.250145+00	2026-06-19 10:30:18.250145+00
184	8	184	2033-09-01	932.48	767.40	165.08	98279.70	2026-06-19 10:30:18.25062+00	2026-06-19 10:30:18.25062+00
185	8	185	2033-10-01	932.48	768.68	163.80	97511.02	2026-06-19 10:30:18.251262+00	2026-06-19 10:30:18.251262+00
186	8	186	2033-11-01	932.48	769.96	162.52	96741.06	2026-06-19 10:30:18.251698+00	2026-06-19 10:30:18.251698+00
187	8	187	2033-12-01	932.48	771.24	161.24	95969.82	2026-06-19 10:30:18.252166+00	2026-06-19 10:30:18.252166+00
188	8	188	2034-01-01	932.48	772.53	159.95	95197.29	2026-06-19 10:30:18.252615+00	2026-06-19 10:30:18.252615+00
189	8	189	2034-02-01	932.48	773.82	158.66	94423.47	2026-06-19 10:30:18.25307+00	2026-06-19 10:30:18.25307+00
190	8	190	2034-03-01	932.48	775.11	157.37	93648.36	2026-06-19 10:30:18.253549+00	2026-06-19 10:30:18.253549+00
191	8	191	2034-04-01	932.48	776.40	156.08	92871.96	2026-06-19 10:30:18.254036+00	2026-06-19 10:30:18.254036+00
192	8	192	2034-05-01	932.48	777.69	154.79	92094.27	2026-06-19 10:30:18.25451+00	2026-06-19 10:30:18.25451+00
193	8	193	2034-06-01	932.48	778.99	153.49	91315.28	2026-06-19 10:30:18.254971+00	2026-06-19 10:30:18.254971+00
194	8	194	2034-07-01	932.48	780.29	152.19	90534.99	2026-06-19 10:30:18.255418+00	2026-06-19 10:30:18.255418+00
195	8	195	2034-08-01	932.48	781.59	150.89	89753.40	2026-06-19 10:30:18.255875+00	2026-06-19 10:30:18.255875+00
196	8	196	2034-09-01	932.48	782.89	149.59	88970.51	2026-06-19 10:30:18.256353+00	2026-06-19 10:30:18.256353+00
197	8	197	2034-10-01	932.48	784.20	148.28	88186.32	2026-06-19 10:30:18.256804+00	2026-06-19 10:30:18.256804+00
198	8	198	2034-11-01	932.48	785.50	146.98	87400.82	2026-06-19 10:30:18.257256+00	2026-06-19 10:30:18.257256+00
199	8	199	2034-12-01	932.48	786.81	145.67	86614.00	2026-06-19 10:30:18.257733+00	2026-06-19 10:30:18.257733+00
200	8	200	2035-01-01	932.48	788.12	144.36	85825.88	2026-06-19 10:30:18.258199+00	2026-06-19 10:30:18.258199+00
201	8	201	2035-02-01	932.48	789.44	143.04	85036.45	2026-06-19 10:30:18.258685+00	2026-06-19 10:30:18.258685+00
202	8	202	2035-03-01	932.48	790.75	141.73	84245.69	2026-06-19 10:30:18.259274+00	2026-06-19 10:30:18.259274+00
203	8	203	2035-04-01	932.48	792.07	140.41	83453.62	2026-06-19 10:30:18.259915+00	2026-06-19 10:30:18.259915+00
204	8	204	2035-05-01	932.48	793.39	139.09	82660.23	2026-06-19 10:30:18.260462+00	2026-06-19 10:30:18.260462+00
205	8	205	2035-06-01	932.48	794.71	137.77	81865.52	2026-06-19 10:30:18.26122+00	2026-06-19 10:30:18.26122+00
206	8	206	2035-07-01	932.48	796.04	136.44	81069.48	2026-06-19 10:30:18.261763+00	2026-06-19 10:30:18.261763+00
207	8	207	2035-08-01	932.48	797.36	135.12	80272.12	2026-06-19 10:30:18.262218+00	2026-06-19 10:30:18.262218+00
208	8	208	2035-09-01	932.48	798.69	133.79	79473.43	2026-06-19 10:30:18.26268+00	2026-06-19 10:30:18.26268+00
209	8	209	2035-10-01	932.48	800.02	132.46	78673.40	2026-06-19 10:30:18.263123+00	2026-06-19 10:30:18.263123+00
210	8	210	2035-11-01	932.48	801.36	131.12	77872.05	2026-06-19 10:30:18.26358+00	2026-06-19 10:30:18.26358+00
211	8	211	2035-12-01	932.48	802.69	129.79	77069.35	2026-06-19 10:30:18.264068+00	2026-06-19 10:30:18.264068+00
212	8	212	2036-01-01	932.48	804.03	128.45	76265.32	2026-06-19 10:30:18.264518+00	2026-06-19 10:30:18.264518+00
213	8	213	2036-02-01	932.48	805.37	127.11	75459.95	2026-06-19 10:30:18.26507+00	2026-06-19 10:30:18.26507+00
214	8	214	2036-03-01	932.48	806.71	125.77	74653.24	2026-06-19 10:30:18.26555+00	2026-06-19 10:30:18.26555+00
215	8	215	2036-04-01	932.48	808.06	124.42	73845.18	2026-06-19 10:30:18.26599+00	2026-06-19 10:30:18.26599+00
216	8	216	2036-05-01	932.48	809.40	123.08	73035.78	2026-06-19 10:30:18.266448+00	2026-06-19 10:30:18.266448+00
217	8	217	2036-06-01	932.48	810.75	121.73	72225.02	2026-06-19 10:30:18.266911+00	2026-06-19 10:30:18.266911+00
218	8	218	2036-07-01	932.48	812.10	120.38	71412.92	2026-06-19 10:30:18.267368+00	2026-06-19 10:30:18.267368+00
219	8	219	2036-08-01	932.48	813.46	119.02	70599.46	2026-06-19 10:30:18.267849+00	2026-06-19 10:30:18.267849+00
220	8	220	2036-09-01	932.48	814.81	117.67	69784.65	2026-06-19 10:30:18.268296+00	2026-06-19 10:30:18.268296+00
221	8	221	2036-10-01	932.48	816.17	116.31	68968.48	2026-06-19 10:30:18.268772+00	2026-06-19 10:30:18.268772+00
222	8	222	2036-11-01	932.48	817.53	114.95	68150.94	2026-06-19 10:30:18.269198+00	2026-06-19 10:30:18.269198+00
223	8	223	2036-12-01	932.48	818.89	113.58	67332.05	2026-06-19 10:30:18.26964+00	2026-06-19 10:30:18.26964+00
224	8	224	2037-01-01	932.48	820.26	112.22	66511.79	2026-06-19 10:30:18.270092+00	2026-06-19 10:30:18.270092+00
225	8	225	2037-02-01	932.48	821.63	110.85	65690.16	2026-06-19 10:30:18.270548+00	2026-06-19 10:30:18.270548+00
226	8	226	2037-03-01	932.48	823.00	109.48	64867.17	2026-06-19 10:30:18.271016+00	2026-06-19 10:30:18.271016+00
227	8	227	2037-04-01	932.48	824.37	108.11	64042.80	2026-06-19 10:30:18.271478+00	2026-06-19 10:30:18.271478+00
228	8	228	2037-05-01	932.48	825.74	106.74	63217.06	2026-06-19 10:30:18.271911+00	2026-06-19 10:30:18.271911+00
229	8	229	2037-06-01	932.48	827.12	105.36	62389.94	2026-06-19 10:30:18.272374+00	2026-06-19 10:30:18.272374+00
230	8	230	2037-07-01	932.48	828.50	103.98	61561.44	2026-06-19 10:30:18.272864+00	2026-06-19 10:30:18.272864+00
231	8	231	2037-08-01	932.48	829.88	102.60	60731.57	2026-06-19 10:30:18.273334+00	2026-06-19 10:30:18.273334+00
232	8	232	2037-09-01	932.48	831.26	101.22	59900.31	2026-06-19 10:30:18.273832+00	2026-06-19 10:30:18.273832+00
233	8	233	2037-10-01	932.48	832.65	99.83	59067.66	2026-06-19 10:30:18.27431+00	2026-06-19 10:30:18.27431+00
234	8	234	2037-11-01	932.48	834.03	98.45	58233.63	2026-06-19 10:30:18.274816+00	2026-06-19 10:30:18.274816+00
235	8	235	2037-12-01	932.48	835.42	97.06	57398.20	2026-06-19 10:30:18.275325+00	2026-06-19 10:30:18.275325+00
236	8	236	2038-01-01	932.48	836.82	95.66	56561.39	2026-06-19 10:30:18.275846+00	2026-06-19 10:30:18.275846+00
237	8	237	2038-02-01	932.48	838.21	94.27	55723.18	2026-06-19 10:30:18.276371+00	2026-06-19 10:30:18.276371+00
238	8	238	2038-03-01	932.48	839.61	92.87	54883.57	2026-06-19 10:30:18.276836+00	2026-06-19 10:30:18.276836+00
239	8	239	2038-04-01	932.48	841.01	91.47	54042.56	2026-06-19 10:30:18.277337+00	2026-06-19 10:30:18.277337+00
240	8	240	2038-05-01	932.48	842.41	90.07	53200.15	2026-06-19 10:30:18.277779+00	2026-06-19 10:30:18.277779+00
241	8	241	2038-06-01	932.48	843.81	88.67	52356.34	2026-06-19 10:30:18.278312+00	2026-06-19 10:30:18.278312+00
242	8	242	2038-07-01	932.48	845.22	87.26	51511.12	2026-06-19 10:30:18.278748+00	2026-06-19 10:30:18.278748+00
243	8	243	2038-08-01	932.48	846.63	85.85	50664.50	2026-06-19 10:30:18.279168+00	2026-06-19 10:30:18.279168+00
244	8	244	2038-09-01	932.48	848.04	84.44	49816.46	2026-06-19 10:30:18.279631+00	2026-06-19 10:30:18.279631+00
245	8	245	2038-10-01	932.48	849.45	83.03	48967.00	2026-06-19 10:30:18.280078+00	2026-06-19 10:30:18.280078+00
246	8	246	2038-11-01	932.48	850.87	81.61	48116.14	2026-06-19 10:30:18.280583+00	2026-06-19 10:30:18.280583+00
247	8	247	2038-12-01	932.48	852.29	80.19	47263.85	2026-06-19 10:30:18.281045+00	2026-06-19 10:30:18.281045+00
248	8	248	2039-01-01	932.48	853.71	78.77	46410.14	2026-06-19 10:30:18.281516+00	2026-06-19 10:30:18.281516+00
249	8	249	2039-02-01	932.48	855.13	77.35	45555.01	2026-06-19 10:30:18.282057+00	2026-06-19 10:30:18.282057+00
250	8	250	2039-03-01	932.48	856.55	75.93	44698.46	2026-06-19 10:30:18.282582+00	2026-06-19 10:30:18.282582+00
251	8	251	2039-04-01	932.48	857.98	74.50	43840.48	2026-06-19 10:30:18.283048+00	2026-06-19 10:30:18.283048+00
252	8	252	2039-05-01	932.48	859.41	73.07	42981.07	2026-06-19 10:30:18.285622+00	2026-06-19 10:30:18.285622+00
253	8	253	2039-06-01	932.48	860.84	71.64	42120.22	2026-06-19 10:30:18.286366+00	2026-06-19 10:30:18.286366+00
254	8	254	2039-07-01	932.48	862.28	70.20	41257.94	2026-06-19 10:30:18.286828+00	2026-06-19 10:30:18.286828+00
255	8	255	2039-08-01	932.48	863.72	68.76	40394.23	2026-06-19 10:30:18.287456+00	2026-06-19 10:30:18.287456+00
256	8	256	2039-09-01	932.48	865.16	67.32	39529.07	2026-06-19 10:30:18.28794+00	2026-06-19 10:30:18.28794+00
257	8	257	2039-10-01	932.48	866.60	65.88	38662.47	2026-06-19 10:30:18.288427+00	2026-06-19 10:30:18.288427+00
258	8	258	2039-11-01	932.48	868.04	64.44	37794.43	2026-06-19 10:30:18.288907+00	2026-06-19 10:30:18.288907+00
259	8	259	2039-12-01	932.48	869.49	62.99	36924.94	2026-06-19 10:30:18.289427+00	2026-06-19 10:30:18.289427+00
260	8	260	2040-01-01	932.48	870.94	61.54	36054.00	2026-06-19 10:30:18.290182+00	2026-06-19 10:30:18.290182+00
261	8	261	2040-02-01	932.48	872.39	60.09	35181.61	2026-06-19 10:30:18.290886+00	2026-06-19 10:30:18.290886+00
262	8	262	2040-03-01	932.48	873.84	58.64	34307.77	2026-06-19 10:30:18.29139+00	2026-06-19 10:30:18.29139+00
263	8	263	2040-04-01	932.48	875.30	57.18	33432.47	2026-06-19 10:30:18.294893+00	2026-06-19 10:30:18.294893+00
264	8	264	2040-05-01	932.48	876.76	55.72	32555.71	2026-06-19 10:30:18.295443+00	2026-06-19 10:30:18.295443+00
265	8	265	2040-06-01	932.48	878.22	54.26	31677.49	2026-06-19 10:30:18.295953+00	2026-06-19 10:30:18.295953+00
266	8	266	2040-07-01	932.48	879.68	52.80	30797.81	2026-06-19 10:30:18.29649+00	2026-06-19 10:30:18.29649+00
267	8	267	2040-08-01	932.48	881.15	51.33	29916.66	2026-06-19 10:30:18.29695+00	2026-06-19 10:30:18.29695+00
268	8	268	2040-09-01	932.48	882.62	49.86	29034.04	2026-06-19 10:30:18.297464+00	2026-06-19 10:30:18.297464+00
269	8	269	2040-10-01	932.48	884.09	48.39	28149.95	2026-06-19 10:30:18.297935+00	2026-06-19 10:30:18.297935+00
270	8	270	2040-11-01	932.48	885.56	46.92	27264.39	2026-06-19 10:30:18.298394+00	2026-06-19 10:30:18.298394+00
271	8	271	2040-12-01	932.48	887.04	45.44	26377.35	2026-06-19 10:30:18.298899+00	2026-06-19 10:30:18.298899+00
272	8	272	2041-01-01	932.48	888.52	43.96	25488.83	2026-06-19 10:30:18.299343+00	2026-06-19 10:30:18.299343+00
273	8	273	2041-02-01	932.48	890.00	42.48	24598.83	2026-06-19 10:30:18.299789+00	2026-06-19 10:30:18.299789+00
274	8	274	2041-03-01	932.48	891.48	41.00	23707.35	2026-06-19 10:30:18.300256+00	2026-06-19 10:30:18.300256+00
275	8	275	2041-04-01	932.48	892.97	39.51	22814.38	2026-06-19 10:30:18.301548+00	2026-06-19 10:30:18.301548+00
276	8	276	2041-05-01	932.48	894.46	38.02	21919.93	2026-06-19 10:30:18.302016+00	2026-06-19 10:30:18.302016+00
277	8	277	2041-06-01	932.48	895.95	36.53	21023.98	2026-06-19 10:30:18.302489+00	2026-06-19 10:30:18.302489+00
278	8	278	2041-07-01	932.48	897.44	35.04	20126.54	2026-06-19 10:30:18.303473+00	2026-06-19 10:30:18.303473+00
279	8	279	2041-08-01	932.48	898.94	33.54	19227.61	2026-06-19 10:30:18.303943+00	2026-06-19 10:30:18.303943+00
280	8	280	2041-09-01	932.48	900.43	32.05	18327.17	2026-06-19 10:30:18.304425+00	2026-06-19 10:30:18.304425+00
281	8	281	2041-10-01	932.48	901.93	30.55	17425.24	2026-06-19 10:30:18.304926+00	2026-06-19 10:30:18.304926+00
282	8	282	2041-11-01	932.48	903.44	29.04	16521.80	2026-06-19 10:30:18.305414+00	2026-06-19 10:30:18.305414+00
283	8	283	2041-12-01	932.48	904.94	27.54	15616.86	2026-06-19 10:30:18.305897+00	2026-06-19 10:30:18.305897+00
284	8	284	2042-01-01	932.48	906.45	26.03	14710.41	2026-06-19 10:30:18.306361+00	2026-06-19 10:30:18.306361+00
285	8	285	2042-02-01	932.48	907.96	24.52	13802.45	2026-06-19 10:30:18.306829+00	2026-06-19 10:30:18.306829+00
286	8	286	2042-03-01	932.48	909.48	23.00	12892.97	2026-06-19 10:30:18.307281+00	2026-06-19 10:30:18.307281+00
287	8	287	2042-04-01	932.48	910.99	21.49	11981.98	2026-06-19 10:30:18.307742+00	2026-06-19 10:30:18.307742+00
288	8	288	2042-05-01	932.48	912.51	19.97	11069.47	2026-06-19 10:30:18.3082+00	2026-06-19 10:30:18.3082+00
289	8	289	2042-06-01	932.48	914.03	18.45	10155.44	2026-06-19 10:30:18.308632+00	2026-06-19 10:30:18.308632+00
290	8	290	2042-07-01	932.48	915.55	16.93	9239.88	2026-06-19 10:30:18.309106+00	2026-06-19 10:30:18.309106+00
291	8	291	2042-08-01	932.48	917.08	15.40	8322.81	2026-06-19 10:30:18.309562+00	2026-06-19 10:30:18.309562+00
292	8	292	2042-09-01	932.48	918.61	13.87	7404.20	2026-06-19 10:30:18.31002+00	2026-06-19 10:30:18.31002+00
293	8	293	2042-10-01	932.48	920.14	12.34	6484.06	2026-06-19 10:30:18.310543+00	2026-06-19 10:30:18.310543+00
294	8	294	2042-11-01	932.48	921.67	10.81	5562.38	2026-06-19 10:30:18.311262+00	2026-06-19 10:30:18.311262+00
295	8	295	2042-12-01	932.48	923.21	9.27	4639.18	2026-06-19 10:30:18.311766+00	2026-06-19 10:30:18.311766+00
296	8	296	2043-01-01	932.48	924.75	7.73	3714.43	2026-06-19 10:30:18.31225+00	2026-06-19 10:30:18.31225+00
297	8	297	2043-02-01	932.48	926.29	6.19	2788.14	2026-06-19 10:30:18.312708+00	2026-06-19 10:30:18.312708+00
298	8	298	2043-03-01	932.48	927.83	4.65	1860.31	2026-06-19 10:30:18.313195+00	2026-06-19 10:30:18.313195+00
299	8	299	2043-04-01	932.48	929.38	3.10	930.93	2026-06-19 10:30:18.313667+00	2026-06-19 10:30:18.313667+00
300	8	300	2043-05-01	932.48	930.93	1.55	0.00	2026-06-19 10:30:18.314135+00	2026-06-19 10:30:18.314135+00
\.


ALTER TABLE public.planned_transaction_loan_schedule ENABLE TRIGGER ALL;

--
-- Data for Name: tags; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.tags DISABLE TRIGGER ALL;

COPY public.tags (id, slug, color, is_active, created_at, updated_at) FROM stdin;
1	subscription	#6366f1	t	2026-06-19 10:30:18.018661+00	2026-06-19 10:30:18.018661+00
2	tax-deductible	#16a34a	t	2026-06-19 10:30:18.019481+00	2026-06-19 10:30:18.019481+00
3	holiday-2025	#f59e0b	t	2026-06-19 10:30:18.019987+00	2026-06-19 10:30:18.019987+00
4	work	#0ea5e9	t	2026-06-19 10:30:18.020448+00	2026-06-19 10:30:18.020448+00
\.


ALTER TABLE public.tags ENABLE TRIGGER ALL;

--
-- Data for Name: planned_transaction_tags; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.planned_transaction_tags DISABLE TRIGGER ALL;

COPY public.planned_transaction_tags (planned_transaction_id, tag_id, created_at) FROM stdin;
\.


ALTER TABLE public.planned_transaction_tags ENABLE TRIGGER ALL;

--
-- Data for Name: portfolio_import_batches; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.portfolio_import_batches DISABLE TRIGGER ALL;

COPY public.portfolio_import_batches (id, adapter_name, source_filename, source_size_bytes, custom_config, default_asset_class, default_type, status, rows_total, rows_imported, rows_duplicate, rows_error, error_summary, started_at, completed_at, account_id, is_brokerage) FROM stdin;
\.


ALTER TABLE public.portfolio_import_batches ENABLE TRIGGER ALL;

--
-- Data for Name: portfolio_import_staging_rows; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.portfolio_import_staging_rows DISABLE TRIGGER ALL;

COPY public.portfolio_import_staging_rows (id, batch_id, row_index, status, tx_date, type_raw, type, symbol_raw, name_raw, units, price_per_unit, amount, fees, taxes, currency, fx_rate_to_eur, note, raw_data, tx_hash, resolved_investment_id, user_override_investment_id, match_source, match_similarity, committed_txn_id, error_message, created_at, route) FROM stdin;
\.


ALTER TABLE public.portfolio_import_staging_rows ENABLE TRIGGER ALL;

--
-- Data for Name: portfolio_performance_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.portfolio_performance_snapshots DISABLE TRIGGER ALL;

COPY public.portfolio_performance_snapshots (id, snapshot_date, invested, value, stocks_etfs_value, crypto_value, metals_value, cash_value, gain_loss, return_pct, inflation_adjusted_value, cumulative_inflation, real_return_pct, currency, computed_at, stocks_etfs_invested, crypto_invested, metals_invested, value_fx_neutral) FROM stdin;
\.


ALTER TABLE public.portfolio_performance_snapshots ENABLE TRIGGER ALL;

--
-- Data for Name: portfolio_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.portfolio_transactions DISABLE TRIGGER ALL;

COPY public.portfolio_transactions (id, investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, fx_rate_to_eur, note, is_recurring, recurrence_interval, recurrence_end_date, created_at, updated_at, account_id) FROM stdin;
1	1	buy	2024-02-21	261.0695	3.61486406	72.221122	2.2188	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.441181+00	2026-06-19 10:30:18.441181+00	3
2	1	buy	2024-03-21	225.7627	3.12444694	72.256851	3.4028	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.442331+00	2026-06-19 10:30:18.442331+00	3
3	1	buy	2024-04-21	277.6747	3.82777018	72.542167	2.6899	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.442901+00	2026-06-19 10:30:18.442901+00	3
4	1	buy	2024-05-21	318.7201	4.38225466	72.729713	0.7461	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.443448+00	2026-06-19 10:30:18.443448+00	3
5	1	buy	2024-06-21	343.3248	4.56466199	75.213624	3.1871	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.443973+00	2026-06-19 10:30:18.443973+00	3
6	1	buy	2024-07-21	314.6438	4.02221948	78.226405	3.2414	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.444677+00	2026-06-19 10:30:18.444677+00	3
7	1	buy	2024-08-21	359.2894	4.72079392	76.107844	1.5825	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.445232+00	2026-06-19 10:30:18.445232+00	3
8	1	buy	2024-09-21	320.5974	4.14485996	77.348197	3.7885	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.445743+00	2026-06-19 10:30:18.445743+00	3
9	1	buy	2024-10-21	448.5209	5.74425728	78.081614	0.2349	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.446214+00	2026-06-19 10:30:18.446214+00	3
10	1	buy	2024-11-21	447.6781	5.79191390	77.293640	0.4510	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.446688+00	2026-06-19 10:30:18.446688+00	3
11	1	buy	2024-12-21	244.0170	3.07556266	79.340618	0.9612	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.44718+00	2026-06-19 10:30:18.44718+00	3
12	1	buy	2025-01-21	282.8764	3.55340572	79.607130	3.6691	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.447686+00	2026-06-19 10:30:18.447686+00	3
13	1	buy	2025-02-21	411.3757	5.04819223	81.489697	1.3087	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.448171+00	2026-06-19 10:30:18.448171+00	3
14	1	buy	2025-03-21	410.5421	5.09887113	80.516277	0.8796	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.448648+00	2026-06-19 10:30:18.448648+00	3
15	1	buy	2025-04-21	403.5832	5.05531704	79.833404	0.3092	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.449139+00	2026-06-19 10:30:18.449139+00	3
16	1	buy	2025-05-21	482.2925	5.88799365	81.911172	2.0581	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.449624+00	2026-06-19 10:30:18.449624+00	3
17	1	buy	2025-06-21	258.4057	3.09509004	83.488898	2.7309	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.450132+00	2026-06-19 10:30:18.450132+00	3
18	1	buy	2025-07-21	462.9197	5.43385547	85.191753	0.6224	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.450785+00	2026-06-19 10:30:18.450785+00	3
19	1	buy	2025-08-21	400.0573	4.58645705	87.225788	1.0811	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.451997+00	2026-06-19 10:30:18.451997+00	3
20	1	buy	2025-09-21	439.3896	5.21342903	84.280339	2.4448	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.452493+00	2026-06-19 10:30:18.452493+00	3
21	1	buy	2025-10-21	424.2276	4.84794252	87.506732	3.9616	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.45299+00	2026-06-19 10:30:18.45299+00	3
22	1	buy	2025-11-21	272.1603	3.13519171	86.808188	2.4721	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.453475+00	2026-06-19 10:30:18.453475+00	3
23	1	buy	2025-12-21	434.9044	4.80848980	90.445105	3.5589	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.453947+00	2026-06-19 10:30:18.453947+00	3
24	1	buy	2026-01-21	498.5860	5.54300437	89.948686	0.9972	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.454544+00	2026-06-19 10:30:18.454544+00	3
25	1	buy	2026-02-21	512.2409	5.63164409	90.957617	1.8090	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.455022+00	2026-06-19 10:30:18.455022+00	3
26	1	buy	2026-03-21	348.5493	3.70282327	94.130679	0.3383	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.455502+00	2026-06-19 10:30:18.455502+00	3
27	1	buy	2026-04-21	548.0189	5.53375602	99.032002	2.1251	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.45598+00	2026-06-19 10:30:18.45598+00	3
28	1	buy	2026-05-21	462.6836	4.63185994	99.891532	0.6670	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.456451+00	2026-06-19 10:30:18.456451+00	3
29	2	buy	2024-02-21	189.2794	2.08556504	90.756890	3.0228	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.521492+00	2026-06-19 10:30:18.521492+00	3
30	2	buy	2024-03-21	133.7496	1.50303737	88.986201	0.5108	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.522022+00	2026-06-19 10:30:18.522022+00	3
31	2	buy	2024-04-21	152.7112	1.72619451	88.466995	1.3716	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.52252+00	2026-06-19 10:30:18.52252+00	3
32	2	buy	2024-05-21	269.4967	2.96548457	90.877803	0.6526	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.523051+00	2026-06-19 10:30:18.523051+00	3
33	2	buy	2024-06-21	197.9676	2.12640287	93.099766	2.0017	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.523598+00	2026-06-19 10:30:18.523598+00	3
34	2	buy	2024-07-21	226.1739	2.52494206	89.575863	3.1646	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.524108+00	2026-06-19 10:30:18.524108+00	3
35	2	buy	2024-08-21	194.9656	2.14255170	90.996905	2.6359	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.524616+00	2026-06-19 10:30:18.524616+00	3
36	2	buy	2024-09-21	190.8253	2.04961332	93.103065	0.0179	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.525088+00	2026-06-19 10:30:18.525088+00	3
37	2	buy	2024-10-21	269.9139	2.85170729	94.649946	1.0943	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.526633+00	2026-06-19 10:30:18.526633+00	3
38	2	buy	2024-11-21	282.2563	3.01305782	93.677685	2.2516	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.527176+00	2026-06-19 10:30:18.527176+00	3
39	2	buy	2024-12-21	243.6466	2.70023026	90.231784	1.5972	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.527678+00	2026-06-19 10:30:18.527678+00	3
40	2	buy	2025-01-21	305.6803	3.34797582	91.303033	2.9362	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.528176+00	2026-06-19 10:30:18.528176+00	3
41	2	buy	2025-02-21	279.1772	3.04343696	91.730903	0.1458	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.528651+00	2026-06-19 10:30:18.528651+00	3
42	2	buy	2025-03-21	248.1175	2.60303818	95.318440	3.4046	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.529127+00	2026-06-19 10:30:18.529127+00	3
43	2	buy	2025-04-21	332.1970	3.46453432	95.885029	2.3383	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.529602+00	2026-06-19 10:30:18.529602+00	3
44	2	buy	2025-05-21	302.4090	3.19286015	94.714131	0.4159	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.530077+00	2026-06-19 10:30:18.530077+00	3
45	2	buy	2025-06-21	323.7398	3.31650141	97.614862	2.1490	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.530547+00	2026-06-19 10:30:18.530547+00	3
46	2	buy	2025-07-21	326.4569	3.33508252	97.885702	1.6652	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.531016+00	2026-06-19 10:30:18.531016+00	3
47	2	buy	2025-08-21	314.2232	3.15382350	99.632474	1.6980	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.531494+00	2026-06-19 10:30:18.531494+00	3
48	2	buy	2025-09-21	183.6960	1.84784327	99.411039	3.5020	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.531977+00	2026-06-19 10:30:18.531977+00	3
49	2	buy	2025-10-21	346.9767	3.44815099	100.626888	2.0125	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.532494+00	2026-06-19 10:30:18.532494+00	3
50	2	buy	2025-11-21	332.4540	3.41463316	97.361546	0.4878	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.533084+00	2026-06-19 10:30:18.533084+00	3
51	2	buy	2025-12-21	201.8143	2.06356914	97.798646	0.7605	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.534079+00	2026-06-19 10:30:18.534079+00	3
52	2	buy	2026-01-21	153.6165	1.50084780	102.353144	0.5489	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.534794+00	2026-06-19 10:30:18.534794+00	3
53	2	buy	2026-02-21	180.5448	1.69611583	106.446019	0.4972	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.535277+00	2026-06-19 10:30:18.535277+00	3
54	2	buy	2026-03-21	295.2366	2.77141577	106.529148	3.9363	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.535808+00	2026-06-19 10:30:18.535808+00	3
55	2	buy	2026-04-21	320.0850	2.96159366	108.078624	1.5405	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.53629+00	2026-06-19 10:30:18.53629+00	3
56	2	buy	2026-05-21	199.4311	1.85286487	107.633924	1.2735	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.536756+00	2026-06-19 10:30:18.536756+00	3
57	3	buy	2025-01-22	950.4619	5.28683178	179.779105	3.4805	0.0000	USD	0.8634152984	\N	f	\N	\N	2026-06-19 10:30:18.62363+00	2026-06-19 10:30:18.62363+00	4
58	3	buy	2025-05-03	1029.0925	5.88835463	174.767415	1.8603	0.0000	USD	0.8926408211	\N	f	\N	\N	2026-06-19 10:30:18.624332+00	2026-06-19 10:30:18.624332+00	4
59	3	buy	2025-12-12	705.2445	4.07037774	173.262667	2.3122	0.0000	USD	0.8643719294	\N	f	\N	\N	2026-06-19 10:30:18.624827+00	2026-06-19 10:30:18.624827+00	4
60	3	buy	2024-07-11	495.2543	2.71674343	182.297044	3.6440	0.0000	USD	0.8852291997	\N	f	\N	\N	2026-06-19 10:30:18.625469+00	2026-06-19 10:30:18.625469+00	4
61	3	buy	2024-04-19	520.2225	3.02632871	171.898881	0.0086	0.0000	USD	0.8694378768	\N	f	\N	\N	2026-06-19 10:30:18.627309+00	2026-06-19 10:30:18.627309+00	4
62	3	buy	2024-07-16	1010.9263	5.51336269	183.359297	2.5504	0.0000	USD	0.8779941916	\N	f	\N	\N	2026-06-19 10:30:18.628261+00	2026-06-19 10:30:18.628261+00	4
63	3	buy	2024-05-10	508.6003	3.00000000	169.533447	1.0237	0.0000	USD	0.8819068056	\N	f	\N	\N	2026-06-19 10:30:18.628886+00	2026-06-19 10:30:18.628886+00	3
64	3	buy	2025-03-12	440.2767	2.50000000	176.110699	3.4519	0.0000	USD	0.8824480340	\N	f	\N	\N	2026-06-19 10:30:18.62951+00	2026-06-19 10:30:18.62951+00	3
65	4	buy	2025-11-05	434.5865	0.69710640	623.414873	0.1249	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.692163+00	2026-06-19 10:30:18.692163+00	4
66	4	buy	2024-04-01	957.7025	1.43113123	669.192640	3.1575	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.69268+00	2026-06-19 10:30:18.69268+00	4
67	4	buy	2025-09-17	923.6495	1.44973729	637.115083	2.0755	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.69336+00	2026-06-19 10:30:18.69336+00	4
68	4	buy	2024-04-13	558.8143	0.81651240	684.391637	0.2767	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.693926+00	2026-06-19 10:30:18.693926+00	4
69	5	buy	2025-12-20	1425.4636	0.03021406	47178.820994	2.7420	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.759257+00	2026-06-19 10:30:18.759257+00	6
70	5	buy	2025-05-11	1875.1455	0.03486192	53787.787966	1.1987	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.759803+00	2026-06-19 10:30:18.759803+00	6
71	5	buy	2025-05-15	1497.7037	0.02852786	52499.690350	2.2081	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.760316+00	2026-06-19 10:30:18.760316+00	6
72	5	buy	2024-05-12	1210.1088	0.02126442	56907.682963	3.2111	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.760807+00	2026-06-19 10:30:18.760807+00	6
73	5	buy	2024-06-04	838.8878	0.01628825	51502.637936	1.2546	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.76135+00	2026-06-19 10:30:18.76135+00	6
74	5	buy	2024-08-11	1766.7336	0.03172631	55686.693954	1.9637	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.761871+00	2026-06-19 10:30:18.761871+00	6
75	6	buy	2024-08-02	991.1417	0.26605302	3725.354138	0.7816	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.829796+00	2026-06-19 10:30:18.829796+00	6
76	6	buy	2024-02-04	875.5660	0.37162231	2356.064225	2.0111	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.830331+00	2026-06-19 10:30:18.830331+00	6
77	6	buy	2024-06-26	1505.5308	0.42877200	3511.261970	1.5066	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.830823+00	2026-06-19 10:30:18.830823+00	6
78	6	buy	2024-03-08	781.3588	0.29778846	2623.872000	1.0203	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.831339+00	2026-06-19 10:30:18.831339+00	6
79	6	buy	2024-01-24	631.8163	0.25875942	2441.713326	1.0278	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.831827+00	2026-06-19 10:30:18.831827+00	6
80	6	buy	2024-05-28	1357.0794	0.47032421	2885.412512	1.0834	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.832319+00	2026-06-19 10:30:18.832319+00	6
81	7	buy	2025-07-25	2959.5334	1.63667433	1808.260395	1.5662	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.902482+00	2026-06-19 10:30:18.902482+00	4
82	7	buy	2024-11-04	6162.1776	3.48256370	1769.437156	1.0548	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.903005+00	2026-06-19 10:30:18.903005+00	4
83	7	buy	2025-02-23	6511.4645	3.70145218	1759.164831	2.3226	0.0000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.903486+00	2026-06-19 10:30:18.903486+00	4
84	3	dividend	2025-02-13	22.5000	\N	\N	0.0000	6.7500	USD	0.8584299189	\N	f	\N	\N	2026-06-19 10:30:18.903967+00	2026-06-19 10:30:18.903967+00	4
85	3	dividend	2025-08-14	24.1000	\N	\N	0.0000	7.2300	USD	0.8651527800	\N	f	\N	\N	2026-06-19 10:30:18.904466+00	2026-06-19 10:30:18.904466+00	4
86	1	dividend	2025-06-20	68.0000	\N	\N	0.0000	20.4000	EUR	1.0000000000	\N	f	\N	\N	2026-06-19 10:30:18.904957+00	2026-06-19 10:30:18.904957+00	3
87	8	buy	2024-01-15	12000.0000	\N	\N	0.0000	0.0000	EUR	\N	\N	f	\N	\N	2026-06-19 10:30:18.905914+00	2026-06-19 10:30:18.905914+00	2
88	8	interest	2025-01-02	180.0000	\N	\N	0.0000	0.0000	EUR	\N	\N	f	\N	\N	2026-06-19 10:30:18.906418+00	2026-06-19 10:30:18.906418+00	2
89	8	buy	2025-06-10	3000.0000	\N	\N	0.0000	0.0000	EUR	\N	\N	f	\N	\N	2026-06-19 10:30:18.906961+00	2026-06-19 10:30:18.906961+00	2
90	9	buy	2024-09-04	5000.0000	\N	\N	0.0000	0.0000	EUR	\N	\N	f	\N	\N	2026-06-19 10:30:18.908042+00	2026-06-19 10:30:18.908042+00	3
91	9	interest	2025-09-04	142.5000	\N	\N	0.0000	0.0000	EUR	\N	\N	f	\N	\N	2026-06-19 10:30:18.908663+00	2026-06-19 10:30:18.908663+00	3
92	10	buy	2018-05-01	298000.0000	\N	\N	0.0000	0.0000	EUR	\N	\N	f	\N	\N	2026-06-19 10:30:18.909791+00	2026-06-19 10:30:18.909791+00	\N
93	10	appreciation	2025-12-31	27000.0000	\N	\N	0.0000	0.0000	EUR	\N	\N	f	\N	\N	2026-06-19 10:30:18.910268+00	2026-06-19 10:30:18.910268+00	\N
\.


ALTER TABLE public.portfolio_transactions ENABLE TRIGGER ALL;

--
-- Data for Name: provider_api_keys; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.provider_api_keys DISABLE TRIGGER ALL;

COPY public.provider_api_keys (provider, api_key, updated_at) FROM stdin;
\.


ALTER TABLE public.provider_api_keys ENABLE TRIGGER ALL;

--
-- Data for Name: provider_health; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.provider_health DISABLE TRIGGER ALL;

COPY public.provider_health (provider, kind, last_success_at, last_error_at, last_error, consecutive_failures, updated_at) FROM stdin;
\.


ALTER TABLE public.provider_health ENABLE TRIGGER ALL;

--
-- Data for Name: provider_quota; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.provider_quota DISABLE TRIGGER ALL;

COPY public.provider_quota (provider, window_date, count, updated_at) FROM stdin;
\.


ALTER TABLE public.provider_quota ENABLE TRIGGER ALL;

--
-- Data for Name: revolut_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.revolut_raw_transactions DISABLE TRIGGER ALL;

COPY public.revolut_raw_transactions (id, deduplication_hash, created_at, transaction_type, product, started_date, completed_date, description, amount, fee, currency, state, balance, raw_csv_line) FROM stdin;
\.


ALTER TABLE public.revolut_raw_transactions ENABLE TRIGGER ALL;

--
-- Data for Name: sabb_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.sabb_raw_transactions DISABLE TRIGGER ALL;

COPY public.sabb_raw_transactions (id, deduplication_hash, created_at, transaction_date, posting_date, description, amount, currency, status, amount_other_currency, raw_csv_line) FROM stdin;
\.


ALTER TABLE public.sabb_raw_transactions ENABLE TRIGGER ALL;

--
-- Data for Name: saved_charts; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.saved_charts DISABLE TRIGGER ALL;

COPY public.saved_charts (id, name, chart_type, category_ids, created_at, updated_at, recipient_ids, chart_variant, time_bucket, date_range_start, date_range_end) FROM stdin;
\.


ALTER TABLE public.saved_charts ENABLE TRIGGER ALL;

--
-- Data for Name: split_audit; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.split_audit DISABLE TRIGGER ALL;

COPY public.split_audit (id, split_id, action, actor, payload, created_at) FROM stdin;
\.


ALTER TABLE public.split_audit ENABLE TRIGGER ALL;

--
-- Data for Name: split_payments; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.split_payments DISABLE TRIGGER ALL;

COPY public.split_payments (id, split_id, amount, paid_at, note, created_at) FROM stdin;
1	1	36.69	2024-01-14	Terugbetaald	2026-06-19 10:30:18.144566+00
2	2	19.86	2024-06-15	Deelbetaling	2026-06-19 10:30:18.146133+00
3	4	33.53	2025-04-21	Terugbetaald	2026-06-19 10:30:18.148083+00
4	5	66.21	2025-07-10	Deelbetaling	2026-06-19 10:30:18.149231+00
\.


ALTER TABLE public.split_payments ENABLE TRIGGER ALL;

--
-- Data for Name: transaction_raw_references; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.transaction_raw_references DISABLE TRIGGER ALL;

COPY public.transaction_raw_references (id, transaction_id, raw_source_type, raw_source_id, created_at) FROM stdin;
\.


ALTER TABLE public.transaction_raw_references ENABLE TRIGGER ALL;

--
-- Data for Name: transaction_tags; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.transaction_tags DISABLE TRIGGER ALL;

COPY public.transaction_tags (transaction_id, tag_id, created_at) FROM stdin;
8	1	2026-06-19 10:30:18.02099+00
9	1	2026-06-19 10:30:18.022239+00
11	2	2026-06-19 10:30:18.023244+00
12	1	2026-06-19 10:30:18.023793+00
13	1	2026-06-19 10:30:18.024304+00
14	1	2026-06-19 10:30:18.02482+00
41	1	2026-06-19 10:30:18.02619+00
42	1	2026-06-19 10:30:18.026896+00
44	2	2026-06-19 10:30:18.027402+00
45	1	2026-06-19 10:30:18.027897+00
46	1	2026-06-19 10:30:18.028383+00
47	1	2026-06-19 10:30:18.028899+00
71	4	2026-06-19 10:30:18.029353+00
76	1	2026-06-19 10:30:18.029826+00
77	1	2026-06-19 10:30:18.030307+00
79	2	2026-06-19 10:30:18.030774+00
80	1	2026-06-19 10:30:18.031257+00
81	1	2026-06-19 10:30:18.031748+00
82	1	2026-06-19 10:30:18.032287+00
101	2	2026-06-19 10:30:18.032793+00
110	1	2026-06-19 10:30:18.033286+00
111	1	2026-06-19 10:30:18.033897+00
113	2	2026-06-19 10:30:18.034441+00
114	1	2026-06-19 10:30:18.034926+00
115	1	2026-06-19 10:30:18.035425+00
116	1	2026-06-19 10:30:18.0359+00
141	1	2026-06-19 10:30:18.036353+00
142	1	2026-06-19 10:30:18.036808+00
144	2	2026-06-19 10:30:18.037312+00
145	1	2026-06-19 10:30:18.037784+00
146	1	2026-06-19 10:30:18.038257+00
147	1	2026-06-19 10:30:18.038704+00
168	2	2026-06-19 10:30:18.039165+00
177	1	2026-06-19 10:30:18.040316+00
178	1	2026-06-19 10:30:18.040976+00
180	2	2026-06-19 10:30:18.041531+00
181	1	2026-06-19 10:30:18.042633+00
182	1	2026-06-19 10:30:18.04312+00
183	1	2026-06-19 10:30:18.043591+00
212	1	2026-06-19 10:30:18.044058+00
213	1	2026-06-19 10:30:18.044565+00
215	2	2026-06-19 10:30:18.045081+00
216	1	2026-06-19 10:30:18.045534+00
217	1	2026-06-19 10:30:18.045976+00
218	1	2026-06-19 10:30:18.046437+00
235	4	2026-06-19 10:30:18.046902+00
237	2	2026-06-19 10:30:18.047356+00
246	1	2026-06-19 10:30:18.047805+00
247	1	2026-06-19 10:30:18.052069+00
249	2	2026-06-19 10:30:18.053434+00
250	1	2026-06-19 10:30:18.054+00
251	1	2026-06-19 10:30:18.054496+00
252	1	2026-06-19 10:30:18.055034+00
270	2	2026-06-19 10:30:18.055592+00
276	4	2026-06-19 10:30:18.056122+00
281	1	2026-06-19 10:30:18.056614+00
282	1	2026-06-19 10:30:18.057125+00
284	2	2026-06-19 10:30:18.057637+00
285	1	2026-06-19 10:30:18.058152+00
286	1	2026-06-19 10:30:18.05872+00
287	1	2026-06-19 10:30:18.059267+00
308	2	2026-06-19 10:30:18.059786+00
312	4	2026-06-19 10:30:18.060293+00
318	1	2026-06-19 10:30:18.060766+00
319	1	2026-06-19 10:30:18.061319+00
321	2	2026-06-19 10:30:18.061907+00
322	1	2026-06-19 10:30:18.06237+00
323	1	2026-06-19 10:30:18.06286+00
324	1	2026-06-19 10:30:18.063358+00
342	4	2026-06-19 10:30:18.064001+00
343	2	2026-06-19 10:30:18.064592+00
348	4	2026-06-19 10:30:18.065068+00
354	1	2026-06-19 10:30:18.065553+00
355	1	2026-06-19 10:30:18.066032+00
357	2	2026-06-19 10:30:18.066496+00
358	1	2026-06-19 10:30:18.066982+00
359	1	2026-06-19 10:30:18.067815+00
360	1	2026-06-19 10:30:18.068336+00
377	2	2026-06-19 10:30:18.068832+00
386	1	2026-06-19 10:30:18.069356+00
387	1	2026-06-19 10:30:18.06988+00
389	2	2026-06-19 10:30:18.070342+00
390	1	2026-06-19 10:30:18.070807+00
391	1	2026-06-19 10:30:18.071279+00
392	1	2026-06-19 10:30:18.071737+00
409	4	2026-06-19 10:30:18.072204+00
419	1	2026-06-19 10:30:18.072647+00
420	1	2026-06-19 10:30:18.073126+00
422	2	2026-06-19 10:30:18.073575+00
423	1	2026-06-19 10:30:18.074014+00
424	1	2026-06-19 10:30:18.074485+00
425	1	2026-06-19 10:30:18.074945+00
426	1	2026-06-19 10:30:18.075487+00
445	2	2026-06-19 10:30:18.075971+00
454	1	2026-06-19 10:30:18.076505+00
455	1	2026-06-19 10:30:18.076976+00
457	2	2026-06-19 10:30:18.077432+00
458	1	2026-06-19 10:30:18.077891+00
459	1	2026-06-19 10:30:18.078358+00
460	1	2026-06-19 10:30:18.078824+00
461	1	2026-06-19 10:30:18.07927+00
481	2	2026-06-19 10:30:18.079736+00
489	1	2026-06-19 10:30:18.080187+00
490	1	2026-06-19 10:30:18.080624+00
492	2	2026-06-19 10:30:18.081088+00
493	1	2026-06-19 10:30:18.081563+00
494	1	2026-06-19 10:30:18.082014+00
495	1	2026-06-19 10:30:18.082461+00
496	1	2026-06-19 10:30:18.082905+00
516	2	2026-06-19 10:30:18.083346+00
525	1	2026-06-19 10:30:18.083962+00
526	1	2026-06-19 10:30:18.084436+00
528	2	2026-06-19 10:30:18.084873+00
529	1	2026-06-19 10:30:18.085317+00
530	1	2026-06-19 10:30:18.085781+00
531	1	2026-06-19 10:30:18.086243+00
532	1	2026-06-19 10:30:18.086683+00
551	2	2026-06-19 10:30:18.087224+00
559	1	2026-06-19 10:30:18.087707+00
560	1	2026-06-19 10:30:18.088189+00
562	2	2026-06-19 10:30:18.088651+00
563	1	2026-06-19 10:30:18.089117+00
564	1	2026-06-19 10:30:18.089592+00
565	1	2026-06-19 10:30:18.09004+00
566	1	2026-06-19 10:30:18.090479+00
594	1	2026-06-19 10:30:18.090913+00
595	1	2026-06-19 10:30:18.09136+00
597	2	2026-06-19 10:30:18.092151+00
598	1	2026-06-19 10:30:18.092611+00
599	1	2026-06-19 10:30:18.093066+00
600	1	2026-06-19 10:30:18.093567+00
601	1	2026-06-19 10:30:18.094055+00
618	4	2026-06-19 10:30:18.094523+00
620	3	2026-06-19 10:30:18.094971+00
629	1	2026-06-19 10:30:18.095421+00
630	1	2026-06-19 10:30:18.095858+00
632	2	2026-06-19 10:30:18.096314+00
633	1	2026-06-19 10:30:18.096764+00
634	1	2026-06-19 10:30:18.09722+00
635	1	2026-06-19 10:30:18.097664+00
636	1	2026-06-19 10:30:18.098128+00
652	2	2026-06-19 10:30:18.098579+00
653	3	2026-06-19 10:30:18.09902+00
656	4	2026-06-19 10:30:18.099498+00
662	1	2026-06-19 10:30:18.100093+00
663	1	2026-06-19 10:30:18.100552+00
665	2	2026-06-19 10:30:18.10105+00
666	1	2026-06-19 10:30:18.101622+00
667	1	2026-06-19 10:30:18.102073+00
668	1	2026-06-19 10:30:18.102521+00
669	1	2026-06-19 10:30:18.103014+00
687	2	2026-06-19 10:30:18.103479+00
696	1	2026-06-19 10:30:18.103923+00
697	1	2026-06-19 10:30:18.104406+00
699	2	2026-06-19 10:30:18.104861+00
700	1	2026-06-19 10:30:18.105394+00
701	1	2026-06-19 10:30:18.105856+00
702	1	2026-06-19 10:30:18.106298+00
703	1	2026-06-19 10:30:18.107017+00
720	2	2026-06-19 10:30:18.107534+00
723	4	2026-06-19 10:30:18.107997+00
729	1	2026-06-19 10:30:18.108893+00
730	1	2026-06-19 10:30:18.109357+00
732	2	2026-06-19 10:30:18.109802+00
733	1	2026-06-19 10:30:18.110239+00
734	1	2026-06-19 10:30:18.110673+00
735	1	2026-06-19 10:30:18.111116+00
736	1	2026-06-19 10:30:18.11162+00
766	1	2026-06-19 10:30:18.112077+00
767	1	2026-06-19 10:30:18.112542+00
769	2	2026-06-19 10:30:18.112977+00
770	1	2026-06-19 10:30:18.113441+00
771	1	2026-06-19 10:30:18.11392+00
772	1	2026-06-19 10:30:18.11435+00
773	1	2026-06-19 10:30:18.114801+00
794	2	2026-06-19 10:30:18.115251+00
804	1	2026-06-19 10:30:18.115735+00
805	1	2026-06-19 10:30:18.116189+00
807	2	2026-06-19 10:30:18.116637+00
808	1	2026-06-19 10:30:18.117107+00
809	1	2026-06-19 10:30:18.117862+00
810	1	2026-06-19 10:30:18.118313+00
811	1	2026-06-19 10:30:18.118753+00
832	2	2026-06-19 10:30:18.119202+00
843	1	2026-06-19 10:30:18.119636+00
844	1	2026-06-19 10:30:18.120087+00
846	2	2026-06-19 10:30:18.120655+00
847	1	2026-06-19 10:30:18.121132+00
848	1	2026-06-19 10:30:18.121585+00
849	1	2026-06-19 10:30:18.122019+00
850	1	2026-06-19 10:30:18.122488+00
876	1	2026-06-19 10:30:18.122935+00
877	1	2026-06-19 10:30:18.123385+00
879	2	2026-06-19 10:30:18.123828+00
880	1	2026-06-19 10:30:18.124284+00
881	1	2026-06-19 10:30:18.124802+00
882	1	2026-06-19 10:30:18.125345+00
883	1	2026-06-19 10:30:18.125819+00
902	4	2026-06-19 10:30:18.126291+00
907	1	2026-06-19 10:30:18.126794+00
908	1	2026-06-19 10:30:18.127234+00
910	2	2026-06-19 10:30:18.127681+00
911	1	2026-06-19 10:30:18.128138+00
912	1	2026-06-19 10:30:18.128603+00
913	1	2026-06-19 10:30:18.129049+00
914	1	2026-06-19 10:30:18.129497+00
937	2	2026-06-19 10:30:18.12995+00
938	2	2026-06-19 10:30:18.130397+00
947	1	2026-06-19 10:30:18.130887+00
948	1	2026-06-19 10:30:18.131358+00
950	2	2026-06-19 10:30:18.131824+00
951	1	2026-06-19 10:30:18.132275+00
952	1	2026-06-19 10:30:18.132711+00
953	1	2026-06-19 10:30:18.133488+00
954	1	2026-06-19 10:30:18.133952+00
981	4	2026-06-19 10:30:18.134448+00
987	1	2026-06-19 10:30:18.134923+00
988	1	2026-06-19 10:30:18.13541+00
990	2	2026-06-19 10:30:18.135933+00
991	1	2026-06-19 10:30:18.13639+00
992	1	2026-06-19 10:30:18.13685+00
993	1	2026-06-19 10:30:18.137309+00
994	1	2026-06-19 10:30:18.137739+00
1012	2	2026-06-19 10:30:18.138203+00
1015	4	2026-06-19 10:30:18.138644+00
1018	1	2026-06-19 10:30:18.139107+00
1019	1	2026-06-19 10:30:18.139568+00
1021	2	2026-06-19 10:30:18.139998+00
1022	1	2026-06-19 10:30:18.140473+00
1023	1	2026-06-19 10:30:18.140918+00
1024	1	2026-06-19 10:30:18.1414+00
1025	1	2026-06-19 10:30:18.141919+00
\.


ALTER TABLE public.transaction_tags ENABLE TRIGGER ALL;

--
-- Data for Name: user_settings; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.user_settings DISABLE TRIGGER ALL;

COPY public.user_settings (key, value, updated_at, created_at) FROM stdin;
belgian_tax_profile	{"region": "flanders", "taxYear": 2025, "unionDues": 145, "isDisabled": false, "alimonyPaid": 0, "filingStatus": "married_joint", "pensionScheme": "1050", "childcareCosts": 0, "employmentType": "employee", "mortgageRegion": "flanders", "cadastralIncome": 1450, "medicalExpenses": 0, "pensionEligible": true, "isIsolatedParent": false, "isSpouseDisabled": false, "dependentChildren": 1, "grossAnnualIncome": 58000, "mortgageStartYear": 2018, "profileConfigured": true, "otherTaxableIncome": 0, "charitableDonations": 120, "annualDividendIncome": 115, "mortgageInterestPaid": 3300, "taxIncomeCategoryIds": [1, 2], "annualSavingsInterest": 60, "dependentOtherPersons": 0, "lifeInsurancePremiums": 0, "mortgageCapitalRepaid": 7900, "dependentChildrenUnder3": 0, "communalSurchargePercent": 6.9, "spouseProfessionalIncome": 22000, "professionalExpenseMethod": "lump_sum", "actualProfessionalExpenses": 0, "mortgageIsPrimaryResidence": true, "charitableDonationsEligible": true, "personalPensionContributions": 990, "employeeGroupInsuranceContributions": 0}	2026-06-19 10:30:18.913085+00	2026-06-19 10:30:18.913085+00
\.


ALTER TABLE public.user_settings ENABLE TRIGGER ALL;

--
-- Data for Name: vision_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.vision_raw_transactions DISABLE TRIGGER ALL;

COPY public.vision_raw_transactions (id, deduplication_hash, created_at, transaction_date, bank_account, recipient, memo, amount, currency, balance, category, comment, raw_csv_line) FROM stdin;
\.


ALTER TABLE public.vision_raw_transactions ENABLE TRIGGER ALL;

--
-- Data for Name: watchlist; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.watchlist DISABLE TRIGGER ALL;

COPY public.watchlist (id, name, symbol, asset_class, target_price, currency, notes, price_provider_id, created_at, updated_at, added_price) FROM stdin;
1	Tesla Inc.	TSLA	stock	180.000000	USD	\N	\N	2026-06-19 10:30:18.910782+00	2026-06-19 10:30:18.910782+00	\N
2	Microsoft Corp.	MSFT	stock	380.000000	USD	\N	\N	2026-06-19 10:30:18.911632+00	2026-06-19 10:30:18.911632+00	\N
3	VanEck Semiconductor ETF	SMH	etf	250.000000	USD	\N	\N	2026-06-19 10:30:18.912091+00	2026-06-19 10:30:18.912091+00	\N
4	Solana	SOL	crypto	120.000000	EUR	\N	\N	2026-06-19 10:30:18.912568+00	2026-06-19 10:30:18.912568+00	\N
\.


ALTER TABLE public.watchlist ENABLE TRIGGER ALL;

--
-- Data for Name: wise_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.wise_raw_transactions DISABLE TRIGGER ALL;

COPY public.wise_raw_transactions (id, deduplication_hash, created_at, transfer_id, direction, status, finished_on, source_name, source_amount, source_currency, target_name, target_amount, target_currency, exchange_rate, source_fee_amount, source_fee_currency, reference, batch, raw_csv_line) FROM stdin;
\.


ALTER TABLE public.wise_raw_transactions ENABLE TRIGGER ALL;

--
-- Name: accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.accounts_id_seq', 6, true);


--
-- Name: asset_price_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.asset_price_history_id_seq', 903, true);


--
-- Name: attachments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.attachments_id_seq', 1, false);


--
-- Name: belfius_raw_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.belfius_raw_transactions_id_seq', 1, false);


--
-- Name: belgian_inflation_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.belgian_inflation_rates_id_seq', 1, false);


--
-- Name: cashflow_forecast_accuracy_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cashflow_forecast_accuracy_id_seq', 1, false);


--
-- Name: cashflow_forecast_mc_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cashflow_forecast_mc_id_seq', 1, false);


--
-- Name: cashflow_forecast_mc_rolling_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cashflow_forecast_mc_rolling_id_seq', 1, false);


--
-- Name: categories_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.categories_id_seq', 33, true);


--
-- Name: custom_parser_configs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.custom_parser_configs_id_seq', 1, false);


--
-- Name: custom_raw_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.custom_raw_transactions_id_seq', 1, false);


--
-- Name: db_editor_audit_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.db_editor_audit_id_seq', 1, false);


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.exchange_rates_id_seq', 129, true);


--
-- Name: import_batches_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.import_batches_id_seq', 1, false);


--
-- Name: import_staging_rows_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.import_staging_rows_id_seq', 1, false);


--
-- Name: instrument_provider_map_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.instrument_provider_map_id_seq', 1, false);


--
-- Name: investments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.investments_id_seq', 10, true);


--
-- Name: kbc_raw_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.kbc_raw_transactions_id_seq', 1, false);


--
-- Name: manual_raw_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.manual_raw_transactions_id_seq', 1, false);


--
-- Name: planned_transaction_executions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.planned_transaction_executions_id_seq', 1, false);


--
-- Name: planned_transaction_loan_schedule_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.planned_transaction_loan_schedule_id_seq', 300, true);


--
-- Name: planned_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.planned_transactions_id_seq', 8, true);


--
-- Name: portfolio_import_batches_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.portfolio_import_batches_id_seq', 1, false);


--
-- Name: portfolio_import_staging_rows_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.portfolio_import_staging_rows_id_seq', 1, false);


--
-- Name: portfolio_performance_snapshots_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.portfolio_performance_snapshots_id_seq', 1, false);


--
-- Name: portfolio_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.portfolio_transactions_id_seq', 93, true);


--
-- Name: recipient_bank_accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.recipient_bank_accounts_id_seq', 3, true);


--
-- Name: recipient_match_patterns_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.recipient_match_patterns_id_seq', 2, true);


--
-- Name: recipients_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.recipients_id_seq', 53, true);


--
-- Name: revolut_raw_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.revolut_raw_transactions_id_seq', 1, false);


--
-- Name: sabb_raw_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sabb_raw_transactions_id_seq', 1, false);


--
-- Name: saved_charts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.saved_charts_id_seq', 1, false);


--
-- Name: split_audit_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.split_audit_id_seq', 1, false);


--
-- Name: split_payments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.split_payments_id_seq', 4, true);


--
-- Name: tags_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.tags_id_seq', 4, true);


--
-- Name: transaction_raw_references_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.transaction_raw_references_id_seq', 1, false);


--
-- Name: transaction_splits_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.transaction_splits_id_seq', 6, true);


--
-- Name: transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.transactions_id_seq', 1051, true);


--
-- Name: vision_raw_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.vision_raw_transactions_id_seq', 1, false);


--
-- Name: watchlist_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.watchlist_id_seq', 4, true);


--
-- Name: wise_raw_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.wise_raw_transactions_id_seq', 1, false);


--
-- PostgreSQL database dump complete
--

\unrestrict XgzPvPqaGo5JoLzMZlRORrNEitMz7Ruz8APrkQ2NBEaxb7mdoAYERSr8frdLPYj

