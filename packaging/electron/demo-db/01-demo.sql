--
-- PostgreSQL database dump
--

\restrict aP17sl0HKNN6Xlxgby5kXoy24QLxlA6eU4n7dH2CihF8bIWVJAoGXSoK9Pz4XZi

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

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
-- Name: asset_class; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.asset_class AS ENUM (
    'stock',
    'etf',
    'crypto',
    'real_estate',
    'savings',
    'bond',
    'metals'
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
                IF NEW.is_active THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        NEW.recipient_id, NEW.currency, NEW.amount, 1, NEW.date
                    );
                END IF;
                RETURN NEW;
            ELSIF TG_OP = 'DELETE' THEN
                IF OLD.is_active THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        OLD.recipient_id, OLD.currency, -OLD.amount, -1, NULL
                    );
                END IF;
                RETURN OLD;
            ELSIF TG_OP = 'UPDATE' THEN
                IF OLD.is_active THEN
                    PERFORM fn_agg_recipient_totals_apply(
                        OLD.recipient_id, OLD.currency, -OLD.amount, -1, NULL
                    );
                END IF;
                IF NEW.is_active THEN
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
-- Name: fn_split_payment_overpayment_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_split_payment_overpayment_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE
            v_split_amount NUMERIC(15, 2);
            v_paid_total NUMERIC(15, 2);
        BEGIN
            SELECT amount INTO v_split_amount
            FROM transaction_splits
            WHERE id = NEW.split_id;

            IF v_split_amount IS NULL THEN
                RAISE EXCEPTION 'split_payment references missing split_id=%', NEW.split_id
                    USING ERRCODE = '23503';
            END IF;

            SELECT COALESCE(SUM(amount), 0) INTO v_paid_total
            FROM split_payments
            WHERE split_id = NEW.split_id
              AND (TG_OP = 'INSERT' OR id <> NEW.id);

            v_paid_total := v_paid_total + NEW.amount;

            IF v_paid_total > v_split_amount + 0.005 THEN
                RAISE EXCEPTION 'payment would exceed split outstanding balance: paid_total=% > split_amount=%',
                    v_paid_total, v_split_amount
                    USING ERRCODE = '23514';
            END IF;

            RETURN NEW;
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
-- Name: investments_view_update_instead(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.investments_view_update_instead() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            UPDATE investments_base
               SET name = NEW.name,
                   currency = NEW.currency,
                   notes = NEW.notes,
                   is_active = NEW.is_active,
                   price_provider = NEW.price_provider,
                   price_provider_id = NEW.price_provider_id,
                   price_provider_url = NEW.price_provider_url,
                   price_provider_latest_url = NEW.price_provider_latest_url,
                   price_provider_latest_path = NEW.price_provider_latest_path,
                   price_provider_history_url = NEW.price_provider_history_url,
                   price_provider_history_path = NEW.price_provider_history_path,
                   price_provider_history_ts_path = NEW.price_provider_history_ts_path,
                   price_provider_history_price_path = NEW.price_provider_history_price_path,
                   price_updated_at = NEW.price_updated_at
             WHERE id = OLD.id;

            IF OLD.asset_class = 'stock' THEN
                UPDATE stock_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'etf' THEN
                UPDATE etf_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'crypto' THEN
                UPDATE crypto_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'metals' THEN
                UPDATE metals_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'real_estate' THEN
                UPDATE real_estate_investments
                   SET current_price = NEW.current_price,
                       location = NEW.location,
                       municipality = NEW.municipality,
                       cadastral_income = NEW.cadastral_income,
                       municipality_tax_rate = NEW.municipality_tax_rate
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'savings' THEN
                UPDATE savings_investments
                   SET current_price = NEW.current_price,
                       interest_rate = NEW.interest_rate
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'bond' THEN
                UPDATE bond_investments
                   SET current_price = NEW.current_price,
                       interest_rate = NEW.interest_rate,
                       maturity_date = NEW.maturity_date
                 WHERE id = OLD.id;
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
    version_num character varying(64) NOT NULL
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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
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
-- Name: investments_base; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investments_base (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    currency character varying(10) DEFAULT 'EUR'::character varying NOT NULL,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    price_provider public.price_provider DEFAULT 'manual'::public.price_provider,
    price_provider_id character varying(200),
    price_provider_url character varying(500),
    price_updated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    price_provider_latest_url character varying(500),
    price_provider_latest_path character varying(300),
    price_provider_history_url character varying(500),
    price_provider_history_path character varying(300),
    price_provider_history_ts_path character varying(300),
    price_provider_history_price_path character varying(300)
);


--
-- Name: investments_base_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investments_base_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investments_base_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investments_base_id_seq OWNED BY public.investments_base.id;


--
-- Name: bond_investments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bond_investments (
    id integer DEFAULT nextval('public.investments_base_id_seq'::regclass) NOT NULL,
    current_price numeric(18,6),
    interest_rate numeric(8,4),
    maturity_date date
)
INHERITS (public.investments_base);


--
-- Name: bond_investments_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.bond_investments_full AS
 SELECT ib.id,
    ib.name,
    ib.currency,
    ib.notes,
    ib.is_active,
    ib.price_provider,
    ib.price_provider_id,
    ib.price_provider_url,
    ib.price_updated_at,
    ib.created_at,
    ib.updated_at,
    bi.current_price,
    bi.interest_rate,
    bi.maturity_date
   FROM (public.investments_base ib
     JOIN public.bond_investments bi ON ((ib.id = bi.id)));


--
-- Name: portfolio_transactions_base; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio_transactions_base (
    id integer NOT NULL,
    investment_id integer NOT NULL,
    type public.portfolio_txn_type NOT NULL,
    date date NOT NULL,
    amount numeric(18,4) NOT NULL,
    fees numeric(18,4) DEFAULT 0,
    taxes numeric(18,4) DEFAULT 0,
    currency character varying(10) DEFAULT 'EUR'::character varying NOT NULL,
    note text,
    is_recurring boolean DEFAULT false NOT NULL,
    recurrence_interval public.recurrence_interval,
    recurrence_end_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fx_rate_to_eur numeric(20,10)
);


--
-- Name: portfolio_transactions_base_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portfolio_transactions_base_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_transactions_base_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portfolio_transactions_base_id_seq OWNED BY public.portfolio_transactions_base.id;


--
-- Name: bond_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bond_transactions (
    id integer DEFAULT nextval('public.portfolio_transactions_base_id_seq'::regclass) NOT NULL,
    investment_id integer NOT NULL
)
INHERITS (public.portfolio_transactions_base);


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
    is_active boolean,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now() NOT NULL
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
-- Name: crypto_investments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crypto_investments (
    id integer DEFAULT nextval('public.investments_base_id_seq'::regclass) NOT NULL,
    symbol character varying(50),
    current_price numeric(18,6)
)
INHERITS (public.investments_base);


--
-- Name: crypto_investments_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.crypto_investments_full AS
 SELECT ib.id,
    ib.name,
    ib.currency,
    ib.notes,
    ib.is_active,
    ib.price_provider,
    ib.price_provider_id,
    ib.price_provider_url,
    ib.price_updated_at,
    ib.created_at,
    ib.updated_at,
    ci.symbol,
    ci.current_price
   FROM (public.investments_base ib
     JOIN public.crypto_investments ci ON ((ib.id = ci.id)));


--
-- Name: crypto_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crypto_transactions (
    id integer DEFAULT nextval('public.portfolio_transactions_base_id_seq'::regclass) NOT NULL,
    investment_id integer NOT NULL,
    units numeric(18,8),
    price_per_unit numeric(18,6)
)
INHERITS (public.portfolio_transactions_base);


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
-- Name: etf_investments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.etf_investments (
    id integer DEFAULT nextval('public.investments_base_id_seq'::regclass) NOT NULL,
    symbol character varying(20),
    current_price numeric(18,6)
)
INHERITS (public.investments_base);


--
-- Name: etf_investments_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.etf_investments_full AS
 SELECT ib.id,
    ib.name,
    ib.currency,
    ib.notes,
    ib.is_active,
    ib.price_provider,
    ib.price_provider_id,
    ib.price_provider_url,
    ib.price_updated_at,
    ib.created_at,
    ib.updated_at,
    ei.symbol,
    ei.current_price
   FROM (public.investments_base ib
     JOIN public.etf_investments ei ON ((ib.id = ei.id)));


--
-- Name: etf_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.etf_transactions (
    id integer DEFAULT nextval('public.portfolio_transactions_base_id_seq'::regclass) NOT NULL,
    investment_id integer NOT NULL,
    units numeric(18,8),
    price_per_unit numeric(18,6)
)
INHERITS (public.portfolio_transactions_base);


--
-- Name: exchange_rate_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exchange_rate_cache (
    id integer NOT NULL,
    from_ccy character(3) NOT NULL,
    to_ccy character(3) NOT NULL,
    rate_date date NOT NULL,
    rate numeric(20,10) NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_exchange_rate_cache_rate_positive CHECK ((rate > (0)::numeric))
);


--
-- Name: exchange_rate_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.exchange_rate_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: exchange_rate_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.exchange_rate_cache_id_seq OWNED BY public.exchange_rate_cache.id;


--
-- Name: exchange_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exchange_rates (
    id integer NOT NULL,
    currency_code character varying(3) NOT NULL,
    rate_to_eur numeric(20,10) NOT NULL,
    rate_date date NOT NULL,
    is_latest boolean,
    fetched_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_exchange_rate_positive CHECK ((rate_to_eur > (0)::numeric))
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
-- Name: metals_investments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metals_investments (
    id integer DEFAULT nextval('public.investments_base_id_seq'::regclass) NOT NULL,
    symbol character varying(20),
    current_price numeric(18,6)
)
INHERITS (public.investments_base);


--
-- Name: real_estate_investments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.real_estate_investments (
    id integer DEFAULT nextval('public.investments_base_id_seq'::regclass) NOT NULL,
    current_price numeric(18,6),
    location character varying(300),
    municipality character varying(200),
    cadastral_income numeric(12,2),
    municipality_tax_rate numeric(8,4)
)
INHERITS (public.investments_base);


--
-- Name: savings_investments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.savings_investments (
    id integer DEFAULT nextval('public.investments_base_id_seq'::regclass) NOT NULL,
    current_price numeric(18,6),
    interest_rate numeric(8,4)
)
INHERITS (public.investments_base);


--
-- Name: stock_investments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_investments (
    id integer DEFAULT nextval('public.investments_base_id_seq'::regclass) NOT NULL,
    symbol character varying(20),
    current_price numeric(18,6)
)
INHERITS (public.investments_base);


--
-- Name: investments; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.investments AS
 SELECT ib.id,
    ib.name,
        CASE
            WHEN (si.id IS NOT NULL) THEN 'stock'::text
            WHEN (ei.id IS NOT NULL) THEN 'etf'::text
            WHEN (ci.id IS NOT NULL) THEN 'crypto'::text
            WHEN (mi.id IS NOT NULL) THEN 'metals'::text
            WHEN (rei.id IS NOT NULL) THEN 'real_estate'::text
            WHEN (savi.id IS NOT NULL) THEN 'savings'::text
            WHEN (bi.id IS NOT NULL) THEN 'bond'::text
            ELSE NULL::text
        END AS asset_class,
    ib.currency,
    ib.notes,
    ib.is_active,
    ib.price_provider,
    ib.price_provider_id,
    ib.price_provider_url,
    ib.price_updated_at,
    ib.created_at,
    ib.updated_at,
    COALESCE(si.symbol, ei.symbol, ci.symbol, mi.symbol) AS symbol,
    COALESCE(si.current_price, ei.current_price, ci.current_price, mi.current_price, rei.current_price, savi.current_price, bi.current_price) AS current_price,
    savi.interest_rate,
    bi.maturity_date,
    rei.location,
    rei.municipality,
    rei.cadastral_income,
    rei.municipality_tax_rate,
    ib.price_provider_latest_url,
    ib.price_provider_latest_path,
    ib.price_provider_history_url,
    ib.price_provider_history_path,
    ib.price_provider_history_ts_path,
    ib.price_provider_history_price_path
   FROM (((((((public.investments_base ib
     LEFT JOIN public.stock_investments si ON ((ib.id = si.id)))
     LEFT JOIN public.etf_investments ei ON ((ib.id = ei.id)))
     LEFT JOIN public.crypto_investments ci ON ((ib.id = ci.id)))
     LEFT JOIN public.metals_investments mi ON ((ib.id = mi.id)))
     LEFT JOIN public.real_estate_investments rei ON ((ib.id = rei.id)))
     LEFT JOIN public.savings_investments savi ON ((ib.id = savi.id)))
     LEFT JOIN public.bond_investments bi ON ((ib.id = bi.id)));


--
-- Name: kbc_raw_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kbc_raw_transactions (
    id integer NOT NULL,
    deduplication_hash character varying(64) NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
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
    raw_csv_line text NOT NULL,
    CONSTRAINT ck_kbc_account_len CHECK ((length((account_number)::text) <= 34))
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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
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
-- Name: metals_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metals_transactions (
    id integer DEFAULT nextval('public.portfolio_transactions_base_id_seq'::regclass) NOT NULL,
    investment_id integer NOT NULL,
    units numeric(18,8),
    price_per_unit numeric(18,6)
)
INHERITS (public.portfolio_transactions_base);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id integer NOT NULL,
    date date NOT NULL,
    amount numeric(18,4) NOT NULL,
    currency character varying(3),
    balance numeric(15,2),
    memo text,
    comment text,
    bank_account text,
    recipient_id integer NOT NULL,
    recipient_bank_account_id integer,
    category_id integer,
    is_active boolean NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    import_batch_id bigint,
    matched_pattern_id integer,
    tx_hash text,
    CONSTRAINT ck_transactions_currency_len CHECK (((length((currency)::text) = 3) OR (currency IS NULL)))
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
-- Name: mv_cashflow_daily; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_cashflow_daily AS
 SELECT date,
    (EXTRACT(day FROM date))::integer AS day_of_month,
    (date_trunc('month'::text, (date)::timestamp with time zone))::date AS month_start,
    currency,
    sum(amount) AS net
   FROM public.transactions t
  WHERE ((is_active = true) AND (date >= (date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone) - '6 mons'::interval)))
  GROUP BY date, ((EXTRACT(day FROM date))::integer), ((date_trunc('month'::text, (date)::timestamp with time zone))::date), currency
  ORDER BY date
  WITH NO DATA;


--
-- Name: recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipients (
    id integer NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    default_category_id integer,
    notes text,
    is_active boolean,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    primary_recipient_id integer
);


--
-- Name: mv_category_totals; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_category_totals AS
 SELECT COALESCE(c.id, '-1'::integer) AS category_id,
    COALESCE(((c.general || ':'::text) || c.detail), 'UNCATEGORISED'::text) AS name,
    count(*) AS count,
    sum(t.amount) AS total,
    t.currency
   FROM ((public.transactions t
     LEFT JOIN public.recipients r ON ((t.recipient_id = r.id)))
     LEFT JOIN public.categories c ON ((COALESCE(t.category_id, r.default_category_id) = c.id)))
  WHERE (t.is_active = true)
  GROUP BY COALESCE(c.id, '-1'::integer), COALESCE(((c.general || ':'::text) || c.detail), 'UNCATEGORISED'::text), t.currency
  ORDER BY (count(*)) DESC
  WITH NO DATA;


--
-- Name: mv_monthly_summary; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_monthly_summary AS
 SELECT (date_trunc('month'::text, (t.date)::timestamp with time zone))::date AS month_start,
    (EXTRACT(month FROM t.date))::integer AS month,
    (EXTRACT(year FROM t.date))::integer AS year,
    t.currency,
    count(*) AS transaction_count,
    sum(
        CASE
            WHEN (t.amount >= (0)::numeric) THEN t.amount
            ELSE (0)::numeric
        END) AS total_income,
    sum(
        CASE
            WHEN (t.amount < (0)::numeric) THEN t.amount
            ELSE (0)::numeric
        END) AS total_spending,
    sum(t.amount) AS net_amount,
    c.id AS category_id,
    COALESCE(c.id, '-1'::integer) AS category_id_key,
    COALESCE(((c.general || ':'::text) || c.detail), 'UNCATEGORISED'::text) AS category_name
   FROM ((public.transactions t
     LEFT JOIN public.recipients r ON ((t.recipient_id = r.id)))
     LEFT JOIN public.categories c ON ((COALESCE(t.category_id, r.default_category_id) = c.id)))
  WHERE ((t.is_active = true) AND (t.date >= (date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone) - '1 year'::interval)))
  GROUP BY ((date_trunc('month'::text, (t.date)::timestamp with time zone))::date), ((EXTRACT(month FROM t.date))::integer), ((EXTRACT(year FROM t.date))::integer), t.currency, c.id, COALESCE(((c.general || ':'::text) || c.detail), 'UNCATEGORISED'::text)
  ORDER BY ((date_trunc('month'::text, (t.date)::timestamp with time zone))::date)
  WITH NO DATA;


--
-- Name: planned_transaction_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planned_transaction_executions (
    id integer NOT NULL,
    planned_transaction_id integer NOT NULL,
    executed_transaction_id integer NOT NULL,
    execution_date date NOT NULL,
    created_at timestamp without time zone DEFAULT now()
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
    currency character varying(3),
    memo text,
    comment text,
    bank_account text,
    recipient_id integer,
    category_id integer,
    is_recurring boolean NOT NULL,
    recurrence_pattern text,
    is_executed boolean NOT NULL,
    last_executed_date date,
    is_active boolean NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    url text,
    is_loan boolean DEFAULT false NOT NULL,
    loan_type text,
    loan_principal numeric(15,2),
    loan_annual_interest_rate numeric(8,4),
    loan_term_months integer,
    loan_start_date date,
    loan_payment_day integer,
    loan_regular_payment_amount numeric(15,2),
    loan_first_payment_date date,
    reminder_days_before integer,
    CONSTRAINT ck_planned_transactions_currency_len CHECK (((length((currency)::text) = 3) OR (currency IS NULL)))
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
-- Name: stock_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_transactions (
    id integer DEFAULT nextval('public.portfolio_transactions_base_id_seq'::regclass) NOT NULL,
    investment_id integer NOT NULL,
    units numeric(18,8),
    price_per_unit numeric(18,6)
)
INHERITS (public.portfolio_transactions_base);


--
-- Name: portfolio_transactions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.portfolio_transactions AS
 SELECT ptb.id,
    ptb.investment_id,
    ptb.type,
    ptb.date,
    ptb.amount,
    COALESCE(st.units, et.units, ct.units, mt.units) AS units,
    COALESCE(st.price_per_unit, et.price_per_unit, ct.price_per_unit, mt.price_per_unit) AS price_per_unit,
    ptb.fees,
    ptb.taxes,
    ptb.currency,
    ptb.note,
    ptb.is_recurring,
    ptb.recurrence_interval,
    ptb.recurrence_end_date,
    ptb.created_at,
    ptb.updated_at,
    ptb.fx_rate_to_eur
   FROM ((((public.portfolio_transactions_base ptb
     LEFT JOIN public.stock_transactions st ON ((ptb.id = st.id)))
     LEFT JOIN public.etf_transactions et ON ((ptb.id = et.id)))
     LEFT JOIN public.crypto_transactions ct ON ((ptb.id = ct.id)))
     LEFT JOIN public.metals_transactions mt ON ((ptb.id = mt.id)));


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
-- Name: real_estate_investments_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.real_estate_investments_full AS
 SELECT ib.id,
    ib.name,
    ib.currency,
    ib.notes,
    ib.is_active,
    ib.price_provider,
    ib.price_provider_id,
    ib.price_provider_url,
    ib.price_updated_at,
    ib.created_at,
    ib.updated_at,
    rei.current_price,
    rei.location,
    rei.municipality,
    rei.cadastral_income,
    rei.municipality_tax_rate
   FROM (public.investments_base ib
     JOIN public.real_estate_investments rei ON ((ib.id = rei.id)));


--
-- Name: real_estate_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.real_estate_transactions (
    id integer DEFAULT nextval('public.portfolio_transactions_base_id_seq'::regclass) NOT NULL,
    investment_id integer NOT NULL
)
INHERITS (public.portfolio_transactions_base);


--
-- Name: recipient_bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipient_bank_accounts (
    id integer NOT NULL,
    recipient_id integer NOT NULL,
    account_number character varying(34) NOT NULL,
    bank_name text,
    account_label text,
    address text,
    is_primary boolean NOT NULL,
    is_active boolean NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now() NOT NULL
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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    transaction_type character varying(50) NOT NULL,
    product character varying(50) NOT NULL,
    started_date timestamp without time zone,
    completed_date timestamp without time zone NOT NULL,
    description text NOT NULL,
    amount numeric(15,2) NOT NULL,
    fee numeric(15,2),
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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category_ids integer[] DEFAULT '{}'::integer[],
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
-- Name: savings_investments_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.savings_investments_full AS
 SELECT ib.id,
    ib.name,
    ib.currency,
    ib.notes,
    ib.is_active,
    ib.price_provider,
    ib.price_provider_id,
    ib.price_provider_url,
    ib.price_updated_at,
    ib.created_at,
    ib.updated_at,
    savi.current_price,
    savi.interest_rate
   FROM (public.investments_base ib
     JOIN public.savings_investments savi ON ((ib.id = savi.id)));


--
-- Name: savings_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.savings_transactions (
    id integer DEFAULT nextval('public.portfolio_transactions_base_id_seq'::regclass) NOT NULL,
    investment_id integer NOT NULL
)
INHERITS (public.portfolio_transactions_base);


--
-- Name: schema_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_version (
    id integer NOT NULL,
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now()
);


--
-- Name: schema_version_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schema_version_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schema_version_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schema_version_id_seq OWNED BY public.schema_version.id;


--
-- Name: split_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.split_audit (
    id bigint NOT NULL,
    split_id integer,
    action character varying(32) NOT NULL,
    actor character varying(64),
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
-- Name: stock_investments_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.stock_investments_full AS
 SELECT ib.id,
    ib.name,
    ib.currency,
    ib.notes,
    ib.is_active,
    ib.price_provider,
    ib.price_provider_id,
    ib.price_provider_url,
    ib.price_updated_at,
    ib.created_at,
    ib.updated_at,
    si.symbol,
    si.current_price
   FROM (public.investments_base ib
     JOIN public.stock_investments si ON ((ib.id = si.id)));


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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_raw_source_id_non_negative CHECK ((raw_source_id >= 0))
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
    updated_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: bond_investments currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_investments ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: bond_investments is_active; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_investments ALTER COLUMN is_active SET DEFAULT true;


--
-- Name: bond_investments price_provider; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_investments ALTER COLUMN price_provider SET DEFAULT 'manual'::public.price_provider;


--
-- Name: bond_investments created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_investments ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: bond_investments updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_investments ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: bond_transactions fees; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions ALTER COLUMN fees SET DEFAULT 0;


--
-- Name: bond_transactions taxes; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions ALTER COLUMN taxes SET DEFAULT 0;


--
-- Name: bond_transactions currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: bond_transactions is_recurring; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions ALTER COLUMN is_recurring SET DEFAULT false;


--
-- Name: bond_transactions created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: bond_transactions updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions ALTER COLUMN updated_at SET DEFAULT now();


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
-- Name: crypto_investments currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_investments ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: crypto_investments is_active; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_investments ALTER COLUMN is_active SET DEFAULT true;


--
-- Name: crypto_investments price_provider; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_investments ALTER COLUMN price_provider SET DEFAULT 'manual'::public.price_provider;


--
-- Name: crypto_investments created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_investments ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: crypto_investments updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_investments ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: crypto_transactions fees; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_transactions ALTER COLUMN fees SET DEFAULT 0;


--
-- Name: crypto_transactions taxes; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_transactions ALTER COLUMN taxes SET DEFAULT 0;


--
-- Name: crypto_transactions currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_transactions ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: crypto_transactions is_recurring; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_transactions ALTER COLUMN is_recurring SET DEFAULT false;


--
-- Name: crypto_transactions created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_transactions ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: crypto_transactions updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_transactions ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: custom_parser_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_parser_configs ALTER COLUMN id SET DEFAULT nextval('public.custom_parser_configs_id_seq'::regclass);


--
-- Name: custom_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.custom_raw_transactions_id_seq'::regclass);


--
-- Name: etf_investments currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_investments ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: etf_investments is_active; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_investments ALTER COLUMN is_active SET DEFAULT true;


--
-- Name: etf_investments price_provider; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_investments ALTER COLUMN price_provider SET DEFAULT 'manual'::public.price_provider;


--
-- Name: etf_investments created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_investments ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: etf_investments updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_investments ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: etf_transactions fees; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_transactions ALTER COLUMN fees SET DEFAULT 0;


--
-- Name: etf_transactions taxes; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_transactions ALTER COLUMN taxes SET DEFAULT 0;


--
-- Name: etf_transactions currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_transactions ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: etf_transactions is_recurring; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_transactions ALTER COLUMN is_recurring SET DEFAULT false;


--
-- Name: etf_transactions created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_transactions ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: etf_transactions updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_transactions ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: exchange_rate_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rate_cache ALTER COLUMN id SET DEFAULT nextval('public.exchange_rate_cache_id_seq'::regclass);


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
-- Name: investments_base id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investments_base ALTER COLUMN id SET DEFAULT nextval('public.investments_base_id_seq'::regclass);


--
-- Name: kbc_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kbc_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.kbc_raw_transactions_id_seq'::regclass);


--
-- Name: manual_raw_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_raw_transactions ALTER COLUMN id SET DEFAULT nextval('public.manual_raw_transactions_id_seq'::regclass);


--
-- Name: metals_investments currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_investments ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: metals_investments is_active; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_investments ALTER COLUMN is_active SET DEFAULT true;


--
-- Name: metals_investments price_provider; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_investments ALTER COLUMN price_provider SET DEFAULT 'manual'::public.price_provider;


--
-- Name: metals_investments created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_investments ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: metals_investments updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_investments ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: metals_transactions fees; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_transactions ALTER COLUMN fees SET DEFAULT 0;


--
-- Name: metals_transactions taxes; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_transactions ALTER COLUMN taxes SET DEFAULT 0;


--
-- Name: metals_transactions currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_transactions ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: metals_transactions is_recurring; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_transactions ALTER COLUMN is_recurring SET DEFAULT false;


--
-- Name: metals_transactions created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_transactions ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: metals_transactions updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_transactions ALTER COLUMN updated_at SET DEFAULT now();


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
-- Name: portfolio_transactions_base id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_transactions_base ALTER COLUMN id SET DEFAULT nextval('public.portfolio_transactions_base_id_seq'::regclass);


--
-- Name: real_estate_investments currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_investments ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: real_estate_investments is_active; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_investments ALTER COLUMN is_active SET DEFAULT true;


--
-- Name: real_estate_investments price_provider; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_investments ALTER COLUMN price_provider SET DEFAULT 'manual'::public.price_provider;


--
-- Name: real_estate_investments created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_investments ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: real_estate_investments updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_investments ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: real_estate_transactions fees; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_transactions ALTER COLUMN fees SET DEFAULT 0;


--
-- Name: real_estate_transactions taxes; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_transactions ALTER COLUMN taxes SET DEFAULT 0;


--
-- Name: real_estate_transactions currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_transactions ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: real_estate_transactions is_recurring; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_transactions ALTER COLUMN is_recurring SET DEFAULT false;


--
-- Name: real_estate_transactions created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_transactions ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: real_estate_transactions updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_transactions ALTER COLUMN updated_at SET DEFAULT now();


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
-- Name: savings_investments currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_investments ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: savings_investments is_active; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_investments ALTER COLUMN is_active SET DEFAULT true;


--
-- Name: savings_investments price_provider; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_investments ALTER COLUMN price_provider SET DEFAULT 'manual'::public.price_provider;


--
-- Name: savings_investments created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_investments ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: savings_investments updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_investments ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: savings_transactions fees; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_transactions ALTER COLUMN fees SET DEFAULT 0;


--
-- Name: savings_transactions taxes; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_transactions ALTER COLUMN taxes SET DEFAULT 0;


--
-- Name: savings_transactions currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_transactions ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: savings_transactions is_recurring; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_transactions ALTER COLUMN is_recurring SET DEFAULT false;


--
-- Name: savings_transactions created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_transactions ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: savings_transactions updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_transactions ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: schema_version id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_version ALTER COLUMN id SET DEFAULT nextval('public.schema_version_id_seq'::regclass);


--
-- Name: split_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.split_audit ALTER COLUMN id SET DEFAULT nextval('public.split_audit_id_seq'::regclass);


--
-- Name: split_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.split_payments ALTER COLUMN id SET DEFAULT nextval('public.split_payments_id_seq'::regclass);


--
-- Name: stock_investments currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_investments ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: stock_investments is_active; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_investments ALTER COLUMN is_active SET DEFAULT true;


--
-- Name: stock_investments price_provider; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_investments ALTER COLUMN price_provider SET DEFAULT 'manual'::public.price_provider;


--
-- Name: stock_investments created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_investments ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: stock_investments updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_investments ALTER COLUMN updated_at SET DEFAULT now();


--
-- Name: stock_transactions fees; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transactions ALTER COLUMN fees SET DEFAULT 0;


--
-- Name: stock_transactions taxes; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transactions ALTER COLUMN taxes SET DEFAULT 0;


--
-- Name: stock_transactions currency; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transactions ALTER COLUMN currency SET DEFAULT 'EUR'::character varying;


--
-- Name: stock_transactions is_recurring; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transactions ALTER COLUMN is_recurring SET DEFAULT false;


--
-- Name: stock_transactions created_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transactions ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: stock_transactions updated_at; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transactions ALTER COLUMN updated_at SET DEFAULT now();


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
-- Data for Name: agg_recipient_totals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agg_recipient_totals (recipient_id, currency, total_amount, transaction_count, last_transaction_date, updated_at) FROM stdin;
46	EUR	-399.11	1	2024-08-10	2026-06-18 08:45:15.510273+00
42	EUR	-1617.85	3	2025-03-11	2026-06-18 08:45:15.510273+00
44	EUR	-708.74	7	2025-05-09	2026-06-18 08:45:15.510273+00
48	EUR	-120.33	3	2025-10-04	2026-06-18 08:45:15.510273+00
18	EUR	-2020.67	3	2025-10-15	2026-06-18 08:45:15.510273+00
24	EUR	-1398.06	19	2025-12-25	2026-06-18 08:45:15.510273+00
45	EUR	-1410.02	6	2026-02-08	2026-06-18 08:45:15.510273+00
25	EUR	-1877.04	23	2026-03-30	2026-06-18 08:45:15.510273+00
38	EUR	-88.21	2	2026-03-07	2026-06-18 08:45:15.510273+00
17	EUR	197.63	10	2026-04-02	2026-06-18 08:45:15.510273+00
15	EUR	-258.24	9	2026-04-16	2026-06-18 08:45:15.510273+00
29	EUR	-811.00	12	2026-04-09	2026-06-18 08:45:15.510273+00
33	EUR	-309.34	61	2026-04-27	2026-06-18 08:45:15.510273+00
40	EUR	-1603.59	5	2026-04-30	2026-06-18 08:45:15.510273+00
49	EUR	-264.78	6	2026-04-08	2026-06-18 08:45:15.510273+00
20	EUR	-382.00	11	2026-04-22	2026-06-18 08:45:15.510273+00
1	EUR	103893.00	31	2026-05-25	2026-06-18 08:45:15.510273+00
19	EUR	0.00	58	2026-05-28	2026-06-18 08:45:15.510273+00
5	EUR	-574.91	10	2026-05-15	2026-06-18 08:45:15.510273+00
16	EUR	-21750.00	29	2026-05-27	2026-06-18 08:45:15.510273+00
21	EUR	-1632.60	21	2026-05-11	2026-06-18 08:45:15.510273+00
26	EUR	-1710.26	24	2026-05-18	2026-06-18 08:45:15.510273+00
27	EUR	-1115.92	17	2026-05-26	2026-06-18 08:45:15.510273+00
32	EUR	-1317.33	23	2026-05-11	2026-06-18 08:45:15.510273+00
37	EUR	-415.82	17	2026-05-06	2026-06-18 08:45:15.510273+00
39	EUR	-123.61	13	2026-05-20	2026-06-18 08:45:15.510273+00
2	EUR	43007.00	30	2026-06-05	2026-06-18 08:45:15.510273+00
3	EUR	5214.72	9	2026-06-15	2026-06-18 08:45:15.510273+00
53	EUR	-27974.40	30	2026-06-03	2026-06-18 08:45:15.510273+00
4	EUR	-3584.67	30	2026-06-10	2026-06-18 08:45:15.510273+00
6	EUR	-1620.00	30	2026-06-12	2026-06-18 08:45:15.510273+00
7	EUR	-660.00	30	2026-06-12	2026-06-18 08:45:15.510273+00
12	EUR	-1350.00	30	2026-06-06	2026-06-18 08:45:15.510273+00
13	EUR	-1140.00	30	2026-06-06	2026-06-18 08:45:15.510273+00
8	EUR	-419.70	30	2026-06-18	2026-06-18 08:45:15.510273+00
9	EUR	-329.70	30	2026-06-05	2026-06-18 08:45:15.510273+00
10	EUR	-161.82	18	2026-06-05	2026-06-18 08:45:15.510273+00
11	EUR	-899.70	30	2026-06-02	2026-06-18 08:45:15.510273+00
14	EUR	-1470.00	30	2026-06-03	2026-06-18 08:45:15.510273+00
23	EUR	-2090.24	25	2026-06-09	2026-06-18 08:45:15.510273+00
22	EUR	-2009.64	23	2026-06-05	2026-06-18 08:45:15.510273+00
28	EUR	-1067.45	16	2026-06-06	2026-06-18 08:45:15.510273+00
30	EUR	-1385.65	25	2026-06-04	2026-06-18 08:45:15.510273+00
31	EUR	-1759.62	30	2026-06-13	2026-06-18 08:45:15.510273+00
34	EUR	-356.05	69	2026-06-16	2026-06-18 08:45:15.510273+00
36	EUR	-842.95	29	2026-06-09	2026-06-18 08:45:15.510273+00
35	EUR	-768.39	28	2026-06-01	2026-06-18 08:45:15.510273+00
41	EUR	-2312.24	6	2026-06-14	2026-06-18 08:45:15.510273+00
43	EUR	-588.55	5	2026-06-04	2026-06-18 08:45:15.510273+00
47	EUR	-1726.59	4	2026-06-01	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: agg_split_outstanding; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agg_split_outstanding (split_id, recipient_id, original_amount, paid_amount, outstanding_amount, updated_at) FROM stdin;
1	50	36.69	36.69	0.00	2026-06-18 08:45:15.510273+00
2	51	39.71	19.86	19.85	2026-06-18 08:45:15.510273+00
3	52	27.52	0.00	27.52	2026-06-18 08:45:15.510273+00
4	50	33.53	33.53	0.00	2026-06-18 08:45:15.510273+00
5	51	132.42	66.21	66.21	2026-06-18 08:45:15.510273+00
6	52	37.38	0.00	37.38	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: ai_conversations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ai_conversations (id, title, model, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: ai_messages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ai_messages (id, conversation_id, role, content, tool_name, tool_args, tool_result, status, created_at) FROM stdin;
\.


--
-- Data for Name: alembic_version; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.alembic_version (version_num) FROM stdin;
0043_add_provider_api_keys
\.


--
-- Data for Name: asset_price_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.asset_price_history (id, investment_id, price_date, close_price, source, fetched_at, updated_at) FROM stdin;
1	1	2024-01-01	71.252899	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
2	1	2024-01-08	72.249798	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
3	1	2024-01-15	71.145072	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
4	1	2024-01-22	70.234886	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
5	1	2024-01-29	70.351336	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
6	1	2024-02-05	71.442103	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
7	1	2024-02-12	71.913414	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
8	1	2024-02-19	72.221122	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
9	1	2024-02-26	73.187559	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
10	1	2024-03-04	72.490240	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
11	1	2024-03-11	72.382433	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
12	1	2024-03-18	72.256851	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
13	1	2024-03-25	72.564274	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
14	1	2024-04-01	72.163848	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
15	1	2024-04-08	72.085381	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
16	1	2024-04-15	72.542167	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
17	1	2024-04-22	72.893955	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
18	1	2024-04-29	73.362717	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
19	1	2024-05-06	73.544992	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
20	1	2024-05-13	73.609761	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
21	1	2024-05-20	72.729713	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
22	1	2024-05-27	73.854531	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
23	1	2024-06-03	74.350777	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
24	1	2024-06-10	75.187676	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
25	1	2024-06-17	75.213624	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
26	1	2024-06-24	75.759129	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
27	1	2024-07-01	75.870909	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
28	1	2024-07-08	76.875870	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
29	1	2024-07-15	78.226405	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
30	1	2024-07-22	77.007983	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
31	1	2024-07-29	77.000982	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
32	1	2024-08-05	76.746260	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
33	1	2024-08-12	77.328793	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
34	1	2024-08-19	76.107844	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
35	1	2024-08-26	75.683272	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
36	1	2024-09-02	76.533025	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
37	1	2024-09-09	77.584700	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
38	1	2024-09-16	77.348197	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
39	1	2024-09-23	77.601341	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
40	1	2024-09-30	77.313663	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
41	1	2024-10-07	77.741108	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
42	1	2024-10-14	76.635230	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
43	1	2024-10-21	78.081614	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
44	1	2024-10-28	78.203082	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
45	1	2024-11-04	79.260638	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
46	1	2024-11-11	78.511741	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
47	1	2024-11-18	77.293640	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
48	1	2024-11-25	77.818851	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
49	1	2024-12-02	78.642784	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
50	1	2024-12-09	78.197145	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
51	1	2024-12-16	79.340618	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
52	1	2024-12-23	79.662665	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
53	1	2024-12-30	80.430825	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
54	1	2025-01-06	80.069987	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
55	1	2025-01-13	80.171882	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
56	1	2025-01-20	79.607130	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
57	1	2025-01-27	80.759528	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
58	1	2025-02-03	80.761674	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
59	1	2025-02-10	81.427354	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
60	1	2025-02-17	81.489697	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
61	1	2025-02-24	80.937944	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
62	1	2025-03-03	81.182576	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
63	1	2025-03-10	80.079827	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
64	1	2025-03-17	80.516277	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
65	1	2025-03-24	79.719202	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
66	1	2025-03-31	78.866700	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
67	1	2025-04-07	79.669102	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
68	1	2025-04-14	80.956476	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
69	1	2025-04-21	79.833404	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
70	1	2025-04-28	80.139621	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
71	1	2025-05-05	79.318435	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
72	1	2025-05-12	80.471421	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
73	1	2025-05-19	81.911172	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
74	1	2025-05-26	82.852977	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
75	1	2025-06-02	83.906920	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
76	1	2025-06-09	83.267625	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
77	1	2025-06-16	83.488898	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
78	1	2025-06-23	84.379861	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
79	1	2025-06-30	84.806867	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
80	1	2025-07-07	86.394201	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
81	1	2025-07-14	85.599237	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
82	1	2025-07-21	85.191753	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
83	1	2025-07-28	85.900154	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
84	1	2025-08-04	84.661236	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
85	1	2025-08-11	86.237075	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
86	1	2025-08-18	87.225788	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
87	1	2025-08-25	86.025574	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
88	1	2025-09-01	86.308034	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
89	1	2025-09-08	85.618020	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
90	1	2025-09-15	84.280339	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
91	1	2025-09-22	85.605076	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
92	1	2025-09-29	86.211025	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
93	1	2025-10-06	86.287641	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
94	1	2025-10-13	86.135481	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
95	1	2025-10-20	87.506732	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
96	1	2025-10-27	87.221921	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
97	1	2025-11-03	87.417990	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
98	1	2025-11-10	87.505487	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
99	1	2025-11-17	86.808188	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
100	1	2025-11-24	87.372372	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
101	1	2025-12-01	87.632460	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
102	1	2025-12-08	89.075361	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
103	1	2025-12-15	90.445105	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
104	1	2025-12-22	89.068662	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
105	1	2025-12-29	87.777197	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
106	1	2026-01-05	88.921006	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
107	1	2026-01-12	89.579352	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
108	1	2026-01-19	89.948686	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
109	1	2026-01-26	91.511828	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
110	1	2026-02-02	90.333680	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
111	1	2026-02-09	90.358229	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
112	1	2026-02-16	90.957617	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
113	1	2026-02-23	90.658831	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
114	1	2026-03-02	91.393337	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
115	1	2026-03-09	92.760165	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
116	1	2026-03-16	94.130679	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
117	1	2026-03-23	95.247468	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
118	1	2026-03-30	96.613393	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
119	1	2026-04-06	97.643460	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
120	1	2026-04-13	97.752738	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
121	1	2026-04-20	99.032002	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
122	1	2026-04-27	97.616212	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
123	1	2026-05-04	98.614368	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
124	1	2026-05-11	98.718080	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
125	1	2026-05-18	99.891532	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
126	1	2026-05-25	101.158178	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
127	1	2026-06-01	100.262096	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
128	1	2026-06-08	101.516916	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
129	1	2026-06-15	103.217482	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
130	2	2024-01-01	93.706676	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
131	2	2024-01-08	92.461700	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
132	2	2024-01-15	91.313156	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
133	2	2024-01-22	92.016983	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
134	2	2024-01-29	91.396677	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
135	2	2024-02-05	92.286193	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
136	2	2024-02-12	92.206873	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
137	2	2024-02-19	90.756890	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
138	2	2024-02-26	91.226377	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
139	2	2024-03-04	89.821797	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
140	2	2024-03-11	89.089420	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
141	2	2024-03-18	88.986201	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
142	2	2024-03-25	87.581209	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
143	2	2024-04-01	87.904055	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
144	2	2024-04-08	87.824307	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
145	2	2024-04-15	88.466995	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
146	2	2024-04-22	89.016722	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
147	2	2024-04-29	89.561846	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
148	2	2024-05-06	90.727844	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
149	2	2024-05-13	89.291110	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
150	2	2024-05-20	90.877803	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
151	2	2024-05-27	91.903227	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
152	2	2024-06-03	91.654156	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
153	2	2024-06-10	91.914611	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
154	2	2024-06-17	93.099766	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
155	2	2024-06-24	91.843007	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
156	2	2024-07-01	92.194179	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
157	2	2024-07-08	90.904557	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
158	2	2024-07-15	89.575863	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
159	2	2024-07-22	88.695154	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
160	2	2024-07-29	89.380875	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
161	2	2024-08-05	89.514089	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
162	2	2024-08-12	90.465004	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
163	2	2024-08-19	90.996905	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
164	2	2024-08-26	91.286094	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
165	2	2024-09-02	90.775226	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
166	2	2024-09-09	91.489262	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
167	2	2024-09-16	93.103065	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
168	2	2024-09-23	91.958986	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
169	2	2024-09-30	92.730308	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
170	2	2024-10-07	93.140134	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
171	2	2024-10-14	93.576669	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
172	2	2024-10-21	94.649946	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
173	2	2024-10-28	93.484509	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
174	2	2024-11-04	94.025236	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
175	2	2024-11-11	95.132848	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
176	2	2024-11-18	93.677685	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
177	2	2024-11-25	93.210639	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
178	2	2024-12-02	92.811738	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
179	2	2024-12-09	91.444321	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
180	2	2024-12-16	90.231784	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
181	2	2024-12-23	90.148675	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
182	2	2024-12-30	90.894675	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
183	2	2025-01-06	91.852165	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
184	2	2025-01-13	92.484533	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
185	2	2025-01-20	91.303033	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
186	2	2025-01-27	91.796464	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
187	2	2025-02-03	92.740314	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
188	2	2025-02-10	91.844660	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
189	2	2025-02-17	91.730903	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
190	2	2025-02-24	93.050094	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
191	2	2025-03-03	93.199437	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
192	2	2025-03-10	94.649604	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
193	2	2025-03-17	95.318440	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
194	2	2025-03-24	93.804631	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
195	2	2025-03-31	94.569806	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
196	2	2025-04-07	93.820626	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
197	2	2025-04-14	94.567124	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
198	2	2025-04-21	95.885029	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
199	2	2025-04-28	94.730389	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
200	2	2025-05-05	93.423953	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
201	2	2025-05-12	93.324689	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
202	2	2025-05-19	94.714131	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
203	2	2025-05-26	95.542138	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
204	2	2025-06-02	97.245514	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
205	2	2025-06-09	96.370910	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
206	2	2025-06-16	97.614862	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
207	2	2025-06-23	96.205891	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
208	2	2025-06-30	97.806117	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
209	2	2025-07-07	96.577997	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
210	2	2025-07-14	96.604939	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
211	2	2025-07-21	97.885702	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
212	2	2025-07-28	97.764998	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
213	2	2025-08-04	97.409859	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
214	2	2025-08-11	97.928860	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
215	2	2025-08-18	99.632474	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
216	2	2025-08-25	98.148987	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
217	2	2025-09-01	99.190046	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
218	2	2025-09-08	99.547648	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
219	2	2025-09-15	99.411039	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
220	2	2025-09-22	100.505308	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
221	2	2025-09-29	101.155182	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
222	2	2025-10-06	101.400776	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
223	2	2025-10-13	100.975535	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
224	2	2025-10-20	100.626888	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
225	2	2025-10-27	99.867170	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
226	2	2025-11-03	98.573541	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
227	2	2025-11-10	98.453051	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
228	2	2025-11-17	97.361546	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
229	2	2025-11-24	96.574588	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
230	2	2025-12-01	97.391800	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
231	2	2025-12-08	98.744020	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
232	2	2025-12-15	97.798646	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
233	2	2025-12-22	98.320280	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
234	2	2025-12-29	99.725936	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
235	2	2026-01-05	99.361085	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
236	2	2026-01-12	101.056257	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
237	2	2026-01-19	102.353144	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
238	2	2026-01-26	103.964845	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
239	2	2026-02-02	104.429434	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
240	2	2026-02-09	105.957952	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
241	2	2026-02-16	106.446019	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
242	2	2026-02-23	105.502645	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
243	2	2026-03-02	105.274151	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
244	2	2026-03-09	106.669526	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
245	2	2026-03-16	106.529148	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
246	2	2026-03-23	105.965222	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
247	2	2026-03-30	107.426991	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
248	2	2026-04-06	108.204511	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
249	2	2026-04-13	106.865307	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
250	2	2026-04-20	108.078624	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
251	2	2026-04-27	106.651657	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
252	2	2026-05-04	108.337717	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
253	2	2026-05-11	107.958945	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
254	2	2026-05-18	107.633924	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
255	2	2026-05-25	106.034184	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
256	2	2026-06-01	104.531249	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
257	2	2026-06-08	105.109425	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
258	2	2026-06-15	104.665924	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
259	3	2024-01-01	166.041866	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
260	3	2024-01-08	164.057918	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
261	3	2024-01-15	160.832665	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
262	3	2024-01-22	162.838033	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
263	3	2024-01-29	163.367360	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
264	3	2024-02-05	161.566411	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
265	3	2024-02-12	164.720442	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
266	3	2024-02-19	166.730899	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
267	3	2024-02-26	168.909016	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
268	3	2024-03-04	167.209766	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
269	3	2024-03-11	168.854421	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
270	3	2024-03-18	165.575312	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
271	3	2024-03-25	165.425064	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
272	3	2024-04-01	168.910773	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
273	3	2024-04-08	169.981357	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
274	3	2024-04-15	171.898881	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
275	3	2024-04-22	169.594990	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
276	3	2024-04-29	172.259508	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
277	3	2024-05-06	169.533447	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
278	3	2024-05-13	171.239062	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
279	3	2024-05-20	175.486723	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
280	3	2024-05-27	177.766119	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
281	3	2024-06-03	178.298466	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
282	3	2024-06-10	179.078474	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
283	3	2024-06-17	175.854888	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
284	3	2024-06-24	178.485457	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
285	3	2024-07-01	181.921723	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
286	3	2024-07-08	182.297044	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
287	3	2024-07-15	183.359297	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
288	3	2024-07-22	183.389642	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
289	3	2024-07-29	184.355524	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
290	3	2024-08-05	180.207797	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
291	3	2024-08-12	184.430906	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
292	3	2024-08-19	183.048084	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
293	3	2024-08-26	186.452211	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
294	3	2024-09-02	183.958462	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
295	3	2024-09-09	185.079208	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
296	3	2024-09-16	180.896505	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
297	3	2024-09-23	177.946485	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
298	3	2024-09-30	178.488190	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
299	3	2024-10-07	177.441566	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
300	3	2024-10-14	173.523189	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
301	3	2024-10-21	177.760946	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
302	3	2024-10-28	175.019519	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
303	3	2024-11-04	174.829385	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
304	3	2024-11-11	176.014487	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
305	3	2024-11-18	173.876708	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
306	3	2024-11-25	178.420307	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
307	3	2024-12-02	177.623236	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
308	3	2024-12-09	180.426005	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
309	3	2024-12-16	181.740386	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
310	3	2024-12-23	186.314523	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
311	3	2024-12-30	182.548374	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
312	3	2025-01-06	181.857853	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
313	3	2025-01-13	181.051441	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
314	3	2025-01-20	179.779105	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
315	3	2025-01-27	182.199706	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
316	3	2025-02-03	185.175169	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
317	3	2025-02-10	186.181728	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
318	3	2025-02-17	182.854900	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
319	3	2025-02-24	181.013207	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
320	3	2025-03-03	177.109174	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
321	3	2025-03-10	176.110699	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
322	3	2025-03-17	175.673736	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
323	3	2025-03-24	176.335488	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
324	3	2025-03-31	177.421848	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
325	3	2025-04-07	174.137845	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
326	3	2025-04-14	172.804413	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
327	3	2025-04-21	170.999943	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
328	3	2025-04-28	174.767415	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
329	3	2025-05-05	174.057825	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
330	3	2025-05-12	170.288383	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
331	3	2025-05-19	168.599796	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
332	3	2025-05-26	168.180219	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
333	3	2025-06-02	167.527275	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
334	3	2025-06-09	166.580906	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
335	3	2025-06-16	168.531790	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
336	3	2025-06-23	170.544553	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
337	3	2025-06-30	172.650060	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
338	3	2025-07-07	173.295904	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
339	3	2025-07-14	177.027802	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
340	3	2025-07-21	173.186102	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
341	3	2025-07-28	175.008339	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
342	3	2025-08-04	172.896515	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
343	3	2025-08-11	170.501173	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
344	3	2025-08-18	168.380556	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
345	3	2025-08-25	171.793002	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
346	3	2025-09-01	168.230074	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
347	3	2025-09-08	171.609633	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
348	3	2025-09-15	174.232468	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
349	3	2025-09-22	174.228053	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
350	3	2025-09-29	175.971510	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
351	3	2025-10-06	178.522316	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
352	3	2025-10-13	176.552844	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
353	3	2025-10-20	173.683997	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
354	3	2025-10-27	173.025325	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
355	3	2025-11-03	175.585124	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
356	3	2025-11-10	179.371768	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
357	3	2025-11-17	175.932491	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
358	3	2025-11-24	173.668004	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
359	3	2025-12-01	173.027053	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
360	3	2025-12-08	173.262667	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
361	3	2025-12-15	176.060646	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
362	3	2025-12-22	176.708100	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
363	3	2025-12-29	180.233138	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
364	3	2026-01-05	179.670311	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
365	3	2026-01-12	180.350552	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
366	3	2026-01-19	179.749873	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
367	3	2026-01-26	182.854105	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
368	3	2026-02-02	183.326434	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
369	3	2026-02-09	186.121712	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
370	3	2026-02-16	187.482787	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
371	3	2026-02-23	185.278249	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
372	3	2026-03-02	188.224472	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
373	3	2026-03-09	190.110907	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
374	3	2026-03-16	193.085729	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
375	3	2026-03-23	193.109314	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
376	3	2026-03-30	192.272320	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
377	3	2026-04-06	194.444725	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
378	3	2026-04-13	190.935364	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
379	3	2026-04-20	187.832984	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
380	3	2026-04-27	192.324956	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
381	3	2026-05-04	194.045673	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
382	3	2026-05-11	192.557998	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
383	3	2026-05-18	196.808332	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
384	3	2026-05-25	193.871581	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
385	3	2026-06-01	196.638769	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
386	3	2026-06-08	194.697563	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
387	3	2026-06-15	197.160661	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
388	4	2024-01-01	695.821063	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
389	4	2024-01-08	704.924030	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
390	4	2024-01-15	703.758633	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
391	4	2024-01-22	700.914617	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
392	4	2024-01-29	684.520441	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
393	4	2024-02-05	705.253278	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
394	4	2024-02-12	699.052279	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
395	4	2024-02-19	699.062804	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
396	4	2024-02-26	682.546462	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
397	4	2024-03-04	675.222653	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
398	4	2024-03-11	661.376561	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
399	4	2024-03-18	664.572714	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
400	4	2024-03-25	669.671923	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
401	4	2024-04-01	671.356803	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
402	4	2024-04-08	663.916920	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
403	4	2024-04-15	650.451163	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
404	4	2024-04-22	665.224496	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
405	4	2024-04-29	668.551665	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
406	4	2024-05-06	658.362969	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
407	4	2024-05-13	671.272329	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
408	4	2024-05-20	665.872065	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
409	4	2024-05-27	677.354444	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
410	4	2024-06-03	685.224937	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
411	4	2024-06-10	671.014649	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
412	4	2024-06-17	665.567299	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
413	4	2024-06-24	672.541601	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
414	4	2024-07-01	671.197845	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
415	4	2024-07-08	658.636606	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
416	4	2024-07-15	668.500773	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
417	4	2024-07-22	655.233463	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
418	4	2024-07-29	655.573104	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
419	4	2024-08-05	671.655125	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
420	4	2024-08-12	655.982691	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
421	4	2024-08-19	642.253356	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
422	4	2024-08-26	651.004175	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
423	4	2024-09-02	668.375125	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
424	4	2024-09-09	687.851138	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
425	4	2024-09-16	689.899452	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
426	4	2024-09-23	693.382202	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
427	4	2024-09-30	679.175830	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
428	4	2024-10-07	662.601676	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
429	4	2024-10-14	674.016253	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
430	4	2024-10-21	687.629263	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
431	4	2024-10-28	674.332219	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
432	4	2024-11-04	657.950739	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
433	4	2024-11-11	645.408626	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
434	4	2024-11-18	642.538269	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
435	4	2024-11-25	647.656593	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
436	4	2024-12-02	659.545218	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
437	4	2024-12-09	650.877949	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
438	4	2024-12-16	644.050051	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
439	4	2024-12-23	644.085684	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
440	4	2024-12-30	644.678074	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
441	4	2025-01-06	631.229258	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
442	4	2025-01-13	620.716761	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
443	4	2025-01-20	608.408565	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
444	4	2025-01-27	592.582028	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
445	4	2025-02-03	599.521524	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
446	4	2025-02-10	594.671473	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
447	4	2025-02-17	584.408073	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
448	4	2025-02-24	569.807022	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
449	4	2025-03-03	555.224761	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
450	4	2025-03-10	568.937113	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
451	4	2025-03-17	573.670853	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
452	4	2025-03-24	589.796475	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
453	4	2025-03-31	592.984417	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
454	4	2025-04-07	592.253047	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
455	4	2025-04-14	591.878343	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
456	4	2025-04-21	584.800153	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
457	4	2025-04-28	582.006192	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
458	4	2025-05-05	595.623924	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
459	4	2025-05-12	591.651932	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
460	4	2025-05-19	597.853984	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
461	4	2025-05-26	613.384968	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
462	4	2025-06-02	603.782334	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
463	4	2025-06-09	601.257019	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
464	4	2025-06-16	616.842754	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
465	4	2025-06-23	612.433972	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
466	4	2025-06-30	608.116800	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
467	4	2025-07-07	597.908799	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
468	4	2025-07-14	599.895324	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
469	4	2025-07-21	593.989875	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
470	4	2025-07-28	608.942006	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
471	4	2025-08-04	606.435681	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
472	4	2025-08-11	607.590863	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
473	4	2025-08-18	599.308312	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
474	4	2025-08-25	604.260553	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
475	4	2025-09-01	600.173597	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
476	4	2025-09-08	617.479913	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
477	4	2025-09-15	628.894934	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
478	4	2025-09-22	627.755536	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
479	4	2025-09-29	619.271974	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
480	4	2025-10-06	618.900432	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
481	4	2025-10-13	618.551295	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
482	4	2025-10-20	628.395940	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
483	4	2025-10-27	620.737409	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
484	4	2025-11-03	615.066442	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
485	4	2025-11-10	622.359883	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
486	4	2025-11-17	605.955454	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
487	4	2025-11-24	598.714451	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
488	4	2025-12-01	585.759674	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
489	4	2025-12-08	570.141987	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
490	4	2025-12-15	564.035524	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
491	4	2025-12-22	552.229156	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
492	4	2025-12-29	555.206758	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
493	4	2026-01-05	551.716873	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
494	4	2026-01-12	561.648357	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
495	4	2026-01-19	551.311333	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
496	4	2026-01-26	547.968443	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
497	4	2026-02-02	552.699783	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
498	4	2026-02-09	552.674257	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
499	4	2026-02-16	555.144889	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
500	4	2026-02-23	545.874895	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
501	4	2026-03-02	545.532415	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
502	4	2026-03-09	545.550606	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
503	4	2026-03-16	535.607274	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
504	4	2026-03-23	521.003440	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
505	4	2026-03-30	526.526913	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
506	4	2026-04-06	524.417169	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
507	4	2026-04-13	540.243765	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
508	4	2026-04-20	550.106458	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
509	4	2026-04-27	559.397940	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
510	4	2026-05-04	564.677622	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
511	4	2026-05-11	562.264831	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
512	4	2026-05-18	548.352285	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
513	4	2026-05-25	545.501103	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
514	4	2026-06-01	540.872575	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
515	4	2026-06-08	543.944429	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
516	4	2026-06-15	539.003594	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
517	5	2024-01-01	44840.589616	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
518	5	2024-01-08	47224.708241	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
519	5	2024-01-15	48970.318341	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
520	5	2024-01-22	51428.882359	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
521	5	2024-01-29	49450.950601	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
522	5	2024-02-05	49971.913257	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
523	5	2024-02-12	50288.526216	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
524	5	2024-02-19	49031.859072	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
525	5	2024-02-26	48649.851998	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
526	5	2024-03-04	46870.895082	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
527	5	2024-03-11	49159.041122	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
528	5	2024-03-18	48405.512570	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
529	5	2024-03-25	46452.210390	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
530	5	2024-04-01	45590.057203	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
531	5	2024-04-08	44956.596935	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
532	5	2024-04-15	47381.508891	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
533	5	2024-04-22	49230.633140	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
534	5	2024-04-29	48943.433527	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
535	5	2024-05-06	50888.919897	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
536	5	2024-05-13	52590.795652	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
537	5	2024-05-20	52158.298061	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
538	5	2024-05-27	51104.524842	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
539	5	2024-06-03	48888.478981	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
540	5	2024-06-10	49320.894762	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
541	5	2024-06-17	47204.345715	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
542	5	2024-06-24	48318.513626	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
543	5	2024-07-01	49710.423937	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
544	5	2024-07-08	52314.004506	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
545	5	2024-07-15	51854.394310	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
546	5	2024-07-22	52593.719166	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
547	5	2024-07-29	53563.401735	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
548	5	2024-08-05	51518.923363	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
549	5	2024-08-12	51231.021345	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
550	5	2024-08-19	51039.210000	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
551	5	2024-08-26	48941.740201	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
552	5	2024-09-02	48379.316134	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
553	5	2024-09-09	47538.993114	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
554	5	2024-09-16	47864.201671	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
555	5	2024-09-23	50393.468985	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
556	5	2024-09-30	52118.002486	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
557	5	2024-10-07	54562.488884	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
558	5	2024-10-14	54247.464106	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
559	5	2024-10-21	55932.746381	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
560	5	2024-10-28	58021.160708	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
561	5	2024-11-04	58463.627409	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
562	5	2024-11-11	57202.270124	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
563	5	2024-11-18	55359.009966	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
564	5	2024-11-25	53962.621037	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
565	5	2024-12-02	51556.296254	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
566	5	2024-12-09	49913.056582	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
567	5	2024-12-16	50820.416152	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
568	5	2024-12-23	51251.337678	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
569	5	2024-12-30	50634.792558	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
570	5	2025-01-06	51362.198624	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
571	5	2025-01-13	49417.393608	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
572	5	2025-01-20	51281.894560	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
573	5	2025-01-27	50555.065055	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
574	5	2025-02-03	51062.436118	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
575	5	2025-02-10	49344.517822	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
576	5	2025-02-17	47375.339939	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
577	5	2025-02-24	49643.915919	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
578	5	2025-03-03	48654.148323	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
579	5	2025-03-10	47978.477459	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
580	5	2025-03-17	48602.480394	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
581	5	2025-03-24	46424.154087	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
582	5	2025-03-31	47218.629232	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
583	5	2025-04-07	48547.858517	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
584	5	2025-04-14	50102.186097	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
585	5	2025-04-21	48219.379271	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
586	5	2025-04-28	49320.599407	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
587	5	2025-05-05	50430.710504	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
588	5	2025-05-12	50036.943166	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
589	5	2025-05-19	49298.782356	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
590	5	2025-05-26	48118.186418	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
591	5	2025-06-02	47291.889839	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
592	5	2025-06-09	47421.749749	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
593	5	2025-06-16	46500.031791	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
594	5	2025-06-23	45780.686781	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
595	5	2025-06-30	46403.955414	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
596	5	2025-07-07	46160.428436	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
597	5	2025-07-14	47272.395173	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
598	5	2025-07-21	49325.408280	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
599	5	2025-07-28	47465.984183	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
600	5	2025-08-04	47502.558519	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
601	5	2025-08-11	47654.541033	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
602	5	2025-08-18	49073.439314	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
603	5	2025-08-25	48934.576638	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
604	5	2025-09-01	47656.363660	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
605	5	2025-09-08	47831.571157	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
606	5	2025-09-15	47899.328635	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
607	5	2025-09-22	49969.965453	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
608	5	2025-09-29	50043.586794	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
609	5	2025-10-06	48914.642724	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
610	5	2025-10-13	49062.173330	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
611	5	2025-10-20	47323.398974	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
612	5	2025-10-27	46466.082266	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
613	5	2025-11-03	45420.035621	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
614	5	2025-11-10	46148.656924	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
615	5	2025-11-17	46387.423359	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
616	5	2025-11-24	48634.181097	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
617	5	2025-12-01	47430.987140	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
618	5	2025-12-08	45529.526985	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
619	5	2025-12-15	45937.802097	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
620	5	2025-12-22	45138.983742	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
621	5	2025-12-29	43241.384633	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
622	5	2026-01-05	43987.031043	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
623	5	2026-01-12	42109.825037	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
624	5	2026-01-19	42136.987107	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
625	5	2026-01-26	41954.117643	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
626	5	2026-02-02	42101.697079	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
627	5	2026-02-09	44280.611113	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
628	5	2026-02-16	44099.371128	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
629	5	2026-02-23	45609.939104	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
630	5	2026-03-02	45525.338639	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
631	5	2026-03-09	46158.507146	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
632	5	2026-03-16	47270.554919	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
633	5	2026-03-23	47618.935416	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
634	5	2026-03-30	50134.625846	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
635	5	2026-04-06	48006.681343	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
636	5	2026-04-13	49570.320048	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
637	5	2026-04-20	49345.125614	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
638	5	2026-04-27	47839.840905	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
639	5	2026-05-04	47186.084214	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
640	5	2026-05-11	45622.661862	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
641	5	2026-05-18	47487.534819	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
642	5	2026-05-25	48168.008341	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
643	5	2026-06-01	48235.532133	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
644	5	2026-06-08	50082.813319	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
645	5	2026-06-15	47900.195406	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
646	6	2024-01-01	2405.576774	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
647	6	2024-01-08	2446.977189	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
648	6	2024-01-15	2524.747160	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
649	6	2024-01-22	2529.427499	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
650	6	2024-01-29	2420.912090	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
651	6	2024-02-05	2471.012536	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
652	6	2024-02-12	2384.335693	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
653	6	2024-02-19	2448.506814	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
654	6	2024-02-26	2572.194120	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
655	6	2024-03-04	2719.981285	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
656	6	2024-03-11	2685.162189	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
657	6	2024-03-18	2655.357014	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
658	6	2024-03-25	2598.599832	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
659	6	2024-04-01	2692.806295	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
660	6	2024-04-08	2687.783449	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
661	6	2024-04-15	2769.436764	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
662	6	2024-04-22	2859.020920	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
663	6	2024-04-29	2844.007245	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
664	6	2024-05-06	2714.286773	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
665	6	2024-05-13	2780.876289	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
666	6	2024-05-20	2893.132828	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
667	6	2024-05-27	3043.463229	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
668	6	2024-06-03	3053.164184	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
669	6	2024-06-10	2920.035867	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
670	6	2024-06-17	3063.967953	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
671	6	2024-06-24	3230.514855	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
672	6	2024-07-01	3387.654097	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
673	6	2024-07-08	3553.395172	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
674	6	2024-07-15	3478.629064	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
675	6	2024-07-22	3629.057075	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
676	6	2024-07-29	3780.401247	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
677	6	2024-08-05	3642.812138	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
678	6	2024-08-12	3770.056328	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
679	6	2024-08-19	3900.226075	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
680	6	2024-08-26	4033.500890	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
681	6	2024-09-02	4140.022959	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
682	6	2024-09-09	4308.313987	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
683	6	2024-09-16	4109.760452	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
684	6	2024-09-23	3912.848877	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
685	6	2024-09-30	4044.144214	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
686	6	2024-10-07	4040.785014	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
687	6	2024-10-14	3872.928369	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
688	6	2024-10-21	3894.246763	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
689	6	2024-10-28	3722.903387	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
690	6	2024-11-04	3803.357118	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
691	6	2024-11-11	4025.913492	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
692	6	2024-11-18	4139.517226	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
693	6	2024-11-25	4289.067296	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
694	6	2024-12-02	4213.521762	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
695	6	2024-12-09	4073.570394	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
696	6	2024-12-16	4205.673283	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
697	6	2024-12-23	4093.724812	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
698	6	2024-12-30	3969.349416	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
699	6	2025-01-06	4163.554855	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
700	6	2025-01-13	4197.860791	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
701	6	2025-01-20	4430.418240	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
702	6	2025-01-27	4515.402609	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
703	6	2025-02-03	4668.335310	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
704	6	2025-02-10	4788.522750	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
705	6	2025-02-17	4599.675579	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
706	6	2025-02-24	4703.580298	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
707	6	2025-03-03	4987.663556	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
708	6	2025-03-10	4848.680336	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
709	6	2025-03-17	4989.683525	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
710	6	2025-03-24	5061.032175	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
711	6	2025-03-31	5284.247305	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
712	6	2025-04-07	5512.915505	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
713	6	2025-04-14	5641.837314	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
714	6	2025-04-21	5743.572176	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
715	6	2025-04-28	5666.252639	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
716	6	2025-05-05	5886.433000	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
717	6	2025-05-12	6033.498925	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
718	6	2025-05-19	6235.373081	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
719	6	2025-05-26	6202.635563	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
720	6	2025-06-02	6164.510154	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
721	6	2025-06-09	6261.426177	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
722	6	2025-06-16	6130.458152	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
723	6	2025-06-23	6342.264522	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
724	6	2025-06-30	6521.552685	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
725	6	2025-07-07	6614.790197	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
726	6	2025-07-14	6569.956324	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
727	6	2025-07-21	6382.141393	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
728	6	2025-07-28	6104.638761	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
729	6	2025-08-04	5928.104562	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
730	6	2025-08-11	6221.974652	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
731	6	2025-08-18	6496.204226	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
732	6	2025-08-25	6194.151438	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
733	6	2025-09-01	6501.327308	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
734	6	2025-09-08	6413.326401	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
735	6	2025-09-15	6680.885019	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
736	6	2025-09-22	6400.322077	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
737	6	2025-09-29	6231.358172	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
738	6	2025-10-06	6050.561510	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
739	6	2025-10-13	6146.162466	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
740	6	2025-10-20	6429.690686	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
741	6	2025-10-27	6657.634836	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
742	6	2025-11-03	6445.169214	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
743	6	2025-11-10	6754.728175	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
744	6	2025-11-17	6796.426475	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
745	6	2025-11-24	6953.936201	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
746	6	2025-12-01	6949.135515	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
747	6	2025-12-08	7357.764527	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
748	6	2025-12-15	7510.704385	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
749	6	2025-12-22	7665.857594	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
750	6	2025-12-29	7953.664364	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
751	6	2026-01-05	7725.352965	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
752	6	2026-01-12	7667.229004	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
753	6	2026-01-19	7326.949764	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
754	6	2026-01-26	7206.249623	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
755	6	2026-02-02	7611.575378	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
756	6	2026-02-09	7476.229661	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
757	6	2026-02-16	7815.111788	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
758	6	2026-02-23	7442.055301	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
759	6	2026-03-02	7208.126139	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
760	6	2026-03-09	7321.513479	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
761	6	2026-03-16	7468.120784	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
762	6	2026-03-23	7265.469568	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
763	6	2026-03-30	7164.811743	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
764	6	2026-04-06	7113.393959	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
765	6	2026-04-13	6811.611072	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
766	6	2026-04-20	6785.007786	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
767	6	2026-04-27	6993.447585	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
768	6	2026-05-04	6931.121033	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
769	6	2026-05-11	6751.293354	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
770	6	2026-05-18	6546.235675	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
771	6	2026-05-25	6263.158393	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
772	6	2026-06-01	6225.252517	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
773	6	2026-06-08	6114.052626	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
774	6	2026-06-15	6196.398191	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
775	7	2024-01-01	1800.194664	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
776	7	2024-01-08	1776.594179	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
777	7	2024-01-15	1796.636935	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
778	7	2024-01-22	1779.755831	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
779	7	2024-01-29	1796.292654	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
780	7	2024-02-05	1802.351037	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
781	7	2024-02-12	1823.813459	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
782	7	2024-02-19	1810.412981	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
783	7	2024-02-26	1819.244766	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
784	7	2024-03-04	1828.033036	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
785	7	2024-03-11	1826.632287	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
786	7	2024-03-18	1836.976914	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
787	7	2024-03-25	1826.074354	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
788	7	2024-04-01	1845.269688	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
789	7	2024-04-08	1872.860055	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
790	7	2024-04-15	1885.310943	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
791	7	2024-04-22	1879.650357	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
792	7	2024-04-29	1893.036221	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
793	7	2024-05-06	1919.475839	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
794	7	2024-05-13	1949.623089	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
795	7	2024-05-20	1933.685525	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
796	7	2024-05-27	1954.413284	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
797	7	2024-06-03	1937.607543	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
798	7	2024-06-10	1936.816235	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
799	7	2024-06-17	1950.434053	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
800	7	2024-06-24	1925.279952	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
801	7	2024-07-01	1908.897776	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
802	7	2024-07-08	1923.699376	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
803	7	2024-07-15	1911.590968	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
804	7	2024-07-22	1894.352451	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
805	7	2024-07-29	1912.812460	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
806	7	2024-08-05	1930.213536	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
807	7	2024-08-12	1914.532112	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
808	7	2024-08-19	1926.087118	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
809	7	2024-08-26	1903.280420	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
810	7	2024-09-02	1891.718579	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
811	7	2024-09-09	1901.883923	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
812	7	2024-09-16	1915.610664	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
813	7	2024-09-23	1908.115307	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
814	7	2024-09-30	1929.720354	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
815	7	2024-10-07	1909.603670	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
816	7	2024-10-14	1918.599470	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
817	7	2024-10-21	1908.802713	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
818	7	2024-10-28	1914.056411	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
819	7	2024-11-04	1891.884010	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
820	7	2024-11-11	1881.154821	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
821	7	2024-11-18	1907.630826	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
822	7	2024-11-25	1891.897888	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
823	7	2024-12-02	1914.325436	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
824	7	2024-12-09	1937.388834	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
825	7	2024-12-16	1911.683484	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
826	7	2024-12-23	1888.491821	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
827	7	2024-12-30	1878.856487	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
828	7	2025-01-06	1880.056055	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
829	7	2025-01-13	1856.410568	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
830	7	2025-01-20	1850.413067	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
831	7	2025-01-27	1826.494658	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
832	7	2025-02-03	1852.205199	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
833	7	2025-02-10	1873.220527	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
834	7	2025-02-17	1879.902008	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
835	7	2025-02-24	1892.196548	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
836	7	2025-03-03	1896.556229	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
837	7	2025-03-10	1885.403143	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
838	7	2025-03-17	1912.121434	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
839	7	2025-03-24	1936.563054	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
840	7	2025-03-31	1928.558766	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
841	7	2025-04-07	1910.813336	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
842	7	2025-04-14	1930.985869	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
843	7	2025-04-21	1917.299512	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
844	7	2025-04-28	1914.334066	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
845	7	2025-05-05	1921.339703	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
846	7	2025-05-12	1943.147817	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
847	7	2025-05-19	1964.388885	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
848	7	2025-05-26	1996.112257	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
849	7	2025-06-02	1970.489853	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
850	7	2025-06-09	1954.088987	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
851	7	2025-06-16	1975.672970	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
852	7	2025-06-23	1960.966353	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
853	7	2025-06-30	1958.662904	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
854	7	2025-07-07	1957.207971	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
855	7	2025-07-14	1938.248022	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
856	7	2025-07-21	1941.537775	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
857	7	2025-07-28	1922.099357	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
858	7	2025-08-04	1949.486174	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
859	7	2025-08-11	1957.038659	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
860	7	2025-08-18	1941.491997	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
861	7	2025-08-25	1920.821566	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
862	7	2025-09-01	1900.310457	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
863	7	2025-09-08	1914.880949	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
864	7	2025-09-15	1923.171580	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
865	7	2025-09-22	1936.389733	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
866	7	2025-09-29	1926.288347	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
867	7	2025-10-06	1918.863370	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
868	7	2025-10-13	1939.269526	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
869	7	2025-10-20	1930.334039	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
870	7	2025-10-27	1913.046621	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
871	7	2025-11-03	1933.680305	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
872	7	2025-11-10	1945.296009	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
873	7	2025-11-17	1967.987241	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
874	7	2025-11-24	1977.155181	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
875	7	2025-12-01	1970.923897	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
876	7	2025-12-08	1952.769457	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
877	7	2025-12-15	1949.126047	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
878	7	2025-12-22	1948.187429	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
879	7	2025-12-29	1925.885159	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
880	7	2026-01-05	1923.800511	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
881	7	2026-01-12	1902.058110	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
882	7	2026-01-19	1911.072103	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
883	7	2026-01-26	1887.780384	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
884	7	2026-02-02	1912.951148	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
885	7	2026-02-09	1942.346305	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
886	7	2026-02-16	1927.498986	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
887	7	2026-02-23	1940.176880	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
888	7	2026-03-02	1933.629530	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
889	7	2026-03-09	1917.354785	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
890	7	2026-03-16	1935.337529	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
891	7	2026-03-23	1957.016532	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
892	7	2026-03-30	1979.192911	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
893	7	2026-04-06	2004.129115	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
894	7	2026-04-13	2005.853019	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
895	7	2026-04-20	1990.899364	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
896	7	2026-04-27	2016.042669	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
897	7	2026-05-04	2003.191955	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
898	7	2026-05-11	1994.321753	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
899	7	2026-05-18	1969.148558	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
900	7	2026-05-25	1948.421767	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
901	7	2026-06-01	1972.279989	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
902	7	2026-06-08	1949.753941	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
903	7	2026-06-15	1935.652621	manual	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: attachments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.attachments (id, transaction_id, filename, stored_path, mime_type, size_bytes, created_at) FROM stdin;
\.


--
-- Data for Name: belfius_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.belfius_raw_transactions (id, deduplication_hash, created_at, account_number, transaction_date, statement_number, transaction_number, recipient_account, recipient_name, recipient_street, recipient_location, recipient_bic, recipient_country, transaction_description, value_date, amount, currency, balance, additional_message, raw_csv_line) FROM stdin;
\.


--
-- Data for Name: belgian_inflation_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.belgian_inflation_rates (id, month_date, monthly_rate, source, fetched_at, updated_at) FROM stdin;
\.


--
-- Data for Name: bond_investments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bond_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, created_at, updated_at, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, current_price, interest_rate, maturity_date) FROM stdin;
9	Belgische Staatsbon 2027	EUR	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	5000.000000	2.8500	2027-09-04
\.


--
-- Data for Name: bond_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bond_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, created_at, updated_at, fx_rate_to_eur) FROM stdin;
88	9	buy	2024-09-04	5000.0000	0.0000	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N
89	9	interest	2025-09-04	142.5000	0.0000	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N
\.


--
-- Data for Name: cashflow_forecast_accuracy; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cashflow_forecast_accuracy (id, user_id, method_id, as_of_month, mae, rmse, mape, sample_days, recorded_at) FROM stdin;
\.


--
-- Data for Name: cashflow_forecast_mc; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cashflow_forecast_mc (id, user_id, month, filter_hash, mc_paths, payload, computed_at) FROM stdin;
\.


--
-- Data for Name: cashflow_forecast_mc_rolling; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cashflow_forecast_mc_rolling (id, user_id, today_iso, days_back, days_forward, filter_hash, mc_paths, payload, computed_at) FROM stdin;
\.


--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.categories (id, general, detail, description, is_active, created_at, updated_at) FROM stdin;
1	INCOME	SALARY	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
2	INCOME	BONUS	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
3	INCOME	REFUND	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
4	INCOME	INTEREST	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
5	INCOME	GIFT	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
6	HOUSING	RENT	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
7	HOUSING	MORTGAGE	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
8	HOUSING	UTILITIES	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
9	HOUSING	INTERNET	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
10	HOUSING	INSURANCE	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
11	FOOD	GROCERIES	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
12	FOOD	RESTAURANT	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
13	FOOD	TAKEAWAY	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
14	FOOD	COFFEE	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
15	TRANSPORT	FUEL	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
16	TRANSPORT	PUBLIC	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
17	TRANSPORT	CAR	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
18	TRANSPORT	PARKING	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
19	HEALTH	PHARMACY	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
20	HEALTH	DOCTOR	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
21	HEALTH	INSURANCE	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
22	LEISURE	STREAMING	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
23	LEISURE	SPORT	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
24	LEISURE	HOBBIES	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
25	LEISURE	TRAVEL	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
26	SHOPPING	CLOTHING	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
27	SHOPPING	ELECTRONICS	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
28	SHOPPING	HOME	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
29	FINANCE	SAVINGS	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
30	FINANCE	INVESTMENT	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
31	FINANCE	FEES	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
32	FINANCE	TAX	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
33	TELECOM	MOBILE	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
\.


--
-- Data for Name: crypto_investments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.crypto_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, created_at, updated_at, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, symbol, current_price) FROM stdin;
5	Bitcoin	EUR	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	BTC	47900.195406
6	Ethereum	EUR	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	ETH	6196.398191
\.


--
-- Data for Name: crypto_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.crypto_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, created_at, updated_at, fx_rate_to_eur, units, price_per_unit) FROM stdin;
67	5	buy	2024-02-23	2341.7213	2.7809	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.04775918	49031.859072
68	5	buy	2025-09-24	1189.7504	1.4995	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.02380931	49969.965453
69	5	buy	2025-04-26	1174.5298	2.1116	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.02435804	48219.379271
70	5	buy	2024-07-03	1221.5392	1.6882	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.02457310	49710.423937
71	5	buy	2024-10-06	1542.2932	0.4480	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.02959233	52118.002486
72	5	buy	2024-04-10	1543.1920	1.5164	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.03432626	44956.596935
73	6	buy	2024-10-08	1946.8150	0.2374	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.48179129	4040.785014
74	6	buy	2024-03-10	476.4367	0.5296	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.17516177	2719.981285
75	6	buy	2024-07-01	1333.7026	3.5974	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.39369505	3387.654097
76	6	buy	2025-05-05	1406.8734	1.0180	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.23900271	5886.433000
77	6	buy	2024-04-03	387.4512	3.3566	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.14388379	2692.806295
78	6	buy	2024-04-13	913.4769	3.9871	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.33986252	2687.783449
\.


--
-- Data for Name: custom_parser_configs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.custom_parser_configs (id, name, config_json, created_at, updated_at, kind) FROM stdin;
\.


--
-- Data for Name: custom_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.custom_raw_transactions (id, deduplication_hash, created_at, date, description, amount, currency, counterparty_name, counterparty_account, balance, category_name, comments, raw_csv_line, raw_metadata) FROM stdin;
\.


--
-- Data for Name: etf_investments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.etf_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, created_at, updated_at, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, symbol, current_price) FROM stdin;
1	iShares Core MSCI World UCITS ETF	EUR	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	IWDA	103.217482
2	Vanguard FTSE All-World UCITS ETF	EUR	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	VWCE	104.665924
\.


