-- PHASE 11 — ACCOUNTS AND OWNERSHIP
-- =================================
--
-- Phase 10 shipped a database in which nothing had an owner and an API that
-- asked for no credentials. This migration is the other half of closing that:
-- every row belongs to an `auth.users` id, and the API stops serving strangers.
--
-- IT DROPS AND RECREATES RATHER THAN ALTERING, on purpose. The six tables held
-- five rows between them, all of it 10a/10b smoke-test data, and recreating
-- leaves one readable statement of the schema instead of a chain of four
-- migrations you have to replay in your head to know what a column is. There is
-- no installed base to migrate — see CODING-PLAN §11, "no retrofitting".
--
-- THE DUNGEON KEY IS THE REAL CHANGE, and it is a Phase 10a mistake being
-- undone. `GeneratedDungeon.id` is `dungeon_<seed in base 36>`
-- (`dungeon-blueprint.ts:786`) and is derived on purpose: the determinism rule
-- is that a seed names a dungeon. 10a then used that name as the PRIMARY KEY,
-- which is fine while there is one copy of each seed in the world and breaks the
-- moment two players each want their own copy of seed 4201. So the two jobs are
-- split: `id` is a meaningless uuid that names the ROW, and `dungeon_key` is the
-- derived name, deliberately NOT unique.
--
-- This is also cheap exactly now and expensive later, which is why it is not
-- being deferred behind the auth work it arrived with.

-- ---------------------------------------------------------------------------
-- OUT WITH THE OLD
-- ---------------------------------------------------------------------------

drop table if exists public.journal_events cascade;
drop table if exists public.dungeon_events cascade;
drop table if exists public.generation_chunks cascade;
drop table if exists public.runs cascade;
drop table if exists public.dungeons cascade;
drop table if exists public.characters cascade;

-- ---------------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------------

-- One row per account, and the only column that matters yet is `tier`.
--
-- `vip` spends the project's Anthropic key; `byok` brings their own. NOTHING
-- READS IT IN PHASE 11 — the whole app is invite-only and every account is a
-- guest of the author's key today. It is here so that Phase 12 is code and not
-- a second migration, and because a tier column added after there are accounts
-- has to decide what the existing ones are.
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  tier       text not null default 'byok' check (tier in ('byok', 'vip')),
  created_at timestamptz not null default now()
);

-- A profile exists because an account does, so the database makes it rather
-- than the API remembering to. The alternative — upserting on first
-- authenticated request — spends a round trip on every request to cover a case
-- that happens once per user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- A SECURITY DEFINER function in `public` is exposed by PostgREST as
-- `/rest/v1/rpc/handle_new_user`, callable by anyone holding the publishable
-- key. Only the trigger has any business calling it. (Caught by the Supabase
-- linter, lints 0028 and 0029, immediately after this migration first applied.)
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- CHARACTERS
-- ---------------------------------------------------------------------------

