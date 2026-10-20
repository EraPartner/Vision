-- 0005_simplify_portfolio_reconciliation rollback: recreate the receipt guards exactly as
-- the 0001 baseline defined them. Triggers do not re-check existing rows. In-kind income
-- imported after 0005 has no `record` receipt, so a later write to such a row fails the
-- recreated portfolio_income_requires_pair check until that batch is rolled back.

CREATE FUNCTION "public"."portfolio_duplicate_repair_state"("data" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    AS $$
        SELECT jsonb_set(jsonb_set(data,'{legacy}',(data->'legacy') - 'updated_at'),'{originalStaging}',
          COALESCE((SELECT jsonb_agg(item.value - 'updated_at' ORDER BY item.ordinality)
                    FROM jsonb_array_elements(data->'originalStaging') WITH ORDINALITY item),'[]'::jsonb))
      $$;

CREATE FUNCTION "public"."enforce_portfolio_duplicate_repair_receipt"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          RAISE EXCEPTION 'Portfolio duplicate repair receipts are immutable';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM portfolio_import_staging_rows source
          WHERE source.id=NEW.staging_row_id AND source.batch_id=NEW.batch_id) THEN
          RAISE EXCEPTION 'Duplicate repair receipt source does not belong to its batch';
        END IF;
        IF NEW.action='restore' AND NOT EXISTS (
          SELECT 1 FROM portfolio_import_duplicate_repair_journal repair
          WHERE repair.id=NEW.previous_entry_id AND repair.action='repair'
            AND repair.batch_id=NEW.batch_id AND repair.staging_row_id=NEW.staging_row_id
            AND repair.original_import_batch_id=NEW.original_import_batch_id
            AND repair.legacy_transaction_id=NEW.legacy_transaction_id
            AND repair.imported_transaction_id=NEW.imported_transaction_id AND repair.policy=NEW.policy
            AND portfolio_duplicate_repair_state(repair.after_data)=portfolio_duplicate_repair_state(NEW.before_data)
            AND portfolio_duplicate_repair_state(repair.before_data)=portfolio_duplicate_repair_state(NEW.after_data)
        ) THEN RAISE EXCEPTION 'Invalid portfolio duplicate repair restoration receipt'; END IF;
        RETURN NEW;
      END $$;

CREATE FUNCTION "public"."forbid_portfolio_import_receipt_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
          BEGIN
            RAISE EXCEPTION 'Portfolio import reconciliation receipts are immutable';
          END $$;

CREATE FUNCTION "public"."guard_portfolio_cash_receipt"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
      BEGIN
        IF portfolio_cash_receipt(OLD.raw_data) IS NOT NULL
          AND (TG_OP='DELETE' OR NEW.raw_data IS DISTINCT FROM OLD.raw_data) THEN
          RAISE EXCEPTION 'Recorded brokerage cash source evidence is immutable';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;

CREATE FUNCTION "public"."require_portfolio_income_pair"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM portfolio_transactions t WHERE t.id=NEW.id AND t.income_recognition_role='included_in_units')
          AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal r WHERE r.income_transaction_id=NEW.id AND r.action='record'
            AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal undo WHERE undo.previous_entry_id=r.id)) THEN
          RAISE EXCEPTION 'In-kind income requires a proved active pair receipt';
        END IF;
        RETURN NEW;
      END $$;

CREATE FUNCTION "public"."validate_portfolio_import_receipt"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM portfolio_import_staging_rows source
              WHERE source.id = NEW.staging_row_id AND source.batch_id = NEW.batch_id
            ) THEN
              RAISE EXCEPTION 'Reconciliation receipt source does not belong to its batch';
            END IF;
            IF NEW.action = 'restore' AND NOT EXISTS (
              SELECT 1 FROM portfolio_import_reconciliation_journal adoption
              WHERE adoption.id = NEW.previous_entry_id AND adoption.action = 'adopt'
                AND adoption.batch_id = NEW.batch_id
                AND adoption.staging_row_id = NEW.staging_row_id
                AND adoption.transaction_id = NEW.transaction_id
                AND adoption.policy = NEW.policy
                AND adoption.before_data = NEW.after_data
                AND adoption.after_data = NEW.before_data
            ) THEN
              RAISE EXCEPTION 'Invalid portfolio import restoration receipt';
            END IF;
            RETURN NEW;
          END $$;