--
-- Data for Name: etf_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.etf_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, created_at, updated_at, fx_rate_to_eur, units, price_per_unit) FROM stdin;
1	1	buy	2024-02-21	261.0695	2.2188	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.61486406	72.221122
2	1	buy	2024-03-21	225.7627	3.4028	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.12444694	72.256851
3	1	buy	2024-04-21	277.6747	2.6899	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.82777018	72.542167
4	1	buy	2024-05-21	318.7201	0.7461	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	4.38225466	72.729713
5	1	buy	2024-06-21	343.3248	3.1871	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	4.56466199	75.213624
6	1	buy	2024-07-21	314.6438	3.2414	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	4.02221948	78.226405
7	1	buy	2024-08-21	359.2894	1.5825	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	4.72079392	76.107844
8	1	buy	2024-09-21	320.5974	3.7885	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	4.14485996	77.348197
9	1	buy	2024-10-21	448.5209	0.2349	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.74425728	78.081614
10	1	buy	2024-11-21	447.6781	0.4510	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.79191390	77.293640
11	1	buy	2024-12-21	244.0170	0.9612	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.07556266	79.340618
12	1	buy	2025-01-21	282.8764	3.6691	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.55340572	79.607130
13	1	buy	2025-02-21	411.3757	1.3087	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.04819223	81.489697
14	1	buy	2025-03-21	410.5421	0.8796	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.09887113	80.516277
15	1	buy	2025-04-21	403.5832	0.3092	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.05531704	79.833404
16	1	buy	2025-05-21	482.2925	2.0581	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.88799365	81.911172
17	1	buy	2025-06-21	258.4057	2.7309	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.09509004	83.488898
18	1	buy	2025-07-21	462.9197	0.6224	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.43385547	85.191753
19	1	buy	2025-08-21	400.0573	1.0811	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	4.58645705	87.225788
20	1	buy	2025-09-21	439.3896	2.4448	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.21342903	84.280339
21	1	buy	2025-10-21	424.2276	3.9616	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	4.84794252	87.506732
22	1	buy	2025-11-21	272.1603	2.4721	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.13519171	86.808188
23	1	buy	2025-12-21	434.9044	3.5589	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	4.80848980	90.445105
24	1	buy	2026-01-21	498.5860	0.9972	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.54300437	89.948686
25	1	buy	2026-02-21	512.2409	1.8090	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.63164409	90.957617
26	1	buy	2026-03-21	348.5493	0.3383	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.70282327	94.130679
27	1	buy	2026-04-21	548.0189	2.1251	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	5.53375602	99.032002
28	1	buy	2026-05-21	462.6836	0.6670	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	4.63185994	99.891532
29	2	buy	2024-02-21	189.2794	3.0228	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.08556504	90.756890
30	2	buy	2024-03-21	133.7496	0.5108	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	1.50303737	88.986201
31	2	buy	2024-04-21	152.7112	1.3716	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	1.72619451	88.466995
32	2	buy	2024-05-21	269.4967	0.6526	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.96548457	90.877803
33	2	buy	2024-06-21	197.9676	2.0017	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.12640287	93.099766
34	2	buy	2024-07-21	226.1739	3.1646	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.52494206	89.575863
35	2	buy	2024-08-21	194.9656	2.6359	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.14255170	90.996905
36	2	buy	2024-09-21	190.8253	0.0179	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.04961332	93.103065
37	2	buy	2024-10-21	269.9139	1.0943	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.85170729	94.649946
38	2	buy	2024-11-21	282.2563	2.2516	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.01305782	93.677685
39	2	buy	2024-12-21	243.6466	1.5972	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.70023026	90.231784
40	2	buy	2025-01-21	305.6803	2.9362	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.34797582	91.303033
41	2	buy	2025-02-21	279.1772	0.1458	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.04343696	91.730903
42	2	buy	2025-03-21	248.1175	3.4046	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.60303818	95.318440
43	2	buy	2025-04-21	332.1970	2.3383	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.46453432	95.885029
44	2	buy	2025-05-21	302.4090	0.4159	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.19286015	94.714131
45	2	buy	2025-06-21	323.7398	2.1490	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.31650141	97.614862
46	2	buy	2025-07-21	326.4569	1.6652	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.33508252	97.885702
47	2	buy	2025-08-21	314.2232	1.6980	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.15382350	99.632474
48	2	buy	2025-09-21	183.6960	3.5020	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	1.84784327	99.411039
49	2	buy	2025-10-21	346.9767	2.0125	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.44815099	100.626888
50	2	buy	2025-11-21	332.4540	0.4878	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.41463316	97.361546
51	2	buy	2025-12-21	201.8143	0.7605	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.06356914	97.798646
52	2	buy	2026-01-21	153.6165	0.5489	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	1.50084780	102.353144
53	2	buy	2026-02-21	180.5448	0.4972	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	1.69611583	106.446019
54	2	buy	2026-03-21	295.2366	3.9363	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.77141577	106.529148
55	2	buy	2026-04-21	320.0850	1.5405	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.96159366	108.078624
56	2	buy	2026-05-21	199.4311	1.2735	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	1.85286487	107.633924
84	1	dividend	2025-06-20	68.0000	0.0000	20.4000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	\N	\N
\.


