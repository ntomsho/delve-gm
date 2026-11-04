# Build plan: smaller dungeons, then an outline pass

Two phases, one session each, in order. Phase 1 removes chunks and changes nothing about
how rooms are chosen. Phase 2 adds the outline pass that chooses them. How the game works
today is in [`ARCHITECTURE.md`](ARCHITECTURE.md); the rest of the planned work is in
[`ROADMAP.md`](ROADMAP.md).

**Why.** A dungeon reads as one place only if something sees all of it before the rooms
are written. Today each content pass sees one six-room chunk and `dungeonContext`, and
code places headlines by depth. Nobody decides how the rooms fit together as a story.
At 12 rooms or fewer, one call can see the whole dungeon, so the chunks and the seams
pass that joins them stop being needed. Bigger dungeons, if they come, are several linked
dungeons, one per region. That is not part of this plan.

---

## Phase 1: cut chunks

**Status.** Built, except the live check: one generation per size, which calls the
model and waits for a go-ahead. One content call writes the whole dungeon, the seams
pass and `RoomStock.chunk` are gone, region challenges are not produced (the engine
still charts one), and the server runs `STEPS` (`generate.ts`) as
`POST /api/dungeons/:id/steps/:step`, saved in `generation_steps`
(`supabase/migrations/20261102120000_generation_steps.sql`). The content pass's
`MAX_TOKENS` stays at 16384: a 12-room answer used about 9,000. Offline, five seeds
per size (1005, 2024, 4242, 77, 1007) all draw a plan and leave nothing unwritten.

### Sizes

`Size` (`src/generation/content/blueprint.ts`) narrows from `1 | 2 | 3 | 4 | 5` to
`1 | 2 | 3`, named small, medium and large (`SIZE_NAMES` in `src/generation/seeds.ts`).
It stays a number because `dungeons.size` is an integer column with a cache index on
it, so words would need a migration and an API change for nothing a player sees: the
run setup screen has no size control. Size 1 already meant about six rooms. The room
count is rolled in code from the generation seed, inside the size's range:

| Size | Rooms | Loops (circuit rank) | Max dead ends | Inhabitant groups |
|---|---|---|---|---|
| small | 5–6 | 1–2, weighted to 2 | 1 | 1 |
| medium | 7–9 | 2–3 | 1 | 1–2 |
| large | 10–12 | 3–4 | 2 | 2 |

The room and loop counts are rolled once, before any graph attempt, so a retried graph
keeps the dungeon's shape. `chunksFor` in `src/generation/seeds.ts` becomes
`shapeFor(size, graphSeed)`, returning `{ rooms, loops }`. The table lives there so
`floorplan/` doesn't import from `content/`.

Anything that scaled with `size` scales with the room count instead, at the density
it has today:

- **Treasure pot** (`rewards.ts`): `size × 250–400` copper was over six rooms per size
  step, so it becomes `rooms × 42–67`. The 10% game-master coin allowance is unchanged.
- **Group count** (`groupCountForSize`): the table above.
- **Corridors** (`designateCorridors`): a sixth of the rooms, rounded, ±1; six rooms or
  fewer is a coin flip between none and one.
- **Allowance** (`src/server/allowance.ts`): `MAX_GENERATED_SIZE` stays 1 (small).
  Unlimited accounts' `maxSize` drops from 5 to 3.
- **Dev**: `--size` accepts 1-3 (`dev/lib/generate.ts`, `dev/lib/play.ts`).

### The room graph

`src/generation/floorplan/graph.ts` is built around chunks (six rooms, six interior
edges, a 2-edge-connected graph of chunks). It is replaced by a whole-dungeon generator,
not adapted. `buildChunkInterior`, `buildChunkMultigraph`, `pickStubRoom` and the chunk
checks in `validate` go.

**Construction**, for `V` rooms and `μ` loops (`E = V − 1 + μ`):

1. **A loop core.** A cycle of 3–6 rooms, then `μ − 1` extra paths (ears), each joining
   two different core rooms with doors to spare and carrying 0–2 new rooms. An ear
   never joins two rooms that are already neighbours.
2. **The rest.** Remaining rooms attach to rooms with doors to spare, singly or in a
   short chain. Dead ends are not built on purpose; they are whatever this leaves.
3. **Rejection.** Every graph is checked (below), and a failure advances the graph seed,
   as a non-planar graph does today.

