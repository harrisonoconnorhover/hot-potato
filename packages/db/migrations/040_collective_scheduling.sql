CREATE TABLE meeting_type_cohosts (
  meeting_type_id uuid NOT NULL
    REFERENCES meeting_types(id) ON DELETE CASCADE,
  rep_id uuid NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  required_for_availability boolean NOT NULL DEFAULT true,
  position smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_type_id, rep_id),
  UNIQUE (meeting_type_id, position),
  CONSTRAINT meeting_type_cohosts_position_check CHECK (
    position BETWEEN 0 AND 9
  )
);

CREATE OR REPLACE FUNCTION hot_potato_validate_meeting_type_cohost()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  meeting_organization_id uuid;
  fixed_organizer_id uuid;
  rep_organization_id uuid;
BEGIN
  SELECT organization_id, rep_id
  INTO meeting_organization_id, fixed_organizer_id
  FROM meeting_types
  WHERE id = NEW.meeting_type_id
  FOR UPDATE;

  SELECT organization_id
  INTO rep_organization_id
  FROM reps
  WHERE id = NEW.rep_id;

  IF meeting_organization_id IS NULL
    OR rep_organization_id IS NULL
    OR meeting_organization_id <> rep_organization_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Meeting co-hosts must belong to the meeting organization.';
  END IF;

  IF fixed_organizer_id = NEW.rep_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The organizer cannot also be configured as a co-host.';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER meeting_type_cohosts_validate
BEFORE INSERT OR UPDATE OF meeting_type_id, rep_id
ON meeting_type_cohosts
FOR EACH ROW
EXECUTE FUNCTION hot_potato_validate_meeting_type_cohost();

CREATE OR REPLACE FUNCTION hot_potato_validate_meeting_type_organizer()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.rep_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM meeting_type_cohosts cohost
    WHERE cohost.meeting_type_id = NEW.id
      AND cohost.rep_id = NEW.rep_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The organizer cannot also be configured as a co-host.';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER meeting_types_validate_organizer
BEFORE UPDATE OF rep_id
ON meeting_types
FOR EACH ROW
EXECUTE FUNCTION hot_potato_validate_meeting_type_organizer();

CREATE TABLE booking_cohosts (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  rep_id uuid NOT NULL REFERENCES reps(id)
    DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  email text NOT NULL,
  required_for_availability boolean NOT NULL,
  position smallint NOT NULL,
  PRIMARY KEY (booking_id, rep_id),
  UNIQUE (booking_id, position),
  CONSTRAINT booking_cohosts_position_check CHECK (
    position BETWEEN 0 AND 9
  )
);

CREATE TABLE booking_rep_reservations (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  rep_id uuid NOT NULL REFERENCES reps(id)
    DEFERRABLE INITIALLY DEFERRED,
  role text NOT NULL,
  status text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reserved_starts_at timestamptz NOT NULL,
  reserved_ends_at timestamptz NOT NULL,
  previous_starts_at timestamptz,
  previous_ends_at timestamptz,
  previous_reserved_starts_at timestamptz,
  previous_reserved_ends_at timestamptz,
  PRIMARY KEY (booking_id, rep_id),
  CONSTRAINT booking_rep_reservations_role_check CHECK (
    role IN ('organizer', 'required_cohost')
  ),
  CONSTRAINT booking_rep_reservations_status_check CHECK (
    status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending',
      'cancelled', 'failed'
    )
  ),
  CONSTRAINT booking_rep_reservations_time_check CHECK (ends_at > starts_at),
  CONSTRAINT booking_rep_reservations_reserved_time_check CHECK (
    reserved_ends_at > reserved_starts_at
  ),
  CONSTRAINT booking_rep_reservations_previous_time_pair_check CHECK (
    (previous_starts_at IS NULL) = (previous_ends_at IS NULL)
  ),
  CONSTRAINT booking_rep_reservations_previous_reserved_pair_check CHECK (
    (previous_reserved_starts_at IS NULL) =
      (previous_reserved_ends_at IS NULL)
  ),
  CONSTRAINT booking_rep_reservations_previous_time_order_check CHECK (
    previous_starts_at IS NULL OR previous_ends_at > previous_starts_at
  ),
  CONSTRAINT booking_rep_reservations_previous_reserved_order_check CHECK (
    previous_reserved_starts_at IS NULL
    OR previous_reserved_ends_at > previous_reserved_starts_at
  )
);

