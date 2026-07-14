-- Persistent per-action replay traces (deterministic replay feature).
create table action_traces (
  id uuid primary key default gen_random_uuid(),
  use_case text not null,
  client text not null,
  version int not null,
  state text not null default 'active' check (state in ('active', 'retired')),
  steps jsonb not null,
  read_selectors jsonb not null default '{}',
  recorded_from_job_id uuid,
  heal_count int not null default 0,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  unique (use_case, client, version)
);

create unique index action_traces_one_active
  on action_traces (use_case, client) where state = 'active';