--
-- Data for Name: exchange_rate_cache; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.exchange_rate_cache (id, from_ccy, to_ccy, rate_date, rate, fetched_at) FROM stdin;
1	USD	EUR	2024-01-01	0.9118610352	2026-06-18 08:45:15.510273+00
2	EUR	USD	2024-01-01	1.0966583300	2026-06-18 08:45:15.510273+00
3	USD	EUR	2024-01-08	0.9031582054	2026-06-18 08:45:15.510273+00
4	EUR	USD	2024-01-08	1.1072257263	2026-06-18 08:45:15.510273+00
5	USD	EUR	2024-01-15	0.8967868894	2026-06-18 08:45:15.510273+00
6	EUR	USD	2024-01-15	1.1150921270	2026-06-18 08:45:15.510273+00
7	USD	EUR	2024-01-22	0.8893809931	2026-06-18 08:45:15.510273+00
8	EUR	USD	2024-01-22	1.1243775253	2026-06-18 08:45:15.510273+00
9	USD	EUR	2024-01-29	0.8940772059	2026-06-18 08:45:15.510273+00
10	EUR	USD	2024-01-29	1.1184716414	2026-06-18 08:45:15.510273+00
11	USD	EUR	2024-02-05	0.8888122327	2026-06-18 08:45:15.510273+00
12	EUR	USD	2024-02-05	1.1250970263	2026-06-18 08:45:15.510273+00
13	USD	EUR	2024-02-12	0.8937491141	2026-06-18 08:45:15.510273+00
14	EUR	USD	2024-02-12	1.1188822279	2026-06-18 08:45:15.510273+00
15	USD	EUR	2024-02-19	0.8976912368	2026-06-18 08:45:15.510273+00
16	EUR	USD	2024-02-19	1.1139687668	2026-06-18 08:45:15.510273+00
17	USD	EUR	2024-02-26	0.8910760817	2026-06-18 08:45:15.510273+00
18	EUR	USD	2024-02-26	1.1222386287	2026-06-18 08:45:15.510273+00
19	USD	EUR	2024-03-04	0.8886438569	2026-06-18 08:45:15.510273+00
20	EUR	USD	2024-03-04	1.1253102041	2026-06-18 08:45:15.510273+00
21	USD	EUR	2024-03-11	0.8884082906	2026-06-18 08:45:15.510273+00
22	EUR	USD	2024-03-11	1.1256085863	2026-06-18 08:45:15.510273+00
23	USD	EUR	2024-03-18	0.8854392794	2026-06-18 08:45:15.510273+00
24	EUR	USD	2024-03-18	1.1293829213	2026-06-18 08:45:15.510273+00
25	USD	EUR	2024-03-25	0.8783362213	2026-06-18 08:45:15.510273+00
26	EUR	USD	2024-03-25	1.1385161807	2026-06-18 08:45:15.510273+00
27	USD	EUR	2024-04-01	0.8771657625	2026-06-18 08:45:15.510273+00
28	EUR	USD	2024-04-01	1.1400353761	2026-06-18 08:45:15.510273+00
29	USD	EUR	2024-04-08	0.8749523555	2026-06-18 08:45:15.510273+00
30	EUR	USD	2024-04-08	1.1429193757	2026-06-18 08:45:15.510273+00
31	USD	EUR	2024-04-15	0.8694378768	2026-06-18 08:45:15.510273+00
32	EUR	USD	2024-04-15	1.1501684326	2026-06-18 08:45:15.510273+00
33	USD	EUR	2024-04-22	0.8734079044	2026-06-18 08:45:15.510273+00
34	EUR	USD	2024-04-22	1.1449404052	2026-06-18 08:45:15.510273+00
35	USD	EUR	2024-04-29	0.8817148202	2026-06-18 08:45:15.510273+00
36	EUR	USD	2024-04-29	1.1341535575	2026-06-18 08:45:15.510273+00
37	USD	EUR	2024-05-06	0.8819068056	2026-06-18 08:45:15.510273+00
38	EUR	USD	2024-05-06	1.1339066595	2026-06-18 08:45:15.510273+00
39	USD	EUR	2024-05-13	0.8756607776	2026-06-18 08:45:15.510273+00
40	EUR	USD	2024-05-13	1.1419947377	2026-06-18 08:45:15.510273+00
41	USD	EUR	2024-05-20	0.8717756947	2026-06-18 08:45:15.510273+00
42	EUR	USD	2024-05-20	1.1470840562	2026-06-18 08:45:15.510273+00
43	USD	EUR	2024-05-27	0.8693017212	2026-06-18 08:45:15.510273+00
44	EUR	USD	2024-05-27	1.1503485793	2026-06-18 08:45:15.510273+00
45	USD	EUR	2024-06-03	0.8718296775	2026-06-18 08:45:15.510273+00
46	EUR	USD	2024-06-03	1.1470130300	2026-06-18 08:45:15.510273+00
47	USD	EUR	2024-06-10	0.8734675170	2026-06-18 08:45:15.510273+00
48	EUR	USD	2024-06-10	1.1448622651	2026-06-18 08:45:15.510273+00
49	USD	EUR	2024-06-17	0.8676354663	2026-06-18 08:45:15.510273+00
50	EUR	USD	2024-06-17	1.1525577720	2026-06-18 08:45:15.510273+00
51	USD	EUR	2024-06-24	0.8751303179	2026-06-18 08:45:15.510273+00
52	EUR	USD	2024-06-24	1.1426869571	2026-06-18 08:45:15.510273+00
53	USD	EUR	2024-07-01	0.8811893995	2026-06-18 08:45:15.510273+00
54	EUR	USD	2024-07-01	1.1348298113	2026-06-18 08:45:15.510273+00
55	USD	EUR	2024-07-08	0.8852291997	2026-06-18 08:45:15.510273+00
56	EUR	USD	2024-07-08	1.1296509427	2026-06-18 08:45:15.510273+00
57	USD	EUR	2024-07-15	0.8779941916	2026-06-18 08:45:15.510273+00
58	EUR	USD	2024-07-15	1.1389596988	2026-06-18 08:45:15.510273+00
59	USD	EUR	2024-07-22	0.8800441354	2026-06-18 08:45:15.510273+00
60	EUR	USD	2024-07-22	1.1363066462	2026-06-18 08:45:15.510273+00
61	USD	EUR	2024-07-29	0.8771805102	2026-06-18 08:45:15.510273+00
62	EUR	USD	2024-07-29	1.1400162092	2026-06-18 08:45:15.510273+00
63	USD	EUR	2024-08-05	0.8689820327	2026-06-18 08:45:15.510273+00
64	EUR	USD	2024-08-05	1.1507717794	2026-06-18 08:45:15.510273+00
65	USD	EUR	2024-08-12	0.8692599120	2026-06-18 08:45:15.510273+00
66	EUR	USD	2024-08-12	1.1504039082	2026-06-18 08:45:15.510273+00
67	USD	EUR	2024-08-19	0.8757967872	2026-06-18 08:45:15.510273+00
68	EUR	USD	2024-08-19	1.1418173880	2026-06-18 08:45:15.510273+00
69	USD	EUR	2024-08-26	0.8681544449	2026-06-18 08:45:15.510273+00
70	EUR	USD	2024-08-26	1.1518687786	2026-06-18 08:45:15.510273+00
71	USD	EUR	2024-09-02	0.8647367633	2026-06-18 08:45:15.510273+00
72	EUR	USD	2024-09-02	1.1564212861	2026-06-18 08:45:15.510273+00
73	USD	EUR	2024-09-09	0.8578257193	2026-06-18 08:45:15.510273+00
74	EUR	USD	2024-09-09	1.1657379553	2026-06-18 08:45:15.510273+00
75	USD	EUR	2024-09-16	0.8659393323	2026-06-18 08:45:15.510273+00
76	EUR	USD	2024-09-16	1.1548153117	2026-06-18 08:45:15.510273+00
77	USD	EUR	2024-09-23	0.8642551065	2026-06-18 08:45:15.510273+00
78	EUR	USD	2024-09-23	1.1570657697	2026-06-18 08:45:15.510273+00
79	USD	EUR	2024-09-30	0.8723543156	2026-06-18 08:45:15.510273+00
80	EUR	USD	2024-09-30	1.1463232108	2026-06-18 08:45:15.510273+00
81	USD	EUR	2024-10-07	0.8720641317	2026-06-18 08:45:15.510273+00
82	EUR	USD	2024-10-07	1.1467046559	2026-06-18 08:45:15.510273+00
83	USD	EUR	2024-10-14	0.8677464004	2026-06-18 08:45:15.510273+00
84	EUR	USD	2024-10-14	1.1524104272	2026-06-18 08:45:15.510273+00
85	USD	EUR	2024-10-21	0.8700826048	2026-06-18 08:45:15.510273+00
86	EUR	USD	2024-10-21	1.1493161620	2026-06-18 08:45:15.510273+00
87	USD	EUR	2024-10-28	0.8650776471	2026-06-18 08:45:15.510273+00
88	EUR	USD	2024-10-28	1.1559655984	2026-06-18 08:45:15.510273+00
89	USD	EUR	2024-11-04	0.8588172155	2026-06-18 08:45:15.510273+00
90	EUR	USD	2024-11-04	1.1643921220	2026-06-18 08:45:15.510273+00
91	USD	EUR	2024-11-11	0.8513259185	2026-06-18 08:45:15.510273+00
92	EUR	USD	2024-11-11	1.1746382652	2026-06-18 08:45:15.510273+00
93	USD	EUR	2024-11-18	0.8512806229	2026-06-18 08:45:15.510273+00
94	EUR	USD	2024-11-18	1.1747007662	2026-06-18 08:45:15.510273+00
95	USD	EUR	2024-11-25	0.8536267857	2026-06-18 08:45:15.510273+00
96	EUR	USD	2024-11-25	1.1714721430	2026-06-18 08:45:15.510273+00
97	USD	EUR	2024-12-02	0.8512816361	2026-06-18 08:45:15.510273+00
98	EUR	USD	2024-12-02	1.1746993681	2026-06-18 08:45:15.510273+00
99	USD	EUR	2024-12-09	0.8555438768	2026-06-18 08:45:15.510273+00
100	EUR	USD	2024-12-09	1.1688471242	2026-06-18 08:45:15.510273+00
101	USD	EUR	2024-12-16	0.8626684729	2026-06-18 08:45:15.510273+00
102	EUR	USD	2024-12-16	1.1591938634	2026-06-18 08:45:15.510273+00
103	USD	EUR	2024-12-23	0.8661706118	2026-06-18 08:45:15.510273+00
104	EUR	USD	2024-12-23	1.1545069602	2026-06-18 08:45:15.510273+00
105	USD	EUR	2024-12-30	0.8591213802	2026-06-18 08:45:15.510273+00
106	EUR	USD	2024-12-30	1.1639798789	2026-06-18 08:45:15.510273+00
107	USD	EUR	2025-01-06	0.8571425084	2026-06-18 08:45:15.510273+00
108	EUR	USD	2025-01-06	1.1666671414	2026-06-18 08:45:15.510273+00
109	USD	EUR	2025-01-13	0.8646804102	2026-06-18 08:45:15.510273+00
110	EUR	USD	2025-01-13	1.1564966527	2026-06-18 08:45:15.510273+00
111	USD	EUR	2025-01-20	0.8634152984	2026-06-18 08:45:15.510273+00
112	EUR	USD	2025-01-20	1.1581911993	2026-06-18 08:45:15.510273+00
113	USD	EUR	2025-01-27	0.8551473767	2026-06-18 08:45:15.510273+00
114	EUR	USD	2025-01-27	1.1693890752	2026-06-18 08:45:15.510273+00
115	USD	EUR	2025-02-03	0.8586484826	2026-06-18 08:45:15.510273+00
116	EUR	USD	2025-02-03	1.1646209366	2026-06-18 08:45:15.510273+00
117	USD	EUR	2025-02-10	0.8584299189	2026-06-18 08:45:15.510273+00
118	EUR	USD	2025-02-10	1.1649174592	2026-06-18 08:45:15.510273+00
119	USD	EUR	2025-02-17	0.8640882652	2026-06-18 08:45:15.510273+00
120	EUR	USD	2025-02-17	1.1572891802	2026-06-18 08:45:15.510273+00
121	USD	EUR	2025-02-24	0.8676927382	2026-06-18 08:45:15.510273+00
122	EUR	USD	2025-02-24	1.1524816977	2026-06-18 08:45:15.510273+00
123	USD	EUR	2025-03-03	0.8739873508	2026-06-18 08:45:15.510273+00
124	EUR	USD	2025-03-03	1.1441813192	2026-06-18 08:45:15.510273+00
125	USD	EUR	2025-03-10	0.8824480340	2026-06-18 08:45:15.510273+00
126	EUR	USD	2025-03-10	1.1332112051	2026-06-18 08:45:15.510273+00
127	USD	EUR	2025-03-17	0.8855612702	2026-06-18 08:45:15.510273+00
128	EUR	USD	2025-03-17	1.1292273427	2026-06-18 08:45:15.510273+00
129	USD	EUR	2025-03-24	0.8884428241	2026-06-18 08:45:15.510273+00
130	EUR	USD	2025-03-24	1.1255648342	2026-06-18 08:45:15.510273+00
131	USD	EUR	2025-03-31	0.8892710358	2026-06-18 08:45:15.510273+00
132	EUR	USD	2025-03-31	1.1245165531	2026-06-18 08:45:15.510273+00
133	USD	EUR	2025-04-07	0.8885734840	2026-06-18 08:45:15.510273+00
134	EUR	USD	2025-04-07	1.1253993260	2026-06-18 08:45:15.510273+00
135	USD	EUR	2025-04-14	0.8973660914	2026-06-18 08:45:15.510273+00
136	EUR	USD	2025-04-14	1.1143723945	2026-06-18 08:45:15.510273+00
137	USD	EUR	2025-04-21	0.8941870921	2026-06-18 08:45:15.510273+00
138	EUR	USD	2025-04-21	1.1183341930	2026-06-18 08:45:15.510273+00
139	USD	EUR	2025-04-28	0.8926408211	2026-06-18 08:45:15.510273+00
140	EUR	USD	2025-04-28	1.1202714198	2026-06-18 08:45:15.510273+00
141	USD	EUR	2025-05-05	0.9013213673	2026-06-18 08:45:15.510273+00
142	EUR	USD	2025-05-05	1.1094821850	2026-06-18 08:45:15.510273+00
143	USD	EUR	2025-05-12	0.8924943819	2026-06-18 08:45:15.510273+00
144	EUR	USD	2025-05-12	1.1204552324	2026-06-18 08:45:15.510273+00
145	USD	EUR	2025-05-19	0.8925512156	2026-06-18 08:45:15.510273+00
146	EUR	USD	2025-05-19	1.1203838866	2026-06-18 08:45:15.510273+00
147	USD	EUR	2025-05-26	0.8881311534	2026-06-18 08:45:15.510273+00
148	EUR	USD	2025-05-26	1.1259598272	2026-06-18 08:45:15.510273+00
149	USD	EUR	2025-06-02	0.8938167398	2026-06-18 08:45:15.510273+00
150	EUR	USD	2025-06-02	1.1187975739	2026-06-18 08:45:15.510273+00
151	USD	EUR	2025-06-09	0.8918278513	2026-06-18 08:45:15.510273+00
152	EUR	USD	2025-06-09	1.1212926335	2026-06-18 08:45:15.510273+00
153	USD	EUR	2025-06-16	0.8830864498	2026-06-18 08:45:15.510273+00
154	EUR	USD	2025-06-16	1.1323919648	2026-06-18 08:45:15.510273+00
155	USD	EUR	2025-06-23	0.8759192511	2026-06-18 08:45:15.510273+00
156	EUR	USD	2025-06-23	1.1416577485	2026-06-18 08:45:15.510273+00
157	USD	EUR	2025-06-30	0.8784091631	2026-06-18 08:45:15.510273+00
158	EUR	USD	2025-06-30	1.1384216399	2026-06-18 08:45:15.510273+00
159	USD	EUR	2025-07-07	0.8746657579	2026-06-18 08:45:15.510273+00
160	EUR	USD	2025-07-07	1.1432938707	2026-06-18 08:45:15.510273+00
161	USD	EUR	2025-07-14	0.8763052227	2026-06-18 08:45:15.510273+00
162	EUR	USD	2025-07-14	1.1411549013	2026-06-18 08:45:15.510273+00
163	USD	EUR	2025-07-21	0.8744933422	2026-06-18 08:45:15.510273+00
164	EUR	USD	2025-07-21	1.1435192834	2026-06-18 08:45:15.510273+00
165	USD	EUR	2025-07-28	0.8685279295	2026-06-18 08:45:15.510273+00
166	EUR	USD	2025-07-28	1.1513734516	2026-06-18 08:45:15.510273+00
167	USD	EUR	2025-08-04	0.8685218517	2026-06-18 08:45:15.510273+00
168	EUR	USD	2025-08-04	1.1513815088	2026-06-18 08:45:15.510273+00
169	USD	EUR	2025-08-11	0.8651527800	2026-06-18 08:45:15.510273+00
170	EUR	USD	2025-08-11	1.1558652103	2026-06-18 08:45:15.510273+00
171	USD	EUR	2025-08-18	0.8572946764	2026-06-18 08:45:15.510273+00
172	EUR	USD	2025-08-18	1.1664600604	2026-06-18 08:45:15.510273+00
173	USD	EUR	2025-08-25	0.8633259641	2026-06-18 08:45:15.510273+00
174	EUR	USD	2025-08-25	1.1583110454	2026-06-18 08:45:15.510273+00
175	USD	EUR	2025-09-01	0.8640566592	2026-06-18 08:45:15.510273+00
176	EUR	USD	2025-09-01	1.1573315121	2026-06-18 08:45:15.510273+00
177	USD	EUR	2025-09-08	0.8724369324	2026-06-18 08:45:15.510273+00
178	EUR	USD	2025-09-08	1.1462146578	2026-06-18 08:45:15.510273+00
179	USD	EUR	2025-09-15	0.8649910668	2026-06-18 08:45:15.510273+00
180	EUR	USD	2025-09-15	1.1560813035	2026-06-18 08:45:15.510273+00
181	USD	EUR	2025-09-22	0.8613783036	2026-06-18 08:45:15.510273+00
182	EUR	USD	2025-09-22	1.1609300998	2026-06-18 08:45:15.510273+00
183	USD	EUR	2025-09-29	0.8604117685	2026-06-18 08:45:15.510273+00
184	EUR	USD	2025-09-29	1.1622342192	2026-06-18 08:45:15.510273+00
185	USD	EUR	2025-10-06	0.8576441756	2026-06-18 08:45:15.510273+00
186	EUR	USD	2025-10-06	1.1659847153	2026-06-18 08:45:15.510273+00
187	USD	EUR	2025-10-13	0.8590913015	2026-06-18 08:45:15.510273+00
188	EUR	USD	2025-10-13	1.1640206323	2026-06-18 08:45:15.510273+00
189	USD	EUR	2025-10-20	0.8632390043	2026-06-18 08:45:15.510273+00
190	EUR	USD	2025-10-20	1.1584277297	2026-06-18 08:45:15.510273+00
191	USD	EUR	2025-10-27	0.8700032264	2026-06-18 08:45:15.510273+00
192	EUR	USD	2025-10-27	1.1494210248	2026-06-18 08:45:15.510273+00
193	USD	EUR	2025-11-03	0.8714159139	2026-06-18 08:45:15.510273+00
194	EUR	USD	2025-11-03	1.1475576519	2026-06-18 08:45:15.510273+00
195	USD	EUR	2025-11-10	0.8672895216	2026-06-18 08:45:15.510273+00
196	EUR	USD	2025-11-10	1.1530175046	2026-06-18 08:45:15.510273+00
197	USD	EUR	2025-11-17	0.8597488995	2026-06-18 08:45:15.510273+00
198	EUR	USD	2025-11-17	1.1631303053	2026-06-18 08:45:15.510273+00
199	USD	EUR	2025-11-24	0.8600511057	2026-06-18 08:45:15.510273+00
200	EUR	USD	2025-11-24	1.1627216027	2026-06-18 08:45:15.510273+00
201	USD	EUR	2025-12-01	0.8684742176	2026-06-18 08:45:15.510273+00
202	EUR	USD	2025-12-01	1.1514446598	2026-06-18 08:45:15.510273+00
203	USD	EUR	2025-12-08	0.8643719294	2026-06-18 08:45:15.510273+00
204	EUR	USD	2025-12-08	1.1569093882	2026-06-18 08:45:15.510273+00
205	USD	EUR	2025-12-15	0.8698448335	2026-06-18 08:45:15.510273+00
206	EUR	USD	2025-12-15	1.1496303266	2026-06-18 08:45:15.510273+00
207	USD	EUR	2025-12-22	0.8699531866	2026-06-18 08:45:15.510273+00
208	EUR	USD	2025-12-22	1.1494871395	2026-06-18 08:45:15.510273+00
209	USD	EUR	2025-12-29	0.8629792305	2026-06-18 08:45:15.510273+00
210	EUR	USD	2025-12-29	1.1587764393	2026-06-18 08:45:15.510273+00
211	USD	EUR	2026-01-05	0.8566174247	2026-06-18 08:45:15.510273+00
212	EUR	USD	2026-01-05	1.1673822773	2026-06-18 08:45:15.510273+00
213	USD	EUR	2026-01-12	0.8524281070	2026-06-18 08:45:15.510273+00
214	EUR	USD	2026-01-12	1.1731194593	2026-06-18 08:45:15.510273+00
215	USD	EUR	2026-01-19	0.8497147094	2026-06-18 08:45:15.510273+00
216	EUR	USD	2026-01-19	1.1768655867	2026-06-18 08:45:15.510273+00
217	USD	EUR	2026-01-26	0.8428594244	2026-06-18 08:45:15.510273+00
218	EUR	USD	2026-01-26	1.1864374664	2026-06-18 08:45:15.510273+00
219	USD	EUR	2026-02-02	0.8400000000	2026-06-18 08:45:15.510273+00
220	EUR	USD	2026-02-02	1.1904761905	2026-06-18 08:45:15.510273+00
221	USD	EUR	2026-02-09	0.8472823755	2026-06-18 08:45:15.510273+00
222	EUR	USD	2026-02-09	1.1802440709	2026-06-18 08:45:15.510273+00
223	USD	EUR	2026-02-16	0.8447455796	2026-06-18 08:45:15.510273+00
224	EUR	USD	2026-02-16	1.1837883786	2026-06-18 08:45:15.510273+00
225	USD	EUR	2026-02-23	0.8457657775	2026-06-18 08:45:15.510273+00
226	EUR	USD	2026-02-23	1.1823604438	2026-06-18 08:45:15.510273+00
227	USD	EUR	2026-03-02	0.8533011620	2026-06-18 08:45:15.510273+00
228	EUR	USD	2026-03-02	1.1719191823	2026-06-18 08:45:15.510273+00
229	USD	EUR	2026-03-09	0.8495349254	2026-06-18 08:45:15.510273+00
230	EUR	USD	2026-03-09	1.1771146424	2026-06-18 08:45:15.510273+00
231	USD	EUR	2026-03-16	0.8523118891	2026-06-18 08:45:15.510273+00
232	EUR	USD	2026-03-16	1.1732794213	2026-06-18 08:45:15.510273+00
233	USD	EUR	2026-03-23	0.8607038416	2026-06-18 08:45:15.510273+00
234	EUR	USD	2026-03-23	1.1618398242	2026-06-18 08:45:15.510273+00
235	USD	EUR	2026-03-30	0.8653152676	2026-06-18 08:45:15.510273+00
236	EUR	USD	2026-03-30	1.1556481636	2026-06-18 08:45:15.510273+00
237	USD	EUR	2026-04-06	0.8704484157	2026-06-18 08:45:15.510273+00
238	EUR	USD	2026-04-06	1.1488331554	2026-06-18 08:45:15.510273+00
239	USD	EUR	2026-04-13	0.8673166150	2026-06-18 08:45:15.510273+00
240	EUR	USD	2026-04-13	1.1529814865	2026-06-18 08:45:15.510273+00
241	USD	EUR	2026-04-20	0.8744641827	2026-06-18 08:45:15.510273+00
242	EUR	USD	2026-04-20	1.1435574147	2026-06-18 08:45:15.510273+00
243	USD	EUR	2026-04-27	0.8787145828	2026-06-18 08:45:15.510273+00
244	EUR	USD	2026-04-27	1.1380259524	2026-06-18 08:45:15.510273+00
245	USD	EUR	2026-05-04	0.8867327161	2026-06-18 08:45:15.510273+00
246	EUR	USD	2026-05-04	1.1277355418	2026-06-18 08:45:15.510273+00
247	USD	EUR	2026-05-11	0.8917498199	2026-06-18 08:45:15.510273+00
248	EUR	USD	2026-05-11	1.1213907507	2026-06-18 08:45:15.510273+00
249	USD	EUR	2026-05-18	0.8905752880	2026-06-18 08:45:15.510273+00
250	EUR	USD	2026-05-18	1.1228696928	2026-06-18 08:45:15.510273+00
251	USD	EUR	2026-05-25	0.8991855351	2026-06-18 08:45:15.510273+00
252	EUR	USD	2026-05-25	1.1121175341	2026-06-18 08:45:15.510273+00
253	USD	EUR	2026-06-01	0.8907634303	2026-06-18 08:45:15.510273+00
254	EUR	USD	2026-06-01	1.1226325261	2026-06-18 08:45:15.510273+00
255	USD	EUR	2026-06-08	0.8828150755	2026-06-18 08:45:15.510273+00
256	EUR	USD	2026-06-08	1.1327400581	2026-06-18 08:45:15.510273+00
257	USD	EUR	2026-06-15	0.8889830928	2026-06-18 08:45:15.510273+00
258	EUR	USD	2026-06-15	1.1248807858	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: exchange_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.exchange_rates (id, currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) FROM stdin;
1	USD	0.8889830928	2026-06-18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
\.


