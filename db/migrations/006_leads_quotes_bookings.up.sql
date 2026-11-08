-- 006 Leads (qualification), quotes (+ negotiation log), bookings (+ payments, status history).
-- The negotiation floor is enforced here as well as in the quote engine.

CREATE TABLE leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'new',
  -- qualification (the six fields the agent must collect)
  occasion_id      uuid REFERENCES occasions(id) ON DELETE SET NULL,
  theme_id         uuid REFERENCES themes(id) ON DELETE SET NULL,
  theme_text       text,                           -- free text when not in the theme list
  package_id       uuid REFERENCES packages(id) ON DELETE SET NULL,
  event_date       date,
  event_time       time,
  venue_address    text,
  venue_lat        numeric(9,6),
  venue_lng        numeric(9,6),
  distance_km      numeric(7,2),
  distance_charge  numeric(12,2),
  distance_method  text,                           -- haversine | google | manual
  guest_count      integer,
  budget_min       numeric(12,2),
  budget_max       numeric(12,2),
  -- pipeline
  source           text NOT NULL DEFAULT 'whatsapp',
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  lost_reason      text,
  notes            text,
  qualified_at     timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT leads_status_check CHECK (status = ANY (ARRAY['new','qualifying','quoted','negotiating','won','lost','stale'])),
  CONSTRAINT leads_lost_reason_check CHECK (status <> 'lost' OR lost_reason IS NOT NULL),
  CONSTRAINT leads_geo_check CHECK (
    (venue_lat IS NULL) = (venue_lng IS NULL)
    AND (venue_lat IS NULL OR venue_lat BETWEEN -90 AND 90)
    AND (venue_lng IS NULL OR venue_lng BETWEEN -180 AND 180)),
  CONSTRAINT leads_distance_check CHECK (
    (distance_km IS NULL OR distance_km >= 0) AND (distance_charge IS NULL OR distance_charge >= 0)),
  CONSTRAINT leads_distance_method_check CHECK (distance_method IS NULL OR distance_method = ANY (ARRAY['haversine','google','manual'])),
  CONSTRAINT leads_guest_check CHECK (guest_count IS NULL OR guest_count > 0),
  CONSTRAINT leads_budget_check CHECK (
    (budget_min IS NULL OR budget_min >= 0) AND (budget_max IS NULL OR budget_max >= 0)
    AND (budget_min IS NULL OR budget_max IS NULL OR budget_max >= budget_min))
);
CREATE INDEX idx_leads_tenant_id ON leads (tenant_id);
CREATE INDEX idx_leads_contact_id ON leads (contact_id);
CREATE INDEX idx_leads_conversation_id ON leads (conversation_id);
CREATE INDEX idx_leads_occasion_id ON leads (occasion_id);
CREATE INDEX idx_leads_theme_id ON leads (theme_id);
CREATE INDEX idx_leads_package_id ON leads (package_id);
CREATE INDEX idx_leads_assigned_user_id ON leads (assigned_user_id);
CREATE INDEX idx_leads_status ON leads (tenant_id, status, last_activity_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_event_date ON leads (tenant_id, event_date) WHERE event_date IS NOT NULL;
CREATE INDEX idx_leads_created_at ON leads (created_at);
-- at most one open lead per contact
CREATE UNIQUE INDEX uq_leads_one_open_per_contact ON leads (tenant_id, contact_id)
  WHERE deleted_at IS NULL AND status IN ('new','qualifying','quoted','negotiating');
CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── quotes: every price the bot or an agent states comes from a quote row ──
CREATE TABLE quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  package_id       uuid NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  theme_id         uuid REFERENCES themes(id) ON DELETE SET NULL,
  gallery_item_id  uuid REFERENCES gallery_items(id) ON DELETE SET NULL,  -- the photo the customer picked
  pricing_rule_id  uuid REFERENCES pricing_rules(id) ON DELETE SET NULL,
  negotiation_rule_id uuid REFERENCES negotiation_rules(id) ON DELETE SET NULL,
  list_price       numeric(12,2) NOT NULL,         -- design price before anything else
  addons_total     numeric(12,2) NOT NULL DEFAULT 0,
  distance_charge  numeric(12,2) NOT NULL DEFAULT 0,
  discount_amount  numeric(12,2) NOT NULL DEFAULT 0,
  final_price      numeric(12,2) NOT NULL,
  floor_price      numeric(12,2) NOT NULL,         -- lowest allowed final price (computed by engine)
  line_items       jsonb NOT NULL DEFAULT '[]'::jsonb,
  rounds_used      integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'issued',
  valid_until      timestamptz,
  created_by_type  text NOT NULL DEFAULT 'bot',    -- bot | agent
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quotes_status_check CHECK (status = ANY (ARRAY['issued','negotiating','accepted','expired','superseded','escalated'])),
  CONSTRAINT quotes_created_by_check CHECK (created_by_type = ANY (ARRAY['bot','agent'])),
  CONSTRAINT quotes_amounts_check CHECK (
    list_price >= 0 AND addons_total >= 0 AND distance_charge >= 0 AND discount_amount >= 0 AND floor_price >= 0),
  CONSTRAINT quotes_math_check CHECK (final_price = list_price + addons_total + distance_charge - discount_amount),
  CONSTRAINT quotes_floor_check CHECK (final_price >= floor_price),
  CONSTRAINT quotes_floor_le_full_check CHECK (floor_price <= list_price + addons_total + distance_charge),
  CONSTRAINT quotes_line_items_check CHECK (jsonb_typeof(line_items) = 'array'),
  CONSTRAINT quotes_rounds_check CHECK (rounds_used >= 0)
);
CREATE INDEX idx_quotes_tenant_id ON quotes (tenant_id);
CREATE INDEX idx_quotes_lead_id ON quotes (lead_id, created_at DESC);
CREATE INDEX idx_quotes_conversation_id ON quotes (conversation_id);
CREATE INDEX idx_quotes_package_id ON quotes (package_id);
CREATE INDEX idx_quotes_theme_id ON quotes (theme_id);
CREATE INDEX idx_quotes_gallery_item_id ON quotes (gallery_item_id);
CREATE INDEX idx_quotes_pricing_rule_id ON quotes (pricing_rule_id);
CREATE INDEX idx_quotes_negotiation_rule_id ON quotes (negotiation_rule_id);
CREATE INDEX idx_quotes_created_by_user_id ON quotes (created_by_user_id);
CREATE INDEX idx_quotes_created_at ON quotes (created_at);
CREATE TRIGGER trg_quotes_updated_at BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Every amount issued in chat is logged here; the outbound guard only lets
-- through ₹ amounts that appear in this table for the conversation.
CREATE TABLE quote_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quote_id        uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  event_type      text NOT NULL,
  requested_price numeric(12,2),                   -- what the customer asked for
  offered_price   numeric(12,2),                   -- what we offered / issued
  actor_type      text NOT NULL,                   -- bot | agent | customer
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_events_type_check CHECK (event_type = ANY (ARRAY['issued','counter_request','counter_offer','accepted','rejected','escalated','expired'])),
  CONSTRAINT quote_events_actor_check CHECK (actor_type = ANY (ARRAY['bot','agent','customer'])),
  CONSTRAINT quote_events_prices_check CHECK (
    (requested_price IS NULL OR requested_price >= 0) AND (offered_price IS NULL OR offered_price >= 0))
);
CREATE INDEX idx_quote_events_tenant_id ON quote_events (tenant_id);
CREATE INDEX idx_quote_events_quote_id ON quote_events (quote_id, created_at);
CREATE INDEX idx_quote_events_conversation_id ON quote_events (conversation_id);
CREATE INDEX idx_quote_events_actor_user_id ON quote_events (actor_user_id);
CREATE INDEX idx_quote_events_created_at ON quote_events (created_at);

