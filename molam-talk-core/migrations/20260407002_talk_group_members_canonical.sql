-- 20260407002_talk_group_members_canonical.sql
-- Canonical runtime normalization for talk_group_members
-- Forward-only, idempotent, production-safe

-- 1. Add metadata bag already present in legacy memberships model
ALTER TABLE talk_group_members
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2. Normalize legacy/null role/status values before constraints
UPDATE talk_group_members
SET role = 'member'
WHERE role IS NULL OR btrim(role) = '';

UPDATE talk_group_members
SET status = 'accepted'
WHERE status IS NULL OR btrim(status) = '';

-- 3. Canonicalize observed historical values into a single runtime vocabulary
UPDATE talk_group_members
SET status = 'accepted'
WHERE lower(status) IN ('active');

UPDATE talk_group_members
SET status = 'left'
WHERE lower(status) IN ('removed');

UPDATE talk_group_members
SET role = lower(role),
    status = lower(status);

-- 4. Runtime-safe constraints:
-- roles observed across the repo:
-- owner, admin, moderator, member, guest
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_talk_group_members_role'
  ) THEN
    ALTER TABLE talk_group_members
      ADD CONSTRAINT chk_talk_group_members_role
      CHECK (role IN ('owner','admin','moderator','member','guest'));
  END IF;
END $$;

-- statuses observed across the repo/runtime:
-- invited, accepted, rejected, left, banned
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_talk_group_members_status'
  ) THEN
    ALTER TABLE talk_group_members
      ADD CONSTRAINT chk_talk_group_members_status
      CHECK (status IN ('invited','accepted','rejected','left','banned'));
  END IF;
END $$;

-- 5. Ensure join timestamp defaults
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'talk_group_members'
      AND column_name = 'joined_at'
  ) THEN
    ALTER TABLE talk_group_members
      ALTER COLUMN joined_at SET DEFAULT now();
  END IF;
END $$;

-- 6. Idempotent membership uniqueness for runtime safety
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pk_talk_group_members_group_user'
  ) THEN
    ALTER TABLE talk_group_members
      ADD CONSTRAINT pk_talk_group_members_group_user
      PRIMARY KEY (group_id, user_id);
  END IF;
EXCEPTION
  WHEN invalid_table_definition THEN
    -- Primary key may already exist or an equivalent uniqueness may already protect the table.
    NULL;
  WHEN duplicate_table THEN
    NULL;
END $$;

-- 7. Supporting indexes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_members_role'
  ) THEN
    CREATE INDEX idx_talk_group_members_role
      ON talk_group_members(group_id, role);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_members_status'
  ) THEN
    CREATE INDEX idx_talk_group_members_status
      ON talk_group_members(group_id, status);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_members_user_status'
  ) THEN
    CREATE INDEX idx_talk_group_members_user_status
      ON talk_group_members(user_id, status);
  END IF;
END $$;

COMMENT ON COLUMN talk_group_members.metadata IS 'Extensible member-level metadata for canonical talk group runtime';
