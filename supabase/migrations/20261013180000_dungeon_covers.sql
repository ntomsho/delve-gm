-- ---------------------------------------------------------------------------
-- DUNGEON COVERS
-- ---------------------------------------------------------------------------
--
-- A dungeon's exterior, drawn once when it is written: the picture on its
-- library card and above its opening. The image lives in `plates` like a room
-- plate; this names which one.
--
-- Beside `doc`, not in it: `doc` is the world as generated and is never written
-- at runtime. Null for a dungeon finished before covers existed, and those are
-- left without one. A copy carries its source's (`duplicateDungeon`), so the
-- copies share one picture.

alter table public.dungeons add column cover text;
