# Dungeon Crawler — Build Plan

A single-player, LLM-refereed dungeon crawl built on Knave 1.0 and Maze Rats tables.
The generation engine is framework-free TypeScript; the app around it is Vite + React,
served by Vercel functions against Postgres, and it is deployed and playable.

**This document is forward-looking.** It carries two things: the **contracts** that bind
code not yet written, and the **features** that are not built. Nothing that is built is
described here except where a decision made while building it still binds something else.

**The history is in git, not deleted.** `5feed17` is the last revision carrying the full
Part 0 findings (B1–B3, D1–D6, G1–G5, S1–S7) and the original phase-by-phase specs;
`cce5c15` and its ancestors carry the session outcomes for everything built since — the
old `docs/CODING-PLAN.md` is in that history, with the reasoning behind every phase that
landed. Read them there when you need to know *why* and §2 below does not say.

**There are no phases.** Work is named features, in no particular order, and any of them
can be picked up on its own. Where one genuinely blocks another, the feature says so.

---

## 1. Where things stand

Built, live and deployed at **https://aidungeon.vercel.app**: generation end to end
(dungeon pass, content pass, seams pass, block plan), the turn loop against the real
model, character creation and the shop, the map, accounts and ownership, run continuity
(resume, abandon, the one-run-at-a-time lock), shared worlds and the library, the single
equipment table, time categories and creature agency, and the first of three rewards
sessions.

**913 tests and build clean**, plus a third, explicitly-invoked vitest config
(`npm run test:db`) holding **58** more that need a real database.

Two playtests are the evidence base for most of what is left. Where a feature cites a
`seq`, that is a line in the named run's `journal.jsonl`; a line number is the rendered
`transcript.md` beside it.

| Run | What it was |
|---|---|
| **R1** `out/runs/2026-08-10T00-32-05-seed15341/` | seed 15341, size 1, level 1 — The Drowned Aviary. **Complete: start to finish, goal met.** Eleven rooms, features searched, a spell cast, the objective stolen, and out. |
| **R2** `out/runs/2026-08-12T01-32-27-seed218356/` | seed 218356, size 2, level 1 — The Relish Quarry. **Eight turns, three rooms, abandoned mid-run.** Almost entirely conversation: the first evidence of how creatures behave when the player talks to them rather than fights them. |

---

## 2. Standing contracts

The rules that bind code not yet written. Stated flatly, without the reasoning that
produced them — that is in git and in the comments at each site.

### 2.1 Seeds and determinism

```ts
// src/runtime/seeds.ts
interface RunSeeds {
  dungeonSeed: number;    // the user-facing number
  graphSeed: string;      // `${dungeonSeed}`; graph retries derive `<graphSeed>~<n>`
  blueprintSeed: number;
  stockSeed: number;      // dungeonSeed + 7919
  layoutSeed: number;     // the block plan
  runSeed: number;        // separate stream for play-time rolls
}
```

- **Entity ids are deliberately unseeded** (`crypto.randomUUID`). Ids are identity, not
  content. Two consequences, both facts rather than choices: a determinism hash must be
  taken over an **id-stripped canonical form**, and **replay replays the run, not the
  generation** — load the persisted `GeneratedDungeon`, reset `runSeed`/`rngDraws`, feed
  `playerInputs` back through `turn.ts`.
- Two RNG streams: `genRng` (generation) and `runRng` (play). `CountingRng` wraps `Rng`
  and counts draws; `{ runSeed, rngDraws }` is persisted and fast-forwarded on rehydrate.
- **Size ↔ chunks is identity.** Size *n* is *n* chunks is *6n* rooms.
- **The model never generates a number.** Every number in narration or in a diff traces
  to a seeded roll or to the `roll` tool.

### 2.2 The generation pipeline

```
  A: generateBlueprintSeed -> buildDungeonPassPayload -> LLM -> applyDungeonPass  ┐
  B: generateBlueprint -> stockDungeon(+layout hook) -> runEntitiesPass           ┘ concurrent
  join, then per chunk:
     buildContentPassPayload -> LLM -> zod        [parallel, all chunks at once]
     applyContentPass                             [SERIAL, ascending chunk order]
  then buildSeamsPassPayload -> LLM -> applySeamsPass                             [1 call]
```

- **`applyContentPass` runs serially in ascending chunk order** even when generation is
  parallel. CLAUDE.md rule, and independently necessary: apply mutates `ep.items`,
  `ep.features`, `ep.bindings`, `ep.registry.creatures` and rebuilds `ep.creatures`.
