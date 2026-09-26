-- Activity feed notifications (the in-app bell).
-- One row per platform event that concerns a user, with a deep-link CTA.
CREATE TABLE IF NOT EXISTS activity_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'SYSTEM',
  kind TEXT,
  action_label TEXT,
  action_url TEXT,
  read_at TIMESTAMPTZ,
  actor_user_id TEXT,
  related_entity_type TEXT,
  related_entity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_notifications_user_id ON activity_notifications (user_id);
CREATE INDEX IF NOT EXISTS idx_activity_notifications_created_at ON activity_notifications (created_at);
