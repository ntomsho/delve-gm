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

## 0. The aim

**This app is a portfolio piece.** That is the test every design decision answers to:
it should look as good as it can, be as technically impressive, as well written and as
performant as it can — **and cost as little as possible to run.** None of those is
traded away silently for another. Where two pull against each other (an illustration
looks better and costs money; a bigger model writes better and costs more), the feature
says which way it went and why, and the cheap path is the default until something
measured says it is not good enough.

Concretely: prefer work done once over work done per run, work done per dungeon over work
done per player, and code over a model call wherever code can do the job.

---

## 1. Where things stand

Built, live and deployed at **https://aidungeon.vercel.app**: generation end to end
(dungeon pass, content pass, seams pass, block plan), the turn loop against the real
model, character creation and the shop (which sells as well as buys), the map, accounts
and ownership, run continuity (resume, abandon, the one-run-at-a-time lock), shared
worlds and the library, the single equipment table, time categories and creature agency,
the first of three rewards sessions, levelling, and guest accounts with daily run
allowances (layer 3 of *Paying for strangers*).

**1,398 tests and build clean**, plus a third, explicitly-invoked vitest config
(`npm run test:db`) holding **72** more that need a real database.

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
// src/generation/seeds.ts
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
same conversation (`missingPost` in `game-master.ts`).

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
  `addItem` / `removeItem` from `character.ts`, `setState` from
  `entities.ts`.
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
  precedence `entities.ts` sets for prose — what the player was told binds.
  It falls out for free: never encountered draws nothing; concealed draws nothing,
  because room entry never composes a hidden thing; something that changed two rooms
  away goes on saying where it was last seen, because `setState` leaves `composed`
  alone; something revealed by a search arrives **with** the prose, because
  `setIsHidden(false)` opens a description debt the next composition pays.
  **The filter lives in `mapView` and nowhere else.** `Layout.fixtures` deliberately
  carries every placed entity, concealed ones included, because `map-layout.ts` knows only
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
- The vocabulary lives in **`src/generation/floorplan/room-size.ts`** — bands, `classOf`, the
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

- **Nothing outside `src/ui/` imports React**, and the domain — everything except the
  shells `ui/`, `server/`, `dev/` and `api-client/` — touches no environment global
  (`import.meta.env`, `window`, `document`, `process`), so all of it runs under vitest.
  Both are scans in `src/architecture.test.ts`, which walks recursively and asserts it
  found files before asserting anything about them.
- Model strings live only in `src/llm/models.ts`, keyed by task. The same file greps
  for `claude-` and the image endpoints outside it.
- The API key lives in `.env.local`, is loaded with `loadEnv(mode, cwd, "")` — **empty
  prefix**, so it is readable by the config and never `VITE_`-inlined — and is injected
  by the dev proxy. The CLI path is Node and reads the key directly; that is not the
  rule being soft, it is there being no browser to keep it out of.
- Skill markdown loads via `?raw`. A test asserts every `steps/…` path named in
  `SKILL.md` resolves to a real file. **`?raw` is a bundler feature** — Vite and vitest
  understand it, plain `node` does not, so anything reaching the referee outside a
  bundler registers the hook in `dev/lib/raw-md.ts` first.
- **No module holds one of anything a run owns.** The store, the journal and the turn
  machine are made per run and carried, never imported: `createGameStore`,
  `createJournal`, `createGameSession`. A singleton is correct for exactly one situation
  — a browser tab, with one run in it — and wrong in every process that serves two.
- `src/ui/shared/use-game.ts` is where game state meets React: the store's hook.
  `gameplay/state/store.ts` imports `zustand/vanilla`, not `zustand`, because the
  package's own entry point re-exports `zustand/react`.
- **Two vitest projects, split on the file extension.** `.test.ts` is headless,
  `.test.tsx` is jsdom. The extension is the whole of the rule.
  `src/ui/test-utils/jsdom-setup.ts` supplies entry points jsdom lacks
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

### Illustrations

