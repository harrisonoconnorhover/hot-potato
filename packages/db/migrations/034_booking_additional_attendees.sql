ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS additional_attendee_emails text[]
    NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE bookings
  ADD CONSTRAINT bookings_additional_attendees_shape_check CHECK (
    cardinality(additional_attendee_emails) BETWEEN 0 AND 5
    AND array_ndims(additional_attendee_emails) <= 1
    AND array_position(additional_attendee_emails, NULL) IS NULL
    AND array_position(additional_attendee_emails, '') IS NULL
  );
