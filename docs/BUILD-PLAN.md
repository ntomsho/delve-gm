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

### Sizes

`Size` (`src/generation/content/blueprint.ts`) changes from `1 | 2 | 3 | 4 | 5` to
`"small" | "medium" | "large"`. The room count is rolled in code from the generation
seed, inside the size's range:

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
- **Allowance** (`src/server/allowance.ts`): `MAX_GENERATED_SIZE = 1` becomes
  `"small"`, and `maxSize` compares sizes by order. Unlimited accounts get `"large"`.
- **Dev and UI**: the size switch (`src/ui/app/switches.ts`), the run setup picker
  (`RunSetup.tsx`), `Session.size`, `dev/lib/generate.ts` and `dev/lib/play.ts`.

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

If a seed range at small fails the route check too often, small drops to accepting a
single loop that the entrance and goal both sit on, which always gives two routes.
Measure first.

**Data model.** `Room.chunk`, `onCycle`, `cycleIndex`, `EdgeKind`/`Edge.kind` and
`Dungeon.chunkCount` go. `Stats` drops `interChunkEdges` and `cycleLengths` and gains
`deadEnds` and `routes`. `batch()` takes a size.

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
- **Failure rate.** Measure how often the block plan fails at large. It should be far
  below the old size 5 rate. If it is, drop the roadmap item **Positions from the planar
  embedding**.

### Landing layout before the passes

Stocking sets `RoomStock.chunk = 0` for every room, so the current pipeline runs the whole
dungeon as one region: one content call, no seams, one region challenge. That is how
size 1 runs today. Layout can land and be checked on its own; the passes step then
deletes `chunk` for good. Production is capped at small, so raise the content pass's
`MAX_TOKENS` only if a medium or large dev run hits it.

### Passes

- **Content pass: one call for the whole dungeon.** `buildContentPassPayload` stops
  filtering by chunk. Every connector is written by its lower-graph-index room, so none
  are left for anything else. Raise its `MAX_TOKENS` in `models.ts` to fit 12 rooms, and
  measure what a large one actually uses.
- **Seams pass: deleted.** That means `seams-pass.ts`, `seams-pass.md`,
  `seams-pass.schema.md`, its `Task` and token entries, `seamsPassOmissions`, and its
  journal and stage entries. `connector-naming.md` and `connector-height.md` stay, because
  the content pass uses them.
- **Keys pass: unchanged** in this phase.
- **Region challenges** (`challenges.ts`: one per chunk, answered by a region key that
  charts rooms) go with the chunks. Phase 2's outline names areas, and region challenges
  can come back as areas then. Until then nothing produces a region key.

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
  - §1: the "size *n* is *n* chunks" line.
  - §3: the diagram and the passes.
  - §3.3: "per chunk" for group bases.
  - §8.1: "a size 5 dungeon has about 30" challenges.
  - §8.2: the pot formula.
  - §11: the routes.
- **ROADMAP.md**:
  - **One leader, one entity** is fixed once there are no chunks; remove it.
  - **Connectors written with their room** is mostly answered; rewrite it to whatever is
    left.
  - **The placed-key spread** quotes size 5 numbers; restate it for large.
- **Comments**: `models.ts`'s per-chunk comments, and the `generate.ts` header.

### Done when

- Tests pass: `graph.test`, `generation.test`, `keys.test`, `rewards.test`, determinism
  and snapshots (updated, not deleted).
- `graph.test`, at 3 sizes × 7 seeds, asserts every row of the **Checks** table under *The room graph*.
  `stock.test` asserts the gate rules: the goal is never hidden-only, and hidden
  connectors go on shortcuts when there are any.
- An offline run (`generateOffline` / `--dry`) on five seeds per size draws a block plan
  on every seed and prints graph attempts per size. Then look at the three maps.
- One live generation per size finishes and plays its first room.

---

## Phase 2: the outline pass

The pipeline after this phase:

```
dungeon pass (LLM) ─┐
graph + block plan ─┘   seed advances until the layout exists; every room has a size class
  → roll candidates (code)
  → outline (LLM) → repair ×≤2 (LLM) → polish ×1–2 (LLM, optional)
  → stocking steps 5–8 on the assigned rooms, then rewards and keys (code)
  → content pass (LLM, with the outline in front of it) → keys pass (LLM; may be removed)
```

### What code rolls

`V` is the room count.

- **Room fictions: `ceil(1.5 × V)` candidates.** Each is an identity plus its features
  if it has any, along with the size classes it fits (`sizeAllows`). Rolled with the
  layout's size classes in hand, so every candidate fits at least one room.
- **Mandatory fictions: `ceil(V / 3)`** of the candidates, marked as such. They must all
  fit at once: there is an assignment of mandatory fictions to distinct rooms that
  `sizeAllows`. If not, reroll the mandatory set.
