-- Phase 0 baseline. The real domain schema arrives with Phase 3;
-- app_metadata exists so the migration pipeline and test fixtures have
-- something real to verify.
CREATE TABLE app_metadata (
    meta_key VARCHAR(64) PRIMARY KEY,
    meta_value VARCHAR(255) NOT NULL
);

INSERT INTO app_metadata (meta_key, meta_value) VALUES ('schema_baseline', 'phase0');