The old degree-mix target (1/6 dead ends, 1/3 corridors, 1/2 junctions) is dropped. At
these loop counts a large dungeon averages about 2.3 doors a room, so half the rooms
can't be junctions. The dead-end cap replaces it.

**Entrance and goal.** `Dungeon.entrances: number[]` becomes `entrance: number`, the room
furthest from the drawing's centre. That ends the leftover 2–3-entrance behaviour
`structuralPrePass` works around (`steps.ts:59`). The goal pick (depth × 10 + doors,
from `structuralPrePass`) moves into a function `graph.ts` exports, so the route checks
and stocking use the same goal. Neither the entrance nor the goal has to be on a loop;
a goal at the end of a chain is fine if the routes to it pass the checks.

**Routes.** A *route* is a path from the entrance to the goal that never visits a room
twice. Two routes are *distinct* when each has at least one room the other lacks, so
routes may share rooms, including a choke point. A route that only skips a room on
another is a bypass, not a second route. Graphs this small make it cheap to list every
route.

**Checks.** Small dungeons get slack, because there aren't enough rooms for more.

| Check | small | medium | large |
|---|---|---|---|
| Room count and loop count match the shape | yes | yes | yes |
| Connected, planar, max degree 4 | yes | yes | yes |
| Dead ends | ≤ 1 | ≤ 1 | ≤ 2 |
| Distinct routes to the goal | ≥ 2 | ≥ 3 | ≥ 3 |
| A bypass: some room on the shortest route can be skipped by a detour of ≤ 2 extra rooms | – | yes | yes |
| Balance: the two shortest distinct routes differ by ≤ 2 rooms | – | yes | yes |

Measured over 200 seeds per size, a graph is accepted 85% of the time at small, 56% at
medium and 82% at large, so a dungeon takes 1.2, 1.8 and 1.2 graphs on average (worst
3, 12 and 4). Medium is dearest because two loops rarely make three distinct routes.
Small did not need the single-loop fallback.

**Data model.** `Room.chunk`, `onCycle`, `cycleIndex`, `EdgeKind`/`Edge.kind` and
`Dungeon.chunkCount` go. `Stats` drops `interChunkEdges` and `cycleLengths` and gains
`deadEnds` and `routes`. `Edge.shortcut` marks an ear with no rooms. `batch()` had no
callers and went. `generateValid` tries 500 graphs and then throws, where it used to
return an invalid one.

**Positions.** `initialPositions` becomes one scatter with radius `95·√(V/6)`, the
single-chunk radius scaled up. `relax` uses one rest length, 72.

### Gates

`gateConnectors` (`src/generation/content/stock/steps.ts`) keeps deciding, in code, which
connectors are gated and which are hidden. The content pass keeps writing what each one
is. Gates are topology: key placement, reachability and the route checks all depend on
them, and route reasoning is where the model is weakest.

What changes is that gating now accounts for routes. Today gates are spread evenly,
guarded only per room, so one gate on each of two routes leaves two routes on paper and
one in play. The rules:

- **The goal is never hidden-only.** At least one route to the goal passes no hidden
  connector. A hidden connector rewards discovery; it is never required to finish.
- **Routes ask different things.** Prefer gating one distinct route and leaving another
  open, and never the same kind of gate on both.
- **Hidden connectors go on shortcuts.** An ear with no rooms on it (a direct connection
  between two core rooms) is where a secret passage belongs, because it bypasses
  something. Concealment draws from those first.
- **Unchanged:** the budget (a sixth to a quarter of connectors), no room fully gated
  except the secret room, and an open way into the entrance. With no dead ends there is
  no secret room; that already happens ("may be null").

In phase 2 the outline chooses from gate candidates that code has already checked
against these rules, and picks each gate's kind: blocked, hidden or hazardous.

### Layout

- **Spacing.** `blockplan.ts` `spaceOut` drops its `chunkOf` argument, and
  `TARGET_ACROSS` goes, so every connection targets `TARGET_SAME = 6`. Try a target from
  graph distance only if the plans for five seeds read badly.
- **Entrance.** `blockplan.ts:924` and `geometry.ts` `roomDepths` read `graph.entrance`.
- **Map.** `map-layout.ts` drops `chunk` and `interChunk`. `DungeonMap.tsx:659` draws every
  connector at stroke width 1.4, and the `interChunk` assertion in `view.test.ts:118`
  goes.