--
-- Data for Name: import_batches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.import_batches (id, adapter_name, source_filename, source_size_bytes, custom_config, status, rows_total, rows_imported, rows_duplicate, rows_error, error_summary, started_at, completed_at) FROM stdin;
\.


--
-- Data for Name: import_staging_rows; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.import_staging_rows (id, batch_id, row_index, status, tx_date, bank_account, recipient_raw, memo, amount, currency, balance, recipient_account, recipient_address, recipient_bank_name, comment, raw_data, tx_hash, resolved_recipient_id, resolved_bank_account_id, error_message, created_at, match_source, matched_pattern_id, match_similarity, user_override_recipient_id, override_category_id) FROM stdin;
\.


--
-- Data for Name: instrument_provider_map; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.instrument_provider_map (id, instrument_key, key_type, provider, provider_symbol, resolved_name, exchange, currency, status, verified_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: investments_base; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.investments_base (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, created_at, updated_at, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path) FROM stdin;
\.


--
-- Data for Name: kbc_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.kbc_raw_transactions (id, deduplication_hash, created_at, account_number, category_name, account_holder_name, currency, statement_number, transaction_date, value_date, description, amount, balance, credit_amount, debit_amount, counterparty_account, counterparty_bic, counterparty_name, counterparty_address, structured_communication, free_communication, raw_csv_line) FROM stdin;
\.


--
-- Data for Name: manual_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.manual_raw_transactions (id, deduplication_hash, created_at, transaction_id, date, bank_account, recipient_id, amount, memo, currency, category_id, comment) FROM stdin;
\.


--
-- Data for Name: metals_investments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.metals_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, created_at, updated_at, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, symbol, current_price) FROM stdin;
7	Physical Gold (XAU)	EUR	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	XAU	1935.652621
\.


--
-- Data for Name: metals_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.metals_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, created_at, updated_at, fx_rate_to_eur, units, price_per_unit) FROM stdin;
79	7	buy	2025-06-19	5307.3420	3.5108	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	2.68634643	1975.672970
80	7	buy	2024-05-01	6950.3817	0.4923	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	3.67155241	1893.036221
81	7	buy	2025-04-18	2555.7042	3.2552	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	1.32352299	1930.985869
\.


--
-- Data for Name: planned_transaction_executions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.planned_transaction_executions (id, planned_transaction_id, executed_transaction_id, execution_date, created_at) FROM stdin;
\.


--
-- Data for Name: planned_transaction_loan_schedule; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.planned_transaction_loan_schedule (id, planned_transaction_id, installment_number, due_date, payment_amount, principal_amount, interest_amount, remaining_principal, created_at, updated_at) FROM stdin;
1	8	1	2018-06-01	932.48	565.81	366.67	219434.19	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
2	8	2	2018-07-01	932.48	566.76	365.72	218867.43	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
3	8	3	2018-08-01	932.48	567.70	364.78	218299.73	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
4	8	4	2018-09-01	932.48	568.65	363.83	217731.08	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
5	8	5	2018-10-01	932.48	569.59	362.89	217161.49	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
6	8	6	2018-11-01	932.48	570.54	361.94	216590.95	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
7	8	7	2018-12-01	932.48	571.49	360.98	216019.45	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
8	8	8	2019-01-01	932.48	572.45	360.03	215447.00	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
9	8	9	2019-02-01	932.48	573.40	359.08	214873.60	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
10	8	10	2019-03-01	932.48	574.36	358.12	214299.25	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
11	8	11	2019-04-01	932.48	575.31	357.17	213723.93	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
12	8	12	2019-05-01	932.48	576.27	356.21	213147.66	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
13	8	13	2019-06-01	932.48	577.23	355.25	212570.43	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
14	8	14	2019-07-01	932.48	578.20	354.28	211992.23	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
15	8	15	2019-08-01	932.48	579.16	353.32	211413.07	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
16	8	16	2019-09-01	932.48	580.12	352.36	210832.95	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
17	8	17	2019-10-01	932.48	581.09	351.39	210251.86	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
18	8	18	2019-11-01	932.48	582.06	350.42	209669.80	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
19	8	19	2019-12-01	932.48	583.03	349.45	209086.77	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
20	8	20	2020-01-01	932.48	584.00	348.48	208502.76	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
21	8	21	2020-02-01	932.48	584.97	347.50	207917.79	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
22	8	22	2020-03-01	932.48	585.95	346.53	207331.84	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
23	8	23	2020-04-01	932.48	586.93	345.55	206744.91	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
24	8	24	2020-05-01	932.48	587.90	344.57	206157.01	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
25	8	25	2020-06-01	932.48	588.88	343.60	205568.12	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
26	8	26	2020-07-01	932.48	589.87	342.61	204978.26	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
27	8	27	2020-08-01	932.48	590.85	341.63	204387.41	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
28	8	28	2020-09-01	932.48	591.83	340.65	203795.57	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
29	8	29	2020-10-01	932.48	592.82	339.66	203202.75	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
30	8	30	2020-11-01	932.48	593.81	338.67	202608.95	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
31	8	31	2020-12-01	932.48	594.80	337.68	202014.15	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
32	8	32	2021-01-01	932.48	595.79	336.69	201418.36	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
33	8	33	2021-02-01	932.48	596.78	335.70	200821.58	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
34	8	34	2021-03-01	932.48	597.78	334.70	200223.80	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
35	8	35	2021-04-01	932.48	598.77	333.71	199625.03	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
36	8	36	2021-05-01	932.48	599.77	332.71	199025.25	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
37	8	37	2021-06-01	932.48	600.77	331.71	198424.48	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
38	8	38	2021-07-01	932.48	601.77	330.71	197822.71	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
39	8	39	2021-08-01	932.48	602.78	329.70	197219.94	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
40	8	40	2021-09-01	932.48	603.78	328.70	196616.16	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
41	8	41	2021-10-01	932.48	604.79	327.69	196011.37	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
42	8	42	2021-11-01	932.48	605.79	326.69	195405.58	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
43	8	43	2021-12-01	932.48	606.80	325.68	194798.77	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
44	8	44	2022-01-01	932.48	607.81	324.66	194190.96	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
45	8	45	2022-02-01	932.48	608.83	323.65	193582.13	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
46	8	46	2022-03-01	932.48	609.84	322.64	192972.29	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
47	8	47	2022-04-01	932.48	610.86	321.62	192361.43	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
48	8	48	2022-05-01	932.48	611.88	320.60	191749.55	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
49	8	49	2022-06-01	932.48	612.90	319.58	191136.66	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
50	8	50	2022-07-01	932.48	613.92	318.56	190522.74	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
51	8	51	2022-08-01	932.48	614.94	317.54	189907.80	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
52	8	52	2022-09-01	932.48	615.97	316.51	189291.83	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
53	8	53	2022-10-01	932.48	616.99	315.49	188674.84	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
54	8	54	2022-11-01	932.48	618.02	314.46	188056.81	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
55	8	55	2022-12-01	932.48	619.05	313.43	187437.76	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
56	8	56	2023-01-01	932.48	620.08	312.40	186817.68	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
57	8	57	2023-02-01	932.48	621.12	311.36	186196.56	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
58	8	58	2023-03-01	932.48	622.15	310.33	185574.41	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
59	8	59	2023-04-01	932.48	623.19	309.29	184951.22	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
60	8	60	2023-05-01	932.48	624.23	308.25	184326.99	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
61	8	61	2023-06-01	932.48	625.27	307.21	183701.73	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
62	8	62	2023-07-01	932.48	626.31	306.17	183075.42	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
63	8	63	2023-08-01	932.48	627.35	305.13	182448.06	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
64	8	64	2023-09-01	932.48	628.40	304.08	181819.66	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
65	8	65	2023-10-01	932.48	629.45	303.03	181190.22	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
66	8	66	2023-11-01	932.48	630.50	301.98	180559.72	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
67	8	67	2023-12-01	932.48	631.55	300.93	179928.17	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
68	8	68	2024-01-01	932.48	632.60	299.88	179295.57	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
69	8	69	2024-02-01	932.48	633.65	298.83	178661.92	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
70	8	70	2024-03-01	932.48	634.71	297.77	178027.21	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
71	8	71	2024-04-01	932.48	635.77	296.71	177391.44	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
72	8	72	2024-05-01	932.48	636.83	295.65	176754.62	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
73	8	73	2024-06-01	932.48	637.89	294.59	176116.73	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
74	8	74	2024-07-01	932.48	638.95	293.53	175477.78	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
75	8	75	2024-08-01	932.48	640.02	292.46	174837.76	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
76	8	76	2024-09-01	932.48	641.08	291.40	174196.68	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
77	8	77	2024-10-01	932.48	642.15	290.33	173554.52	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
78	8	78	2024-11-01	932.48	643.22	289.26	172911.30	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
79	8	79	2024-12-01	932.48	644.29	288.19	172267.01	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
80	8	80	2025-01-01	932.48	645.37	287.11	171621.64	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
81	8	81	2025-02-01	932.48	646.44	286.04	170975.20	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
82	8	82	2025-03-01	932.48	647.52	284.96	170327.68	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
83	8	83	2025-04-01	932.48	648.60	283.88	169679.08	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
84	8	84	2025-05-01	932.48	649.68	282.80	169029.40	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
85	8	85	2025-06-01	932.48	650.76	281.72	168378.63	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
86	8	86	2025-07-01	932.48	651.85	280.63	167726.78	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
87	8	87	2025-08-01	932.48	652.93	279.54	167073.85	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
88	8	88	2025-09-01	932.48	654.02	278.46	166419.82	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
89	8	89	2025-10-01	932.48	655.11	277.37	165764.71	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
90	8	90	2025-11-01	932.48	656.21	276.27	165108.51	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
91	8	91	2025-12-01	932.48	657.30	275.18	164451.21	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
92	8	92	2026-01-01	932.48	658.39	274.09	163792.81	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
93	8	93	2026-02-01	932.48	659.49	272.99	163133.32	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
94	8	94	2026-03-01	932.48	660.59	271.89	162472.73	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
95	8	95	2026-04-01	932.48	661.69	270.79	161811.04	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
96	8	96	2026-05-01	932.48	662.79	269.69	161148.25	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
97	8	97	2026-06-01	932.48	663.90	268.58	160484.35	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
98	8	98	2026-07-01	932.48	665.01	267.47	159819.34	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
99	8	99	2026-08-01	932.48	666.11	266.37	159153.23	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
100	8	100	2026-09-01	932.48	667.22	265.26	158486.00	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
101	8	101	2026-10-01	932.48	668.34	264.14	157817.67	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
102	8	102	2026-11-01	932.48	669.45	263.03	157148.22	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
103	8	103	2026-12-01	932.48	670.57	261.91	156477.65	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
104	8	104	2027-01-01	932.48	671.68	260.80	155805.97	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
105	8	105	2027-02-01	932.48	672.80	259.68	155133.16	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
106	8	106	2027-03-01	932.48	673.92	258.56	154459.24	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
107	8	107	2027-04-01	932.48	675.05	257.43	153784.19	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
108	8	108	2027-05-01	932.48	676.17	256.31	153108.02	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
109	8	109	2027-06-01	932.48	677.30	255.18	152430.72	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
110	8	110	2027-07-01	932.48	678.43	254.05	151752.29	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
111	8	111	2027-08-01	932.48	679.56	252.92	151072.73	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
112	8	112	2027-09-01	932.48	680.69	251.79	150392.04	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
113	8	113	2027-10-01	932.48	681.83	250.65	149710.21	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
114	8	114	2027-11-01	932.48	682.96	249.52	149027.25	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
115	8	115	2027-12-01	932.48	684.10	248.38	148343.15	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
116	8	116	2028-01-01	932.48	685.24	247.24	147657.91	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
117	8	117	2028-02-01	932.48	686.38	246.10	146971.53	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
118	8	118	2028-03-01	932.48	687.53	244.95	146284.00	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
119	8	119	2028-04-01	932.48	688.67	243.81	145595.33	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
120	8	120	2028-05-01	932.48	689.82	242.66	144905.51	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
121	8	121	2028-06-01	932.48	690.97	241.51	144214.54	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
122	8	122	2028-07-01	932.48	692.12	240.36	143522.41	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
123	8	123	2028-08-01	932.48	693.28	239.20	142829.14	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
124	8	124	2028-09-01	932.48	694.43	238.05	142134.71	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
125	8	125	2028-10-01	932.48	695.59	236.89	141439.12	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
126	8	126	2028-11-01	932.48	696.75	235.73	140742.37	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
127	8	127	2028-12-01	932.48	697.91	234.57	140044.46	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
128	8	128	2029-01-01	932.48	699.07	233.41	139345.39	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
129	8	129	2029-02-01	932.48	700.24	232.24	138645.15	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
130	8	130	2029-03-01	932.48	701.40	231.08	137943.75	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
131	8	131	2029-04-01	932.48	702.57	229.91	137241.18	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
132	8	132	2029-05-01	932.48	703.74	228.74	136537.43	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
133	8	133	2029-06-01	932.48	704.92	227.56	135832.51	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
134	8	134	2029-07-01	932.48	706.09	226.39	135126.42	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
135	8	135	2029-08-01	932.48	707.27	225.21	134419.15	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
136	8	136	2029-09-01	932.48	708.45	224.03	133710.71	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
137	8	137	2029-10-01	932.48	709.63	222.85	133001.08	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
138	8	138	2029-11-01	932.48	710.81	221.67	132290.27	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
139	8	139	2029-12-01	932.48	712.00	220.48	131578.27	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
140	8	140	2030-01-01	932.48	713.18	219.30	130865.09	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
141	8	141	2030-02-01	932.48	714.37	218.11	130150.72	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
142	8	142	2030-03-01	932.48	715.56	216.92	129435.16	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
143	8	143	2030-04-01	932.48	716.75	215.73	128718.40	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
144	8	144	2030-05-01	932.48	717.95	214.53	128000.45	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
145	8	145	2030-06-01	932.48	719.15	213.33	127281.31	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
146	8	146	2030-07-01	932.48	720.34	212.14	126560.96	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
147	8	147	2030-08-01	932.48	721.54	210.93	125839.42	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
148	8	148	2030-09-01	932.48	722.75	209.73	125116.67	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
149	8	149	2030-10-01	932.48	723.95	208.53	124392.72	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
150	8	150	2030-11-01	932.48	725.16	207.32	123667.56	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
151	8	151	2030-12-01	932.48	726.37	206.11	122941.19	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
152	8	152	2031-01-01	932.48	727.58	204.90	122213.62	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
153	8	153	2031-02-01	932.48	728.79	203.69	121484.83	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
154	8	154	2031-03-01	932.48	730.00	202.47	120754.82	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
155	8	155	2031-04-01	932.48	731.22	201.26	120023.60	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
156	8	156	2031-05-01	932.48	732.44	200.04	119291.16	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
157	8	157	2031-06-01	932.48	733.66	198.82	118557.50	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
158	8	158	2031-07-01	932.48	734.88	197.60	117822.62	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
159	8	159	2031-08-01	932.48	736.11	196.37	117086.51	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
160	8	160	2031-09-01	932.48	737.34	195.14	116349.17	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
161	8	161	2031-10-01	932.48	738.56	193.92	115610.61	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
162	8	162	2031-11-01	932.48	739.80	192.68	114870.81	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
163	8	163	2031-12-01	932.48	741.03	191.45	114129.78	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
164	8	164	2032-01-01	932.48	742.26	190.22	113387.52	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
165	8	165	2032-02-01	932.48	743.50	188.98	112644.02	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
166	8	166	2032-03-01	932.48	744.74	187.74	111899.28	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
167	8	167	2032-04-01	932.48	745.98	186.50	111153.30	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
168	8	168	2032-05-01	932.48	747.22	185.26	110406.08	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
169	8	169	2032-06-01	932.48	748.47	184.01	109657.61	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
170	8	170	2032-07-01	932.48	749.72	182.76	108907.89	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
171	8	171	2032-08-01	932.48	750.97	181.51	108156.92	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
172	8	172	2032-09-01	932.48	752.22	180.26	107404.71	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
173	8	173	2032-10-01	932.48	753.47	179.01	106651.23	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
174	8	174	2032-11-01	932.48	754.73	177.75	105896.51	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
175	8	175	2032-12-01	932.48	755.99	176.49	105140.52	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
176	8	176	2033-01-01	932.48	757.25	175.23	104383.28	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
177	8	177	2033-02-01	932.48	758.51	173.97	103624.77	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
178	8	178	2033-03-01	932.48	759.77	172.71	102865.00	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
179	8	179	2033-04-01	932.48	761.04	171.44	102103.96	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
180	8	180	2033-05-01	932.48	762.31	170.17	101341.65	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
181	8	181	2033-06-01	932.48	763.58	168.90	100578.08	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
182	8	182	2033-07-01	932.48	764.85	167.63	99813.23	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
183	8	183	2033-08-01	932.48	766.12	166.36	99047.10	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
184	8	184	2033-09-01	932.48	767.40	165.08	98279.70	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
185	8	185	2033-10-01	932.48	768.68	163.80	97511.02	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
186	8	186	2033-11-01	932.48	769.96	162.52	96741.06	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
187	8	187	2033-12-01	932.48	771.24	161.24	95969.82	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
188	8	188	2034-01-01	932.48	772.53	159.95	95197.29	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
189	8	189	2034-02-01	932.48	773.82	158.66	94423.47	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
190	8	190	2034-03-01	932.48	775.11	157.37	93648.36	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
191	8	191	2034-04-01	932.48	776.40	156.08	92871.96	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
192	8	192	2034-05-01	932.48	777.69	154.79	92094.27	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
193	8	193	2034-06-01	932.48	778.99	153.49	91315.28	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
194	8	194	2034-07-01	932.48	780.29	152.19	90534.99	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
195	8	195	2034-08-01	932.48	781.59	150.89	89753.40	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
196	8	196	2034-09-01	932.48	782.89	149.59	88970.51	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
197	8	197	2034-10-01	932.48	784.20	148.28	88186.32	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
198	8	198	2034-11-01	932.48	785.50	146.98	87400.82	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
199	8	199	2034-12-01	932.48	786.81	145.67	86614.00	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
200	8	200	2035-01-01	932.48	788.12	144.36	85825.88	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
201	8	201	2035-02-01	932.48	789.44	143.04	85036.45	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
202	8	202	2035-03-01	932.48	790.75	141.73	84245.69	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
203	8	203	2035-04-01	932.48	792.07	140.41	83453.62	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
204	8	204	2035-05-01	932.48	793.39	139.09	82660.23	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
205	8	205	2035-06-01	932.48	794.71	137.77	81865.52	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
206	8	206	2035-07-01	932.48	796.04	136.44	81069.48	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
207	8	207	2035-08-01	932.48	797.36	135.12	80272.12	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
208	8	208	2035-09-01	932.48	798.69	133.79	79473.43	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
209	8	209	2035-10-01	932.48	800.02	132.46	78673.40	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
210	8	210	2035-11-01	932.48	801.36	131.12	77872.05	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
211	8	211	2035-12-01	932.48	802.69	129.79	77069.35	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
212	8	212	2036-01-01	932.48	804.03	128.45	76265.32	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
213	8	213	2036-02-01	932.48	805.37	127.11	75459.95	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
214	8	214	2036-03-01	932.48	806.71	125.77	74653.24	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
215	8	215	2036-04-01	932.48	808.06	124.42	73845.18	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
216	8	216	2036-05-01	932.48	809.40	123.08	73035.78	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
217	8	217	2036-06-01	932.48	810.75	121.73	72225.02	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
218	8	218	2036-07-01	932.48	812.10	120.38	71412.92	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
219	8	219	2036-08-01	932.48	813.46	119.02	70599.46	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
220	8	220	2036-09-01	932.48	814.81	117.67	69784.65	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
221	8	221	2036-10-01	932.48	816.17	116.31	68968.48	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
222	8	222	2036-11-01	932.48	817.53	114.95	68150.94	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
223	8	223	2036-12-01	932.48	818.89	113.58	67332.05	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
224	8	224	2037-01-01	932.48	820.26	112.22	66511.79	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
225	8	225	2037-02-01	932.48	821.63	110.85	65690.16	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
226	8	226	2037-03-01	932.48	823.00	109.48	64867.17	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
227	8	227	2037-04-01	932.48	824.37	108.11	64042.80	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
228	8	228	2037-05-01	932.48	825.74	106.74	63217.06	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
229	8	229	2037-06-01	932.48	827.12	105.36	62389.94	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
230	8	230	2037-07-01	932.48	828.50	103.98	61561.44	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
231	8	231	2037-08-01	932.48	829.88	102.60	60731.57	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
232	8	232	2037-09-01	932.48	831.26	101.22	59900.31	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
233	8	233	2037-10-01	932.48	832.65	99.83	59067.66	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
234	8	234	2037-11-01	932.48	834.03	98.45	58233.63	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
235	8	235	2037-12-01	932.48	835.42	97.06	57398.20	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
236	8	236	2038-01-01	932.48	836.82	95.66	56561.39	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
237	8	237	2038-02-01	932.48	838.21	94.27	55723.18	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
238	8	238	2038-03-01	932.48	839.61	92.87	54883.57	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
239	8	239	2038-04-01	932.48	841.01	91.47	54042.56	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
240	8	240	2038-05-01	932.48	842.41	90.07	53200.15	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
241	8	241	2038-06-01	932.48	843.81	88.67	52356.34	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
242	8	242	2038-07-01	932.48	845.22	87.26	51511.12	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
243	8	243	2038-08-01	932.48	846.63	85.85	50664.50	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
244	8	244	2038-09-01	932.48	848.04	84.44	49816.46	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
245	8	245	2038-10-01	932.48	849.45	83.03	48967.00	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
246	8	246	2038-11-01	932.48	850.87	81.61	48116.14	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
247	8	247	2038-12-01	932.48	852.29	80.19	47263.85	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
248	8	248	2039-01-01	932.48	853.71	78.77	46410.14	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
249	8	249	2039-02-01	932.48	855.13	77.35	45555.01	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
250	8	250	2039-03-01	932.48	856.55	75.93	44698.46	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
251	8	251	2039-04-01	932.48	857.98	74.50	43840.48	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
252	8	252	2039-05-01	932.48	859.41	73.07	42981.07	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
253	8	253	2039-06-01	932.48	860.84	71.64	42120.22	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
254	8	254	2039-07-01	932.48	862.28	70.20	41257.94	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
255	8	255	2039-08-01	932.48	863.72	68.76	40394.23	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
256	8	256	2039-09-01	932.48	865.16	67.32	39529.07	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
257	8	257	2039-10-01	932.48	866.60	65.88	38662.47	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
258	8	258	2039-11-01	932.48	868.04	64.44	37794.43	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
259	8	259	2039-12-01	932.48	869.49	62.99	36924.94	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
260	8	260	2040-01-01	932.48	870.94	61.54	36054.00	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
261	8	261	2040-02-01	932.48	872.39	60.09	35181.61	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
262	8	262	2040-03-01	932.48	873.84	58.64	34307.77	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
263	8	263	2040-04-01	932.48	875.30	57.18	33432.47	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
264	8	264	2040-05-01	932.48	876.76	55.72	32555.71	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
265	8	265	2040-06-01	932.48	878.22	54.26	31677.49	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
266	8	266	2040-07-01	932.48	879.68	52.80	30797.81	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
267	8	267	2040-08-01	932.48	881.15	51.33	29916.66	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
268	8	268	2040-09-01	932.48	882.62	49.86	29034.04	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
269	8	269	2040-10-01	932.48	884.09	48.39	28149.95	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
270	8	270	2040-11-01	932.48	885.56	46.92	27264.39	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
271	8	271	2040-12-01	932.48	887.04	45.44	26377.35	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
272	8	272	2041-01-01	932.48	888.52	43.96	25488.83	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
273	8	273	2041-02-01	932.48	890.00	42.48	24598.83	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
274	8	274	2041-03-01	932.48	891.48	41.00	23707.35	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
275	8	275	2041-04-01	932.48	892.97	39.51	22814.38	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
276	8	276	2041-05-01	932.48	894.46	38.02	21919.93	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
277	8	277	2041-06-01	932.48	895.95	36.53	21023.98	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
278	8	278	2041-07-01	932.48	897.44	35.04	20126.54	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
279	8	279	2041-08-01	932.48	898.94	33.54	19227.61	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
280	8	280	2041-09-01	932.48	900.43	32.05	18327.17	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
281	8	281	2041-10-01	932.48	901.93	30.55	17425.24	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
282	8	282	2041-11-01	932.48	903.44	29.04	16521.80	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
283	8	283	2041-12-01	932.48	904.94	27.54	15616.86	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
284	8	284	2042-01-01	932.48	906.45	26.03	14710.41	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
285	8	285	2042-02-01	932.48	907.96	24.52	13802.45	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
286	8	286	2042-03-01	932.48	909.48	23.00	12892.97	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
287	8	287	2042-04-01	932.48	910.99	21.49	11981.98	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
288	8	288	2042-05-01	932.48	912.51	19.97	11069.47	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
289	8	289	2042-06-01	932.48	914.03	18.45	10155.44	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
290	8	290	2042-07-01	932.48	915.55	16.93	9239.88	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
291	8	291	2042-08-01	932.48	917.08	15.40	8322.81	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
292	8	292	2042-09-01	932.48	918.61	13.87	7404.20	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
293	8	293	2042-10-01	932.48	920.14	12.34	6484.06	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
294	8	294	2042-11-01	932.48	921.67	10.81	5562.38	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
295	8	295	2042-12-01	932.48	923.21	9.27	4639.18	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
296	8	296	2043-01-01	932.48	924.75	7.73	3714.43	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
297	8	297	2043-02-01	932.48	926.29	6.19	2788.14	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
298	8	298	2043-03-01	932.48	927.83	4.65	1860.31	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
299	8	299	2043-04-01	932.48	929.38	3.10	930.93	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
300	8	300	2043-05-01	932.48	930.93	1.55	0.00	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: planned_transaction_tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.planned_transaction_tags (planned_transaction_id, tag_id, created_at) FROM stdin;
\.


