-- Rollback of 0003_exposure_classification_origin: drops the origin column.
-- Manual classifications stay as ordinary rows; a later import may overwrite them.

ALTER TABLE portfolio_exposure_classifications DROP COLUMN origin;
