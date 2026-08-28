-- OPS: DB-backed catalogue registry, action lifecycle, per-client enablement
-- with the first-live-run rule, canary state, audit log, and job cost fields.
-- Base definitions (zod schemas, goal builders) stay in code; the DB owns
-- lifecycle, enablement, canary config, and audit.

create table platforms (
  key text primary key,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger platforms_updated_at before update on platforms
  for each row execute function set_updated_at();

create table actions (
  use_case text primary key,
  platform text not null references platforms(key),
  version integer not null default 1,
  -- draft -> validated -> tested -> live is tracked per client below; the
  -- action-level state gates whether any client can be enabled at all.
  state text not null default 'draft' check (state in ('draft', 'validated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger actions_updated_at before update on actions
  for each row execute function set_updated_at();

create table action_clients (
  use_case text not null references actions(use_case),
  client text not null,
  -- disabled -> tested (a passing match-verified test run exists) -> live.
  -- The first-live-run rule in code: live requires a recorded passing test.
  state text not null default 'disabled' check (state in ('disabled', 'tested', 'live')),
  -- The passing test record; becomes this pair's canary configuration.
  test_input jsonb,
  test_job_id uuid,
  last_canary_at timestamptz,
  last_canary_status text,
  last_canary_job_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (use_case, client)
);
create trigger action_clients_updated_at before update on action_clients
  for each row execute function set_updated_at();

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  action text not null,
  entity text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_recent on audit_log (created_at desc);

-- Cost tracking: additive columns on jobs.
alter table jobs add column steps_used integer;
alter table jobs add column cost_usd numeric(10, 4);

alter table platforms enable row level security;
alter table actions enable row level security;
alter table action_clients enable row level security;
alter table audit_log enable row level security;
