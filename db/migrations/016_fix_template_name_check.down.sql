-- The original constraint could never accept a row; restore the working form anyway.
ALTER TABLE templates DROP CONSTRAINT templates_name_check;
ALTER TABLE templates ADD CONSTRAINT templates_name_check CHECK (name ~ '^[a-z0-9_]+$' AND length(name) <= 512);
