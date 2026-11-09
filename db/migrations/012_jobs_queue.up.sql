-- 012 Durable job queue in Postgres (replaces Redis/BullMQ: no extra service, and
--     Upstash's free tier can't absorb BullMQ's polling). Workers claim with
--     FOR UPDATE SKIP LOCKED; retries use exponential backoff; run_at gives delays.

CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL for not-yet-routed webhook work
  queue         text NOT NULL DEFAULT 'default',
  name          text NOT NULL,                     -- handler name, e.g. process_webhook_event, send_message
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued',
  priority      integer NOT NULL DEFAULT 0,        -- higher runs first
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  unique_key    text,                              -- optional dedupe key
  locked_by     text,
  locked_at     timestamptz,
  last_error    text,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_check CHECK (status = ANY (ARRAY['queued','running','done','failed','cancelled'])),
  CONSTRAINT jobs_name_check CHECK (name ~ '^[a-z_]{2,64}$'),
  CONSTRAINT jobs_attempts_check CHECK (attempts >= 0 AND max_attempts >= 1)
);
CREATE INDEX idx_jobs_tenant_id ON jobs (tenant_id);
CREATE INDEX idx_jobs_ready ON jobs (queue, priority DESC, run_at) WHERE status = 'queued';
CREATE INDEX idx_jobs_running_locked_at ON jobs (locked_at) WHERE status = 'running';
CREATE INDEX idx_jobs_created_at ON jobs (created_at);
CREATE UNIQUE INDEX uq_jobs_unique_key ON jobs (unique_key) WHERE unique_key IS NOT NULL AND status IN ('queued','running');
CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- webhook_events links to the job that processes it
ALTER TABLE webhook_events ADD COLUMN job_id uuid REFERENCES jobs(id) ON DELETE SET NULL;
CREATE INDEX idx_webhook_events_job_id ON webhook_events (job_id);