--
-- Data for Name: planned_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.planned_transactions (id, planned_date, amount, currency, memo, comment, bank_account, recipient_id, category_id, is_recurring, recurrence_pattern, is_executed, last_executed_date, is_active, created_at, updated_at, url, is_loan, loan_type, loan_principal, loan_annual_interest_rate, loan_term_months, loan_start_date, loan_payment_day, loan_regular_payment_amount, loan_first_payment_date, reminder_days_before) FROM stdin;
1	2026-06-25	3502.00	EUR	Loon (gepland)	\N	\N	1	1	t	monthly	f	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	f	\N	\N	\N	\N	\N	\N	\N	\N	\N
2	2026-07-05	1442.00	EUR	Loon partner (gepland)	\N	\N	2	1	t	monthly	f	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	f	\N	\N	\N	\N	\N	\N	\N	\N	\N
3	2026-06-18	-13.99	EUR	Netflix (gepland)	\N	\N	8	22	t	monthly	f	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	f	\N	\N	\N	\N	\N	\N	\N	\N	\N
4	2026-07-02	-29.99	EUR	Fitness (gepland)	\N	\N	11	23	t	monthly	f	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	f	\N	\N	\N	\N	\N	\N	\N	\N	\N
5	2026-06-20	-500.00	EUR	Maandelijkse belegging	\N	\N	16	30	t	monthly	f	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	f	\N	\N	\N	\N	\N	\N	\N	\N	\N
6	2026-08-14	-612.40	EUR	Autoverzekering jaarpremie	\N	\N	12	10	f	\N	f	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	f	\N	\N	\N	\N	\N	\N	\N	\N	7
7	2026-10-15	-1180.00	EUR	Personenbelasting (verwacht)	\N	\N	18	32	f	\N	f	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	f	\N	\N	\N	\N	\N	\N	\N	\N	14
8	2026-07-01	-932.48	EUR	Hypotheek woning Gent	\N	\N	53	7	t	monthly	f	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	t	annuity	220000.00	2.0000	300	2018-05-01	3	932.48	2018-05-01	\N
\.


--
-- Data for Name: portfolio_import_batches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.portfolio_import_batches (id, adapter_name, source_filename, source_size_bytes, custom_config, default_asset_class, default_type, status, rows_total, rows_imported, rows_duplicate, rows_error, error_summary, started_at, completed_at) FROM stdin;
\.


--
-- Data for Name: portfolio_import_staging_rows; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.portfolio_import_staging_rows (id, batch_id, row_index, status, tx_date, type_raw, type, symbol_raw, name_raw, units, price_per_unit, amount, fees, taxes, currency, fx_rate_to_eur, note, raw_data, tx_hash, resolved_investment_id, user_override_investment_id, match_source, match_similarity, committed_txn_id, error_message, created_at) FROM stdin;
\.


--
-- Data for Name: portfolio_performance_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.portfolio_performance_snapshots (id, snapshot_date, invested, value, stocks_etfs_value, crypto_value, metals_value, cash_value, gain_loss, return_pct, inflation_adjusted_value, cumulative_inflation, real_return_pct, currency, computed_at, stocks_etfs_invested, crypto_invested, metals_invested, value_fx_neutral) FROM stdin;
\.


--
-- Data for Name: portfolio_transactions_base; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.portfolio_transactions_base (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, created_at, updated_at, fx_rate_to_eur) FROM stdin;
\.


--
-- Data for Name: provider_api_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.provider_api_keys (provider, api_key, updated_at) FROM stdin;
\.


--
-- Data for Name: provider_health; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.provider_health (provider, kind, last_success_at, last_error_at, last_error, consecutive_failures, updated_at) FROM stdin;
\.


--
-- Data for Name: provider_quota; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.provider_quota (provider, window_date, count, updated_at) FROM stdin;
\.


--
-- Data for Name: real_estate_investments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.real_estate_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, created_at, updated_at, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, current_price, location, municipality, cadastral_income, municipality_tax_rate) FROM stdin;
10	Appartement Gent	EUR	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	325000.000000	Korenmarkt, Gent	Gent	1450.00	7.5000
\.


--
-- Data for Name: real_estate_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.real_estate_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, created_at, updated_at, fx_rate_to_eur) FROM stdin;
90	10	buy	2018-05-01	298000.0000	0.0000	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N
91	10	appreciation	2025-12-31	27000.0000	0.0000	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N
\.


--
-- Data for Name: recipient_bank_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recipient_bank_accounts (id, recipient_id, account_number, bank_name, account_label, address, is_primary, is_active, created_at, updated_at) FROM stdin;
1	2	BE68 5390 0754 7034	KBC	\N	\N	t	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
2	1	BE71 0961 2345 6769	BNP Paribas Fortis	\N	\N	t	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
3	53	BE62 5100 0754 7061	KBC	\N	\N	t	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273
\.


--
-- Data for Name: recipient_match_patterns; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recipient_match_patterns (id, recipient_id, pattern, pattern_kind, case_sensitive, priority, is_active, source, notes, created_at, updated_at) FROM stdin;
1	21	COLRUYT	literal_prefix	f	10	t	user	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
2	1	SALARIS TECH SOLUTIONS	literal_prefix	f	10	t	user	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: recipients; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recipients (id, name, normalized_name, default_category_id, notes, is_active, created_at, updated_at, primary_recipient_id) FROM stdin;
1	Tech Solutions BVBA	TECH SOLUTIONS BVBA	1	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
2	Creatief Bureau BVBA	CREATIEF BUREAU BVBA	1	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
3	Freelance Klant Vander	FREELANCE KLANT VANDER	2	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
4	Engie Electrabel	ENGIE ELECTRABEL	8	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
5	Farys	FARYS	8	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
6	Telenet	TELENET	9	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
7	Proximus	PROXIMUS	33	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
8	Netflix	NETFLIX	22	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
9	Spotify	SPOTIFY	22	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
10	Disney Plus	DISNEY PLUS	22	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
11	Basic-Fit	BASIC FIT	23	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
12	AG Insurance	AG INSURANCE	10	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
13	DKV Belgium	DKV BELGIUM	21	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
14	De Lijn	DE LIJN	16	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
15	NMBS	NMBS	16	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
16	DEGIRO	DEGIRO	30	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
17	KBC Bank	KBC BANK	4	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
18	FOD Financien	FOD FINANCIEN	32	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
19	Eigen Spaarrekening	EIGEN SPAARREKENING	29	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
20	Onbekende Begunstigde	ONBEKENDE BEGUNSTIGDE	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
21	Colruyt	COLRUYT	11	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
22	Delhaize	DELHAIZE	11	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
23	Carrefour	CARREFOUR	11	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
24	Albert Heijn	ALBERT HEIJN	11	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
25	Aldi	ALDI	11	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
26	Lidl	LIDL	11	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
27	Q8	Q8	15	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
28	Total	TOTAL	15	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
29	Shell	SHELL	15	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
30	Restaurant De Vis	RESTAURANT DE VIS	12	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
31	Pizza Napoli	PIZZA NAPOLI	12	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
32	Brasserie Central	BRASSERIE CENTRAL	12	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
33	Starbucks	STARBUCKS	14	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
34	Bar Mocca	BAR MOCCA	14	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
35	Bolt Food	BOLT FOOD	13	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
36	Deliveroo	DELIVEROO	13	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
37	Apotheek Centrum	APOTHEEK CENTRUM	19	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
38	Dr. Janssens	DR JANSSENS	20	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
39	Parking Gent	PARKING GENT	18	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
40	Bol.com	BOL COM	27	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
41	Coolblue	COOLBLUE	27	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
42	MediaMarkt	MEDIAMARKT	27	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
43	Zalando	ZALANDO	26	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
44	H&M	H M	26	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
45	IKEA	IKEA	28	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
46	Booking.com	BOOKING COM	25	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
47	Brussels Airlines	BRUSSELS AIRLINES	25	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
48	Decathlon	DECATHLON	24	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
49	Standaard Boekhandel	STANDAARD BOEKHANDEL	24	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
50	Thomas Peeters	THOMAS PEETERS	12	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
51	Sarah Maes	SARAH MAES	12	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
52	Lukas De Smet	LUKAS DE SMET	25	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
53	KBC Woonkrediet	KBC WOONKREDIET	7	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N
\.


--
-- Data for Name: revolut_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.revolut_raw_transactions (id, deduplication_hash, created_at, transaction_type, product, started_date, completed_date, description, amount, fee, currency, state, balance, raw_csv_line) FROM stdin;
\.


--
-- Data for Name: sabb_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sabb_raw_transactions (id, deduplication_hash, created_at, transaction_date, posting_date, description, amount, currency, status, amount_other_currency, raw_csv_line) FROM stdin;
\.


--
-- Data for Name: saved_charts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.saved_charts (id, name, chart_type, created_at, updated_at, category_ids, recipient_ids, chart_variant, time_bucket, date_range_start, date_range_end) FROM stdin;
\.


--
-- Data for Name: savings_investments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.savings_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, created_at, updated_at, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, current_price, interest_rate) FROM stdin;
8	KBC Termijnrekening	EUR	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	15250.000000	2.5000
\.


--
-- Data for Name: savings_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.savings_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, created_at, updated_at, fx_rate_to_eur) FROM stdin;
85	8	buy	2024-01-15	12000.0000	0.0000	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N
86	8	interest	2025-01-02	180.0000	0.0000	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N
87	8	buy	2025-06-10	3000.0000	0.0000	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N
\.


--
-- Data for Name: schema_version; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_version (id, version, applied_at) FROM stdin;
\.


--
-- Data for Name: split_audit; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.split_audit (id, split_id, action, actor, payload, created_at) FROM stdin;
\.


--
-- Data for Name: split_payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.split_payments (id, split_id, amount, paid_at, note, created_at) FROM stdin;
1	1	36.69	2024-01-14	Terugbetaald	2026-06-18 08:45:15.510273+00
2	2	19.86	2024-06-15	Deelbetaling	2026-06-18 08:45:15.510273+00
3	4	33.53	2025-04-21	Terugbetaald	2026-06-18 08:45:15.510273+00
4	5	66.21	2025-07-10	Deelbetaling	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: stock_investments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, created_at, updated_at, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, symbol, current_price) FROM stdin;
3	Apple Inc.	USD	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	AAPL	197.160661
4	ASML Holding NV	EUR	\N	t	manual	\N	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	\N	\N	\N	\N	\N	\N	ASML	539.003594
\.


--
-- Data for Name: stock_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, created_at, updated_at, fx_rate_to_eur, units, price_per_unit) FROM stdin;
57	3	buy	2025-01-22	950.4619	3.4805	0.0000	USD	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	0.8634152984	5.28683178	179.779105
58	3	buy	2025-05-03	1029.0925	1.8603	0.0000	USD	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	0.8926408211	5.88835463	174.767415
59	3	buy	2025-12-12	705.2445	2.3122	0.0000	USD	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	0.8643719294	4.07037774	173.262667
60	3	buy	2024-07-11	495.2543	3.6440	0.0000	USD	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	0.8852291997	2.71674343	182.297044
61	3	buy	2024-04-19	520.2225	0.0086	0.0000	USD	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	0.8694378768	3.02632871	171.898881
62	3	buy	2024-07-16	1010.9263	2.5504	0.0000	USD	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	0.8779941916	5.51336269	183.359297
63	4	buy	2024-10-23	922.4469	0.5832	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	1.34148876	687.629263
64	4	buy	2024-01-10	559.0510	0.0456	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.79306554	704.924030
65	4	buy	2025-10-28	766.6418	2.3304	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	1.23505004	620.737409
66	4	buy	2025-07-10	457.9229	1.7335	0.0000	EUR	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	1.0000000000	0.76587415	597.908799
82	3	dividend	2025-02-13	22.5000	0.0000	6.7500	USD	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	0.8584299189	\N	\N
83	3	dividend	2025-08-14	24.1000	0.0000	7.2300	USD	\N	f	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00	0.8651527800	\N	\N
\.


--
-- Data for Name: tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tags (id, slug, color, is_active, created_at, updated_at) FROM stdin;
1	subscription	#6366f1	t	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
2	tax-deductible	#16a34a	t	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
3	holiday-2025	#f59e0b	t	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
4	work	#0ea5e9	t	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: transaction_raw_references; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transaction_raw_references (id, transaction_id, raw_source_type, raw_source_id, created_at) FROM stdin;
\.