**Black-and-white line art in the manner of the old modules**: pen and ink, hatching,
no grey wash. The precedent is exact: the 1e modules shipped illustration booklets for
the DM to hold up as the players entered particular rooms (S1's is the famous one). This
is for the **player**, never the model, so it does not reopen [Room plans](#room-plans)'
"not an image" — that was about what the referee reads.

Four kinds, in the order they should be built. Assessed, not built; **nothing here is
committed to until the spike below has been looked at.**

**What binds all four**

- **An image shows only what the player could know.** The prompt is built from the
  room with every concealed feature and connector filtered out — the same filter
  `roomView` applies. A `base` that mentions a secret door, fed to an image model, is a
  picture of the secret door: §2.10's *never differently* in a new medium.
- **Images from `base` belong to the dungeon; images from `state` belong to the run.**
  A `base` image is true forever (§2.4), so the first player in a shared world pays for it
  and every later one gets it free, and a duplicated dungeon shares it by URL. A `state`
  image is one player's run and dies with it.
- **The prompt builder is pure and lives in `src/illustrations/`**; the provider call is
  server-side behind its own key in `.env.local`, exactly like `ANTHROPIC_API_KEY`
  (`src/server/app.ts`). The image model's string lives in `src/llm/models.ts`
  — `src/architecture.test.ts` greps for both.
- **Post-processing is code, and it is what makes the style hold.** Every image is
  thresholded to **1-bit** on the server: it guarantees black and white (the commonest
  way these models drift), pulls different models and calls toward one look, shrinks a
  PNG to ~50–150 KB, and lets the white become the app's paper colour so the plate sits
  on the page rather than in a box.
- **No image ever blocks a turn.** Prose first, picture when it lands. Nothing in game
  state depends on one existing, and a failed call is a missing picture, never an error.
- **Paid out of the same budget.** Every image call writes the `spend` ledger and is
  gated by `DAILY_BUDGET_USD` like any other start; see
  [Paying for strangers](#paying-for-strangers),
  which comes first. Over the budget, a room simply has no plate. The curated shelf's
  plates are drawn ahead of time by the author, so a guest never causes an image call.
- **Lettering only in a fantasy script.** Where something should carry text — an
  inscription, a sign — ask for it in an invented script of roughly the real text's
  length, never in a readable alphabet. These models write nonsense into readable text.

**Composition: settled in code, by a camera search.** *Built:* `plateView` /
`viewFrom` (`src/illustrations/view.ts`), `roomPlate` / `plateBrief` / `plateTags`
(`src/illustrations/room-illustration.ts`), the guide image (`src/illustrations/sketch.ts`), and a contact
sheet checking all of them against the map (`node src/dev/cli-illustration-views.ts [--dungeon
<json> | --seed N --size S]`, written to `out/plates/`).

- **The camera is chosen by score.** Nine spots per floor cell, each tried at 36 headings
  (100° field of view, 3:2 frame, eye at 5.5 ft). The camera never stands in a doorway,
  only on the floor in front of one. A doorway view showed the room from somewhere the
  player had not been, sometimes through a sealed door.
  `PLATE_SCORE`: floor cell 1, feature 100, exit 20, the way in 5. A tie keeps the first, so
  the view is deterministic. Sight lines are an exact grid walk. A thing counts only once it is past `PLATE_MIN_AHEAD_FT`
  (~6.9 ft), where the floor enters the bottom of the frame.
- **Measured (seed 4201, 43 views):** **95% of features and 70% of other exits** are in the
  picture. Before the search, standing in the entry door, it was 74% and 28%. All three
  misses are in 10-ft rooms (The Gallery, The Petrified Fountain), where no spot on the
  floor is far enough back to frame everything; doorway spots had recovered them at 98%.
  Search time is under 10 ms per view.
- **The view barely depends on the way in.** At 5 points the entry only breaks ties, so
  most rooms get the same camera whichever door the player used. The plate is still keyed
  by its prompt; it just mostly comes out one per room.
- **The guide image is architecture plus placement marks, never solids.** A reference gets
  copied, so it carries only what should be: continuous walls with a vertical only at
  corners, outlined doorways, no floor grid. Each visible feature is a dashed footprint
  outline (one per connected piece) with a numbered tag; each visible doorway has a
  lettered tag. The brief uses the same tags, and `PLATE_GUIDE_NOTE` tells the model the
  marks are not to be drawn. `marks: false` draws the architecture alone. **The first
  image test decides** whether models leave the marks out, and which variant to use.
- **Feature presence, from the rolled table entry** (`featurePresence`,
  `src/illustrations/feature-presence.ts`). There are three kinds:
  - **object:** placed, outlined and tagged.
  - **surface:** stains, murals, haze, anything "throughout". Drawn over the room and
    given a button, but no outline or tag; the brief describes it in words.
  - **sense:** sounds, smells, drafts. Not scored, drawn or given a button; the brief
    lists it "for mood only".

  Every fixture is an object. A table entry missing from the lists defaults to object.
- **Outlines stop at walls.** A footprint outline is cut into 0.25 ft pieces and only the
  pieces in line of sight are drawn. Walls run floor to ceiling, so seeing a floor
  point is a 2D test.
- **Hotspots for the page's buttons** (`plateHotspots`, `src/illustrations/hotspots.ts`;
  `RoomPlate.hotspots`). Positions are fractions of the plate from its top-left, from
  the same projection as the guide, so a button sits on the doorway the model was told
  to draw. Each door (the way in carries `role: "entry"`) and each drawable feature is
  one of:
  - **shown:** a button per point, one per visible piece of a feature.
  - **around:** the first corner on the shortest walk to it, found by Dijkstra over
    the room's inside corners, with which way the walk turns there. The arrow is the
    button, so there is no dashed button as well.
  - **behind-wall:** in the field of view but walled off, with no corner in the frame to
    route through. A dashed button where it would be.
  - **off-frame:** an arrow on the left, right or bottom edge. Past
    `HOTSPOT_BEHIND_DEG` (120°), or straight ahead but below the frame, means bottom.

  Each outcome is exactly one control. Guide tags are drawn at the hotspot points, so a
  tag and its button cannot disagree. Seed 4201, 43 views: 136 shown, 17 around, 28
  off-frame, no behind-wall.

**Storage: a table keyed by what the image shows.** An image link cannot go in the
dungeon, because `base` is never written at runtime. It cannot go in the run's `state`
either, because then only that run could see it and every copy would pay again.

```sql
create table public.plates (
  key        text primary key,   -- sha256 of what the plate is drawn from (`plateKey`)
  status     text not null check (status in ('pending', 'ready', 'failed')),
  path       text,               -- object path in the storage bucket
  model      text not null,
  attempts   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

- **The key is a hash of what the plate is drawn from, and that gives sharing for
  free.** Not of the final prompt: that carries words Haiku wrote, which differ every
  call, so a key made from it would never be found again. `plateKey`
  (`src/server/illustrations/serve.ts`) hashes the Haiku requests, the layout half of the prompt, the
  guide SVG, the style version, the model and quality, and the number of references.
  All of it is a pure function of the room's `base` as generated. A copy of a dungeon builds the same
  prompt and so finds the same image. Two worlds from one seed have different prose, so
  they get different images, which is correct (13a: a seed is a skeleton, not a world).
  Bumping `PLATE_STYLE_VERSION` or changing the model redraws everything from then on,
  rather than mixing two styles in one dungeon.
- **Concealment is judged as generated, not as played.** The prompt reads `isHidden`
  from the dungeon doc, never from the run, so a room's key never changes. A secret
  door the player has found stays out of the plate; drawing it is a state plate
  (kind 4 below), not this.
- **Files go in a public Supabase Storage bucket**, at `plates/<key>.png`, served by its
  CDN. A public bucket is safe because the key is a hash nobody can work out without the
  `doc`, and the API refuses to make one for a room the run has not entered. The upload
  needs `SUPABASE_SERVICE_ROLE_KEY`, server-only, in `.env.local` and on Vercel.
  - Rejected: `bytea` in Postgres served through the API. That needs no new secret, but
    every image then passes through the function and fills the 500 MB database tier,
    which the curated-shelf decision is already protecting.
- **One route:** `GET /api/runs/:id/plates/:roomId`.
  1. Check ownership, as every route does.
  2. Refuse a room the run has not entered. A plate of an unentered room shows the
     player that room.
  3. Build the prompt from the dungeon, hash it, and look up the key.
     - `ready`: return the URL.
     - Missing: claim it (`insert … on conflict do nothing` as `pending`), check the
       budget, generate, threshold to 1-bit, upload, mark `ready`, return the URL. The
       claim means two runs entering the same room pay once, and the 300s
       `maxDuration` has plenty of room.
     - `pending` under someone else's claim: `202`, and the client asks again in a few
       seconds. A claim older than a named timeout is treated as abandoned.
     - `failed`: retry while `attempts` is under `PLATE_MAX_ATTEMPTS`; past it, no plate.
- **`?offline` and `?stub` never request a plate.** The fixture pages stay free.
- **Images outlive their dungeons.** Shared by key, so no one dungeon owns one, and at
  ~100 KB each an orphan costs too little to be worth a sweep.

**Room plates are BUILT (2026-10-13)** as described here:
- migration `20261013120000_plates.sql`, with `plates`, `plate_words` and the public
  `plates` bucket;
- `servePlate` / `livePlateWork` in `src/server/illustrations/serve.ts`;
- the sharp steps in `src/server/illustrations/image.ts`;
- the route in `src/server/app.ts`;
- `Illustration.tsx` in the narration.

Differences from the design above:
- **The way in is the run's.** Each arrival in the log records `via`, the connector it
  came in by. `plateEntryFor` draws from the first arrival's door, so the client names
  only the room.
- **The drawing starts on the server, the moment a turn puts the player in a room
  they have not arrived in** (`playTurn`, kept alive with `waitUntil`), alongside the
  arrival prose. The page's own ask then finds the plate pending, then ready. Asking
  only from the page put the ~25 s drawing behind the prose.
- **`plate_words`** keeps the per-dungeon SETTING line, so every plate in a dungeon is
  drawn against the same line.
- **Three paid calls in one request:** the setting (once per dungeon), the room's words
  and the image. That is about 25–35 s.
- **No budget check yet.** The `spend` ledger and `DAILY_BUDGET_USD` do not exist (see
  [Paying for strangers](#paying-for-strangers)). The gate today is that a plate is
  only drawn for an entered room, at most `PLATE_MAX_ATTEMPTS` (3) tries per key.
  When the ledger lands, the claim in `servePlate` is where the check goes.
- **The off switch is configuration.** Without `FAL_KEY`, `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY`, every room answers `none`.
- **Guide tags are stroked paths, not `<text>`.** A serverless function has no fonts,
  so sharp would rasterise `<text>` as nothing.
- **The plate's buttons are BUILT, as white dots only.** A ready answer carries
  `spots` (`plateSpots`, `src/illustrations/room-illustration.ts`): one per point of each `shown` hotspot
  that has a guide tag, so a dot sits where the guide's marker was. They are recomputed
  from the dungeon on every ask, not stored with the image. Each dot is the map's marker
  for that thing (`doorHover` / `fixtureHover` in `DungeonMap.tsx`): the same card, the
  same verb, and the same `lit` id, so the plate, the map and the room card light
  together. A thing the map does not show has no dot. The way out of the dungeon is
  torch, as on the map. Dots have a 3 px ink rim. The door they came in by
  (`ExitView.cameFrom`) carries a U-turn. Only the plate of the room the player is in has
  buttons. A resumed run asks only for the current room's plate; rooms already arrived in
  at mount (`resumed` in `PlayScreen`) are skipped. Not built yet: the `around`, `behind-wall` and `off-frame` arrows.

**Dungeon covers are BUILT (2026-10-13).** A cover is the dungeon's exterior: the picture
on its library card, beside it in run setup, and above its opening.
- **When:** `finish` names the cover's key on the row (`dungeons.cover`, migration
  `20261013180000_dungeon_covers.sql`). It stays beside `doc`, never in it.
- **Drawn by the first ask:** `GET /api/runs/:id/cover`, which the client sends the moment
  a run starts. So a new dungeon's cover lands a few seconds after its opening, and the
  run never waits for it.
- **From:** `coverDescription`, which is the opening prose plus the surface connector
  into the first room, condensed by `requestPlateExterior` and drawn by `COVER_MODEL`
  (klein 4B, prompt only, seeded with the dungeon seed). It is stored in `plates` like a
  room plate.
- **Copies** carry the key, so they share the picture. Dungeons finished before covers
  have none and are never drawn.

**Presentation: inline, at the arrival, in the page's own ink.**

- **The plate sits in the room's arrival section in the narration**, between the room
  name and its prose (`Narration.tsx`, the `arrival` branch). That is the module-booklet
  moment, and it makes the scrollback an illustrated record of the run.
  - Rejected: the room card, which is 320px wide and has no room for a picture.
  - Rejected: the map area, which is for the map.
- **Space is reserved at a fixed 3:2 the moment the player arrives**, with a faint
  pencil placeholder, so a plate landing a few seconds later fills the space rather than
  shoving the text the player is reading. The space collapses only on `failed`, which
  is rare.
- **The plate is drawn as ink, not shown as a photograph.** The server stores the 1-bit
  image as black on transparent, and the page uses it as a CSS `mask-image` over a
  `--color-ink` fill. The lines are exactly the text's ink, the paper is the page's
  paper, and there is no box edge.
- **Width is the prose measure (62ch).** A click opens it full size: the booklet held up.
- **First arrival only.** Re-entering a room does not repeat its plate; the scrollback
  already has it.

**1. Room plates — lazily, on first entry.** Generating every room at generation time
pays for rooms nobody reaches (R2 saw 3 of 12). The image call fires alongside the
room-entry call and arrives a few seconds after the prose. Architecture, fixtures and
atmosphere only: **no creatures and no loose items** — they move, die and get picked up,
and a picture of them is stale the moment they do. Prompt: a fixed style preamble, the
theme from `dungeonContext`, the room's name, visible `base` and fixture kinds; optionally
a Haiku call to condense it into a visual brief. The dungeon seed goes in as the image
seed wherever the provider takes one.

**2. Creature sprites — one per kind, not per entity.** Keyed on the group or creature
base in `registry.groups` / `registry.creatures`, so twelve cultists are one drawing and
a dungeon has perhaps 5–15 to make. A unique leader gets its own. Generated lazily the
first time the kind is met.

- **Transparency is free and needs no model.** After the 1-bit threshold, flood-fill the
  white *from the border* to transparent: only the background goes, and white enclosed
  by the figure's outline stays opaque paper. A morphological close first seals small
  gaps in the outline so the fill does not leak into the figure. Prompt for a single
  figure on a plain white ground. The paid alternatives are the fallback, not the plan:
  gpt-image-2 has a native `background: "transparent"` in preview (reported unstable,
  with grey fringing), and fal's background removers are ~$0.01–0.025 per image.
- **Removing a sprite is free**, so a death, a creature leaving and a creature arriving
  cost nothing to show.
- **Compositing into the plate is the risk, not the generation.** A figure dropped into
  a scene drawn without it reads as collage — wrong scale, wrong perspective, no ground
  contact — and code does not know where the plate's floor is. **Two layouts to compare
  in the spike:** in-scene (plates prompted with an open foreground floor, sprites placed
  along a bottom band and scaled by size), and **spot art** beside or overlapping the
  plate's edge the way the Monster Manual set its figures. Spot art cannot look wrong and
  is the default unless in-scene is convincingly better.
- **Interacts with [First impressions](#first-impressions)**: a sprite shows a stranger
  without naming her, which is the point of that feature.

**3. Item illustrations — two very different costs.**

- **The equipment catalogue** (122 entries in `equipment.ts`) is drawn **once, at build
  time, by a script**, committed as static assets and served from the CDN. A few dollars
  total, forever, and zero cost per run — the clearest case for §0's "once over per run".
  Shop, sheet and inventory all get it.
- **Unique items** — loot, keys, the objective — lazily, the first time one is taken or
  closely inspected. Dungeon-scoped when the item is in the generated dungeon; run-scoped
  when the referee created it mid-run.

**4. State plates — redrawing a room that has changed.** Feasible with the image *edit*
models (FLUX.2 edit, FLUX Kontext, Nano Banana, GPT Image), which take the existing image
plus an instruction — *"the brazier lies overturned, the floor is ankle-deep in water"* —
and keep everything else. ~$0.015–0.045 per edit.

- **Always edit from the `base` plate**, with the current visible description. Never
  chain edits on edits: each pass degrades, and the drawing drifts away from the style.
- **The trigger is the gate that already exists.** Room entry recomposes the room only
  when the staleness sweep finds `needUpdate` on the room itself (§2.9); a redraw rides
  that and nothing else, so it costs at most one edit per re-entry of a changed room, and
  never one per turn.
- **A cap per run, as a named constant.** Past it the room keeps its last plate. A
  changed room drawn as it was is a stale picture — tolerable, because the prose and the
  room card are what bind, and the cap is what keeps a long run's cost bounded.
- **Open: is every room recomposition worth a redraw**, or does the referee mark the
  changes that are *visible*? A flag on the commit is a judgement rather than a number, so
  §2.1 allows it — but it is another thing the referee can get wrong. Decide from the spike.

**Cost.** Aggregator prices, Aug–Oct 2026; verify before committing.

| | per image | lazy run, ~10 rooms | size 5, every room |
|---|---|---|---|
| FLUX.2 klein | ~$0.014 | ~$0.15 | ~$0.45 |
| Recraft V4.1 / Nano Banana | ~$0.035 | ~$0.35 | ~$1.05 |
| FLUX.2 pro + 3 style refs | ~$0.075 | ~$0.75 | ~$2.25 |

Plus ~10 creature kinds, a handful of unique items, and capped state edits — a lazily
illustrated run lands somewhere around **$0.30–1.50** in total, and less on a shared
world. Style references are billed as input on top; downscaling them to ~0.25 MP cuts most
of that. **The real price is per usable image**: a model that needs three attempts costs
three times its listed price.

**Candidates.** FLUX.2 [pro] (up to 10 reference images, built for keeping a style
across them); FLUX.2 [klein] (cheapest, open weights, so a LoRA trained on our own style
is the long-run route to a locked look); Recraft V4.1 (strong on line art, custom styles
from references); Nano Banana (prompt-following, references, edits); GPT Image 2 at low
quality. **Not**: Imagen 4 (gone from the Gemini API since Aug 17) or gpt-image-1 / 1.5
(shutting down Oct 23 and Dec 1).

**Style references must be ours.** Not TSR art and not a community LoRA trained on named
artists — both are someone else's copyrighted work in a piece meant to be shown. Generate
from a prompt that describes the look in words, keep the 4–6 that are right, and those are
the references (and, later, the LoRA's training set).

**The spike comes before any of it**, and the storage and presentation design above
waits on it too: a model that cannot hold the style makes the rest moot.

*Round 1 is built and runs on the author's keys* (`ANTHROPIC_API_KEY` and `FAL_KEY` in
`.env.local`):

```
node src/dev/cli-illustrate.ts --dry   # everything but the images
node src/dev/cli-illustrate.ts         # ~144 images, est. $6.36
```

It writes a contact sheet to `out/illustrate/index.html`.

- **Subjects** (`src/dev/lib/illustration-subjects.ts`): 3 exteriors and 12 interiors, chosen to cover
  the layouts and a spread of looks (cave, rough-hewn or dressed stone; ruined, occupied
  or pristine; wet or dry; overgrown or lifeless).
  - Each interior is a real offline room picked by layout, with hand-written fiction at
    content-pass length. Footprints are relabelled only where the shape suits.
  - Single things (an altar, a desk) only take one-piece footprints.
- **What the image model gets**:
  - a fixed style text (`PLATE_STYLE`, versioned by `PLATE_STYLE_VERSION`);
  - the guide image's role;
  - a per-dungeon SETTING line;
  - the room's shell;
  - every thing in the frame, with a short look and where it goes.

  The looks and shell come from one Haiku call per plate (`plate-visual` task,
  `src/illustrations/visual.ts`; request text in `src/illustrations/prompt.ts`), which is
  forbidden numbers and positions. The WHERE is `plateView`'s.
  - Out-of-frame things and senses are not mentioned at all; naming something only to
    say "don't draw it" invites it.
  - Exteriors are built from their description alone: a dungeon's THEME is about its
    inside, and brought ceilings into an outside view.
- **Setups**:
  - GPT Image 2 at low (marks, plain, none) and medium (marks, plain)
  - FLUX.2 [klein] 4B (marks, plain, none)
  - FLUX.2 [pro] (marks, plain)
  - FLUX.1 [pro] Canny (plain only: it locks to edges, so marks would come back as edges)

  Endpoint ids live in `IMAGE_MODELS` (`src/llm/models.ts`). Every image is shown
  converted to 1-bit with the page's buttons laid over it.
**Spike outcome — DECIDED (2026-10-13, about $8 in all).** Judged on the 1-bit versions.

- **Interiors: GPT Image 2 at low quality, with the marked guide plus style references.**
  About $0.015 and 20 s a plate.
  - Of everything tried, GPT followed the prompt and the guide most closely. Medium
    quality was no better than low.
  - The marked guide fits the layout a little more closely than the unmarked one (the
    author's call), so marks stay. GPT never drew them; klein always did.
  - Canny was useless: it returned the wireframe with nothing on the walls.
- **Style: PLATE_STYLE v2, "sparse"**: mostly white paper, shading only in the deepest
  shadows. v1 asked for cross-hatching and stippling and got dense engraving that went
  busy or black at 1-bit.
- **Style references: klein [4B] no-guide plates of I7, I8, I9 and I10** (barracks, flooded
  nave, overgrown temple, forge cave), in the sparse style.
  - They are sent as 1-bit at 768×512, after the guide, with a role note
    (`plateReferenceNote`). Any frame klein drew is cropped off first.
  - Klein had the best line art of any model but follows content loosely. Its plates as
    references gave GPT's content klein's look.
  - The references are kept in the repo at `assets/plate-refs/` (with a README saying
    where each came from). The server route has to bundle them; on Vercel that means
    listing them in the function's included files.
- **Exteriors: klein [4B], prompt only, sparse style.** It was best on the castle and tied
  on the abbey. Exteriors get no references; the text-to-image endpoint takes none.
- **Open, refine later:**
  - **Framing:** GPT sometimes swaps the guide's angled view for a symmetrical,
    straight-on one (I2, I6). I8's one-point composition may be pulling it. Swapping I8
    for an angled reference is the first thing to try.
  - **Busy rooms:** foliage- and texture-heavy rooms (I4, I9, I12) still come out busier
    than the references.
  - **Condensed vs raw:** the check of condensed words against the raw fiction
    (`rawVisual`) was not run.
  - **Depth control:** a depth-map structure lock (the next thing to try if button
    placement turns out too loose) was not tried.

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

1. **Whether `stock.ts` should produce groups that large at level 1** — a
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
`restRoll(rng, conBonus)` in `rolls.ts` — there is no heal kind today. The heal is
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
- **Stored as `RunState.takes`**, set in `gameplay/state/store.ts` beside `pendingRoll`, cleared by
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

Both are one cause. `DUNGEON_ENTRANCES` (`blueprint.ts:131`) is the Maze Rats
table — *Beaver dam, Living tattoo, Giant book, Under the bed, Maze potion, Unfolded map*.
It is rolled in **stocking** (`stock.ts:897`), which is branch B of the
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
from the entrance (`stock.ts:426`), and in R2 it did: the entrance is the
Bookyard, the goal room is The Vault, the goal entity is the ledger. The player never got
there.

The defect is that **the goal text names Wendy** — *"Learn what Wendy Wilberforce has
promised…"* — so meeting Wendy reads as arriving at the goal. The goal directive should be
stated in terms of **what is in the goal room**, or the NPC it names has to be the one
standing in it. Today nothing connects the two: the directive is written by the Dungeon
Pass from `bp.inhabitants`, and which room a group's members end up in is stocking's.

---

### Rewards: the keys pass — **BUILT**

The full design is `docs/REWARDS-SPEC.md`; this does not repeat it. **R2 of three**, spec
§6. `src/generation/content/passes/keys-pass.ts`, wired into `finishGeneration` after the seams pass,
so the single-process pipeline and the server's `/finish` both get it.

What it does:

- **Writes the placed keys**, with the key and its challenge's finished `base` both in
  front of it, and may rewrite a blocked way's `conditional` so lock and key name each
  other. `withheldKeyItems` keeps them out of the content pass at both ends — the payload
  omits them and the applier refuses a write to one that comes back anyway, the same way
  the seams pass guards both ends.
- **Mints the objective's keyable properties.** `goal-property` was declared and not
  enumerated at R1 because the goal's form is a chunk's decision; this is the first point
  at which it is known. They go straight to the reserve, as challenges and reserve entries
  with no prose. `EntityPassResult.goalEntityId` is new and is how the pass finds the
  objective — nothing else could tell it from the other entities in that room.

Two things came out of building it that were not in the spec:

- **A withheld key is still POSITIONED, by code.** Withholding it from the writing must
  not withhold it from the drawing, and by the time the keys pass runs the room's ground
  and its `taken` set are spent. So `applyContentPass` rolls a position word from the same
  seeded stream that placed everything else in that room.
- **`applyContentPass` now rebuilds the creature bindings it invalidates.** It throws away
  the placeholder roster the entities pass emitted and mints its own with fresh ids, so
  every `mobileId` binding pointed at a creature that no longer existed. Nothing had
  noticed, because nothing had needed to get from a stocking-level mobile back to an
  entity until a key had to name the creature it was about. `anchorOf` in
  `content/challenges.ts` is the one crossing now, and both this pass and the runtime go
  through it.

**Still open, carried from R1: the placed-key count varies 1 to 9 at size 5**, against the
spec's "roughly four". Structural rather than a bug — step 1 walks the reward-guaranteed
locations rolling loot-or-key at `KEY_SHARE`, and a dungeon with few such locations spends
its general budget in the contested draw, which places no keys. The order spec §4 fixes is
implemented as written; narrowing the spread means changing that order. The dials are all
named constants at the top of `rewards.ts`.

Measured across nine dungeons (seeds 1005 / 4242 / 90210 at sizes 2, 3, 5): challenge
counts land where the spec predicted (~30 at size 5) and money is bounded — a whole size 5
dungeon is ~1500cp against a Knave starting purse of 60–360.

---

### Rewards at runtime — **BUILT**

**R3 of three**, spec §7–8. `src/gameplay/mechanics/challenges.ts` holds the state and the rules;
`src/gameplay/tally/tally-pass.ts` holds the end-of-run call.

- **The draw.** `offerDraws` puts a trimmed list — nearest first, capped at eight — under
  *What this dungeon still has to give*, every turn. `commit.draw` spends one; the applier
  refuses an id that is not in the reserve, one already spent, and one whose challenge is
  already resolved. `entityRef` ties a drawn object to an entity a `children[]` diff in the
  same commit created.
- **The resolution write.** `commit.learned` names challenges whose fact the player now
  knows, and `recordFact` writes it into `state` **on the thing it is true of, in the
  dungeon's own words** rather than the referee's. It FANS OUT to every entity the
  challenge anchors to — the spec named that as the fix if the single-entity version bit,
  and it costs one loop.
- **`mapped`.** A region challenge carries `roomIds`, and drawing it puts them on the
  chart. `MapRoomView.mapped` is display only: `known` stays false, `travel.ts` is
  untouched, `shortestPath` still refuses them, and fog stays exactly one thing. Drawn
  hollow and dashed, from `base` — what the chart recorded, not what is there now — and
  `roomVerb` offers *Recall?* rather than a *Go To?* the game would turn away.
- **The ledger.** First-class run state, never in a prompt. Written by code:
  `resolutionsFrom` reads what a commit DID — `creature-slain`, a `conditional` gone, an
  `isHidden` gone, `resolved` set, `goalMet` latched — rather than asking anyone's opinion.
  `noteDamage` charges hit points lost to what was in the room, which is the tally's
  sharpest evidence and the one thing a turn produces without being asked.
- **The tally.** One call at the end, rating each accomplishment `low` / `moderate` /
  `high` **in words, with no numbers in the response**; `XP_FOR_RISK` prices them 50 /
  100 / 200 in code. **Neither a death nor an abandonment tallies** — `shouldTally`
  refuses both and `session.abandon` makes no call at all. Abandoning briefly did, on the
  reasoning that walking away is still ending it alive; the end-of-run screen settled it
  the other way, because nothing came back up and there is nothing to pay for.
- **The allowance.** `commit.coinGrant` says the player found money; `grantCoin` rolls how
  much from the 10% held out of the pot, seeded on the run seed and the turn. When it runs
  out the answer is no.

**Bypass is the one inference, and it is two timestamps compared once at the end.** A
creature met before some later accomplishment was got past somehow; the game does not care
which way, and all of them are worth the same. One met after the last accomplishment was
fled, and is correctly not credited. Nothing detects it per turn.

**Levelling is built** — see below. The arithmetic that was the open question is
unchanged and now deliberate: ~30 challenges at size 5, mostly moderate, is roughly 3000
XP against a 1000-per-level track, so a full size 5 delve pays for about three levels and
they are taken one at a time. Neither the track nor the rating moved; if either should,
`XP_PER_LEVEL` in `tally-pass.ts` is still the one number.

---

### The end of the run — **BUILT**

`src/ui/play/EndOfRun.tsx`, over the whole page, up on its own when the run ends and
dismissable back to the map and the scrollback; `RunOver` in the input area brings it back.
Four endings, and it has to be right about something different in each.

- **What they carried out**, from `lootOf` in `src/gameplay/mechanics/loot.ts`. `newRun` snapshots the
  inventory ids and the purse at turn zero and the take is the diff — a thing they went
  down with is never reported as treasure. Money is not a line: the purse is one item whose
  amount moves, so coin is a delta and everything else is a list. A run saved before the
  snapshot falls back to matching ids against the generated dungeon's items.
- **Whether they keep it.** `keepsWhatTheyFound` — walking out alive, `goal_met` and
  `escaped` both. The list is shown either way, because being shown the thing you lost is a
  better ending than being told you lost something; only the verdict on it changes.
- **What killed them**, from `causeOfDeath`, derived rather than written when it happened:
  the room, the turn, and the target of the last roll thrown. **`killer` and `present` are
  two different claims** — nothing marks a creature hostile, so what was standing in the
  room is not an accusation and is a separate sentence.
- **What it was worth**, from `run.tally`. The two unscored endings say why rather than
  showing a blank, and a survivor whose call has not come back yet says it is still being
  reckoned up rather than looking finished.

**XP now lands on the sheet.** `PlayerCharacter.xp` accumulates; `carriedOut` adds the
run's award in the same transaction as the ending, so it is paid on exactly the two
endings that write a sheet at all. The roster row shows the total, and `pendingLevels`
turns it into a badge and a button. **The reckoning says when a level is waiting** rather
than only how far off the next one is — `levelsOwed` against the level they ended the run
at, so an unclaimed level from three runs ago is still reported.

**The `escaped` copy was wrong and is fixed.** It read *"with your life and nothing else"*,
which was untrue twice over — they keep the whole pack, and cutting your losses is a
decision rather than a defeat.

---

### Levelling — **BUILT**

`src/rules/knave/level-up.ts` and `src/ui/characters/LevelUp.tsx`, reached from a button on the roster
row. Knave's own rule, with one departure and one derivation worth writing down.

- **The track is cumulative and nothing is spent.** `pendingLevels` is
  `floor(xp / XP_PER_LEVEL) + 1 - level`: `xp` is a career total that only ever grows and
  `level` is what has been claimed of it. That is the reading `EndOfRun` has implied since
  the tally landed — it counts down to the next level as `total % XP_PER_LEVEL` — and it
  means a size 5 delve can owe three levels at once, each taken separately.
- **One level per confirm.** `applyLevelUp` returns a sheet one level on; the row offers
  the button again while anything is still owed. Batching would mean rolling 2d8, 3d8 and
  4d8 in one press and calling it a choice.
- **The dice are decided before the button.** `levelUpSeed` derives the seed from the
  character id and the level being taken, so closing the modal and reopening it finds the
  same dice. There is no reroll to argue about and no state to persist — the same problem
  `StepHp` solves by charging a reroll, solved here by the seed not moving.
- **The one departure from the book.** Knave raises the maximum by 1 when the roll comes
  in *less than* the old maximum, which leaves rolling exactly the old maximum as the only
  result that pays nothing. `hpFromRoll` floors at `previousMax + 1`, so the curve is
  monotonic. `CREATION_RULES`' hit point floors are the precedent.
- **The ceiling is `ABILITY_MAX = 10`**, which is Knave's 20/+10 in the units the sheet
  stores. A character with fewer than three abilities under it takes the level and simply
  cannot spend all of it — `requiredRaises` says how many, and the screen says why.
- **Not while they are in a run**, like the shop and for the same reason: the sheet on the
  server is what the run is playing from. The badge beside the name still says it is owed.

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

- **Call log viewer.** `game-master.ts` writes `run.callLog` and nothing renders it.
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

### Paying for strangers

**Blocks opening the app to the public, and blocks [Illustrations](#illustrations).**

**The app is going public, and the author pays.** A portfolio piece has to open on
one click: no invite list, no key to paste. Today the only quota is the Google consent
screen's Testing mode, 100 invited addresses, and nothing limits an account once it is
in. This feature replaces that with a budget the author sets and the app enforces.
It also replaces the old *Rate limiting* note, which was a subset of it.

**What a run costs.** R1, summed from its journal: **94 calls, ~865K input and ~72K
output tokens, ~$1.23** on Haiku 4.5, of which generation is ~$0.04 (layer 4 below
has the split). That figure is **low**: `client.ts` (lines 196 and 285) copies only `input_tokens` and
`output_tokens` out of the response and drops `cache_creation_input_tokens` and
`cache_read_input_tokens`. The journal has never seen a cache write, so a real per-run
figure waits on the ledger below.

Traffic to a portfolio piece is bursty: one post picked up somewhere is a few hundred
strangers in an hour. That is why the total ceiling is the layer that cannot be skipped.
Per-person limits only shape how a burst is shared out.

**Four layers, built in this order:**

**1. The ledger.** One table, written by every paid call, with the dollar cost computed
in code:

```sql
create table public.spend (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  owner_id   uuid references auth.users (id) on delete set null,
  run_id     uuid references public.runs (id) on delete set null,
  dungeon_id uuid references public.dungeons (id) on delete set null,
  task       text not null,          -- the `Task` key, or an image task
  model      text not null,
  units      jsonb not null,         -- tokens in/out/cache-write/cache-read, or images
  usd        numeric(10,6) not null
);
create index spend_at_idx on public.spend (at);
create index spend_owner_idx on public.spend (owner_id, at);
```

- **`ON DELETE SET NULL` throughout.** Money spent stays spent after the account is
  gone, and the daily total must not drop because somebody deleted their characters.
- **Prices live beside the model strings**, as `PRICES` in `src/llm/models.ts`.
  A price is a fact about a model string, and that file is the only place the strings
  are. Cache writes are 1.25× input and cache reads 0.1× input.
- **`Usage` gains the two cache fields.** That fixes the undercount above and lets the
  ledger show whether the existing `cache_control` breakpoints are earning anything.
- **Written at the transport, not at the call sites.** Every model call on the server
  goes through the transport `configureAnthropic` sets up in `src/server/app.ts`, so
  that is where the row is written. A paid call that skips the ledger is a bug, and it
  is easiest to prevent where every call already passes through.
  - **The catch:** that transport is module state and does not know whose request it is
    serving. The handler therefore opens a request scope (`AsyncLocalStorage`, holding
    `owner_id` and the run or dungeon id), and the transport reads it. A call made
    outside any scope throws instead of writing an unowned row, so a missing scope
    fails in tests rather than in the bill.
  - The dev CLIs call the API directly with the author's key and are not metered. They
    are not strangers.
  - When this is built, it becomes a §2 contract: **every paid call on the server writes
    the ledger, image calls included.**

**2. The ceiling.** Two limits, both named constants, with values set after a week of
ledger data rather than guessed now:

- **`DAILY_BUDGET_USD` gates starting things**: generating a dungeon, starting a run,
  drawing a plate. Once today's ledger sum passes it, the app stays open for anything
  free (the roster, the shop, the library, finished runs) and says plainly that the
  dungeon is closed until tomorrow (UTC).
- **`HARD_CEILING_USD` gates every call**, turns included. It is set above the budget,
  so a run started just under the line can be finished. Refusing a turn mid-fight is
  far worse than overspending a little; refusing one at the hard ceiling is the
  backstop working.
- **The providers enforce a third limit.** Prepaid credit with auto-reload off on the
  Anthropic workspace and on the image provider, plus the Anthropic workspace spend
  limit. If the app's own accounting has a bug, the most it can lose is what is loaded.
  This is configuration, not code, but it ships with the feature or the feature is not
  done.
- One indexed `sum(usd) … where at >= date_trunc('day', now() at time zone 'utc')` per
  gated request. It needs no cache at this scale.

**3. Identity that costs one click. BUILT, except where marked.**

What landed, and binds what comes next:

- **Allowances are "runs" per UTC day**, in `src/server/allowance.ts`:
  `GUEST_RUNS_PER_DAY = 1`, `MEMBER_RUNS_PER_DAY = 3`. **One run is either** writing a
  dungeon together with the first run into it, **or** a run into a dungeon already
  written (a library copy, or a second run down your own). Counted off `dungeons`
  (`copied_from is null`) and `runs`, no counter table. Abandoned runs count; deleting
  a character refunds nothing.
- **Writing is gated on a run being left** (429 otherwise) and capped at
  `MAX_GENERATED_SIZE = 1` (400). **Guests write**, against the plan below, by the
  author's call until the curated shelf exists. A retry of a failed writing (same
  seed, size, level) reuses the unfinished row instead of counting a second, and
  chunks already saved are not asked for again.
- **`unlimited` is exempt from the count, the generation gate and the size cap.** Set
  by hand: `update profiles set tier = 'unlimited' where id = '<uid>'`.
- `GET /api/allowance` feeds run setup. The gates never trust it.
- **Turnstile is wired but off** until `VITE_TURNSTILE_SITE_KEY` is set *and* captcha
  is on in Supabase. See `src/ui/sign-in/turnstile.ts`.
- **Not built:** the stale-guest sweep and `MAX_TURNS_PER_RUN`.

The original design, kept for the parts still open:

- **Supabase anonymous sign-in** as "Play as a guest". It gives a real `auth.users`
  row, so the `owner_id` rule and RLS still apply. Upgrading with `linkIdentity`
  (Google) keeps the same uid, so a guest who signs in keeps their characters.
- **Turnstile on guest creation**, through Supabase Auth's built-in captcha support. It
  is invisible to almost everyone and stops a script minting guests in bulk.
- **Allowances per account per day**, as named constants. Guests play the curated shelf
  (below) and do not generate. Signed-in accounts may generate. The turn cap per run,
  `MAX_TURNS_PER_RUN`, is set generously above a real run (R1 took 92 calls), so that a
  script cannot play one run forever.
- **Guest accounts are cheap to reset**, so an allowance only slows abuse down. The
  ceiling is what actually limits it. The allowances exist so one person in a burst
  cannot use the whole day's budget.
- **Tier is reworked, not read as it stands.** `profiles.tier` defaults every account to
  `byok` while in fact spending the author's key. The limiter reads `is_anonymous` from
  the token for guest/member, and `tier` becomes `member | unlimited`. `unlimited` is
  the author and anyone they choose, exempt from allowances but not from the ceiling.
  Bring-your-own-key is a later addition for heavy players, not part of this.
- **The Google consent screen leaves Testing mode** for Production. Email and profile
  scopes need only light verification.
- **Stale guests are swept**: anonymous accounts unused for a named number of days are
  deleted. The existing cascades take their characters and runs with them, and `spend`
  keeps its rows.

**4. Make each stranger cheaper. The money is in the turns.**

| Run | Generation | Play | Play share |
|---|---|---|---|
| R1 (size 1, complete) | 2 calls, ~$0.04 | 92 calls, ~$1.19 | 97% |
| R2 (size 2, 8 turns) | 4 calls, ~$0.08 | 27 calls, ~$0.40 | 84% |

Input is about 72% of play's cost: ~9.3K input tokens per call against ~0.7K output.

- **The turn prompt is the lever.**
  - **Cache hit rate first.** A cache read bills at 0.1× input, and the turn loop resends
    a large stable prefix every call, so this is potentially most of the bill. It is
    unmeasured until `Usage` carries the cache fields.
  - **Then the size of what is sent:** the §2.8 context policy, and how many model calls one
    player turn takes.
  - These are the only items in this feature that lower the cost of the median visitor
    rather than capping the worst one.
- **A curated shelf of finished dungeons** is what a guest plays. **Not for the token
  saving, which is small:** generation is 3–15% of a run. It is worth having anyway:
  - **The plates are the real money**, roughly 10 rooms at $0.014–0.075 each, which is
    5–20× a dungeon's generation cost. Drawn once ahead of time, a guest never pays for
    them.
  - **The first click plays immediately.** Generation takes about a minute, which is
    friction the "nearly frictionless" goal cannot afford.
  - **The author has seen the dungeon.** A stranger's first impression is a world known
    to be good, not a fresh roll that might be the one with three locks on a grate.
- **Decide: copy or share.** Playing someone else's world today means
  `duplicateDungeon`, a copy of a ~0.5 MB row, which at guest volume fills the 500 MB
  tier in about a thousand plays. **Recommended: curated dungeons are shared, not
  copied.** A `curated` flag lets a run reference a dungeon its owner does not own.
  That is one exception in `mustGetDungeon` and one in `dungeons_owner` RLS, and it is
  safe because `base` never changes at runtime (§2.4), so a shared dungeon cannot be
  altered by playing it.
**Builds on** [Dungeons as a generation cache](#dungeons-as-a-generation-cache). A
guest's shelf and a member's cache hit are the same idea: a world somebody already
built. Like the shelf, that cache is worth more for latency and plates than for tokens.

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

### Phones — **PLAY SCREEN BUILT; Characters and Character creation next**

Mobile used to be a non-goal (§5). It no longer is. The layout is Claude Design's mobile
handoff (`design_handoff_mobile_responsive/README.md`, kept outside the repo). It covers
three screens, and they are three sessions:

1. **Play — built.** `PhonePlay.tsx` is the shell: Map / Chat / Character tabs under 640px
   (`PHONE` in `src/ui/shared/media.ts`), with the desktop and tablet grids unchanged. Beyond the
   handoff, at the author's request:
   - a sideways swipe anywhere moves one tab, with no wrap. Swipes that start on the map
     box (`data-no-swipe`) or in a field don't count.
   - the open tab grows (`flex-grow` 1 → 1.8, 280ms) and pushes the others aside.
   - the Chat label always wears `STAGE_TONE[stage].label`, runs the `sweep` bar while
     `busy`, and carries a torch dot when narration has landed since Chat was last open.
     The handoff's dot for `WANTS_YOU` stages was dropped, since the colour already says it.

   Tap-to-inspect (`InspectSheet`, `HoverState.selection`) is chosen by `TOUCH`, not width,
   so a landscape tablet gets the grid with the sheet. **Not yet checked on a real phone.**
2. **Characters** (`Characters.tsx`): stacked rows, More/Less, the account panel. Handoff §2.
3. **Character creation** (`src/ui/create/*`): step strip, sticky footer, Equipment
   sub-tabs. Handoff §3.

*Markers answer a click* is probably fixed by the same change: `DungeonMap` no longer
captures the pointer until a press has moved `TAP_SLOP` (6px), so a click reaches the
marker. The jsdom test goes through the map's own handlers, but nobody has clicked a
marker in a real browser yet.

What follows is the plan as written before the handoff arrived, kept for the record.

**What there is today.** A viewport meta in `index.html`. One play-screen breakpoint at
`max-[1200px]` (`PlayScreen.tsx:176`), which goes from three columns (320px | narration |
300px) to two (narration | 296px). At 390px wide that leaves the narration about 90px.
The menu screens use `max-w-[…]` and mostly shrink fine. The map pans by touch
(`DungeonMap.tsx`: pointer events, `setPointerCapture`, `touch-none`).

**What breaks on a phone, in order of how much it matters:**

1. **The play screen has no single-column layout.** Map, room card, narration, input and
   character panel all have to fit in about 390×700, with the soft keyboard taking
   roughly 40% of that while the player types.
2. **Hover-only information.** `ThingTooltip` in `hover.tsx` opens on hover, and touch
   has none. The `ActionPill` opens on click (`openOnClick`), but a tap may raise both
   the card and the pill, or only one. Find out on a real device; jsdom can't tell us.
3. **Height.** `h-screen` is `100vh`, which on iOS and Android sits behind the address
   bar and the keyboard. The input row at the bottom is the one thing that must never be
   hidden. Needs `dvh` (or `visualViewport`) plus `env(safe-area-inset-*)`.
4. **Sending a turn.** Enter only (`InputArea.tsx`, the `onKeyDown` handler). There is no
   send button. Some Android keyboards report Enter as `key === "Unidentified"`
   (keyCode 229), and a phone player expects a button anyway. `box.current?.focus()`
   whenever input opens will raise the keyboard every turn, which may or may not be
   wanted.
5. **Map zoom is wheel-only** (`onWheel`). Needs pinch: two pointers, distance ratio
   feeding the same `k` clamp of 1–6, aimed at the midpoint the way the wheel aims at
   the cursor. Pointer capture has to stay per pointer, or the second finger is lost.
6. **Fixed columns in menus.** `StepEquipment.tsx:118` and `Shop.tsx:410`
   (`grid-cols-[minmax(0,1fr)_300px]`), `StepTraits.tsx:53` (`110px_1fr_auto`), and
   `LoadingScreen.tsx:37` (`w-[380px]`, a width, not a max-width).
7. **Tap targets and type.** 107 uses of `text-[9–11px]`, and buttons like the pill
   (`py-1.5`) are well under 44px tall. A design question, not a find-and-replace.

**What the design pass has to answer.** These go into the Claude Design prompt
(`docs/DESIGN-BRIEF.md`):

- The play screen at 390×844, with and without the keyboard up. What is visible while
  typing, and how the player gets to the map, room card and character sheet. Tabs, a
  bottom sheet and a drawer are all possible; the brief's "never more than a glance away"
  for HP and conditions has to survive whichever it is.
- What a tap on a map marker or room-card row does now that a hover can't happen.
  Card, then pill on a second tap? Card with the pill inside it?
- Where a roll's dice and the "Roll" button sit when the keyboard is down.
- The end-of-run dialog, the shop, and character creation at phone width.
- Whether the tablet layout (`max-[1200px]`) changes too or stays as it is.

**Build, once the design lands.** One session, in this order, each step its own commit:

1. **Viewport plumbing.** `h-screen` → `h-dvh` on the play screen, and safe-area padding
   on the input row. On its own this fixes nothing visible on desktop, which is how to
   tell it is safe.
2. **The phone play layout** behind a new breakpoint below the tablet one. The desktop
   and tablet grids stay byte-identical; `PlayScreen` keeps one component tree and only
   regroups it, so `HoverProvider` still wraps everything and map and card still agree.
3. **Tap behaviour for `hover.tsx`**, as the design specifies it. Branch on
   `matchMedia("(hover: none)")`, not on width: a narrow desktop window still has a
   mouse.
4. **A send button** in `InputArea`, shown on every width or only on `(hover: none)`,
   per design.
5. **Pinch zoom** in `DungeonMap.tsx`. Test it through the map's own pointer handlers,
   the lesson of *Markers answer a click*.
6. **The menu screens'** fixed columns collapse below the phone breakpoint.

**Verifying it.** Tests can't say whether this works; jsdom has no layout. Done means:
the existing suite still passes; a run played to the end on a real phone (iOS Safari and
Android Chrome) without zooming the page, losing the input under the keyboard, or needing
a hover; and desktop screenshots at 1440 and 1100 unchanged against the ones handed to
Design.

---

## 4. Accepted gaps

Known, deliberate, and not currently anybody's feature. Revisit if the symptom starts
mattering.

1. **Relief is not applied.** Outside MVP. The axis and its carving code still exist in
   `floorplan.ts` and are still tested; nothing calls them.
2. **The family axis is unused**, so no round, cross or T-shaped rooms. Revisit if the
   drawings read as monotonous.
3. **Large rooms are unreachable.** Zones average 20–40 cells. Accepted: size feeds only
   the identity roll, and the bands that matter for that are reachable.
4. **Proportion cannot lengthen a room whose doors cluster**, because the skeleton runs
   between the doors. "A banquet hall is long" is not honoured.
5. **Target areas are a placeholder roll** (`[6, 9, 14, 20, 28, 40, 56]`) rather than
   derived from the size classes.
6. **Corridors are only mildly narrower than chambers.**
7. **`floorplan.ts` is parked, not deleted** — author's call, kept as the record of
   a design that lost. `generateFloorplanValid`, `floorplanSvg` and `validateFloorplan`
   have no callers outside `floorplan.test.ts`, and the four suites exercising the packer
   are `describe.skip`. **Two suites stay live and must:** `corridor designation` covers
   stocking, and `chamber archetypes` covers the vocabulary in `room-size.ts` that
   the identity roll reads through `sizeAllows`.
8. **A multi-cell fixture draws as several separate things.** One berthed entity across two
   cells, drawn one mark per cell so a colonnade reads as a row. Weighed and dropped: it
   needs a per-kind spread/no-spread decision that was not worth the session.

---

## 5. Non-goals

No multiplayer, no party (one PC). No between-dungeon persistence beyond saved
characters. No light or ration clocks yet, though `turnCount` exists for them. (Mobile
was a non-goal; it is now *Phones* in §3.)

**And no retrofitting.** A dungeon generated by an earlier build is disposable: this is
still development, there is no installed base, and a fix that applies from the next
generation onward is a finished fix. Nothing here gets a migration path, a back-compat
branch, or a caveat explaining what old saves keep. This is **not** licence to drop a field
a *current* generation run can legitimately leave unset — `blockplan` is null whenever the
plan does not draw (§2.10), which is a live supported case and not legacy data.
