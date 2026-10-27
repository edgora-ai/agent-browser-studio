-- Version 1. SQLiteOpenHelper executes these exact statements, separated by markers.
-- Python executes this original file with executescript; it is not an Android execution.
-- @statement
CREATE TABLE store_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    store_id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16))))
        CHECK (length(store_id) = 32 AND store_id NOT GLOB '*[^0-9a-f]*')
);
-- @statement
INSERT INTO store_meta(singleton) VALUES (1);
-- @statement
CREATE TABLE profile_ids (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36
        AND id NOT GLOB '*[^0-9a-f-]*' AND length(replace(id, '-', '')) = 32
        AND substr(id,9,1) = '-' AND substr(id,14,1) = '-'
        AND substr(id,19,1) = '-' AND substr(id,24,1) = '-'),
    directory_suffix TEXT NOT NULL UNIQUE
        CHECK (length(directory_suffix) BETWEEN 1 AND 128
            AND directory_suffix NOT GLOB '*[^a-zA-Z0-9_-]*')
);
-- @statement
CREATE TABLE profile_revisions (
    profile_id TEXT NOT NULL REFERENCES profile_ids(id),
    revision TEXT PRIMARY KEY NOT NULL CHECK (length(revision) = 36
        AND revision NOT GLOB '*[^0-9a-f-]*' AND length(replace(revision, '-', '')) = 32
        AND substr(revision,9,1) = '-' AND substr(revision,14,1) = '-'
        AND substr(revision,19,1) = '-' AND substr(revision,24,1) = '-'),
    UNIQUE (profile_id, revision)
);
-- @statement
CREATE TABLE profiles (
    id TEXT PRIMARY KEY NOT NULL REFERENCES profile_ids(id),
    revision TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
    name_key TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name_key) > 0),
    has_credentials INTEGER NOT NULL CHECK (has_credentials IN (0, 1)),
    credential_revision TEXT UNIQUE,
    spec_json TEXT NOT NULL CHECK (length(spec_json) BETWEEN 2 AND 65536),
    config_hash TEXT NOT NULL CHECK (length(config_hash) = 64
        AND config_hash NOT GLOB '*[^0-9a-f]*'),
    directory_suffix TEXT NOT NULL,
    CHECK ((has_credentials = 0 AND credential_revision IS NULL)
        OR (has_credentials = 1 AND credential_revision IS NOT NULL
            AND length(credential_revision) = 36
            AND credential_revision NOT GLOB '*[^0-9a-f-]*'
            AND length(replace(credential_revision, '-', '')) = 32
            AND substr(credential_revision,9,1) = '-' AND substr(credential_revision,14,1) = '-'
            AND substr(credential_revision,19,1) = '-' AND substr(credential_revision,24,1) = '-')),
    FOREIGN KEY (id, revision) REFERENCES profile_revisions(profile_id, revision),
    FOREIGN KEY (id, credential_revision)
        REFERENCES credential_envelopes(profile_id, credential_revision)
        DEFERRABLE INITIALLY DEFERRED
);
-- @statement
CREATE TABLE credential_envelopes (
    profile_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles(id) ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED,
    credential_revision TEXT NOT NULL UNIQUE CHECK (length(credential_revision) = 36
        AND credential_revision NOT GLOB '*[^0-9a-f-]*'
        AND length(replace(credential_revision, '-', '')) = 32
        AND substr(credential_revision,9,1) = '-' AND substr(credential_revision,14,1) = '-'
        AND substr(credential_revision,19,1) = '-' AND substr(credential_revision,24,1) = '-'),
    iv BLOB NOT NULL CHECK (typeof(iv) = 'blob' AND length(iv) = 12),
    ciphertext BLOB NOT NULL CHECK (typeof(ciphertext) = 'blob'
        AND length(ciphertext) BETWEEN 30 AND 32800),
    UNIQUE (profile_id, credential_revision)
);
-- @statement
CREATE TABLE launch_records (
    session_id TEXT PRIMARY KEY NOT NULL CHECK (length(session_id) = 36
        AND session_id NOT GLOB '*[^0-9a-f-]*' AND length(replace(session_id, '-', '')) = 32
        AND substr(session_id,9,1) = '-' AND substr(session_id,14,1) = '-'
        AND substr(session_id,19,1) = '-' AND substr(session_id,24,1) = '-'),
    nonce TEXT NOT NULL UNIQUE CHECK (length(nonce) = 36
        AND nonce NOT GLOB '*[^0-9a-f-]*' AND length(replace(nonce, '-', '')) = 32
        AND substr(nonce,9,1) = '-' AND substr(nonce,14,1) = '-'
        AND substr(nonce,19,1) = '-' AND substr(nonce,24,1) = '-'),
    slot INTEGER NOT NULL DEFAULT 1 CHECK (slot = 1),
    profile_id TEXT NOT NULL REFERENCES profile_ids(id),
    profile_revision TEXT NOT NULL,
    spec_json TEXT NOT NULL CHECK (length(spec_json) BETWEEN 2 AND 65536),
    config_hash TEXT NOT NULL CHECK (length(config_hash) = 64
        AND config_hash NOT GLOB '*[^0-9a-f]*'),
    directory_suffix TEXT NOT NULL,
    issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms > 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms
        AND expires_at_ms - issued_at_ms <= 120000),
    state TEXT NOT NULL CHECK (state IN
        ('PUBLISHED', 'CLAIMED', 'REVOKED', 'EXIT_UNCONFIRMED', 'EXIT_CONFIRMED')),
    incarnation_id TEXT UNIQUE CHECK (incarnation_id IS NULL OR (length(incarnation_id) = 36
        AND incarnation_id NOT GLOB '*[^0-9a-f-]*'
        AND length(replace(incarnation_id, '-', '')) = 32
        AND substr(incarnation_id,9,1) = '-' AND substr(incarnation_id,14,1) = '-'
        AND substr(incarnation_id,19,1) = '-' AND substr(incarnation_id,24,1) = '-')),
    pid INTEGER,
    consumed_at_ms INTEGER,
    provider TEXT CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 240),
    phase INTEGER NOT NULL CHECK (phase IN (0, 10, 20, 30, 40, 50, 60, 70, 90, 100)),
    FOREIGN KEY (profile_id, profile_revision)
        REFERENCES profile_revisions(profile_id, revision),
    CHECK ((incarnation_id IS NULL AND pid IS NULL AND consumed_at_ms IS NULL)
        OR (incarnation_id IS NOT NULL AND length(incarnation_id) = 36
            AND pid IS NOT NULL AND pid > 0 AND consumed_at_ms IS NOT NULL
            AND consumed_at_ms >= issued_at_ms AND consumed_at_ms < expires_at_ms)),
    CHECK ((state = 'PUBLISHED' AND phase = 0 AND incarnation_id IS NULL)
        OR (state = 'CLAIMED' AND phase BETWEEN 10 AND 70 AND incarnation_id IS NOT NULL)
        OR (state IN ('REVOKED', 'EXIT_UNCONFIRMED') AND phase = 90)
        OR (state = 'EXIT_CONFIRMED' AND phase = 100)),
    CHECK (phase < 30 OR phase >= 90 OR provider IS NOT NULL)
);
-- @statement
CREATE UNIQUE INDEX only_one_unconfirmed_launch ON launch_records(slot)
    WHERE state <> 'EXIT_CONFIRMED';
