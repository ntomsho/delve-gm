-- ---------------------------------------------------------------------------
-- THE SPEND LEDGER
-- ---------------------------------------------------------------------------
--
-- ROADMAP, *Running it for strangers*. One row per paid call: every Anthropic
-- response and every image fal drew. The cost is worked out in code from the
-- prices in `src/llm/models.ts` and written here, so the daily budget and
-- ceiling (`src/server/spend.ts`) are one sum over today's rows.
--
-- THE LEDGER OUTLIVES WHAT IT PAID FOR. Money spent on a guest who is later
-- swept, or a run that is later deleted, was still spent. So `user_id` goes to
-- null rather than taking the row with it, and `run_id` and `dungeon_id` are
-- plain columns with no foreign key at all.
--
-- Reading it, in the SQL editor:
--   -- today, by task
--   select task, count(*), sum(cost_usd) from spend
--    where at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
--    group by task order by 3 desc;
--   -- whether prompt caching is paying
--   select task, sum(cache_read_tokens)::float / nullif(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0)
--     from spend where images = 0 group by task;

create table public.spend (
  id                 bigint generated always as identity primary key,
  at                 timestamptz not null default now(),
  user_id            uuid references auth.users (id) on delete set null,
  run_id             uuid,
  dungeon_id         uuid,
  -- a `Task` from models.ts for a text call; `illustration`, `cover` or
  -- `sprite` for an image
  task               text not null,
  model              text not null,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_write_tokens integer not null default 0,
  cache_read_tokens  integer not null default 0,
  images             integer not null default 0,
  cost_usd           numeric(12, 6) not null
);

-- The budget's sum, run before every paid call.
create index spend_at_idx on public.spend (at);

-- The API reaches it as the database owner; nobody reaches it through
-- PostgREST. RLS on with no policies says exactly that.
alter table public.spend enable row level security;