- **Failure rate.** Measured over 60 seeds per size: the block plan drew first time on
  every one, at every size, with the single target. The roadmap item **Positions from
  the planar embedding** is dropped.

### Landing layout before the passes

Stocking sets `RoomStock.chunk = 0` for every room, so the current pipeline runs the whole
dungeon as one region: one content call, no seams, one region challenge. That is how
size 1 runs today. Layout can land and be checked on its own; the passes step then
deletes `chunk` for good. Production is capped at small, so raise the content pass's
`MAX_TOKENS` only if a medium or large dev run hits it.

Six tests in `src/generation/generation.test.ts` are skipped for the bridge, because
they need a chunk boundary and there is none. The passes step deletes them with the
seams pass: *hands the chunk boundaries to the seams pass and nobody else*, *shows the
seams pass both rooms, written*, *ignores a chunk that answers with a seam anyway*,
*says nothing about a seam, which the chunk is told not to write*, *names a way through
the seams pass left out*, and the *seams pass* prompt snapshot.

### Passes

- **Content pass: one call for the whole dungeon.** `buildContentPassPayload` stops
  filtering by chunk. Every connector is written by its lower-graph-index room, so none
  are left for anything else. Raise its `MAX_TOKENS` in `models.ts` to fit 12 rooms, and
  measure what a large one actually uses.
- **Seams pass: deleted.** That means `seams-pass.ts`, `seams-pass.md`,
  `seams-pass.schema.md`, its `Task` and token entries, `seamsPassOmissions`, and its
  journal and stage entries. `connector-naming.md` and `connector-height.md` stay, because
  the content pass uses them.
- **Content pass repair: built, ahead of the rest of this step.** The first live large
  dungeon (seed 1005, 12 rooms, one content call) left one entity out of `room_8` on
  both the first answer and the whole retry, and the generation failed. Now an answer
  that is well-formed but incomplete is kept: the model is told what is missing and
  asked for only the rooms that hold it, which are merged in, up to two times, then the
  generation fails. A malformed answer still gets the one whole retry, since there is
  nothing to keep. It is the `repair` option on `callForJson` (`src/llm/client.ts`),
  with `askForRooms` and `mergeRooms` in `content-pass/response.ts`. Live, four more
  large dungeons (seeds 1005, 2024, 4242, 77) all finished; 4242 left a connector out
  of `room_9`, and the repair rewrote that one room for about 700 output tokens instead
  of about 9,000 for all twelve.
- **Keys pass: unchanged** in this phase. It could take the same repair, keyed by key.
- **Region challenges** (`challenges.ts`: one per chunk, answered by a region key that
  charts rooms) go with the chunks. Nothing produces a region key now. The idea that
  would bring them back is *Named areas* in `ROADMAP.md`, cut from phase 2 for now.

### Server and client

A Vercel invocation may run 300 seconds, and a six-room region call has already taken 50
(`src/server/vercel.ts`). So a 12-room content call stays its own request. The three
routes become:

1. `POST /api/dungeons`: graph, block plan, stocking and the dungeon pass, as now.
2. `POST /api/dungeons/:id/steps/:step`: one model call per request, idempotent, saved on
   arrival. Phase 1's only step is `content`. Phase 2 adds outline, repair and polish
   steps here without new routes.
3. `POST /api/dungeons/:id/finish`: applies, then the keys pass, as now.

- **Steps table.** A migration replaces `generation_chunks` (`dungeon_id, chunk`) with
  `generation_steps` (`dungeon_id, step`). `saveChunk`/`listChunks` in
  `src/server/db/dungeons.ts` become `saveStep`/`listSteps`.
- **Client.** `remote-session.ts` runs the steps in order instead of firing chunks in
  parallel. `LoadingScreen.tsx` drops `chunksDone`/`chunksTotal` and reports stage
  names from the list in `generate.ts`.
- **Log.** The journal and `generation/log.ts` drop `chunk` from their events.
- **Old dungeons** are not migrated (pre-release). If an old stored dungeon fails to
  load, delete it.

### Rules and docs to update

- **CLAUDE.md**: "applyContentPass runs serially in chunk order even when generation is
  parallel" no longer describes anything. Remove it, and remove the matching check in
  `architecture.test.ts` if there is one.
- **ARCHITECTURE.md**:
  - §3: the diagram and the content and seams passes.
  - §3.3: "per chunk" for group bases.
  - §11: the routes.
  - Done with layout: §1's size line, the graph and gates in §3.1, §8.1's challenge
    count, §8.2's pot, and the corridor and wall lines in the map section.