- **A connector is written by whoever can see both its rooms.** Inside a chunk the lower
  graph index owns it. A connector *leaving* a chunk is a **seam** and is written by the
  seams pass at the end, with both rooms in front of it. **This rule is what
  [Connectors written with their room](#connectors-written-with-their-room) rewrites**,
  and the tests asserting it move with it.
- On zod failure, retry that chunk **once** with the validation errors appended. On a
  second failure, throw. No partial content.
- **An answer that is well-formed and incomplete is a failure too.** A chunk response
  that simply omits a ref is valid JSON against a valid schema, and three of ~90 written
  things once came back unwritten that way. So every ref the payload asked about must
  come back, checked by `contentPassOmissions` / `seamsPassOmissions` through
  `callForJson`'s `check` — which runs after zod and raises `ResponseFormatError`, so an
  omission takes the retry that already existed and throws the same way. Only the payload
  knows what was asked for, which is why the check is engine-side and pure.
  **Deliberately not checked**: fixtures, promoted details, and the seam connectors
  carried as context — the model chose those, so there is nothing it can have left out.
- **The block plan runs inside stocking**, between corridor designation and identity:
  `stockDungeon` takes a `layout` hook and `generate.ts` supplies it. Anything that
  generates without the hook leaves `RoomStock.sizeClass` unset, which silently disables
  `sizeAllows` — the condition that stops a four-cell closet rolling "Banquet hall".
  **`generateOffline` and `--dry` both run the hook**, and must keep doing so.
- **`state` and `composed` are not written during generation.** They stay `undefined`
  until the player encounters the entity.

### 2.3 `dungeonContext` and group bases

- `dungeonContext` is constructed in `applyDungeonPass` from `bp.inhabitants` **alone**,
  and is immutable thereafter. Nothing appends to it, no later pass regenerates it.
  Stored as a `readonly string` on `GeneratedDungeon`.
- **Wanderers must never leak into it.** They land in `registry.groups` chunk by chunk,
  so anything that re-derived the context *from* the registry would start describing
  corridor filler as the dungeon's population. The test is: no id or name from
  `sd.wandererGroups` appears in `dungeonContext`, and every `bp.inhabitants` name does.
- Inhabitant group bases are authored by the **Dungeon Pass**, wanderer bases by the
  **content pass**; both are stored on `TemplateRegistry.groups` with a write-once
  guard. `resolveBase(e, reg)`: inline `e.base` wins, else
  `reg.groups[bid]?.base ?? reg.creatures[bid]?.base` for a creature,
  `reg.hazards[bid]?.base` for a hazard.
- `validateWritten(gd)` must find a non-empty resolvable base on every room, connector,
  creature, feature, item and hazard. It is the assertion that catches the whole class
  of "base went missing" bugs.

### 2.4 Entity prose lifetimes

- **`base`** — immutable identity, written once at generation. Never writable at
  runtime, by any path.
- **`state`** — what is true now. `undefined` means *the player has not encountered this*.
- **`composed`** — rendered from base + state, and the only one the player has read.
  When it and `state` disagree about something the player is acting on, **`composed`
  wins** and `state` is what gets corrected.
- `setState(e, s)` sets `e.state` and `e.needUpdate = true`. It does **not** clear
  `composed`. `composed === undefined` means *never encountered* and is the fog-of-war
  signal; `needUpdate === true` means *stale, recompose when next seen*.
- **`name` is not runtime-writable.** Names are identity. If a thing has changed enough
  to need a new one it should be a new entity. **[First impressions](#first-impressions)
  proposes the one exception**, and it is not built.
- **`place` (`{ cells, position, fixture? }`) is not runtime-writable.** A brazier
  knocked over changes its `state`, not its footprint.

### 2.5 Stage, Step, and the commit envelope

```ts
type Stage = "room_entry" | "awaiting_action" | "clarifying" | "rejected"
           | "roll_offered" | "rolling" | "resolving" | "dead" | "goal_met";
type Step  = "1-target" | "2-classify" | "3-information" | "3-standard"
           | "4-confirm-roll" | "5-resolution" | "room-entry";

interface Commit {
  nextStage: Stage;         // drives the UI
  nextStep: Step;           // drives prompt assembly
  post?: string;            // the paragraph the player reads
  rollRequest?: RollSpec;   // present iff nextStage === "roll_offered"
  diffs: Diff[];            // MUST be empty when nextStage is "clarifying" | "rejected"
}
```

`stage` and `step` are separate fields and `turn.ts` is the only thing that writes
either. Both "iff" clauses are **zod refinements**, not shape checks. The diffs-empty
rule is independently enforced by the applier — rejections never mutate.

**The prose is a field of the commit, not loose text.** There is one commit per turn, a
field cannot be written twice, and the last accepted call is the only one that counts —
so a referee that writes a draft, thinks better of it and writes another cannot publish
both. Loose text is working-out by definition. `post` is optional, because a room entry
(where the room's own `composed` IS the paragraph) and a commit that moves the player
legitimately write none; anything else committing without one is handed back inside the
same conversation (`missingPost` in `referee.ts`).

Rules stated to the referee in `SKILL.md` and enforced in code:

1. **Ids are quoted, never invented** — *and an id names that exact object and nothing
   else*. A thing just discovered is a new entity via `children[]`, even when something
   of the same kind exists elsewhere.
2. **Atomicity and retry.** The batch validates whole and applies whole; one bad diff
   rejects all of them. On rejection the model gets the reasons and retries once.
   **The retry is only productive if the reasons name the way through.**
3. **`state` and `composed` travel together.** Writing one without the other leaves a
   stale cache. `composed` is never read to make a decision.
4. **Relational keys are plain writes.** `creature.roomId`, `item.parentId`,
   `effect.roomIds` — write the field and nothing else. Occupancy is derived; the model
   must not maintain any room-side list.
5. **Every number traces to a roll.**

### 2.6 The diff applier

One uniform diff, `{ entityId, path, value }`. The model states **the destination
value**, never a procedure; `applyDiff` reads path and value to work out which
operation is being described and dispatches to a handler that owns that field's
invariants. `paths.ts` (the allowlist) is consulted **first**, so a `base` write never
reaches a handler.

**Writable paths**

| Type | Writable |
|---|---|
| `Room` | `state`, `composed` |
| `RoomConnector` | `state`, `composed`, `conditional` (settable **and** deletable) |
| `Creature` | `state`, `composed`, `activity`, `count`, `stats.hp`, `roomId` |
| `RoomFeature` | `state`, `composed`, `hidden`, `resolved` |
| `Item` | `state`, `composed`, `currentQuality`, `amount`, `parentId` |
| `Hazard` | `state`, `composed`, `sprung`, `active` |
| `MobileEffect` | `state`, `composed`, `roomIds` |
| `PlayerCharacter` | `hp.current`, `conditions[]`, `inventory[]` / `inventory[i]`, `equipped.<slot>` |
| *(any)* | `children[]` — append, i.e. create |

Never writable on any type: `id`, `type`, `base`, `name`, `keywords`, `blueprintId`,
`narrative.*`, `stats.hitDice`, `stats.modifiers`, `slots`, `quality`, `place`,
`endpointA`, `endpointB`, and on the PC `abilities`, `traits`, `level`, `hp.max`.

**Behaviour that binds**

- **Atomic by construction**, not by dry-run validation: apply to a `structuredClone`
  and adopt the clone only if every diff succeeded. Pre-validating against the starting
  state cannot handle a batch whose later diffs depend on its earlier ones — unequip the
  shield, then take up the two-hander.
- **Intra-commit references are `ref`-based.** `children[]` accepts an optional `ref`
  and later diffs *in the same commit* may use it as an `entityId`. Refs do not survive
  the commit that created them.
- **Creature creation via `children[]` is refused**, with a message saying so. Items and
  features create fine.
- Invariants after the batch: clamp `hp.current` **above only** (no floor at 0 —
  overkill is worth narrating, and `dead` is `<= 0`); clamp `currentQuality` to
  `[0, quality]` and **destroy at exactly 0**, clearing any equip slot pointing at it;
  run `validateEquipment` and surface anything unequipped; recompute `isOverburdened`.
- Handlers delegate to the engine function that owns the rule — `equip` / `unequip` /
  `addItem` / `removeItem` from `dungeon-character.ts`, `setState` from
  `dungeon-entities.ts`.
- **Every route into the player's hands goes through `takeIntoInventory`** —
  `item.parentId = <player>`, `inventory[…] = <id or spec>`, and `children[]` on the
  player. Three spellings of one operation, and they drifted while they were three
  functions. A pickup is **forced**: overburdening is reported as an event, never a
  refusal, because the fiction has already committed to it.
- **`inventory[…]` reads its value.** Null drops the item at that index; anything else is
  a pickup and **appends**, the stated index being advisory — the list is compacted and
  has no positions to hold open.
- **`isHidden` is refused on anything the player was carrying *when the turn began*** —
  `Ctx.carriedAtStart`, snapshotted off the world before the first diff runs, not read
  off the draft. It is the one mechanical tell that the referee has reused a sheet id for
  something it has just invented in the room. Asked of the draft instead, it refuses a
  pickup that also reveals, which is a legal pair and must go through; the refusal says
  so, because a refusal that does not name the way through sends the retry off.

### 2.7 Rolls

- **One threshold convention: `success = total >= dc`, `ORDINARY_DC = 16`.**
  `saveRoll` takes a **DC**; `attackRoll` and `stuntRoll` take a **defense** and apply
  `dcFromDefense` internally. **`dcFromDefense` holds the only `+1` in the codebase.**
  A total exactly equal to a target's defense **misses**.
- **Attacks always resolve attacker-side, under the hood.** Only two crit branches are
  reachable: attacker nat 20 costs the defender's armor a point of `currentQuality` and
  adds an extra damage die; attacker nat 1 costs the attacker's weapon a point. At 0
  quality the item is destroyed. **`roll_offered` is therefore always the player's own
  action, never a reaction.**
- The roll module reports the *fact*; the **applier** performs the quality decrement.
- `attackRoll` returns damage, including the crit die, not just hit/miss.
- Advantage/disadvantage is 2d20 keep better/worse, **on the d20 only**, never on damage.
- A stunt hit produces the stunt and **no damage**, unless advantage was spent as
  "stunt-and-damage", in which case both land and the roll is made at `edge: "none"`.
- Morale is 2d6, `holds = total <= morale`, default rating 7.
- **0 HP is death.** Knave's unconscious-at-0 rule assumes a party to drag you out.
- No initiative, no reaction table — both are in the book, neither has a caller.
- Unarmored is defense 11 / bonus +1 for the **player**, and that is a Knave
  constant with no hit dice behind it — `UNARMORED_DEFENSE` states it rather than
  deriving it through a stand-in creature, which is what it used to do.
- Monster HP is HD × 4. **HD 0 is a real band, not a floor**: every bonus +0,
  every defense 10, and half a hit die — `HALF_HIT_DIE_HP = 2`, what `1d4` and
  `1d8/2` both average to. Bonuses and ability defenses fall out of the ordinary
  formulas; `maxHp` and `armorDefense` are the two that special-case it, because
  multiplying gives a creature with no hit points and the unarmoured default
  gives it 11. A stored `armorDefense` still wins, so a level 0 thing in a
  breastplate is armoured normally.

**The player's roll is client-side**, thrown from the run RNG the moment the player
takes it — that is what the `rolling` stage is. Everything else goes through the
batched `roll` tool, which takes a **list** with caller-chosen ids and returns every
result in one go, so a three-creature resolution costs one extra exchange rather than
three.

### 2.8 Context policy

Rebuild the messages array **fresh each call**. Never append-and-grow.

| Call | Files loaded | Ends at |
|---|---|---|
| **A — triage** | `SKILL.md` + steps 1, 2, `3-handle-by-type`, `3-information`, `3-standard` | `rejected`, `clarifying`, `awaiting_action`, `roll_offered`, or through to C |
| **B — confirm** | `SKILL.md` + `steps/4-confirm-and-roll.md` | `roll_offered`, `clarifying`, `awaiting_action`, or `rolling` → C |
| **C — resolve** | `SKILL.md` + `steps/5-resolution.md` | `awaiting_action`, `dead`, `goal_met` |
| **D — room entry** | `SKILL.md` + `steps/room-entry.md`; **skipped entirely when the staleness sweep is empty** | `awaiting_action` |

- Static prefix, cached: `dungeonContext`.
- Ground truth, re-rendered each turn: full PC sheet, full current room — `composed`
  plus every contained entity's current `state`, plus the geometry (§2.11).
- Transcript: the in-progress exchange, **hard-capped at 12 messages**, plus the
  resolution records of the previous **2** completed turns, as structured
  `{ action, target, roll, outcome, diffsApplied }` rather than prose.
- **Entity `state` is the long-term memory. The transcript only carries conversational
  continuity.**
- **A retry is the same turn asked again**, so the rejection block is *prepended to* the
  original task, never substituted for it. `task()` is a preamble and a body, and the
  body is unconditional; a retry prompt is a **superset** of the ask it retries, asserted
  line by line in `assemble.test.ts`. A retry that substituted was how a refused commit
  threw the player's roll away.
- **The player's roll reaches the referee through two channels**, `renderRoll` in the
  instruction (authoritative) and a `role: "roll"` entry in the transcript (a record that
  survives however the instruction is built). One channel was not enough.

**No streaming to the screen.** Narration is buffered and shown only after the commit
validates and applies, so prose the player has read is always true of the game state.
Streaming stays on internally to avoid HTTP timeouts; the deltas accumulate into a
buffer. `thinking` / `resolving` is what fills the wait.

### 2.9 Occupancy and room entry

**There is no occupant list.** Occupancy is derived by scanning for entities whose link
field matches the room, so a `roomId` write is a plain field write and cannot
desynchronise anything.

| Entity | Link field |
|---|---|
| `ICreature`, `IRoomFeature` | `roomId` |
| `IItem` | `parentId` — a room, a creature, **or** a feature, so items nest |
| `IMobileEffect` | `roomIds` (an array) |
| `IRoomConnector` | `endpointA` / `endpointB`, never written at runtime |

`directContents` for the applier, `roomIndex` (transitive) for the room block,
`placedThings` for the map. Rebuilt after each applied commit — O(n) over a few hundred
entities. The PC is the one genuine two-sided relation: `PlayerCharacter.inventory` is
a real array *and* each item carries `parentId`.

**Room entry is gated in code, before any model call.** `needsComposition(run, roomId?)`
returns everything in the room that is `composed === undefined` or `needUpdate === true`,
plus the room itself under the same test. Empty → **no model call**: `enterRoom()`
re-shows `room.composed` verbatim and goes to `awaiting_action`. Non-empty → one call,
handed only those entities. The step file never reasons about whether this is a first
visit. The free path writes the same journal, scrollback and transcript entries as the
paid one, so nothing downstream can tell them apart.

Entry composes bottom-up, contents then room. It never rolls, starts combat, springs a
hazard, or changes anything but prose. **Hidden features stay hidden** — they surface
only as clues, and a directed look is what turns a clue into the thing itself.

**A concealed way out is shown to the referee three times and must read the same way in
all three.** It is in the ways-out list under `includeHidden` — marked `NOT YET FOUND BY
THE PLAYER`, the same words a concealed thing standing in the room carries — it is left
out of the geometry sentence's count entirely, and it is not drawn on the map. The
referee has to know it is there to be found, and must not be able to mention it without
noticing that it is doing so.

### 2.10 The map, and what it may show

- The map component consumes a `Layout`, never `dungeon.rooms[].pos` directly.
  `pointLayout` and `floorplanLayout` both implement it and both render through the one
  component. **`GeneratedDungeon.blockplan` is nullable** and the map is an enhancement
  over `pointLayout`, never a dependency.
- **Corridors are rooms**, drawn from the six-per-chunk budget. Not a new entity type,
  not a promoted connector. So a connected pair already shares a wall and a connector
  *is* the break in it: `Layout` carries a door `{ at, wall, through }`, and the
  `polyline` case is unused.
- The way out is not a graph edge (`endpointB: null`). `BlockPlan.surface` places it on
  a wall of the entrance room facing open rock; it draws as a dashed stub reaching into
  blank paper, the only door with nothing on its far side.
- **Fixed cell scale, not normalised.** A wall should be the same weight at six rooms
  and at thirty.
- **THE RULE: an entity appears on the map only when its `composed` changes.** Same
  precedence `dungeon-entities.ts` sets for prose — what the player was told binds.
  It falls out for free: never encountered draws nothing; concealed draws nothing,
  because room entry never composes a hidden thing; something that changed two rooms
  away goes on saying where it was last seen, because `setState` leaves `composed`
  alone; something revealed by a search arrives **with** the prose, because
  `setIsHidden(false)` opens a description debt the next composition pays.
  **The filter lives in `mapView` and nowhere else.** `Layout.fixtures` deliberately
  carries every placed entity, concealed ones included, because `layout.ts` knows only
  geometry.
- **Only the current room's doors are clickable**, through a confirmation, then
  dispatched as ordinary text through the normal turn path so it is identical to typing
  it. A blocked door stays clickable, so the referee gets to be the one that says no.
- **The map may know more than the fiction but never differently.** Nothing is drawn
  that the referee has not been told about.

### 2.11 Geometry and fixtures

- **`CELL_FEET = 5`**, in one constant. The moment two places convert cells to feet
  they disagree.
- **The compass is map-absolute and the prompt says so.** North is up, the drawing never
  rotates, nothing knows which way the player is facing. "Left", "right", "ahead" and
  "behind" are forbidden outright, and a test asserts `describeGeometry` never emits
  one. A relative direction is a lie the moment the player walks back through.
- **The referee and the content pass read the same sentence, from the same function.**
  `describeGeometry` → the content pass's `ContentRoomBrief.geometry` and the runtime's
  `RoomView.geometry`. One derivation behind both; that is the whole of the feedback loop.
- `describeGeometry` takes `{ omit }` and `roomView` hands it every concealed connector
  touching the room, so the count is what a person standing there can see; the way out of
  the dungeon has a null id and is never omittable. The memo in `selectors.ts` holds the
  `RoomGeometry` rather than the rendered line, because concealment is run state — a
  secret door found on turn nine has to start being counted. **The content pass passes
  nothing and sees them all**, deliberately: it is the pass that writes what the concealed
  way physically is.
- Outline thresholds are **0.85 / 0.60** on box-fill, measured over 1,520 chambers
  (median fill 0.67 — the block plan grows rooms out of a skeleton, so a clean rectangle
  is the rare case). **Re-measure before changing either number.**
- **The model picks a fixture kind and a position; code rolls the count and picks the
  cells.** "Pillars" is a decision about the room; "six pillars" would be a number the
  model invented. Caps rather than quotas: tiny 1, small 2, medium/large 3, passage 1.
- **A stored `position` is always true of the cells beside it.** A wall-hugging kind
  asked for the middle of the room is moved to the longest wall and the stored word moves
  with it; a word whose cells were unavailable becomes `throughout` rather than keeping a
  wall the marker is not against.
- **`throughout` resolves to the room's interior** — cells with floor on all four sides —
  falling through to the whole floor where there is no interior. `spread()` is
  farthest-point sampling, which is what makes a colonnade read as a row. Measured over
  72 rooms: the `centre` pool is empty in 16.7% and there is no interior at all in 22.2%.
- The menu and the position words are **interpolated into the prompt from the same
  constants the validator reads**, so they cannot drift. Printed **once**, in the
  instructions, with a `*` on the kinds a passage can hold.
- An unrecognised `kind` drops the fixture; an unrecognised `position` falls back to the
  centre. Neither is ever fatal — a rejected batch is six unwritten rooms and a retry,
  where a bad position word is a pillar in the wrong place.
- `positionPhrase` is the one place the wire form becomes prose. The map hover and the
  room block both go through it, so they match word for word rather than merely agreeing.
- `ContentPassPayload.ground` carries cells from build to apply. **The renderer does not
  touch it and must not** — coordinates stay on this side of the boundary.

### 2.12 Layout and sizing vocabulary

- **Size is read off the room**, not demanded of the packer. `roomSizes()` reads the
  class off the finished floor area and the archetype pin becomes a condition on the
  *identity roll* — `sizeAllows(identity, class)`. Always satisfiable, because the roll
  is what bends.
- Four bands, tight, against spacing of 5–9 cells: **tiny 4–9, small 10–25, medium
  26–35, large 36+**. They describe what the block plan actually draws. `vast` is gone.
- The vocabulary lives in **`src/engine/dungeon-room-size.ts`** — bands, `classOf`, the
  archetype table, `sizeAllows`. Tables and predicates only, no geometry.
- Corridor designation happens in stocking, after entrance and goal roles are fixed and
  before the headline quota. Count is **N−1 / N / N+1 at 25 / 50 / 25**; size 1 is a coin
  flip between 0 and 1. Selection: **degree ≥ 2**, never the goal room, never adjacent to
  another corridor, distributed across depth bands. A corridor rolls `identity` on the
  **Dungeon Corridors** table (20 entries, deliberately not 36) and `detail` on the
  shared Dungeon Room Detail table.
- **Corridors get no shape mapping.** They are the only part of the layout allowed to
  stretch and they carry all of its slack; pinning their width would make the packer
  rigid exactly where it needs to give. A corridor's identity informs the **prose only**.
- **The plane is flat and nothing overlaps.** Stairs, shafts, ramps and bridges are
  flavour that matters only inside the room where the change occurs. Nothing gets a z.
- **`validate()` requires a planar embedding**, so sizes 4–5 reject-and-retry inside
  `generateValid` (~1.2 attempts at size 5). Sizes 1–3 are unaffected.
- **Adjacency holds by construction** in the block plan: both rooms are required to
  contain their side of an agreed contact before either is drawn.

### 2.13 Project rules

Restated from CLAUDE.md, plus the mechanisms that enforce them.

- `src/engine/` never imports React and must stay runnable under vitest. A purity test
  greps for `react`, `import.meta.env` and `document`.
- Model strings live only in `src/runtime/llm/models.ts`, keyed by task. A test greps
  for `claude-` outside it.
- The API key lives in `.env.local`, is loaded with `loadEnv(mode, cwd, "")` — **empty
  prefix**, so it is readable by the config and never `VITE_`-inlined — and is injected
  by the dev proxy. The CLI path is Node and reads the key directly; that is not the
  rule being soft, it is there being no browser to keep it out of.
- Skill markdown loads via `?raw`. A test asserts every `steps/…` path named in
  `SKILL.md` resolves to a real file. **`?raw` is a bundler feature** — Vite and vitest
  understand it, plain `node` does not, so anything reaching the referee outside a
  bundler registers the hook in `dev/raw-md.ts` first.
- **No module holds one of anything a run owns.** The store, the journal and the turn
  machine are made per run and carried, never imported: `createGameStore`,
  `createJournal`, `createGameSession`. A singleton is correct for exactly one situation
  — a browser tab, with one run in it — and wrong in every process that serves two.
- `src/store/react.ts` is the only module below `src/ui` and `App.tsx` that imports
  React. `store/game.ts` imports `zustand/vanilla`, not `zustand`, because the package's
  own entry point re-exports `zustand/react`.
- **Two vitest projects, split on the file extension.** `.test.ts` is headless,
  `.test.tsx` is jsdom. The extension is the whole of the rule.
  `src/ui/__fixtures__/jsdom-setup.ts` supplies entry points jsdom lacks
  (`setPointerCapture` and friends) and **never fakes behaviour**.
- Persistence is two IndexedDB keys behind a `KeyValueStore` interface with a memory
  implementation for tests and Node: `dungeon:<id>` written once, `run:<id>` per commit.
  The server keeps the same records in Postgres, the sheet whole in a jsonb column.
- Node runs the CLI with native type-stripping, so **constructor parameter properties
  are unsupported** and all relative imports in `src/` carry `.ts`.
- **Ownership is a parameter, not a check.** Every query takes `owner_id`; RLS is the
  floor under it, not the mechanism.

**Two testing habits worth keeping**, both learned from tests that lied:

- **A guard clause that skips is a test that lies.** A fixture lookup that returns early
  when it finds nothing asserts nothing and passes.
- **Snapshots must redact UUIDs**, because ids are unseeded and appear in prompts. Run
  the suite twice when adding one.

---

## 3. Features

Not built. No order. Each one names what it is, what binds it, and what has to be
decided or measured before it can be written. Where a feature blocks another it says so;
otherwise assume none of them do.

---

### Prose discipline

**The referee writes from the prose it was handed rather than from the geometry the
floorplan actually has.** The room block has walls, positions and exits with sides; the
step files have not caught up with it. Mostly a prompt change, and it is one feature
because every item shares that cause.

**Space and direction**

- **Absolute directions only.** R1: *"to your left"* — the player has no facing, the map
  has no facing, and left is undefined. North/south/east/west, and the room block already
  provides them.
- **Positions must match the plan.** *"The ramp at the north wall's western end"* when
  the connector is at the **eastern** end. The side and the end are both in the room
  block; the step file needs to say that they bind, in the same voice §2.8 uses for
  `composed`.
- **Shape claims must match the shape.** A room drawn as a pyramid or half-round
  described as *"running east to west"*. `describeGeometry` exists and is rendered; the
  instruction to prefer it over invention does not.
- **Elevation should not contradict itself.** *"The ramp slopes gently upward into deeper
  darkness."* Up is not deeper. Worth one line, since the flat-plane rule means ramps and
  stairs are flavour with nothing constraining their use.
- **Mention the way in last, and outside the count.** The remaining half of the
  exit-count fix — the other three sources have been reconciled (§2.9, §2.11), and this
  is the step-file line that was ordered last on purpose. It now has a room block it can
  be written against.

**Reuse and register**

- **Room descriptions are being reproduced verbatim.** The `composed` field binds the
  referee and it is being satisfied by quotation. Two candidate fixes, to be tried in
  this order: (1) instruct explicitly that `composed` is what the player has *already
  read* and must be built on rather than repeated; (2) if that does not hold, render the
  room block's prose fields in a deliberately **non-prose form** — fragments, keyword
  lists — so there is nothing grammatical to copy. The second is heavier and is the one
  that cannot be ignored. **Open: which is needed.**
- **The verbal tics.** *"Running my fingers over"* everything inspected, *"moving along"*
  everything traversed. A short list of banned constructions in the information handler is
  the cheap fix; the better one is to say what an inspection paragraph is *for* so it
  stops reaching for a stock gesture to open with.
- **Room names and their descriptions must agree.** A room called "The Laboratory" whose
  description was not of a laboratory. **Diagnose before fixing** — the name comes from
  the rolled `identity` and the description from the content pass, so either the
  content-pass prompt is not treating the name as binding, or the naming instruction is
  loose enough that the name was the odd one out. Read the R1 content-pass prompt and
  response for that room before changing anything.

---

### Room plans

**Room proportions read as nonsense and a sentence may not be enough.** R2: *"a narrow
chamber running the length of a ship"*, *"East and west walls run the length, north and
south are mere suggestions"*, *"broken geometry"*. The question is whether to hand the
model **the drawing** instead of a sentence about it.

**The proposal: an ASCII plan of the room's cells** — not an image, not the SVG. One
character per cell, doors marked, north up. A 10×8 room is 88 characters, it is
deterministic, it diffs in a snapshot test, it costs no vision tokens, and it is the same
artefact for the content pass and the referee, which is the §2.11 feedback-loop rule. An
image would have to be rasterised somewhere, cannot be asserted on, and buys nothing a
grid does not.

Keep `describeGeometry`'s sentence beside it — the words are what the prose should reuse;
the grid is what settles arguments about shape. Feed it through
`ContentRoomBrief.geometry` and `RoomView.geometry` together, so both readers keep seeing
the same thing.

**Measure before adopting.** Render a dozen rooms both ways and compare what comes back:
a grid the model narrates cell by cell would be a worse failure than a vague sentence.

---

### Spellcasting

**There is no guidance at all.** The rule, to be written into `3-standard.md`: a spell is
**auto-success** unless it targets another creature or attempts something difficult or
flashy, in which case it rolls as normal. It is **exhausted after use** — with an explicit
allowance for follow-up actions that are part of the same effect, so lifting a thing and
then setting it down is not two castings. R1's lockbox theft is the worked example; under
this rule it is a clean success with no roll at all.

**`spellBook.exhausted` is not writable** — a pre-existing gap in `paths.ts`, the obvious
neighbour of `book.exhausted`, and this is the feature that needs it.

---

### One obstacle, one roll

R1: *"Getting through the iron grate was too hard. It didn't need to have 3 locks. Most
obstacles should be beatable with a single roll."*

A connector's `conditional` is **one string** describing one obstacle — the grate's was
*"locked from this side, the chains wrapped through the bars, the mechanism seized with
rust and brine"*. The referee read that clause list as three **separate obstacles** and
charged a roll for each. Nothing told it otherwise, and its reading is not unreasonable:
the prose does describe three things.

Two halves, both needed:

1. **The rule, in `3-standard.md`:** a `conditional` is a single obstacle. One successful
   roll clears it and the diff that follows is `conditional = null`. A referee that wants
   to charge a second roll needs a reason from the fiction that arose **after** the first
   — a new fact the player uncovered — not a second noun in the same sentence.
2. **The prose, in the content pass:** stop writing `conditional` as a pile of clauses.
   One obstacle, said once. Multi-stage obstacles are worth having, but they should be
   something the generator *chose*, on a room that deserves one, not an accident of a
   comma-heavy sentence. If they are wanted they need a field — a count or a flag — not a
   longer string.

---

### Crowds, mooks, and the attack cap

Twelve creatures plus a leader against a level 1 character (R1). Three separable
questions:

1. **Whether `dungeon-rooms-loop.ts` should produce groups that large at level 1** — a
   stocking parameter. **Measure first**: run the generator across a seed spread and get
   the actual distribution of group size against level.
2. **Whether an HD 0 creature resolves as a mook** — dying to any hit, attacking as a
   group rather than individually. A rules addition to `dungeon-rolls`. The band itself
   now exists (§2.7): +0, defense 10, 2 HP, and reachable from the Easy difficulty. What
   is still open is whether it gets its own *resolution*, since 2 HP already dies to most
   single hits without a rule saying so.
3. **A hard cap on how many creatures may attack the player in one exchange**, regardless
   of how many are in the room. The fiction carries the rest as pressing in, waiting for
   an opening, blocking the way — which is what a real melee looks like and what a crowded
   doorway does. The cap is a number in code that the resolution step is told about, not a
   judgement the referee makes. **Suggest 3.** It also bounds the batched `roll` call,
   which would otherwise roll thirteen attacks in one go.

(3) needs no measurement, is the cheapest, and is the one the player feels. It can ship
alone.

---

### Effects with consequences

**The magnetic field did nothing.** The player walked through it wearing chain, carrying a
sword and a helmet, and nothing happened. An effect with no mechanical consequence written
for it is an effect the referee has no way to apply.

**Decide in session:** either effects need a consequence field the content pass fills in,
or the resolution step needs to be told that walking into an effect is an event. The open
question is how an effect with no written consequence reaches the resolution step at all.

---

### Creature reactions in the room

*"Wendy badmouthed the Brotherhood in front of Zora, a member of the Brotherhood, to no
response."* And generally: *"Creatures need more guidance to make NPCs act more normal
when the player talks to them."*

The referee's own R2 traces say what is missing. It reasons about **Wendy's position** and
**Zora's position** as two separate one-on-one relationships with the player, and closes
with *"No other creatures act"* — written about a room holding exactly the creature that
had just been insulted. It is not ignoring Zora; it is handed the player's action and one
target list, and nothing ever asks it what everyone else in the room thought.

**Two instructions, and they are two because they answer different questions:**

1. **On every turn that changes state, ask what each creature present does about it** —
   not only the target. This is the world-acts problem at a range of zero, and it should
   share whatever mechanism that has: the per-turn hook fired for the *current* room is
   the cheapest version and the one worth building first, because the player is standing
   there to see it.
2. **When deciding a creature's action, put the other creatures in the room in front of
   it, with what it knows of them** — including what it expects them to do about it. Wendy
   insulting the Brotherhood in front of Zora is a *choice* if Zora is in the context and
   an accident if she is not. Group membership is already on the entity through
   `registry.groups`, so "Zora is Brotherhood and Wendy just insulted the Brotherhood" is
   derivable rather than something the model has to remember.

**What binds:** whatever a creature does is `activity` and `state` writes through the
ordinary applier, `composed` travelling with `state` (§2.4). No new entity type, no
initiative, and the model still authors no numbers — a reaction that needs a roll goes
through the batched `roll` tool like everything else.

**Reads much better after [First impressions](#first-impressions)**, since "who is this
person" and "what do they do about what was just said" are the same scene.

---

### Followers, and creatures moving the player

*"Should entities be able to take the player to another room?"* Two cases: **when the
player is cooperating with them**, and **when the player is downed but not slain**. And
behind both: *"Follower logic? Henchmen/party members?"*

A creature writing `currentRoomId` is not currently possible — the player's room moves
through travel, which is the player's own action, and `apply.ts` treats a walk as
something the player did. Three things to settle:

- **Consent.** Being led somewhere you agreed to go is a scene; being moved without
  consent is the thing that makes a player stop trusting the interface. The downed case is
  the one exception, and it earns it by being the alternative to death.
- **Whether a follower is an entity or a new concept.** Almost certainly a creature whose
  `activity` says it is following, with `roomId` written to wherever the player went — no
  party, no second sheet, no shared inventory. One PC is a non-goal that still holds; a
  follower is scenery that walks, not a second character.
- **What the map does.** A follower is a creature and creature markers do not exist, so it
  will be invisible on the drawing until [Creature markers](#creature-markers) lands.
  Acceptable; note it.

---

### Rest

**Fully specified and unblocked.** It is what makes the `long` time category reachable —
`long` is on the wire today and refused until this exists.

The structural twin of `roll_offered` / `pendingRoll`, throughout: a `rest_offered` stage
and `pendingRest` in the store, `TurnMachine.rest()` mirroring `roll()`, a `RestOffer`
component beside `RollOffer` in `InputArea.tsx`, `steps/6-rest.md`, and
`restRoll(rng, conBonus)` in `dungeon-rolls.ts` — there is no heal kind today. The heal is
resolved **client-side on the button press**, like the player's d20 and for the same
reason. Typing an action cancels the offer, which is free: `acceptsInput` stays true and
`submit()` already resumes at `r.step`.

**Long actions that are not rest** — digging out a passage, standing a watch — and
**exhaustion** are post-MVP. `RestOffer` carries no `label` because of it; when those
arrive they will want one.

---

### Take Item

Specified in full, built in none of it. The design survived being written down — this is
what to build, not what to reconsider.

- **`Commit.takeOffers?: TakeOffer[]`**, attached to a commit whose `nextStage` is
  `awaiting_action`. An offer is either an item that already exists (`itemId`), or one
  that is part of something else (`from: { sourceId, sourceState, item: EntitySpec }`) —
  the gem in the statue's eye, where the referee has already written both the new thing
  and what the statue looks like without it.
- **Clicking costs no model call**, which is the point. The offer already carries
  everything the applier needs: `{itemId, "parentId", "player"}` for the first case;
  `{player, "children[]", spec}` plus `{sourceId, "state", sourceState}` for the second.
  Both paths exist and are tested.
- **Stored as `RunState.takes`**, set in `store/game.ts` beside `pendingRoll`, cleared by
  the next submit, by a take, and by a move.
- **`TurnMachine.take(offerId)`** builds the diffs and calls `store.commit` directly.
  `POST /api/runs/:id/take` beside `roll`; `session.take()`; buttons in `InputArea`
  rendered like `RollOffer`.
- **Taking does not close a turn or tick the clock** — nothing goes through `ask`, so
  `turnCount` is untouched. A log line and a transcript entry, so the next call knows.

---

### An Rng inside the applier

**An item the referee creates mid-run is worth 0.** The grade-rolled value needs an `Rng`
inside the applier, which is the same plumbing [Take Item](#take-item) wants. Until then
`createEntity` writes `value: 0` and says so at the site.

---

### Connectors written with their room

*"Change the order of creation on room connectors. They need to be done at the same time
as the first room so they can be part of its context, and then added to the context of the
adjoining room on its generation."*

Today (§2.2) the lower graph index owns a connector inside a chunk, and a connector leaving
a chunk is a seam written last. So the first room's own description is written **before**
the way out of it exists as prose, and the second room's is too if the connector is a seam.
That is why a room says *"a spillway of stacked wood and stone"* in one place and the
connector says something else in another.

**The change:** a room's connectors are written **with the room that first claims them**,
and the adjoining room's payload carries the finished connector prose as context it must
agree with rather than re-invent. That makes ordering load-bearing where it was cosmetic —
`applyContentPass` is already serial in ascending chunk order for exactly this kind of
reason, so the mechanism exists.

**Open: what survives of the seams pass.** It may survive, may shrink to only the
connectors whose both rooms are in later chunks, or may disappear. Decide with the payload
in front of you. Whatever happens, §2.2's ownership rule is being rewritten and the tests
asserting it move with it.

---

### The entrance in the fiction

*"Incorporate the dungeon entrance into the fiction."* / *"Most of them are really weird."*

Both are one cause. `DUNGEON_ENTRANCES` (`dungeon-blueprint.ts:131`) is the Maze Rats
table — *Beaver dam, Living tattoo, Giant book, Under the bed, Maze potion, Unfolded map*.
It is rolled in **stocking** (`dungeon-rooms-loop.ts:897`), which is branch B of the
pipeline, and the **opening prose is written by the Dungeon Pass**, which is branch A and
runs concurrently. **Branch A cannot see the roll.** So R2's opening walks the player down
a rim path into a quarry, and the entrance roll — *Beaver dam* — surfaces only as a clause
in one connector's description, in a room the player reached later.

**Two fixes, take both:** move the entrance roll **before the split** so the Dungeon Pass
is handed it and the opening is written around it; and **cut or rewrite the table** for a
dungeon that is a place rather than a fairy tale. A third of those entries cannot be
realised in a marble quarry without the model either ignoring them or writing something
absurd. The table is Maze Rats' and was transcribed wholesale; that was right for the
detail tables and wrong for this one.

---

### First impressions

*"Named NPCs are identified by name in the room card — in general names need to be toned
down to better represent first impressions."*

R2, on first sight: *"One is a wiry woman with intricate braids—Wendy, you think, though
you have never seen her in the flesh."* The referee is patching around a name it was handed
and had no way to withhold. `entity.name` is identity and is **not runtime writable**
(§2.4), the room card renders it, and the prompt renders it — so a stranger across a dark
room is labelled.

**The proposal: a `properNamed` flag, false at first.** While false, the name is a
description the player would arrive at — *"a wiry woman with braids"* — the room card shows
that, the prompt shows that, and the referee may **write the true name in** the moment the
fiction earns it, flipping the flag. That makes `name` writable exactly once, through one
path, which is a narrow enough exception to §2.4 to be worth stating there rather than a
hole in it.

**Settle in session:** whether the placeholder is a second field or the `name` itself, and
what happens on reload for a creature named mid-run (it persists — it is a normal field
write).

---

### One leader, one entity

**A generation bug, and the more serious of R2's two goal complaints.** Wendy is written
into Revenant Spring *and* into The Crypt, with the same name, the same base and different
`activity` — two entities realising one group's leader, because each chunk that placed a
member of that group realised the leader independently.

A unique named NPC must be one entity. Look at how `registry.groups` members are
distributed in `stockDungeon` and at what the content pass is told about a group whose
leader has already been written. **Worth a `validateWritten`-style assertion** — no two
creatures sharing a name and a group — because it is exactly the class of thing that
silently passes today.

---

### The goal names what is in the goal room

*"Wendy appears to be the goal entity for the dungeon, but she showed up in the 3rd room. I
thought we had something in place to make sure the goal was found on the opposite side."*

**The placement machinery is working.** `structure()` picks the goal room by eccentricity
from the entrance (`dungeon-rooms-loop.ts:426`), and in R2 it did: the entrance is the
Bookyard, the goal room is The Vault, the goal entity is the ledger. The player never got
there.

The defect is that **the goal text names Wendy** — *"Learn what Wendy Wilberforce has
promised…"* — so meeting Wendy reads as arriving at the goal. The goal directive should be
stated in terms of **what is in the goal room**, or the NPC it names has to be the one
standing in it. Today nothing connects the two: the directive is written by the Dungeon
Pass from `bp.inhabitants`, and which room a group's members end up in is stocking's.

---

### Rewards: the keys pass

The full design is `docs/REWARDS-SPEC.md`; this does not repeat it. **R2 of three**, and
R1 (`dungeon-challenges.ts`, `dungeon-rewards.ts`, the taxonomy, the pot, placement, the
reserve) is built. Spec §6 is the pass.

Carried in from R1:

- **The content pass still writes placed keys**, from the challenge's fact and its kind
  label. Spec §6 has it skipping them the way it skips seams; that is this session's
  change, and the note at the `case "reward"` block says so.
- **`goal-property` is declared and not enumerated**, per spec §2/§6. This pass mints those.
- **The placed-key count varies more than the spec's "roughly four" suggests — 1 to 9 at
  size 5.** Structural rather than a bug: step 1 walks the reward-guaranteed locations
  rolling loot-or-key at `KEY_SHARE`, and a dungeon with few such locations spends its
  general budget in the contested draw instead, which places no keys. The order spec §4
  fixes is implemented as written; narrowing the spread means changing that order, so it
  is this pass's decision or the next one's. The dials are all named constants at the top
  of `dungeon-rewards.ts`.

Measured across nine dungeons (seeds 1005 / 4242 / 90210 at sizes 2, 3, 5): challenge
counts land where the spec predicted (~30 at size 5) and money is bounded — a whole size 5
dungeon is ~1500cp against a Knave starting purse of 60–360.

---

### Rewards at runtime

**R3 of three**, spec §7–8: the draws, the resolution writes, `mapped`, the ledger, and the
tally. `IRoomFeature.isObstacle` and `resolved` are in and `resolved` is whitelisted on
`RoomFeature` in `paths.ts`; **nothing writes `resolved` yet** — that is this.

---

### Prose for the equipment catalogue

**The 122 entries in `equipment.ts` need prose**, and it is the author's to write, a few
at a time. An unwritten entry behaves exactly as it did before the table existed, so this
can be done in any size of bite and never blocks anything.

**The Maze Rats tables behind the rewards are all filled** — the six that were stubs, plus
`EDIBLE_PLANTS` and `POISONOUS_PLANTS` behind them. `rollTable` still returns undefined on
an empty list and `resolveCascades` still leaves an unregistered token's own name inline;
both are asserted in `rewards.test.ts` directly rather than through whichever table
happened to be empty, so the next stub is a dull word in the prose rather than a crash.

---

### Creature markers

**Creatures do not appear on the map at all**, and with them the "last seen here" position
snapshot: an entity that moves while the player is elsewhere currently loses its marker
rather than staying where it was last seen.

Right for every path that exists today — all of them happen with the player watching — and
wrong for a thief carrying something off. **The snapshot arrives with the markers, not
before**: a field nothing reads correctly is worse than a documented gap.

Two other features are waiting on this: a creature row in the room card lights nothing on
hover until markers exist, and a
[follower](#followers-and-creatures-moving-the-player) is invisible without one.

---

### The map's orientation and labels

Four items, one surface:

- **A compass rose.** Not decoration — the prose is being held to absolute directions
  (§2.11), and the map should state which way north is rather than assume it.
- **Floating labels on explored rooms.** Room names on the map itself, fog permitting.
  Today the name is on the hover only.
- **Auto-centre on the new room** when the player moves.
- **The second fog bit.** A corridor walked through but never stood in is *seen, not
  examined*, and should be drawn without having cost a composition call.
  `composed === undefined` is still the only fog signal.

---

### Markers answer a click

*"Icons in rooms are not clickable. They should create the quick action button for that
entity type."*

**They are supposed to**, which makes this a behaviour that contradicts the code:
`Fixture` in `DungeonMap.tsx:107` spreads `anchor(f.id, …, thingVerb(f.name))`, so every
marker carries `data-verb` and `data-verb-text` exactly as a room path and a door do.

**Reproduce before fixing.** Prime suspect, and it explains why the tests pass:
`onPointerDown` on the `<svg>` calls `setPointerCapture` for the pan drag
(`DungeonMap.tsx:229`), and while a pointer is captured the browser dispatches the
subsequent `click` to the **capturing element**, not to the marker under the cursor — so
`react-tooltip`'s `anchorSelect="[data-verb]"` never sees it. `hover.test.tsx` fires
`click` on the element directly and so cannot catch it. If that is the cause, the fix is
to release capture and treat a press that never moved as a click, or to stop capturing
until the pointer has actually travelled a few pixels. **Whatever the cause, the
regression test has to go through the map's own pointer handlers.**

---

### The scrollback

- **Roll entries larger and more prominent**, with success and failure carried by colour
  and weight rather than by the word at the end of a mono line. The roll is the moment the
  player was promised they would get to watch; it currently renders as the least prominent
  thing in the scrollback.
- **A sticky room header at arrival** — room name, and enough of the description to stay
  oriented, pinned as the narration scrolls.
- **The layout shifts when the room changes.** *"Something changes causing a shift in the
  DOM layout when a room change occurs. I can't see what it is."* Reported and **not yet
  reproduced** — most likely by stepping between two rooms whose cards differ in height.
  Prime suspects in order: the room card growing or losing a section (occupants, ways out)
  between rooms; the map re-centring; a scrollbar appearing. **Fix by reserving the space
  rather than by chasing the specific element.** If it will not reproduce, that is worth
  knowing before a session is spent on it.

---

### The blank beyond the surface exit

The dashed stub standing for the outside is drawn; the space around it is not designed.

---

### Positions from the planar embedding

**Size 5 block plans fail about one attempt in eight**, with ~0.5 crossings surviving the
untangle hill-climb. Handled by throwing the graph away and generating another, up to 8
(`GRAPH_ATTEMPTS`), which puts the failure rate near one seed in ten million. The retry
seed is derived (`<graphSeed>~<n>`) so a seed still names one dungeon.

**Cheapest first:** flip a whole branch across a crossing rather than swapping two rooms;
allow occasional worsening steps; stop the spring pass reintroducing crossings; bail before
routing when untangling did not reach zero.

**The proper answer is to derive positions from the planar embedding** rather than
hill-climbing toward it — then the retry loop runs once, always.

---

### Dev affordances

Three left, all independent:

- **Call log viewer.** `referee.ts` writes `run.callLog` and nothing renders it.
- **Jump-to-room.** A debug diff that sets `currentRoomId` and fires the room-entry pass.
- **Replay.** Replays the *run*, not the generation: load the persisted `GeneratedDungeon`,
  reset `runSeed`/`rngDraws`, feed `playerInputs` back through `turn.ts`. Deterministic
  because the dice come from the seeded run RNG and the dungeon is fixed. **Model responses
  are not deterministic**, so replay is only exact against the stub or a recorded-response
  cassette — record responses in the call log and add a cassette mode. **Say this out loud
  in the code**, because "replay" implying determinism through a live model would be a
  misleading affordance.

---

### Dungeons as a generation cache

Reuse a world somebody has already paid to generate. **Not on `dungeons_cache_idx`, whose
key is wrong**: seeds do not matter after generation, so the pool is keyed on
**`(size, level)`** and hands back any complete world of the right shape this player does
not already hold. That hits the first time anybody has built one, where the seeded key does
not hit until the corpus is in the thousands.

**Still to settle:** whether a hit duplicates silently or is offered, and whether a player
may opt out — noting that opting out buys the same skeleton for real money, so it may be a
dev switch rather than a player control.

The machinery it sits on is built: `POST /api/dungeons/:id/duplicate` copies the row, the
`doc` and the generation journal under a new uuid with the new owner.

---

### Rate limiting

**Nothing rate-limits a signed-in player**, and generation is the expensive call. The
Google consent screen's Testing mode — 100 invited addresses — is the only quota today,
which is enough while it is invite-only and is not enough the moment anyone can sign in.

**It cannot be in-process**: one stateless Vercel function and no Redis on Hobby, so the
counter is in Postgres and is charged **explicitly at the top of the handlers that call the
model**, rather than in middleware that would have to guess what a route costs.

**And it must not read `profiles.tier` yet** — every account defaults to `byok` while in
fact spending the author's key, so a tier-aware limiter today exempts everyone.

---

### The library card's run-state badges

The artifact's `IN A RUN`, `DIED · ROOM 3`, and the epitaph. These need per-character run
state nothing stores, and a badge computed from a field nobody writes is worse than no
badge.

---

### Telling the referee it got something wrong

**Deferred on purpose, and recorded so the next reader does not re-derive it.** The author
raised it after R1 and was unsure of the shape. R2 was the playtest that was to decide it
and it says: still deferred, and now we know what it would have been for — the ledger took
three attempts and the referee published a discarded draft, and a "that's wrong" button
would have been the player patching over both. Both have real fixes and both shipped.

**Revisit after a run in which the machine is behaving and the referee is still wrong.**

Three shapes were considered: a *"that's wrong"* button opening a correction turn that may
rewrite `state` and `composed`; a persistent out-of-character input channel addressed to
the referee as a referee; and nothing at all, on the theory that a referee which cannot be
argued with is part of the genre. No decision.

---

## 4. Accepted gaps

Known, deliberate, and not currently anybody's feature. Revisit if the symptom starts
mattering.

1. **Relief is not applied.** Outside MVP. The axis and its carving code still exist in
   `dungeon-floorplan.ts` and are still tested; nothing calls them.
2. **The family axis is unused**, so no round, cross or T-shaped rooms. Revisit if the
   drawings read as monotonous.
3. **Large rooms are unreachable.** Zones average 20–40 cells. Accepted: size feeds only
   the identity roll, and the bands that matter for that are reachable.
4. **Proportion cannot lengthen a room whose doors cluster**, because the skeleton runs
   between the doors. "A banquet hall is long" is not honoured.
5. **Target areas are a placeholder roll** (`[6, 9, 14, 20, 28, 40, 56]`) rather than
   derived from the size classes.
6. **Corridors are only mildly narrower than chambers.**
7. **`dungeon-floorplan.ts` is parked, not deleted** — author's call, kept as the record of
   a design that lost. `generateFloorplanValid`, `floorplanSvg` and `validateFloorplan`
   have no callers outside `floorplan.test.ts`, and the four suites exercising the packer
   are `describe.skip`. **Two suites stay live and must:** `corridor designation` covers
   stocking, and `chamber archetypes` covers the vocabulary in `dungeon-room-size.ts` that
   the identity roll reads through `sizeAllows`.
8. **A multi-cell fixture draws as several separate things.** One berthed entity across two
   cells, drawn one mark per cell so a colonnade reads as a row. Weighed and dropped: it
   needs a per-kind spread/no-spread decision that was not worth the session.

---

## 5. Non-goals

No multiplayer, no party (one PC). No leveling. No between-dungeon persistence beyond saved
characters. No light or ration clocks yet, though `turnCount` exists for them. No mobile
layout — desktop-first, must not break at tablet width.

**And no retrofitting.** A dungeon generated by an earlier build is disposable: this is
still development, there is no installed base, and a fix that applies from the next
generation onward is a finished fix. Nothing here gets a migration path, a back-compat
branch, or a caveat explaining what old saves keep. This is **not** licence to drop a field
a *current* generation run can legitimately leave unset — `blockplan` is null whenever the
plan does not draw (§2.10), which is a live supported case and not legacy data.