CREATE FUNCTION "public"."validate_portfolio_income_receipt"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
      DECLARE income_image JSONB; unit_image JSONB;
      BEGIN
        SELECT portfolio_income_transaction_snapshot(t) INTO income_image FROM portfolio_transactions t WHERE t.id=NEW.income_transaction_id FOR UPDATE;
        SELECT portfolio_income_transaction_snapshot(t) INTO unit_image FROM portfolio_transactions t WHERE t.id=NEW.unit_transaction_id FOR UPDATE;
        IF income_image IS DISTINCT FROM NEW.income_data OR unit_image IS DISTINCT FROM NEW.unit_data THEN
          RAISE EXCEPTION 'Paired income current after-images changed';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM portfolio_import_staging_rows s JOIN portfolio_import_batches b ON b.id=s.batch_id
          WHERE s.id=NEW.staging_row_id AND b.id=NEW.batch_id AND s.type='dividend' AND s.route='portfolio'
            AND b.custom_config->>'format'='kinesis_transaction_history' AND b.custom_config->>'yield_basis_policy'='zero'
            AND b.custom_config->'kinesis_source_context'->>'source_file_hash'=NEW.proof_data->>'sourceFileHash') THEN
          RAISE EXCEPTION 'Paired income receipt requires its complete primary source';
        END IF;
        IF NEW.action='record' THEN
          IF income_image->>'income_recognition_role'<>'included_in_units' OR income_image->>'type'<>'dividend'
            OR income_image->>'units' IS NOT NULL OR income_image->>'price_per_unit' IS NOT NULL
            OR (income_image->>'amount')::numeric<0 OR (income_image->>'fees')::numeric<>0 OR (income_image->>'taxes')::numeric<>0
            OR income_image->>'fx_rate_to_eur' IS NOT NULL
            OR unit_image->>'type'<>'gift' OR (unit_image->>'amount')::numeric<>0
            OR (unit_image->>'price_per_unit')::numeric<>0 OR (unit_image->>'units')::numeric<=0
            OR (unit_image->>'fees')::numeric<>0 OR (unit_image->>'taxes')::numeric<>0
            OR income_image->>'investment_id' IS DISTINCT FROM unit_image->>'investment_id'
            OR income_image->>'account_id' IS DISTINCT FROM unit_image->>'account_id'
            OR income_image->>'date' IS DISTINCT FROM unit_image->>'date'
            OR income_image->>'source_record_hash' IS DISTINCT FROM unit_image->>'source_record_hash'
            OR EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal r WHERE r.action='record' AND r.unit_transaction_id=NEW.unit_transaction_id
              AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal undo WHERE undo.previous_entry_id=r.id)) THEN
            RAISE EXCEPTION 'Paired income acquisition is invalid or already recognized';
          END IF;
        ELSIF NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal r WHERE r.id=NEW.previous_entry_id AND r.action='record'
          AND r.batch_id=NEW.batch_id AND r.staging_row_id=NEW.staging_row_id AND r.unit_staging_row_id=NEW.unit_staging_row_id
          AND r.income_transaction_id=NEW.income_transaction_id AND r.unit_transaction_id=NEW.unit_transaction_id
          AND r.income_data=NEW.income_data AND r.unit_data=NEW.unit_data AND r.proof_data=NEW.proof_data) THEN
          RAISE EXCEPTION 'Invalid paired income restoration receipt';
        END IF;
        RETURN NEW;
      END $$;

CREATE TRIGGER "portfolio_duplicate_repair_receipt_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."portfolio_import_duplicate_repair_journal" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_portfolio_duplicate_repair_receipt"();
CREATE TRIGGER "portfolio_import_reconciliation_immutable" BEFORE DELETE OR UPDATE ON "public"."portfolio_import_reconciliation_journal" FOR EACH ROW EXECUTE FUNCTION "public"."forbid_portfolio_import_receipt_mutation"();
CREATE TRIGGER "portfolio_import_reconciliation_valid_receipt" BEFORE INSERT ON "public"."portfolio_import_reconciliation_journal" FOR EACH ROW EXECUTE FUNCTION "public"."validate_portfolio_import_receipt"();
CREATE TRIGGER "portfolio_income_journal_immutable" BEFORE DELETE OR UPDATE ON "public"."portfolio_import_income_recognition_journal" FOR EACH ROW EXECUTE FUNCTION "public"."forbid_portfolio_import_receipt_mutation"();
CREATE CONSTRAINT TRIGGER "portfolio_income_requires_pair" AFTER INSERT OR UPDATE ON "public"."portfolio_transactions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."require_portfolio_income_pair"();
CREATE TRIGGER "portfolio_income_valid_receipt" BEFORE INSERT ON "public"."portfolio_import_income_recognition_journal" FOR EACH ROW EXECUTE FUNCTION "public"."validate_portfolio_income_receipt"();
CREATE TRIGGER "trg_portfolio_cash_receipt_immutable" BEFORE DELETE OR UPDATE ON "public"."portfolio_import_staging_rows" FOR EACH ROW EXECUTE FUNCTION "public"."guard_portfolio_cash_receipt"();