- **ROADMAP.md**:
  - **Connectors written with their room** is mostly answered; rewrite it to whatever is
    left.
  - Done with layout: **One leader, one entity** removed (one region writes each leader
    once), **The placed-key spread** restated with the new numbers, **Positions from the
    planar embedding** removed.
- **Comments**: `models.ts`'s per-chunk comments, and the `generate.ts` header.

### Done when

- Tests pass: `graph.test`, `generation.test`, `keys.test`, `rewards.test`, determinism
  and snapshots (updated, not deleted).
- `graph.test`, at 3 sizes × 7 seeds, asserts every row of the **Checks** table under *The room graph*.
  `stock.test` asserts the gate rules: the goal is never hidden-only, and hidden
  connectors go on shortcuts when there are any.
- An offline run (`generateOffline` / `--dry`) on five seeds per size draws a block plan
  on every seed and prints graph attempts per size. Then look at the three maps.
- One live generation per size finishes and plays its first room. Not yet run: it
  calls the model, so it waits for a go-ahead.

---

## Phase 2: the outline pass

**Status.** Detailed plan, under review. Nothing is built. It runs as two builds, with a
stop between them to read the outlines. Marked *proposed* where a decision is still open.

The pipeline after this phase:

```
dungeon pass (LLM) ─┐
graph + block plan ─┘   seed advances until the layout exists; every room has a size class
  → roll candidate fictions and content cards (code)
  → outline (LLM) → repair ×≤2 (LLM) → polish ×1–2 (LLM, optional)
  → the rest of stocking on the assigned rooms, then rewards and keys (code)
  → content pass (LLM, with the outline in front of it) → keys pass (LLM; may be removed)
```

The dungeon pass stays its own call and writes the theme, history, goal and inhabitants
first. The outline reads that output and places rooms and contents; it does not rewrite it.

### The two builds

**Build 1: the outline alone, with no change to live generation.**

- New pure functions roll the candidates and cards.
- New `outline` and `outline-polish` tasks in `src/llm/models.ts`, with zod schemas, `check`
  and the prompts below in `src/prompts/generation/`.
- Sonnet 5.5 support in `callForJson`: it returns a 400 on a forced `tool_choice`, so a task
  can ask for `auto` plus `strict` and a prompt instruction. A missing tool call already
  takes the existing retry. Add its price to `TEXT_PRICES` ($2 / $10), and send the refusal
  fallback (`fallbacks: "default"`) on it. Haiku 5.5 has no such fallback.
- The outline and polish tasks use `auto` on both models. On Haiku 5.5 a forced call skips
  thinking, which would make the comparison unfair and hurt the planning. Effort `medium`,
  `max_tokens` 16000.
- `src/dev/cli-outline.ts` runs the measurement below.

**Build 2: after the outlines have been read.**

- Split `stockDungeon` around the outline, and run the entities pass after it. Entity ids
  are random, so the settled dungeon is saved once and not rebuilt.
- Add the outline steps to `STEPS`, and a stage to the loading screen. Repair runs inside the
  outline step, as it does in the content pass; split it out only if timing requires it.
- Give the content pass the outline, and set the models from the results.
- Update ARCHITECTURE.md §3.

### What code rolls

`V` is the room count. A *chamber* is an ordinary room and a *passage* is a room stocking
marked `isCorridor`, which rolls its identity from `DUNGEON_CORRIDORS` instead of
`DUNGEON_ROOMS` and can only hold the fixtures that fit a passage.

- **Room fictions.** `ceil(1.5 × chambers)` chamber candidates and `ceil(1.5 × passages)`
  passage candidates, so a chamber fiction can't land in a corridor. Each is an identity
  plus a room detail if it rolled one, along with the size classes it fits (`sizeAllows`).
  Rolled with the layout's size classes in hand, so every candidate fits at least one room.
- **Mandatory fictions: the first `ceil(V / 3)` chamber candidates.** Code marks them; the
  model does not choose which are mandatory. They must all fit at once: there is an
  assignment of mandatory fictions to distinct rooms that `sizeAllows`. If not, reroll the
  mandatory set.
