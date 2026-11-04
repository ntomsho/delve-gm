-- GENERATION STEPS replace GENERATION CHUNKS.
--
-- A dungeon is now one region, written by one content call, and the calls after
-- the structure run one at a time as named steps (`STEPS` in
-- `src/generation/generate.ts`): `content` today, and the outline, repair and
-- polish steps after it. Each step's answer is kept unapplied until `finish`.
--
-- Pre-release: the chunk rows of any unfinished dungeon are dropped with the
-- table. Such a dungeon cannot finish; delete it.

drop table if exists public.generation_chunks cascade;

create table public.generation_steps (
  dungeon_id uuid not null references public.dungeons (id) on delete cascade,
  step       text not null,
  response   jsonb not null,
  created_at timestamptz not null default now(),
  primary key (dungeon_id, step)
);

alter table public.generation_steps enable row level security;

-- No owner of its own; it inherits its dungeon's, like `dungeon_events`.
create policy generation_steps_owner on public.generation_steps
  for all to authenticated
  using (exists (
    select 1 from public.dungeons d
     where d.id = generation_steps.dungeon_id and d.owner_id = auth.uid()
  ));
