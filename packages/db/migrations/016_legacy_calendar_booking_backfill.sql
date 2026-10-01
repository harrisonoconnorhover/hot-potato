ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS attendee_notifications_enabled boolean
    NOT NULL DEFAULT true;

ALTER TABLE bookings
  ALTER COLUMN manage_token_hash DROP NOT NULL;

DO $migration$
#variable_conflict use_variable
DECLARE
  calendar_job record;
  organization_slug text;
  booking_id_text text;
  booking_id uuid;
  external_id text;
  rep_id_text text;
  rep_id uuid;
  rep_name text;
  rep_email text;
  rep_timezone text;
  rep_scheduling_slug text;
  decision_id_text text;
  decision_id uuid;
  decision_lead_email text;
  decision_lead jsonb;
  decision_rep_id uuid;
  requested_scheduling_slug text;
  meeting_type_id uuid;
  meeting_type_slug text;
  meeting_type_title text;
  meeting_type_zoom_join_url text;
  starts_at timestamptz;
  ends_at timestamptz;
  calendar_provider text;
  conference_provider text;
  conference_url text;
  subject text;
  description text;
  reminder_minutes integer;
  attendee_name text;
  attendee_email text;
  payload_attendee_email text;
  notifications_enabled boolean;
  attendee_notifications_value text;
  booking_status text;
  external_event_id text;
  external_event_web_link text;
  manage_token_hash text;
  existing_booking_id uuid;
  existing_booking_rep_id uuid;
  existing_booking_meeting_type_id uuid;
  existing_booking_decision_id uuid;
  existing_booking_status text;
  existing_booking_starts_at timestamptz;
  existing_booking_ends_at timestamptz;
  existing_booking_calendar_provider text;
  existing_booking_attendee_email text;
  existing_booking_external_event_id text;
  existing_booking_router_session_id uuid;
  existing_booking_notifications_enabled boolean;
  conflicting_booking record;
