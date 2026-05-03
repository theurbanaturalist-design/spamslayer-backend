-- ─────────────────────────────────────────────────────────────────────────
--  SpamSlayer Migration 001 — Initial schema
--
--  Target Supabase project: Spam-Slayer (vwfnmcfvaasrouiiejos)
--  Region: us-west-2
--  Postgres: 17
--
--  Translates the cases.json data model (see backend/src/services/caseBuilder.ts)
--  into a multi-tenant Postgres schema with Row Level Security tied to
--  Supabase Auth (auth.users.id = user_id throughout).
--
--  Multi-tenancy decision:
--    Each user gets their own offender row keyed by (user_id, normalized_number).
--    Two users called by the same spam company will have two distinct
--    offender rows — they file separate suits, they have separate damages
--    estimates, they each see only their own. This is simpler and safer
--    than sharing offender rows across tenants (no risk of one user's
--    edit affecting another user's pending filing).
--
--  Continuation profiles:
--    The cases.json model uses a string suffix `${normalized}#post-filed`
--    to track calls that arrive after a case has been filed. We model that
--    here with a self-referencing parent_offender_id column. NULL = primary
--    (first-file) profile. Non-NULL = continuation pointing back at the
--    parent. Partial unique indexes enforce: at most one primary per
--    (user_id, normalized_number), at most one continuation per parent.
--
--  Filing audit trail:
--    The filings table stores the full FilingPackage JSON in package_data
--    so we have a permanent record of what the court was given, even if
--    the offender row is later edited. RLS denies DELETE on filings via
--    the absence of a delete policy — only the service-role key can
--    remove a filing record (and that should be logged).
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Extensions ────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ─── offenders ────────────────────────────────────────────────────────
create table public.offenders (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  normalized_number   text not null,
  raw_numbers         text[] not null default '{}',
  company_name        text,
  caller_names        text[] not null default '{}',
  purpose             text,

  first_call_date     date not null,
  last_call_date      date not null,

  actionable          boolean not null default false,
  willful             boolean not null default false,
  damages_estimate    integer not null default 0 check (damages_estimate >= 0),

  demand_letter_sent  boolean not null default false,
  demand_letter_date  date,

  filed_at            timestamptz,
  filed_case_ref      text,

  -- Self-reference for continuation profiles. NULL = primary (first-file)
  -- profile. Non-NULL = continuation pointing at the original parent.
  parent_offender_id  uuid references public.offenders(id) on delete cascade,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One primary offender per (user, number).
create unique index offenders_primary_uniq
  on public.offenders (user_id, normalized_number)
  where parent_offender_id is null;

-- At most one continuation per parent (mirrors cases.json's single
-- `#post-filed` suffix per number).
create unique index offenders_continuation_uniq
  on public.offenders (parent_offender_id)
  where parent_offender_id is not null;

create index offenders_user_id_idx on public.offenders(user_id);
create index offenders_actionable_idx
  on public.offenders(user_id, actionable)
  where actionable = true and parent_offender_id is null;

-- ─── calls ────────────────────────────────────────────────────────────
create table public.calls (
  id                 uuid primary key default uuid_generate_v4(),
  offender_id        uuid not null references public.offenders(id) on delete cascade,

  -- Denormalized for RLS — lets the calls policy check user_id directly
  -- without a join through offenders. Must be kept in sync with the
  -- parent offender's user_id (enforced at application layer; a CHECK
  -- constraint cannot reference another row).
  user_id            uuid not null references auth.users(id) on delete cascade,

  call_sid           text not null,
  call_date          date not null,
  call_time          text not null,
  recording_url      text,
  transcript_snippet text not null default '',
  call_type          text not null default 'unknown',

  created_at         timestamptz not null default now()
);

-- Twilio call SIDs are globally unique, but scope the uniqueness to the
-- user just in case we ever ingest from multiple sources.
create unique index calls_user_callsid_uniq on public.calls(user_id, call_sid);
create index calls_offender_id_idx on public.calls(offender_id);
create index calls_user_id_idx on public.calls(user_id);
create index calls_date_idx on public.calls(offender_id, call_date);

-- ─── filings ──────────────────────────────────────────────────────────
create table public.filings (
  id                uuid primary key default uuid_generate_v4(),
  offender_id       uuid not null references public.offenders(id) on delete restrict,
  user_id           uuid not null references auth.users(id) on delete cascade,

  case_ref          text not null,
  court_name        text,
  court_state       text,
  damages_claimed   integer not null check (damages_claimed >= 0),
  willful           boolean not null default false,

  -- Full FilingPackage JSON snapshot — what was given to the court.
  -- Frozen at filing time; never updated.
  package_data      jsonb,

  generated_at      timestamptz not null default now()
);

-- offender_id uses ON DELETE RESTRICT — you cannot delete an offender
-- that has a filing on file. Forces explicit cleanup in the right order
-- and prevents accidental destruction of the audit trail.

create unique index filings_user_caseref_uniq on public.filings(user_id, case_ref);
create index filings_offender_id_idx on public.filings(offender_id);
create index filings_user_id_idx on public.filings(user_id);

-- ─── user_config ─────────────────────────────────────────────────────
-- Per-user legal identity + court settings. Replaces filingConfig.json.
create table public.user_config (
  user_id                 uuid primary key references auth.users(id) on delete cascade,

  full_name               text,
  address                 text,
  city                    text,
  state                   text,
  zip                     text,
  phone                   text,
  email                   text,

  dnc_registration_date   date,

  -- Constrained set — must match what filingConfig validates.
  line_type               text check (line_type in ('residential','business','mobile')),

  court_name              text,
  court_parish_or_county  text,
  court_state             text,

  updated_at              timestamptz not null default now()
);

-- ─── updated_at trigger ──────────────────────────────────────────────
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger offenders_set_updated_at
  before update on public.offenders
  for each row execute function public.tg_set_updated_at();

create trigger user_config_set_updated_at
  before update on public.user_config
  for each row execute function public.tg_set_updated_at();

-- ─── Row Level Security ──────────────────────────────────────────────
-- Every table is RLS-enabled. The default-deny posture means a user
-- with only the anon/authenticated key can read/write only their own
-- rows. Service-role key bypasses RLS — keep it server-side only.

alter table public.offenders   enable row level security;
alter table public.calls       enable row level security;
alter table public.filings     enable row level security;
alter table public.user_config enable row level security;

-- ── offenders policies ────────────────────────────────────────
create policy offenders_select_own on public.offenders
  for select to authenticated using (user_id = auth.uid());

create policy offenders_insert_own on public.offenders
  for insert to authenticated with check (user_id = auth.uid());

create policy offenders_update_own on public.offenders
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy offenders_delete_own on public.offenders
  for delete to authenticated using (user_id = auth.uid());

-- ── calls policies ────────────────────────────────────────────
create policy calls_select_own on public.calls
  for select to authenticated using (user_id = auth.uid());

create policy calls_insert_own on public.calls
  for insert to authenticated with check (user_id = auth.uid());

create policy calls_update_own on public.calls
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy calls_delete_own on public.calls
  for delete to authenticated using (user_id = auth.uid());

-- ── filings policies ──────────────────────────────────────────
-- INTENTIONALLY no DELETE policy. Filings are court-filing audit trail.
-- Removing one requires the service-role key + explicit logging.

create policy filings_select_own on public.filings
  for select to authenticated using (user_id = auth.uid());

create policy filings_insert_own on public.filings
  for insert to authenticated with check (user_id = auth.uid());

create policy filings_update_own on public.filings
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── user_config policies ──────────────────────────────────────
create policy user_config_select_own on public.user_config
  for select to authenticated using (user_id = auth.uid());

create policy user_config_insert_own on public.user_config
  for insert to authenticated with check (user_id = auth.uid());

create policy user_config_update_own on public.user_config
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ─── Comments for self-documentation ─────────────────────────
comment on table  public.offenders is 'TCPA offender profiles, one per (user, normalized_number). Continuations link via parent_offender_id.';
comment on column public.offenders.normalized_number is 'E.164-style format produced by normalizePhone() in caseBuilder.ts';
comment on column public.offenders.parent_offender_id is 'NULL = primary profile. Non-NULL = continuation for calls received after parent was filed.';
comment on column public.offenders.damages_estimate is 'Cents-free integer dollars. Computed by caseBuilder; do not edit directly.';

comment on table  public.calls is 'One row per logged call. user_id denormalized for RLS efficiency.';
comment on table  public.filings is 'Filing-package audit trail. Append-only via RLS (no delete policy). package_data is the frozen FilingPackage JSON.';
comment on table  public.user_config is 'Per-user legal identity and court settings. Replaces filingConfig.json.';

-- ─── End of migration 001 ────────────────────────────────────