INSERT INTO booking_rep_reservations (
  booking_id, rep_id, role, status, starts_at, ends_at,
  reserved_starts_at, reserved_ends_at,
  previous_starts_at, previous_ends_at,
  previous_reserved_starts_at, previous_reserved_ends_at
)
SELECT
  id, rep_id, 'organizer', status, starts_at, ends_at,
  reserved_starts_at, reserved_ends_at,
  previous_starts_at, previous_ends_at,
  previous_reserved_starts_at, previous_reserved_ends_at
FROM bookings;

ALTER TABLE booking_rep_reservations
  ADD CONSTRAINT booking_rep_reservations_active_time_excl
  EXCLUDE USING gist (
    rep_id WITH =,
    (
      CASE
        WHEN status IN ('reschedule_pending', 'cancel_pending')
          AND previous_reserved_starts_at IS NOT NULL
          AND previous_reserved_ends_at IS NOT NULL
        THEN tstzmultirange(
          tstzrange(reserved_starts_at, reserved_ends_at, '[)'),
          tstzrange(
            previous_reserved_starts_at,
            previous_reserved_ends_at,
            '[)'
          )
        )
        ELSE tstzmultirange(
          tstzrange(reserved_starts_at, reserved_ends_at, '[)')
        )
      END
    ) WITH &&
  )
  WHERE (
    status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    )
  );

CREATE INDEX booking_rep_reservations_capacity_starts_idx
  ON booking_rep_reservations (rep_id, starts_at)
  WHERE status IN (
    'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
  );

CREATE INDEX booking_rep_reservations_capacity_previous_starts_idx
  ON booking_rep_reservations (rep_id, previous_starts_at)
  WHERE previous_starts_at IS NOT NULL
    AND status IN ('reschedule_pending', 'cancel_pending');

DROP TRIGGER IF EXISTS bookings_enforce_rep_meeting_capacity ON bookings;

CREATE OR REPLACE FUNCTION hot_potato_enforce_rep_meeting_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rep_timezone text;
  daily_limit integer;
  weekly_limit integer;
  capacity_start timestamptz;
  capacity_date date;
  capacity_week date;
  used_count integer;
  already_counted_daily boolean;
  already_counted_weekly boolean;