-- ── bookings ─────────────────────────────────────────────────
CREATE SEQUENCE booking_code_seq START 1001;

CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_code        text NOT NULL DEFAULT ('BB-' || nextval('booking_code_seq')::text),
  lead_id             uuid REFERENCES leads(id) ON DELETE SET NULL,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  quote_id            uuid REFERENCES quotes(id) ON DELETE SET NULL,
  package_id          uuid NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  theme_id            uuid REFERENCES themes(id) ON DELETE SET NULL,
  occasion_id         uuid REFERENCES occasions(id) ON DELETE SET NULL,
  gallery_item_id     uuid REFERENCES gallery_items(id) ON DELETE SET NULL,
  event_date          date NOT NULL,
  event_time          time,
  setup_time          time,
  venue_address       text NOT NULL,
  venue_lat           numeric(9,6),
  venue_lng           numeric(9,6),
  distance_km         numeric(7,2),
  guest_count         integer,
  quoted_price        numeric(12,2) NOT NULL,      -- full price before negotiation
  agreed_price        numeric(12,2) NOT NULL,
  floor_price         numeric(12,2) NOT NULL,
  distance_charge     numeric(12,2) NOT NULL DEFAULT 0,
  advance_amount      numeric(12,2) NOT NULL DEFAULT 0,  -- required advance
  advance_paid_amount numeric(12,2) NOT NULL DEFAULT 0,  -- maintained by trigger from booking_payments
  balance_amount      numeric(12,2) GENERATED ALWAYS AS (agreed_price - advance_paid_amount) STORED,
  advance_status      text NOT NULL DEFAULT 'pending',   -- maintained by trigger
  status              text NOT NULL DEFAULT 'advance_pending',
  cancelled_reason    text,
  special_requests    text,
  internal_notes      text,
  assigned_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_type     text NOT NULL DEFAULT 'bot',
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at        timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT uq_bookings_booking_code UNIQUE (booking_code),
  CONSTRAINT bookings_status_check CHECK (status = ANY (ARRAY['enquiry','quoted','advance_pending','confirmed','completed','cancelled'])),
  CONSTRAINT bookings_advance_status_check CHECK (advance_status = ANY (ARRAY['pending','partial','paid','refunded'])),
  CONSTRAINT bookings_created_by_check CHECK (created_by_type = ANY (ARRAY['bot','agent'])),
  CONSTRAINT bookings_prices_check CHECK (
    quoted_price >= 0 AND agreed_price >= 0 AND floor_price >= 0 AND distance_charge >= 0 AND advance_amount >= 0),
  CONSTRAINT bookings_floor_check CHECK (agreed_price >= floor_price),            -- negotiation limit, enforced in DB
  CONSTRAINT bookings_agreed_le_quoted_check CHECK (agreed_price <= quoted_price),
  CONSTRAINT bookings_advance_le_agreed_check CHECK (advance_amount <= agreed_price),
  CONSTRAINT bookings_paid_check CHECK (advance_paid_amount >= 0 AND advance_paid_amount <= agreed_price),
  CONSTRAINT bookings_cancel_check CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL),
  CONSTRAINT bookings_geo_check CHECK ((venue_lat IS NULL) = (venue_lng IS NULL)),
  CONSTRAINT bookings_guest_check CHECK (guest_count IS NULL OR guest_count > 0)
);
CREATE INDEX idx_bookings_tenant_id ON bookings (tenant_id);
CREATE INDEX idx_bookings_lead_id ON bookings (lead_id);
CREATE INDEX idx_bookings_contact_id ON bookings (contact_id);
CREATE INDEX idx_bookings_quote_id ON bookings (quote_id);
CREATE INDEX idx_bookings_package_id ON bookings (package_id);
CREATE INDEX idx_bookings_theme_id ON bookings (theme_id);
CREATE INDEX idx_bookings_occasion_id ON bookings (occasion_id);
CREATE INDEX idx_bookings_gallery_item_id ON bookings (gallery_item_id);
CREATE INDEX idx_bookings_assigned_user_id ON bookings (assigned_user_id);
CREATE INDEX idx_bookings_created_by_user_id ON bookings (created_by_user_id);
CREATE INDEX idx_bookings_status ON bookings (tenant_id, status, event_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_bookings_event_date ON bookings (tenant_id, event_date) WHERE deleted_at IS NULL AND status <> 'cancelled';
CREATE INDEX idx_bookings_created_at ON bookings (created_at);
CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE booking_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'payment',  -- payment | refund
  amount        numeric(12,2) NOT NULL,
  method        text NOT NULL,                    -- upi | cash | bank_transfer | gateway
  reference     text,                             -- UTR / gateway payment id
  received_at   timestamptz NOT NULL DEFAULT now(),
  recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_payments_kind_check CHECK (kind = ANY (ARRAY['payment','refund'])),
  CONSTRAINT booking_payments_amount_check CHECK (amount > 0),
  CONSTRAINT booking_payments_method_check CHECK (method = ANY (ARRAY['upi','cash','bank_transfer','gateway']))
);
CREATE INDEX idx_booking_payments_tenant_id ON booking_payments (tenant_id);
CREATE INDEX idx_booking_payments_booking_id ON booking_payments (booking_id);
CREATE INDEX idx_booking_payments_recorded_by ON booking_payments (recorded_by);
CREATE INDEX idx_booking_payments_created_at ON booking_payments (created_at);
CREATE UNIQUE INDEX uq_booking_payments_reference ON booking_payments (tenant_id, method, reference) WHERE reference IS NOT NULL;

