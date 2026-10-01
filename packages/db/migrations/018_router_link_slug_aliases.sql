CREATE TABLE IF NOT EXISTS router_link_slug_aliases (
  organization_id uuid NOT NULL,
  slug text NOT NULL,
  router_link_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, slug),
  CONSTRAINT router_link_slug_aliases_slug_check CHECK (
    char_length(slug) BETWEEN 1 AND 80
    AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  CONSTRAINT router_link_slug_aliases_link_organization_fk
    FOREIGN KEY (router_link_id, organization_id)
    REFERENCES router_links(id, organization_id) ON DELETE CASCADE
);

INSERT INTO router_link_slug_aliases (organization_id, slug, router_link_id)
SELECT organization_id, slug, id
FROM router_links
ON CONFLICT (organization_id, slug) DO NOTHING;

CREATE OR REPLACE FUNCTION preserve_router_link_slug_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO router_link_slug_aliases (
    organization_id, slug, router_link_id
  ) VALUES (
    NEW.organization_id, NEW.slug, NEW.id
  )
  ON CONFLICT (organization_id, slug) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM router_link_slug_aliases alias
    WHERE alias.organization_id = NEW.organization_id
      AND alias.slug = NEW.slug
      AND alias.router_link_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Smart Link slug is already reserved by another link.'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS router_links_preserve_slug_alias ON router_links;
CREATE TRIGGER router_links_preserve_slug_alias
AFTER INSERT OR UPDATE OF organization_id, slug ON router_links
FOR EACH ROW EXECUTE FUNCTION preserve_router_link_slug_alias();
