-- 270_talk_group_bridge.sql
-- Service-local mirror migration for smart_groups runtime/discovery bridge
-- Forward-only, idempotent, production-safe

ALTER TABLE smart_groups
  ADD COLUMN IF NOT EXISTS talk_group_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
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
END $$;

COMMENT ON COLUMN smart_groups.talk_group_id IS 'Bridge to canonical talk_groups runtime entity';