-- @statement
CREATE INDEX launch_profile_lookup ON launch_records(profile_id, state);
-- @statement
CREATE TRIGGER profile_update_requires_new_revision BEFORE UPDATE ON profiles
WHEN NEW.id <> OLD.id OR NEW.revision = OLD.revision
BEGIN SELECT RAISE(ABORT, 'profile_revision_required'); END;
-- @statement
CREATE TRIGGER profile_suffix_is_fixed BEFORE INSERT ON profiles
WHEN NOT EXISTS (SELECT 1 FROM profile_ids
    WHERE id = NEW.id AND directory_suffix = NEW.directory_suffix)
BEGIN SELECT RAISE(ABORT, 'profile_identity_mismatch'); END;
-- @statement
CREATE TRIGGER profile_update_suffix_is_fixed BEFORE UPDATE ON profiles
WHEN NEW.directory_suffix <> OLD.directory_suffix
BEGIN SELECT RAISE(ABORT, 'profile_identity_mismatch'); END;
-- @statement
CREATE TRIGGER active_profile_update_blocked BEFORE UPDATE ON profiles
WHEN EXISTS (SELECT 1 FROM launch_records
    WHERE profile_id = OLD.id AND state <> 'EXIT_CONFIRMED')
BEGIN SELECT RAISE(ABORT, 'profile_active'); END;
-- @statement
CREATE TRIGGER active_profile_delete_blocked BEFORE DELETE ON profiles
WHEN EXISTS (SELECT 1 FROM launch_records
    WHERE profile_id = OLD.id AND state <> 'EXIT_CONFIRMED')
BEGIN SELECT RAISE(ABORT, 'profile_active'); END;
-- @statement
CREATE TRIGGER envelope_matches_profile_insert BEFORE INSERT ON credential_envelopes
WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.profile_id
    AND has_credentials = 1 AND credential_revision = NEW.credential_revision)
BEGIN SELECT RAISE(ABORT, 'envelope_profile_mismatch'); END;
-- @statement
CREATE TRIGGER envelope_matches_profile_update BEFORE UPDATE ON credential_envelopes
WHEN NEW.profile_id <> OLD.profile_id OR NOT EXISTS (SELECT 1 FROM profiles
    WHERE id = NEW.profile_id AND has_credentials = 1
        AND credential_revision = NEW.credential_revision)
BEGIN SELECT RAISE(ABORT, 'envelope_profile_mismatch'); END;
-- @statement
CREATE TRIGGER active_envelope_insert_blocked BEFORE INSERT ON credential_envelopes
WHEN EXISTS (SELECT 1 FROM launch_records
    WHERE profile_id = NEW.profile_id AND state <> 'EXIT_CONFIRMED')
