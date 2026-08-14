# Dungeon Crawler — Coding Plan

Forward-looking. Everything through Phase 6 is built; this document no longer
describes it except where a decision made back then still binds code not yet written.

**The history is in git, not deleted.** The last revision carrying the full Part 0
findings (B1–B3, D1–D6, G1–G5, S1–S7), Part 1, and the Phase 0–6 specs and session
outcomes is `5feed17`. Read it there when you need to know *why* something is the way
it is and §2 below does not say.

---

## 1. Where things stand

| Phase | State |
|---|---|
| 0 Scaffold | ✅ built |
| 1 Headless generation | ✅ built, runs live — the §1.1 defect is fixed |
| 2 State and rules | ✅ built |
| 2.5 UI shell | ✅ built |
| 3 Turn loop against a stub | ✅ built (`__fixtures__/stub-referee.ts`, `offline.ts`) |
| 4 Real model | ✅ built — a full run completed 2026-08-10 |
| 4.5 The way in | ✅ built (`Characters.tsx`, `RunSetup.tsx`); the creation door opened with Phase 5 |
| 5 Character creation | ✅ built — §3 |
| 6 Maps | ✅ built (6a → 6c.4), with the carried gaps in §1.2 |
| 7 Dev affordances | ⚠️ **partial** — §4 |
| 8 Playtest refinements | ⚠️ **started** — 8a is done bar A7 and A9, the 8b hover items, the click-verb pill and four of the 8b interface fixes are built, 8f's capitalisation has landed, and the exit-count item is closed bar its step-file line; §5 is the rest, and the bulk of the remaining work |
| 9 The seam | ✅ built — §6. First of the server migration, and it contains no server |

553 tests, two vitest projects, build clean as of `5feed17`. 593 and still clean after the
8b hover work; 630 and still clean after the click-verb pill; 640 and still clean after
A8, the room-card exits, the growing input box and 8f's capitalisation; 662 and still
clean after the §1.1 completeness check and the concealed-exit fix; 730 after Phase 5;
**750 and still clean after the hit point floors, the weapon classes and the swap undo**;
**787 after Phase 9**, which added the session, the two-runs-at-once check, a mounted-app
test and a per-file purity sweep over the runtime.

### 1.1 The live defect carried out of generation ✅ **FIXED**

**A chunk response that omits a ref is not a schema error.** Found on the 6c.4 live run
(`--seed 4201 --size 3`): three of ~90 written things came back unwritten, and the
telling one was a connector between two rooms *in the same chunk* — so not a seam, and
the seams pass was never going to catch it. The chunk simply left it out of an
otherwise well-formed response.

The retry policy is "on zod failure, retry that chunk once". A response answering with
five of six connectors is valid JSON against a valid schema. It passed, and nothing
noticed until `validateWritten` swept at the end, by which point the pass was over and
there was no retry left to take. A **Phase 1 exit-criterion failure** — "no empty `base`
on any room, connector, creature, feature, item, or hazard".

**Shipped as the cheap fix specified here**, in three pieces:

- `contentPassOmissions(payload, res)` in `dungeon-content-pass.ts` — pure, engine-side,
  and the only thing that can ask the question, because only the payload knows what was
  asked for and the schema never sees the payload. It reports missing rooms, entities,
  owned connectors, encounters, an encounter's mass, a distinct specimen (matched on
  `kind` **and** `member`, the same join apply makes for keywords), and a goal room that
  wrote no goal. `seamsPassOmissions` is the same question for the seams pass, which
  already computed `missing` — but *after* applying, when the call was spent.
- `JsonCallOptions.check` in `llm/client.ts`, run after zod and raising a
  `ResponseFormatError`, so an omission is treated as exactly what it is: a schema-shaped
  failure taking the retry that already existed, with the missing refs in the feedback.
- **Deliberately not checked**: fixtures, promoted details, and the seam connectors
  carried as context — the model chose those, so there is nothing it can have left out.
  HARD RULE 1 tells it not to return a seam at all.

`Omission` is structurally a `ValidationIssue` without the engine importing the runtime;
`OmissionIsAnIssue` in `schemas.ts` is the drift guard, beside the other three.

### 1.2 Gaps carried forward from Phase 6, all deliberate

1. **Size 5 block plans fail about one attempt in eight**, with ~0.5 crossings
   surviving the untangle hill-climb. Handled by throwing the graph away and generating
   another, up to 8 (`GRAPH_ATTEMPTS`), which puts the failure rate near one seed in ten
   million. The retry seed is derived (`<graphSeed>~<n>`) so a seed still names one
   dungeon. **TODO, cheapest first:** flip a whole branch across a crossing rather than
   swapping two rooms; allow occasional worsening steps; stop the spring pass
   reintroducing crossings; bail before routing when untangling did not reach zero. The
   proper answer is to derive positions from the planar embedding rather than
   hill-climbing toward it — then the retry loop runs once, always.
2. **Relief is not applied.** Outside MVP. The axis and its carving code still exist in
   `dungeon-floorplan.ts` and are still tested; nothing calls them.
3. **The family axis is unused**, so no round, cross or T-shaped rooms. Revisit if the
   drawings read as monotonous.
4. **Large rooms are unreachable.** Zones average 20–40 cells. Accepted: size feeds only
   the identity roll and the bands that matter for that are reachable.
5. **Proportion cannot lengthen a room whose doors cluster**, because the skeleton runs
   between the doors. "A banquet hall is long" is not honoured.
6. **Target areas are a placeholder roll** (`[6, 9, 14, 20, 28, 40, 56]`) rather than
   derived from the size classes.
7. **Corridors are only mildly narrower than chambers.**
8. **`dungeon-floorplan.ts` is parked, not deleted** — author's call, kept as the record
   of a design that lost. The 6a packer, `generateFloorplanValid`, `floorplanSvg` and
   `validateFloorplan` have no callers outside `floorplan.test.ts`, and the four suites
   exercising the packer are `describe.skip`. **Two suites stay live and must:**
   `corridor designation` covers stocking, and `chamber archetypes` covers the
   vocabulary in `dungeon-room-size.ts` that the identity roll reads through
   `sizeAllows`.
9. **The second fog bit.** A corridor walked through but never stood in is *seen, not
   examined*, and should be drawn without having cost a composition call.
   `composed === undefined` is still the only fog signal.
10. **The blank area beyond the surface exit**, standing for the outside. The dashed
    stub is drawn; the space around it is not designed.
11. **Room labels drawn in the polygons.** The name is on the hover only. (Also 8b.)
12. **Creature markers do not exist on the map**, and with them the "last seen here"
    position snapshot: an entity that moves while the player is elsewhere currently
    loses its marker rather than staying where it was last seen. Right for every path
    that exists today — all of them happen with the player watching — and wrong for a
    thief carrying something off. The snapshot arrives with creature markers, not
    before: a field nothing reads correctly is worse than a documented gap.
13. ~~**The empty-character-stock state is unreachable**~~ ✅ **CLOSED by Phase 5.**
    Deleting the last character reaches it, and it is designed rather than merely
    survived — an invitation to roll one up, with the door beside it. See §3.

---

## 2. Standing contracts

The rules that still bind code not yet written. Stated flatly, without the reasoning
that produced them — that is in `5feed17` and in the comments at each site.

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
  seams pass at the end, with both rooms in front of it.
- On zod failure, retry that chunk **once** with the validation errors appended. On a
  second failure, throw. No partial content.