--
-- Data for Name: transaction_splits; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transaction_splits (id, transaction_id, recipient_id, amount, note, is_settled, created_at, updated_at) FROM stdin;
1	23	50	36.69	Gedeelde rekening met Thomas Peeters	t	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
2	192	51	39.71	Gedeelde rekening met Sarah Maes	f	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
3	298	52	27.52	Gedeelde rekening met Lukas De Smet	f	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
4	540	50	33.53	Gedeelde rekening met Thomas Peeters	t	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
5	653	51	132.42	Gedeelde rekening met Sarah Maes	f	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
6	821	52	37.38	Gedeelde rekening met Lukas De Smet	f	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: transaction_tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transaction_tags (transaction_id, tag_id, created_at) FROM stdin;
8	1	2026-06-18 08:45:15.510273+00
9	1	2026-06-18 08:45:15.510273+00
11	2	2026-06-18 08:45:15.510273+00
12	1	2026-06-18 08:45:15.510273+00
13	1	2026-06-18 08:45:15.510273+00
14	1	2026-06-18 08:45:15.510273+00
41	1	2026-06-18 08:45:15.510273+00
42	1	2026-06-18 08:45:15.510273+00
44	2	2026-06-18 08:45:15.510273+00
45	1	2026-06-18 08:45:15.510273+00
46	1	2026-06-18 08:45:15.510273+00
47	1	2026-06-18 08:45:15.510273+00
71	4	2026-06-18 08:45:15.510273+00
76	1	2026-06-18 08:45:15.510273+00
77	1	2026-06-18 08:45:15.510273+00
79	2	2026-06-18 08:45:15.510273+00
80	1	2026-06-18 08:45:15.510273+00
81	1	2026-06-18 08:45:15.510273+00
82	1	2026-06-18 08:45:15.510273+00
101	2	2026-06-18 08:45:15.510273+00
110	1	2026-06-18 08:45:15.510273+00
111	1	2026-06-18 08:45:15.510273+00
113	2	2026-06-18 08:45:15.510273+00
114	1	2026-06-18 08:45:15.510273+00
115	1	2026-06-18 08:45:15.510273+00
116	1	2026-06-18 08:45:15.510273+00
141	1	2026-06-18 08:45:15.510273+00
142	1	2026-06-18 08:45:15.510273+00
144	2	2026-06-18 08:45:15.510273+00
145	1	2026-06-18 08:45:15.510273+00
146	1	2026-06-18 08:45:15.510273+00
147	1	2026-06-18 08:45:15.510273+00
168	2	2026-06-18 08:45:15.510273+00
177	1	2026-06-18 08:45:15.510273+00
178	1	2026-06-18 08:45:15.510273+00
180	2	2026-06-18 08:45:15.510273+00
181	1	2026-06-18 08:45:15.510273+00
182	1	2026-06-18 08:45:15.510273+00
183	1	2026-06-18 08:45:15.510273+00
212	1	2026-06-18 08:45:15.510273+00
213	1	2026-06-18 08:45:15.510273+00
215	2	2026-06-18 08:45:15.510273+00
216	1	2026-06-18 08:45:15.510273+00
217	1	2026-06-18 08:45:15.510273+00
218	1	2026-06-18 08:45:15.510273+00
235	4	2026-06-18 08:45:15.510273+00
237	2	2026-06-18 08:45:15.510273+00
246	1	2026-06-18 08:45:15.510273+00
247	1	2026-06-18 08:45:15.510273+00
249	2	2026-06-18 08:45:15.510273+00
250	1	2026-06-18 08:45:15.510273+00
251	1	2026-06-18 08:45:15.510273+00
252	1	2026-06-18 08:45:15.510273+00
270	2	2026-06-18 08:45:15.510273+00
276	4	2026-06-18 08:45:15.510273+00
281	1	2026-06-18 08:45:15.510273+00
282	1	2026-06-18 08:45:15.510273+00
284	2	2026-06-18 08:45:15.510273+00
285	1	2026-06-18 08:45:15.510273+00
286	1	2026-06-18 08:45:15.510273+00
287	1	2026-06-18 08:45:15.510273+00
308	2	2026-06-18 08:45:15.510273+00
312	4	2026-06-18 08:45:15.510273+00
318	1	2026-06-18 08:45:15.510273+00
319	1	2026-06-18 08:45:15.510273+00
321	2	2026-06-18 08:45:15.510273+00
322	1	2026-06-18 08:45:15.510273+00
323	1	2026-06-18 08:45:15.510273+00
324	1	2026-06-18 08:45:15.510273+00
342	4	2026-06-18 08:45:15.510273+00
343	2	2026-06-18 08:45:15.510273+00
348	4	2026-06-18 08:45:15.510273+00
354	1	2026-06-18 08:45:15.510273+00
355	1	2026-06-18 08:45:15.510273+00
357	2	2026-06-18 08:45:15.510273+00
358	1	2026-06-18 08:45:15.510273+00
359	1	2026-06-18 08:45:15.510273+00
360	1	2026-06-18 08:45:15.510273+00
377	2	2026-06-18 08:45:15.510273+00
386	1	2026-06-18 08:45:15.510273+00
387	1	2026-06-18 08:45:15.510273+00
389	2	2026-06-18 08:45:15.510273+00
390	1	2026-06-18 08:45:15.510273+00
391	1	2026-06-18 08:45:15.510273+00
392	1	2026-06-18 08:45:15.510273+00
409	4	2026-06-18 08:45:15.510273+00
419	1	2026-06-18 08:45:15.510273+00
420	1	2026-06-18 08:45:15.510273+00
422	2	2026-06-18 08:45:15.510273+00
423	1	2026-06-18 08:45:15.510273+00
424	1	2026-06-18 08:45:15.510273+00
425	1	2026-06-18 08:45:15.510273+00
426	1	2026-06-18 08:45:15.510273+00
445	2	2026-06-18 08:45:15.510273+00
454	1	2026-06-18 08:45:15.510273+00
455	1	2026-06-18 08:45:15.510273+00
457	2	2026-06-18 08:45:15.510273+00
458	1	2026-06-18 08:45:15.510273+00
459	1	2026-06-18 08:45:15.510273+00
460	1	2026-06-18 08:45:15.510273+00
461	1	2026-06-18 08:45:15.510273+00
481	2	2026-06-18 08:45:15.510273+00
489	1	2026-06-18 08:45:15.510273+00
490	1	2026-06-18 08:45:15.510273+00
492	2	2026-06-18 08:45:15.510273+00
493	1	2026-06-18 08:45:15.510273+00
494	1	2026-06-18 08:45:15.510273+00
495	1	2026-06-18 08:45:15.510273+00
496	1	2026-06-18 08:45:15.510273+00
516	2	2026-06-18 08:45:15.510273+00
525	1	2026-06-18 08:45:15.510273+00
526	1	2026-06-18 08:45:15.510273+00
528	2	2026-06-18 08:45:15.510273+00
529	1	2026-06-18 08:45:15.510273+00
530	1	2026-06-18 08:45:15.510273+00
531	1	2026-06-18 08:45:15.510273+00
532	1	2026-06-18 08:45:15.510273+00
551	2	2026-06-18 08:45:15.510273+00
559	1	2026-06-18 08:45:15.510273+00
560	1	2026-06-18 08:45:15.510273+00
562	2	2026-06-18 08:45:15.510273+00
563	1	2026-06-18 08:45:15.510273+00
564	1	2026-06-18 08:45:15.510273+00
565	1	2026-06-18 08:45:15.510273+00
566	1	2026-06-18 08:45:15.510273+00
594	1	2026-06-18 08:45:15.510273+00
595	1	2026-06-18 08:45:15.510273+00
597	2	2026-06-18 08:45:15.510273+00
598	1	2026-06-18 08:45:15.510273+00
599	1	2026-06-18 08:45:15.510273+00
600	1	2026-06-18 08:45:15.510273+00
601	1	2026-06-18 08:45:15.510273+00
618	4	2026-06-18 08:45:15.510273+00
620	3	2026-06-18 08:45:15.510273+00
629	1	2026-06-18 08:45:15.510273+00
630	1	2026-06-18 08:45:15.510273+00
632	2	2026-06-18 08:45:15.510273+00
633	1	2026-06-18 08:45:15.510273+00
634	1	2026-06-18 08:45:15.510273+00
635	1	2026-06-18 08:45:15.510273+00
636	1	2026-06-18 08:45:15.510273+00
652	2	2026-06-18 08:45:15.510273+00
653	3	2026-06-18 08:45:15.510273+00
656	4	2026-06-18 08:45:15.510273+00
662	1	2026-06-18 08:45:15.510273+00
663	1	2026-06-18 08:45:15.510273+00
665	2	2026-06-18 08:45:15.510273+00
666	1	2026-06-18 08:45:15.510273+00
667	1	2026-06-18 08:45:15.510273+00
668	1	2026-06-18 08:45:15.510273+00
669	1	2026-06-18 08:45:15.510273+00
687	2	2026-06-18 08:45:15.510273+00
696	1	2026-06-18 08:45:15.510273+00
697	1	2026-06-18 08:45:15.510273+00
699	2	2026-06-18 08:45:15.510273+00
700	1	2026-06-18 08:45:15.510273+00
701	1	2026-06-18 08:45:15.510273+00
702	1	2026-06-18 08:45:15.510273+00
703	1	2026-06-18 08:45:15.510273+00
720	2	2026-06-18 08:45:15.510273+00
723	4	2026-06-18 08:45:15.510273+00
729	1	2026-06-18 08:45:15.510273+00
730	1	2026-06-18 08:45:15.510273+00
732	2	2026-06-18 08:45:15.510273+00
733	1	2026-06-18 08:45:15.510273+00
734	1	2026-06-18 08:45:15.510273+00
735	1	2026-06-18 08:45:15.510273+00
736	1	2026-06-18 08:45:15.510273+00
766	1	2026-06-18 08:45:15.510273+00
767	1	2026-06-18 08:45:15.510273+00
769	2	2026-06-18 08:45:15.510273+00
770	1	2026-06-18 08:45:15.510273+00
771	1	2026-06-18 08:45:15.510273+00
772	1	2026-06-18 08:45:15.510273+00
773	1	2026-06-18 08:45:15.510273+00
794	2	2026-06-18 08:45:15.510273+00
804	1	2026-06-18 08:45:15.510273+00
805	1	2026-06-18 08:45:15.510273+00
807	2	2026-06-18 08:45:15.510273+00
808	1	2026-06-18 08:45:15.510273+00
809	1	2026-06-18 08:45:15.510273+00
810	1	2026-06-18 08:45:15.510273+00
811	1	2026-06-18 08:45:15.510273+00
832	2	2026-06-18 08:45:15.510273+00
843	1	2026-06-18 08:45:15.510273+00
844	1	2026-06-18 08:45:15.510273+00
846	2	2026-06-18 08:45:15.510273+00
847	1	2026-06-18 08:45:15.510273+00
848	1	2026-06-18 08:45:15.510273+00
849	1	2026-06-18 08:45:15.510273+00
850	1	2026-06-18 08:45:15.510273+00
876	1	2026-06-18 08:45:15.510273+00
877	1	2026-06-18 08:45:15.510273+00
879	2	2026-06-18 08:45:15.510273+00
880	1	2026-06-18 08:45:15.510273+00
881	1	2026-06-18 08:45:15.510273+00
882	1	2026-06-18 08:45:15.510273+00
883	1	2026-06-18 08:45:15.510273+00
902	4	2026-06-18 08:45:15.510273+00
907	1	2026-06-18 08:45:15.510273+00
908	1	2026-06-18 08:45:15.510273+00
910	2	2026-06-18 08:45:15.510273+00
911	1	2026-06-18 08:45:15.510273+00
912	1	2026-06-18 08:45:15.510273+00
913	1	2026-06-18 08:45:15.510273+00
914	1	2026-06-18 08:45:15.510273+00
937	2	2026-06-18 08:45:15.510273+00
938	2	2026-06-18 08:45:15.510273+00
947	1	2026-06-18 08:45:15.510273+00
948	1	2026-06-18 08:45:15.510273+00
950	2	2026-06-18 08:45:15.510273+00
951	1	2026-06-18 08:45:15.510273+00
952	1	2026-06-18 08:45:15.510273+00
953	1	2026-06-18 08:45:15.510273+00
954	1	2026-06-18 08:45:15.510273+00
981	4	2026-06-18 08:45:15.510273+00
987	1	2026-06-18 08:45:15.510273+00
988	1	2026-06-18 08:45:15.510273+00
990	2	2026-06-18 08:45:15.510273+00
991	1	2026-06-18 08:45:15.510273+00
992	1	2026-06-18 08:45:15.510273+00
993	1	2026-06-18 08:45:15.510273+00
994	1	2026-06-18 08:45:15.510273+00
1012	2	2026-06-18 08:45:15.510273+00
1015	4	2026-06-18 08:45:15.510273+00
1018	1	2026-06-18 08:45:15.510273+00
1019	1	2026-06-18 08:45:15.510273+00
1021	2	2026-06-18 08:45:15.510273+00
1022	1	2026-06-18 08:45:15.510273+00
1023	1	2026-06-18 08:45:15.510273+00
1024	1	2026-06-18 08:45:15.510273+00
1025	1	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transactions (id, date, amount, currency, balance, memo, comment, bank_account, recipient_id, recipient_bank_account_id, category_id, is_active, created_at, updated_at, import_batch_id, matched_pattern_id, tx_hash) FROM stdin;
1	2024-01-25	3404.0000	EUR	7157.95	Loon januari 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
2	2024-01-05	1387.0000	EUR	4431.00	Loon partner januari 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
3	2024-01-02	24.5143	EUR	8024.51	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
4	2024-01-28	-1100.0000	EUR	5164.19	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
5	2024-01-28	1100.0000	EUR	9124.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
6	2024-01-03	-932.4795	EUR	3210.57	Hypotheek aflossing januari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
7	2024-01-09	-120.5354	EUR	4129.05	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
8	2024-01-12	-54.0000	EUR	3943.09	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
9	2024-01-12	-22.0000	EUR	3921.09	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
10	2024-01-06	-45.0000	EUR	4375.01	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
11	2024-01-06	-38.0000	EUR	4337.01	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
12	2024-01-18	-13.9900	EUR	3761.27	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
13	2024-01-05	-10.9900	EUR	4420.01	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
14	2024-01-02	-29.9900	EUR	4170.01	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
15	2024-01-03	-49.0000	EUR	3161.57	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
16	2024-01-27	-750.0000	EUR	6407.95	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
17	2024-01-15	-52.5459	EUR	3809.77	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
18	2024-01-31	-57.7418	EUR	5099.88	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
19	2024-01-03	-33.9709	EUR	3127.60	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
20	2024-01-04	-83.5986	EUR	3044.00	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
21	2024-01-10	-127.0979	EUR	3997.09	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
22	2024-01-13	-58.7818	EUR	3862.31	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
23	2024-01-08	-73.3710	EUR	4249.59	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
24	2024-01-31	-66.8117	EUR	5033.07	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
25	2024-01-19	-7.3248	EUR	3753.95	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
26	2024-01-30	-6.5687	EUR	5157.62	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
27	2024-01-17	-6.2067	EUR	3803.56	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
28	2024-01-09	-4.8619	EUR	4124.19	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
29	2024-01-31	-21.4197	EUR	5011.65	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
30	2024-01-02	-26.9624	EUR	4143.05	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
31	2024-01-17	-28.2962	EUR	3775.26	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
32	2024-01-27	-143.7558	EUR	6264.19	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
33	2024-01-07	-14.0490	EUR	4322.96	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
34	2024-02-25	3404.0000	EUR	7749.13	Loon februari 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
35	2024-02-05	1400.0000	EUR	5130.14	Loon partner februari 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
36	2024-02-28	-1100.0000	EUR	5761.73	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
37	2024-02-28	1100.0000	EUR	10224.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
38	2024-02-03	-932.4795	EUR	3860.84	Hypotheek aflossing februari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
39	2024-02-11	-94.8291	EUR	4672.42	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
40	2024-02-15	-51.3546	EUR	4512.19	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
41	2024-02-12	-54.0000	EUR	4618.42	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
42	2024-02-12	-22.0000	EUR	4596.42	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
43	2024-02-06	-45.0000	EUR	5030.88	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
44	2024-02-06	-38.0000	EUR	4992.88	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
45	2024-02-18	-13.9900	EUR	4492.25	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
46	2024-02-05	-10.9900	EUR	5119.15	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
47	2024-02-02	-29.9900	EUR	4981.66	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
48	2024-02-03	-49.0000	EUR	3811.84	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
49	2024-02-27	-750.0000	EUR	6861.73	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
50	2024-02-10	-89.3653	EUR	4770.96	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
51	2024-02-02	-99.5338	EUR	4882.13	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
52	2024-02-14	-32.8773	EUR	4563.54	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
53	2024-02-05	-43.2755	EUR	5075.88	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
54	2024-02-04	-66.0827	EUR	3745.75	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
55	2024-02-24	-79.4823	EUR	4345.13	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
56	2024-02-02	-88.8098	EUR	4793.32	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
57	2024-02-18	-60.9502	EUR	4431.29	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
58	2024-02-26	-5.9483	EUR	7743.18	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
59	2024-02-20	-6.6837	EUR	4424.61	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
60	2024-02-06	-4.0740	EUR	4988.80	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
61	2024-02-17	-5.9542	EUR	4506.24	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
62	2024-02-10	-3.7078	EUR	4767.25	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
63	2024-02-07	-7.3505	EUR	4963.78	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
64	2024-02-06	-17.6667	EUR	4971.14	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
65	2024-02-04	-15.6132	EUR	3730.14	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
66	2024-02-29	-25.5958	EUR	5736.14	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
67	2024-02-09	-103.4613	EUR	4860.32	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
68	2024-02-26	-131.4486	EUR	7611.73	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
69	2024-03-25	3382.0000	EUR	8960.68	Loon maart 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
70	2024-03-05	1391.0000	EUR	6045.59	Loon partner maart 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
71	2024-03-16	851.0739	EUR	5706.41	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
72	2024-03-28	-1100.0000	EUR	7110.68	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
73	2024-03-28	1100.0000	EUR	11324.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
74	2024-03-03	-932.4795	EUR	4773.67	Hypotheek aflossing maart	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
75	2024-03-08	-124.1874	EUR	5786.91	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
76	2024-03-12	-54.0000	EUR	5003.58	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
77	2024-03-12	-22.0000	EUR	4981.58	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
78	2024-03-06	-45.0000	EUR	5985.65	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
79	2024-03-06	-38.0000	EUR	5947.65	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
80	2024-03-18	-13.9900	EUR	5692.42	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
81	2024-03-05	-10.9900	EUR	6034.60	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
82	2024-03-02	-29.9900	EUR	5706.15	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
83	2024-03-03	-49.0000	EUR	4724.67	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
84	2024-03-27	-750.0000	EUR	8210.68	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
85	2024-03-11	-90.0415	EUR	5095.58	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
86	2024-03-21	-57.7379	EUR	5634.68	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
87	2024-03-31	-119.8679	EUR	6954.02	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
88	2024-03-07	-36.5538	EUR	5911.10	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
89	2024-03-04	-48.4374	EUR	4676.23	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
90	2024-03-24	-51.2115	EUR	5583.47	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
91	2024-03-12	-42.3732	EUR	4939.21	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
92	2024-03-15	-78.2127	EUR	4855.34	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
93	2024-03-31	-75.2213	EUR	6878.80	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
94	2024-03-24	-4.7938	EUR	5578.68	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
95	2024-03-28	-6.0116	EUR	7104.67	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
96	2024-03-05	-3.9440	EUR	6030.65	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
97	2024-03-13	-5.6605	EUR	4933.55	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
98	2024-03-28	-21.5584	EUR	7083.11	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
99	2024-03-04	-21.6427	EUR	4654.59	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
100	2024-03-10	-601.2883	EUR	5185.62	Electronica	\N	BE76 7340 1234 5678	42	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
101	2024-03-28	-9.2162	EUR	7073.89	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
102	2024-03-11	-37.9987	EUR	5057.58	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
103	2024-04-25	3399.0000	EUR	9451.06	Loon april 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
104	2024-04-05	1410.0000	EUR	6851.56	Loon partner april 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
105	2024-04-02	9.5322	EUR	11334.05	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
106	2024-04-28	-1100.0000	EUR	7601.06	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
107	2024-04-28	1100.0000	EUR	12434.05	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
108	2024-04-03	-932.4795	EUR	5916.33	Hypotheek aflossing april	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
109	2024-04-10	-140.3360	EUR	6456.97	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
110	2024-04-12	-54.0000	EUR	6402.97	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
111	2024-04-12	-22.0000	EUR	6380.97	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
112	2024-04-06	-45.0000	EUR	6702.73	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
113	2024-04-06	-38.0000	EUR	6664.73	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
114	2024-04-18	-13.9900	EUR	6181.93	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
115	2024-04-05	-10.9900	EUR	6840.57	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
116	2024-04-02	-29.9900	EUR	6848.81	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
117	2024-04-03	-49.0000	EUR	5867.33	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
118	2024-04-27	-750.0000	EUR	8701.06	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
119	2024-04-12	-92.9070	EUR	6288.06	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
120	2024-04-24	-60.1740	EUR	6052.06	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
121	2024-04-05	-92.8353	EUR	6747.73	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
122	2024-04-28	-82.2814	EUR	7518.78	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
123	2024-04-19	-62.9387	EUR	6118.99	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
124	2024-04-08	-67.4246	EUR	6597.31	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
125	2024-04-03	-35.7214	EUR	5831.61	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
126	2024-04-15	-77.7665	EUR	6210.30	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
127	2024-04-16	-6.8889	EUR	6195.92	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
128	2024-04-20	-6.7630	EUR	6112.23	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
129	2024-04-15	-7.4852	EUR	6202.81	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
130	2024-04-28	-4.6788	EUR	7514.10	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
131	2024-04-29	-20.1202	EUR	7493.98	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
132	2024-04-03	-390.0551	EUR	5441.56	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
133	2024-04-30	-18.4068	EUR	7475.57	Hobby	\N	BE76 7340 1234 5678	48	\N	24	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
134	2024-05-25	3396.0000	EUR	10316.99	Loon mei 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
135	2024-05-05	1408.0000	EUR	7761.57	Loon partner mei 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
136	2024-05-28	-1100.0000	EUR	8442.15	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
137	2024-05-28	1100.0000	EUR	13534.05	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
138	2024-05-03	-932.4795	EUR	6402.57	Hypotheek aflossing mei	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
139	2024-05-08	-108.3275	EUR	7559.26	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
140	2024-05-15	-44.8126	EUR	7291.59	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
141	2024-05-12	-54.0000	EUR	7408.88	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
142	2024-05-12	-22.0000	EUR	7386.88	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
143	2024-05-06	-45.0000	EUR	7705.58	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
144	2024-05-06	-38.0000	EUR	7667.58	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
145	2024-05-18	-13.9900	EUR	7231.54	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
146	2024-05-05	-10.9900	EUR	7750.58	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
147	2024-05-02	-29.9900	EUR	7346.26	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
148	2024-05-03	-49.0000	EUR	6353.57	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
149	2024-05-15	-41.5240	EUR	7250.07	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
150	2024-05-27	-750.0000	EUR	9566.99	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
151	2024-05-01	-99.3161	EUR	7376.25	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
152	2024-05-08	-56.5421	EUR	7502.71	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
153	2024-05-18	-95.6012	EUR	7135.94	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
154	2024-05-31	-33.6144	EUR	7968.03	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
155	2024-05-18	-76.9165	EUR	7059.02	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
156	2024-05-31	-72.6779	EUR	7895.35	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
157	2024-05-19	-33.9358	EUR	7025.09	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
158	2024-05-29	-60.9188	EUR	8368.05	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
159	2024-05-02	-5.0595	EUR	7341.20	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
160	2024-05-24	-3.3058	EUR	6920.99	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
161	2024-05-02	-6.1497	EUR	7335.05	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
162	2024-05-16	-4.5384	EUR	7245.53	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
163	2024-05-10	-39.8361	EUR	7462.88	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
164	2024-05-27	-24.8379	EUR	9542.15	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
165	2024-05-14	-27.5148	EUR	7336.41	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
166	2024-05-29	-366.4105	EUR	8001.64	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
167	2024-05-20	-100.7894	EUR	6924.30	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
168	2024-05-13	-22.9578	EUR	7363.92	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
169	2024-05-28	-13.1814	EUR	8428.97	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
170	2024-05-31	-49.6889	EUR	7845.66	Hobby	\N	BE76 7340 1234 5678	48	\N	24	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
171	2024-06-25	3394.0000	EUR	10277.27	Loon juni 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
172	2024-06-05	1399.0000	EUR	8080.92	Loon partner juni 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
173	2024-06-28	-1100.0000	EUR	8422.54	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
174	2024-06-28	1100.0000	EUR	14634.05	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
175	2024-06-03	-932.4795	EUR	6763.38	Hypotheek aflossing juni	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
176	2024-06-09	-124.4610	EUR	7862.47	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
177	2024-06-12	-54.0000	EUR	7709.71	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
178	2024-06-12	-22.0000	EUR	7687.71	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
179	2024-06-06	-45.0000	EUR	8024.93	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
180	2024-06-06	-38.0000	EUR	7986.93	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
181	2024-06-18	-13.9900	EUR	7355.92	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
182	2024-06-05	-10.9900	EUR	8069.93	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
183	2024-06-02	-29.9900	EUR	7695.86	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
184	2024-06-03	-49.0000	EUR	6714.38	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
185	2024-06-03	-32.4644	EUR	6681.92	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
186	2024-06-27	-750.0000	EUR	9527.27	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
187	2024-06-22	-68.0252	EUR	7257.52	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
188	2024-06-28	-54.5232	EUR	8368.02	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
189	2024-06-23	-54.7984	EUR	7202.72	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
190	2024-06-01	-119.8099	EUR	7725.85	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
191	2024-06-10	-66.1857	EUR	7796.28	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
192	2024-06-12	-79.4161	EUR	7608.29	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
193	2024-06-10	-32.5735	EUR	7763.71	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
194	2024-06-16	-76.6034	EUR	7518.88	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
195	2024-06-27	-4.7331	EUR	9522.54	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
196	2024-06-19	-5.4086	EUR	7350.51	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
197	2024-06-12	-7.1574	EUR	7601.14	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
198	2024-06-13	-5.6545	EUR	7595.48	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
199	2024-06-29	-5.6491	EUR	8362.37	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
200	2024-06-19	-4.6885	EUR	7345.82	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
201	2024-06-20	-20.2781	EUR	7325.54	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
202	2024-06-17	-127.9313	EUR	7369.91	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
203	2024-06-16	-21.0368	EUR	7497.84	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
204	2024-06-24	-319.4455	EUR	6883.27	Reis / vakantie	\N	BE76 7340 1234 5678	47	\N	25	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
205	2024-07-25	3412.0000	EUR	10745.05	Loon juli 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
206	2024-07-05	1386.0000	EUR	8723.73	Loon partner juli 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
207	2024-07-02	24.9234	EUR	14658.97	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
208	2024-07-28	-1100.0000	EUR	8324.36	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
209	2024-07-28	1100.0000	EUR	15758.97	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
210	2024-07-03	-932.4795	EUR	7386.73	Hypotheek aflossing juli	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
211	2024-07-09	-120.7088	EUR	8344.06	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
212	2024-07-12	-54.0000	EUR	7600.34	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
213	2024-07-12	-22.0000	EUR	7578.34	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
214	2024-07-06	-45.0000	EUR	8556.24	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
215	2024-07-06	-38.0000	EUR	8518.24	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
216	2024-07-18	-13.9900	EUR	7486.40	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
217	2024-07-05	-10.9900	EUR	8712.74	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
218	2024-07-02	-29.9900	EUR	8319.21	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
219	2024-07-03	-49.0000	EUR	7337.73	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
220	2024-07-27	-750.0000	EUR	9428.00	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
221	2024-07-25	-89.1446	EUR	10655.91	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
222	2024-07-28	-40.1238	EUR	8284.23	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
223	2024-07-10	-113.8188	EUR	8230.25	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
224	2024-07-06	-53.4616	EUR	8464.77	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
225	2024-07-05	-58.5518	EUR	8654.19	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
226	2024-07-18	-86.1475	EUR	7400.25	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
227	2024-07-15	-66.6353	EUR	7504.54	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
228	2024-07-29	-59.9196	EUR	8224.31	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
229	2024-07-27	-3.6467	EUR	9424.36	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
230	2024-07-12	-7.1600	EUR	7571.18	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
231	2024-07-20	-4.2394	EUR	7396.01	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
232	2024-07-16	-4.1534	EUR	7500.39	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
233	2024-07-20	-36.9855	EUR	7359.03	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
234	2024-07-23	-25.9773	EUR	7333.05	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
235	2024-07-10	-575.9071	EUR	7654.34	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
236	2024-07-25	-477.9019	EUR	10178.00	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
237	2024-07-01	-13.1708	EUR	8349.20	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
238	2024-07-05	-52.9522	EUR	8601.24	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
239	2024-08-25	3380.0000	EUR	10569.49	Loon augustus 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
240	2024-08-05	1400.0000	EUR	8600.52	Loon partner augustus 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
241	2024-08-28	-1100.0000	EUR	8594.52	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
242	2024-08-28	1100.0000	EUR	16858.97	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
243	2024-08-03	-932.4795	EUR	7261.84	Hypotheek aflossing augustus	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
244	2024-08-10	-116.6258	EUR	7934.29	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
245	2024-08-15	-57.2254	EUR	7382.67	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
246	2024-08-12	-54.0000	EUR	7461.89	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
247	2024-08-12	-22.0000	EUR	7439.89	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
248	2024-08-06	-45.0000	EUR	8538.22	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
249	2024-08-06	-38.0000	EUR	8500.22	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
250	2024-08-18	-13.9900	EUR	7368.68	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
251	2024-08-05	-10.9900	EUR	8589.53	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
252	2024-08-02	-29.9900	EUR	8194.32	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
253	2024-08-03	-49.0000	EUR	7212.84	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
254	2024-08-27	-750.0000	EUR	9757.86	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
255	2024-08-06	-94.2939	EUR	8405.93	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
256	2024-08-07	-117.7241	EUR	8182.82	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
257	2024-08-08	-101.4372	EUR	8081.39	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
258	2024-08-27	-63.3358	EUR	9694.52	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
259	2024-08-06	-69.0402	EUR	8336.89	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
260	2024-08-24	-80.7455	EUR	7194.49	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
261	2024-08-06	-36.3393	EUR	8300.55	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
262	2024-08-23	-86.4696	EUR	7275.24	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
263	2024-08-18	-3.6620	EUR	7365.01	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
264	2024-08-11	-6.8645	EUR	7528.32	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
265	2024-08-05	-6.3081	EUR	8583.22	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
266	2024-08-28	-4.1241	EUR	8590.40	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
267	2024-08-24	-5.0015	EUR	7189.49	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
268	2024-08-18	-3.3086	EUR	7361.71	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
269	2024-08-08	-30.4717	EUR	8050.92	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
270	2024-08-04	-12.3246	EUR	7200.52	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
271	2024-08-26	-61.6303	EUR	10507.86	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
272	2024-08-11	-12.4259	EUR	7515.89	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
273	2024-08-10	-399.1079	EUR	7535.18	Reis / vakantie	\N	BE76 7340 1234 5678	46	\N	25	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
274	2024-09-25	3412.0000	EUR	11769.90	Loon september 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
275	2024-09-05	1402.0000	EUR	8675.57	Loon partner september 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
276	2024-09-16	872.7241	EUR	8717.93	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
277	2024-09-28	-1100.0000	EUR	9706.20	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
278	2024-09-28	1100.0000	EUR	17958.97	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
279	2024-09-03	-932.4795	EUR	7391.83	Hypotheek aflossing september	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
280	2024-09-09	-120.9180	EUR	8331.34	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
281	2024-09-12	-54.0000	EUR	8211.56	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
282	2024-09-12	-22.0000	EUR	8189.56	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
283	2024-09-06	-45.0000	EUR	8545.31	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
284	2024-09-06	-38.0000	EUR	8507.31	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
285	2024-09-18	-13.9900	EUR	8652.45	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
286	2024-09-05	-10.9900	EUR	8664.58	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
287	2024-09-02	-29.9900	EUR	8324.31	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
288	2024-09-03	-49.0000	EUR	7342.83	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
289	2024-09-27	-750.0000	EUR	10806.20	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
290	2024-09-05	-68.1103	EUR	8596.47	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
291	2024-09-21	-100.1488	EUR	8546.68	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
292	2024-09-01	-110.0810	EUR	8480.32	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
293	2024-09-01	-126.0145	EUR	8354.30	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
294	2024-09-23	-122.8845	EUR	8357.90	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
295	2024-09-26	-68.1256	EUR	11561.78	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
296	2024-09-03	-69.2606	EUR	7273.57	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
297	2024-09-17	-51.4814	EUR	8666.44	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
298	2024-09-08	-55.0488	EUR	8452.26	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
299	2024-09-25	-80.0932	EUR	11689.80	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
300	2024-09-29	-69.2286	EUR	9636.97	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
301	2024-09-26	-5.5874	EUR	11556.20	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
302	2024-09-21	-3.6526	EUR	8543.03	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
303	2024-09-18	-5.6210	EUR	8646.83	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
304	2024-09-05	-6.1619	EUR	8590.31	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
305	2024-09-10	-32.7190	EUR	8298.62	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
306	2024-09-22	-62.2523	EUR	8480.78	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
307	2024-09-13	-344.3622	EUR	7845.20	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
308	2024-09-10	-33.0610	EUR	8265.56	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
309	2024-09-25	-59.8934	EUR	11629.91	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
310	2024-10-25	3403.0000	EUR	11570.55	Loon oktober 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
311	2024-10-05	1396.0000	EUR	9861.83	Loon partner oktober 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
312	2024-10-15	362.1312	EUR	9787.59	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
313	2024-10-02	29.5424	EUR	17988.51	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
314	2024-10-28	-1100.0000	EUR	9628.49	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
315	2024-10-28	1100.0000	EUR	19088.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
316	2024-10-03	-932.4795	EUR	8514.83	Hypotheek aflossing oktober	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
317	2024-10-08	-102.1255	EUR	9556.04	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
318	2024-10-12	-54.0000	EUR	9502.04	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
319	2024-10-12	-22.0000	EUR	9480.04	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
320	2024-10-06	-45.0000	EUR	9805.84	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
321	2024-10-06	-38.0000	EUR	9767.84	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
322	2024-10-18	-13.9900	EUR	8379.78	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
323	2024-10-05	-10.9900	EUR	9850.84	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
324	2024-10-02	-29.9900	EUR	9447.31	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
325	2024-10-03	-49.0000	EUR	8465.83	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
326	2024-10-27	-750.0000	EUR	10728.49	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
327	2024-10-20	-80.8714	EUR	8298.91	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
328	2024-10-25	-82.2244	EUR	11488.33	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
329	2024-10-07	-84.0315	EUR	9662.67	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
330	2024-10-01	-107.2536	EUR	9529.71	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
331	2024-10-28	-58.5872	EUR	9569.90	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
332	2024-10-28	-66.7803	EUR	9503.12	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
333	2024-10-01	-52.4124	EUR	9477.30	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
334	2024-10-14	-28.6046	EUR	9451.43	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
335	2024-10-31	-34.2087	EUR	9461.57	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
336	2024-10-30	-7.3449	EUR	9495.78	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
337	2024-10-07	-4.5024	EUR	9658.16	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
338	2024-10-21	-3.4609	EUR	8203.88	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
339	2024-10-20	-3.2952	EUR	8295.61	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
340	2024-10-06	-21.1426	EUR	9746.70	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
341	2024-10-21	-36.3291	EUR	8167.55	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
342	2024-10-20	-88.2694	EUR	8207.34	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
343	2024-10-14	-25.9735	EUR	9425.46	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
344	2024-10-25	-9.8367	EUR	11478.49	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
345	2024-10-15	-1393.8255	EUR	8393.77	Personenbelasting afrekening	\N	BE76 7340 1234 5678	18	\N	32	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
346	2024-11-25	3392.0000	EUR	12667.93	Loon november 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
347	2024-11-05	1399.0000	EUR	9753.89	Loon partner november 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
348	2024-11-18	517.4891	EUR	9625.76	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
349	2024-11-28	-1100.0000	EUR	10813.90	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
350	2024-11-28	1100.0000	EUR	20188.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
351	2024-11-03	-932.4795	EUR	8467.08	Hypotheek aflossing november	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
352	2024-11-11	-146.6524	EUR	9428.51	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
353	2024-11-15	-67.5915	EUR	9260.19	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
354	2024-11-12	-54.0000	EUR	9374.51	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
355	2024-11-12	-22.0000	EUR	9352.51	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
356	2024-11-06	-45.0000	EUR	9613.16	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
357	2024-11-06	-38.0000	EUR	9575.16	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
358	2024-11-18	-13.9900	EUR	9611.77	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
359	2024-11-05	-10.9900	EUR	9742.90	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
360	2024-11-02	-29.9900	EUR	9399.56	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
361	2024-11-03	-49.0000	EUR	8418.08	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
362	2024-11-27	-750.0000	EUR	11913.90	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
363	2024-11-23	-71.7960	EUR	9357.78	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
364	2024-11-15	-95.7994	EUR	9164.39	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
365	2024-11-24	-63.6644	EUR	9275.93	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
366	2024-11-01	-32.0185	EUR	9429.55	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
367	2024-11-21	-91.4881	EUR	9429.57	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
368	2024-11-05	-52.2914	EUR	9690.61	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
369	2024-11-18	-81.4024	EUR	9530.36	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
370	2024-11-05	-32.4408	EUR	9658.16	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
371	2024-11-03	-63.1937	EUR	8354.89	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
372	2024-11-25	-4.0266	EUR	12663.90	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
373	2024-11-18	-5.9273	EUR	9524.44	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
374	2024-11-18	-3.3763	EUR	9521.06	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
375	2024-11-23	-18.1841	EUR	9339.59	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
376	2024-11-16	-56.1202	EUR	9108.27	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
377	2024-11-12	-24.7332	EUR	9327.78	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
378	2024-11-29	-75.4221	EUR	10738.48	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
379	2024-12-25	3414.0000	EUR	14686.66	Loon december 2024	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
380	2024-12-05	1391.0000	EUR	11096.71	Loon partner december 2024	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
381	2024-12-20	1500.0000	EUR	11278.85	Eindejaarsbonus 2024	\N	BE76 7340 1234 5678	1	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
382	2024-12-28	-1100.0000	EUR	12836.66	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
383	2024-12-28	1100.0000	EUR	21288.51	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
384	2024-12-03	-932.4795	EUR	9776.01	Hypotheek aflossing december	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
385	2024-12-09	-112.8597	EUR	10687.88	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
386	2024-12-12	-54.0000	EUR	10489.85	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
387	2024-12-12	-22.0000	EUR	10467.85	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
388	2024-12-06	-45.0000	EUR	11040.72	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
389	2024-12-06	-38.0000	EUR	11002.72	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
390	2024-12-18	-13.9900	EUR	9835.34	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
391	2024-12-05	-10.9900	EUR	11085.72	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
392	2024-12-02	-29.9900	EUR	10708.49	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
393	2024-12-03	-49.0000	EUR	9727.01	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
394	2024-12-06	-23.2221	EUR	10979.50	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
395	2024-12-27	-750.0000	EUR	13936.66	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
396	2024-12-06	-95.7898	EUR	10883.71	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
397	2024-12-18	-56.4908	EUR	9778.85	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
398	2024-12-10	-66.7924	EUR	10617.66	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
399	2024-12-07	-82.9638	EUR	10800.74	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
400	2024-12-10	-73.8082	EUR	10543.85	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
401	2024-12-17	-50.2428	EUR	9864.73	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
402	2024-12-29	-39.6682	EUR	12636.78	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
403	2024-12-29	-4.3402	EUR	12632.44	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
404	2024-12-30	-3.3347	EUR	12624.21	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
405	2024-12-29	-4.8914	EUR	12627.54	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
406	2024-12-09	-3.4339	EUR	10684.45	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
407	2024-12-22	-6.1840	EUR	11272.66	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
408	2024-12-04	-21.3011	EUR	9705.71	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
409	2024-12-16	-552.8775	EUR	9914.97	Electronica	\N	BE76 7340 1234 5678	42	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
410	2024-12-28	-160.2192	EUR	12676.44	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
411	2024-12-17	-15.4001	EUR	9849.33	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
412	2025-01-25	3514.0000	EUR	15487.18	Loon januari 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
413	2025-01-05	1438.0000	EUR	12965.60	Loon partner januari 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
414	2025-01-02	17.6734	EUR	21306.19	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
415	2025-01-28	-1100.0000	EUR	13637.18	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
416	2025-01-28	1100.0000	EUR	22406.19	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
417	2025-01-03	-932.4795	EUR	11576.60	Hypotheek aflossing januari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
418	2025-01-11	-136.0822	EUR	12559.04	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
419	2025-01-12	-54.0000	EUR	12380.39	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
420	2025-01-12	-22.0000	EUR	12358.39	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
421	2025-01-06	-45.0000	EUR	12900.62	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
422	2025-01-06	-38.0000	EUR	12862.62	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
423	2025-01-18	-13.9900	EUR	12158.29	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
424	2025-01-05	-10.9900	EUR	12954.61	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
425	2025-01-05	-8.9900	EUR	12945.62	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
426	2025-01-02	-29.9900	EUR	12594.22	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
427	2025-01-03	-49.0000	EUR	11527.60	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
428	2025-01-15	-27.8896	EUR	12284.59	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
429	2025-01-27	-750.0000	EUR	14737.18	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
430	2025-01-19	-107.2632	EUR	11973.18	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
431	2025-01-06	-51.8155	EUR	12810.80	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
432	2025-01-18	-77.8484	EUR	12080.44	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
433	2025-01-02	-85.1436	EUR	12509.08	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
434	2025-01-30	-70.3455	EUR	13566.83	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
435	2025-01-11	-65.3987	EUR	12493.64	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
436	2025-01-17	-76.7193	EUR	12172.28	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
437	2025-01-11	-59.2519	EUR	12434.39	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
438	2025-01-15	-35.5957	EUR	12249.00	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
439	2025-01-14	-7.2051	EUR	12351.19	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
440	2025-01-08	-3.9248	EUR	12742.51	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
441	2025-01-08	-6.7654	EUR	12735.75	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
442	2025-01-06	-4.1944	EUR	12806.61	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
443	2025-01-30	-20.8916	EUR	13545.94	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
444	2025-01-14	-38.7025	EUR	12312.48	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
445	2025-01-08	-40.6226	EUR	12695.12	Consultatie huisarts	\N	BE76 7340 1234 5678	38	\N	20	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
446	2025-01-07	-60.1711	EUR	12746.44	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
447	2025-02-25	3508.0000	EUR	16325.53	Loon februari 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
448	2025-02-05	1434.0000	EUR	13927.68	Loon partner februari 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
449	2025-02-28	-1100.0000	EUR	14383.84	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
450	2025-02-28	1100.0000	EUR	23506.19	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
451	2025-02-03	-932.4795	EUR	12579.11	Hypotheek aflossing februari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
452	2025-02-10	-112.0335	EUR	13431.39	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
453	2025-02-15	-60.6746	EUR	13113.50	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
454	2025-02-12	-54.0000	EUR	13373.73	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
455	2025-02-12	-22.0000	EUR	13351.73	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
456	2025-02-06	-45.0000	EUR	13862.70	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
457	2025-02-06	-38.0000	EUR	13824.70	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
458	2025-02-18	-13.9900	EUR	12952.53	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
459	2025-02-05	-10.9900	EUR	13916.69	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
460	2025-02-05	-8.9900	EUR	13907.70	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
461	2025-02-02	-29.9900	EUR	13511.59	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
462	2025-02-03	-49.0000	EUR	12530.11	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
463	2025-02-27	-750.0000	EUR	15533.64	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
464	2025-02-16	-115.3774	EUR	12998.12	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
465	2025-02-21	-124.7812	EUR	12827.75	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
466	2025-02-08	-47.0057	EUR	13659.24	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
467	2025-02-14	-101.3634	EUR	13179.27	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
468	2025-02-09	-95.3304	EUR	13547.89	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
469	2025-02-13	-71.1015	EUR	13280.63	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
470	2025-02-27	-49.8015	EUR	15483.84	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
471	2025-02-07	-75.9092	EUR	13706.24	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
472	2025-02-26	-41.8862	EUR	16283.64	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
473	2025-02-01	-4.3628	EUR	13541.58	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
474	2025-02-09	-4.4691	EUR	13543.42	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
475	2025-02-21	-4.0969	EUR	12823.65	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
476	2025-02-24	-6.1232	EUR	12817.53	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
477	2025-02-14	-5.0935	EUR	13174.18	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
478	2025-02-16	-31.6038	EUR	12966.52	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
479	2025-02-08	-16.0178	EUR	13643.22	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
480	2025-02-04	-36.4220	EUR	12493.68	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
481	2025-02-06	-42.5532	EUR	13782.15	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
482	2025-02-11	-3.6512	EUR	13427.73	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
483	2025-03-25	3490.0000	EUR	16609.61	Loon maart 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
484	2025-03-05	1440.0000	EUR	14578.73	Loon partner maart 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
485	2025-03-28	-1100.0000	EUR	14676.08	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
486	2025-03-28	1100.0000	EUR	24606.19	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
487	2025-03-03	-932.4795	EUR	13421.37	Hypotheek aflossing maart	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
488	2025-03-08	-95.2326	EUR	14064.32	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
489	2025-03-12	-54.0000	EUR	13502.68	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
490	2025-03-12	-22.0000	EUR	13480.68	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
491	2025-03-06	-45.0000	EUR	14389.02	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
492	2025-03-06	-38.0000	EUR	14351.02	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
493	2025-03-18	-13.9900	EUR	13217.79	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
494	2025-03-05	-10.9900	EUR	14567.74	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
495	2025-03-05	-8.9900	EUR	14558.75	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
496	2025-03-02	-29.9900	EUR	14353.85	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
497	2025-03-03	-49.0000	EUR	13372.37	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
498	2025-03-27	-750.0000	EUR	15776.08	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
499	2025-03-07	-93.1857	EUR	14257.84	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
500	2025-03-05	-124.7274	EUR	14434.02	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
501	2025-03-03	-119.9115	EUR	13252.46	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
502	2025-03-07	-57.1094	EUR	14200.73	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
503	2025-03-03	-109.9045	EUR	13142.56	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
504	2025-03-26	-83.5345	EUR	16526.08	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
505	2025-03-14	-61.9767	EUR	13412.58	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
506	2025-03-23	-43.3865	EUR	13119.61	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
507	2025-03-18	-54.7936	EUR	13163.00	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
508	2025-03-10	-3.9944	EUR	14060.32	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
509	2025-03-12	-6.1201	EUR	13474.56	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
510	2025-03-07	-5.2688	EUR	14195.46	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
511	2025-03-03	-3.8240	EUR	13138.73	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
512	2025-03-11	-39.9685	EUR	14020.35	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
513	2025-03-17	-26.9515	EUR	13231.78	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
514	2025-03-14	-153.8489	EUR	13258.73	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
515	2025-03-11	-463.6756	EUR	13556.68	Electronica	\N	BE76 7340 1234 5678	42	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
516	2025-03-07	-35.9112	EUR	14159.55	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
517	2025-03-31	-6.8321	EUR	14669.24	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
518	2025-04-25	3498.0000	EUR	17763.61	Loon april 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
519	2025-04-05	1432.0000	EUR	14957.53	Loon partner april 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
520	2025-04-02	16.3031	EUR	24622.49	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
521	2025-04-28	-1100.0000	EUR	15853.81	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
522	2025-04-28	1100.0000	EUR	25722.49	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
523	2025-04-03	-932.4795	EUR	13702.50	Hypotheek aflossing april	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
524	2025-04-10	-112.8322	EUR	14676.45	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
525	2025-04-12	-54.0000	EUR	14622.45	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
526	2025-04-12	-22.0000	EUR	14600.45	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
527	2025-04-06	-45.0000	EUR	14864.25	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
528	2025-04-06	-38.0000	EUR	14826.25	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
529	2025-04-18	-13.9900	EUR	14385.68	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
530	2025-04-05	-10.9900	EUR	14946.54	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
531	2025-04-05	-8.9900	EUR	14937.55	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
532	2025-04-02	-29.9900	EUR	14639.25	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
533	2025-04-03	-49.0000	EUR	13653.50	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
534	2025-04-27	-750.0000	EUR	16953.81	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
535	2025-04-04	-54.6200	EUR	13592.60	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
536	2025-04-14	-58.0732	EUR	14542.38	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
537	2025-04-07	-36.9660	EUR	14789.28	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
538	2025-04-16	-71.2411	EUR	14406.95	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
539	2025-04-14	-64.1917	EUR	14478.19	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
540	2025-04-04	-67.0668	EUR	13525.53	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
541	2025-04-22	-94.3016	EUR	14265.61	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
542	2025-04-05	-28.2978	EUR	14909.25	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
543	2025-04-26	-53.6950	EUR	17709.92	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
544	2025-04-19	-7.4936	EUR	14378.19	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
545	2025-04-03	-6.2845	EUR	13647.22	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
546	2025-04-16	-7.2717	EUR	14399.67	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
547	2025-04-28	-4.6306	EUR	15849.18	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
548	2025-04-02	-4.2753	EUR	14634.98	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
549	2025-04-26	-6.1096	EUR	17703.81	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
550	2025-04-19	-18.2750	EUR	14359.92	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
551	2025-04-28	-20.3268	EUR	15828.85	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
552	2025-05-25	3513.0000	EUR	18435.59	Loon mei 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
553	2025-05-05	1457.0000	EUR	16218.45	Loon partner mei 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
554	2025-05-28	-1100.0000	EUR	16505.33	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
555	2025-05-28	1100.0000	EUR	26822.49	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
556	2025-05-03	-932.4795	EUR	14823.06	Hypotheek aflossing mei	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
557	2025-05-09	-132.9070	EUR	15876.04	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
558	2025-05-15	-63.0172	EUR	15433.36	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
559	2025-05-12	-54.0000	EUR	15523.53	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
560	2025-05-12	-22.0000	EUR	15501.53	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
561	2025-05-06	-45.0000	EUR	16046.95	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
562	2025-05-06	-38.0000	EUR	16008.95	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
563	2025-05-18	-13.9900	EUR	15213.48	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
564	2025-05-05	-10.9900	EUR	16207.46	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
565	2025-05-05	-8.9900	EUR	16198.47	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
566	2025-05-02	-29.9900	EUR	15798.86	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
567	2025-05-03	-49.0000	EUR	14774.06	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
568	2025-05-27	-27.2928	EUR	18355.33	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
569	2025-05-27	-750.0000	EUR	17605.33	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
570	2025-05-15	-96.2305	EUR	15337.13	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
571	2025-05-18	-121.3832	EUR	15092.09	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
572	2025-05-17	-75.1604	EUR	15227.47	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
573	2025-05-05	-106.5251	EUR	16091.95	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
574	2025-05-18	-93.2113	EUR	14998.88	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
575	2025-05-09	-76.5791	EUR	15799.46	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
576	2025-05-02	-43.3246	EUR	15755.54	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
577	2025-05-25	-52.9673	EUR	18382.62	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
578	2025-05-19	-6.6015	EUR	14992.28	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
579	2025-05-24	-3.5717	EUR	14922.59	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
580	2025-05-15	-6.0880	EUR	15331.05	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
581	2025-05-14	-5.1439	EUR	15496.38	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
582	2025-05-22	-35.3279	EUR	14926.16	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
583	2025-05-19	-30.7901	EUR	14961.49	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
584	2025-05-15	-28.4209	EUR	15302.63	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
585	2025-05-09	-87.5830	EUR	15711.88	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
586	2025-05-09	-134.3546	EUR	15577.53	Kleding	\N	BE76 7340 1234 5678	44	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
587	2025-05-04	-12.6039	EUR	14761.45	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
588	2025-06-25	3494.0000	EUR	19001.27	Loon juni 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
589	2025-06-05	1441.0000	EUR	16775.19	Loon partner juni 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
590	2025-06-28	-1100.0000	EUR	17151.27	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
591	2025-06-28	1100.0000	EUR	27922.49	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
592	2025-06-03	-932.4795	EUR	15542.86	Hypotheek aflossing juni	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
593	2025-06-08	-134.0192	EUR	16538.20	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
594	2025-06-12	-54.0000	EUR	16454.49	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
595	2025-06-12	-22.0000	EUR	16432.49	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
596	2025-06-06	-45.0000	EUR	16710.21	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
597	2025-06-06	-38.0000	EUR	16672.21	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
598	2025-06-18	-13.9900	EUR	16245.97	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
599	2025-06-05	-10.9900	EUR	16764.20	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
600	2025-06-05	-8.9900	EUR	16755.21	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
601	2025-06-02	-29.9900	EUR	16475.34	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
602	2025-06-03	-49.0000	EUR	15493.86	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
603	2025-06-27	-750.0000	EUR	18251.27	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
604	2025-06-03	-100.9903	EUR	15392.87	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
605	2025-06-16	-60.3723	EUR	16263.56	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
606	2025-06-04	-58.6749	EUR	15334.19	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
607	2025-06-18	-68.5823	EUR	16177.39	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
608	2025-06-29	-48.5821	EUR	16636.15	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
609	2025-06-23	-81.4279	EUR	15511.23	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
610	2025-06-08	-29.7027	EUR	16508.49	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
611	2025-06-12	-60.6071	EUR	16371.89	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
612	2025-06-21	-4.7223	EUR	15618.87	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
613	2025-06-13	-7.4147	EUR	16323.94	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
614	2025-06-23	-3.9622	EUR	15507.27	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
615	2025-06-16	-3.6007	EUR	16259.96	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
616	2025-06-30	-31.5068	EUR	16604.65	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
617	2025-06-12	-40.5347	EUR	16331.35	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
618	2025-06-18	-553.8011	EUR	15623.59	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
619	2025-06-22	-26.2096	EUR	15592.66	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
620	2025-06-28	-466.5334	EUR	16684.73	Reis / vakantie	\N	BE76 7340 1234 5678	47	\N	25	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
621	2025-06-30	517.5312	EUR	17122.18	Belastingteruggave	\N	BE76 7340 1234 5678	18	\N	3	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
622	2025-07-25	3502.0000	EUR	19922.76	Loon juli 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
623	2025-07-05	1451.0000	EUR	17260.42	Loon partner juli 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
624	2025-07-02	14.6287	EUR	27937.12	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
625	2025-07-28	-1100.0000	EUR	17976.22	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
626	2025-07-28	1100.0000	EUR	29037.12	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
627	2025-07-03	-932.4795	EUR	15894.86	Hypotheek aflossing juli	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
628	2025-07-09	-121.3960	EUR	16847.26	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
629	2025-07-12	-54.0000	EUR	16793.26	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
630	2025-07-12	-22.0000	EUR	16771.26	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
631	2025-07-06	-45.0000	EUR	17006.65	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
632	2025-07-06	-38.0000	EUR	16968.65	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
633	2025-07-18	-13.9900	EUR	16532.71	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
634	2025-07-05	-10.9900	EUR	17249.43	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
635	2025-07-05	-8.9900	EUR	17240.44	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
636	2025-07-02	-29.9900	EUR	17092.19	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
637	2025-07-03	-49.0000	EUR	15845.86	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
638	2025-07-27	-750.0000	EUR	19076.22	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
639	2025-07-19	-49.4205	EUR	16425.50	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
640	2025-07-05	-120.0334	EUR	17120.41	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
641	2025-07-14	-90.0806	EUR	16681.18	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
642	2025-07-26	-87.3143	EUR	19835.44	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
643	2025-07-15	-58.2281	EUR	16622.95	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
644	2025-07-18	-54.1654	EUR	16478.55	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
645	2025-07-29	-62.8526	EUR	17913.37	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
646	2025-07-17	-70.4718	EUR	16546.70	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
647	2025-07-05	-68.7583	EUR	17051.65	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
648	2025-07-18	-3.6238	EUR	16474.93	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
649	2025-07-16	-5.7719	EUR	16617.18	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
650	2025-07-23	-4.7460	EUR	16420.76	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
651	2025-07-03	-36.4382	EUR	15809.42	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
652	2025-07-26	-9.2246	EUR	19826.22	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
653	2025-07-02	-264.8443	EUR	16827.34	Reis / vakantie	\N	BE76 7340 1234 5678	47	\N	25	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
654	2025-08-25	3513.0000	EUR	21251.62	Loon augustus 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
655	2025-08-05	1436.0000	EUR	18228.42	Loon partner augustus 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
656	2025-08-15	463.6951	EUR	17962.26	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
657	2025-08-28	-1100.0000	EUR	19392.96	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
658	2025-08-28	1100.0000	EUR	30137.12	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
659	2025-08-03	-932.4795	EUR	16950.90	Hypotheek aflossing augustus	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
660	2025-08-08	-138.5930	EUR	17978.54	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
661	2025-08-15	-58.6284	EUR	17903.63	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
662	2025-08-12	-54.0000	EUR	17681.66	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
663	2025-08-12	-22.0000	EUR	17659.66	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
664	2025-08-06	-45.0000	EUR	18163.44	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
665	2025-08-06	-38.0000	EUR	18125.44	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
666	2025-08-18	-13.9900	EUR	17741.96	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
667	2025-08-05	-10.9900	EUR	18217.43	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
668	2025-08-05	-8.9900	EUR	18208.44	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
669	2025-08-02	-29.9900	EUR	17883.38	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
670	2025-08-03	-49.0000	EUR	16901.90	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
671	2025-08-27	-750.0000	EUR	20501.62	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
672	2025-08-30	-58.5612	EUR	19286.07	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
673	2025-08-13	-117.7317	EUR	17541.93	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
674	2025-08-03	-109.4744	EUR	16792.42	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
675	2025-08-13	-43.3630	EUR	17498.56	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
676	2025-08-10	-108.6248	EUR	17735.66	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
677	2025-08-09	-61.7653	EUR	17873.48	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
678	2025-08-16	-56.0098	EUR	17755.95	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
679	2025-08-28	-48.3264	EUR	19344.63	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
680	2025-08-15	-91.6754	EUR	17811.95	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
681	2025-08-22	-3.3375	EUR	17738.62	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
682	2025-08-07	-3.4986	EUR	18121.94	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
683	2025-08-07	-4.8127	EUR	18117.13	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
684	2025-08-31	-5.1840	EUR	19275.44	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
685	2025-08-30	-5.4499	EUR	19280.62	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
686	2025-08-09	-29.2014	EUR	17844.28	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
687	2025-08-08	-43.2889	EUR	17935.25	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
688	2025-08-27	-8.6581	EUR	20492.96	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
689	2025-08-31	-14.0310	EUR	19261.41	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
690	2025-09-25	3499.0000	EUR	22324.35	Loon september 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
691	2025-09-05	1431.0000	EUR	19430.55	Loon partner september 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
692	2025-09-28	-1100.0000	EUR	20399.89	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
693	2025-09-28	1100.0000	EUR	31237.12	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
694	2025-09-03	-932.4795	EUR	18116.22	Hypotheek aflossing september	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
695	2025-09-11	-90.6374	EUR	19162.79	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
696	2025-09-12	-54.0000	EUR	19108.79	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
697	2025-09-12	-22.0000	EUR	19086.79	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
698	2025-09-06	-45.0000	EUR	19296.58	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
699	2025-09-06	-38.0000	EUR	19258.58	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
700	2025-09-18	-13.9900	EUR	19059.61	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
701	2025-09-05	-10.9900	EUR	19419.56	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
702	2025-09-05	-8.9900	EUR	19410.57	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
703	2025-09-02	-29.9900	EUR	19186.18	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
704	2025-09-03	-49.0000	EUR	18067.22	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
705	2025-09-27	-750.0000	EUR	21574.35	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
706	2025-09-03	-67.6740	EUR	17999.55	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
707	2025-09-02	-36.3506	EUR	19149.83	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
708	2025-09-05	-68.9845	EUR	19341.58	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
709	2025-09-21	-88.7001	EUR	18938.63	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
710	2025-09-02	-101.1289	EUR	19048.70	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
711	2025-09-27	-74.4557	EUR	21499.89	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
712	2025-09-21	-78.5726	EUR	18860.06	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
713	2025-09-01	-45.2377	EUR	19216.17	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
714	2025-09-08	-5.1574	EUR	19253.42	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
715	2025-09-14	-3.2765	EUR	19080.14	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
716	2025-09-21	-7.3054	EUR	18852.75	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
717	2025-09-13	-3.3680	EUR	19083.42	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
718	2025-09-16	-6.5380	EUR	19073.60	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
719	2025-09-19	-32.2847	EUR	19027.33	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
720	2025-09-23	-27.4066	EUR	18825.35	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
721	2025-10-25	3508.0000	EUR	23055.28	Loon oktober 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
722	2025-10-05	1455.0000	EUR	20761.99	Loon partner oktober 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
723	2025-10-20	751.9837	EUR	19811.51	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
724	2025-10-02	13.2866	EUR	31250.40	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
725	2025-10-28	-1100.0000	EUR	21159.64	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
726	2025-10-28	1100.0000	EUR	32350.40	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
727	2025-10-03	-932.4795	EUR	19433.01	Hypotheek aflossing oktober	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
728	2025-10-11	-93.7301	EUR	20351.12	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
729	2025-10-12	-54.0000	EUR	20297.12	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
730	2025-10-12	-22.0000	EUR	20275.12	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
731	2025-10-06	-45.0000	EUR	20617.57	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
732	2025-10-06	-38.0000	EUR	20579.57	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
733	2025-10-18	-13.9900	EUR	19059.52	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
734	2025-10-05	-10.9900	EUR	20751.00	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
735	2025-10-05	-8.9900	EUR	20742.01	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
736	2025-10-02	-29.9900	EUR	20369.90	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
737	2025-10-03	-49.0000	EUR	19384.01	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
738	2025-10-27	-750.0000	EUR	22305.28	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
739	2025-10-22	-34.0731	EUR	19672.94	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
740	2025-10-08	-45.4796	EUR	20534.09	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
741	2025-10-17	-51.9130	EUR	19073.51	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
742	2025-10-20	-47.6650	EUR	19763.84	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
743	2025-10-23	-61.2451	EUR	19611.69	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
744	2025-10-08	-64.0111	EUR	20470.08	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
745	2025-10-21	-56.8324	EUR	19707.01	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
746	2025-10-24	-29.2901	EUR	19547.28	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
747	2025-10-23	-35.1162	EUR	19576.57	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
748	2025-10-05	-66.6138	EUR	20675.40	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
749	2025-10-05	-7.4007	EUR	20668.00	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
750	2025-10-05	-5.4294	EUR	20662.57	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
751	2025-10-02	-4.4126	EUR	20365.49	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
752	2025-10-14	-5.3325	EUR	20269.79	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
753	2025-10-27	-37.9488	EUR	22267.34	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
754	2025-10-03	-24.7817	EUR	19359.23	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
755	2025-10-08	-25.2257	EUR	20444.85	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
756	2025-10-27	-7.6945	EUR	22259.64	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
757	2025-10-04	-52.2323	EUR	19306.99	Hobby	\N	BE76 7340 1234 5678	48	\N	24	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
758	2025-10-15	-1144.3652	EUR	19125.43	Personenbelasting afrekening	\N	BE76 7340 1234 5678	18	\N	32	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
759	2025-11-25	3493.0000	EUR	23654.68	Loon november 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
760	2025-11-05	1443.0000	EUR	21511.61	Loon partner november 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
761	2025-11-28	-1100.0000	EUR	21690.85	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
762	2025-11-28	1100.0000	EUR	33450.40	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
763	2025-11-03	-932.4795	EUR	20125.75	Hypotheek aflossing november	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
764	2025-11-08	-106.1839	EUR	21206.98	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
765	2025-11-15	-42.9410	EUR	20460.19	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
766	2025-11-12	-54.0000	EUR	20641.26	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
767	2025-11-12	-22.0000	EUR	20619.26	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
768	2025-11-06	-45.0000	EUR	21423.87	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
769	2025-11-06	-38.0000	EUR	21385.87	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
770	2025-11-18	-13.9900	EUR	20398.73	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
771	2025-11-05	-10.9900	EUR	21500.62	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
772	2025-11-05	-8.9900	EUR	21491.63	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
773	2025-11-02	-29.9900	EUR	21129.65	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
774	2025-11-03	-49.0000	EUR	20076.75	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
775	2025-11-27	-750.0000	EUR	22790.85	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
776	2025-11-14	-112.8624	EUR	20503.13	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
777	2025-11-30	-102.8426	EUR	21390.81	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
778	2025-11-29	-109.6790	EUR	21564.52	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
779	2025-11-24	-47.0896	EUR	20161.68	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
780	2025-11-25	-113.8366	EUR	23540.85	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
781	2025-11-07	-72.7031	EUR	21313.16	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
782	2025-11-23	-81.6091	EUR	20208.77	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
783	2025-11-02	-71.4222	EUR	21058.23	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
784	2025-11-21	-94.6604	EUR	20299.84	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
785	2025-11-19	-4.2267	EUR	20394.50	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
786	2025-11-22	-4.7055	EUR	20295.14	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
787	2025-11-22	-4.7542	EUR	20290.38	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
788	2025-11-13	-3.2620	EUR	20615.99	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
789	2025-11-17	-6.9152	EUR	20412.72	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
790	2025-11-08	-26.9154	EUR	21180.07	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
791	2025-11-15	-40.5555	EUR	20419.63	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
792	2025-11-29	-70.8736	EUR	21493.65	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
793	2025-11-08	-484.8099	EUR	20695.26	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
794	2025-11-05	-22.7586	EUR	21468.87	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
795	2025-11-04	-8.1431	EUR	20068.61	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
796	2025-11-28	-16.6451	EUR	21674.20	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
797	2025-12-25	3513.0000	EUR	25210.89	Loon december 2025	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
798	2025-12-05	1457.0000	EUR	21469.28	Loon partner december 2025	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
799	2025-12-20	1500.0000	EUR	21710.57	Eindejaarsbonus 2025	\N	BE76 7340 1234 5678	1	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
800	2025-12-28	-1100.0000	EUR	23181.52	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
801	2025-12-28	1100.0000	EUR	34550.40	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
802	2025-12-03	-932.4795	EUR	20061.28	Hypotheek aflossing december	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
803	2025-12-09	-139.7368	EUR	20986.29	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
804	2025-12-12	-54.0000	EUR	20890.67	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
805	2025-12-12	-22.0000	EUR	20868.67	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
806	2025-12-06	-45.0000	EUR	21342.08	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
807	2025-12-06	-38.0000	EUR	21304.08	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
808	2025-12-18	-13.9900	EUR	20360.29	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
809	2025-12-05	-10.9900	EUR	21458.29	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
810	2025-12-05	-8.9900	EUR	21449.30	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
811	2025-12-02	-29.9900	EUR	21021.95	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
812	2025-12-03	-49.0000	EUR	20012.28	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
813	2025-12-27	-750.0000	EUR	24281.52	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
814	2025-12-25	-104.6095	EUR	25106.28	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
815	2025-12-08	-51.8484	EUR	21252.23	Boodschappen	\N	BE76 7340 1234 5678	24	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
816	2025-12-05	-62.2151	EUR	21387.08	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
817	2025-12-01	-47.7805	EUR	21343.03	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
818	2025-12-18	-77.1983	EUR	20283.09	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
819	2025-12-29	-54.7517	EUR	23126.77	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
820	2025-12-18	-72.5281	EUR	20210.57	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
821	2025-12-26	-74.7625	EUR	25031.52	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
822	2025-12-02	-28.1978	EUR	20993.75	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
823	2025-12-08	-70.2838	EUR	21181.95	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
824	2025-12-09	-41.6244	EUR	20944.67	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
825	2025-12-22	-4.2213	EUR	21697.89	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
826	2025-12-12	-4.5568	EUR	20864.11	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
827	2025-12-31	-5.5933	EUR	23086.81	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
828	2025-12-08	-25.1500	EUR	21156.80	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
829	2025-12-08	-30.7692	EUR	21126.03	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
830	2025-12-01	-291.0836	EUR	21051.94	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
831	2025-12-16	-402.3938	EUR	20408.57	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
832	2025-12-30	-34.3623	EUR	23092.41	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
833	2025-12-21	-8.4510	EUR	21702.12	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
834	2025-12-17	-34.2896	EUR	20374.28	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
835	2025-12-14	-53.1445	EUR	20810.97	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
836	2026-01-25	3611.0000	EUR	26263.24	Loon januari 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
837	2026-01-05	1496.0000	EUR	23405.36	Loon partner januari 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
838	2026-01-02	25.4605	EUR	34575.86	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
839	2026-01-28	-1100.0000	EUR	24413.24	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
840	2026-01-28	1100.0000	EUR	35675.86	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
841	2026-01-03	-932.4795	EUR	22124.34	Hypotheek aflossing januari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
842	2026-01-11	-105.7967	EUR	23170.12	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
843	2026-01-12	-54.0000	EUR	23112.46	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
844	2026-01-12	-22.0000	EUR	23090.46	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
845	2026-01-06	-45.0000	EUR	23340.38	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
846	2026-01-06	-38.0000	EUR	23302.38	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
847	2026-01-18	-13.9900	EUR	22958.10	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
848	2026-01-05	-10.9900	EUR	23394.37	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
849	2026-01-05	-8.9900	EUR	23385.38	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
850	2026-01-02	-29.9900	EUR	23056.82	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
851	2026-01-03	-49.0000	EUR	22075.34	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
852	2026-01-22	-44.3448	EUR	22816.79	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
853	2026-01-27	-750.0000	EUR	25513.24	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
854	2026-01-03	-87.7979	EUR	21987.55	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
855	2026-01-22	-100.1718	EUR	22716.62	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
856	2026-01-30	-90.3522	EUR	24322.89	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
857	2026-01-16	-43.0256	EUR	22986.27	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
858	2026-01-23	-64.3790	EUR	22652.24	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
859	2026-01-30	-29.2910	EUR	24293.60	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
860	2026-01-03	-55.4768	EUR	21932.07	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
861	2026-01-15	-61.1675	EUR	23029.29	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
862	2026-01-20	-93.5080	EUR	22861.13	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
863	2026-01-11	-3.6610	EUR	23166.46	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
864	2026-01-08	-6.4520	EUR	23275.92	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
865	2026-01-18	-3.4605	EUR	22954.64	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
866	2026-01-07	-20.0118	EUR	23282.37	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
867	2026-01-17	-14.1761	EUR	22972.09	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
868	2026-01-03	-22.7071	EUR	21909.36	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
869	2026-02-25	3592.0000	EUR	27273.58	Loon februari 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
870	2026-02-05	1474.0000	EUR	24713.26	Loon partner februari 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
871	2026-02-28	-1100.0000	EUR	25264.22	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
872	2026-02-28	1100.0000	EUR	36775.86	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
873	2026-02-03	-932.4795	EUR	23325.23	Hypotheek aflossing februari	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
874	2026-02-09	-144.1475	EUR	24146.65	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
875	2026-02-15	-63.1131	EUR	23986.33	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
876	2026-02-12	-54.0000	EUR	24071.44	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
877	2026-02-12	-22.0000	EUR	24049.44	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
878	2026-02-06	-45.0000	EUR	24648.28	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
879	2026-02-06	-38.0000	EUR	24610.28	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
880	2026-02-18	-13.9900	EUR	23875.36	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
881	2026-02-05	-10.9900	EUR	24702.27	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
882	2026-02-05	-8.9900	EUR	24693.28	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
883	2026-02-02	-29.9900	EUR	24257.71	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
884	2026-02-03	-49.0000	EUR	23276.23	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
885	2026-02-11	-15.6967	EUR	24125.44	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
886	2026-02-27	-750.0000	EUR	26523.58	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
887	2026-02-19	-83.0046	EUR	23792.36	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
888	2026-02-27	-115.1598	EUR	26408.42	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
889	2026-02-15	-90.5217	EUR	23895.81	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
890	2026-02-07	-52.1534	EUR	24500.99	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
891	2026-02-21	-73.6264	EUR	23718.73	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
892	2026-02-27	-44.1998	EUR	26364.22	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
893	2026-02-06	-57.1403	EUR	24553.14	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
894	2026-02-01	-5.8958	EUR	24287.70	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
895	2026-02-09	-5.5107	EUR	24141.14	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
896	2026-02-16	-6.4538	EUR	23889.35	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
897	2026-02-24	-37.1537	EUR	23681.58	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
898	2026-02-03	-36.9660	EUR	23239.26	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
899	2026-02-08	-210.1941	EUR	24290.80	Woninginrichting	\N	BE76 7340 1234 5678	45	\N	28	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
900	2026-03-25	3617.0000	EUR	28893.98	Loon maart 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
901	2026-03-05	1494.0000	EUR	25554.72	Loon partner maart 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
902	2026-03-16	641.8209	EUR	25552.72	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
903	2026-03-28	-1100.0000	EUR	27007.84	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
904	2026-03-28	1100.0000	EUR	37875.86	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
905	2026-03-03	-932.4795	EUR	24109.72	Hypotheek aflossing maart	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
906	2026-03-09	-97.2089	EUR	25208.45	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
907	2026-03-12	-54.0000	EUR	25074.01	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
908	2026-03-12	-22.0000	EUR	25052.01	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
909	2026-03-06	-45.0000	EUR	25489.74	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
910	2026-03-06	-38.0000	EUR	25451.74	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
911	2026-03-18	-13.9900	EUR	25462.96	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
912	2026-03-05	-10.9900	EUR	25543.73	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
913	2026-03-05	-8.9900	EUR	25534.74	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
914	2026-03-02	-29.9900	EUR	25123.58	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
915	2026-03-03	-49.0000	EUR	24060.72	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
916	2026-03-23	-27.8307	EUR	25288.96	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
917	2026-03-27	-750.0000	EUR	28107.84	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
918	2026-03-22	-52.0257	EUR	25316.79	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
919	2026-03-30	-61.6948	EUR	26946.15	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
920	2026-03-12	-113.8674	EUR	24938.14	Boodschappen	\N	BE76 7340 1234 5678	25	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
921	2026-03-21	-37.3150	EUR	25425.64	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
922	2026-03-21	-56.8251	EUR	25368.82	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
923	2026-03-01	-80.5177	EUR	25183.70	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
924	2026-03-08	-41.5721	EUR	25362.58	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
925	2026-03-09	-38.3741	EUR	25170.08	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
926	2026-03-02	-81.3830	EUR	25042.20	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
927	2026-03-08	-56.9158	EUR	25305.66	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
928	2026-03-23	-7.3613	EUR	25281.60	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
929	2026-03-23	-4.6233	EUR	25276.98	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
930	2026-03-09	-3.2939	EUR	25166.79	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
931	2026-03-30	-6.6447	EUR	26939.50	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
932	2026-03-26	-3.5103	EUR	28857.84	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
933	2026-03-11	-38.7730	EUR	25128.01	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
934	2026-03-01	-19.8634	EUR	25163.84	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
935	2026-03-25	-32.6234	EUR	28861.35	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
936	2026-03-16	-75.7750	EUR	25476.95	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
937	2026-03-14	-27.2426	EUR	24910.90	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
938	2026-03-07	-47.5911	EUR	25404.15	Consultatie huisarts	\N	BE76 7340 1234 5678	38	\N	20	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
939	2026-03-01	-10.2633	EUR	25153.57	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
940	2026-04-25	3618.0000	EUR	29759.15	Loon april 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
941	2026-04-05	1488.0000	EUR	27084.77	Loon partner april 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
942	2026-04-02	21.7840	EUR	37897.65	Rente spaarrekening	\N	BE12 0688 1947 5532	17	\N	4	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
943	2026-04-28	-1100.0000	EUR	27895.97	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
944	2026-04-28	1100.0000	EUR	38997.65	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
945	2026-04-03	-932.4795	EUR	25936.57	Hypotheek aflossing april	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
946	2026-04-08	-125.7493	EUR	26754.83	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
947	2026-04-12	-54.0000	EUR	26488.80	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
948	2026-04-12	-22.0000	EUR	26466.80	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
949	2026-04-06	-45.0000	EUR	27019.79	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
950	2026-04-06	-38.0000	EUR	26981.79	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
951	2026-04-18	-13.9900	EUR	26356.34	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
952	2026-04-05	-10.9900	EUR	27073.78	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
953	2026-04-05	-8.9900	EUR	27064.79	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
954	2026-04-02	-29.9900	EUR	26909.51	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
955	2026-04-03	-49.0000	EUR	25887.57	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
956	2026-04-16	-17.9928	EUR	26370.33	Treinticket	\N	BE76 7340 1234 5678	15	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
957	2026-04-27	-750.0000	EUR	29000.06	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
958	2026-04-19	-104.4068	EUR	26251.94	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
959	2026-04-03	-122.0560	EUR	25765.52	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
960	2026-04-08	-101.2731	EUR	26653.56	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
961	2026-04-02	-36.3912	EUR	26873.12	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
962	2026-04-07	-66.1720	EUR	26915.61	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
963	2026-04-09	-55.5587	EUR	26542.80	Tankbeurt	\N	BE76 7340 1234 5678	29	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
964	2026-04-12	-32.4716	EUR	26434.33	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
965	2026-04-21	-54.8567	EUR	26168.77	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
966	2026-04-02	-4.0701	EUR	26869.05	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
967	2026-04-25	-5.7557	EUR	29753.39	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
968	2026-04-19	-6.9075	EUR	26245.03	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
969	2026-04-12	-7.4842	EUR	26426.84	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
970	2026-04-27	-4.0912	EUR	28995.97	Koffie	\N	BE76 7340 1234 5678	33	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
971	2026-04-25	-3.3306	EUR	29750.06	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
972	2026-04-20	-21.3983	EUR	26223.63	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
973	2026-04-12	-38.5166	EUR	26388.33	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
974	2026-04-07	-35.0316	EUR	26880.58	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
975	2026-04-03	-168.7508	EUR	25596.77	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
976	2026-04-30	-368.2721	EUR	27527.70	Electronica	\N	BE76 7340 1234 5678	40	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
977	2026-04-08	-55.2038	EUR	26598.36	Hobby	\N	BE76 7340 1234 5678	49	\N	24	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
978	2026-04-22	-27.6230	EUR	26141.15	Onbekende betaling	\N	BE76 7340 1234 5678	20	\N	\N	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
979	2026-05-25	3618.0000	EUR	31147.14	Loon mei 2026	\N	BE76 7340 1234 5678	1	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
980	2026-05-05	1476.0000	EUR	27923.03	Loon partner mei 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
981	2026-05-10	359.4717	EUR	27965.42	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
982	2026-05-28	-1100.0000	EUR	29230.61	Overschrijving naar spaarrekening	\N	BE76 7340 1234 5678	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
983	2026-05-28	1100.0000	EUR	40097.65	Storting van zichtrekening	\N	BE12 0688 1947 5532	19	\N	29	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
984	2026-05-03	-932.4795	EUR	26565.23	Hypotheek aflossing mei	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
985	2026-05-08	-129.4922	EUR	27609.96	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
986	2026-05-15	-65.5589	EUR	27630.31	Waterfactuur	\N	BE76 7340 1234 5678	5	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
987	2026-05-12	-54.0000	EUR	27739.72	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
988	2026-05-12	-22.0000	EUR	27717.72	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
989	2026-05-06	-45.0000	EUR	27858.05	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
990	2026-05-06	-38.0000	EUR	27820.05	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
991	2026-05-18	-13.9900	EUR	27611.50	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
992	2026-05-05	-10.9900	EUR	27912.04	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
993	2026-05-05	-8.9900	EUR	27903.05	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
994	2026-05-02	-29.9900	EUR	27497.71	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
995	2026-05-03	-49.0000	EUR	26516.23	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
996	2026-05-27	-750.0000	EUR	30330.61	Belegging storting	\N	BE76 7340 1234 5678	16	\N	30	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
997	2026-05-18	-38.7290	EUR	27572.77	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
998	2026-05-11	-100.7704	EUR	27824.73	Boodschappen	\N	BE76 7340 1234 5678	21	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
999	2026-05-10	-39.9229	EUR	27925.50	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1000	2026-05-07	-69.2848	EUR	27739.45	Boodschappen	\N	BE76 7340 1234 5678	26	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1001	2026-05-03	-69.2014	EUR	26447.03	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1002	2026-05-26	-61.9286	EUR	31085.21	Tankbeurt	\N	BE76 7340 1234 5678	27	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1003	2026-05-11	-26.4074	EUR	27798.32	Restaurant	\N	BE76 7340 1234 5678	32	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1004	2026-05-24	-37.5499	EUR	27529.14	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1005	2026-05-08	-4.0036	EUR	27605.95	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1006	2026-05-17	-4.8138	EUR	27625.49	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1007	2026-05-11	-4.6002	EUR	27793.72	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1008	2026-05-26	-4.5979	EUR	31080.61	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1009	2026-05-29	-32.3843	EUR	29198.23	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1010	2026-05-12	-21.8577	EUR	27695.86	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1011	2026-05-30	-41.0042	EUR	29157.23	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1012	2026-05-06	-11.3171	EUR	27808.73	Apotheek	\N	BE76 7340 1234 5678	37	\N	19	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1013	2026-05-20	-6.0824	EUR	27566.69	Parking	\N	BE76 7340 1234 5678	39	\N	18	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1014	2026-06-05	1495.0000	EUR	28667.28	Loon partner juni 2026	\N	BE76 7340 1234 5678	2	\N	1	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1015	2026-06-15	394.3382	EUR	28005.67	Freelance opdracht	\N	BE76 7340 1234 5678	3	\N	2	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1016	2026-06-03	-932.4795	EUR	27503.81	Hypotheek aflossing juni	\N	BE76 7340 1234 5678	53	\N	7	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1017	2026-06-10	-136.3005	EUR	28110.75	Energievoorschot	\N	BE76 7340 1234 5678	4	\N	8	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1018	2026-06-12	-54.0000	EUR	28048.01	Internet + TV	\N	BE76 7340 1234 5678	6	\N	9	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1019	2026-06-12	-22.0000	EUR	28026.01	GSM abonnement	\N	BE76 7340 1234 5678	7	\N	33	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1020	2026-06-06	-45.0000	EUR	28563.31	Brand/familiale verzekering	\N	BE76 7340 1234 5678	12	\N	10	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1021	2026-06-06	-38.0000	EUR	28525.31	Hospitalisatieverzekering	\N	BE76 7340 1234 5678	13	\N	21	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1022	2026-06-18	-13.9900	EUR	27987.82	Netflix abonnement	\N	BE76 7340 1234 5678	8	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1023	2026-06-05	-10.9900	EUR	28656.29	Spotify Premium	\N	BE76 7340 1234 5678	9	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1024	2026-06-05	-8.9900	EUR	28647.30	Disney+ abonnement	\N	BE76 7340 1234 5678	10	\N	22	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1025	2026-06-02	-29.9900	EUR	28436.29	Fitness abonnement	\N	BE76 7340 1234 5678	11	\N	23	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1026	2026-06-03	-49.0000	EUR	27454.81	Buzzy Pazz abonnement	\N	BE76 7340 1234 5678	14	\N	16	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1027	2026-06-05	-38.9828	EUR	28608.31	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1028	2026-06-09	-124.7852	EUR	28264.92	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1029	2026-06-08	-64.9342	EUR	28389.71	Boodschappen	\N	BE76 7340 1234 5678	23	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1030	2026-06-03	-115.1156	EUR	27339.70	Boodschappen	\N	BE76 7340 1234 5678	22	\N	11	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1031	2026-06-06	-70.6739	EUR	28454.64	Tankbeurt	\N	BE76 7340 1234 5678	28	\N	15	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1032	2026-06-04	-53.0481	EUR	27286.65	Restaurant	\N	BE76 7340 1234 5678	30	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1033	2026-06-13	-72.9380	EUR	27953.08	Restaurant	\N	BE76 7340 1234 5678	31	\N	12	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1034	2026-06-16	-3.8595	EUR	28001.81	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1035	2026-06-11	-3.8970	EUR	28102.01	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1036	2026-06-10	-4.8338	EUR	28105.91	Koffie	\N	BE76 7340 1234 5678	34	\N	14	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1037	2026-06-09	-17.8744	EUR	28247.05	Afhaalmaaltijd	\N	BE76 7340 1234 5678	36	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1038	2026-06-01	-15.1727	EUR	29142.05	Afhaalmaaltijd	\N	BE76 7340 1234 5678	35	\N	13	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1039	2026-06-14	-341.7421	EUR	27611.33	Electronica	\N	BE76 7340 1234 5678	41	\N	27	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1040	2026-06-04	-114.3723	EUR	27172.28	Kleding	\N	BE76 7340 1234 5678	43	\N	26	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
1041	2026-06-01	-675.7711	EUR	28466.28	Reis / vakantie	\N	BE76 7340 1234 5678	47	\N	25	t	2026-06-18 08:45:15.510273	2026-06-18 08:45:15.510273	\N	\N	\N
\.


