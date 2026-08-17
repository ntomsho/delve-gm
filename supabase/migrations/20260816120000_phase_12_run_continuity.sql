-- PHASE 12 — RUN CONTINUITY
-- =========================
--
-- Phase 11 gave every row an owner. This one gives a CHARACTER a life that spans
-- runs: they can be in exactly one at a time, they can be picked back up, and
-- what has happened to them is countable.
--
-- IT IS ONE INDEX, and that is the point. Everything this phase needs is already
-- in the schema — `runs.character_id`, and a `status` whose check constraint has
-- carried 'abandoned' since Phase 11 without anything yet producing it. "This
-- character is in a run" is not a new fact to record; it is `status = 'active'`,
-- which the table has always known.

-- ---------------------------------------------------------------------------
-- ONE RUN AT A TIME
-- ---------------------------------------------------------------------------

-- A character may hold exactly one active run.
--
-- THE RULE IS STATED IN THE DATABASE RATHER THAN IN THE HANDLER, because a
-- handler can be forgotten and a second endpoint can be written by someone who
-- did not know about the first. `POST /api/runs` catches the violation and turns
-- it into a 409 naming the run they are already in.
--
-- A BOOLEAN ON `characters` WAS THE ALTERNATIVE AND IS WORSE: it is a second
-- source of truth for something `runs` already knows, and the failure mode of a
-- stale flag is a character locked out of the game with no run to abandon.
--
-- Partial, so the index holds one row per character rather than one per run —
-- every finished run drops out of it. NULLs do not conflict in a unique index,
-- so a run orphaned by a deleted character (`on delete set null`, Phase 11)
-- stays legal and locks nobody.
create unique index runs_one_active_per_character
  on public.runs (character_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- THE SCOREBOARD
-- ---------------------------------------------------------------------------

-- How many times this character has died, walked away, come out empty-handed,
-- and come out with it. DERIVED, NEVER STORED: the four counters are exactly the
-- four terminal values of `runs.status`, so they are a grouping of rows that
-- already exist rather than four columns that have to be kept in step with them.
-- A counter that disagrees with the rows it summarises is a scoreboard that
-- lies; this one cannot.
--
-- The index is what makes that grouping cheap enough to do on every load of the
-- characters screen. `owner_id` leads because every statement in `repo.ts`
-- filters on it first.
create index runs_character_status_idx
  on public.runs (owner_id, character_id, status);