- **An answer that is well-formed and incomplete is a failure too.** Every ref the
  payload asked about must come back, checked by `contentPassOmissions` /
  `seamsPassOmissions` through `callForJson`'s `check` before the response is accepted —
  so it costs the same one retry and throws the same way. See §1.1 for what is and is
  not asked for.
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
  of "base went missing" bugs. See §1.1 — it currently reports rather than prevents.

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
  to need a new one it should be a new entity.
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
  rollRequest?: RollSpec;   // present iff nextStage === "roll_offered"
  diffs: Diff[];            // MUST be empty when nextStage is "clarifying" | "rejected"
}
```

`stage` and `step` are separate fields and `turn.ts` is the only thing that writes
either. Both "iff" clauses are **zod refinements**, not shape checks. The diffs-empty
rule is independently enforced by the applier — rejections never mutate.

Rules stated to the referee in `SKILL.md` and enforced in code:

1. **Ids are quoted, never invented** — *and an id names that exact object and nothing
   else*. A thing just discovered is a new entity via `children[]`, even when something
   of the same kind exists elsewhere. (The missing half of this rule caused 8a A3.)
2. **Atomicity and retry.** The batch validates whole and applies whole; one bad diff
   rejects all of them. On rejection the model gets the reasons and retries once.
   **The retry is only productive if the reasons name the way through** — see 8a A2.
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
| `RoomFeature` | `state`, `composed`, `hidden` |
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
- **`isHidden` is refused on anything in the player's inventory.** Concealment is read
  only of things standing in a room, so on a carried thing the write is inert as well as
  incoherent — and it is the one mechanical tell that the referee has reused a sheet id
  for something it has just invented in the room.

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
- Unarmored is defense 11 / bonus +1. Monster HP is HD × 4.

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
  plus every contained entity's current `state`, plus the geometry (§2.10).
- Transcript: the in-progress exchange, **hard-capped at 12 messages**, plus the
  resolution records of the previous **2** completed turns, as structured
  `{ action, target, roll, outcome, diffsApplied }` rather than prose.
- **Entity `state` is the long-term memory. The transcript only carries conversational
  continuity.**
- **A retry is the same turn asked again**, so the rejection block is *prepended to* the
  original task, never substituted for it. `task()` is a preamble and a body, and the
  body is unconditional; a retry prompt is a **superset** of the ask it retries, asserted
  line by line in `assemble.test.ts`.
- **The player's roll reaches the referee through two channels**, `renderRoll` in the
  instruction (authoritative) and a `role: "roll"` entry in the transcript (a record that
  survives however the instruction is built). One channel is how 8a A1 happened.

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
  over `pointLayout`, never a dependency — a run saved before the plan existed comes
  back on the fallback.
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
- Outline thresholds are **0.85 / 0.60** on box-fill, measured over 1,520 chambers
  (median fill 0.67 — the block plan grows rooms out of a skeleton, so a clean rectangle
  is the rare case). **Re-measure before changing either number.**
- **The model picks a fixture kind and a position; code rolls the count and picks the
  cells.** "Pillars" is a decision about the room; "six pillars" would be a number the
  model invented. Caps rather than quotas: tiny 1, small 2, medium/large 3, passage 1.
- **A stored `position` is always true of the cells beside it.** A wall-hugging kind
  asked for the middle of the room is moved to the longest wall and the stored word moves
  with it; a word whose cells were unavailable becomes `throughout` rather than keeping a
  wall the marker is not against. The word is what the prose and the map hover may say, so
  it may never outlive the cells it was chosen for.
- **`throughout` resolves to the room's interior** — cells with floor on all four sides —
  falling through to the whole floor where there is no interior. `spread()` is
  farthest-point sampling, which is what makes a colonnade read as a row and what used to
  put the second mark of "rubble covering the floor" in the furthest corner. Measured over
  72 rooms: the `centre` pool is empty in 16.7% and there is no interior at all in 22.2%,
  so both words still mean what they say four or five times in six.
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
  `generateValid` (~1.2 attempts at size 5). Sizes 1–3 are unaffected. A seed maps to a
  different dungeon at sizes 4–5 than it did before this landed.
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
  bundler registers the hook in `dev/raw-md.ts` first. See §6.5.
- **No module holds one of anything a run owns.** The store, the journal and the turn
  machine are made per run and carried, never imported: `createGameStore`,
  `createJournal`, `createGameSession`. A singleton is correct for exactly one situation
  — a browser tab, with one run in it — and wrong in every process that serves two.
  See §6.
- `src/store/react.ts` is the only module below `src/ui` and `App.tsx` that imports
  React. `store/game.ts` imports `zustand/vanilla`, not `zustand`, because the package's
  own entry point re-exports `zustand/react`.
- **Two vitest projects, split on the file extension.** `.test.ts` is headless,
  `.test.tsx` is jsdom. The extension is the whole of the rule.
  `src/ui/__fixtures__/jsdom-setup.ts` supplies entry points jsdom lacks
  (`setPointerCapture` and friends) and **never fakes behaviour**.
- Persistence is two IndexedDB keys behind a `KeyValueStore` interface with a memory
  implementation for tests and Node: `dungeon:<id>` written once, `run:<id>` per commit.
- Node runs the CLI with native type-stripping, so **constructor parameter properties
  are unsupported** and all relative imports in `src/` carry `.ts`.

**Two testing habits worth keeping**, both learned from tests that lied:

- **A guard clause that skips is a test that lies.** A fixture lookup that returns early
  when it finds nothing asserts nothing and passes.
- **Snapshots must redact UUIDs**, because ids are unseeded and appear in prompts. Run
  the suite twice when adding one.

---

## 3. Phase 5 — Character creation ✅ **BUILT**

Six steps, back-navigable, nothing written until the last button. The two screens
came from the design plan artifact (`fbad10ad`), the rules from the author, and
the numbers from `docs/Knave 1.0.pdf`. Where the artifact and the author's rules
disagreed the rules won — the artifact's abilities step still says three dice and
reroll-all-or-none, and its point-buy panel still says nine points and nothing
above +3.

### 3.1 The two modes

Normal is the generous read and hardcore is close to the book. `CREATION_RULES`
in `character-creation.ts` is the whole of the difference, and nothing else in
the flow branches on the mode:

| | normal | hardcore | Knave 1.0 as printed |
|---|---|---|---|
| ability dice | 2d6, keep lowest | 3d6, keep lowest | 3d6, keep lowest |
| swaps | 2 | 1 | 1 |
| point buy | 10 points | 7 points | — not in the book |
| rerolls | 3 | 0 | — not in the book |
| hit points | 2d8, floor 9 | 1d8, floor 5 | d8, no floor |

**The hit point floors are the sharpest departure from the book**, and the reason is the
one Knave's own note gives when it suggests letting a PC reroll below 5: a level 1
character on 1 HP is not a hard start, it is a character who does not get to play. Normal
takes two dice and floors at 9; hardcore keeps the single die and floors at 5. `rollHp`
returns the dice, the raw total and a `floored` flag, so the screen can say *the rule
caught you* rather than print a number the dice never showed.

**A swap can be given back.** Undo refunds it rather than costing a second, because trying
an arrangement out and disliking it is not a decision worth charging for — only keeping one
is. `swapAbilities` is its own inverse, so the history is the pairs and not copies of the
spread. **A reroll clears the history and hands every swap back**: new dice land on the
cards, and the pairs an undo would restore no longer hold what they held.

**Mode is step 0, and changing it starts the character again.** It rewrites four
numbers across three later steps, so a control that quietly did that from a
header would be worse than a screen. The reset is not tidiness: a switch that
kept the sheet would let a player roll hit points under normal, bank the 8, and
arrive as a hardcore character who never spent a reroll. `mode` is stored on
`PlayerCharacter` and joins the never-writable list in `diffs/paths.ts`.

**Point buy.** Every ability starts at +1 and raising one to *v* costs
`floor(v / 2)` — so +2 and +3 are a point each and +4 is two more. A single
ability caps at **+4** at level 1. Rolling may exceed that and is allowed to;
the cap is on what a player may *choose*, not on what the dice may give.

### 3.2 One reroll budget, spent from three screens

Abilities, hit points and starting gear all draw on it. **Traits do not** — they
are flavour, and a player fishing for a face they believe in is not taking
anything from the game. **Hit points do**, because an unlimited d8 is an 8.

Every reroll costs exactly one, including reroll-all: one ability or all six, one
gear table or all six, the same price. Both are deliberate — the budget is about
how many times you may change your mind, not how much you change at once.

The counter lives in the create header, not on the step, because it is one budget
spent from three places and the player has to see it before spending. At zero, and
for every hardcore character, the buttons are plainly disabled — the same *not
yet* treatment the brief demanded of the creation door, and never a padlock.
Hardcore is not a special case anywhere: it starts at 0 and hits the same
`rerollsLeft <= 0` a normal character hits on their fourth press.

### 3.3 The tables

`src/engine/knave-tables.ts`, transcribed from the PDF. Tables and stat lines
only, no dice — so a transcription error is a diff in a file with no behaviour.

**The Maze Rats tables were checked first, as this section used to instruct, and
they do not overlap.** Those are 36-entry NPC tables on different axes;
`MISFORTUNES` (36) against Knave's Misfortunes (20), `CLOTHING` (36) against
Knave's Clothing (20), `BACKGROUNDS` = `UNDERWORLD_NPCS` (36) against Knave's
Background (20), and no counterpart at all for physique, face, skin, hair,
virtue, vice, speech or alignment. Reusing one would have changed both the
entries and the distribution. The finding is in the file header so the question
is not reopened.

**Two tables are house-ruled**, written out per face rather than as bands so the
divergence is visible rather than arithmetic:

| | printed | ours |
|---|---|---|
| Armor (d20) | 1-3 none · 4-14 Gambeson · 15-19 Brigandine · 20 Chain | **1-5 none + 1 random spellbook** · **6-14** Gambeson · 15-19 Brigandine · 20 Chain |
| Helmets & Shields (d20) | 1-13 none · 14-16 Helmet · 17-19 Shield · 20 both | **1-5 1 random spellbook** · **6-11** Helmet · **12-19** Shield · 20 both |

The armor trade is the one the book itself suggests a line above the table —
*"allow new PCs to roll a random spell in exchange for not starting with any
armor"*. The hundred level-less spells are transcribed with it, feeding the
`spellBook` field that has been on `IItem` since Phase 0. Spell **90 is printed
as Summon Idol**, out of the alphabetical run the rest of the list keeps;
preserved as printed, like the duplicate "Tinker" in `dungeon-blueprint.ts`.

Armor and weapon stat lines come off the Item Costs page. Note the d10 class is
**quality 3**; the table this section used to carry said 2, and the PDF wins.

**Weapons are a class and then a name, and only the class is mechanical.**
`WEAPON_CLASSES` carries the six the book prices — Light d6, Medium d8, Heavy
d10, Sling d4, Bow d6, Crossbow d8 — and every name inside a class has that
class's damage, hands, slots, quality and cost. So the picker asks for the class
first and treats the name as fiction laid on top; the three ranged classes are
their own single weapon and skip the second question rather than asking it with
one answer. `WEAPONS` is the flattening, and `weaponsIn` is what builds it.

### 3.4 Starting gear

Two days of rations and one weapon of the player's choice, free, on both paths.

**Rolled:** one roll each on Armor, Helmets & Shields, General Gear 1 and General
Gear 2, and **two** on Dungeoneering Gear. A `GearSlot` is one die and a
`GearGroup` is what it produced — a list, because 20 on Helmets & Shields is a
helmet *and* a shield. That shape is what makes a per-table reroll possible.

**Bought:** 3d6 × 20 copper and no gear rolls, carried as a `Copper` item costing
0 slots. **The shop is a later session**; until it exists, buying is thinner than
rolling and is meant to read as a real choice rather than a free one.

**A shield beside a two-hander stays carried rather than worn.** `canEquip`
refuses that pair, and a character who arrived failing `validateEquipment` would
have the applier complaining on the first commit of the run.

**Capacity is not enforced at creation.** A rolled kit may exceed CON defense;
`isOverburdened` reports it and the meter shows it in torchlight past the rule.
Refusing would mean silently dropping something the dice gave.

### 3.5 What the screens do

`src/ui/create/`, one file per step, all of it on `theme.ts`'s tokens rather than
the artifact's inline hex.

**Rolls carry their dice where the dice are the player's business** — `2d6 → 4 2`
under every ability, `2d8 → 1 7 = 8, raised to 9` under the hit points. A screen
re-deriving those would be inventing numbers. **The gear tables are the
exception**: `GearGroup.d20` is still what the band tests are written against,
but it is not printed, because a table result is not a number the player is being
asked to check the way an ability's d6s are. What matters there is what you are
carrying and what it costs you in slots.

**`CreateCharacter` takes an optional `seed`.** The app omits it, so every visit
is a new person; the tests pin it, because otherwise they assert against whatever
six abilities turned up and the swap tests go quiet on the roughly one run in
nine hundred where all six match. Same affordance as `?seed` on a dungeon, for
the same reason.

**What you review is what is saved.** `preview` is a real `PlayerCharacter` built
by `finishCharacter`, and the save button hands that exact object to the store.
There is no second construction that could disagree with the sheet.

**One RNG for the whole session**, seeded from `randomSeed()` and held in a ref,
so a reroll advances the stream rather than restarting it. Nothing in the flow
calls `Math.random`.

**There is no "you have overspent" guard**, and there should not be: `canRaise`
disables the + that would do it and the − stops at +1, so an illegal spread is
unreachable from the screen. `validatePointBuy` is where that rule is written
down and it is asserted directly in `character-creation.test.ts`. A branch that
can never run would be a lie about what the interface checks.

`Characters.tsx` was rebuilt to the artifact's library screen — name, one
sentence of who they are, the numbers, Send down and Delete. `describePerson` in
`ui/person.ts` is shared with the confirm step, so a player meets the same
description they approved. Deleting asks first, and is what makes the empty state
reachable at last.

### 3.6 Deliberately not in this pass

- **The shop.** Next session. The copper is rolled and carried; nothing spends it.
- **Persistence.** `store/characters.ts` gained `saveCharacter` and
  `deleteCharacter` against the same in-memory array, so **a character does not
  survive a reload**. What the record looks like and what happens to one saved
  against an older shape are their own decision, and making it badly now would be
  harder to undo than making it later.
- **The library card's run-state badges** — the artifact's `IN A RUN`,
  `DIED · ROOM 3`, and the epitaph. Those need per-character run state nothing
  stores, and a badge computed from a field nobody writes is worse than no badge.

---

## 4. Phase 7 — Dev affordances

Partly done. What remains:

- ~~Seed in the URL~~ ✅ `?seed` `?size` `?level` `?offline` `?stub`, read in `App.tsx`;
  any of them bypasses the front page.
- ~~Quick-start PC~~ ✅ the hardcoded test character, and since Phase 5 anyone the
  player rolled up this session. Surviving a reload is still open — §3.6.
- ~~`callLog` written from day one~~ ✅ `referee.ts` writes it; `turn.ts` deliberately
  does not, because it cannot know what model answered.
- **Call log viewer.** ❌ Nothing renders `run.callLog`.
- **Jump-to-room.** ❌ A debug diff that sets `currentRoomId` and fires the room-entry
  pass.
- **Replay.** ❌ Replays the *run*, not the generation: load the persisted
  `GeneratedDungeon`, reset `runSeed`/`rngDraws`, feed `playerInputs` back through
  `turn.ts`. Deterministic because the dice come from the seeded run RNG and the dungeon
  is fixed. **Model responses are not deterministic**, so replay is only exact against
  the stub or a recorded-response cassette — record responses in the call log and add a
  cassette mode. Say this out loud in the code, because "replay" implying determinism
  through a live model would be a misleading affordance.

---

## 5. Phase 8 — Playtest refinements ⚠️ **8a done bar A7 and A9, the rest planned**

This phase is **the author's playtest feedback, sorted by what actually causes each
symptom** — which is not how it was reported, because several unrelated-looking
complaints turn out to be one defect. Nothing here is speculative UX polish; every item
traces to something observed in a real run.

**Two runs are the evidence base.** Where a claim cites a `seq`, that is a line in the
named run's `journal.jsonl`; where it cites a line number, that is the rendered
`transcript.md` beside it.

| Run | What it was |
|---|---|
| **R1** `out/runs/2026-08-10T00-32-05-seed15341/` | 2026-08-10, seed 15341, size 1, level 1 — The Drowned Aviary. **Complete: start to finish, goal met.** Eleven rooms explored, features searched, a spell cast, the objective stolen, and out. Four commits refused in the whole session, three of them one bug wearing two hats. |
| **R2** `out/runs/2026-08-12T01-32-27-seed218356/` | 2026-08-12, seed 218356, size 2, level 1 — The Relish Quarry. **Eight turns, three rooms, abandoned mid-run.** Ran against the 8a fixes and the 8b interface work, so what it found is what those did not cover — and one regression they introduced. Almost all of it is talking: the first playtest that leaned on creatures rather than on locks and levers, and it is why 8e grew. |

Six sessions. **8a stays first in ordering.** A1–A4, A6 and A8 are fixed, A5 is cut, and
A7 and A9 are open.

---

### 8a — The referee cannot finish a turn twice. **DO THIS FIRST.**

The section that named the phase: R1's refusals and R2's ledger are both "the player did a
thing, the machine would not let the referee say so, and they had to do it again".

**Done, and the rules they established are in §2 — that is where to read them now.**

| | The symptom | What shipped |
|---|---|---|
| **A1** | A refused commit threw away the roll | ✅ `task()` in `assemble.ts` is a preamble plus an unconditional body, so a retry carries the roll, the room-entry `owed` list and the "player has acted" framing. The roll also lands in `run.transcript` as a third role. §2.8. |
| **A2** | `inventory[i]` is how the model says "they now have this" | ✅ `inventory[…]` reads its value: null drops, an id moves, an object mints. `takeIntoInventory` is the one door and a pickup is forced. §2.6. |
| **A3** | The referee attached invented things to ids off the character sheet — *the lantern* | ✅ `SKILL.md` rule 3 gained its missing half (an id names one exact object), and `isHidden` on a carried item is refused. **A8 narrowed this guard to what the player was carrying when the turn began** — see below. §2.5, §2.6. |
| **A4** | Re-entering an unchanged room still cost a model call | ✅ The staleness sweep is hoisted into `enterRoom()`; an empty sweep re-shows `room.composed` and spends nothing. Five of R1's eleven arrivals were paid for and discarded. §2.9. |
| **A5** | A multi-cell fixture drew as several separate things | ❌ **Cut, author's call.** One berths entity across two cells, drawn one mark per cell so a colonnade reads as a row. It needed a per-kind spread/no-spread decision that was not worth the session. Weighed and dropped, not missed. |
| **A6** | Debris in a corner | ✅ Not the wall fallback — the sampler. `throughout` now resolves to the room's interior, and a position word that could not be honoured is no longer kept. §2.11. |
| **A8** | A pickup that also reveals refused itself | ✅ `carriedAtStart` on the applier's `Ctx`, taken off the world before the batch runs; the `isHidden` guard asks it rather than the draft. A3's case still refuses. The refusal now names the pickup as the way through. |

Two still open.

#### A7. The layout shifts when the room changes

Reported and not yet reproduced: *"Something changes causing a shift in the DOM layout when
a room change occurs. I can't see what it is."* First job of the session is to reproduce
it, most likely by stepping between two rooms whose cards differ in height. Prime suspects,
in order: the room card growing or losing a section (occupants, ways out) between rooms;
the map re-centring; a scrollbar appearing. Fix by reserving the space rather than by
chasing the specific element.

#### A8. A pickup that also reveals refuses itself. ✅ **FIXED**

*"I had to pick up a ledger twice."* Three times, in fact, and the applier did it.

**Shipped as specified below.** `Ctx.carriedAtStart` is a set of inventory ids taken off
the world before the first diff runs, and the `isHidden` guard reads it instead of
`ctx.world.pc.inventory`. The refusal now says *"was already in the player's inventory when
this turn began"* and states the allowed pair. `apply.test.ts` carries the R2 commit in both
orderings, A3's commit still refused, and an assertion on the wording. **A9 is what is left
of the ledger — the refused commit is fixed, the doubled post is not.** The reasoning:

R2, the Bookyard. The player reads a ledger found on the library shelves; the referee mints
it correctly with `children[]` on the Rebel Library feature. The player says **"Keep the
ledger"**, and the referee commits the obvious pair:

```
{ entityId: <ledger>, path: "parentId",  value: "player" }
{ entityId: <ledger>, path: "isHidden",  value: false    }
```

`apply.ts:237` refuses the second one: *"unmarked ledger is in the player's inventory, so
it cannot be hidden or revealed."* **It is in the player's inventory because the diff
immediately above it put it there.** The guard reads `ctx.world.pc.inventory` — and
`ctx.world` is the `structuredClone` the batch is being applied to, so it sees the state
the *earlier diff in the same commit* produced. A3's guard was written against a commit
where the item was already carried when the batch began, and it cannot tell that case from
this one.

Atomicity then does exactly what it is for and takes the pickup down with the reveal. The
retry reads its own refusal as *"the ledger is already in their inventory"* — which the
refusal does literally say — concludes there is nothing to do, and narrates the pickup
twice without committing anything (transcript.md:504 and :508 — see A9). On the third
attempt the player typed *"Add the ledger to my inventory"* to get what they had already
asked for twice.

**The fix is to ask the right question.** The guard means *was this already the player's
before this turn touched it* — so it must test the **starting** state, not the draft:
snapshot the inventory ids at the top of `applyDiffs` and test against that. A3's real
case (revealing the lantern the player walked in carrying) still refuses; a pickup that
reveals in the same breath goes through. Tests: the R2 commit verbatim, both orderings of
the pair, and A3's seq 454 commit still refused.

**And the refusal must name the way through**, per A2's second half — this one told the
referee it was holding something it was in the act of picking up, which is what sent the
retry off. `parentId` to the player and `isHidden: false` in one commit is a pickup; say
so.

#### A9. Superseded drafts are published as narration

*"A dialogue line got mangled, repeating the first paragraph but then veering off into
requiring a roll."*

R2 seq 147, and again at the ledger (transcript.md:504/:508). The player reads one post
that says the thing twice — the second time in a different tense, ending in a roll offer.

The referee wrote a draft, thought better of it mid-response, and wrote another. Its own
trace says so out loud: *"Wait—I should not write that post yet. I need to present the roll
offer first… Let me rewrite."* **Both drafts reached the player**, because narration is the
concatenation of every text block in the response and nothing distinguishes a draft from
the post. No streaming rule catches this — the buffer is complete and valid, it is just
two answers stapled together.

Two candidate fixes and they are not exclusive:

1. **Take the prose off the loose text channel.** Narration becomes a field of the commit,
   the way `diffs` and `rollRequest` already are. Then a draft is not narration by
   construction, the "commit validates before the player reads anything" rule gets a
   second guarantee, and there is exactly one place the post can come from. This is the
   real fix and it touches `referee.ts`, the commit schema, and every step file's closing
   instruction.
2. **Until then, the last block wins.** A response whose text blocks are separated by the
   model's own restart is a model that rewrote; the last complete one is the one it meant.
   Cheap, and wrong the moment a referee legitimately writes prose in two blocks.

Prefer 1. Note that the confirmation-post instruction in `steps/3-standard.md` is what the
model was confused about — it read the post as narration of the attempt, wrote it, then
found the instruction that says a confirmation post states terms. **That wording has since
been fixed under 8c** — the post now stops at the moment of attempt, said once at the head
of the section — **which reduces how often this fires and does not fix it**; a referee is
allowed to change its mind mid-response and the player should never see it happen.

---

### 8b — The interface

All of this is the author's list, and it holds together as one session because most of it
is the same idea: **the things named in the prose should be inspectable, and the map and
the text should agree about where they are.**

**Built** (2026-08-10 and 2026-08-11, `react-tooltip@6.0.8`). What the pieces share is one
module, `src/ui/play/hover.tsx`: the context holding what the cursor is on, the `useAnchor`
factory that makes an element hoverable, and the one card both panels raise. An anchor
carries its own content in `data-hover-*` and `data-verb-*` attributes, so neither panel
has to know what the other is drawing, and each renders alone in a test.

- ✅ **Tooltips out of their parent**, `portalRoot={document.body}`. Two mounts, one
  renderer: the map's follows the cursor, the card's anchors to the row. A card shows
  about one paragraph (`oneParagraph`, 320 chars) — measured against five recorded runs,
  where a room's `composed` runs to a median of 947 characters and a thing's to 235.
- ✅ **The room card rows get the same tooltip**, contents and exits both, from the same
  `RoomView` fields the map reads. An exit's hover is the wall it cuts — the phrase the
  referee was handed, so a player checking a position claim reads the map's own answer.
- ✅ **Hover on either highlights the other**, keyed on the entity or connector id. A
  creature row lights nothing yet, because creature markers do not exist (§1.2.12).
- ✅ **A click offers one thing to do** — a pill raised above the thing, answered by
  sending a sentence through the ordinary turn path. It replaced the planned quick-action
  dropdown, which collapsed on inspection: outside examining, what is worth doing to a
  thing depends on what it specifically **is**, not on its type.

  | clicked | condition | pill |
  |---|---|---|
  | room | `known && !current` | Go To? |
  | room | `current` | Examine? (look around) |
  | way | `surface`, reachable, open | Leave the Dungeon? |
  | way | reachable, open, `toUnknown` | Go Through? |
  | anything else | | Examine? |

  `verbs.ts` is the table and the sentences, with no React in it. **Go Through is
  deliberately narrow** — a way with both ends known is two clicks for one move, so the
  room is the clearer target and the door stops offering it; a way out of the dungeon is
  the extreme case and the one override. **Two `TravelConfirm` decisions are reversed
  knowingly**: the pill sends on the press rather than previewing the sentence (it is on
  the button as `data-sends`), and a blocked way offers Examine rather than spending a turn
  to be told what the room card already says. `acting` and `reachable` live on the hover
  context, not as props: whether a thing can be acted on is a fact about the game, not
  about the panel drawing it.

**The rest, and R2 added the first three.**

- 🔴 **Map markers are not clickable.** *"Icons in rooms are not clickable. They should
  create the quick action button for that entity type."* They are supposed to: `Fixture`
  in `DungeonMap.tsx:107` spreads `anchor(f.id, …, thingVerb(f.name))`, so every marker
  carries `data-verb` and `data-verb-text` exactly as a room path and a door do. So this
  is a **behaviour that contradicts the code and must be reproduced before it is fixed.**
  Prime suspect, and it explains why the tests pass: `onPointerDown` on the `<svg>` calls
  `setPointerCapture` for the pan drag (`DungeonMap.tsx:229`), and while a pointer is
  captured the browser dispatches the subsequent `click` to the **capturing element**, not
  to the marker under the cursor — so `react-tooltip`'s `anchorSelect="[data-verb]"` never
  sees it. `hover.test.tsx` fires `click` on the element directly and so cannot catch this.
  If that is it, the fix is to release capture and treat a press that never moved as a
  click, or to stop capturing until the pointer has actually travelled a few pixels.
  Whatever the cause, the regression test has to go through the map's own pointer handlers.
- ✅ **The room card's two exit sections were the wrong way round and misnamed.** **Swapped
  and renamed: "Exits" first, then the rule, then "You came in from".** The author settled
  the ambiguity in the original note — it said "swap" and then listed the other order — in
  favour of the swap: where they can go is the question a player standing in a room is
  asking, and the way back is a decision to be found rather than the first thing under the
  contents. The *data* order is untouched (`byUsefulness` in `selectors.ts:348`), this was
  the presentation of it. `screens.test.ts` moved with the strings, and its ordering
  assertion inverted with them.
- ✅ **The player's input box grows.** A `useLayoutEffect` in `InputArea.tsx` sizes the
  textarea off its own `scrollHeight` — `height: auto` first, so it can shrink as well as
  grow — capped at six lines measured from the box's computed `lineHeight`, scrolling past
  that. Keyed on the draft rather than on a key handler, so typing, pasting, Escape and the
  post-send clear are all one path. **No unit test**: jsdom does not lay out, `scrollHeight`
  is 0 there, and the effect no-ops on that deliberately.
- ✅ **A header for the map section.** **Built as proposed**: `MapHeader` in
  `DungeonMap.tsx`, the dungeon's name (`dungeon.pass.name`) left and `n/m explored`
  right, with the map cell in `PlayScreen` now a column rather than a centred box. A
  sibling of the map and not part of it, so it does not pan and zoom away with the paper.
  The count is `map.rooms.filter(known)` — **the same field the fog is drawn from**, so
  the number and the drawing under it cannot disagree — and it counts corridors, which are
  rooms you walk into and read a description of like any other. The name was written by
  the Dungeon Pass and shown once above the opening, then scrolled away for the rest of
  the run.
- **A compass rose.** Not decoration — see 8c. The prose is being held to absolute
  directions, and the map should state which way north is rather than assume it.
- **Floating labels on explored rooms.** Room names on the map itself, fog permitting.
- **A sticky room header at arrival** — room name, and enough of the description to stay
  oriented, pinned as the narration scrolls.
- **Roll entries larger and more prominent**, with success and failure carried by colour
  and weight rather than by the word at the end of a mono line. The roll is the moment the
  player was promised they would get to watch; it currently renders as the least prominent
  thing in the scrollback.
- **Auto-centre the map on the new room** when the player moves.
- ✅ **A turn tracker**, top right of the stage area — the stage header row in
  `InputArea.tsx`, which was already `justify-between` with the stage name alone in it.
  **It shows the turn IN PROGRESS**, `turnCount + 1`, because `turnCount` is closed turns
  and the number the player is living through is one more — which is also the number
  `assemble.ts:139` puts in front of the referee, and the two should not be off by one
  from each other when a player is reading both. **Absent at a terminal stage**, where
  there is no turn in progress and `EndOfRun` states the closed count a few lines below;
  two numbers labelled "turn" and one apart would be worse than no tracker.
  `InputArea.test.tsx` is new and jsdom, per the extension rule in `vite.config.ts`.

---

### 8c — Referee prose discipline

Most of this is a prompt change, and they are grouped because they share a cause: **the
referee is writing from the prose it was handed rather than from the geometry the floorplan
actually has.** Phase 6 gave the room block real geometry — walls, positions, exits with
sides — and the step files have not caught up with it. **Two items turn out not to be
prompt changes at all**, and they are marked; both are the room's own `base` and the one
geometry sentence behind it, which is 8f's territory.

**Space and direction**

- **Absolute directions only.** *"To your left"* — the player has no facing, the map has no
  facing, and left is undefined. North/south/east/west, and the room block already provides
  them.
- **Positions must match the plan.** *"The ramp at the north wall's western end"* when the
  connector is at the **eastern** end. The side and the end are both in the room block; the
  step file needs to say that they bind, in the same voice the context policy uses for
  `composed`.
- **Shape claims must match the shape.** A room drawn as a pyramid or half-round described
  as *"running east to west"*. `describeGeometry` exists and is rendered; the instruction to
  prefer it over invention does not.
- **Elevation should not contradict itself.** *"The ramp slopes gently upward into deeper
  darkness."* Up is not deeper. Worth one line, since the flat-plane rule means ramps and
  stairs are flavour and the model has nothing constraining how it uses them.
- 🔴 **Room proportions still read as nonsense, and a sentence may not be enough.** R2:
  *"a narrow chamber running the length of a ship"*, *"East and west walls run the length,
  north and south are mere suggestions"*, *"broken geometry"*. The author's question is
  whether to hand the model **the drawing** instead of a sentence about it.

  **Recommendation: an ASCII plan of the room's cells, not an image and not the SVG.** One
  character per cell, with the doors marked and north up — a 10×8 room is 88 characters,
  it is deterministic, it diffs in a snapshot test, it costs no vision tokens, and it is
  the same artefact for the content pass and the referee, which is the §2.11 feedback-loop
  rule. An image would have to be rasterised somewhere, cannot be asserted on, and buys
  nothing a grid does not. Keep `describeGeometry`'s sentence beside it — the words are
  what the prose should reuse; the grid is what settles arguments about shape. Feed it
  through `ContentRoomBrief.geometry` and `RoomView.geometry` together, so both readers
  keep seeing the same thing. **Measure before adopting**: render a dozen rooms both ways
  and compare what comes back, because a grid the model narrates cell by cell would be a
  worse failure than a vague sentence.

**Exits**

- 🟠 **Do not count the way the player came in — and the count is not the referee's
  fault.** R1: *"Three ways lead out"* when there were two plus the entrance. R2 is worse
  and shows the cause: the Residue Way's arrival post says *"Four ways lead out"* and then
  names three, and it describes the concealed fissure to the Oubliette as one of them.

  Three sources tell the referee how many exits a room has, and **they disagreed**:

  1. the **ways-out list**, which is correct — `roomView` filters concealed connectors
     (`selectors.ts:271`) and flags the one they came in by;
  2. the **geometry sentence**, which counted every connector in `g.exits` with no
     concealment filter at all — so it said *"one off the north wall, two off the west
     wall"* about a room with a hidden way;
  3. the room's own **`base`**, written by the content pass off that same unfiltered
     sentence, which in R2 opens *"Four ways out: east, south, and two to the west."*
     `base` is immutable and binds the referee, so **no step file can fix this** — the
     referee is being obedient.

  ✅ **(2) is fixed, and so is a fourth source nobody had counted.** `describeGeometry`
  takes `{ omit }` and `roomView` hands it every concealed connector touching the room, so
  the count is what a person standing there can see; the way out of the dungeon has a null
  id and is never omittable. The memo in `selectors.ts` now holds the `RoomGeometry` rather
  than the rendered line, because concealment is run state — a secret door found on turn
  nine has to start being counted, and a baked sentence could not. **The content pass still
  passes nothing and sees them all**, deliberately: it is the pass that writes what the
  concealed way physically is.

  **The fourth source was the ways-out list itself.** A concealed *item* carries
  `NOT YET FOUND BY THE PLAYER` (`render.ts:113`); a concealed **connector** carried
  nothing — `ExitView` had no such field — and prompt assembly passes `includeHidden:
  true`, so a secret door reached the referee formatted identically to an open one. That is
  R2's fissure. `ExitView.isHidden` now exists and `render.ts` marks it in the same words,
  plus *do not count it among the ways out*.

  ✅ **(3) is fixed.** `CONTENT_PASS_INSTRUCTIONS`
  gained two rules under the direction pair, both argued from `base` being immutable and
  there being no later pass that can correct it: **do not count the ways out in the room's
  base**, because the number stops being true the first time one is opened, barred or
  found and the description cannot catch up; and **a concealed way is not part of the
  room's description**, not even as a hint or a draught, because that description is read
  out on arrival — it is written on the connector, which is the text the player reads on
  *finding* it, and a findable concealed way already has a clue entity of its own.

  **Still open:** the step-file line about mentioning the way in last and outside the
  count. That was ordered last on purpose and now has a room block it can be written
  against.

**Reuse and register**

- **Room descriptions are being reproduced verbatim.** The `composed` field binds the
  referee (`SKILL.md:236`) and it is being satisfied by quotation. Two candidate fixes, and
  they should be tried in this order: (1) instruct explicitly that `composed` is what the
  player has *already read* and must be built on rather than repeated; (2) if that does not
  hold, render the room block's prose fields in a deliberately **non-prose form** —
  fragments, keyword lists — so there is nothing grammatical to copy. The second is heavier
  but is the one that cannot be ignored.
- **The verbal tics.** *"Running my fingers over"* everything inspected, *"moving along"*
  everything traversed. A short list of banned constructions in the information handler is
  the cheap fix; the better one is to say what an inspection paragraph is *for* so it stops
  reaching for a stock gesture to open with.
- ✅ **The roll announcement does not belong in the narration.** *"You need to cast this
  without being noticed. Make a Dexterity save—DC 16. Roll 1d20+3."* **And the step file was
  asking for it**: `3-standard.md` listed "the roll they are about to make", "their bonus"
  and "whether it carries advantage" as things the confirmation post must say — while
  `RollOffer` (`InputArea.tsx:59`) has always rendered exactly those beneath the post from
  the committed `rollRequest`, and `SKILL.md:194` says it does. So the referee was obeying
  an instruction to duplicate the interface, and the DC rode along on the duplicate.
  **Fixed, and the line is drawn between the VALUES and the REASONS** — not between
  mechanics and fiction, which was the first cut and the wrong one. The screen prints
  `DEX SAVE · +3 · ADVANTAGE`: the bare fact, no cause. So the numbers and the labels want
  no restating, and the post must still carry what the screen cannot say —

  1. **where an edge came from**, whenever there is one. A player who cannot see that their
     preparation paid stops preparing, and one who cannot see where a disadvantage came
     from cannot argue it away. This is the standing "do not name anything working *for*
     them unless you are giving them advantage" rule read from its other end, and that rule
     now says so: naming without paying misleads, paying without naming hides the fact that
     thinking works.
  2. **why this ability, unless it is obvious** — and it usually is; a leap is Dex and a
     heaved portcullis is Str. Where the fit is a judgement (Wis to hold their nerve rather
     than Dex to move faster), a clause tells the player what kind of attempt the referee
     understood this to be, in time for them to say "no, I meant —" before the dice.

  Anything the offer is missing still goes into `rollRequest` — whose `description` is the
  line shown above the Roll button — rather than into a second copy that can drift out of
  step with it.
- ✅ **What a confirmation post is for, said once, plainly.** R2 seq 145 shows the referee
  writing the post as narration of the attempt, catching itself, and rewriting it as a
  statement of terms — *"Wait—I should not write that post yet"*. The one statement it
  needed, now at the head of the section: **the post stops at the moment of attempt** — the
  instant before the hand closes, the blade moves, the foot leaves the ledge — because the
  dice have not been thrown and narrating the attempt is step 5's, once there is a result to
  narrate. **This reduces how often A9 fires and does not fix it.**

  **`4-confirm-and-roll.md` carried the same instruction a file away** and moved with it:
  a re-presented roll says what changed and why — an edge the player has just argued into
  existence is one they earned, and naming what bought it is how they find out the argument
  worked — rather than the numbers again. Two step files telling the referee to restate the
  terms is exactly the "says both things a paragraph apart" problem, one paragraph further
  out.
- **Room names and their descriptions must agree.** A room called "The Laboratory" whose
  description was not of a laboratory. Needs diagnosis before a fix — the name comes from
  the rolled `identity` and the description from the content pass, so either the
  content-pass prompt is not treating the name as binding, or the naming instruction is
  loose enough that the name was the odd one out. Read the R1 content-pass prompt and
  response for that room before changing anything.

---

### 8d — Rules gaps

- **Spellcasting has no guidance at all.** Author's design, to be written into
  `3-standard.md`: a spell is **auto-success** unless it targets another creature or
  attempts something difficult or flashy, in which case it rolls as normal. It is
  **exhausted after use** — with an explicit allowance for follow-up actions that are part
  of the same effect, so lifting a thing and then setting it down is not two castings. The
  lockbox theft is the worked example, and under this rule it would have been a clean
  success with no roll at all.
- 🔴 **One obstacle, one roll.** *"Getting through the iron grate was too hard. It didn't
  need to have 3 locks. Most obstacles should be beatable with a single roll. Requiring 2–3
  rolls should be reserved for particularly challenging obstacles."* (R1.)

  A connector's `conditional` is **one string** describing one obstacle — the grate's was
  *"locked from this side, the chains wrapped through the bars, the mechanism seized with
  rust and brine"*. The referee read that clause list as a list of **separate obstacles**
  and charged a roll for each: the chain, then the lock, then the seized mechanism. Nothing
  told it otherwise, and its reading is not unreasonable — the prose does describe three
  things.

  Two halves to the fix and both are needed:

  1. **The rule, in `3-standard.md`:** a `conditional` is a single obstacle. One successful
     roll clears it and the diff that follows is `conditional = null`. A referee that wants
     to charge a second roll needs a reason from the fiction that arose **after** the first
     — a new fact the player uncovered — not a second noun in the same sentence.
  2. **The prose, in the content pass:** stop writing `conditional` as a pile of clauses.
     One obstacle, said once. Multi-stage obstacles are worth having, but they should be
     something the generator *chose*, on a room that deserves one, not an accident of a
     comma-heavy sentence. If they are wanted, they need a field — a count or a flag — and
     not a longer string.
- **Hordes are too strong, half-HD creatures are not fodder, and nothing caps how many can
  swing in one exchange.** Twelve creatures plus a leader against a level 1 character (R1).
  Three questions, and the third is the author's new one:
  1. whether `dungeon-rooms-loop.ts` should produce groups that large at level 1 — a
     stocking parameter;
  2. whether a ½ HD creature resolves as a **mook** — dying to any hit, attacking as a
     group rather than individually — a rules addition to `dungeon-rolls`;
  3. **a hard cap on how many creatures may attack the player in one turn exchange**,
     regardless of how many are in the room. The fiction carries the rest as pressing in,
     waiting for an opening, blocking the way — which is what a real melee looks like and
     what a crowded doorway does. The cap is a number in code that the resolution step is
     told about, not a judgement the referee makes; **suggest 3**, and note that it also
     bounds the batched `roll` call, which is the mechanism that would otherwise roll
     thirteen attacks in one go.

  **Measure before tuning (1)**: run the existing generator across a seed spread and get the
  actual distribution of group size against level. (3) needs no measurement and can ship on
  its own — it is the cheapest of the three and it is the one the player feels.
- **The magnetic field did nothing.** The player walked through it wearing chain, carrying a
  sword and a helmet, and nothing happened. An effect with no mechanical consequence written
  for it is an effect the referee has no way to apply. Either effects need a consequence
  field the content pass fills in, or the resolution step needs to be told that walking into
  an effect is an event. Decide which in session.

---

### 8e — Time, attention, and creatures acting on their own

The largest item and the one that is genuinely new machinery, so it is last. **R2 doubled
its size**: that run was almost entirely conversation, and it is the first evidence of how
creatures behave when the player talks to them rather than fights them.

#### The world moving while the player is elsewhere

The author's original observation is that these are one problem: *"we need a contingency for
loud sounds or other effects that would attract attention from elsewhere in the dungeon.
This probably also implicates a system for the passing of time and actions of other
creatures we don't have yet."* That is right, and the pursuit complaint — *"enemies didn't
actively pursue into adjoining rooms"* — is the same gap seen from the other side.

What exists to build on: `turnCount` has been in `GameState` since Phase 2 precisely for
this; `stockDungeon` already generates wandering groups; `roomIndex` makes "who is where" a
cheap question; and `travel.ts` already knows which rooms adjoin which.

What does not exist: anything that runs between turns. Design questions for the session,
none of them settled:

- Does the world act on a **clock** (every N turns) or on **events** (a loud noise, a fight,
  a scream)? Probably both, with the clock as the floor.
- Is off-screen action **simulated in code** or **narrated by a model call**? Code is
  cheaper and deterministic and fits the "the model never generates a number" rule; prose is
  richer. A hybrid — code decides who moves where, the referee is told about it on the next
  entry — is the obvious first cut.
- How does the player learn about it? Almost certainly through the room-entry pass and
  through `state` on the creatures that moved, which is what the three prose lifetimes are
  for.

#### Creatures in the room the player is standing in 🔴 **NEW, and it is half of R2**

*"Wendy badmouthed the Brotherhood in front of Zora, a member of the Brotherhood, to no
response."* And more generally: *"Creatures need more guidance to make NPCs act more normal
when the player talks to them."*

The referee's own resolution traces in R2 say what is missing. It reasons about **Wendy's
position** and **Zora's position** as two separate one-on-one relationships with the
player, and closes with *"No other creatures act"* — which it wrote about a room holding
exactly the creature that had just been insulted. It is not ignoring Zora; it is being
handed the player's action and one target list, and nothing ever asks it what everyone
else in the room thought of that.

**Two instructions, and they are two because they answer different questions:**

1. **On every turn that changes state, ask what each creature present does about it.**
   Not only the target. This is the same "the world acts" problem as above, at a range of
   zero, and it should share whatever mechanism that gets — the passage-of-time hook fired
   for the current room is the cheapest version and the one worth building first, because
   the player is standing there to see it.
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

#### Creatures moving the player 🔴 **NEW, design question**

*"Should entities be able to take the player to another room?"* The author's own two cases:
**when the player is cooperating with them**, and **when the player is downed but not
slain**. And behind both: *"Follower logic? Henchmen/party members?"*

Worth answering in this session because the machinery is already there and the rule is
not. A creature writing `currentRoomId` is not currently possible — the player's room moves
through travel, which is the player's own action, and `apply.ts` treats a walk as something
the player did. Three things to settle:

- **Consent.** Being led somewhere you agreed to go is a scene; being moved without consent
  is the thing that makes a player stop trusting the interface. The downed case is the one
  exception, and it earns it by being the alternative to death.
- **Whether a follower is an entity or a new concept.** Almost certainly a creature whose
  `activity` says it is following, with `roomId` written to wherever the player went — no
  party, no second sheet, no shared inventory. §9 non-goals says one PC and that still
  holds; a follower is scenery that walks, not a second character.
- **What the map does.** A follower is a creature and creature markers do not exist
  (§1.2.12), so it will be invisible on the drawing until they do. Acceptable; note it.

#### What is not missing

**Multi-room travel is not part of this and is not missing.** The report said the travel
function *"was lost"*; it was not. `runtime/travel.ts` implements routing across known
rooms, stops the walk at a creature, a hazard, a spreading effect or a barred way, and
reports where the player actually ended up — and `turn.ts:296` reads the `movement-stopped`
event and writes it into the turn record. `SKILL.md:285` documents it to the referee. The
UI gate is now `reachable` in `PlayScreen.tsx` and the `Go To?` pill — a click on a distant
known room already sends a sentence naming it as the destination and lets `routeTo` walk
the rest, which is the bargain `apply.ts:164` describes. So the remaining question is
narrow: whether the referee writes the far `roomId` when the player names a far room.

---

### 8f — What the dungeon hands the referee 🔴 **NEW SESSION, all of it from R2**

Five items that look like referee faults and are not. Each one is a fact written into an
immutable `base` — or not written at all — before the run starts, which the referee is
then correctly obedient to. **This is the session that has to exist because 8c cannot fix
these with a prompt.**

- **Connectors are written after the rooms that own them, so neither room's prose knows
  what its own doors are.** The author's ask: *"Change the order of creation on room
  connectors. They need to be done at the same time as the first room so they can be part
  of its context, and then added to the context of the adjoining room on its generation."*

  Today (§2.2): inside a chunk the lower graph index owns a connector, and a connector
  leaving a chunk is a **seam** written last by a separate pass with both rooms in front of
  it. So the first room's own description is written **before** the way out of it exists as
  prose, and the second room's is written before it too if the connector is a seam. That is
  why a room says *"a spillway of stacked wood and stone"* in one place and the connector
  says something else in another, and it is the same root as the entrance item below.

  The change: a room's connectors are written **with the room that first claims them**, and
  the adjoining room's payload carries the finished connector prose as context it must
  agree with rather than re-invent. That makes ordering load-bearing where it was
  cosmetic — `applyContentPass` is already serial in ascending chunk order (§2.2) for
  exactly this kind of reason, so the mechanism exists. **The seams pass may survive, may
  shrink to only the connectors whose both rooms are in later chunks, or may disappear;
  decide that with the payload in front of you.** Whatever happens, §2.2's ownership rule
  is being rewritten and the tests asserting it move with it.
- **The dungeon entrance is not in the fiction, and the roll behind it is strange.**
  *"Incorporate the dungeon entrance into the fiction."* / *"Most of them are really
  weird."*

  Both are one cause. `DUNGEON_ENTRANCES` (`dungeon-blueprint.ts:131`) is the Maze Rats
  table — *Beaver dam, Living tattoo, Giant book, Under the bed, Maze potion, Unfolded
  map*. It is rolled in **stocking** (`dungeon-rooms-loop.ts:1104`), which is branch B of
  the pipeline, and the **opening prose is written by the Dungeon Pass**, which is branch A
  and runs concurrently. **Branch A cannot see the roll.** So R2's opening walks the player
  down a rim path into a quarry, and the entrance roll — *Beaver dam* — surfaces only as a
  clause in one connector's description, *"a spillway of stacked wood and stone"*, in a room
  the player reached later.

  Two fixes, and take both: **move the entrance roll before the split** so the Dungeon Pass
  is handed it and the opening is written around it; and **cut or rewrite the table** for a
  dungeon that is a place rather than a fairy tale — a third of those entries cannot be
  realised in a marble quarry without the model either ignoring them or writing something
  absurd. The table is Maze Rats' and it was transcribed wholesale; that was right for the
  detail tables and wrong for this one.
- **Named NPCs introduce themselves by name before the player could know it.** *"Named NPCs
  are identified by name in the room card (one was identified in the prose) — in general
  names need to be toned down to better represent first impressions."*

  R2, on first sight: *"One is a wiry woman with intricate braids—Wendy, you think, though
  you have never seen her in the flesh."* The referee is patching around a name it was
  handed and had no way to withhold. `entity.name` is identity and is **not runtime
  writable** (§2.4), the room card renders it, and the prompt renders it — so a stranger
  across a dark room is labelled.

  The author's proposal, and it is the right shape: **a `properNamed` flag, false at
  first.** While false, the name is a description the player would arrive at — *"a wiry
  woman with braids"* — the room card shows that, the prompt shows that, and the referee
  may **write the true name in** the moment the fiction earns it, flipping the flag. That
  makes `name` writable exactly once, through one path, which is a narrow enough exception
  to the §2.4 rule to be worth stating there rather than a hole in it. Settle in session:
  whether the placeholder is a second field or the `name` itself, and what happens on
  reload for a creature that was named mid-run (it persists — it is a normal field write).
- ✅ **Item names came through in lower case.** R2's *"unmarked ledger"*, and the generated
  entities were inconsistent — *"The Residue"*, *"The Cutlass"*, *"The ledger"*, *"The
  mirror"* in one dungeon.

  `properName` in `dungeon-entities.ts` raises the first letter and leaves the rest alone —
  not title case, which would have to know which words belong to somebody's actual name.
  **Four mint sites, not the two this said**, and the extra two are why the walk exists:
  `createEntity` (`apply.ts`) for what the referee mints mid-run; `applyContentPass`, where
  a dozen assignment sites made per-site normalising a trap, so the whole response is walked
  once at the top and every `name` key capitalised on a clone (the raw response is what the
  journal recorded); plus `applySeamsPass`, which names the cross-chunk connectors, and
  `applyDungeonPass`, whose group name **is** a creature's display name through
  `resolveName`. `SKILL.md`'s creation section carries the rule and its example was
  teaching the opposite.

  **One thing this needed that the note said it would not.** `definite()` in `verbs.ts` was
  to be left alone, and it could not be: a name carrying its own article is now stored as
  *"The pillars"*, and dropping that into a sentence verbatim gives *"I examine The
  pillars."* `definite` now normalises **the article and only the article** — any leading
  `a`/`an`/`the` leaves as a lower-case `the`, and the rest of the name is untouched, since
  *"I examine the wendy wilberforce"* would be a worse sentence than the one being fixed.
- **The goal is stated in terms of a named NPC who is not in the goal room, and who is in
  two rooms at once.** *"Wendy appears to be the goal entity for the dungeon, but she showed
  up in the 3rd room. I thought we had something in place to make sure the goal was found
  on the opposite side."*

  **The placement machinery is working.** `structure()` picks the goal room by eccentricity
  from the entrance (`dungeon-rooms-loop.ts:426`), and in R2 it did: the entrance is the
  Bookyard, the goal room is **The Vault**, and the goal entity is **the ledger** with
  Adelaide beside it. The player never got there.

  Two real defects behind the impression:

  1. **The goal text names Wendy** — *"Learn what Wendy Wilberforce has promised…"* — so
     meeting Wendy reads as arriving at the goal. The goal directive should be stated in
     terms of **what is in the goal room**, or the NPC it names has to be the one standing
     in it. Today nothing connects the two: the directive is written by the Dungeon Pass
     from `bp.inhabitants`, and which room a group's members end up in is stocking's.
  2. **Wendy exists twice.** She is written into Revenant Spring *and* into The Crypt, with
     the same name, the same base and different `activity` — two entities realising one
     group's leader, because each chunk that placed a member of that group realised the
     leader independently. **That is a generation bug and it is the more serious of the
     two**: a unique named NPC must be one entity. Look at how `registry.groups` members are
     distributed in `stockDungeon` and at what the content pass is told about a group whose
     leader has already been written. This is also worth a `validateWritten`-style assertion
     — no two creatures sharing a name and a group — because it is exactly the class of
     thing that silently passes today.

---

### Deferred out of Phase 8

**Letting the player tell the referee it got something wrong.** The author raised it after
R1 and was unsure of the shape (*"I don't know"*). **Deferred deliberately**, on the grounds
that 8a removed the failure that prompted it — the referee in R1 was not being stubborn, it
was being handed a prompt with the roll missing — and a correction affordance designed
against the wrong failure would be designed wrong.

**R2 is the second playtest that was to decide this, and it says: still deferred, and now
we know what it would have been for.** The ledger took three attempts (A8) and the mangled
post repeated itself (A9), and a "that's wrong" button would have been the player patching
over both. Both have real fixes. Revisit after a run in which the machine is behaving and
the referee is still wrong.

Three shapes were considered and are recorded so the next reader does not re-derive them: a
*"that's wrong"* button opening a correction turn that may rewrite `state` and `composed`; a
persistent out-of-character input channel addressed to the referee as a referee; and nothing
at all, on the theory that a referee which cannot be argued with is part of the genre. No
decision.

---

## 6. Phase 9 — The seam ✅ **BUILT**

The first phase of the server migration, and it contains no server. Its whole job is
that **the runtime stops depending on there being exactly one of everything**, because
a browser tab holds one run and a request handler holds many. Nothing here is visible
to a player: same game, same turns, same journal.

### 6.1 What was singleton, and what it is now

| Was | Is |
|---|---|
| `useGame`, a module-level store in `store/game.ts` | `createGameStore(): GameStoreApi` |
| `sink` / `seq` / `broken` / `written`, module state in `runtime/journal.ts` | `createJournal(sink?): Journal`, plus the shared no-op `NO_JOURNAL` |
| the run lifecycle, inside `App.tsx`'s `begin` | `createGameSession()` in `runtime/session.ts` |

`turn.ts` and `referee.ts` already took the store as a parameter — that foresight is
why this was cheap — but both **defaulted to the singleton**, so nothing was forced to
say which run it meant. The defaults are gone. `createTurnMachine(referee, { store,
journal })` and `createModelReferee({ store, journal })` now require a store, and both
declare it structurally (`{ getState(): GameStore }`) so neither imports zustand.

The journal is optional everywhere and defaults to `NO_JOURNAL`, which is what keeps
**NO SINK, NO COST** true: the hundreds of tests that do not want a journal did not
have to change, and none of them allocate one.

### 6.2 `store/game.ts` imports `zustand/vanilla`

The package's own entry point is `export * from 'zustand/vanilla'; export * from
'zustand/react';` — so importing `"zustand"` pulled React into the import graph of
every module that touched game state, the turn machine and the referee included. It
worked, and it made the rule that the runtime is renderer-free untrue in fact.

`src/store/react.ts` is now the only module below `src/ui` and `App.tsx` that imports
React: one hook, `useGame(store, selector?)`, over `zustand/react`'s `useStore`.

### 6.3 `GameSession`

One object per run: its store, its journal, its referee, its turn machine, and the
sequence that gets from a seed to a player standing in the first room.

```
createGameSession({ referee?, sink?, generate?, offline?, onProgress?, signal?, maxRounds? })
  → { store, runId, begin(request), resume(saved, runId?), enterRoom, submit, roll, retry }
