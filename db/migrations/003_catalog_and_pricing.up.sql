-- 003 Catalog & pricing: occasions, packages (design categories), themes (+aliases),
--     pricing_rules, negotiation_rules, distance_slabs.
-- Prices come from the client's Drive folder names (website prices are ignored).

-- ── occasions ─────────────────────────────────────────────────
CREATE TABLE occasions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  aliases     text[] NOT NULL DEFAULT '{}',        -- "bday", "naming ceremony", ...
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT occasions_key_check CHECK (key ~ '^[a-z0-9_]{2,50}$')
);
CREATE UNIQUE INDEX uq_occasions_tenant_key ON occasions (tenant_id, key) WHERE deleted_at IS NULL;
CREATE INDEX idx_occasions_tenant_id ON occasions (tenant_id);
CREATE TRIGGER trg_occasions_updated_at BEFORE UPDATE ON occasions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── packages = design categories (ring frame, single frame, 2 frames, arch, ...) ──
CREATE TABLE packages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key              text NOT NULL,
  name             text NOT NULL,
  kind             text NOT NULL DEFAULT 'package',  -- package | addon | unit
  description      text,
  inclusions       text[] NOT NULL DEFAULT '{}',
  price_min        numeric(12,2),                    -- category-level estimate (from folder name)
  price_max        numeric(12,2),
  unit_label       text,                             -- for kind='unit', e.g. 'bunch'
  min_quantity     integer,
  price_confirmed  boolean NOT NULL DEFAULT false,   -- false = TODO: confirm with client before go-live
  folder_names     text[] NOT NULL DEFAULT '{}',     -- Drive top folders that map here (importer)
  sort_order       integer NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT packages_key_check CHECK (key ~ '^[a-z0-9_]{2,50}$'),
  CONSTRAINT packages_kind_check CHECK (kind = ANY (ARRAY['package','addon','unit'])),
  CONSTRAINT packages_price_check CHECK (
    (price_min IS NULL OR price_min >= 0) AND (price_max IS NULL OR price_max >= 0)
    AND (price_min IS NULL OR price_max IS NULL OR price_max >= price_min)),
  CONSTRAINT packages_unit_check CHECK (kind <> 'unit' OR unit_label IS NOT NULL),
  CONSTRAINT packages_min_qty_check CHECK (min_quantity IS NULL OR min_quantity > 0)
);
CREATE UNIQUE INDEX uq_packages_tenant_key ON packages (tenant_id, key) WHERE deleted_at IS NULL;
CREATE INDEX idx_packages_tenant_id ON packages (tenant_id);
CREATE TRIGGER trg_packages_updated_at BEFORE UPDATE ON packages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── themes (+ aliases for typo-normalisation and customer phrasing) ──
CREATE TABLE themes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT themes_key_check CHECK (key ~ '^[a-z0-9_]{2,50}$')
);
CREATE UNIQUE INDEX uq_themes_tenant_key ON themes (tenant_id, key) WHERE deleted_at IS NULL;
CREATE INDEX idx_themes_tenant_id ON themes (tenant_id);
CREATE TRIGGER trg_themes_updated_at BEFORE UPDATE ON themes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE theme_aliases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  theme_id    uuid NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  alias       text NOT NULL,                        -- stored lower-case, trimmed
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_theme_aliases_tenant_alias UNIQUE (tenant_id, alias),
  CONSTRAINT theme_aliases_alias_check CHECK (alias = lower(btrim(alias)) AND length(alias) > 0)
);
CREATE INDEX idx_theme_aliases_theme_id ON theme_aliases (theme_id);

-- ── pricing_rules: binding price inputs for the quote engine ─
-- Most specific active rule wins (package+theme+occasion > package+theme > package).
CREATE TABLE pricing_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_id   uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  theme_id     uuid REFERENCES themes(id) ON DELETE CASCADE,
  occasion_id  uuid REFERENCES occasions(id) ON DELETE CASCADE,
  rule_type    text NOT NULL DEFAULT 'base_price',   -- base_price | surcharge | unit_price
  price_min    numeric(12,2) NOT NULL,
  price_max    numeric(12,2) NOT NULL,
  priority     integer NOT NULL DEFAULT 0,
  valid_from   date,
  valid_to     date,
  is_active    boolean NOT NULL DEFAULT true,
  price_confirmed boolean NOT NULL DEFAULT false,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_rules_type_check CHECK (rule_type = ANY (ARRAY['base_price','surcharge','unit_price'])),
  CONSTRAINT pricing_rules_price_check CHECK (price_min >= 0 AND price_max >= price_min),
  CONSTRAINT pricing_rules_validity_check CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX idx_pricing_rules_tenant_id ON pricing_rules (tenant_id) WHERE is_active;
