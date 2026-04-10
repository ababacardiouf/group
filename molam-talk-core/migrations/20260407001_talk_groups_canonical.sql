-- 20260407001_talk_groups_canonical.sql
-- Canonical runtime expansion for talk_groups
-- Forward-only, idempotent, production-safe

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Add canonical columns already modeled elsewhere in the repo
ALTER TABLE talk_groups
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS locale TEXT,
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS topic_id UUID;

-- 2. Ensure operational defaults expected by runtime
ALTER TABLE talk_groups
  ALTER COLUMN member_count SET DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'talk_groups'
      AND column_name = 'max_members'
  ) THEN
    ALTER TABLE talk_groups
      ALTER COLUMN max_members SET DEFAULT 1000;
  END IF;
END $$;

-- 3. Keep privacy flags internally consistent
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'talk_groups'
      AND column_name = 'is_public'
  ) THEN
    UPDATE talk_groups
    SET is_private = NOT is_public
    WHERE is_private IS DISTINCT FROM (NOT is_public);
  END IF;
END $$;

-- 4. Backfill slug deterministically from name when missing
UPDATE talk_groups
SET slug = LEFT(
  regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g'),
  120
)
WHERE (slug IS NULL OR btrim(slug) = '')
  AND name IS NOT NULL
  AND btrim(name) <> '';

-- 5. Guard against fully empty slug collisions after normalization
-- If multiple rows normalize to the same slug or empty string, suffix with the group id prefix
WITH normalized AS (
  SELECT
    id,
    CASE
      WHEN slug IS NULL OR btrim(slug) = '' THEN NULL
      ELSE slug
    END AS slug_value
  FROM talk_groups
),
dupes AS (
  SELECT slug_value
  FROM normalized
  WHERE slug_value IS NOT NULL
  GROUP BY slug_value
  HAVING COUNT(*) > 1
)
UPDATE talk_groups tg
SET slug = LEFT(tg.slug || '-' || replace(split_part(tg.id::text, '-', 1), ' ', ''), 120)
WHERE tg.slug IN (SELECT slug_value FROM dupes);

-- 6. Make slug unique only when present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i'
      AND c.relname = 'uq_talk_groups_slug_not_null'
  ) THEN
    CREATE UNIQUE INDEX uq_talk_groups_slug_not_null
      ON talk_groups(slug)
      WHERE slug IS NOT NULL;
  END IF;
END $$;

-- 7. Supporting indexes for runtime reads
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_groups_slug'
  ) THEN
    CREATE INDEX idx_talk_groups_slug ON talk_groups(slug);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_groups_locale'
  ) THEN
    CREATE INDEX idx_talk_groups_locale ON talk_groups(locale);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_groups_topic_id'
  ) THEN
    CREATE INDEX idx_talk_groups_topic_id ON talk_groups(topic_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_groups_is_private'
  ) THEN
    CREATE INDEX idx_talk_groups_is_private ON talk_groups(is_private);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_groups_legal_entity'
  ) THEN
    CREATE INDEX idx_talk_groups_legal_entity ON talk_groups(legal_entity);
  END IF;
END $$;

-- 8. updated_at trigger, only if not already attached
CREATE OR REPLACE FUNCTION set_talk_groups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_talk_groups_updated_at'
  ) THEN
    CREATE TRIGGER trg_talk_groups_updated_at
      BEFORE UPDATE ON talk_groups
      FOR EACH ROW
      EXECUTE FUNCTION set_talk_groups_updated_at();
  END IF;
END $$;

-- 9. Documentation
COMMENT ON COLUMN talk_groups.slug IS 'Canonical stable slug for public/runtime group identity';
COMMENT ON COLUMN talk_groups.locale IS 'Primary locale for the group';
COMMENT ON COLUMN talk_groups.settings IS 'Canonical runtime settings inherited from historical groups model';
COMMENT ON COLUMN talk_groups.metadata IS 'Extensible runtime metadata';
COMMENT ON COLUMN talk_groups.topic_id IS 'Optional discovery/topic link used by smart_groups bridge';
