-- 0003_exposure_classification_origin: record whether an exposure
-- classification came from a source-bundle import or was set by hand in the
-- app (ADR-267).
--
-- Every existing row came from an import, so the constant default labels them
-- 'import'. Imports skip rows marked 'manual'. Adding a column with a constant
-- default rewrites no rows.

ALTER TABLE portfolio_exposure_classifications
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'import'
    CONSTRAINT portfolio_exposure_classifications_origin__vtype CHECK (origin IN ('import', 'manual'));
