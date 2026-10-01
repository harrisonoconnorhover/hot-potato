ALTER TABLE meeting_types
  ADD COLUMN invitee_limit_scope text NOT NULL DEFAULT 'none',
  ADD COLUMN invitee_limit_count integer,
  ADD COLUMN reschedule_cutoff_minutes integer,
  ADD COLUMN cancel_cutoff_minutes integer,
  ADD CONSTRAINT meeting_types_invitee_limit_scope_check CHECK (
    invitee_limit_scope IN ('none', 'email', 'domain')
  ),
  ADD CONSTRAINT meeting_types_invitee_limit_pair_check CHECK (
    (invitee_limit_scope = 'none' AND invitee_limit_count IS NULL)
    OR (
      invitee_limit_scope IN ('email', 'domain')
      AND invitee_limit_count BETWEEN 1 AND 100
    )
  ),
  ADD CONSTRAINT meeting_types_reschedule_cutoff_check CHECK (
    reschedule_cutoff_minutes IS NULL
    OR reschedule_cutoff_minutes BETWEEN 0 AND 43200
  ),
  ADD CONSTRAINT meeting_types_cancel_cutoff_check CHECK (
    cancel_cutoff_minutes IS NULL
    OR cancel_cutoff_minutes BETWEEN 0 AND 43200
  );

-- A booking keeps the lifecycle policy the invitee accepted. Editing the
-- meeting type affects future bookings without silently changing old links.
ALTER TABLE bookings
  ADD COLUMN reschedule_cutoff_minutes integer,
  ADD COLUMN cancel_cutoff_minutes integer,
  ADD CONSTRAINT bookings_reschedule_cutoff_check CHECK (
    reschedule_cutoff_minutes IS NULL
    OR reschedule_cutoff_minutes BETWEEN 0 AND 43200
  ),
  ADD CONSTRAINT bookings_cancel_cutoff_check CHECK (
    cancel_cutoff_minutes IS NULL
    OR cancel_cutoff_minutes BETWEEN 0 AND 43200
  );

CREATE INDEX bookings_meeting_type_invitee_email_idx
  ON bookings (meeting_type_id, (lower(attendee_email)), ends_at)
  WHERE status IN (
    'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
  );

CREATE INDEX bookings_meeting_type_invitee_domain_idx
  ON bookings (
    meeting_type_id,
    (split_part(lower(attendee_email), '@', 2)),
    ends_at
  )
  WHERE status IN (
    'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
  );
