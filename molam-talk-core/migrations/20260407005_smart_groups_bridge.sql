-- 20260407005_smart_groups_bridge.sql
-- Bridge discovery smart_groups with canonical talk_groups runtime
-- Forward-only, idempotent, production-safe

-- 1. Bridge column on smart_groups
ALTER TABLE smart_groups
  ADD COLUMN IF NOT EXISTS talk_group_id UUID;

-- 2. Ensure talk_groups can safely reference smart discovery topics
-- topic_id column is created in talk_groups canonical migration; this migration adds the FK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'talk_groups'
      AND column_name = 'topic_id'
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'group_topics'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_talk_groups_topic_id'
  ) THEN
    ALTER TABLE talk_groups
      ADD CONSTRAINT fk_talk_groups_topic_id
      FOREIGN KEY (topic_id)
      REFERENCES group_topics(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Add FK from smart_groups to canonical runtime
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'smart_groups'
      AND column_name = 'talk_group_id'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_smart_groups_talk_group_id'
  ) THEN
    ALTER TABLE smart_groups
      ADD CONSTRAINT fk_smart_groups_talk_group_id
      FOREIGN KEY (talk_group_id)
      REFERENCES talk_groups(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Indexes for fast runtime/discovery bridge traversal
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'uq_smart_groups_talk_group_id_not_null'
  ) THEN
    CREATE UNIQUE INDEX uq_smart_groups_talk_group_id_not_null
      ON smart_groups(talk_group_id)
      WHERE talk_group_id IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_smart_groups_talk_group_id'
  ) THEN
    CREATE INDEX idx_smart_groups_talk_group_id
      ON smart_groups(talk_group_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_smart_groups_topic_id_locale'
  ) THEN
    CREATE INDEX idx_smart_groups_topic_id_locale
      ON smart_groups(topic_id, locale);
  END IF;
END $$;

COMMENT ON COLUMN smart_groups.talk_group_id IS 'Bridge to canonical talk_groups runtime entity';
