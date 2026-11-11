-- WHAT EACH PLATE IS A PICTURE OF.
--
-- A plate is keyed by a hash of what it was drawn from, and that hash changes
-- whenever the prompt does. The landing page's showcase used to find room
-- pictures by rebuilding their keys from recent runs, so every prompt change
-- left it with no rooms at all. These columns are written when the picture is
-- claimed (`claimIllustration`), so a room can be found by what it is.
--
--   kind       'room' | 'sprite' | 'cover'
--   dungeon_id the dungeon a room was first drawn for (a copy shares the plate)
--   room_id    the room, and entry_id the door it was drawn from
--   title      the room's name, for the landing page's caption
--
-- ADDITIVE ONLY. Localhost and production share this database, and code that
-- does not know the columns ignores them, so this can be applied before the
-- code that writes them is deployed. Plates drawn before this are tagged once
-- by `src/dev/backfill-plate-subjects.ts`; a room it cannot place is still a
-- room, shown without a caption.

alter table public.plates
  add column if not exists kind text check (kind in ('room', 'sprite', 'cover')),
  add column if not exists dungeon_id uuid,
  add column if not exists room_id text,
  add column if not exists entry_id text,
  add column if not exists title text;

create index if not exists plates_ready_kind on public.plates (kind) where status = 'ready';