-- Keep bookings.advance_paid_amount / advance_status consistent with payments.
CREATE OR REPLACE FUNCTION sync_booking_paid_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b_id uuid := COALESCE(NEW.booking_id, OLD.booking_id);
  paid numeric(12,2);
  refunded numeric(12,2);
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0),
         COALESCE(SUM(amount) FILTER (WHERE kind = 'refund'), 0)
    INTO paid, refunded
    FROM booking_payments WHERE booking_id = b_id;

  UPDATE bookings
     SET advance_paid_amount = paid - refunded,
         advance_status = CASE
           WHEN refunded > 0 AND paid - refunded <= 0 THEN 'refunded'
           WHEN paid - refunded >= advance_amount AND paid - refunded > 0 THEN 'paid'
           WHEN paid - refunded > 0 THEN 'partial'
           ELSE 'pending' END
   WHERE id = b_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_booking_payments_sync AFTER INSERT OR UPDATE OR DELETE ON booking_payments
  FOR EACH ROW EXECUTE FUNCTION sync_booking_paid_amount();

CREATE TABLE booking_status_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status   text,
  to_status     text NOT NULL,
  actor_type    text NOT NULL DEFAULT 'system',
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_status_history_actor_check CHECK (actor_type = ANY (ARRAY['bot','agent','system']))
);
CREATE INDEX idx_booking_status_history_tenant_id ON booking_status_history (tenant_id);
CREATE INDEX idx_booking_status_history_booking_id ON booking_status_history (booking_id, created_at);
CREATE INDEX idx_booking_status_history_actor_user_id ON booking_status_history (actor_user_id);
CREATE INDEX idx_booking_status_history_created_at ON booking_status_history (created_at);

-- Record every status change automatically (actor details can be set by the app
-- via SET LOCAL bb.actor_type / bb.actor_user_id inside the same transaction).
CREATE OR REPLACE FUNCTION log_booking_status_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO booking_status_history (tenant_id, booking_id, from_status, to_status, actor_type, actor_user_id)
    VALUES (NEW.tenant_id, NEW.id,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
            NEW.status,
            COALESCE(NULLIF(current_setting('bb.actor_type', true), ''), 'system'),
            NULLIF(current_setting('bb.actor_user_id', true), '')::uuid);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_bookings_status_history AFTER INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION log_booking_status_change();