-- `id` stays TEXT: a sheet carries its own id, minted in the browser, and
-- `PlayerCharacter.id` is declared `string`. 10a learned this the hard way
-- twice — see CODING-PLAN §7.6.
create table public.characters (
  id         text primary key default gen_random_uuid()::text,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  sheet      jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index characters_owner_idx on public.characters (owner_id, created_at);

-- ---------------------------------------------------------------------------
-- DUNGEONS
-- ---------------------------------------------------------------------------

create table public.dungeons (
  id          uuid primary key default gen_random_uuid(),
  -- The derived name, `dungeon_<seed in base 36>`. NOT UNIQUE: two players may
  -- each hold their own copy of one seed. Redundant against `seed` and kept
  -- anyway, because it is what matches a row to the `id` inside its own `doc`
  -- without parsing jsonb, which is what you want at 3am reading a log.
  dungeon_key text not null,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  seed        integer not null,
  size        integer not null,
  level       integer not null,
  status      text not null default 'partial' check (status in ('partial', 'complete')),
  doc         jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index dungeons_owner_idx on public.dungeons (owner_id, created_at desc);

-- THE CACHE LOOKUP. Before spending N+2 model calls on a world, ask whether
-- anyone has already built one from these dice. Partial dungeons are excluded
-- because half a world is not worth copying.
create index dungeons_cache_idx on public.dungeons (seed, size, level)
  where status = 'complete';

-- ---------------------------------------------------------------------------
-- GENERATION
-- ---------------------------------------------------------------------------

create table public.generation_chunks (
  dungeon_id uuid not null references public.dungeons (id) on delete cascade,
  chunk      integer not null,
  response   jsonb not null,
  created_at timestamptz not null default now(),
  primary key (dungeon_id, chunk)
);

-- What generation wrote down. Belongs to the dungeon rather than to any run,
-- because it happens across three requests before a run exists.
create table public.dungeon_events (
  dungeon_id uuid not null references public.dungeons (id) on delete cascade,
  seq        integer not null,
  at         timestamptz not null,
  kind       text not null,
  payload    jsonb not null,
  primary key (dungeon_id, seq)
);

-- ---------------------------------------------------------------------------
-- RUNS
-- ---------------------------------------------------------------------------

-- A run is two things and both are private: our log when something goes wrong,
-- and the player's save file. There is no read path for anyone but the owner.
create table public.runs (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  dungeon_id   uuid not null references public.dungeons (id) on delete cascade,
  -- ON DELETE SET NULL, and `repo.StoredRun.characterId` has been
  -- `string | null` since 10a, so this is the type finally telling the truth.
  -- Deleting a character is a button on the library screen; a finished run
  -- holding a foreign key open would have made that button fail.
  character_id text references public.characters (id) on delete set null,
  state        jsonb not null,
  version      integer not null default 1,
  status       text not null default 'active'
               check (status in ('active', 'dead', 'escaped', 'goal_met', 'abandoned')),
  locked_until timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index runs_owner_idx on public.runs (owner_id, created_at desc);

create table public.journal_events (
  run_id  uuid not null references public.runs (id) on delete cascade,
  seq     integer not null,
  at      timestamptz not null,
  kind    text not null,
  payload jsonb not null,
  primary key (run_id, seq)
);

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
--
-- THE API IS THE ENFORCEMENT AND THESE ARE THE BACKSTOP. The server reaches
-- Postgres over a direct connection as a role RLS does not apply to, so nothing
-- below is what actually keeps one player out of another's run — the `where
-- owner_id = $n` in every statement in `repo.ts` is. These exist for the OTHER
-- door: the publishable key ships in the browser by design, and anything that
-- picks it up should get its own rows and nothing else.
--
-- SO EVERY POLICY IS OWNER-ONLY, INCLUDING DUNGEONS. A player browsing someone
-- else's dungeon sees a summary — name, objective, size, level — and never the
-- `doc`, which holds every answer in the world. RLS cannot express "these
-- columns only" without column grants, so it says NOTHING instead and the API
-- serves the summary from its privileged connection. Stricter and simpler; the
-- backstop should not be the thing deciding what a summary is.

alter table public.profiles          enable row level security;
alter table public.characters        enable row level security;
alter table public.dungeons          enable row level security;
alter table public.generation_chunks enable row level security;
alter table public.dungeon_events    enable row level security;
alter table public.runs              enable row level security;
alter table public.journal_events    enable row level security;

create policy profiles_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy characters_owner on public.characters
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy dungeons_owner on public.dungeons
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy runs_owner on public.runs
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- The child tables have no owner of their own; they inherit their parent's.
create policy generation_chunks_owner on public.generation_chunks
  for all to authenticated
  using (exists (
    select 1 from public.dungeons d
     where d.id = generation_chunks.dungeon_id and d.owner_id = auth.uid()
  ));

create policy dungeon_events_owner on public.dungeon_events
  for all to authenticated
  using (exists (
    select 1 from public.dungeons d
     where d.id = dungeon_events.dungeon_id and d.owner_id = auth.uid()
  ));

create policy journal_events_owner on public.journal_events
  for all to authenticated
  using (exists (
    select 1 from public.runs r
     where r.id = journal_events.run_id and r.owner_id = auth.uid()
  ));
