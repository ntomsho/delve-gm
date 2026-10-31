-- ---------------------------------------------------------------------------
-- CHARACTER PORTRAITS
-- ---------------------------------------------------------------------------
--
-- A picture of a player's character: drawn by the image model on request, or
-- uploaded by the player. See `src/server/illustrations/portraits.ts`.
--
-- Unlike `plates`, a portrait belongs to one account and is never shared, so it
-- is keyed by its own id rather than by what it was drawn from. The character's
-- sheet carries the id and URLs (`PlayerCharacter.portrait`), checked against
-- this table on every save; a portrait made for a character never saved just
-- sits here.
--
-- THE DAILY CAP reads straight off this table, like the run allowance reads off
-- `runs`: drawn rows that are `pending` or `ready` since midnight UTC. A failed
-- drawing does not count; an upload costs nothing and is not counted.
--
-- The images are in Storage, in the public `plates` bucket, at
-- `portraits/<id>.<ext>` and `portraits/<id>-thumb.<ext>`.

create table public.portraits (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  source     text not null check (source in ('drawn', 'uploaded')),
  status     text not null check (status in ('pending', 'ready', 'failed')),
  -- object paths in the `plates` bucket, once ready
  path       text,
  thumb_path text,
  -- the last failure, for whoever is reading the table
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The cap's count, run before every drawing.
create index portraits_owner_idx on public.portraits (owner_id, created_at);

-- The API reaches it as the database owner; nobody reaches it through
-- PostgREST. RLS on with no policies says exactly that.
alter table public.portraits enable row level security;
