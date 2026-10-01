ALTER TABLE outlook_email_identities
  ALTER COLUMN asserted_email DROP NOT NULL;

ALTER TABLE outlook_email_identities
  DROP CONSTRAINT outlook_email_identities_email_check;

ALTER TABLE outlook_email_identities
  ADD CONSTRAINT outlook_email_identities_email_check
  CHECK (
    asserted_email IS NULL OR char_length(asserted_email) BETWEEN 3 AND 320
  );
