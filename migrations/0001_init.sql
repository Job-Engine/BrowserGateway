-- Initial v2 schema: callers (per-caller scoped tokens) and jobs (durable
-- store + skip-locked queue). Fixes C2/C3/S1/S2 from Architecture Review 2.0.

create extension if not exists pgcrypto;

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

create table callers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  -- sha256 hex of the presented bearer token; the plaintext exists only at issue time
  token_hash text not null unique,
  -- scope strings "useCase:client"; "*" wildcards either side, e.g. "lightreach.ntpDate:*"
  scopes jsonb not null default '[]'::jsonb,
  is_admin boolean not null default false,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger callers_updated_at before update on callers
  for each row execute function set_updated_at();

create table jobs (
  id uuid primary key default gen_random_uuid(),
  use_case text not null,
  client text not null default 'default',
  platform text not null,
  input jsonb not null,
  caller_id uuid not null references callers(id),
  state text not null default 'QUEUED' check (state in ('QUEUED', 'RUNNING', 'DONE')),
  -- The envelope is written in the same statement that advances state to DONE;
  -- a DONE job without an envelope cannot exist.
  envelope jsonb,
  idempotency_key text,
  attempts integer not null default 0,
  deadline_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint done_has_envelope check (state <> 'DONE' or envelope is not null)
);
create unique index jobs_idempotency on jobs (caller_id, idempotency_key)
  where idempotency_key is not null;
create index jobs_queue on jobs (created_at) where state = 'QUEUED';
create index jobs_running_platform on jobs (platform) where state = 'RUNNING';
create index jobs_caller on jobs (caller_id, created_at desc);
create trigger jobs_updated_at before update on jobs
  for each row execute function set_updated_at();

-- RLS is enabled per house rules. The gateway connects as the table owner
-- (owner bypasses RLS); any future non-owner role gets no access by default.
alter table callers enable row level security;
alter table jobs enable row level security;
