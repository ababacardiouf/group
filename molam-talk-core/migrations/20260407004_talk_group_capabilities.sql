-- 20260407004_talk_group_capabilities.sql
-- Canonical capability tables for talk_groups
-- Forward-only, idempotent, production-safe

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Pinned objects inside a talk group
CREATE TABLE IF NOT EXISTS talk_group_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES talk_groups(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  target_id UUID NOT NULL,
  pinned_by UUID,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_talk_group_pins_type'
  ) THEN
    ALTER TABLE talk_group_pins
      ADD CONSTRAINT chk_talk_group_pins_type
      CHECK (type IN ('post','live','product'));
  END IF;
END $$;

-- 2. Shop links already modeled in the historical groups schema
CREATE TABLE IF NOT EXISTS talk_group_shop_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES talk_groups(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  pinned_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Moderation log already modeled in historical groups schema
CREATE TABLE IF NOT EXISTS talk_group_moderation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES talk_groups(id) ON DELETE CASCADE,
  actor_id UUID,
  action TEXT NOT NULL,
  target_id UUID,
  reason TEXT,
  fatima_decision JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_talk_group_moderation_logs_action'
  ) THEN
    ALTER TABLE talk_group_moderation_logs
      ADD CONSTRAINT chk_talk_group_moderation_logs_action
      CHECK (action IN ('mute','kick','ban','remove_post','warn','escalate'));
  END IF;
END $$;

-- 4. Materialized metrics already modeled in historical groups schema
CREATE TABLE IF NOT EXISTS talk_group_metrics (
  group_id UUID PRIMARY KEY REFERENCES talk_groups(id) ON DELETE CASCADE,
  members_count BIGINT NOT NULL DEFAULT 0,
  active_last_7d BIGINT NOT NULL DEFAULT 0,
  messages_last_24h BIGINT NOT NULL DEFAULT 0,
  health_score NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Indexes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_pins_group_id'
  ) THEN
    CREATE INDEX idx_talk_group_pins_group_id
      ON talk_group_pins(group_id, pinned_at DESC);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_pins_expires_at'
  ) THEN
    CREATE INDEX idx_talk_group_pins_expires_at
      ON talk_group_pins(expires_at)
      WHERE expires_at IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_shop_links_group_id'
  ) THEN
    CREATE INDEX idx_talk_group_shop_links_group_id
      ON talk_group_shop_links(group_id, created_at DESC);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_shop_links_product_id'
  ) THEN
    CREATE INDEX idx_talk_group_shop_links_product_id
      ON talk_group_shop_links(product_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_moderation_logs_group_id'
  ) THEN
    CREATE INDEX idx_talk_group_moderation_logs_group_id
      ON talk_group_moderation_logs(group_id, created_at DESC);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_moderation_logs_action'
  ) THEN
    CREATE INDEX idx_talk_group_moderation_logs_action
      ON talk_group_moderation_logs(action, created_at DESC);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relname = 'idx_talk_group_moderation_logs_target_id'
  ) THEN
    CREATE INDEX idx_talk_group_moderation_logs_target_id
      ON talk_group_moderation_logs(target_id);
  END IF;
END $$;

-- 6. updated_at trigger for metrics
CREATE OR REPLACE FUNCTION set_talk_group_metrics_updated_at()
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
    WHERE tgname = 'trg_talk_group_metrics_updated_at'
  ) THEN
    CREATE TRIGGER trg_talk_group_metrics_updated_at
      BEFORE UPDATE ON talk_group_metrics
      FOR EACH ROW
      EXECUTE FUNCTION set_talk_group_metrics_updated_at();
  END IF;
END $$;

COMMENT ON TABLE talk_group_pins IS 'Canonical pins for talk_groups runtime';
COMMENT ON TABLE talk_group_shop_links IS 'Canonical product links for talk_groups runtime';
COMMENT ON TABLE talk_group_moderation_logs IS 'Canonical auditable moderation log for talk_groups runtime';
COMMENT ON TABLE talk_group_metrics IS 'Canonical materialized metrics for talk_groups runtime';
