-- THE PLAYBOOK, STORED ONCE
-- =========================
--
-- A `system` journal event carries the standing instructions a referee call was
-- made under: `SKILL.md`, the dungeon's fiction, and the step files for the step
-- being run. Together that is 25–45 kB of prose, and `journal.ts` was written to
-- record it ONCE PER STEP PER RUN — see `createJournal`, which keeps a `written`
-- set for exactly that purpose.
--
-- THAT GUARANTEE DIED WHEN PLAY MOVED TO A SERVER, and nothing noticed. The set
-- lives on the journal object, the journal object is made per session, and
-- `playTurn` builds a session per REQUEST — so the set is empty on every turn
-- and the playbook is written again on every referee call. Measured on a real
-- four-turn run before this migration: 121 kB of `journal_events`, of which 81 kB
-- was three copies of the same three blocks. Eleven blocks stored; five distinct.
--
-- RESTORING THE PER-RUN SET WOULD HAVE BEEN THE SMALL FIX AND IS THE WRONG ONE.
-- It leaves seven copies of `SKILL.md` per run — one per step — and it puts the
-- correctness of a storage decision back inside a per-request object that has
-- already been shown to lose it. So the deduplication moves to the only place
-- that sees every write: the write itself.
--
-- CONTENT-ADDRESSED, so identity is a property of the text and not of anything
-- that has to be remembered. The same block written by two runs, two dungeons or
-- two years apart is one row. `SKILL.md` is stored once for the whole database.
--
-- WHAT THIS IS NOT. It is not compression and it is not a cache: the text is
-- here in full, exactly as it was sent, and `journal_events_full` below puts it
-- back. A journal pulled out through that view is byte-identical to one pulled
-- out before this migration.

-- ---------------------------------------------------------------------------
-- THE BLOCKS
-- ---------------------------------------------------------------------------

-- `sha` is a sha256 of `text`, hex, computed in `repo.ts` rather than here.
--
-- IN THE APPLICATION AND NOT IN POSTGRES, deliberately. Doing it in SQL means
-- either pgcrypto or PG's own `sha256(bytea)`, and either way the hash of a
-- block becomes a thing the database decides — so a write path that wants to
-- know whether it already holds a block has to ask the database to tell it.
-- Hashing in `node:crypto` on the way in makes the id available before the
-- statement is composed, which is what lets the blocks and the events that
-- reference them go in as two plain inserts.
create table public.prompt_blocks (
  sha        text primary key,
  chars      integer not null,
  text       text not null,
  created_at timestamptz not null default now()
);

-- NO OWNER COLUMN, and that is the point of content addressing — a block is the
-- same block whoever sent it, and an owned copy per player would be the
-- duplication this migration exists to remove.
--
-- Most of what lands here is the project's own prompt markdown, which is source
-- code. The exception is a dungeon's `dungeonContext`, which is model-written
-- fiction and belongs to somebody. It is not reachable: RLS is on with NO POLICY
-- AT ALL, so the publishable key that ships in the browser reads nothing here,
-- and the server reads it over the direct connection RLS does not apply to. Same
-- reasoning as `dungeons.doc` in the Phase 11 migration — the backstop says
-- nothing rather than trying to say something clever.
alter table public.prompt_blocks enable row level security;

-- ---------------------------------------------------------------------------
-- PUTTING IT BACK
-- ---------------------------------------------------------------------------

-- A stored `system` payload has, in place of each block's `text`, the `sha` that
-- names it and the `chars` it stood for. This is the inverse.
--
-- Anything without a `blocks` array is returned untouched, so the function is
-- safe to apply to a whole table of mixed kinds rather than the caller having to
-- filter first. A block that is already whole — no `sha` — is returned untouched
-- too, which is what lets events written before this migration read back
-- unchanged.
--
-- A MISSING BLOCK SAYS SO. `prompt_blocks` is only ever inserted into and never
-- deleted from, so a sha with no row is a bug rather than an expected state, and
-- silently substituting an empty string would hide it inside a 40 kB file nobody
-- reads closely.
create or replace function public.rehydrate_blocks(payload jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    -- `IS DISTINCT FROM` and not `<>`. Most events have no `blocks` at all, so
    -- `jsonb_typeof` returns NULL, and `NULL <> 'array'` is NULL rather than
    -- true — which sent every `player`, `commit` and `narration` event down the
    -- rewriting branch and grafted an empty `blocks: []` onto it. Caught by
    -- "leaves every other kind of event untouched" in `ownership.dbtest.ts`,
    -- which is the assertion that exists because a deduplication that changes a
    -- record it was only supposed to shrink is worse than no deduplication.
    when jsonb_typeof(payload -> 'blocks') is distinct from 'array' then payload
    else jsonb_set(payload, '{blocks}', coalesce((
      select jsonb_agg(
               case
                 when b ? 'sha' then (b - 'sha' - 'chars') || jsonb_build_object(
                   'text', coalesce(pb.text, '[missing prompt block ' || (b ->> 'sha') || ']')
                 )
                 else b
               end
               order by i
             )
        from jsonb_array_elements(payload -> 'blocks') with ordinality as t(b, i)
        left join public.prompt_blocks pb on pb.sha = b ->> 'sha'
    ), '[]'::jsonb))
  end
$$;

-- A `SECURITY INVOKER` function in `public` is still exposed by PostgREST as a
-- callable rpc. It reads a table nothing outside the server may read, so it
-- would return the missing-block marker for everything and be useless — but an
-- endpoint that is useless is still an endpoint. Same call as the Phase 11
-- migration made for `handle_new_user`.
revoke execute on function public.rehydrate_blocks(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- THE VIEWS
-- ---------------------------------------------------------------------------
--
-- FOR READING FROM THE DASHBOARD, which is the whole reason they exist.
--
-- The stored form is the compact one, so `select payload from journal_events` in
-- the SQL editor is already what you want most of the time — a turn's events
-- without 27 kB of playbook wrapped around them. These are for the other case:
-- when the question IS the prompt, and you need the text the model actually saw.
--
-- `security_invoker = true` because a view in PG 15+ otherwise runs as its OWNER,
-- which would let anything holding the publishable key read every run in the
-- database through a view over tables whose RLS it cannot touch. The grants below
-- are the real lock and this is the second one.

create view public.journal_events_full
with (security_invoker = true) as
  select run_id, seq, at, kind, public.rehydrate_blocks(payload) as payload
    from public.journal_events;

create view public.dungeon_events_full
with (security_invoker = true) as
  select dungeon_id, seq, at, kind, public.rehydrate_blocks(payload) as payload
    from public.dungeon_events;

revoke all on public.journal_events_full from anon, authenticated;
revoke all on public.dungeon_events_full from anon, authenticated;