BEGIN
  LOCK TABLE jobs, bookings IN SHARE ROW EXCLUSIVE MODE;

  FOR calendar_job IN
    SELECT id, organization_id, payload, status, result, last_error,
           created_at, completed_at
    FROM jobs
    WHERE type = 'calendar.event.create'
    ORDER BY id
    FOR UPDATE
  LOOP
    IF jsonb_typeof(calendar_job.payload) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: payload must be a JSON object.',
          calendar_job.id
        ),
        HINT = 'Repair or remove the malformed calendar.event.create job, then rerun the migration.';
    END IF;

    IF calendar_job.status NOT IN (
      'pending', 'processing', 'completed', 'failed', 'cancelled'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: unsupported job status %s.',
          calendar_job.id,
          calendar_job.status
        ),
        HINT = 'Move the job to pending, processing, completed, failed, or cancelled after verifying its provider state, then rerun the migration.';
    END IF;

    SELECT slug
    INTO organization_slug
    FROM organizations
    WHERE id = calendar_job.organization_id;

    external_id := calendar_job.payload->>'externalId';
    IF external_id IS NULL OR external_id = '' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: payload.externalId is missing.',
          calendar_job.id
        ),
        HINT = 'Restore the original idempotency key in payload.externalId, then rerun the migration.';
    END IF;

    IF nullif(btrim(calendar_job.payload->>'organizationSlug'), '') IS NOT NULL
       AND btrim(calendar_job.payload->>'organizationSlug') <> organization_slug THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: payload.organizationSlug does not match its organization.',
          calendar_job.id
        ),
        HINT = 'Correct the job organization or payload organizationSlug, then rerun the migration.';
    END IF;

    booking_id_text := nullif(btrim(calendar_job.payload->>'bookingId'), '');
    IF booking_id_text IS NOT NULL THEN
      IF booking_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot validate calendar job %s: payload.bookingId is not a UUID.',
            calendar_job.id
          ),
          HINT = 'Restore the booking UUID or remove bookingId so the legacy job can be backfilled, then rerun the migration.';
      END IF;
      booking_id := booking_id_text::uuid;

      SELECT b.id, b.rep_id, b.status, b.external_event_id,
             b.calendar_provider, b.starts_at, b.ends_at,
             b.routing_decision_id, b.router_session_id,
             b.attendee_email, b.attendee_notifications_enabled
      INTO existing_booking_id, existing_booking_rep_id,
           existing_booking_status, existing_booking_external_event_id,
           existing_booking_calendar_provider, existing_booking_starts_at,
           existing_booking_ends_at, existing_booking_decision_id,
           existing_booking_router_session_id, existing_booking_attendee_email,
           existing_booking_notifications_enabled
      FROM bookings b
      WHERE b.id = booking_id
        AND b.organization_id = calendar_job.organization_id
        AND b.external_id = external_id;

      IF existing_booking_id IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot validate calendar job %s: bookingId %s does not identify the same organization and externalId.',
            calendar_job.id,
            booking_id
          ),
          HINT = 'Repair the job-to-booking link before dropping the legacy calendar slot index.';
      END IF;

      rep_id_text := nullif(btrim(calendar_job.payload->>'repId'), '');
      calendar_provider := nullif(
        btrim(calendar_job.payload->>'provider'),
        ''
      );
      IF rep_id_text IS NULL
         OR rep_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR rep_id_text::uuid IS DISTINCT FROM existing_booking_rep_id
         OR calendar_provider NOT IN ('google', 'microsoft')
         OR calendar_provider IS DISTINCT FROM existing_booking_calendar_provider THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot validate calendar job %s: rep or provider does not match linked booking %s.',
            calendar_job.id,
            booking_id
          ),
          HINT = 'Repair the stable rep/provider identity in the job payload before rerunning the migration.';
      END IF;

      IF calendar_job.status IN ('pending', 'processing')
      THEN
        BEGIN
          starts_at := (calendar_job.payload->>'startsAt')::timestamptz;
          ends_at := (calendar_job.payload->>'endsAt')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Cannot validate active calendar job %s: startsAt or endsAt is invalid.',
              calendar_job.id
            ),
            HINT = 'Restore the exact reserved range in the job payload, then rerun the migration.';
        END;
        IF starts_at IS NULL OR ends_at IS NULL OR ends_at <= starts_at
           OR existing_booking_status <> 'pending'
           OR existing_booking_starts_at IS DISTINCT FROM starts_at
           OR existing_booking_ends_at IS DISTINCT FROM ends_at THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Cannot validate active calendar job %s: linked booking %s is not pending on the same range.',
              calendar_job.id,
              booking_id
            ),
            HINT = 'Reconcile the job payload with the pending booking reservation, then rerun the migration.';
        END IF;
        IF NOT EXISTS (
             SELECT 1
             FROM rep_calendar_connections connection
             WHERE connection.rep_id = existing_booking_rep_id
               AND connection.provider = existing_booking_calendar_provider
           ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Cannot validate active calendar job %s: its rep/provider connection is missing.',
              calendar_job.id
            ),
            HINT = 'Reconnect the original provider or fail the job after verifying provider state, then rerun the migration.';
        END IF;
      END IF;

      external_event_id := coalesce(
        nullif(btrim(calendar_job.result->>'externalEventId'), ''),
        nullif(btrim(existing_booking_external_event_id), '')
      );
      IF calendar_job.status = 'completed'
         AND nullif(btrim(calendar_job.result->>'externalEventId'), '') IS NOT NULL
         AND nullif(btrim(existing_booking_external_event_id), '') IS NOT NULL
         AND btrim(calendar_job.result->>'externalEventId')
             <> btrim(existing_booking_external_event_id) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot validate completed calendar job %s: linked booking %s has a different provider event ID.',
            calendar_job.id,
            booking_id
          ),
          HINT = 'Verify the provider event and repair the stale job or booking evidence, then rerun the migration.';
      END IF;
      IF calendar_job.status = 'completed' AND external_event_id IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot validate completed calendar job %s: no provider event ID is recorded.',
            calendar_job.id
          ),
          HINT = 'Restore result.externalEventId or bookings.external_event_id from the calendar provider, then rerun the migration.';
      END IF;
      IF calendar_job.status IN ('failed', 'cancelled')
         AND existing_booking_status <> 'failed' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot validate failed calendar job %s: linked booking %s is not failed.',
            calendar_job.id,
            booking_id
          ),
          HINT = 'Reconcile the job and booking statuses before rerunning the migration.';
      END IF;
      IF calendar_job.status = 'completed'
         AND existing_booking_status = 'failed' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot validate completed calendar job %s: linked booking %s is failed.',
            calendar_job.id,
            booking_id
          ),
          HINT = 'Reconcile the provider completion and booking status before rerunning the migration.';
      END IF;
      IF calendar_job.status = 'completed' THEN
        external_event_web_link := nullif(
          btrim(calendar_job.result->>'webLink'),
          ''
        );
        conference_url := nullif(
          btrim(calendar_job.result->>'conferenceUrl'),
          ''
        );
        UPDATE bookings b
        SET status = CASE
              WHEN b.status = 'pending' THEN 'confirmed'
              ELSE b.status
            END,
            external_event_id = coalesce(
              nullif(b.external_event_id, ''),
              external_event_id
            ),
            external_event_web_link = coalesce(
              b.external_event_web_link,
              external_event_web_link
            ),
            conference_url = coalesce(b.conference_url, conference_url),
            updated_at = greatest(
              b.updated_at,
              coalesce(calendar_job.completed_at, calendar_job.created_at)
            )
        WHERE b.id = booking_id;
      END IF;

      attendee_notifications_value := calendar_job.payload
        ->>'attendeeNotificationsEnabled';
      IF calendar_job.payload ? 'attendeeNotificationsEnabled'
         AND (
           attendee_notifications_value IS NULL
           OR attendee_notifications_value NOT IN ('true', 'false')
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot validate calendar job %s: attendeeNotificationsEnabled must be boolean.',
            calendar_job.id
          ),
          HINT = 'Set attendeeNotificationsEnabled to true or false, then rerun the migration.';
      END IF;
      notifications_enabled := CASE
        WHEN calendar_job.payload ? 'attendeeNotificationsEnabled'
          THEN attendee_notifications_value::boolean
        WHEN existing_booking_decision_id IS NOT NULL
             AND existing_booking_router_session_id IS NULL
          THEN nullif(
            btrim(calendar_job.payload->>'attendeeEmail'),
            ''
          ) IS NOT NULL
        ELSE true
      END;
      UPDATE bookings b
      SET attendee_notifications_enabled = notifications_enabled,
          updated_at = greatest(b.updated_at, calendar_job.created_at)
      WHERE b.id = booking_id;
      UPDATE jobs
      SET payload = payload || jsonb_build_object(
        'attendeeNotificationsEnabled', notifications_enabled,
        'attendeeEmail', CASE
          WHEN notifications_enabled THEN to_jsonb(coalesce(
            nullif(btrim(payload->>'attendeeEmail'), ''),
            existing_booking_attendee_email
          ))
          ELSE 'null'::jsonb
        END
      )
      WHERE id = calendar_job.id;

      CONTINUE;
    END IF;

    rep_id_text := nullif(btrim(calendar_job.payload->>'repId'), '');
    IF rep_id_text IS NULL
       OR rep_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: payload.repId is missing or invalid.',
          calendar_job.id
        ),
        HINT = 'Restore the routed representative UUID in payload.repId, then rerun the migration.';
    END IF;
    rep_id := rep_id_text::uuid;

    SELECT r.name, r.email, r.timezone, r.scheduling_slug
    INTO rep_name, rep_email, rep_timezone, rep_scheduling_slug
    FROM reps r
    WHERE r.id = rep_id AND r.organization_id = calendar_job.organization_id;
    IF rep_name IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: rep %s is not in the job organization.',
          calendar_job.id,
          rep_id
        ),
        HINT = 'Restore the original representative or retire the malformed job, then rerun the migration.';
    END IF;

    BEGIN
      starts_at := (calendar_job.payload->>'startsAt')::timestamptz;
      ends_at := (calendar_job.payload->>'endsAt')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: startsAt or endsAt is not a valid timestamp.',
          calendar_job.id
        ),
        HINT = 'Restore valid ISO timestamps in the job payload, then rerun the migration.';
    END;
    IF starts_at IS NULL OR ends_at IS NULL OR ends_at <= starts_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: its meeting range is empty or reversed.',
          calendar_job.id
        ),
        HINT = 'Correct payload.startsAt and payload.endsAt, then rerun the migration.';
    END IF;

    calendar_provider := nullif(btrim(calendar_job.payload->>'provider'), '');
    IF calendar_provider IS NULL
       OR calendar_provider NOT IN ('google', 'microsoft') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: provider must be google or microsoft.',
          calendar_job.id
        ),
        HINT = 'Restore the provider that received or should receive the calendar event, then rerun the migration.';
    END IF;
    IF calendar_job.status IN ('pending', 'processing')
       AND NOT EXISTS (
         SELECT 1
         FROM rep_calendar_connections connection
         WHERE connection.rep_id = rep_id
           AND connection.provider = calendar_provider
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill active calendar job %s: rep %s has no %s connection.',
          calendar_job.id,
          rep_id,
          calendar_provider
        ),
        HINT = 'Reconnect the original provider or fail the job after verifying provider state, then rerun the migration.';
    END IF;

    decision_id := NULL;
    decision_lead_email := NULL;
    decision_lead := NULL;
    decision_rep_id := NULL;
    decision_id_text := nullif(btrim(calendar_job.payload->>'decisionId'), '');
    IF decision_id_text IS NOT NULL THEN
      IF decision_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot backfill calendar job %s: payload.decisionId is not a UUID.',
            calendar_job.id
          ),
          HINT = 'Restore the routing decision UUID, then rerun the migration.';
      END IF;
      decision_id := decision_id_text::uuid;
      SELECT rd.lead_email, rd.lead, rd.rep_id
      INTO decision_lead_email, decision_lead, decision_rep_id
      FROM routing_decisions rd
      WHERE rd.id = decision_id
        AND rd.organization_id = calendar_job.organization_id;
      IF decision_lead_email IS NULL OR decision_rep_id IS DISTINCT FROM rep_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot backfill calendar job %s: routing decision %s is missing or points to another representative.',
            calendar_job.id,
            decision_id
          ),
          HINT = 'Repair payload.decisionId or payload.repId from the original routing decision, then rerun the migration.';
      END IF;

      payload_attendee_email := nullif(
        btrim(calendar_job.payload->>'attendeeEmail'),
        ''
      );
      attendee_email := coalesce(
        payload_attendee_email,
        nullif(btrim(decision_lead_email), '')
      );
      attendee_name := coalesce(
        nullif(btrim(calendar_job.payload->>'attendeeName'), ''),
        nullif(btrim(decision_lead->>'name'), ''),
        attendee_email
      );
    ELSE
      IF calendar_job.payload->>'publicBooking' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot backfill calendar job %s: it has neither a routing decision nor a public-booking identity.',
            calendar_job.id
          ),
          HINT = 'Restore payload.decisionId for a routed booking, or publicBooking plus attendee identity for a public booking.';
      END IF;
      payload_attendee_email := nullif(
        btrim(calendar_job.payload->>'attendeeEmail'),
        ''
      );
      attendee_email := payload_attendee_email;
      attendee_name := coalesce(
        nullif(btrim(calendar_job.payload->>'attendeeName'), ''),
        attendee_email
      );
    END IF;
    IF attendee_email IS NULL OR attendee_name IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: attendee identity is incomplete.',
          calendar_job.id
        ),
        HINT = 'Restore attendeeEmail and attendeeName, or the routed lead identity, then rerun the migration.';
    END IF;

    attendee_notifications_value := calendar_job.payload
      ->>'attendeeNotificationsEnabled';
    IF calendar_job.payload ? 'attendeeNotificationsEnabled'
       AND (
         attendee_notifications_value IS NULL
         OR attendee_notifications_value NOT IN ('true', 'false')
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: attendeeNotificationsEnabled must be boolean.',
          calendar_job.id
        ),
        HINT = 'Set attendeeNotificationsEnabled to true or false, then rerun the migration.';
    END IF;
    notifications_enabled := CASE
      WHEN calendar_job.payload ? 'attendeeNotificationsEnabled'
        THEN attendee_notifications_value::boolean
      WHEN decision_id IS NOT NULL THEN payload_attendee_email IS NOT NULL
      ELSE true
    END;

    meeting_type_id := NULL;
    meeting_type_slug := NULL;
    requested_scheduling_slug := nullif(
      btrim(calendar_job.payload->>'schedulingSlug'),
      ''
    );
    IF requested_scheduling_slug IS NOT NULL THEN
      SELECT mt.id, mt.slug, mt.title, mt.zoom_join_url
      INTO meeting_type_id, meeting_type_slug, meeting_type_title,
           meeting_type_zoom_join_url
      FROM meeting_types mt
      WHERE mt.organization_id = calendar_job.organization_id
        AND mt.slug = requested_scheduling_slug
        AND mt.rep_id = rep_id;
    END IF;

    IF meeting_type_id IS NULL THEN
      SELECT mt.id, mt.slug, mt.title, mt.zoom_join_url
      INTO meeting_type_id, meeting_type_slug, meeting_type_title,
           meeting_type_zoom_join_url
      FROM meeting_types mt
      WHERE mt.organization_id = calendar_job.organization_id
        AND mt.rep_id = rep_id
        AND mt.slug = rep_scheduling_slug;
    END IF;

    IF meeting_type_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: no compatible meeting type exists for rep %s.',
          calendar_job.id,
          rep_id
        ),
        HINT = 'Restore the historical schedulingSlug meeting type or the rep default meeting type, then rerun the migration.';
    END IF;

    conference_provider := coalesce(
      nullif(btrim(calendar_job.payload->>'conferenceProvider'), ''),
      'none'
    );
    IF conference_provider NOT IN (
      'none', 'google_meet', 'microsoft_teams', 'zoom'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: conferenceProvider is unsupported.',
          calendar_job.id
        ),
        HINT = 'Use none, google_meet, microsoft_teams, or zoom, then rerun the migration.';
    END IF;
    IF (conference_provider = 'google_meet' AND calendar_provider <> 'google')
       OR (conference_provider = 'microsoft_teams' AND calendar_provider <> 'microsoft') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: conference and calendar providers are incompatible.',
          calendar_job.id
        ),
        HINT = 'Restore the provider combination used by the original booking, then rerun the migration.';
    END IF;

    subject := coalesce(
      nullif(btrim(calendar_job.payload->>'subject'), ''),
      meeting_type_title
    );
    description := coalesce(calendar_job.payload->>'description', '');
    IF nullif(btrim(calendar_job.payload->>'reminderMinutes'), '') IS NULL THEN
      reminder_minutes := 0;
    ELSIF btrim(calendar_job.payload->>'reminderMinutes') !~ '^[0-9]+$'
          OR char_length(btrim(calendar_job.payload->>'reminderMinutes')) > 5 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill calendar job %s: reminderMinutes is invalid.',
          calendar_job.id
        ),
        HINT = 'Use a whole number from 0 through 43200, then rerun the migration.';
    ELSE
      reminder_minutes := (calendar_job.payload->>'reminderMinutes')::integer;
      IF reminder_minutes > 43200 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot backfill calendar job %s: reminderMinutes exceeds 43200.',
            calendar_job.id
          ),
          HINT = 'Use a whole number from 0 through 43200, then rerun the migration.';
      END IF;
    END IF;

    booking_status := CASE calendar_job.status
      WHEN 'completed' THEN 'confirmed'
      WHEN 'failed' THEN 'failed'
      WHEN 'cancelled' THEN 'failed'
      ELSE 'pending'
    END;
    external_event_id := nullif(
      btrim(calendar_job.result->>'externalEventId'),
      ''
    );
    external_event_web_link := nullif(
      btrim(calendar_job.result->>'webLink'),
      ''
    );
    conference_url := coalesce(
      nullif(btrim(calendar_job.result->>'conferenceUrl'), ''),
      nullif(btrim(calendar_job.payload->>'conferenceUrl'), ''),
      CASE
        WHEN conference_provider = 'zoom' THEN meeting_type_zoom_join_url
        ELSE NULL
      END
    );
    manage_token_hash := CASE
      WHEN external_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN encode(digest(external_id, 'sha256'), 'hex')
      ELSE NULL
    END;

    existing_booking_id := NULL;
    existing_booking_rep_id := NULL;
    existing_booking_meeting_type_id := NULL;
    existing_booking_decision_id := NULL;
    existing_booking_status := NULL;
    existing_booking_starts_at := NULL;
    existing_booking_ends_at := NULL;
    existing_booking_calendar_provider := NULL;
    existing_booking_attendee_email := NULL;
    existing_booking_external_event_id := NULL;
    existing_booking_notifications_enabled := NULL;
    SELECT b.id, b.rep_id, b.meeting_type_id, b.routing_decision_id,
           b.status, b.starts_at, b.ends_at, b.calendar_provider,
           b.attendee_email, b.external_event_id,
           b.attendee_notifications_enabled
    INTO existing_booking_id, existing_booking_rep_id,
         existing_booking_meeting_type_id, existing_booking_decision_id,
         existing_booking_status, existing_booking_starts_at,
         existing_booking_ends_at, existing_booking_calendar_provider,
         existing_booking_attendee_email, existing_booking_external_event_id,
         existing_booking_notifications_enabled
    FROM bookings b
    WHERE b.organization_id = calendar_job.organization_id
      AND b.external_id = external_id;

    IF existing_booking_id IS NOT NULL THEN
      IF existing_booking_rep_id IS DISTINCT FROM rep_id
         OR existing_booking_meeting_type_id IS DISTINCT FROM meeting_type_id
         OR existing_booking_decision_id IS DISTINCT FROM decision_id
         OR existing_booking_calendar_provider IS DISTINCT FROM calendar_provider
         OR lower(existing_booking_attendee_email) IS DISTINCT FROM lower(attendee_email) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot link calendar job %s: existing booking %s has different routing or attendee identity.',
            calendar_job.id,
            existing_booking_id
          ),
          HINT = 'Reconcile the booking and job identities before rerunning the migration.';
      END IF;
      IF calendar_job.status IN ('pending', 'processing')
         AND (
           existing_booking_status <> 'pending'
           OR existing_booking_starts_at IS DISTINCT FROM starts_at
           OR existing_booking_ends_at IS DISTINCT FROM ends_at
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot link active calendar job %s: existing booking %s does not reserve the requested range.',
            calendar_job.id,
            existing_booking_id
          ),
          HINT = 'Reconcile the booking range and status before rerunning the migration.';
      END IF;
      IF calendar_job.status IN ('failed', 'cancelled')
         AND existing_booking_status <> 'failed' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot link failed calendar job %s: existing booking %s is not failed.',
            calendar_job.id,
            existing_booking_id
          ),
          HINT = 'Reconcile the job and booking statuses before rerunning the migration.';
      END IF;
      IF calendar_job.status = 'completed'
         AND existing_booking_status = 'failed' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot link completed calendar job %s: existing booking %s is failed.',
            calendar_job.id,
            existing_booking_id
          ),
          HINT = 'Reconcile the provider completion and booking status before rerunning the migration.';
      END IF;
      IF external_event_id IS NOT NULL
         AND nullif(btrim(existing_booking_external_event_id), '') IS NOT NULL
         AND external_event_id <> existing_booking_external_event_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format(
            'Cannot link completed calendar job %s: provider event IDs disagree.',
            calendar_job.id
          ),
          HINT = 'Verify the provider event and repair the stale job or booking evidence, then rerun the migration.';
      END IF;
      external_event_id := coalesce(
        external_event_id,
        nullif(btrim(existing_booking_external_event_id), '')
      );
      booking_id := existing_booking_id;
    ELSE
      IF manage_token_hash IS NOT NULL THEN
        SELECT b.id, b.organization_id, b.external_id
        INTO conflicting_booking
        FROM bookings b
        WHERE b.manage_token_hash = manage_token_hash
        LIMIT 1;
        IF FOUND THEN
          manage_token_hash := NULL;
        END IF;
      END IF;

      IF decision_id IS NOT NULL THEN
        SELECT b.id, b.organization_id, b.external_id
        INTO conflicting_booking
        FROM bookings b
        WHERE b.routing_decision_id = decision_id
        LIMIT 1;
        IF FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Cannot backfill calendar job %s: routing decision %s already belongs to booking %s.',
              calendar_job.id,
              decision_id,
              conflicting_booking.id
            ),
            HINT = 'Reconcile the duplicate booking before rerunning the migration.';
        END IF;
      END IF;

      BEGIN
        INSERT INTO bookings (
          organization_id, meeting_type_id, rep_id, external_id,
          manage_token_hash, status, attendee_name, attendee_email,
          attendee_notifications_enabled,
          starts_at, ends_at, calendar_provider, conference_provider,
          conference_url, external_event_id, external_event_web_link,
          last_error, routing_decision_id, created_at, updated_at
        ) VALUES (
          calendar_job.organization_id, meeting_type_id, rep_id, external_id,
          manage_token_hash, booking_status, attendee_name, attendee_email,
          notifications_enabled,
          starts_at, ends_at, calendar_provider, conference_provider,
          conference_url, external_event_id, external_event_web_link,
          calendar_job.last_error, decision_id, calendar_job.created_at,
          coalesce(calendar_job.completed_at, calendar_job.created_at)
        )
        RETURNING id INTO booking_id;
      EXCEPTION
        WHEN exclusion_violation THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Cannot backfill active calendar job %s: rep %s already has an overlapping durable booking.',
              calendar_job.id,
              rep_id
            ),
            HINT = 'Cancel, fail, or reschedule one overlapping booking after verifying the provider events, then rerun the migration.';
        WHEN unique_violation THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Cannot backfill calendar job %s: its externalId, routing decision, or manage token is already used.',
              calendar_job.id
            ),
            HINT = 'Reconcile the duplicate identity before rerunning the migration.';
      END;
    END IF;

    IF calendar_job.status = 'completed' AND external_event_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill completed calendar job %s: result.externalEventId is missing.',
          calendar_job.id
        ),
        HINT = 'Restore the provider event ID so the booking can be rescheduled or cancelled, then rerun the migration.';
    END IF;

    UPDATE bookings b
    SET status = CASE
          WHEN calendar_job.status = 'completed' AND b.status = 'pending'
            THEN 'confirmed'
          ELSE b.status
        END,
        attendee_notifications_enabled = notifications_enabled,
        external_event_id = coalesce(
          nullif(b.external_event_id, ''),
          external_event_id
        ),
        external_event_web_link = coalesce(
          b.external_event_web_link,
          external_event_web_link
        ),
        conference_url = coalesce(b.conference_url, conference_url),
        updated_at = greatest(
          b.updated_at,
          coalesce(calendar_job.completed_at, calendar_job.created_at)
        )
    WHERE b.id = booking_id;

    UPDATE jobs
    SET payload = payload || jsonb_build_object(
      'bookingId', booking_id::text,
      'externalId', external_id,
      'organizationSlug', organization_slug,
      'schedulingSlug', meeting_type_slug,
      'publicBooking', true,
      'repId', rep_id::text,
      'repName', rep_name,
      'repEmail', rep_email,
      'repTimezone', rep_timezone,
      'provider', calendar_provider,
      'startsAt', calendar_job.payload->>'startsAt',
      'endsAt', calendar_job.payload->>'endsAt',
      'subject', subject,
      'description', description,
      'attendeeName', attendee_name,
      'attendeeEmail', CASE
        WHEN notifications_enabled THEN attendee_email
        ELSE NULL
      END,
      'attendeeNotificationsEnabled', notifications_enabled,
      'conferenceProvider', conference_provider,
      'conferenceUrl', conference_url,
      'reminderMinutes', reminder_minutes
    ) || CASE
      WHEN decision_id IS NOT NULL
        THEN jsonb_build_object('decisionId', decision_id::text)
      ELSE '{}'::jsonb
    END
    WHERE id = calendar_job.id;
  END LOOP;
END
$migration$;
