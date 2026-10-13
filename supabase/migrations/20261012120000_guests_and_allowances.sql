-- ---------------------------------------------------------------------------
-- GUESTS AND ALLOWANCES
-- ---------------------------------------------------------------------------
--
-- `profiles.tier` was `byok | vip` and nothing read it: every account defaulted
-- to `byok` while in fact spending the author's key. It is reworked rather than
-- read as it stood (BUILD-PLAN, *Paying for strangers*, layer 3):
--
--   member     — the default. Limited per day; see `src/server/allowance.ts`.
--   unlimited  — the author, and whoever they choose. Exempt from allowances.
--
-- Guest versus member is NOT a tier. It comes from the token's `is_anonymous`
-- claim, which Supabase flips when a guest links Google, so there is no column
-- to keep in step with it.
--
-- Bring-your-own-key is a later addition, and gets its own value then.

alter table public.profiles drop constraint if exists profiles_tier_check;

update public.profiles set tier = case tier when 'vip' then 'unlimited' else 'member' end;

alter table public.profiles
  alter column tier set default 'member',
  add constraint profiles_tier_check check (tier in ('member', 'unlimited'));

-- Who is `unlimited` is data, not schema, and is set by hand in the SQL editor:
--   update public.profiles set tier = 'unlimited' where id = '<uid>';

-- The allowance counts a player's runs since midnight UTC on every run started.
-- `runs_owner_idx (owner_id, created_at desc)` already serves that query, so no
-- new index.