```

Three decisions worth keeping:

- **`sink` is a factory taking the run id**, because the id is derived from the seed and
  the seed does not arrive until `begin`.
- **`referee` is a factory taking `{ store, journal }`**, because the real one needs both
  and they belong to the session. A fixture that needs neither is `() => stubReferee`.
- **A second `begin` is ignored.** That was a `useRef` guard in `App.tsx` against
  StrictMode's double mount; it belongs on the session, where it also covers a retried
  handler. Generating over the top of a run in progress is worse than doing nothing.

`resume(saved, runId?)` sets a store from a `SavedGame` without generating — the shape
a request handler needs when the run comes back out of a database.

### 6.4 The dungeon baseline moved

`generate.ts` used to write the `{ kind: "dungeon" }` event. The session writes it now,
immediately after `run`. The journal's claim is that the dungeon plus the commits is a
complete history, and a dungeon that did not come through `generateDungeon` — the
offline fixture, and later a dungeon loaded from a row — used to leave the journal with
no world in it at all.

### 6.5 `?raw` markdown does not load under Node 🔴 **the one real surprise**

The playbook is markdown imported with Vite's `?raw` suffix (`prompts/loader.ts`). Vite
understands it and so does vitest, which is why prompt assembly was always testable
headlessly. **`node` does not**, so anything reaching the referee could not run outside
a bundler. Invisible while the only thing that played a turn was a browser tab, and the
first wall you hit playing one from a terminal.

`dev/raw-md.ts` registers a synchronous module hook that teaches Node the same trick —
no build step, the markdown stays the source of truth, nothing generated and nothing
that can go stale. `cli-play.ts` is ten lines that register it and then `await import`
the real CLI, because a static import would be hoisted above the registration.

**This is a Phase 10 constraint, not a solved problem.** A serverless bundler will need
the same thing from its own config. Vite in SSR mode already does it.

### 6.6 What proves it

- **`dev/cli-play.ts`** plays a whole run from a terminal — generation, room entry,
  turns, the roll cycle, a journal in `out/runs/<id>/`. `npm run play` /
  `npm run play:offline`. Piped stdin works, so a run can be scripted.
- **`runtime/session.test.ts`** runs two sessions at once on different seeds and checks
  that neither can reach the other: separate dungeons, separate draw counts, separate
  journals each numbered from one. This is the test the phase exists for.
- **`App.test.tsx`** mounts the app on `?offline=1` and plays a turn, which is the only
  cover on the wiring between the session, the store subscription and the switches.
- **A purity sweep** in `session.test.ts` over every file in `src/runtime` and
  `src/store`: no `from "react"`, and no bare `from "zustand"`. The engine has had its
  equivalent since Phase 0; the runtime never did, which is how the rule became untrue.
- 787 tests, build clean; 793 after §6.7.

### 6.7 A generation failure said almost nothing ✅ **FIXED**

Observed in the browser on `?stub=1`, 2026-08-14: **"Could not build a dungeon: response
did not match the expected shape"**, and nothing else — on the screen or in the console.

The journal (`out/runs/2026-08-14T14-18-37-seed1005/`) had four events: the run,
`dungeon-pass`, `content-pass` chunk 0, then the error. So one content-pass chunk came
back failing zod, retried once, failed again, and took the whole generation down with
it — two other passes' worth of tokens thrown away. **The same switches succeeded twenty
minutes later** (`15-26-35`, "The Turning House"), so this is a transient model failure
of the §1.1 family, not a broken build.

What is missing is everything that would let you *fix* it:

- **Which chunk.** The `error` event carries `where: "session:generate"` and a message.
  Chunks run in parallel, so "one of them" is all you get.
- **What zod objected to.** `ResponseFormatError` already carries `issues` and `raw`
  (`llm/json.ts`), and every layer above drops both on the floor.
- **The failed attempts at all.** `journal.log({ kind: "generation" })` only fires on
  success, so a pass that never succeeded leaves no prompt and no response — the exact
  two things §1.1 says are worth keeping because the dungeon is written once.
- **Anything in the console.** `App.tsx` catches, takes `e.message`, and renders a
  string. The error object never reaches devtools.

**Shipped, in four pieces:**

1. `onAttemptFailed?: (report: FailedAttempt) => void` on `JsonCallOptions`.
   `callForJson` calls it before each retry and again before the final throw, so both
   attempts are recorded — the same complaint twice is a prompt that cannot be
   satisfied, two different ones is a model having a bad round, and only having both
   tells them apart. A reporting hook rather than a journal parameter: `client.ts` has
   no business knowing what a journal is, and the caller is the one that knows which
   pass is in flight. It is wrapped, because reporting must not be able to lose the
   error underneath it.
2. A `{ kind: "generation-error"; pass; chunk?; attempt; willRetry; message; issues;
   raw }` event, written from `generate.ts` by a `reportFailure(journal, pass, chunk)`
   curried on the two things `callForJson` cannot know. It goes to the console as well,
   because whoever hits this in a browser has devtools open and no journal file within
   reach. `journal-render.ts` renders it into the transcript — unlike `generation`,
   which is record-only, because a dungeon that failed to build has no rooms to read
   and this is the whole document.
3. `describeFailure(e)` in `session.ts` puts the first three validation complaints into
   the sentence and says how many more there are; `session.begin` logs that and
   `console.error`s the error OBJECT, not the string.
4. The error screen names the run id — the journal is in `out/runs/<id>/` and the only
   way to find it was to guess at the timestamp — and offers **Try seed N again**, on a
   fresh session, because a session that has begun refuses to begin twice. The same
   seed on purpose: a second failure on the same seed is worth knowing and a fresh
   random one would hide it.

What it produces now, from a dungeon-pass response that failed twice:

```
response did not match the expected shape — name: Invalid input: expected string,
received undefined; theme: …, and 3 more
```

plus two `generation-error` events carrying every issue and the raw response, the same
two on the console, and a `> [!WARNING]` block per attempt in `transcript.md`.

**Not covered by a test:** the error screen itself. `App.test.tsx` mounts on
`?offline=1`, the switches are read at module scope, and there is no seam to inject a
generation failure through — so the retry button and the run id are verified by eye.

**This is also the argument for Phase 10's split generation.** One bad chunk killing a
whole dungeon is only tolerable because a request cannot resume; once each chunk is its
own request, the retry is the chunk rather than the run.

---

### 6.8 Deliberately not in this pass

No Postgres, no Hono, no Vercel, no auth, no BYOK, no model catalogue, no run lock, and
no splitting generation across requests. `store/characters.ts` is still the in-memory
array — §8 still carries "whether a made character survives a reload", and Phase 11 is
where that gets settled.

---

## 7. Order of remaining work

```
  Phase 8a rest (A7, A9) ─┐
                8b ─┐     │
                8c ─┼─────┴─ independent of each other, any order or in parallel
                8d ─┤
                8e ─┤
                8f ─┘
  Phase 7   — the three remaining affordances, independent
  The shop  — the other half of Phase 5's equipment step; §3.6
