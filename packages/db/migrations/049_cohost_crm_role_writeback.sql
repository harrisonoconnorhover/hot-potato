ALTER TABLE meeting_type_cohost_groups
  ADD COLUMN crm_owner_property text;

ALTER TABLE meeting_type_cohost_groups
  ADD CONSTRAINT meeting_type_cohost_groups_crm_owner_property_check CHECK (
    crm_owner_property IS NULL
    OR (
      char_length(crm_owner_property) BETWEEN 1 AND 100
      AND crm_owner_property ~ '^[a-z][a-z0-9_]*$'
      AND crm_owner_property <> 'hubspot_owner_id'
    )
  );

CREATE UNIQUE INDEX meeting_type_cohost_groups_crm_owner_property_idx
  ON meeting_type_cohost_groups (meeting_type_id, crm_owner_property)
  WHERE crm_owner_property IS NOT NULL;

CREATE UNIQUE INDEX jobs_crm_roles_booking_idx
  ON jobs (organization_id, (payload->>'bookingId'))
  WHERE type = 'crm.roles.writeback';
