-- VoiceKhata App database schema.
-- Idempotent: safe to run again (npm run migrate). Later changes go in migrations/.

CREATE EXTENSION IF NOT EXISTS pg_trgm; -- fuzzy name matching ("Sidhhi Stone" ≈ "Siddhi Stone")

-- A business. Every other table is scoped to one.
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  owner_phone VARCHAR(20) UNIQUE NOT NULL,
  owner_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Default business for a single-owner setup (scripts use it unless ORG_ID is set)
INSERT INTO organizations (id, name, owner_phone)
VALUES ('00000000-0000-0000-0000-000000000000', 'My Business', '+10000000000')
ON CONFLICT (id) DO NOTHING;

-- People who can log in to the app
CREATE TABLE IF NOT EXISTS organization_members (
  phone VARCHAR(20) PRIMARY KEY,                 -- E.164, e.g. +919876543210
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255),
  role VARCHAR(20) NOT NULL DEFAULT 'owner',     -- 'owner' | 'staff'
  pin_hash VARCHAR(100),                         -- bcrypt hash of the login PIN
  push_token VARCHAR(255),                       -- Expo push token of their phone
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_members_org ON organization_members(organization_id);

-- Customers and transporters
CREATE TABLE IF NOT EXISTS parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,                     -- 'customer' | 'transporter'
  phone VARCHAR(20),
  gst_number VARCHAR(15),
  address TEXT,
  city VARCHAR(100),
  notes TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_parties_org_type ON parties(organization_id, type);
CREATE INDEX IF NOT EXISTS idx_parties_name_trgm ON parties USING gin (name gin_trgm_ops);

-- Workers (advances given to them)
CREATE TABLE IF NOT EXISTS workers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  role VARCHAR(100),
  phone VARCHAR(20),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_workers_org ON workers(organization_id);
CREATE INDEX IF NOT EXISTS idx_workers_name_trgm ON workers USING gin (name gin_trgm_ops);

-- Price list
CREATE TABLE IF NOT EXISTS stone_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  size_format VARCHAR(50) NOT NULL,              -- e.g. 2x1½
  finish VARCHAR(50),
  current_price NUMERIC(8,2) NOT NULL,           -- rupees per sqft
  unit VARCHAR(20) DEFAULT 'SQFT',
  is_active BOOLEAN DEFAULT TRUE,
  last_price_update TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, size_format, finish)
);
CREATE INDEX IF NOT EXISTS idx_stone_types_org ON stone_types(organization_id, is_active);

CREATE TABLE IF NOT EXISTS stone_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stone_type_id UUID NOT NULL REFERENCES stone_types(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  old_price NUMERIC(8,2),
  new_price NUMERIC(8,2) NOT NULL,
  change_reason VARCHAR(255),
  change_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_price_history ON stone_price_history(stone_type_id, created_at DESC);

-- Ledger entries. Money columns are rupees with 2 decimals; all maths is done in integer paise.
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  party_id UUID REFERENCES parties(id),
  worker_id UUID REFERENCES workers(id),
  transaction_type VARCHAR(50),                  -- 'dispatch' | 'payment' | 'worker_advance' | 'freight_payment'

  stone_type_id UUID REFERENCES stone_types(id),
  stone_type_text VARCHAR(100),
  pieces_count INT,
  sqft_quantity DECIMAL(10,2),
  unit_rate DECIMAL(8,2),
  master_price DECIMAL(8,2),                     -- price-list rate at the time
  price_variance DECIMAL(8,2),
  subtotal_amount DECIMAL(12,2),
  freight_charge DECIMAL(10,2) DEFAULT 0,
  loading_charge DECIMAL(10,2) DEFAULT 0,
  packing_charge DECIMAL(10,2) DEFAULT 0,
  tax_percentage DECIMAL(5,2) DEFAULT 0,
  tax_amount DECIMAL(12,2) DEFAULT 0,
  total_amount DECIMAL(12,2),
  advance_paid DECIMAL(12,2) DEFAULT 0,          -- amount for payments / advances
  outstanding_balance DECIMAL(12,2),             -- effect on the balance (+ owes more, − owes less)

  status VARCHAR(50) DEFAULT 'pending_confirmation', -- pending_confirmation | confirmed | cancelled | reversed
  needs_price_confirmation BOOLEAN DEFAULT FALSE,
  price_warning JSONB,
  source_id VARCHAR(255),                        -- the voice note it came from (one entry per voice note)
  requested_by_phone VARCHAR(20),
  ref_code VARCHAR(8),
  confirmed_at TIMESTAMP,

  transcription_text TEXT,
  ai_extracted_json JSONB,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tx_org_party ON transactions(organization_id, party_id);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tx_pending_by_phone ON transactions(organization_id, requested_by_phone, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_source_id ON transactions(source_id) WHERE source_id IS NOT NULL;

-- Running balances, updated in the same DB transaction as each confirm / undo
CREATE TABLE IF NOT EXISTS party_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  total_billed DECIMAL(12,2) DEFAULT 0,
  total_paid DECIMAL(12,2) DEFAULT 0,
  outstanding_balance DECIMAL(12,2) DEFAULT 0,
  last_transaction_date TIMESTAMP,
  last_payment_date TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, party_id)
);
CREATE INDEX IF NOT EXISTS idx_party_balances_due ON party_balances(organization_id, outstanding_balance);

CREATE TABLE IF NOT EXISTS worker_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  worker_id UUID NOT NULL REFERENCES workers(id),
  advances_taken DECIMAL(10,2) DEFAULT 0,
  net_due DECIMAL(10,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, worker_id)
);

-- Voice notes recorded in the app. client_entry_id is made on the phone, so an
-- upload retried after a network drop is stored only once. The audio is kept
-- only until it has been transcribed.
CREATE TABLE IF NOT EXISTS voice_uploads (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  member_phone VARCHAR(20) NOT NULL,
  client_entry_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued | ready | rejected | failed
  reason VARCHAR(40),
  missing_fields TEXT[],
  audio BYTEA,
  audio_mime VARCHAR(50),
  transcript TEXT,
  transaction_id UUID REFERENCES transactions(id),
  recorded_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, client_entry_id)
);
CREATE INDEX IF NOT EXISTS idx_voice_uploads_member ON voice_uploads(organization_id, member_phone, created_at DESC);

-- What the AI understood vs what was saved after review (for measuring real accuracy)
CREATE TABLE IF NOT EXISTS entry_reviews (
  transaction_id UUID PRIMARY KEY REFERENCES transactions(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  ai_values JSONB NOT NULL,
  final_values JSONB NOT NULL,
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_entry_reviews_org ON entry_reviews(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  action VARCHAR(255),
  entity_type VARCHAR(100),
  entity_id UUID,
  old_values JSONB,
  new_values JSONB,
  user_agent TEXT,                               -- who did it, e.g. app:+919876543210
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, created_at DESC);