BEGIN
  IF NEW.status NOT IN (
    'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    )
      AND OLD.rep_id = NEW.rep_id
      AND OLD.starts_at = NEW.starts_at
      AND OLD.previous_starts_at IS NOT DISTINCT FROM NEW.previous_starts_at
    THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT timezone, daily_meeting_limit, weekly_meeting_limit
  INTO rep_timezone, daily_limit, weekly_limit
  FROM reps
  WHERE id = NEW.rep_id;

  IF daily_limit IS NULL AND weekly_limit IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW.rep_id::text));

  FOR capacity_start IN
    SELECT DISTINCT candidate.starts_at
    FROM (
      VALUES
        (NEW.starts_at),
        (
          CASE
            WHEN NEW.status IN ('reschedule_pending', 'cancel_pending')
              THEN NEW.previous_starts_at
            ELSE NULL
          END
        )
    ) AS candidate(starts_at)
    WHERE candidate.starts_at IS NOT NULL
  LOOP
    capacity_date := (capacity_start AT TIME ZONE rep_timezone)::date;
    capacity_week := date_trunc(
      'week', capacity_start AT TIME ZONE rep_timezone
    )::date;

    already_counted_daily := false;
    already_counted_weekly := false;
    IF TG_OP = 'UPDATE' AND OLD.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    ) THEN
      SELECT
        coalesce(bool_or(
          (old_start.starts_at AT TIME ZONE rep_timezone)::date = capacity_date
        ), false),
        coalesce(bool_or(
          date_trunc(
            'week', old_start.starts_at AT TIME ZONE rep_timezone
          )::date = capacity_week
        ), false)
      INTO already_counted_daily, already_counted_weekly
      FROM (
        SELECT DISTINCT candidate.starts_at
        FROM (
          VALUES
            (OLD.starts_at),
            (
              CASE
                WHEN OLD.status IN ('reschedule_pending', 'cancel_pending')
                  THEN OLD.previous_starts_at
                ELSE NULL
              END
            )
        ) AS candidate(starts_at)
        WHERE candidate.starts_at IS NOT NULL
      ) old_start;
    END IF;

    IF daily_limit IS NOT NULL AND NOT already_counted_daily THEN
      SELECT count(DISTINCT reservation.booking_id)::integer
      INTO used_count
      FROM booking_rep_reservations reservation
      CROSS JOIN LATERAL (
        SELECT DISTINCT candidate.starts_at
        FROM (
          VALUES
            (reservation.starts_at),
            (
              CASE
                WHEN reservation.status IN (
                  'reschedule_pending', 'cancel_pending'
                ) THEN reservation.previous_starts_at
                ELSE NULL
              END
            )
        ) AS candidate(starts_at)
        WHERE candidate.starts_at IS NOT NULL
      ) active_start
      WHERE reservation.rep_id = NEW.rep_id
        AND reservation.booking_id <> NEW.booking_id
        AND reservation.status IN (
          'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
        )
        AND (active_start.starts_at AT TIME ZONE rep_timezone)::date = capacity_date;

      IF used_count >= daily_limit THEN
        RAISE EXCEPTION USING
          ERRCODE = '23P01',
          CONSTRAINT = 'booking_rep_reservations_meeting_capacity_check',
          MESSAGE = 'Representative daily meeting capacity is full.';
      END IF;
    END IF;

    IF weekly_limit IS NOT NULL AND NOT already_counted_weekly THEN
      SELECT count(DISTINCT reservation.booking_id)::integer
      INTO used_count
      FROM booking_rep_reservations reservation
      CROSS JOIN LATERAL (
        SELECT DISTINCT candidate.starts_at
        FROM (
          VALUES
            (reservation.starts_at),
            (
              CASE
                WHEN reservation.status IN (
                  'reschedule_pending', 'cancel_pending'
                ) THEN reservation.previous_starts_at
                ELSE NULL
              END
            )
        ) AS candidate(starts_at)
        WHERE candidate.starts_at IS NOT NULL
      ) active_start
      WHERE reservation.rep_id = NEW.rep_id
        AND reservation.booking_id <> NEW.booking_id
        AND reservation.status IN (
          'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
        )
        AND date_trunc(
          'week', active_start.starts_at AT TIME ZONE rep_timezone
        )::date = capacity_week;

      IF used_count >= weekly_limit THEN
        RAISE EXCEPTION USING
          ERRCODE = '23P01',
          CONSTRAINT = 'booking_rep_reservations_meeting_capacity_check',
          MESSAGE = 'Representative weekly meeting capacity is full.';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END
$function$;

CREATE TRIGGER booking_rep_reservations_enforce_capacity
BEFORE INSERT OR UPDATE OF rep_id, starts_at, previous_starts_at, status
ON booking_rep_reservations
FOR EACH ROW
EXECUTE FUNCTION hot_potato_enforce_rep_meeting_capacity();

CREATE OR REPLACE FUNCTION hot_potato_snapshot_booking_participants()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM meeting_type_cohosts configured
    JOIN reps rep ON rep.id = configured.rep_id
    WHERE configured.meeting_type_id = NEW.meeting_type_id
      AND configured.required_for_availability
      AND configured.rep_id <> NEW.rep_id
      AND NOT rep.active
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A required co-host is no longer active.';
  END IF;

  INSERT INTO booking_cohosts (
    booking_id, rep_id, name, email, required_for_availability, position
  )
  SELECT
    NEW.id, configured.rep_id, rep.name, rep.email,
    configured.required_for_availability, configured.position
  FROM meeting_type_cohosts configured
  JOIN reps rep ON rep.id = configured.rep_id
  WHERE configured.meeting_type_id = NEW.meeting_type_id
    AND configured.rep_id <> NEW.rep_id
    AND rep.active
  ORDER BY configured.position;

  INSERT INTO booking_rep_reservations (
    booking_id, rep_id, role, status, starts_at, ends_at,
    reserved_starts_at, reserved_ends_at,
    previous_starts_at, previous_ends_at,
    previous_reserved_starts_at, previous_reserved_ends_at
  )
  SELECT
    participant.booking_id, participant.rep_id, participant.role,
    NEW.status, NEW.starts_at, NEW.ends_at,
    NEW.reserved_starts_at, NEW.reserved_ends_at,
    NEW.previous_starts_at, NEW.previous_ends_at,
    NEW.previous_reserved_starts_at, NEW.previous_reserved_ends_at
  FROM (
    SELECT NEW.id AS booking_id, NEW.rep_id AS rep_id, 'organizer' AS role
    UNION ALL
    SELECT NEW.id, cohost.rep_id, 'required_cohost'
    FROM booking_cohosts cohost
    WHERE cohost.booking_id = NEW.id
      AND cohost.required_for_availability
      AND cohost.rep_id <> NEW.rep_id
  ) participant
  ORDER BY participant.rep_id;

  RETURN NEW;
