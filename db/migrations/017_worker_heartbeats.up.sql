-- 017 The worker checks in here every minute, so /api/health can tell when background
-- work (replies, sends, reminders, broadcasts) has stopped even though the API is up.
CREATE TABLE worker_heartbeats (
  worker_id   text PRIMARY KEY,                    -- hostname:pid
  started_at  timestamptz NOT NULL,
  beat_at     timestamptz NOT NULL DEFAULT now(),
  info        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- version, concurrency
  CONSTRAINT worker_heartbeats_id_check CHECK (length(worker_id) BETWEEN 1 AND 200)
);
CREATE INDEX idx_worker_heartbeats_beat_at ON worker_heartbeats (beat_at DESC);
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON worker_heartbeats FROM anon, authenticated';
  END IF;
END $$;