```

**A8 is done** — it led this list because it refused a commit the player was entitled to,
and every playtest until it was fixed spent turns on it. **8a's remainder still goes first**,
for the same reason 8a led before: a machine that cannot finish a turn makes every other
item hard to see. Of what is left there, **A9 is the one with teeth** — A8's refusal is
gone, but the doubled post it produced was a second defect and is untouched.

**Two soft orderings among the rest.** 8f's exit-count fix had to land before 8c writes
step-file rules about exits, or 8c would be writing instructions for a room block that was
about to change. **It has landed** — the geometry sentence no longer counts a concealed
way, the ways-out list marks one, and the content pass no longer writes counts or concealed
ways into a room's `base` — so the step-file line is now unblocked. And 8e's creature work reads
much better after 8f's `properNamed`, since "who is this person" and "what do they do about
what was just said" are the same scene.

---

## 8. What is still open

**Open outside Phase 8**, both from Phase 5 and both named in §3.6:

- **The shop.** The Item Costs page is ~90 entries and `knave-tables.ts` already carries
  costs for everything the gear tables can produce. Per the brief, slot cost shows at least
  as prominently as price.
- **Whether a made character survives a reload**, and what the stored record looks like.
  `store/characters.ts` is still the only module that has to change.

Everything else settled through Phase 7 is either in §2 or in the code.

**Open out of Phase 9**, and worth doing before the server work rather than after:

- ~~A generation failure is undebuggable~~ — §6.7, **done**. Nothing left open.

**Open in Phase 8**, none of it blocking the rest of 8a, which is fully specified:

- Whether narration moves onto the commit or the last text block simply wins (8a A9).
  **Prefer the commit; say so out loud when choosing the cheap one.**
- Why map markers do not answer a click when the code says they carry a verb.
  **Reproduce before fixing** — the pointer-capture suspect is a hypothesis (8b).
- Which of the two fixes for verbatim room-description reuse is needed — the instruction,
  or rendering the room block's prose non-grammatically (8c).
- Whether an ASCII plan of a room's cells actually improves how proportions are described,
  or gets narrated cell by cell. **Measure on a dozen rooms before adopting** (8c).
- Why "The Laboratory" and its description disagreed: a loose naming instruction, or the
  content pass not treating the rolled name as binding. **Diagnose before changing** (8c).
- Whether group size at level 1 is a stocking fault or a rules one, and what a ½ HD mook
  does mechanically. **Measure the existing distribution first.** The attacks-per-exchange
  cap needs no measurement — suggest 3 (8d).
- How an effect with no written consequence — the magnetic field — reaches the resolution
  step at all (8d).
- Everything about time and off-screen action: clock or events, code or model call, and how
  the player finds out (8e).
- Whether a creature may move the player, and what a follower is made of (8e).
- What survives of the seams pass once connectors are written with their first room, and
  whether §2.2's ownership rule is replaced or only narrowed (8f).
- Whether `properNamed` is a second field or makes `name` writable exactly once — the one
  exception §2.4 would then carry (8f).
- Why one group's leader was realised as two entities in two rooms (8f). **A generation
  bug, not a tuning question.**
- Whether the player gets a way to tell the referee it was wrong, and what shape it takes.
  **Deferred past Phase 8 on purpose** — see the phase.

---

## 9. Non-goals for this prototype

No multiplayer, no party (one PC). No leveling. No between-dungeon persistence beyond saved
characters. No light or ration clocks yet, though `turnCount` exists for them. No mobile
layout — desktop-first, must not break at tablet width.

**And no retrofitting.** A dungeon generated by an earlier build is disposable: this is
still development, there is no installed base, and a fix that applies from the next
generation onward is a finished fix. Nothing here gets a migration path, a back-compat
branch, or a caveat explaining what old saves keep. This is **not** licence to drop a
field a *current* generation run can legitimately leave unset — `blockplan` is null
whenever the plan does not draw (§2.10), which is a live supported case and not legacy
data.