CREATE INDEX idx_pricing_rules_package_id ON pricing_rules (package_id);
CREATE INDEX idx_pricing_rules_theme_id ON pricing_rules (theme_id);
CREATE INDEX idx_pricing_rules_occasion_id ON pricing_rules (occasion_id);
CREATE TRIGGER trg_pricing_rules_updated_at BEFORE UPDATE ON pricing_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── negotiation_rules: hard discount limits (enforced in code + DB) ──
CREATE TABLE negotiation_rules (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope                       text NOT NULL,          -- global | package | theme
  package_id                  uuid REFERENCES packages(id) ON DELETE CASCADE,
  theme_id                    uuid REFERENCES themes(id) ON DELETE CASCADE,
  max_discount_pct            numeric(5,2),           -- of list price
  max_discount_amount         numeric(12,2),          -- ₹ cap
  min_final_price             numeric(12,2),          -- absolute floor
  concession_step_pct         numeric(5,2) NOT NULL DEFAULT 5.00,  -- size of each counter-offer step
  max_rounds                  integer NOT NULL DEFAULT 2,
  applies_to_addons           boolean NOT NULL DEFAULT false,
  applies_to_distance_charge  boolean NOT NULL DEFAULT false,
  is_active                   boolean NOT NULL DEFAULT true,
  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT negotiation_rules_scope_check CHECK (scope = ANY (ARRAY['global','package','theme'])),
  CONSTRAINT negotiation_rules_scope_target_check CHECK (
    (scope = 'global'  AND package_id IS NULL AND theme_id IS NULL) OR
    (scope = 'package' AND package_id IS NOT NULL AND theme_id IS NULL) OR
    (scope = 'theme'   AND theme_id IS NOT NULL)),
  CONSTRAINT negotiation_rules_has_limit_check CHECK (
    max_discount_pct IS NOT NULL OR max_discount_amount IS NOT NULL OR min_final_price IS NOT NULL),
  CONSTRAINT negotiation_rules_pct_check CHECK (max_discount_pct IS NULL OR max_discount_pct BETWEEN 0 AND 100),
  CONSTRAINT negotiation_rules_amount_check CHECK (
    (max_discount_amount IS NULL OR max_discount_amount >= 0) AND (min_final_price IS NULL OR min_final_price >= 0)),
  CONSTRAINT negotiation_rules_step_check CHECK (concession_step_pct > 0 AND concession_step_pct <= 100),
  CONSTRAINT negotiation_rules_rounds_check CHECK (max_rounds BETWEEN 0 AND 10)
);
CREATE INDEX idx_negotiation_rules_tenant_id ON negotiation_rules (tenant_id) WHERE is_active;
CREATE INDEX idx_negotiation_rules_package_id ON negotiation_rules (package_id);
CREATE INDEX idx_negotiation_rules_theme_id ON negotiation_rules (theme_id);
CREATE UNIQUE INDEX uq_negotiation_rules_global ON negotiation_rules (tenant_id) WHERE scope = 'global' AND is_active;
CREATE UNIQUE INDEX uq_negotiation_rules_package ON negotiation_rules (tenant_id, package_id) WHERE scope = 'package' AND is_active;
CREATE UNIQUE INDEX uq_negotiation_rules_theme ON negotiation_rules (tenant_id, theme_id, package_id) NULLS NOT DISTINCT WHERE scope = 'theme' AND is_active;
CREATE TRIGGER trg_negotiation_rules_updated_at BEFORE UPDATE ON negotiation_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── distance_slabs: [min_km, max_km) bands, non-overlapping per tenant ──
CREATE TABLE distance_slabs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  min_km       numeric(6,2) NOT NULL,
  max_km       numeric(6,2),                         -- NULL = open-ended
  charge_type  text NOT NULL,                         -- free | flat | per_km | not_serviceable
  amount       numeric(12,2) NOT NULL DEFAULT 0,      -- flat ₹, or ₹ per km beyond min_km
  label        text,
  is_active    boolean NOT NULL DEFAULT true,
  price_confirmed boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT distance_slabs_type_check CHECK (charge_type = ANY (ARRAY['free','flat','per_km','not_serviceable'])),
  CONSTRAINT distance_slabs_range_check CHECK (min_km >= 0 AND (max_km IS NULL OR max_km > min_km)),
  CONSTRAINT distance_slabs_amount_check CHECK (amount >= 0 AND (charge_type <> 'free' OR amount = 0)),
  CONSTRAINT ex_distance_slabs_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    numrange(min_km, max_km, '[)') WITH &&
  ) WHERE (is_active)
);
CREATE INDEX idx_distance_slabs_tenant_id ON distance_slabs (tenant_id);
CREATE TRIGGER trg_distance_slabs_updated_at BEFORE UPDATE ON distance_slabs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
