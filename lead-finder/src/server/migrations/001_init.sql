-- SkyBridge Facility Lead Finder: initial schema.
-- Job postings, facility branches and parent organizations are separate tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'manager', 'member')),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Browser sessions and personal API tokens (used by the browser extension). Only hashes are stored.
CREATE TABLE auth_tokens (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('session', 'api')),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  normalized_name text NOT NULL,
  website         text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_norm ON organizations(normalized_name);

CREATE TABLE facilities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid REFERENCES organizations(id) ON DELETE SET NULL,
  name                 text NOT NULL,
  normalized_name      text NOT NULL,
  facility_type        text,                       -- e.g. Home Health Agency, Hospice, Hybrid
  care_lines           text[] NOT NULL DEFAULT '{}', -- home_health | hospice | palliative | ipc_hospice
  street               text,
  city                 text,
  state                text,
  zip                  text,
  website              text,
  phone                text,
  branch_label         text,
  branch_code          text,
  verification_status  text NOT NULL DEFAULT 'extracted'
    CHECK (verification_status IN ('extracted', 'unverified', 'verified_website', 'verified_license', 'verified_manual')),
  identity_status      text NOT NULL DEFAULT 'confirmed',
  -- business development
  lead_status          text NOT NULL DEFAULT 'New Lead',
  priority_override    text CHECK (priority_override IN ('High', 'Medium', 'Low', 'Needs Research')),
  owner_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  is_existing_client   boolean NOT NULL DEFAULT false,
  existing_client_owner text,
  bullhorn_company_id  text,
  last_contacted_at    date,
  next_follow_up       date,
  next_action          text,
  opportunity_notes    text,
  merged_into_id       uuid REFERENCES facilities(id) ON DELETE SET NULL,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facilities_norm ON facilities(normalized_name);
CREATE INDEX facilities_state_city ON facilities(state, city);
CREATE INDEX facilities_active ON facilities(merged_into_id) WHERE merged_into_id IS NULL;

CREATE TABLE job_postings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id          uuid REFERENCES facilities(id) ON DELETE SET NULL,
  source               text NOT NULL DEFAULT 'vivian',
  source_url           text NOT NULL UNIQUE,
  external_id          text,
  title                text NOT NULL,
  specialty            text,
  care_line            text,
  license              text,
  role                 text,
  classification       text NOT NULL CHECK (classification IN ('accept', 'review', 'exclude')),
  classification_reasons jsonb NOT NULL DEFAULT '[]',
  classification_manual boolean NOT NULL DEFAULT false,
  employment_type      text,
  city                 text,
  state                text,
  advertiser_name      text,
  advertiser_is_agency boolean,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  job_status           text NOT NULL DEFAULT 'observed',
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX job_postings_facility ON job_postings(facility_id);

-- Every extraction attempt, with its evidence, kept for source transparency.
CREATE TABLE extractions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id  uuid REFERENCES job_postings(id) ON DELETE CASCADE,
  source_url      text,
  method          text NOT NULL CHECK (method IN ('server_fetch', 'extension', 'paste')),
  extracted_at    timestamptz NOT NULL DEFAULT now(),
  identity_status text NOT NULL,
  source_field    text,
  source_path     text,
  original_value  text,
  result          jsonb NOT NULL,   -- full extraction result as returned by the engine
  corrections     jsonb NOT NULL DEFAULT '{}', -- fields the user changed before saving: {field: {from, to}}
  errors          jsonb NOT NULL DEFAULT '[]',
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX extractions_job ON extractions(job_posting_id);

CREATE TABLE activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('note', 'contact', 'status_change', 'comment')),
  body        text NOT NULL,
  contact_date date,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_facility ON activities(facility_id, created_at DESC);

CREATE TABLE merges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survivor_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  merged_id   uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  moved_job_ids uuid[] NOT NULL DEFAULT '{}',
  moved_activity_ids uuid[] NOT NULL DEFAULT '{}',
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  undone_at   timestamptz,
  undone_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  entity     text NOT NULL,
  entity_id  text NOT NULL,
  action     text NOT NULL,
  changes    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id, created_at DESC);

CREATE TABLE batches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label      text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE batch_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  url         text NOT NULL,
  status      text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'extracted', 'needs_browser', 'failed', 'duplicate', 'saved', 'invalid')),
  message     text,
  result      jsonb,
  attempts    int NOT NULL DEFAULT 0,
  job_posting_id uuid REFERENCES job_postings(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, url)
);
CREATE INDEX batch_items_status ON batch_items(status);