BEGIN SELECT RAISE(ABORT, 'profile_active'); END;
-- @statement
CREATE TRIGGER active_envelope_update_blocked BEFORE UPDATE ON credential_envelopes
WHEN EXISTS (SELECT 1 FROM launch_records
    WHERE profile_id = OLD.profile_id AND state <> 'EXIT_CONFIRMED')
BEGIN SELECT RAISE(ABORT, 'profile_active'); END;
-- @statement
CREATE TRIGGER active_envelope_delete_blocked BEFORE DELETE ON credential_envelopes
WHEN EXISTS (SELECT 1 FROM launch_records
    WHERE profile_id = OLD.profile_id AND state <> 'EXIT_CONFIRMED')
BEGIN SELECT RAISE(ABORT, 'profile_active'); END;
-- @statement
CREATE TRIGGER launch_insert_is_current BEFORE INSERT ON launch_records
WHEN NEW.state <> 'PUBLISHED' OR NEW.phase <> 0 OR NEW.incarnation_id IS NOT NULL
    OR NEW.provider IS NOT NULL OR NOT EXISTS (SELECT 1 FROM profiles
        WHERE id = NEW.profile_id AND revision = NEW.profile_revision
            AND spec_json = NEW.spec_json AND config_hash = NEW.config_hash
            AND directory_suffix = NEW.directory_suffix)
BEGIN SELECT RAISE(ABORT, 'launch_snapshot_mismatch'); END;
-- @statement
CREATE TRIGGER launch_snapshot_is_immutable BEFORE UPDATE ON launch_records
WHEN NEW.session_id <> OLD.session_id OR NEW.nonce <> OLD.nonce OR NEW.slot <> OLD.slot
    OR NEW.profile_id <> OLD.profile_id OR NEW.profile_revision <> OLD.profile_revision
    OR NEW.spec_json <> OLD.spec_json OR NEW.config_hash <> OLD.config_hash
    OR NEW.directory_suffix <> OLD.directory_suffix
    OR NEW.issued_at_ms <> OLD.issued_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'launch_snapshot_immutable'); END;
-- @statement
CREATE TRIGGER launch_claim_identity_is_immutable BEFORE UPDATE ON launch_records
WHEN (OLD.incarnation_id IS NOT NULL AND (NEW.incarnation_id IS NOT OLD.incarnation_id
    OR NEW.pid IS NOT OLD.pid OR NEW.consumed_at_ms IS NOT OLD.consumed_at_ms))
    OR (OLD.incarnation_id IS NULL AND NEW.incarnation_id IS NOT NULL
        AND NOT (OLD.state = 'PUBLISHED' AND NEW.state = 'CLAIMED'))
    OR (OLD.provider IS NOT NULL AND NEW.provider IS NOT OLD.provider)
    OR NEW.phase < OLD.phase
BEGIN SELECT RAISE(ABORT, 'launch_identity_immutable'); END;
-- @statement
CREATE TRIGGER launch_state_transition_is_guarded BEFORE UPDATE ON launch_records
WHEN NOT ((OLD.state = 'PUBLISHED'
        AND NEW.state IN ('CLAIMED', 'REVOKED', 'EXIT_UNCONFIRMED'))
    OR (OLD.state = 'CLAIMED' AND NEW.state IN ('CLAIMED', 'EXIT_UNCONFIRMED'))
    OR (OLD.state = 'REVOKED' AND NEW.state IN ('REVOKED', 'EXIT_UNCONFIRMED', 'EXIT_CONFIRMED'))
    OR (OLD.state = 'EXIT_UNCONFIRMED' AND NEW.state IN ('EXIT_UNCONFIRMED', 'EXIT_CONFIRMED')))
BEGIN SELECT RAISE(ABORT, 'launch_transition_rejected'); END;
-- @statement
CREATE TRIGGER launch_history_is_not_deleted BEFORE DELETE ON launch_records
BEGIN SELECT RAISE(ABORT, 'launch_history_required'); END;
-- @statement
CREATE TRIGGER profile_identity_is_not_changed BEFORE UPDATE ON profile_ids
BEGIN SELECT RAISE(ABORT, 'profile_identity_immutable'); END;
-- @statement
CREATE TRIGGER profile_identity_is_not_deleted BEFORE DELETE ON profile_ids
BEGIN SELECT RAISE(ABORT, 'profile_identity_required'); END;
-- @statement
CREATE TRIGGER profile_revision_is_not_changed BEFORE UPDATE ON profile_revisions
BEGIN SELECT RAISE(ABORT, 'profile_revision_immutable'); END;
-- @statement
CREATE TRIGGER profile_revision_is_not_deleted BEFORE DELETE ON profile_revisions
BEGIN SELECT RAISE(ABORT, 'profile_revision_required'); END;
-- @statement
CREATE TRIGGER store_identity_is_not_changed BEFORE UPDATE ON store_meta
BEGIN SELECT RAISE(ABORT, 'store_identity_immutable'); END;
-- @statement
CREATE TRIGGER store_identity_is_not_deleted BEFORE DELETE ON store_meta
BEGIN SELECT RAISE(ABORT, 'store_identity_required'); END;