- **Headlines: exactly `V`.** The required ones go first: the entrance's `none`, the
  goal's `special`, and a `creature` headline for each inhabitant group's base room. The
  rest follow stocking's existing quota (step 3) for the target mix. Code rolls the mix
  and the model only places headlines, so the distribution holds with nothing to enforce.
- **Pre-assigned.** Whatever code already places is written into the payload, not left
  to the model: the entrance's and goal's headlines, and the goal entity.

Stocking step 4 (headline placement by depth fit plus local swaps) is replaced by the
outline. Steps 5–8 run afterwards on the rooms as assigned.

### The outline call

**Payload**, one entry per room in graph order, each complete on its own line so nothing
needs looking up elsewhere: id, size class, depth from the entrance, dead end or on a
loop, its neighbours, and anything pre-assigned. Then the candidate fictions (mandatory
ones marked), the headlines, the inhabitant groups and their goals from the dungeon pass,
and the challenges a key could answer.

**Response**, references and short prose only, never a number:

- per room: a fiction ref, a headline ref, and one line on the room's part in the
  dungeon's story;
- per connection: what it is (a door, a stair, a collapsed tunnel, which side is
  higher), in a phrase;
- the dungeon's areas: two or three named groups of rooms at medium and large, which
  bring region challenges back;
- key↔challenge pairs by reference: which challenge each planned key answers, and what
  the key is.

**Validation** (zod, then a `check`):

- every room assigned exactly once;
- no fiction or headline used twice;
- every mandatory fiction and required headline present;
- every fiction fits its room's size class;
- every connection described;
- pre-assigned values unchanged;
- every key pair references a real challenge.

Code then places each planned key in a room still reachable from the entrance without
passing the thing it opens (§8.2's rule, unchanged).

### Repair

Repair is required and narrow. On a validation failure, code sends back only the
violations (for example, "fiction F7 is used twice: rooms C and K") and asks for
replacement values for the rooms and connections they name. Code merges the replacements
and validates again. **At most two repair calls, then the generation fails.** A pass
still never produces partial content.

The repair call is generic over a pass's schema and check, so the dungeon pass and the
content pass can use it too. It replaces `callForJson`'s current re-ask with the errors
appended.

### Polish

Polish is optional and runs only on an outline that has passed validation. The reviewer
gets the dungeon pass, the full outline and the payload, and answers with **a list of
at most k edits**, not a rewrite: swap two rooms' fictions, swap two rooms' headlines,
swap in an unused optional fiction, rewrite a room's story line, rewrite a connection's
nature. It cannot remove a mandatory fiction or touch anything pre-assigned. Code applies
the edits and validates again. **If the result fails, keep the version from before the
polish.** One or two rounds, set by a flag.

The reviewer's criteria, in the prompt as questions:

1. **Does each room fit the dungeon's concept?** A mandatory oddity should be worked in,
   not smoothed away. Its strangeness is why it is mandatory.
2. **Do the routes to the goal feel different, and ask different things of the player?**
   Two paths through the same kind of challenge count as one route.
3. **Does each creature's placement fit its group's goals and the layout?** Guards stand
   where something is worth guarding, a lair is somewhere defensible, a patrol is on a
   through route.
4. **Are the challenges well paced?** No early death traps or easy windfalls near the
   entrance, and no easy stretches or useless finds deep in the dungeon. Depth is in the
   payload for this question.
5. **Do the rooms tell the dungeon's story?** Walking any route, the player should piece
   together the history the dungeon pass wrote.

Every outline version (draft, each repair, each polish round) is logged in the journal,
so a run shows what polish changed and whether it was kept.

### Models

The outline, repair and polish calls each get their own `Task` in `src/llm/models.ts`,
so their models switch independently. The writer/reviewer combination is a dev flag.
Three combinations are compared:

| Run | Outline + repair | Polish |
|---|---|---|
| control | Haiku 4.5 | none |
| A | Haiku 4.5 | Sonnet 5 |
| B | Sonnet 5 | Haiku 4.5 |

The control is there to show whether polish helps at all.

### Measuring

A dev CLI (`src/dev/cli-outline.ts`) runs the outline, repair and polish steps alone,
with no content pass. It covers 5 seeds × 3 sizes × the three runs above, which is 45
outlines. For each outline it records:

- whether it passed validation on the first try, and which rules failed;
- the number of repairs;
- how many polish edits were proposed, accepted and rolled back;
- tokens, cost and seconds.

It writes each seed's outlines side by side to read. The models table in `models.ts` is
set from the results, and only then is the content pass wired to the outline.

### Afterwards, each its own decision

- **The keys pass.** If the content pass, given the outline's key pairs, writes good keys
  together with their challenges, remove the keys pass.
- **Polish on the dungeon pass and the content pass.** Same edit-list shape. Add it for
  the content pass last, because it has the largest output.

### Done when

- The outline is validated, repaired and polished as above, each call its own step
  request.
- The 45-outline measurement has been run and the model choice made from it.
- Generation runs end to end at each size with the outline in the content pass's prompt.
- ARCHITECTURE.md §3 describes the new pipeline.