- **Content cards: exactly `V`** (*proposed*). A card is a headline with its contents already
  rolled, so the model places a concrete thing and not the word "creature". The headline mix
  still comes from stocking's quota (step 3), so the distribution holds with nothing to
  enforce. Rolled the way steps 5a to 5c roll them today:
  - `creature`: a *group base* card for each inhabitant group (`makeGroupMobile`), then the
    rest from `makeMinionOrWanderer`, with activity and disposition;
  - `special`: `rollSpecial`, a hazard, a trap or an obstacle;
  - `quiet`: empty half the time, a clue the other half;
  - `none` for the entrance, and the goal's `special`, both pre-assigned.
- **Challenges** are enumerated from the cards before the call, so key pairs can answer any
  of them. Today most challenges don't exist until step 5, after headlines are placed.
- **Pre-assigned.** Whatever code already places is written into the payload, not left to the
  model: the entrance's and goal's cards, the goal entity, and the group base of a
  goal-implicated group, which stays in the goal room. Every other group base is placed by
  the model (*proposed*); today it is a random room.

Stocking step 4 (headline placement by depth fit plus local swaps) is replaced by the
outline. Stacking, danger, rewards and clue targets run afterwards on the rooms as assigned.

### The outline call

**Payload**, one entry per room in graph order, each complete on its own line so nothing
needs looking up elsewhere: id, size class, chamber or passage, depth from the entrance, dead
end or on a loop, its neighbours, and anything pre-assigned. Then the routes from the entrance
to the goal (`routesOf`), the dungeon pass's theme, history, goal and groups, the candidate
fictions (mandatory ones marked), the cards, and the challenges a key could answer.

**Response**, references and short prose only, never a number:

- per room: a fiction ref, a card ref, a story note, a journey note, and at most one story
  feature (*proposed*);
- per connection: what it is (a door, a stair, a collapsed tunnel, which side is higher), in
  a phrase;
- key↔challenge pairs by reference: which challenge each planned key answers, and what the
  key is.

**Story features** (*proposed*) let the model tie a room in better: tally marks on a wall, a
half-burned order, claw marks at shoulder height. A feature is scenery with no mechanics. It
is written by the content pass like any other feature, and it is not a way through, a
creature, a hazard, treasure or a key. So the rolled budget of danger and reward holds.

**Validation** (zod, then a `check`):

- every room assigned exactly once;
- no fiction or card used twice, and every card used;
- every mandatory fiction present;
- every fiction fits its room's size class and kind;
- every connection described;
- pre-assigned values unchanged;
- at most one story feature per room;
- every key pair references a real challenge.

