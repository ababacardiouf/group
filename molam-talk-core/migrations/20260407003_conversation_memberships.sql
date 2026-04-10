-- 20260407003_conversation_memberships.sql
-- Explicit conversation membership table required by talkGroupsRouter runtime
-- Forward-only, idempotent, production-safe

CREATE TABLE IF NOT EXISTS conversation_memberships (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (conversation_id, user_id)
);

-- 1. Normalize any legacy/null values
UPDATE conversation_memberships
SET role = 'member'
WHERE role IS NULL OR btrim(role) = '';

UPDATE conversation_memberships
SET status = 'active'
WHERE status IS NULL OR btrim(status) = '';

UPDATE conversation_memberships
SET role = lower(role),
    status = lower(status);

UPDATE conversation_memberships
SET status = 'active'
WHERE status = 'accepted';

-- 2. Constraints aligned with observed role/status sets in group runtime
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_conversation_memberships_role'
  ) THEN
    ALTER TABLE conversation_memberships
      ADD CONSTRAINT chk_conversation_memberships_role
      CHECK (role IN ('owner','admin','moderator','member','guest'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_conversation_memberships_status'
  ) THEN
    ALTER TABLE conversation_memberships
      ADD CONSTRAINT chk_conversation_memberships_status
      CHECK (status IN ('active','invited','left','banned'));
  END IF;
END $$;

-- 3. Supporting indexes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_conversation_memberships_user'
  ) THEN
    CREATE INDEX idx_conversation_memberships_user
      ON conversation_memberships(user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_conversation_memberships_status'
  ) THEN
    CREATE INDEX idx_conversation_memberships_status
      ON conversation_memberships(conversation_id, status);
  END IF;
END $$;

COMMENT ON TABLE conversation_memberships IS 'Canonical membership table for all runtime conversation/group joins';
COMMENT ON COLUMN conversation_memberships.metadata IS 'Extensible conversation membership metadata';
