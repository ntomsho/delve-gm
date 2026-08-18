-- PHASE 13a — SHARED WORLDS
-- =========================
--
-- One column, and it is the difference between a copy and a coincidence.
--
-- A dungeon may now be duplicated: the row, the `doc` and the generation
-- journal, under a new uuid and a new owner. The reason the copy has to be
-- recorded as a copy is the second click. `Take a copy` pressed twice must not
-- mint two half-megabyte rows of the same world, and there is no other way to
-- tell that the player already has this one — matching on `dungeon_key` is
-- WRONG for exactly the reason the key exists: a seed fixes the structure, the
-- stocking and the floorplan, but the prose, the names and the objective text
-- are content-pass model output. Two dungeons from seed 4201 are the same
-- skeleton wearing different writing, so "you already have a seed-4201 dungeon"
-- is not an answer to "may I have THAT one".
--
-- SO IT IS PROVENANCE, NOT A UNIQUENESS RULE. There is deliberately no unique
-- index here: a player may generate seed 4201 twice and get two different
-- worlds, which is legitimate and stays legitimate. What is refused is copying
-- one source twice, which is the only case where the second row is guaranteed
-- to be identical to the first.
--
-- ON DELETE SET NULL, and not cascade. A copy is a whole standalone dungeon —
-- its own `doc`, its own `dungeon_events` — so it must survive its source. The
-- source's owner deleting their account cascades their dungeons away
-- (`dungeons.owner_id references auth.users on delete cascade`), and cascading
-- from here would take every copy anyone ever made with it. The copy loses its
-- parentage and keeps its world, which is the honest outcome.

alter table public.dungeons
  add column copied_from uuid references public.dungeons (id) on delete set null;

-- Asked once per duplicate, by the owner, to find out whether they already took
-- this one. Partial because a duplicate is only ever made from a complete
-- world — see `duplicateDungeon` in `src/server/repo.ts`.
create index dungeons_copy_idx on public.dungeons (owner_id, copied_from)
  where copied_from is not null;

-- RLS is untouched: `dungeons_owner` is `for all` on `owner_id = auth.uid()`,
-- and a copy is owned by whoever made it. The CROSS-OWNER read that duplicating
-- needs happens on the API's privileged connection, which is the same
-- arrangement §8.6 gives for serving a summary — the backstop stays owner-only
-- and does not become the thing deciding what may be copied.
