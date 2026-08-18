-- auth-kotlin-toolkit support tables, duplicated verbatim from the
-- toolkit's db/auth/V001__auth_tables.sql + V002__passkey_credential.sql
-- (build-scope §8: consumer-versioned copy, MediaManager precedent —
-- a second Flyway location would collide with this chain's version
-- numbers). The toolkit's files are the source of truth; refresh this
-- copy when the toolkit's auth DDL changes.

-- Session tokens (cookie-based auth)
CREATE TABLE IF NOT EXISTS session_token (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT NOT NULL,
    token_hash      VARCHAR(64) NOT NULL,
    user_agent      VARCHAR(500),
    created_at      TIMESTAMP NOT NULL,
    expires_at      TIMESTAMP NOT NULL,
    last_used_at    TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_session_token_hash ON session_token(token_hash);
CREATE INDEX IF NOT EXISTS idx_session_token_user ON session_token(user_id);

-- Login attempts (rate limiting)
CREATE TABLE IF NOT EXISTS login_attempt (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(100) NOT NULL,
    ip_address      VARCHAR(45) NOT NULL,
    attempted_at    TIMESTAMP NOT NULL,
    success         BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_login_attempt_ip ON login_attempt(ip_address, attempted_at);
CREATE INDEX IF NOT EXISTS idx_login_attempt_user ON login_attempt(username, attempted_at);

-- Refresh tokens (JWT auth)
CREATE TABLE IF NOT EXISTS refresh_token (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT NOT NULL,
    token_hash      VARCHAR(64) NOT NULL,
    family_id       VARCHAR(64) NOT NULL,
    device_name     VARCHAR(255) NOT NULL DEFAULT '',
    created_at      TIMESTAMP NOT NULL,
    expires_at      TIMESTAMP NOT NULL,
    revoked         BOOLEAN NOT NULL DEFAULT FALSE,
    replaced_by_hash VARCHAR(64),
    replaced_at     TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_refresh_token_hash ON refresh_token(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_token_user ON refresh_token(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token_family ON refresh_token(family_id);

-- Auth config (JWT signing keys, etc.)
CREATE TABLE IF NOT EXISTS auth_config (
    config_key      VARCHAR(100) PRIMARY KEY,
    config_val      VARCHAR(4000) NOT NULL
);

-- WebAuthn/passkey credential storage for passwordless re-login.
-- Each row represents one registered authenticator (Face ID, Touch ID, hardware key, etc.).
CREATE TABLE IF NOT EXISTS passkey_credential (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT NOT NULL,
    credential_id   VARCHAR(512) NOT NULL,
    public_key      VARBINARY(1024) NOT NULL,
    sign_count      BIGINT NOT NULL DEFAULT 0,
    transports      VARCHAR(255) DEFAULT NULL,
    display_name    VARCHAR(255) NOT NULL DEFAULT 'Passkey',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at    TIMESTAMP DEFAULT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_passkey_credential_id ON passkey_credential(credential_id);
CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey_credential(user_id);