--
-- Data for Name: user_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_settings (key, value, updated_at, created_at) FROM stdin;
belgian_tax_profile	{"region": "flanders", "taxYear": 2025, "unionDues": 145, "isDisabled": false, "alimonyPaid": 0, "filingStatus": "married_joint", "pensionScheme": "1050", "childcareCosts": 0, "employmentType": "employee", "mortgageRegion": "flanders", "cadastralIncome": 1450, "medicalExpenses": 0, "pensionEligible": true, "isIsolatedParent": false, "isSpouseDisabled": false, "dependentChildren": 1, "grossAnnualIncome": 58000, "mortgageStartYear": 2018, "profileConfigured": true, "otherTaxableIncome": 0, "charitableDonations": 120, "annualDividendIncome": 115, "mortgageInterestPaid": 3300, "taxIncomeCategoryIds": [1, 2], "annualSavingsInterest": 60, "dependentOtherPersons": 0, "lifeInsurancePremiums": 0, "mortgageCapitalRepaid": 7900, "dependentChildrenUnder3": 0, "communalSurchargePercent": 6.9, "spouseProfessionalIncome": 22000, "professionalExpenseMethod": "lump_sum", "actualProfessionalExpenses": 0, "mortgageIsPrimaryResidence": true, "charitableDonationsEligible": true, "personalPensionContributions": 990, "employeeGroupInsuranceContributions": 0}	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: vision_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vision_raw_transactions (id, deduplication_hash, created_at, transaction_date, bank_account, recipient, memo, amount, currency, balance, category, comment, raw_csv_line) FROM stdin;
\.


