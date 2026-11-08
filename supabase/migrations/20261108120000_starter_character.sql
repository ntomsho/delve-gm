-- THE STARTER CHARACTER, handed out once per account.
--
-- A new account (Google or guest) finds a ready-made character on its roster
-- the first time it opens it (`grantStarterIfDue`, src/server/db/characters.ts).
-- This flag is what makes it once: without it, "the roster is empty" would hand
-- a player who deleted the starter a fresh one on the next refresh.
--
-- ADDITIVE ONLY. Localhost and production share this database, and code that
-- does not know the column ignores it, so this can be applied before the code
-- that reads it is deployed.
--
-- Accounts that already exist are marked as granted: they made their own
-- characters already, and nothing is retrofitted before release.

alter table public.profiles
  add column if not exists starter_granted boolean not null default false;

update public.profiles set starter_granted = true where starter_granted = false;
