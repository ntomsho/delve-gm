-- ---------------------------------------------------------------------------
-- ROOM PLATES
-- ---------------------------------------------------------------------------
--
-- BUILD-PLAN, *Illustrations*. A plate is a picture of a room as GENERATED, so
-- it belongs to no run and no dungeon row: it is keyed by a hash of what it is
-- drawn from, and every run (and every copy of the dungeon) that builds the
-- same key gets the same picture. See `src/server/plates.ts`.
--
-- The image itself is in Storage, at `plates/<key>.png` in the public bucket
-- below. The key is a sha256 nobody can work out without the dungeon's doc, and
-- the API draws a plate only for a room the run has entered.

create table public.plates (
  key        text primary key,
  status     text not null check (status in ('pending', 'ready', 'failed')),
  -- object path in the `plates` bucket, once ready
  path       text,
  model      text not null,
  attempts   integer not null default 0,
  -- the last failure, for whoever is reading the table
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Words a plate is drawn from that are shared by more than one plate: today the
-- per-dungeon SETTING line, keyed by a hash of the request that wrote it. Kept so
-- every plate in a dungeon is drawn against the same line rather than a fresh
-- Haiku answer each time.
create table public.plate_words (
  key        text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);

-- The API reaches these as the database owner; nobody reaches them through
-- PostgREST. RLS on with no policies says exactly that.
alter table public.plates      enable row level security;
alter table public.plate_words enable row level security;

-- Public: the CDN serves the files with no token. Uploads use the service-role
-- key, server-only.
insert into storage.buckets (id, name, public)
values ('plates', 'plates', true)
on conflict (id) do nothing;
