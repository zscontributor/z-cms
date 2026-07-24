-- The marketplace API token this person minted for this instance.
--
-- Encrypted the way the SMTP password is (AES-256-GCM under an env key), and NOT
-- the way the publisher key in the same row is. The asymmetry is deliberate:
--
--   the key   nothing on this server ever needs it, so it is sealed under a
--             passphrase the server does not have.
--   the token cms-api MUST use it — it is what authenticates the POST upstream — so
--             it is encrypted with a key cms-api holds. A secret the server has to
--             use is a secret the server can read; pretending otherwise is theatre.
--
-- Guarded differently on purpose: the token submits, the key signs, and the
-- marketplace's accept() needs both. Stealing one is not enough.

ALTER TABLE "publisher_key_vaults" ADD COLUMN "marketplace_token" TEXT;
