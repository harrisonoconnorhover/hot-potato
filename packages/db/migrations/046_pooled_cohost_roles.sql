CREATE TABLE meeting_type_cohost_groups (
  meeting_type_id uuid NOT NULL
    REFERENCES meeting_types(id) ON DELETE CASCADE,
  pool_id uuid NOT NULL REFERENCES routing_pools(id) ON DELETE CASCADE,
  required_for_availability boolean NOT NULL DEFAULT true,
  position smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_type_id, pool_id),
  UNIQUE (meeting_type_id, position),
  CONSTRAINT meeting_type_cohost_groups_position_check CHECK (
    position BETWEEN 0 AND 4
  )
);

CREATE OR REPLACE FUNCTION hot_potato_validate_meeting_type_cohost_group()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  meeting_organization_id uuid;
  organizer_pool_id uuid;
  cohost_pool_organization_id uuid;
BEGIN
  SELECT organization_id, pool_id
  INTO meeting_organization_id, organizer_pool_id
  FROM meeting_types
  WHERE id = NEW.meeting_type_id
  FOR UPDATE;

  SELECT organization_id
  INTO cohost_pool_organization_id
  FROM routing_pools
  WHERE id = NEW.pool_id;

  IF meeting_organization_id IS NULL
    OR cohost_pool_organization_id IS NULL
    OR meeting_organization_id <> cohost_pool_organization_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Co-host pools must belong to the meeting organization.';
  END IF;

  IF organizer_pool_id = NEW.pool_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The organizer pool cannot also be a co-host pool.';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER meeting_type_cohost_groups_validate
BEFORE INSERT OR UPDATE OF meeting_type_id, pool_id
ON meeting_type_cohost_groups
FOR EACH ROW
EXECUTE FUNCTION hot_potato_validate_meeting_type_cohost_group();

CREATE OR REPLACE FUNCTION hot_potato_validate_meeting_type_cohost_pool()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.pool_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM meeting_type_cohost_groups cohost_group
    WHERE cohost_group.meeting_type_id = NEW.id
      AND cohost_group.pool_id = NEW.pool_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The organizer pool cannot also be a co-host pool.';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER meeting_types_validate_cohost_pool
BEFORE UPDATE OF pool_id
ON meeting_types
FOR EACH ROW
EXECUTE FUNCTION hot_potato_validate_meeting_type_cohost_pool();

ALTER TABLE booking_cohosts
  DROP CONSTRAINT booking_cohosts_position_check,
  ADD CONSTRAINT booking_cohosts_position_check CHECK (
    position BETWEEN 0 AND 14
  ),
  ADD COLUMN source_pool_id uuid REFERENCES routing_pools(id) ON DELETE SET NULL,
  ADD COLUMN source_pool_name text;

ALTER TABLE booking_cohosts
  ADD CONSTRAINT booking_cohosts_source_pool_pair_check CHECK (
    (source_pool_id IS NULL) = (source_pool_name IS NULL)
  );