--
-- Data for Name: watchlist; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.watchlist (id, name, symbol, asset_class, target_price, currency, notes, price_provider_id, created_at, updated_at) FROM stdin;
1	Tesla Inc.	TSLA	stock	180.000000	USD	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
2	Microsoft Corp.	MSFT	stock	380.000000	USD	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
3	VanEck Semiconductor ETF	SMH	etf	250.000000	USD	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
4	Solana	SOL	crypto	120.000000	EUR	\N	\N	2026-06-18 08:45:15.510273+00	2026-06-18 08:45:15.510273+00
\.


--
-- Data for Name: wise_raw_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.wise_raw_transactions (id, deduplication_hash, created_at, transfer_id, direction, status, finished_on, source_name, source_amount, source_currency, target_name, target_amount, target_currency, exchange_rate, source_fee_amount, source_fee_currency, reference, batch, raw_csv_line) FROM stdin;
\.


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
-- Name: exchange_rate_cache_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.exchange_rate_cache_id_seq', 258, true);


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.exchange_rates_id_seq', 1, true);


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
-- Name: investments_base_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.investments_base_id_seq', 10, true);


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
-- Name: portfolio_transactions_base_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.portfolio_transactions_base_id_seq', 91, true);


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
-- Name: schema_version_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.schema_version_id_seq', 1, false);


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

SELECT pg_catalog.setval('public.transactions_id_seq', 1041, true);


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
-- Name: bond_investments bond_investments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_investments
    ADD CONSTRAINT bond_investments_pkey PRIMARY KEY (id);


--
-- Name: bond_transactions bond_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions
    ADD CONSTRAINT bond_transactions_pkey PRIMARY KEY (id);


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
-- Name: crypto_investments crypto_investments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_investments
    ADD CONSTRAINT crypto_investments_pkey PRIMARY KEY (id);


--
-- Name: crypto_transactions crypto_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_transactions
    ADD CONSTRAINT crypto_transactions_pkey PRIMARY KEY (id);


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
-- Name: etf_investments etf_investments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_investments
    ADD CONSTRAINT etf_investments_pkey PRIMARY KEY (id);


--
-- Name: etf_transactions etf_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etf_transactions
    ADD CONSTRAINT etf_transactions_pkey PRIMARY KEY (id);


--
-- Name: exchange_rate_cache exchange_rate_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rate_cache
    ADD CONSTRAINT exchange_rate_cache_pkey PRIMARY KEY (id);


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
-- Name: investments_base investments_base_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investments_base
    ADD CONSTRAINT investments_base_pkey PRIMARY KEY (id);


--
-- Name: kbc_raw_transactions kbc_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kbc_raw_transactions
    ADD CONSTRAINT kbc_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: manual_raw_transactions manual_raw_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_raw_transactions
    ADD CONSTRAINT manual_raw_transactions_pkey PRIMARY KEY (id);


--
-- Name: metals_investments metals_investments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_investments
    ADD CONSTRAINT metals_investments_pkey PRIMARY KEY (id);


--
-- Name: metals_transactions metals_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metals_transactions
    ADD CONSTRAINT metals_transactions_pkey PRIMARY KEY (id);


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
-- Name: portfolio_transactions_base portfolio_transactions_base_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_transactions_base
    ADD CONSTRAINT portfolio_transactions_base_pkey PRIMARY KEY (id);


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
-- Name: real_estate_investments real_estate_investments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_investments
    ADD CONSTRAINT real_estate_investments_pkey PRIMARY KEY (id);


--
-- Name: real_estate_transactions real_estate_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.real_estate_transactions
    ADD CONSTRAINT real_estate_transactions_pkey PRIMARY KEY (id);


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
-- Name: recipients recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipients
    ADD CONSTRAINT recipients_pkey PRIMARY KEY (id);


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
-- Name: savings_investments savings_investments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_investments
    ADD CONSTRAINT savings_investments_pkey PRIMARY KEY (id);


--
-- Name: savings_transactions savings_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.savings_transactions
    ADD CONSTRAINT savings_transactions_pkey PRIMARY KEY (id);


--
-- Name: schema_version schema_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_version
    ADD CONSTRAINT schema_version_pkey PRIMARY KEY (id);


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
-- Name: stock_investments stock_investments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_investments
    ADD CONSTRAINT stock_investments_pkey PRIMARY KEY (id);


--
-- Name: stock_transactions stock_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transactions
    ADD CONSTRAINT stock_transactions_pkey PRIMARY KEY (id);


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
-- Name: exchange_rate_cache uq_exchange_rate_cache_pair_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rate_cache
    ADD CONSTRAINT uq_exchange_rate_cache_pair_date UNIQUE (from_ccy, to_ccy, rate_date);


--
-- Name: categories uq_general_detail; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT uq_general_detail UNIQUE (general, detail);


--
-- Name: manual_raw_transactions uq_manual_dedup_hash; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_raw_transactions
    ADD CONSTRAINT uq_manual_dedup_hash UNIQUE (deduplication_hash);


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
-- Name: recipient_bank_accounts uq_rba_account_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipient_bank_accounts
    ADD CONSTRAINT uq_rba_account_number UNIQUE (account_number);


--
-- Name: recipients uq_recipients_normalized_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipients
    ADD CONSTRAINT uq_recipients_normalized_name UNIQUE (normalized_name);


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
-- Name: idx_bond_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bond_transactions_date ON public.bond_transactions USING btree (date);


--
-- Name: idx_bond_transactions_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bond_transactions_investment_id ON public.bond_transactions USING btree (investment_id);


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
-- Name: idx_crypto_investments_symbol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crypto_investments_symbol ON public.crypto_investments USING btree (symbol);


--
-- Name: idx_crypto_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crypto_transactions_date ON public.crypto_transactions USING btree (date);


--
-- Name: idx_crypto_transactions_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crypto_transactions_investment_id ON public.crypto_transactions USING btree (investment_id);


--
-- Name: idx_custom_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_date ON public.custom_raw_transactions USING btree (date);


--
-- Name: idx_custom_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_hash ON public.custom_raw_transactions USING btree (deduplication_hash);


--
-- Name: idx_etf_investments_symbol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_etf_investments_symbol ON public.etf_investments USING btree (symbol);


--
-- Name: idx_etf_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_etf_transactions_date ON public.etf_transactions USING btree (date);


--
-- Name: idx_etf_transactions_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_etf_transactions_investment_id ON public.etf_transactions USING btree (investment_id);


--
-- Name: idx_exchange_rate_cache_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exchange_rate_cache_date ON public.exchange_rate_cache USING btree (rate_date);


--
-- Name: idx_exchange_rate_cache_from_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exchange_rate_cache_from_to ON public.exchange_rate_cache USING btree (from_ccy, to_ccy);


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
-- Name: idx_investments_base_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_investments_base_is_active ON public.investments_base USING btree (is_active);


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
-- Name: idx_metals_investments_symbol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metals_investments_symbol ON public.metals_investments USING btree (symbol);


--
-- Name: idx_metals_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metals_transactions_date ON public.metals_transactions USING btree (date);


--
-- Name: idx_metals_transactions_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metals_transactions_investment_id ON public.metals_transactions USING btree (investment_id);


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
-- Name: idx_portfolio_transactions_base_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_transactions_base_date ON public.portfolio_transactions_base USING btree (date);


--
-- Name: idx_portfolio_transactions_base_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_transactions_base_investment_id ON public.portfolio_transactions_base USING btree (investment_id);


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
-- Name: idx_real_estate_investments_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_real_estate_investments_location ON public.real_estate_investments USING btree (location);


--
-- Name: idx_real_estate_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_real_estate_transactions_date ON public.real_estate_transactions USING btree (date);


--
-- Name: idx_real_estate_transactions_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_real_estate_transactions_investment_id ON public.real_estate_transactions USING btree (investment_id);


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
-- Name: idx_recipients_normalized_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_normalized_name ON public.recipients USING btree (normalized_name);


--
-- Name: idx_recipients_normalized_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_normalized_name_trgm ON public.recipients USING gin (normalized_name public.gin_trgm_ops);


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
-- Name: idx_savings_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_savings_transactions_date ON public.savings_transactions USING btree (date);


--
-- Name: idx_savings_transactions_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_savings_transactions_investment_id ON public.savings_transactions USING btree (investment_id);


--
-- Name: idx_split_audit_action_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_split_audit_action_created ON public.split_audit USING btree (action, created_at DESC);


--
-- Name: idx_split_audit_split_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_split_audit_split_created ON public.split_audit USING btree (split_id, created_at DESC);


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
-- Name: idx_stock_investments_symbol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_investments_symbol ON public.stock_investments USING btree (symbol);


--
-- Name: idx_stock_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_transactions_date ON public.stock_transactions USING btree (date);


--
-- Name: idx_stock_transactions_investment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_transactions_investment_id ON public.stock_transactions USING btree (investment_id);


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
-- Name: idx_transactions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_active ON public.transactions USING btree (date DESC, id DESC) WHERE (is_active = true);


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
-- Name: ix_belfius_raw_transactions_account_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_belfius_raw_transactions_account_number ON public.belfius_raw_transactions USING btree (account_number);


--
-- Name: ix_belfius_raw_transactions_deduplication_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_belfius_raw_transactions_deduplication_hash ON public.belfius_raw_transactions USING btree (deduplication_hash);


--
-- Name: ix_belfius_raw_transactions_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_belfius_raw_transactions_id ON public.belfius_raw_transactions USING btree (id);


--
-- Name: ix_belfius_raw_transactions_transaction_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_belfius_raw_transactions_transaction_date ON public.belfius_raw_transactions USING btree (transaction_date);


--
-- Name: ix_categories_detail; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_categories_detail ON public.categories USING btree (detail);


--
-- Name: ix_categories_general; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_categories_general ON public.categories USING btree (general);


--
-- Name: ix_categories_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_categories_id ON public.categories USING btree (id);


--
-- Name: ix_exchange_rates_currency_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_exchange_rates_currency_code ON public.exchange_rates USING btree (currency_code);


--
-- Name: ix_exchange_rates_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_exchange_rates_id ON public.exchange_rates USING btree (id);


--
-- Name: ix_exchange_rates_is_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_exchange_rates_is_latest ON public.exchange_rates USING btree (is_latest);


--
-- Name: ix_exchange_rates_rate_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_exchange_rates_rate_date ON public.exchange_rates USING btree (rate_date);


--
-- Name: ix_instrument_provider_map_provider_symbol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_instrument_provider_map_provider_symbol ON public.instrument_provider_map USING btree (provider, provider_symbol);


--
-- Name: ix_kbc_raw_transactions_account_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_kbc_raw_transactions_account_number ON public.kbc_raw_transactions USING btree (account_number);


--
-- Name: ix_kbc_raw_transactions_deduplication_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_kbc_raw_transactions_deduplication_hash ON public.kbc_raw_transactions USING btree (deduplication_hash);


--
-- Name: ix_kbc_raw_transactions_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_kbc_raw_transactions_id ON public.kbc_raw_transactions USING btree (id);


--
-- Name: ix_kbc_raw_transactions_transaction_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_kbc_raw_transactions_transaction_date ON public.kbc_raw_transactions USING btree (transaction_date);


--
-- Name: ix_manual_raw_transactions_date_amount; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_manual_raw_transactions_date_amount ON public.manual_raw_transactions USING btree (date, amount);


--
-- Name: ix_manual_raw_transactions_deduplication_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_manual_raw_transactions_deduplication_hash ON public.manual_raw_transactions USING btree (deduplication_hash);


--
-- Name: ix_planned_transaction_executions_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_planned_transaction_executions_id ON public.planned_transaction_executions USING btree (id);


--
-- Name: ix_planned_transaction_executions_planned_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_planned_transaction_executions_planned_transaction_id ON public.planned_transaction_executions USING btree (planned_transaction_id);


--
-- Name: ix_planned_transactions_bank_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_planned_transactions_bank_account ON public.planned_transactions USING btree (bank_account);


--
-- Name: ix_planned_transactions_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_planned_transactions_id ON public.planned_transactions USING btree (id);


--
-- Name: ix_planned_transactions_planned_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_planned_transactions_planned_date ON public.planned_transactions USING btree (planned_date);


--
-- Name: ix_recipient_bank_accounts_account_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_recipient_bank_accounts_account_number ON public.recipient_bank_accounts USING btree (account_number);


--
-- Name: ix_recipient_bank_accounts_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_recipient_bank_accounts_id ON public.recipient_bank_accounts USING btree (id);


--
-- Name: ix_recipients_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_recipients_id ON public.recipients USING btree (id);


--
-- Name: ix_recipients_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_recipients_name ON public.recipients USING btree (name);


--
-- Name: ix_recipients_normalized_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_recipients_normalized_name ON public.recipients USING btree (normalized_name);


--
-- Name: ix_revolut_raw_transactions_completed_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_revolut_raw_transactions_completed_date ON public.revolut_raw_transactions USING btree (completed_date);


--
-- Name: ix_revolut_raw_transactions_deduplication_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_revolut_raw_transactions_deduplication_hash ON public.revolut_raw_transactions USING btree (deduplication_hash);


--
-- Name: ix_revolut_raw_transactions_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_revolut_raw_transactions_id ON public.revolut_raw_transactions USING btree (id);


--
-- Name: ix_transaction_raw_references_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_transaction_raw_references_id ON public.transaction_raw_references USING btree (id);


--
-- Name: ix_transaction_raw_references_raw_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_transaction_raw_references_raw_source_id ON public.transaction_raw_references USING btree (raw_source_id);


--
-- Name: ix_transaction_raw_references_raw_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_transaction_raw_references_raw_source_type ON public.transaction_raw_references USING btree (raw_source_type);


--
-- Name: ix_transaction_raw_references_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_transaction_raw_references_transaction_id ON public.transaction_raw_references USING btree (transaction_id);


--
-- Name: ix_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_transactions_date ON public.transactions USING btree (date);


--
-- Name: mv_bank_balances_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mv_bank_balances_idx ON public.mv_bank_balances USING btree (bank_account, currency);


--
-- Name: mv_cashflow_daily_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mv_cashflow_daily_idx ON public.mv_cashflow_daily USING btree (date, currency);


--
-- Name: mv_category_totals_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mv_category_totals_idx ON public.mv_category_totals USING btree (category_id, currency);


--
-- Name: mv_monthly_summary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mv_monthly_summary_idx ON public.mv_monthly_summary USING btree (month_start, currency, category_id_key);


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
-- Name: transaction_splits trg_split_outstanding_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_split_outstanding_sync AFTER INSERT OR DELETE OR UPDATE ON public.transaction_splits FOR EACH ROW EXECUTE FUNCTION public.fn_trg_split_sync();


--
-- Name: split_payments trg_split_payment_outstanding_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_split_payment_outstanding_sync AFTER INSERT OR DELETE OR UPDATE ON public.split_payments FOR EACH ROW EXECUTE FUNCTION public.fn_trg_split_payment_sync();


--
-- Name: split_payments trg_split_payment_overpayment_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_split_payment_overpayment_guard BEFORE INSERT OR UPDATE OF amount, split_id ON public.split_payments FOR EACH ROW EXECUTE FUNCTION public.fn_split_payment_overpayment_guard();


--
-- Name: asset_price_history update_asset_price_history_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_asset_price_history_updated_at BEFORE UPDATE ON public.asset_price_history FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: belgian_inflation_rates update_belgian_inflation_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_belgian_inflation_updated_at BEFORE UPDATE ON public.belgian_inflation_rates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: bond_investments update_bond_investments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bond_investments_updated_at BEFORE UPDATE ON public.bond_investments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: bond_transactions update_bond_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bond_transactions_updated_at BEFORE UPDATE ON public.bond_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: categories update_categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: crypto_investments update_crypto_investments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_crypto_investments_updated_at BEFORE UPDATE ON public.crypto_investments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: crypto_transactions update_crypto_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_crypto_transactions_updated_at BEFORE UPDATE ON public.crypto_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: custom_parser_configs update_custom_parser_configs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_custom_parser_configs_updated_at BEFORE UPDATE ON public.custom_parser_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: etf_investments update_etf_investments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_etf_investments_updated_at BEFORE UPDATE ON public.etf_investments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: etf_transactions update_etf_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_etf_transactions_updated_at BEFORE UPDATE ON public.etf_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: instrument_provider_map update_instrument_provider_map_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_instrument_provider_map_updated_at BEFORE UPDATE ON public.instrument_provider_map FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: investments_base update_investments_base_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_investments_base_updated_at BEFORE UPDATE ON public.investments_base FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: investments update_investments_view_instead; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_investments_view_instead INSTEAD OF UPDATE ON public.investments FOR EACH ROW EXECUTE FUNCTION public.investments_view_update_instead();


--
-- Name: metals_transactions update_metals_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_metals_transactions_updated_at BEFORE UPDATE ON public.metals_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: portfolio_transactions_base update_portfolio_transactions_base_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_portfolio_transactions_base_updated_at BEFORE UPDATE ON public.portfolio_transactions_base FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


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
-- Name: real_estate_investments update_real_estate_investments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_real_estate_investments_updated_at BEFORE UPDATE ON public.real_estate_investments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: real_estate_transactions update_real_estate_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_real_estate_transactions_updated_at BEFORE UPDATE ON public.real_estate_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


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
-- Name: savings_investments update_savings_investments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_savings_investments_updated_at BEFORE UPDATE ON public.savings_investments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: savings_transactions update_savings_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_savings_transactions_updated_at BEFORE UPDATE ON public.savings_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: stock_investments update_stock_investments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_stock_investments_updated_at BEFORE UPDATE ON public.stock_investments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: stock_transactions update_stock_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_stock_transactions_updated_at BEFORE UPDATE ON public.stock_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


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
-- Name: recipients fk_recipients_primary_recipient; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipients
    ADD CONSTRAINT fk_recipients_primary_recipient FOREIGN KEY (primary_recipient_id) REFERENCES public.recipients(id) ON DELETE SET NULL;


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
-- Name: planned_transactions planned_transactions_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transactions
    ADD CONSTRAINT planned_transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: planned_transactions planned_transactions_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planned_transactions
    ADD CONSTRAINT planned_transactions_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.recipients(id);


--
-- Name: portfolio_import_staging_rows portfolio_import_staging_rows_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_import_staging_rows
    ADD CONSTRAINT portfolio_import_staging_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.portfolio_import_batches(id) ON DELETE CASCADE;


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
    ADD CONSTRAINT recipients_default_category_id_fkey FOREIGN KEY (default_category_id) REFERENCES public.categories(id);


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
-- Name: transactions transactions_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


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

\unrestrict aP17sl0HKNN6Xlxgby5kXoy24QLxlA6eU4n7dH2CihF8bIWVJAoGXSoK9Pz4XZi