END
$function$;

CREATE TRIGGER bookings_snapshot_participants
AFTER INSERT ON bookings
FOR EACH ROW
EXECUTE FUNCTION hot_potato_snapshot_booking_participants();

CREATE OR REPLACE FUNCTION hot_potato_sync_booking_participant_reservations()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE booking_rep_reservations reservation
  SET role = CASE
        WHEN reservation.rep_id = NEW.rep_id THEN 'organizer'
        ELSE 'required_cohost'
      END,
      status = NEW.status,
      starts_at = NEW.starts_at,
      ends_at = NEW.ends_at,
      reserved_starts_at = NEW.reserved_starts_at,
      reserved_ends_at = NEW.reserved_ends_at,
      previous_starts_at = NEW.previous_starts_at,
      previous_ends_at = NEW.previous_ends_at,
      previous_reserved_starts_at = NEW.previous_reserved_starts_at,
      previous_reserved_ends_at = NEW.previous_reserved_ends_at
  WHERE reservation.booking_id = NEW.id
    AND (
      reservation.rep_id = NEW.rep_id
      OR EXISTS (
        SELECT 1
        FROM booking_cohosts cohost
        WHERE cohost.booking_id = NEW.id
          AND cohost.required_for_availability
          AND cohost.rep_id = reservation.rep_id
          AND cohost.rep_id <> NEW.rep_id
      )
    );

  INSERT INTO booking_rep_reservations (
    booking_id, rep_id, role, status, starts_at, ends_at,
    reserved_starts_at, reserved_ends_at,
    previous_starts_at, previous_ends_at,
    previous_reserved_starts_at, previous_reserved_ends_at
  )
  SELECT
    participant.booking_id, participant.rep_id, participant.role,
    NEW.status, NEW.starts_at, NEW.ends_at,
    NEW.reserved_starts_at, NEW.reserved_ends_at,
    NEW.previous_starts_at, NEW.previous_ends_at,
    NEW.previous_reserved_starts_at, NEW.previous_reserved_ends_at
  FROM (
    SELECT NEW.id AS booking_id, NEW.rep_id AS rep_id, 'organizer' AS role
    UNION ALL
    SELECT NEW.id, cohost.rep_id, 'required_cohost'
    FROM booking_cohosts cohost
    WHERE cohost.booking_id = NEW.id
      AND cohost.required_for_availability
      AND cohost.rep_id <> NEW.rep_id
  ) participant
  WHERE NOT EXISTS (
    SELECT 1
    FROM booking_rep_reservations reservation
    WHERE reservation.booking_id = participant.booking_id
      AND reservation.rep_id = participant.rep_id
  )
  ORDER BY participant.rep_id;

  DELETE FROM booking_rep_reservations reservation
  WHERE reservation.booking_id = NEW.id
    AND reservation.rep_id <> NEW.rep_id
    AND NOT EXISTS (
      SELECT 1
      FROM booking_cohosts cohost
      WHERE cohost.booking_id = NEW.id
        AND cohost.required_for_availability
        AND cohost.rep_id = reservation.rep_id
    );

  RETURN NEW;
END
$function$;

CREATE TRIGGER bookings_sync_participant_reservations
AFTER UPDATE OF
  rep_id, status, starts_at, ends_at, reserved_starts_at, reserved_ends_at,
  previous_starts_at, previous_ends_at,
  previous_reserved_starts_at, previous_reserved_ends_at
ON bookings
FOR EACH ROW
EXECUTE FUNCTION hot_potato_sync_booking_participant_reservations();
