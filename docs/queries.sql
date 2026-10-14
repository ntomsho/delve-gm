-- READING WHAT THE TESTERS DID
-- ============================
--
-- Paste these into the Supabase dashboard → SQL Editor. It runs as a privileged
-- role, so it sees every account's rows — which is the whole admin story. There
-- is no admin API route and there is deliberately not going to be one: an
-- endpoint that can read everybody's runs is a thing that has to be kept safe
-- forever, and the dashboard already exists and is already behind your login.
--
-- WHAT COMES BACK IS ALREADY COMPACT. A `system` journal event used to carry
-- 25-45 kB of playbook and carried it again on every game master call. The text now
-- lives once in `prompt_blocks` and the event names it by hash, so `select
-- payload from journal_events` is the turn and not the instructions wrapped
-- around it. Read `journal_events_full` instead when the PROMPT is the question.
--
-- ONE THING IS NOT A QUERY. A readable transcript is `journal/render.ts`, so
-- download §3 as CSV and run `npm run transcript -- <file>`.


-- ---------------------------------------------------------------------------
-- 1. WHO HAS PLAYED WHAT, AND WHICH ONES WENT WRONG
-- ---------------------------------------------------------------------------
--
-- The one to start from. Errors and refused commits are the two columns worth
-- scanning: a run with either is a run worth opening.

select r.id                                            as run_id,
       u.email,
       c.sheet ->> 'name'                              as character,
       d.doc -> 'pass' ->> 'name'                      as dungeon,
       d.seed, d.size, d.level,
       r.status,
       (r.state ->> 'turnCount')::int                  as turns,
       count(*) filter (where j.kind = 'error')        as errors,
       count(*) filter (where j.kind = 'commit'
                          and (j.payload ->> 'ok') = 'false') as refused_commits,
       pg_size_pretty(sum(pg_column_size(j.payload)))  as journal_size,
       r.created_at, r.updated_at
  from runs r
  join auth.users u          on u.id = r.owner_id
  join dungeons d            on d.id = r.dungeon_id
  left join characters c     on c.id = r.character_id
  left join journal_events j on j.run_id = r.id
 group by r.id, u.email, c.sheet, d.doc, d.seed, d.size, d.level
 order by r.created_at desc;


-- ---------------------------------------------------------------------------
-- 2. WHAT WENT WRONG, ACROSS EVERY RUN
-- ---------------------------------------------------------------------------
--
-- Generation failures live against the DUNGEON and play failures against the
-- RUN, so this is both streams. `generation-error` carries the validation issues
-- that were actually objected to, which is usually the whole answer.

select 'run'      as stream, r.id::text as parent, u.email,
       j.at, j.kind, j.payload
  from journal_events j
  join runs r       on r.id = j.run_id
  join auth.users u on u.id = r.owner_id
 where j.kind in ('error', 'generation-error')
    or (j.kind = 'commit' and (j.payload ->> 'ok') = 'false')
union all
select 'generation', d.id::text, u.email,
       e.at, e.kind, e.payload
  from dungeon_events e
  join dungeons d   on d.id = e.dungeon_id
  join auth.users u on u.id = d.owner_id
 where e.kind = 'generation-error'
 order by at desc;


-- ---------------------------------------------------------------------------
-- 3. ONE RUN'S JOURNAL  ← download as CSV, then `npm run transcript`
-- ---------------------------------------------------------------------------
--
-- Generation followed by play, which is the order they happened in. The two
-- streams number independently — generation's `seq` belongs to the dungeon and
-- play's to the run — so they are renumbered here, exactly as `readJournal`
-- does it.
--
-- Swap `journal_events` → `journal_events_full` and `dungeon_events` →
-- `dungeon_events_full` to get the playbook text back. That is a 40 kB row per
-- game master call and you almost never want it.

with j as (
  select at, kind, payload from dungeon_events
   where dungeon_id = (select dungeon_id from runs where id = '00000000-0000-0000-0000-000000000000'::uuid  /* ← the run id */)
  union all
  select at, kind, payload from journal_events where run_id = '00000000-0000-0000-0000-000000000000'::uuid  /* ← the run id */
)
select jsonb_set(payload, '{seq}', to_jsonb(row_number() over (order by at))) as payload
  from j
 order by at;


-- ---------------------------------------------------------------------------
-- 4. ONE WORLD, WHOLE — layout, procgen, every room and every entity
-- ---------------------------------------------------------------------------
--
-- `doc` is the complete `GeneratedDungeon`: `seeds` and `blueprint` (the rolls
-- behind the place), `graph` (phase A), `blockplan` (the floorplan as drawn),
-- `stocked` (per-room role, headline, identity roll, size class, danger, reward)
-- and `entities` (the registry plus every room, connector, creature, feature,
-- item, hazard and binding, each with the keywords it was rolled from).
--
-- The DRAWN map is not in here and is not missing: `floorplanLayout(blockplan,
-- graph)` is pure, so the picture is a function of two columns above.

select doc from dungeons where id = '00000000-0000-0000-0000-000000000000'::uuid  /* ← the dungeon id */;

-- Flattened, when you want to scan rooms rather than read one:
select s ->> 'roomId'                      as room_id,
       s ->> 'role'                        as role,
       s ->> 'headline'                    as headline,
       s -> 'identity' ->> 'result'        as identity,
       s ->> 'sizeClass'                   as size_class,
       (s ->> 'depth')::int                as depth,
       (s ->> 'danger')::numeric           as danger,
       (s ->> 'isCorridor')::boolean       as corridor,
       s -> 'reward'                       as reward,
       jsonb_array_length(coalesce(s -> 'occupants', '[]')) as occupants
  from dungeons d, jsonb_array_elements(d.doc -> 'stocked' -> 'rooms') s
 where d.id = '00000000-0000-0000-0000-000000000000'::uuid  /* ← the dungeon id */
 order by depth, room_id;

-- Every entity in a world, with the procgen rolls behind it:
select e.key                as entity_type,
       v ->> 'id'           as id,
       v ->> 'name'         as name,
       v -> 'keywords'      as rolls,
       length(v ->> 'base') as base_chars
  from dungeons d,
       jsonb_each(d.doc -> 'entities') e,
       jsonb_array_elements(case when jsonb_typeof(e.value) = 'array'
                                 then e.value else '[]'::jsonb end) v
 where d.id = '00000000-0000-0000-0000-000000000000'::uuid  /* ← the dungeon id */
 order by entity_type, id;


-- ---------------------------------------------------------------------------
-- 5. WHAT IS THE DATABASE ACTUALLY FULL OF
-- ---------------------------------------------------------------------------
--
-- Run this when the free tier starts looking close. The first query is the one
-- that told us the playbook was two thirds of every journal.

select payload ->> 'kind'                          as kind,
       count(*)                                    as events,
       pg_size_pretty(sum(pg_column_size(payload))) as total,
       pg_size_pretty(avg(pg_column_size(payload))::bigint) as average
  from journal_events
 group by 1
 order by sum(pg_column_size(payload)) desc;

select relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by pg_total_relation_size(c.oid) desc;

-- How much the block table is saving: what the playbook WOULD have cost stored
-- inline, against what it costs stored once.
select count(*)                                   as distinct_blocks,
       pg_size_pretty(sum(pg_column_size(text)))  as stored_once,
       pg_size_pretty((
         select sum(pb.chars)::bigint
           from journal_events j,
                jsonb_array_elements(j.payload -> 'blocks') b
           join prompt_blocks pb on pb.sha = b ->> 'sha'
       ))                                          as would_have_cost_inline
  from prompt_blocks;
