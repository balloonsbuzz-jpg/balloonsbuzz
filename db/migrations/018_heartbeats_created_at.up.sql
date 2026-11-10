-- 018 House rule: every table has created_at. For a worker that is when it started.
ALTER TABLE worker_heartbeats RENAME COLUMN started_at TO created_at;
