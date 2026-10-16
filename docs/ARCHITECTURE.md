# Architecture

How the game is built and the rules the code keeps. `src/README.md` maps the folders;
this document explains the design behind them. Planned work is in
[`ROADMAP.md`](ROADMAP.md).

1. [Principles](#1-principles)
2. [Seeds and determinism](#2-seeds-and-determinism)
3. [Generation](#3-generation)
4. [Entities](#4-entities)
5. [The turn](#5-the-turn)
6. [The applier](#6-the-applier)
7. [Rolls](#7-rolls)
8. [Rewards, keys and experience](#8-rewards-keys-and-experience)
9. [The map and geometry](#9-the-map-and-geometry)
10. [Illustrations and sprites](#10-illustrations-and-sprites)
11. [The server](#11-the-server)
12. [Code rules and testing](#12-code-rules-and-testing)

---

## 1. Principles

- **The model writes words; code owns everything else.** The model never generates a
  number. Every number in narration or in a state change traces to a seeded roll in
  code or to the game master's `roll` tool, which code answers. Room shapes, positions,
  counts, damage, treasure values and experience are all code.
- **The model proposes; code disposes.** A game master turn is a structured *commit*,
  validated by schema and then applied atomically by one applier that owns every
  invariant. A refused commit changes nothing.
- **Prose the player has read is true.** Narration is shown only after its commit has
  applied, and what the player was told (`composed`) binds later turns and the map.
- **Cheap to run.** Work done once beats work done per run, work done per dungeon beats
  work done per player, and code beats a model call wherever code can do the job. Every
  task runs on Haiku 4.5 by default (`src/llm/models.ts`); a pricier option has to earn
  its place by measurement.

---

## 2. Seeds and determinism

```ts
// src/generation/generate.ts
interface RunSeeds {
  dungeonSeed: number;    // the user-facing number
  graphSeed: string;      // `${dungeonSeed}`; graph retries derive `<graphSeed>~<n>`
  blueprintSeed: number;
  stockSeed: number;
  layoutSeed: number;     // the block plan
  runSeed: number;        // a separate stream for play-time rolls
}
```

- Two RNG streams: generation and play. `CountingRng` (`src/shared/utils/rng.ts`) counts
  its draws, and `{ runSeed, rngDraws }` is persisted and fast-forwarded when a run is
  loaded, so a resumed run rolls the dice it would have rolled.
- **Entity ids are deliberately unseeded** (`crypto.randomUUID`). Ids are identity, not
  content. So a determinism check compares an id-stripped form, snapshots redact UUIDs,
  and replaying a run means loading the stored dungeon rather than regenerating it.
- **Size *n* is *n* chunks is *6n* rooms.** A chunk (a *region*) is the unit of parallel
  writing.

---

## 3. Generation

A dungeon is completely written before the first turn. `src/generation/generate.ts`:

```
  A: generateBlueprintSeed -> dungeon pass (LLM)                         ┐ concurrent
  B: generateBlueprint -> stockDungeon (+ block plan) -> entities pass   ┘
  join, then per chunk:
     buildContentPassPayload -> LLM -> zod     [parallel, all chunks at once]
     applyContentPass                          [serial, ascending chunk order]
  then: seams pass (LLM, 1 call) -> keys pass (LLM, 1 call)
```

### 3.1 The passes

- **Structure is code.** `generation/floorplan/` builds the room graph, makes it planar,
  and draws a *block plan*: every room's cells on a grid, adjacency holding by
  construction. `generation/content/stock/` stocks it from the Maze Rats tables: room
  identities, creatures, hazards, obstacles, treasure and the goal.
- **The dungeon pass** writes the dungeon's premise, its inhabitants and the opening,
  from the rolled genome alone, so it runs alongside stocking.
- **The content pass** writes each chunk's six rooms and everything in them, all chunks
  at once. Its applies run **serially in ascending chunk order**, because applying
  mutates shared state (`ep.items`, `ep.features`, `ep.bindings`,
  `ep.registry.creatures`).
- **A connector is written by whoever can see both its rooms.** Inside a chunk the room
  with the lower graph index owns it. A connector *leaving* a chunk is a **seam**,
  written by the seams pass at the end with both rooms in front of it.
- **The keys pass** writes the keys placed to answer challenges, with the key and the
  challenge's finished text both in front of it (§8).

### 3.2 Validation

- On a schema failure a pass is retried **once**, with the validation errors appended.
  A second failure throws. There is no partial content.
- **Well-formed but incomplete is a failure too.** Every ref a payload asks about must
  come back (`contentPassOmissions`, `seamsPassOmissions`, `keysPassOmissions`, run as
  `callForJson`'s `check` after zod), so an omission takes the same retry.
- `validateWritten` asserts a non-empty, resolvable `base` on every room, connector,
  creature, feature, item and hazard of a finished dungeon.
- **`state` and `composed` are not written during generation.** Every entity stays
  unencountered until the player meets it.
- The block plan runs inside stocking, through a `layout` hook, because a room's size
  class constrains what it may be (`sizeAllows` stops a four-cell closet rolling
  "Banquet hall"). `generateOffline` and `--dry` both run it.

### 3.3 `dungeonContext` and group bases

- `dungeonContext` is built in `applyDungeonPass` from the blueprint's inhabitants
  **alone** and never changes. Wandering monsters must never leak into it.
- Inhabitant group bases are written by the dungeon pass and wanderer bases by the
  content pass, both write-once on `TemplateRegistry.groups`. `resolveBase`
  (`src/shared/world/entities.ts`) finds an entity's base: inline first, then its
  group's or template's.

---

## 4. Entities

### 4.1 Three kinds of prose

| Field | Meaning | Written |
|---|---|---|
| `base` | Immutable identity | Once, at generation. **Never at runtime, by any path.** |
| `state` | What is true now | By the game master. `undefined` = not yet encountered |
| `composed` | What the player has read, rendered from `base` + `state` | By the game master, with `state` |

- `setState` sets `state` and marks `needUpdate`; it leaves `composed` alone.
  `composed === undefined` is the fog-of-war signal; `needUpdate` means *recompose when
  next seen*.
- When `composed` and `state` disagree about something the player is acting on,
  `composed` wins and `state` is corrected.
- `name`, `place` (cells and position) and `keywords` are identity and never change.

### 4.2 Occupancy

**There is no occupant list.** Containment is a field on the contained thing, and
occupancy is derived by scanning (`src/gameplay/mechanics/occupancy.ts`), so moving
something is one field write that cannot desynchronise anything.

| Entity | Link field |
|---|---|
| Creature, feature | `roomId` |
| Item | `parentId`: a room, a creature or a feature, so items nest |
| Mobile effect | `roomIds` |
| Connector | `endpointA` / `endpointB`, never written at runtime |

The player character is the one two-sided relation: `inventory` is a real array and
each item also carries `parentId`.

---

## 5. The turn

`src/gameplay/turn.ts` is the turn state machine; `src/gameplay/game-master/` is the
model that plays each turn.

### 5.1 Stage and step

```ts
type Stage = "room_entry" | "awaiting_action" | "thinking" | "clarifying" | "rejected"
           | "roll_offered" | "rolling" | "resolving" | "error"
           | "dead" | "departed" | "escaped" | "goal_met" | "abandoned";
type Step  = "1-target" | "2-classify" | "3-information" | "3-standard"
           | "4-confirm-roll" | "5-resolution" | "room-entry";
```

**Stage** drives the screen: the input area always says what the game is waiting for.
**Step** drives prompt assembly: which file of the playbook the game master reads.
`turn.ts` is the only writer of either.

### 5.2 The commit

```ts
interface Commit {
  nextStage: Stage;
  nextStep: Step;
  post?: string;            // the paragraph the player reads
  rollRequest?: RollSpec;   // present iff nextStage is "roll_offered"
  diffs: Diff[];            // empty when nextStage is "clarifying" or "rejected"
  timeSpent: TimeSpent;     // how long the action took, which lets the dungeon act
  draw?, learned?, coinGrant?, goalMet?   // rewards (§8)
}
```

- Both "iff" rules are zod refinements, and the applier enforces the second again:
  a rejection never changes anything.
- **The prose is a field of the commit**, so a game master that drafts and redrafts
  cannot publish both. A commit that needs a `post` and has none is handed back
  (`missingPost`).
- A refused commit gets **one** more ask, with the reasons in front of it. Beyond that
  the turn fails visibly and can be retried.
- Rules stated in the playbook and enforced in code: ids are quoted, never invented;
  `state` and `composed` travel together; relational keys are plain writes; every
  number traces to a roll.

### 5.3 What the game master reads

The messages are **rebuilt fresh on every call**, never appended to
(`src/gameplay/game-master/assemble.ts`).

| Call | Playbook files | Ends at |
|---|---|---|
| Triage | `SKILL.md` + steps 1, 2, `3-handle-by-type`, `3-information`, `3-standard` | rejected, clarifying, awaiting action, roll offered |
| Confirm | `SKILL.md` + `4-confirm-and-roll` | roll offered, rolling, … |
| Resolve | `SKILL.md` + `5-resolution` | awaiting action, dead, goal met |
| Room entry | `SKILL.md` + `room-entry` | awaiting action |

- Cached prefix: `dungeonContext`. Re-rendered every turn: the full character sheet and
  the full current room, with every contained entity's `state` and the room's geometry.
- Transcript: the exchange in progress, capped at `MAX_EXCHANGE` (12) messages, plus the
  previous `CARRIED_TURNS` (2) turns as structured records, not prose.
- **Entity `state` is the long-term memory.** The transcript only carries the
  conversation.
- **A retry is the same turn asked again.** The rejection is prepended to the original
  task, never substituted for it; `assemble.test.ts` asserts a retry prompt contains
  every line of the ask it retries.
- **Narration is never streamed.** It is shown only once the commit has applied; the
  stage is what fills the wait.

### 5.4 Room entry

**Gated in code, before any model call.** `needsComposition`
(`src/gameplay/view/room.ts`) lists everything in the room that has never been
composed or is stale. If the list is empty, there is no call: the room's `composed` is
shown again as it stands. Otherwise one call composes exactly those things, contents
first, then the room. Room entry never rolls, starts a fight or changes anything but
prose, and **hidden features stay hidden**: they surface only as clues.

A concealed way out is shown to the game master marked `NOT YET FOUND BY THE PLAYER`,
left out of the room's exit count, and not drawn on the map.

---

## 6. The applier

`src/gameplay/diffs/` is the one place game state changes. A diff is
`{ entityId, path, value }`: the model states **the destination value**, never a
procedure, and the applier works out which operation that describes and hands it to the
handler that owns that field's invariants. The allowlist in `paths.ts` is checked first,
so a write to `base` never reaches a handler.

| Type | Writable |
|---|---|
| Room | `state`, `composed` |
| Connector | `state`, `composed`, `conditional` (settable and deletable) |
| Creature | `state`, `composed`, `activity`, `count`, `stats.hp`, `roomId` |
| Feature | `state`, `composed`, `hidden`, `resolved` |
| Item | `state`, `composed`, `currentQuality`, `amount`, `parentId` |
| Hazard | `state`, `composed`, `sprung`, `active` |
| Mobile effect | `state`, `composed`, `roomIds` |
| Player character | `hp.current`, `conditions[]`, `inventory[]`, `equipped.<slot>` |
| *(any)* | `children[]`: append, which creates |

- **Atomic by construction.** The batch applies to a `structuredClone`, which is
  adopted only if every diff succeeds. A dry-run validation against the starting state
  could not handle a batch whose later diffs depend on its earlier ones, such as
  unequipping a shield before taking up a two-handed weapon.
- **Refs within a commit.** `children[]` takes an optional `ref` that later diffs in the
  same commit may use as an id.
- **Creatures cannot be created mid-run.** Items and features can.
- **After the batch:** `hp.current` is clamped above only (overkill is worth narrating;
  dead is `<= 0`); `currentQuality` is clamped to `[0, quality]` and an item at exactly
  0 is destroyed and unequipped; equipment is revalidated and anything no longer legal is
  put down; encumbrance is recomputed.
- **Every route into the player's hands goes through `takeIntoInventory`.** A pickup is
  forced: being overburdened is reported as an event, never a refusal, because the
  fiction has already happened.
- **A refusal names the way through**, because the retry (§5.2) is only useful if it
  does.

---

## 7. Rolls

The rules are Knave 1.0's (`src/rules/knave/`).

- **One threshold convention:** `success = total >= dc`, with `ORDINARY_DC = 16`. Saves
  take a DC; attacks and stunts take a defense and convert it with `dcFromDefense`,
  which holds the only `+1` in the codebase. A total exactly equal to a defense misses.
- **Attacks resolve on the attacker's side.** A natural 20 costs the defender's armour a
  point of quality and adds a damage die; a natural 1 costs the attacker's weapon a
  point. So an offered roll is always the player's own action, never a reaction. The
  roll reports the fact; the applier applies the wear.
- Advantage and disadvantage are 2d20 keep best or worst, on the d20 only.
- Morale is 2d6 against a rating, 7 by default. **0 HP is death**: Knave's
  unconscious-at-0 assumes a party to carry you out.
- Monster hit points are hit dice × 4. Hit dice 0 is a real band: +0, defense 10, and
  `HALF_HIT_DIE_HP` (2).
- **The player's roll is thrown in code** from the run's RNG when they press the
  button; that is the `rolling` stage. Every other roll goes through the game master's
  batched `roll` tool (`src/rules/knave/roll-tool.ts`), which takes a list, so three
  creatures' attacks cost one exchange, not three.

---

## 8. Rewards, keys and experience

**What a dungeon gives, what it asks, and what it pays for answering**, as one system.

### 8.1 Challenges

A **challenge** is one keyable property of one entity: a creature's weakness or
ability, an NPC's asset or liability, a blocked or concealed way, a hazard, an
obstacle, a region of the map, the goal's location and the goal's own properties.
`src/generation/content/challenges.ts` enumerates them; a size 5 dungeon has about 30.
Everything else reads from that list: keys answer challenges, accomplishments resolve
them, experience prices them.

### 8.2 Rewards

`src/generation/content/rewards.ts`. Two families:

- **Keys.** Any item placed to answer a challenge: a vial of acid, a censer, a chart.
  "Key" is the role, not the object. Priced low, so selling one never beats using it.
- **General rewards,** half equipment (priced from the Knave catalogue) and half
  treasure, which draws on **a conserved pot**: `size × 250–400` copper, partitioned
  across the treasure before any model sees it. Money is bounded; a whole size 5 dungeon
  holds about 1,500cp against a starting purse of 60–360. 10% of the pot is held back as
  the game master's coin allowance.

**Placement**, in order: reward-guaranteed rooms (dead ends, obstacle rooms, rooms with
hostile creatures) roll loot or key; the goal gets keys for its location and properties;
any dead end or obstacle room still empty gets a key; everything else goes to the
**reserve**. A placed key is never behind the thing it opens: generation removes the
blocked edge and places only in rooms still reachable from the entrance.

### 8.3 At runtime

`src/gameplay/mechanics/challenges.ts`.

- **The reserve is drawn mid-run.** It holds facts, not prose, so a key is written only
  when drawn, in whatever form fits the moment: something an NPC lets slip, an object in
  the cabinet being searched. `offerDraws` lists the nearest few each turn; `commit.draw`
  spends one, and the applier refuses an id that is spent, resolved or not in the
  reserve.
- **A learned fact is recorded on the thing it is true of,** in the dungeon's own words
  (`recordFact`), on every entity the challenge anchors to. It reaches the player
  through the next recomposition.
- **A region key charts rooms.** They are drawn hollow from `base`, display only:
  travel still refuses rooms the player has never entered.
- **Coin grants** (`commit.coinGrant`) roll their amount in code from the held-back
  allowance. When it runs out, the answer is no.

### 8.4 Experience

- **The ledger** is written by code from what each commit *did*: a creature slain, a
  `conditional` cleared, a concealment found, the goal met (`resolutionsFrom`), plus hit
  points lost to what was in the room. It never enters a prompt.
- **Bypass is inferred, not detected.** A creature met before some later
  accomplishment was got past somehow, and all ways past are worth the same.
- **The tally** is one call at the end of a run that rates each accomplishment `low`,
  `moderate` or `high` in words; `XP_FOR_RISK` prices them 50 / 100 / 200 in code.
  Deaths and abandoned runs do not tally.
- **Levelling** (`src/rules/knave/level-up.ts`) is cumulative, at `XP_PER_LEVEL` (1000)
  a level, one level per confirm. The dice are seeded on the character and the level, so
  reopening the screen shows the same roll.

### 8.5 The end of a run

Walking out alive (`goal_met` or `escaped`) keeps what was carried out (`lootOf`, a
diff against the turn-zero inventory) and banks the experience, both in the
transaction that ends the run (`carriedOut`, `src/server/db/characters.ts`). Death and
abandonment write nothing back to the character.

---

## 9. The map and geometry

### 9.1 What the map may show

- **An entity appears on the map only once its `composed` exists**, which is the same
  rule that governs prose. Never encountered draws nothing; concealed draws nothing; a
  thing that changed elsewhere stays where the player last saw it. The filter lives in
  `mapView` (`src/gameplay/view/map.ts`) and nowhere else.
- **The map may know more than the fiction, but never something different.**
- **Corridors are rooms**, drawn from each chunk's budget of six. So connected rooms
  share a wall, and a connector *is* the gap in it.
- The way out of the dungeon has no room on its far side; it draws as a dashed stub into
  blank paper.
- Fixed cell scale, so a wall weighs the same at six rooms as at thirty. North is up and
  the map never rotates.
- Only the current room's doors and things are clickable. A click sends the same text a
  typed action would, through the same turn.

### 9.2 Geometry

- **`CELL_FEET = 5`**, in one constant (`src/generation/floorplan/geometry.ts`).
- **Directions are absolute.** No one knows which way the player faces, so "left",
  "right", "ahead" and "behind" are forbidden, and a test asserts `describeGeometry`
  never emits one.
- **The content pass and the game master read the same sentence about a room**, from
  `describeGeometry`, so what was written and what is played agree.
- **The model picks a fixture's kind and position word; code rolls the count and picks
  the cells.** The menu and position words are put into the prompt from the same
  constants the validator reads. A stored position is always true of its cells.

### 9.3 Room sizes

`src/generation/floorplan/room-size.ts`. Size is read off the finished room, not
demanded of the layout: tiny 4–9 cells, small 10–25, medium 26–35, large 36+. The class
then constrains the room's identity roll, which is what bends. Corridors take the slack
of the layout and carry no shape.

---

## 10. Illustrations and sprites

Black-and-white line art in the manner of the old module illustration booklets, drawn
for the player and never shown to the model.

### 10.1 What binds them

- **An image shows only what the player could know.** Concealed features and connectors
  are filtered out of the prompt, the same filter the room view applies.
- **Images belong to the dungeon, not the run.** They are drawn from `base`, which never
  changes, so the first player to enter a room pays and every later player and copy gets
  it free.
- **No image ever blocks a turn.** Prose first, picture when it lands; a failure is a
  missing picture, never an error.
- **Code makes the style hold.** Every image is thresholded to 1-bit on the server
  (`src/server/illustrations/image.ts`) and drawn on the page as a mask in the text's own
  ink.
- **Style references are ours,** generated from words (`assets/*-refs/`), never anyone
  else's art.

### 10.2 Composition is settled in code

- **A camera search** (`src/illustrations/view.ts`) tries nine spots per floor cell at
  36 headings and scores what each sees: features 100, exits 20, the way in 5, floor 1.
  It frames 95% of features and 70% of other exits, in under 10 ms a view.
- **A guide image** (`src/illustrations/sketch.ts`) of walls, doorways and tagged
  footprints is sent with the prompt, so the image model draws the room the map has.
- **Buttons over the illustration** come from the same projection
  (`src/illustrations/hotspots.ts`), so a door's button sits on the doorway drawn there.
  Things out of shot keep a button at a corner or the frame's edge.
- **Creatures are sprites, one per kind**, cut out for free (threshold, close, flood
  the background from the border) and stood on a patch of floor every illustration keeps
  clear, at a height from the camera's own projection (`src/illustrations/figures.ts`).

### 10.3 Serving

`GET /api/runs/:id/illustrations/:roomId` and `/sprites/:spriteId`
(`src/server/illustrations/`).

- **The cache key is a hash of what the image is drawn from:** the requests, the guide,
  the style version, the model and the references. Not the final prompt, which contains
  words a model wrote differently each time. A copied dungeon builds the same key and
  finds the same image.
- The server refuses a room the run has not entered. A claim row (`pending` → `ready` or
  `failed`) means two runs entering one room pay once.
- Drawing starts on the server the moment a turn puts the player in a new room, so the
  picture is usually ready by the time the page asks.
- Images live in a public Supabase Storage bucket. The Supabase names still say `plates`
  (the table, `plate_words`, the bucket), from before the code said *illustration*.
- Room interiors and sprites are drawn by GPT Image 2 at low quality with style
  references; dungeon covers by FLUX.2 [klein]. About $0.015 an image.
- Without `FAL_KEY` and the Supabase service key, every room simply has no
  illustration.

---

## 11. The server

One Hono app (`src/server/app.ts`) deployed as a single Vercel function.

- **One model call per request.** A Vercel invocation may run 300 seconds and
  generation is N+2 calls, so building a dungeon is three routes: structure, then each
  region (fired in parallel by the client), then finish. A turn is one request.
- **The client never asserts a rule.** It sends what the player typed and the run
  version it last saw. The turn machine, the game master, the applier and the dice all
  run on the server, and the client's store is replaced with what comes back.
- **Accounts** are Supabase Auth: Google sign-in, or a one-click guest (an anonymous
  account) that can be linked to Google later and keeps its characters.
- **Ownership is a parameter, not a check.** Every query takes `owner_id`; row-level
  security is the floor under that, not the mechanism.
- **Allowances** (`src/server/allowance.ts`): guests get one run a day and members three,
  and 30 and 60 turns a day across all their runs. A turn is a `player` event in the
  journal, so only a committed action counts; only a new action (`/turn`) is refused,
  never the roll or room entry finishing one, and the run waits, saved, for midnight
  UTC. Generated dungeons are capped at size 1. An `unlimited` tier is set by hand.
- **Spend** (`src/server/spend.ts`): every paid call is a row in the `spend` ledger,
  its cost worked out in code from the prices in `src/llm/models.ts` (`src/llm/cost.ts`).
  Text calls are recorded by the meter the server hands `configureTransport`; images by
  the illustration and sprite workers. Two daily lines, in dollars on the UTC day:
  the **budget** stops new dungeons, new runs and new pictures, and the **ceiling**
  refuses every paid call. Both default to $5 (`DAILY_BUDGET_USD`, `DAILY_CEILING_USD`).
  `unlimited` accounts pass the budget but not the ceiling. Who a call belongs to is
  carried through the request in an `AsyncLocalStorage`, so nothing in the game is
  told.
- **Persistence** is Postgres: a dungeon is written twice (structure, then complete), a
  run on every commit, the character sheet whole in a jsonb column, and the journal of
  every generation and turn event, readable as JSONL or a transcript.
- **Shared worlds.** The library lists complete dungeons other players made; playing
  one takes a copy.
- **The Anthropic key lives only in the server's environment.** `src/llm/client.ts` has
  no default URL, so nothing calls the model until a process holding a key configures
  it.

---

## 12. Code rules and testing

- **The folders are layers** (`src/README.md`): each imports only from those below it,
  type imports included, and no import cycle that loads code is allowed.
  `src/architecture.test.ts` checks every import.
- **Only `src/ui/` imports React.** Outside the shells (`ui/`, `server/`, `dev/`,
  `api-client/`) nothing touches an environment global, so the whole game runs under
  vitest with no browser and no server.
- **Model names live only in `src/llm/models.ts`.** The architecture test greps for
  them elsewhere.
- **Every prompt is markdown in `src/prompts/`**, imported raw by `loader.ts` and
  nowhere else. Plain Node does not understand `?raw`, so the dev CLIs register
  `dev/lib/raw-md.ts` before importing anything that reaches a prompt.
- **A type-only import is written `import type`.** Under `verbatimModuleSyntax`,
  `import { type A }` still loads the module; one such import once pulled the whole
  generation pipeline into the browser bundle.
- **No module holds one of anything a run owns.** The store, the journal and the turn
  machine are created per run and passed down, because a server process serves many runs
  at once.
- **Two vitest projects, split on the extension:** `.test.ts` runs headless,
  `.test.tsx` runs in jsdom. `npm run test:db` is a third, opt-in config for tests
  that need a real database.
- **Snapshots redact UUIDs**, because ids are unseeded and appear in prompts.
- **A guard clause that skips is a test that lies.** A fixture lookup that returns early
  when it finds nothing asserts nothing and passes.
- **No retrofitting.** There is no installed base to migrate: a fix that applies from
  the next generated dungeon onward is a finished fix.