Code then places each planned key in a room still reachable from the entrance without
passing the thing it opens (§8.2's rule, unchanged).

### Repair

Repair is required and narrow. On a validation failure, code sends back only the violations
and asks for replacement values for the rooms and connections they name. Code merges the
replacements and validates again. **At most two repair calls, then the generation fails.** A
pass still never produces partial content.

The mechanism exists: the `repair` option on `callForJson`, built for the content pass in
phase 1 (see *Passes*). The outline pass supplies its own `ask` and `merge`, keyed by room and
connection.

### Polish

Polish is optional and runs only on an outline that has passed validation. The reviewer gets
the dungeon pass, the full outline and the payload, and answers with **a list of at most 6
edits**, not a rewrite. It cannot remove a mandatory fiction or touch anything pre-assigned.
Code applies the edits and validates again. **If the result fails, keep the version from
before the polish.** One round in the measurement; one or two afterwards, set by a flag.

Every outline version (draft, each repair, each polish round) is logged in the journal, so a
run shows what polish changed and whether it was kept.

### The instructions (draft, under review)

**Outline**

```
You are outlining a dungeon before any of it is written. The map is drawn and
its contents are rolled. You decide what goes where, so that it reads as one
place and is fun to play through.

FOR EACH ROOM, choose
- a fiction: what the place was built as. Fictions marked MANDATORY must all be
  used. If a room is an odd fit for the dungeon's concept (a Theater in a
  Prison), work it into the story by adding lore explaining its presence (the
  warden was fixated on making prisoners perform plays he wrote), or by making
  the room a slight variation on the concept (the "theater" was actually for
  viewing executions). You will leave some optional fictions unused.
- a card: what is in the room now. Every card is used exactly once.
- story: how this room came to be as it is, tied to the dungeon's history.
- journey: what this room does for a player coming through it.
- a story feature, if it helps: one piece of scenery that ties this room to the
  story or the journey. Tally marks on a wall, a half-burned order. Scenery only:
  never a way through, a creature, a hazard, treasure or a key.

FOR EACH CONNECTION: a phrase for what it physically is, suited to both rooms,
saying which side is higher if it changes level.

FOR EACH KEY: which challenge it answers and what the object is.

A FUN PLAY EXPERIENCE IS YOUR MAIN JOB. Read the routes first, then plan so that:
- dangers are properly signposted: a player paying attention gets warning before
  the thing that can kill them;
- exploration and clever thinking are rewarded: looking around, taking the side
  route or using something found earlier pays off;
- an interesting backstory is told through environmental storytelling: the player
  pieces it together from what they see, not from being told.
Different routes to the goal should ask different things of the player.

RULES
1. Use refs exactly as given. Anything marked pre-assigned stays as it is.
2. A fiction must fit its room's listed sizes and kind.
3. Never write a number, count, distance or statistic.
4. Notes are plans, one or two sentences each. Do not write the rooms' prose.
```

**Repair** (code fills in the violations and what is unused)

```
These parts of your outline broke a rule:
- fiction F7 is used twice: rooms C and K

Still unused: fictions F2, F5; cards H3.

Return replacements for only the rooms and connections named above. Everything
else stands.
```

**Polish**

```
You are reviewing a finished outline. Change only what clearly makes the
dungeon better. If it is already good, return no edits. At most 6 edits: swap
two rooms' fictions, swap two rooms' cards, swap in an unused optional fiction,
rewrite a room's story or journey note, add or rewrite a story feature, or
rewrite a connection.

Ask:
1. Does each room fit the concept of the dungeon, including mandatory rooms?
2. Are dangers signposted, and are exploration and clever thinking rewarded?
3. Do routes to the goal ask different things of the player?
4. Does each creature's placement fit its group's goals and the layout? Guards
   stand where something is worth guarding, a lair is somewhere defensible, a
   patrol is on a through route.
5. Is it well paced: no early death traps or windfalls near the entrance, no easy
   stretches or useless finds deep in?
6. Can the player piece together a part of the dungeon's history from what they
   find here?
7. Are all the important aspects of the dungeon's history represented in at least
   one room?

Say in one line why each edit helps. You cannot remove a mandatory fiction or
change anything pre-assigned.
```

**Addition to `content-pass.md`** (Build 2)

```
THE OUTLINE
Each room has a story note and a journey note, and each connector has a phrase.
These are decisions already made, so write to them. Make the journey note true
of the place without ever saying it; the player should feel it, not read it.
Write any story feature listed as an entity like any other. Do not quote the
notes or explain the plot. Where a note and the drawing disagree, the drawing
wins.
```

### Models

The outline, repair and polish calls each get their own `Task` in `src/llm/models.ts`, so
their models switch independently. The writer/reviewer combination is a dev flag. Four
combinations are compared:

| Outline + repair | Polish |
|---|---|
| Haiku 5.5 | Haiku 5.5 |
| Haiku 5.5 | Sonnet 5.5 |
| Sonnet 5.5 | Haiku 5.5 |
| Sonnet 5.5 | Sonnet 5.5 |

No run skips polish. Every outline version is logged (see *Polish*), so whether polish helps
at all shows in each run's draft against its polished version.

### Measuring

A dev CLI (`src/dev/cli-outline.ts`) runs the outline, repair and polish steps alone, with no
content pass. It covers seeds 1005, 2024 and 4242 at small size × the four combinations above,
which is 12 outlines. It calls the model, so it waits for a go-ahead. For each outline it
records:

- whether it passed validation on the first try, and which rules failed;
- the number of repairs, and any refusals;
- how many polish edits were proposed, accepted and rolled back;
- tokens, cost and seconds.

It writes each seed's outlines side by side to read. The models table in `models.ts` is set
from the results, and only then is the content pass wired to the outline.

### Afterwards, each its own decision

- **The keys pass.** If the content pass, given the outline's key pairs, writes good keys
  together with their challenges, remove the keys pass.
- **Polish on the dungeon pass and the content pass.** Same edit-list shape. Add it for the
  content pass last, because it has the largest output.

### Done when

- The outline is validated, repaired and polished as above.
- The 12-outline measurement has been run and the model choice made from it.
- Generation runs end to end at each size with the outline in the content pass's prompt.
- ARCHITECTURE.md §3 describes the new pipeline.
