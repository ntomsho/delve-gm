-- ASSETS: every picture stored against the thing it shows.
--
-- Replaces the hash-keyed `plates` store, where a picture's key was a hash of
-- the prompt code that drew it: any prompt edit orphaned every picture, and
-- nothing could say what a stored picture was of. Here a picture is found by
-- what it shows, and is only ever redrawn on purpose (`src/dev/redraw.ts`).
--
--   art_root  the dungeon the art belongs to: a dungeon's own id, or for a
--             copy the original it came from, so copies share every picture
--   kind      'room' | 'sprite' | 'cover'
--   subject   the room's id, the creature's sprite id (`spriteKeyOf`), or ''
--             for the cover
--   status    pending → ready | failed; 'redraw' is a ready picture marked to
--             be drawn again on its next request, still served until then
--   path      the stored file; kept through a redraw until the new one lands
--   draws     how many times it has been drawn, which names the next file:
--             the bucket serves files as immutable, so a file never changes
--   meta      what belongs to this one picture: a room's placed buttons and
--             the door it was drawn from, a sprite's look and size
--
-- ADDITIVE ONLY. Localhost and production share this database, and code that
-- does not know the table ignores it, so this can be applied before the code
-- that reads it is deployed. `plates` and `dungeons.cover` are left in place
-- for the code still running there; see ROADMAP "Retire the old picture store".

create table public.assets (
  art_root   uuid not null,
  kind       text not null check (kind in ('room', 'sprite', 'cover')),
  subject    text not null,
  status     text not null check (status in ('pending', 'ready', 'failed', 'redraw')),
  path       text,
  draws      integer not null default 0,
  attempts   integer not null default 0,
  model      text,
  meta       jsonb not null default '{}'::jsonb,
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (art_root, kind, subject)
);

-- The landing page's random pick reads drawn pictures by kind.
create index assets_drawn_kind_idx on public.assets (kind) where path is not null;

-- The API reaches it as the database owner; nobody reaches it through
-- PostgREST. RLS on with no policies says exactly that.
alter table public.assets enable row level security;

-- Which dungeon's art a copy uses. Null on an original: its own id.
alter table public.dungeons add column if not exists art_root uuid;

-- Copies made before this point at their root through the `copied_from` chain.
with recursive chain (id, root) as (
  select id, id from public.dungeons where copied_from is null
  union all
  select d.id, c.root from public.dungeons d join chain c on d.copied_from = c.id
)
update public.dungeons d set art_root = chain.root
  from chain
 where d.id = chain.id and d.copied_from is not null and d.art_root is null;
