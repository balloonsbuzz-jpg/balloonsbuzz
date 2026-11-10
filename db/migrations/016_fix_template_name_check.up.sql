-- 016 Fix: PostgreSQL regexes allow at most 255 repetitions, so '{1,512}' made every
-- INSERT into templates fail. Same rule (Meta: lowercase, digits, _ ; up to 512 chars).
ALTER TABLE templates DROP CONSTRAINT templates_name_check;
ALTER TABLE templates ADD CONSTRAINT templates_name_check CHECK (name ~ '^[a-z0-9_]+$' AND length(name) <= 512);
