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
| 5 Character creation | ✅ built — §3. The shop, its one carried gap, is built too — §3.7 |
| 6 Maps | ✅ built (6a → 6c.4), with the carried gaps in §1.2 |
| 7 Dev affordances | ⚠️ **partial** — §4 |
| 8 Playtest refinements | ⚠️ **started** — 8a is done bar A7 and A9, the 8b hover items, the click-verb pill and four of the 8b interface fixes are built, 8f's capitalisation has landed, and the exit-count item is closed bar its step-file line; §5 is the rest, and the bulk of the remaining work |
| 9 The seam | ✅ built — §6. First of the server migration, and it contains no server |
| 10 Server and database | ✅ built and deployed — §7. https://aidungeon.vercel.app |
| 11 Accounts and ownership | ✅ built — §8. Google sign-in, `owner_id` everywhere, the dungeon key split |
| 12 Run continuity | ✅ built — §9. Resume, abandon, the one-run-at-a-time lock |
| 13a Shared worlds | ✅ built — §9a. Duplicate a dungeon, and go back down one already written |
| 13b The library | ✅ built — §9b. Browse what other people wrote, in batches, and take one |

**913 tests and build clean after Phase 13b** (899 after 13a, 887 after the shop, 818
after Phase 11), plus a third, explicitly-invoked vitest config (`npm run test:db`)
holding **58** more that need a real database.

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

- ~~**The shop.**~~ ✅ **BUILT — §3.7.** The copper is spent now.
- **Persistence.** `store/characters.ts` gained `saveCharacter` and
  `deleteCharacter` against the same in-memory array, so **a character does not
  survive a reload**. What the record looks like and what happens to one saved
  against an older shape are their own decision, and making it badly now would be
  harder to undo than making it later.
- **The library card's run-state badges** — the artifact's `IN A RUN`,
  `DIED · ROOM 3`, and the epitaph. Those need per-character run state nothing
  stores, and a badge computed from a field nobody writes is worse than no badge.

---

## 3.7 The shop ✅ **BUILT**

The other half of the equipment step, and what makes buying a real choice rather
than the thinner one. `src/engine/shop.ts` is the whole of the rules;
`src/ui/shop/Shop.tsx` is the counter.

**Reached two ways, and they are the same screen.** A `Shop` button on every
roster row that is not in a run, and — for anybody who took the copper —
straight off the last button of creation. The second is **derived from the
sheet**, not passed down as a flag from `StepEquipment`: a rolled kit carries no
copper, so `purse(pc) > 0` *is* the buying path. `App.tsx` holds the shopper as
a sheet (`shopping`) rather than as a screen name, because a market with nobody
in it is not a state the app can be in, and the branch sits **above** the roster
it returns to.

**The prices are the Item Costs page, transcribed once.** `SHOP_SECTIONS` in
`knave-tables.ts` carries tools, light, ammunition, clothing and food; the armor
rows and the weapon picker read `ARMOR_STATS` and `WEAPON_CLASSES`, which are
the same page and were already transcribed for creation. Weapons are asked for
**class first, name second**, exactly as at creation — the class is every number
and the name is fiction laid on it. Everything on the five gear tables is one
slot, because Knave says most items are and states otherwise only for armor and
weapons.

**The purse is prose on an item**, `Copper` with `amount: "440 cp"`, so `purse`
and `setPurse` live in `character-creation.ts` beside `copperItem` — the one
file that writes that string is the one file that reads it. **A purse of nothing
is no row at all.**

**Nothing is committed until the Buy button**, as in creation. The cart is
local, `checkout` is pure, and the sheet the parent saves is the object the
aside was describing. What binds:

- **Money is enforced, capacity is not.** The `+` that would overspend is dead
  before it is pressed and `checkout` throws besides; being overburdened is
  reported and bought anyway, which is the same call §3.4 makes for a rolled kit.
- **Quantities mint separate items.** Three torches are three items of one slot,
  because that is what they weigh and because dropping one has to be possible.
- **What is bought goes on, where there is room.** An empty equip slot takes the
  first purchase that fits it — armor nobody is wearing is money for nothing —
  and a **filled slot is never displaced**. `canEquip` is the strict check, so a
  shield bought beside a two-hander stays in the pack exactly as a rolled one
  does.
- **No selling.** A shop that buys is a second set of rules nobody asked for. A
  cart can be emptied, which covers changing your mind.

**`POST /api/characters` now refuses a character with an active run**, the way
`DELETE` already did and for a neighbouring reason: a run plays from its own copy
of the sheet and writes what survives back when it ends, so a write from the
roster would either be lost or clobber the run's own result. The shop does not
offer the button to anyone underground; this is the rule rather than the manners.

`SlotMeter` moved to `create/shared.tsx` — the meter a player learns to read
while making a character is the meter they read while spending.

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

## 5. Phase 8 — Playtest refinements ⚠️ **8a done bar A7, the rest planned**

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

### 8a — The referee cannot finish a turn twice. ✅ **DONE bar A7**

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

**One still open**, and it is A7 — the DOM shift, which is an interface
report rather than a turn the machine got wrong. A9 closed under Phase 12.

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

#### A9. Superseded drafts are published as narration ✅ **FIXED — solution 1**

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

##### What shipped: solution 1, and 2 was never written

**`post` is a field of `commit_state`.** There is one commit per turn, a field cannot be
written twice, and the last accepted call is the only one that counts — so a draft is not
narration **by construction** rather than by the loop guessing which block the referee
meant. The rule that a player reads nothing until the commit has validated gains its second
guarantee for free: the prose now travels *inside* the thing being validated.

**The `<post>` tags are gone, and so is everything that read them.** They existed to keep
two hundred words of "## Step 1 — Determine the target" off the screen, and they could not
tell a draft from the thing that replaced it — two drafts inside the tags are two tagged
posts. With the post on the commit, **loose text is working-out by definition** and there
is nothing left for a marker to disambiguate. `taggedPost` and `postOf` are deleted.

**The accumulator is gone with them.** `banked` and `attempt` existed to work out, from the
text alone, whether a round CONTINUED the turn (dice) or REDID it (a nudge, a refused
commit). Five separate live failures came out of that guess and each had a test; all five
tests survive, now asserting the same outcomes against a mechanism with no guess in it.
One behaviour genuinely changed and is the intended one: **prose written before the dice no
longer reaches the player at all.** `SKILL.md` has said "roll first, write nothing before
it" for two phases, because an outcome written before the dice came back is a guess.

**`post` is optional, and refused when it is missing.** Two turns legitimately write none —
a room entry, where the room's own `composed` IS the paragraph, and a commit that moves the
player, whose prose is discarded unread because the arrival pass is about to describe the
real room. Anything else committing without one is handed back inside the same conversation
(`missingPost` in referee.ts), because a referee that wrote its paragraph outside the tool
call has written it to nobody, and the player should not be the one who finds that out.

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
  party, no second sheet, no shared inventory. §11 non-goals says one PC and that still
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

**Answered in 10a.** `npm run build:api` bundles `src/server/vercel.ts` with Vite in SSR
mode into `api/index.js`, prose inlined — 507kB, verified running under plain `node` with
no hook and no `?raw` left in it. `api/` holds nothing but the bundle, on purpose: Vercel
scans that directory for entrypoints, and a `.ts` beside the bundle is an invitation for
it to build the source with the bundler that cannot read `?raw`.

`dev/raw-md.ts` (§6.5) solves the same problem the other way, for `node` running the
TypeScript directly. Both exist because both cases are real: the CLI runs from source and
the deployment runs from a bundle.

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
array — §9 still carries "whether a made character survives a reload", and Phase 11 is
where that gets settled.

---

## 7. Phase 10 — Server and database ✅ **BUILT AND DEPLOYED**

The runtime moves to a server and the client becomes a view of it. Split in two,
because it is too big for one session:

- **10a** the API, run locally against Supabase. Everything but deployment.
- **10b** deploy. ✅ **https://aidungeon.vercel.app** — 2026-08-15.

**No auth, no BYOK, no model choice.** One player. Those are Phases 11 and 12, and the
tables here carry no ownership columns yet.

### 7.1 The hosting decision, settled

| | |
|---|---|
| Client | the existing Vite SPA, static |
| API | one catch-all Vercel Node function running **Hono** |
| DB | **Supabase Postgres** over the Supavisor transaction pooler (6543) |

Hono in one catch-all rather than a file per route for two reasons: it runs as a plain
Node server locally, so local dev and production exercise the same code, and moving off
Vercel later is a deploy change rather than a rewrite.

Fluid compute bills **active CPU** and pauses on I/O, so a turn that is 195 seconds of
waiting on Anthropic is nearly free. The constraint that actually binds is the **300s
Hobby ceiling per invocation**, and it is what shapes §7.3.

**The project is `aidungeon` (`ytgmygcuqtvxzcxygtib`), us-east-1** — chosen to match
Vercel Hobby's `iad1`, because the latency that matters is function↔database.

### 7.2 What Phase 9 did not anticipate

**The journal restarts its sequence on every request** — the one genuine bug. A session
is built fresh per request, so `createJournal` counts from 1 again, and
`journal_events` has primary key `(run_id, seq)`. The second turn's first event collides
with the first turn's. And the failure is the quiet kind: the journal wraps every write
and reports once, per *IT MUST NEVER BREAK A TURN*, so a collision does not fail the
turn — it silently stops journalling, which is the exact thing the journal exists to
prevent. Fix: `createJournal(sink, startSeq)`, and the handler reads
`coalesce(max(seq), 0)` as it builds the session. Postgres assigning `seq` was
considered and rejected: `seq` is part of `JournalRecord`, which the renderer and the
transcript both read.

**Compare-and-swap on `runs.version` is the correctness mechanism.** Every write carries
`where version = $n`. Two turns that overlap both read version N; the first writes N+1
and the second finds no row to update and is rejected. That covers the stale second tab
as well, which is the same failure arriving slowly. `journal_events` rows go in the
**same transaction** as the `runs` update, so a rejected turn leaves nothing behind and
the journal can never describe a turn the state does not have.

A **version rather than the stage** the client thinks it is on: a client that names its
own stage can name a flattering one and be handed a roll it never earned. An integer is
opaque, so there is nothing to forge toward.

**`runs.locked_until` is an optimisation, not a correctness mechanism** — an earlier
draft of this section had it backwards. The compare-and-swap already makes concurrent
turns safe. The lock only stops a duplicate request spending a whole referee
conversation on a turn that is going to be rejected at the write. Worth having; a
double-click should not cost tokens. An expiry rather than a boolean so a function that
dies mid-turn does not wedge the run.

An in-process lock cannot do this job: Vercel runs N instances that share no memory, so
a `Map<runId, Promise>` exists N times and guards nothing.

### 7.3 Generation splits into three, and it is not a rewrite

No request may hold more than one model call. Generation is N+2 calls, so it becomes
three endpoints — and the split is cheap because of a fact in the existing pipeline:
**every content-pass payload is built before any apply runs** (`generate.ts:288`). The
payloads do not depend on the applies, so they can be rebuilt at apply time from
persisted state, and only the *responses* need storing.

```
generateStructure(opts)                     → GeneratedDungeon  (status: partial)
generateChunk(partial, chunk, opts)         → ContentPassResponse
finishGeneration(partial, responses, opts)  → GeneratedDungeon  (status: complete)
```

`generateDungeon` becomes a thin composition of the three, so the browser and CLI paths
are unchanged and every existing generation test still covers them. **applyContentPass
still runs serially in ascending chunk order** — the CLAUDE.md rule moves house intact,
into `finishGeneration`.

This is better than what it replaces, not a compromise: generation becomes resumable, a
failure at chunk 3 does not redo chunks 1 and 2, and the loading screen gets honest
per-step progress with no SSE machinery.

**Proved, not assumed.** `generation.test.ts` runs the split path twice from one
structure — once in memory, once with the partial put through `JSON.stringify` first,
which is what a Postgres row does to it — and compares what was written. They agree
exactly, modulo the ids of entities that applying CREATES, which are `randomUUID` by
design. That is the test that matters: `entities.registry` holds shared object
references, a round trip breaks that sharing, and if applying had ever depended on it
this is where it would have shown. It does not.

Two things the test had to be built around, both of which are the pipeline working as
designed rather than obstacles: the dungeon-pass prompt cannot be precomputed, because
it names inhabitant groups by unseeded id; and the seams prompt cannot either, because
it is built after the regions are applied and quotes rooms that now have names.

### 7.4 Endpoints

Generation addresses the **dungeon**, play addresses the **run** — the same split
`persist.ts` already makes between write-once and per-commit.

```
POST /api/dungeons                    → { dungeonId, chunks }      1 model call
POST /api/dungeons/:id/chunks/:n      → { done }                   1 model call, fired in parallel
POST /api/dungeons/:id/finish         → { dungeonId }              1 model call
POST /api/runs   { dungeonId, character }                          → run
POST /api/runs/:id/enter | /turn | /roll | /retry                  1 turn each
GET  /api/runs · /api/runs/:id · /:id/journal.jsonl · /:id/transcript.md
```

### 7.5 The schema

Applied as `phase_10a_initial_schema`. `characters` · `dungeons` (doc jsonb,
partial|complete) · `generation_chunks` (pk `dungeon_id, chunk`) · `runs` (state jsonb,
version, locked_until) · `journal_events` (pk `run_id, seq`).

RLS is **on with no policies at all**. The API is the only writer and reaches Postgres
over a direct connection, which RLS does not apply to; this is the backstop for the
other door, so anything that ever picks up the anon key gets nothing rather than
everything. Phase 11 adds ownership and real policies.

### 7.6 Where 10a stands

| | |
|---|---|
| the generation split | ✅ §7.3, with the round-trip proof |
| `createJournal(sink, startSeq)` | ✅ plus `SessionOptions.startSeq` |
| `src/server/db.ts` | ✅ one pool, transaction pooler, `prepare: false` |
| `src/server/repo.ts` | ✅ every statement the server runs |
| `src/server/app.ts` | ✅ every route, on Hono |
| `src/server/dev.ts` | ✅ `npm run api`, the same app on `@hono/node-server` |
| `src/runtime/remote-session.ts` | ✅ the client half, with its own tests |
| the client on HTTP | ✅ App picks local or remote; `store/characters.ts` is the database |
| `vercel.json` + `npm run build:api` | ✅ built and run; the deploy itself is 10b |

**A whole run went through the API on 2026-08-15.** Character saved and listed; the three
generation requests at 17s, 50s and 0.3s; "The Drift Hotel", six rooms; a room entry and a
turn; a stale turn refused with **409** and the current version handed back; the journal
read out of Postgres as 17 events with a contiguous sequence, and a 27KB transcript.
`runs still locked: 0` afterwards, which is the release path in `commitTurn` doing its job.

**Every id column had to become `text`.** `characters.id` rejected the seeded fixture
("pc-1" — `PlayerCharacter.id` is declared `string`, and the fixture is in every test in
the repo); then `dungeons.id` rejected `dungeon_rx`, because a dungeon's id is
`dungeon_<seed in base 36>` (`dungeon-blueprint.ts:786`) and is derived on purpose, since
the same seed must name the same dungeon. Both migrations were the same mistake made
twice: the schema was written from what a row usually looks like rather than from the type
of the thing being stored. It cost one wasted structure call to find the second one.

**Generation is journalled against the DUNGEON, not the run.** It happens across three
requests before a run exists — the player has not chosen a character yet — so
`journal_events.run_id` had nothing to point at. `dungeon_events` holds those, and
`readJournal` concatenates the two streams and renumbers on the way out: how the world
was built, then how it was played, which is also the order they happened in. It also
settles the size worry from the original planning — the `dungeon` baseline event carries
the whole world and is now written **once per dungeon** rather than once per run.

**Hono, and what it is for.** A router plus middleware built on Web-standard
`Request`/`Response`, which is the shape Vercel's runtime hands you and the shape Express
is not. Ten routes is hand-rollable; what tips it is path parameters, one error handler,
and CORS — the client will be on another origin in 10b. `@hono/node-server` runs the same
app locally, so local development exercises production code rather than a parallel
implementation that drifts.

**The SQL is verified, the driver binding is not.** Every statement in `repo.ts` was run
against the real database inside a rolled-back transaction: the lock acquires when free,
refuses when held, and acquires again after its expiry; the compare-and-swap accepts at
the right version and is **rejected** at a stale one, leaving the state untouched; the
`unnest` insert writes a turn's events in one statement; a replayed event does not
overwrite the one already at that sequence. What has not run is the TypeScript — that
needs `DATABASE_URL`, which is a secret and lives in `.env.local`.

**`prepare: false` is not a tuning knob.** Transaction mode hands out a different backend
connection per transaction and a prepared statement belongs to one, so leaving
postgres.js on its default would produce "prepared statement s1 already exists" under
load and never once in development.

**The pool is a module-level singleton, deliberately** — the opposite of the rule the
store and the journal follow (§6.1). Those hold per-run state and a singleton lets two
runs see each other. A pool holds no run state; it is a socket cache, and one per request
would spend a TCP and TLS handshake on every turn.

### 7.7 What the client became

`PlayableSession` — store, `begin`, `enterRoom`, `submit`, `roll`, `retry` — has two
implementations, and `App.tsx` cannot tell which it holds. `createGameSession` is the
whole runtime in process; `createRemoteSession` holds a store and posts.

**`?offline` and `?stub` stay local**, deliberately. Interface work should not need
Postgres running, and a fixture dungeon refereed by a keyword table costs nothing and
answers instantly. `LOCAL = OFFLINE || STUB` is the whole of that decision.

**The client sends what the player typed and the version it last saw. Nothing else.**
`remote-session.test.ts` asserts the request body is exactly `{ text, version }` —
because a client that quietly grew a `stage` field would break the security posture
without breaking anything visible.

**A 409 is not an error the player sees.** Stale or busy, the session re-reads the run
and shows what is actually true, so a second tab catches up rather than showing a
failure.

**`store/characters.ts` is the database**, and it was the only file that had to change —
which is what its header promised in Phase 5. That also settles §3.6's open question:
the stored record is the sheet, whole, in a jsonb column, because `PlayerCharacter` is
already the serialisable thing that goes in and out of a run. A sheet stored before a
field existed reads back without it, exactly as a save from before `fiction` did.

**Two Vite shims are gone**: the journal middleware and the Anthropic proxy. `vite.config.ts`
now proxies `/api` to the API beside it, so the browser sees one origin in development
exactly as it will in production. `journal-http.ts` is deleted. Run both:
`npm run api` and `npm run dev`.

### 7.8 Deployed

**https://aidungeon.vercel.app**, project `aidungeon` on `nicks-projects-2712a019`.
`ANTHROPIC_API_KEY` and `DATABASE_URL` are set for production and preview, both marked
Sensitive. A cron hits `/api/health` at 06:00 UTC on Mondays and Thursdays, which is what
keeps Supabase from pausing the project after seven days of quiet — Hobby allows one
trigger a day, and twice a week is enough to close a seven-day gap.

**A whole run was played on the deployed API**, which is the thing that proves the key,
the region and the 300s ceiling all at once: "The Menagerie", six rooms, the arrival
written by a model inside a Vercel function.

**And the first region failed, which was the more useful half.** Two attempts, 117
seconds, both refused by zod — `rooms: Invalid input: expected array, received string`,
which is §6.7's diagnostics saying exactly what went wrong instead of the word "shape".
The retry succeeded in 83 seconds and **the 15-second structure pass was not redone**.
That is the split from §7.3 doing precisely what it was built for, in production, on its
first real failure.

**One bug the failure exposed.** A generation pass that throws never reached
`appendDungeonEvents`, so the `generation-error` events were dropped — the exact records
§6.7 exists to keep, lost again the moment the runtime moved to a server. The console had
them; the database did not, and the console belongs to whoever happened to be tailing the
function. Fixed with a `journalled()` helper whose `finally` writes the events either way.
Safe here and not in a turn, because the sequence belongs to the dungeon and a retry
appends after them rather than colliding.

The structure pass is the one exception and cannot be fixed: when IT fails there is no
dungeon row for the events to hang on, so the console really is the only record.

### 7.9 `?raw`, answered

The API is built with **Vite in SSR mode** into a single bundled `api/index.js` with the
markdown inlined. Vercel deploys the prebuilt file; the same bundle runs under plain
`node` locally. `dev/raw-md.ts` (§6.5) stays the CLI's story, and no codegen step is
needed. `vite.config.ts` loses the `journal()` middleware and the `/api/anthropic`
proxy — the API owns both now.

---

## 8. Phase 11 — Accounts and ownership ✅ **BUILT**

Phase 10 shipped an API that asked for no credentials and a database in which
nothing had an owner. Both are closed. **The motivation was sharper than "we
should have logins": `POST https://aidungeon.vercel.app/api/dungeons` was
unauthenticated and spends the project's Anthropic key.**

**No BYOK and no model choice** — those are Phase 13. The one thing that landed
early is `profiles.tier` (`byok` | `vip`), because a tier column added after
there are accounts has to decide what the existing ones are. Nothing reads it.

### 8.1 The decisions

| | |
|---|---|
| sign-in | **Supabase Auth, Google only.** One provider, one button, no password reset flow, no credential store of ours |
| gate | **Everything under `/api` except `/api/health`.** The exception is the twice-weekly cron, which holds no session and touches nothing |
| invite | **Google's OAuth consent screen, left in Testing mode** — up to 100 test users by email address. The invite list is a console setting, not code |
| characters, runs | private to their owner, no other read path at all |
| dungeons | owned; a non-owner may see a **summary** and never the `doc` |
| the old rows | deleted. Five rows of 10a/10b smoke-test data |

**A run is two private things at once** — our log when something goes wrong, and
the player's save file — and neither wants an audience. `listRuns`/`getRun` are
owner-filtered and there is nothing else.

### 8.2 The token, and why there is no secret

The project signs with **asymmetric ES256** keys, so `src/server/auth.ts`
verifies signatures against the public JWKS with `jose`'s `createRemoteJWKSet`.
**There is no `SUPABASE_JWT_SECRET`** to leak, rotate or forget in an
environment. The key set is module state and caches, refetching only on an
unknown `kid`, which makes rotation a non-event — the same reasoning `db.ts`
gives for its pool.

Verified locally rather than by asking `GET /auth/v1/user`: that is a network
round trip per request, and a size-5 generation fires twelve chunk requests at
once.

**`audience: "authenticated"`** is checked, which is also what keeps anonymous
sign-ins out if anybody ever enables them.

**Every refusal is the same bare 401, `sign in first`.** A caller learns it is
not signed in and nothing else — not expired-rather-than-forged, not whether the
user exists. Asserted in `auth.test.ts` against a real key pair generated per
run, with the JWKS served from a stubbed fetch.

### 8.3 Ownership is a parameter, not a check

**The rule: ownership goes in the `where`, not in an `if` after the read.** So
another player's row is indistinguishable from one that does not exist, and the
API never confirms that something it will not serve is there. `mustGetDungeon`
and `mustGetRun` both take the owner; there is no arrangement of calls in which
a handler reads first and remembers to check second.

- Every character, dungeon and run statement in `repo.ts` carries the owner.
- **`lockRun` and `commitTurn` carry it too** — belt and braces, the author's
  call. The run was already read under an owner filter, so reaching the write
  with someone else's means a handler forgot; the write is the last place that
  can still refuse.
- **The upsert is the one way a write could leak.** `saveCharacter`'s
  `on conflict do update` conflicts on the id alone, so it would have overwritten
  a row it did not own. The update branch carries `where characters.owner_id`.
- **Dungeon writes require being the maker**; that hole exists only because
  dungeons are the one thing another player may ever see.
- CORS narrowed from a bare `cors()` to the Vercel origin, localhost, and
  anything in `CORS_ORIGINS`.

### 8.4 The dungeon key split 🔴 **a Phase 10a mistake, undone**

`GeneratedDungeon.id` is `dungeon_<seed in base 36>`
(`dungeon-blueprint.ts:786`) and is derived on purpose — the determinism rule is
that a seed names a dungeon. **10a then used that name as the Postgres primary
key**, which is fine while there is one copy of each seed in the world and breaks
the moment two players each want their own copy of seed 4201.

The two jobs are now split: **`dungeons.id` is a meaningless uuid naming the
ROW**, and **`dungeon_key` is the derived name, deliberately not unique**. The
document keeps its own id untouched, so nothing in the engine changed.
`runs`, `dungeon_events` and `generation_chunks` moved to the uuid.

**Done now rather than later because the tables were empty.** Five test rows, no
data to move; the same change against real dungeons is a migration with risk in
it. `dungeons_cache_idx` on `(seed, size, level) where status = 'complete'` is
already in place for the lookup that has not been written yet — see §9.

### 8.5 The client

`store/auth.ts` is the only place a token is attached. Before it,
`store/characters.ts` and `runtime/remote-session.ts` called bare `fetch` in four
places, and **the 409 resync path was one of them** — it would have gone out
unauthenticated and failed as a 401 inside the handler for a 409, which is the
hardest kind of failure to see. `remote-session.test.ts` now covers exactly that
path.

- **The fetch is injected into `remote-session.ts`, not imported.** The runtime
  never depends on the store's auth module and so never constructs a Supabase
  client merely by being imported.
- **The Supabase client is made on first use, not at import.** Laziness is
  load-bearing: `?offline` and `?stub` need no account, no project and no keys,
  and a client built at module scope threw `supabaseUrl is required` and took
  `App.test.tsx` down with it. Nothing local should have to own a Supabase
  project to run.
- **`VITE_SUPABASE_ANON_KEY` reaches the browser and must.** That is not a hole
  in the CLAUDE.md rule, which is about the ANTHROPIC key and is untouched — the
  model is still reached only by the server. The publishable key identifies the
  project and grants nothing, because every table has RLS on with owner-only
  policies.
- `?offline` and `?stub` stay local and stay account-free.

### 8.6 RLS, and what it is actually for

**The API is the enforcement; the policies are the backstop.** The server reaches
Postgres over a direct connection as a role RLS does not apply to, so what keeps
one player out of another's run is the `where owner_id = $n` in `repo.ts`. The
policies exist for the *other* door: the publishable key ships in a page by
design, and anything that picks it up should get its own rows and nothing else.

**So every policy is owner-only, including dungeons.** RLS cannot express "these
columns only" without column grants, so it says nothing at all and the API serves
the summary from its privileged connection. Stricter and simpler — the backstop
should not be the thing deciding what a summary is.

The Supabase linter caught one thing immediately: `handle_new_user()` is
`SECURITY DEFINER` in `public`, so PostgREST exposed it as
`/rest/v1/rpc/handle_new_user`. `EXECUTE` is revoked from `public`, `anon` and
`authenticated`; only the trigger calls it. Advisors clean afterwards.

### 8.7 What proves it

**818 tests, build clean** — 13 new in `auth.test.ts`, 2 in
`remote-session.test.ts`.

**And a third suite that needs a database.** `npm run test:db`, its own config,
`*.dbtest.ts`, **explicitly invoked and not part of `npm test`** — because it
cannot run without `DATABASE_URL`, and §2.13's own rule is that a test which
skips itself is a test that lies. It runs against the real database inside
transactions that are always rolled back, which is the method §7.6 used by hand.
**This closes 10a's "the SQL is verified, the driver binding is not."** 13 cases:
each of characters, dungeons and runs invisible to a second account; the upsert
refusing a stolen id; two players holding one seed; a stolen `commitTurn`
refused with A's version and state untouched; the profile trigger firing.

**It found a real defect on its first run.** `commitTurn`'s rejection branch
re-read the run AS THE CALLER to hand back current state, found nothing when the
caller was not the owner, and threw `no such run` — a 500 for what is a refusal.
`CommitResult` gained a **`gone`** reason and `playTurn` maps it to 404.
Unreachable through the handler, which filters by owner first; answered anyway,
because the last door in the system should refuse in the shape everything else
refuses in.

**Probed against a running server**, which is what proves the gate rather than
the middleware: `/api/health` 200, `GET /api/characters` 401, **`POST
/api/dungeons` 401 — the token-spend hole, refused before anything is spent** —
a garbage bearer 401, and an `Origin: https://evil.example` preflight answered
with no `access-control-allow-origin` at all.

### 8.8 Deployed, and what deploying taught us 🔴

**Production probed after the deploy, and the hole is shut:** `/api/health` 200,
`GET /api/characters` 401, **`POST /api/dungeons` 401 — refused before a token is
spent** — a forged bearer 401, and an `Origin: https://evil.example` preflight
answered with no `access-control-allow-origin` at all.

**A GIT PUSH DOES NOT DEPLOY THIS PROJECT, AND NEVER HAS.** The push of this
phase triggered a build that failed in 130ms:

```
Error: The pattern "api/index.js" defined in `functions` doesn't match
any Serverless Functions inside the `api` directory.
```

`api/` is gitignored — correctly, per §7.9: it holds only the bundle, so Vercel
has no TypeScript there to build with the bundler that cannot read `?raw`. But
that means the GitHub clone has no `api/index.js`, and Vercel validates the
`functions` glob **against the clone, before `buildCommand` runs** — so the file
`npm run build` is about to produce does not exist yet at the moment it is
checked. There is an identical 1s failure from the day before, so this has been
true since 10b; 10b reached production by `vercel --prod` from the author's
machine, which uploads the local tree including the built bundle and so matches
the pattern.

**`vercel build --prod` locally does not work either**, but for an unrelated
reason: the function packaging step dies with
`EISDIR: illegal operation on a directory, readlink 'api\index.js'` on Windows,
leaving `.vercel/output` with a `static/` and no `functions/`. The bundle itself
is a perfectly ordinary file; this is the CLI on this platform.

✅ **SETTLED: `api/index.js` is committed.** `.gitignore` became `api/*` plus
`!api/index.js`, so the bundle is tracked and anything else landing in `api/` is
still ignored — a `.ts` beside it would invite Vercel to build the source with
the bundler that cannot read `?raw`, which is the whole reason §7.9 puts a bundle
there.

The alternative was leaving it CLI-only and writing `npx vercel --prod` down
somewhere. Rejected: a main branch that cannot deploy itself is a trap for the
next person, and the GitHub integration would show a failed deploy on every push
forever. The cost is a 516kB generated file that churns, softened by
`.gitattributes` marking it `linguist-generated=true -diff` so a one-line source
change is not reviewed as half a megabyte of diff.

**`npx vercel --prod` still works and is still the way to deploy without a
commit.** What changed is that a push now deploys too.

`vercel build --prod` remains broken on Windows and is not the path.

### 8.9 Deliberately not in this pass

- **Browse and duplicate someone else's dungeon, and the generation cache.** The
  schema is ready for both — `DungeonSummary`, `dungeon_key`, `dungeons_cache_idx`
  — and neither endpoint is written. §11 carries them.
- BYOK, model choice, and anything that reads `profiles.tier`. Phase 13.
- Per-user rate limiting. The invite list is the only quota today.
- Sharing a run by link, account deletion, a second provider.

---

## 9. Phase 12 — Run continuity ✅ **BUILT**

Phase 10 and 11 built persistence for characters, dungeons and runs. Nothing used
it. A run was written to Postgres on every turn and then unreachable the moment
the tab closed; a character could be sent down twice at once, into two dungeons,
with two divergent copies of the same sheet; and a character who died was
indistinguishable from one who had never been anywhere.

This phase makes a character an identity that persists ACROSS runs rather than a
sheet copied into one.

### 9.1 Nothing is rebuilt from the journal

The obvious reading of "resume a run" is: take the dungeon and the journal and
replay them forward. **That work is already done and should not be done twice.**
`runs.state` is a whole `RunState` in a jsonb column — `entities`, `pc`,
`currentRoomId`, `rngDraws`, `transcript`, and `log`, which is the scrollback the
player actually reads (`store/game.ts`). `GET /api/runs/:id` already returns
`{ run, dungeon }`, and `remote-session.ts` has already been landing exactly that
shape since Phase 10, on the 409 resync path.

So **resuming is one fetch and one `setState`**. A replay path would be a second
reconstruction of a state the server already writes in full every turn, and a
second one is a thing that can disagree with the first. The journal explains a
run; it is not its save file.

What was actually missing is small and all around the edges: a lock, an abandon
verb, an entry point, and a scoreboard.

### 9.2 The lock is an index, not a flag

**No new column, and no new concept.** `runs` already carries `character_id` and
`status`, and "this character is in a run" is exactly `status = 'active'`. The
rule is stated once, in the only place that cannot be forgotten:

```sql
create unique index runs_one_active_per_character
  on public.runs (character_id) where status = 'active';
```

That is the whole migration — `abandoned` has been in the `runs.status` check
constraint since Phase 11, put there by a phase that anticipated this one.

**The database refuses the second run rather than the handler remembering to.**
`POST /api/runs` catches the unique violation and answers 409 naming the run they
are already in. A boolean on `characters` would have been a second source of
truth for something `runs` already knows, and the failure mode of a stale flag is
a character locked out of the game with no run to abandon.

A NULL `character_id` does not conflict in a partial unique index, so a run
orphaned by a deleted character — `on delete set null`, per Phase 11 — stays
legal and locks nobody.

### 9.3 Abandoning is a stage

`Stage` gains `"abandoned"` and it joins `TERMINAL_STAGES`. That one line is what
makes the rest of the change safe: every table keyed by stage is
`Record<Stage, …>`, so the compiler walks through `STAGE_TONE`, `STAGE_NAME` and
`STAGE_HINT` in `theme.ts`, the `Ending` union in `InputArea.tsx`, and `statusOf`
in `repo.ts`. **A stage added without deciding how it reads does not compile**,
which is the reason the stage table was built that way in Phase 3.

`POST /api/runs/:id/abandon` is the cheapest route in the API: no model call, no
dice, no referee. It moves the run to `abandoned` and commits through the same
compare-and-swap as any turn, so the lock comes off by the same path everything
else uses.

**Two doors to it**, because the two situations are different. From the Characters
screen, where a player discovers a character they cannot use and needs a way to
free them. And from inside the run, which is where a player actually decides to
give up. Both confirm first — it is not undoable and the run is deleted from
nothing, it simply ends.

### 9.4 The counters are derived, and cannot drift

The four counters asked for — died, abandoned, finished with the objective,
finished without — **are already the four terminal run statuses.** Nothing needs
to be recorded, only grouped:

```sql
select character_id, status, count(*)::int
  from runs where owner_id = $1 and character_id is not null group by 1, 2
```

`dead` · `abandoned` · `escaped` (out without it) · `goal_met` (out with it).

Stored counter columns were the alternative and are rejected: they need a write
on every ending, that write can fail independently of the ending it describes,
and a counter that disagrees with the rows it summarises is worse than no counter
— it is a scoreboard that lies. This one is a projection of the rows and cannot
be wrong.

**`GET /api/characters` changes shape.** It served `PlayerCharacter[]`; it now
serves the person plus what has happened to them:

```ts
interface CharacterEntry {
  sheet: PlayerCharacter;
  record: { dead: number; abandoned: number; escaped: number; goalMet: number };
  activeRun?: { id: string; dungeonId: string; dungeonName: string; turnCount: number };
}
```

`store/characters.ts` remains the only module that knows where characters live,
which is the promise it has carried since Phase 4.5 and has now been paid twice.

`dungeonName` is a join to `doc -> 'pass' ->> 'name'`; `turnCount` is
`state ->> 'turnCount'`, which is cheap and honest — **IN A RUN · THE SUNKEN
VAULT · TURN 14**. That closes the badge `Characters.tsx` has carried as
"deferred, not dropped" since Phase 5, and it is deferred no longer because the
state it needed is finally written down.

### 9.5 What a run leaves on the character

- **dead and abandoned leave the sheet untouched**, which IS "as they were before
  they went down", for free. Nothing writes `characters.sheet` during a run — the
  run mutates its own `state.pc` — so the stored sheet is still the pre-run one
  and there is no snapshot to take and no restore to perform. The only trace is
  the counter, which is a row in `runs`.
- **escaped and goal_met write `run.state.pc` back over the sheet.** Gear and
  coin carry out. The id is the same, so the Phase 11 upsert lands on the same
  row.

**Hit points return to max on the way out**, and this is a decision rather than a
consequence. There is no downtime, no rest, and no healing outside a run: a
character who surfaces at 1/15 can only die next time, which quietly converts
"escaped alive" into a delayed death and makes the escape ending worthless.

**Settled as the standing answer, with the way back written down.** `carriedOut`
in `repo.ts` carries the block comment: the code change is one line, and what it
needs beside it is some route back to full, or the ending stops meaning anything
— a flat partial heal between runs, rest as a real action with a real cost (which
is where Knave points and what `turnCount` was put in `RunState` for), or healing
bought in the shop, which is still open out of Phase 5. Whichever lands, that
function is where it goes and the db suite's "keeps what they carried, and heals
them" is the test that changes with it.

### 9.6 Resume, and the run that was interrupted mid-turn

`PlayableSession` gains `resume(runId)`. The in-process `GameSession.resume(saved,
runId)` is **renamed `restore`** — two callers — because two different shapes
under one name on a shared interface is how a caller ends up passing the wrong
one.

**A run that resumes into a busy stage lands on `error`.** This is the case worth
building for: a function that timed out or was deployed over mid-turn leaves the
row saying `thinking`, and `thinking` closes the input. Without this the player
resumes into a game that will never ask them for anything again. So resume
coerces a busy stage into `error` on the client, which is the one stage that
offers a way on — and the `pending` request stored on the run is what lets the
retry actually repeat the ask rather than bump the version and do nothing.

No write, no version bump: the run in the database still says what it said, and
the next thing the player does decides what happens to it.

**And a way back out.** At a terminal stage the player returns to Characters,
which replaces `InputArea`'s "reload to begin again" — copy written when there
was one character and one dungeon and reloading really was the only way on.

### 9.7 What does not change

- **Deleting a character in a run is refused**, with the run named. Abandon
  first. The alternative — cascading to `null` and orphaning a live run — is a
  save file nobody can reach and nobody can end.
- **`?offline` and `?stub` are untouched.** One local character, a zeroed record,
  no lock and no resume. Interface work still needs no Postgres and no account,
  which is the rule those switches exist to keep.

### 9.8 What proves it

**850 tests, build clean** — 32 new, plus **36 in the database suite**, up from 13.

- **`ownership.dbtest.ts`, against real Postgres.** The index refuses a second
  active run. A character is free again the moment their run ends, **asserted for
  all four endings** — which is what says the lock lives in a partial index and
  not in a flag somebody has to remember to clear. Another player's active run
  does not lock your character and is not even visible. The counters count the
  four endings, ignore a run still going, and count only the owner's rows. A
  survivor's gear carries and their hit points do not; death and abandonment
  write nothing at all; and **a character deleted mid-run is not resurrected by
  the write-back**, which is the case the update-rather-than-upsert exists for.
- **`remote-session.test.ts`.** Resume is ONE request and lands both the state
  and the version, so the first turn after it answers the version the server
  actually holds. A run stored as `thinking` resumes to `error` with the retry
  live and **nothing written** — the row still says what it said. Abandon posts
  the version and nothing else, and is the one verb that predicts no stage,
  because a terminal guess could show a player an ending that never landed.
- **`screens.test.ts`.** A character in a run is offered Resume and Abandon, and
  is offered neither Send down nor Delete — the two the game would refuse. The
  badge names the dungeon and the turn, off by one from `turnCount` in the same
  direction the input area's tracker is. The record reads at 0 (silence, not four
  zeroes) and at 12.
- **`InputArea.test.tsx`.** The way out is offered for as long as the run is
  live, including while the referee is working; every ending offers the way back.
- The stage-exhaustiveness tables, which `"abandoned"` broke until they were
  filled in. That is what they are for.

**Probed against a running server**, which is what proves the gate rather than
the middleware: `/api/health` 200, and **`POST /api/runs/:id/abandon` 401 with no
token and 401 with a forged one** — the new write is behind the same door as
everything else.

### 9.9 The handler layer, closed

§9.8 shipped naming a gap: `ownership.dbtest.ts` covered every statement in
`repo.ts` and `auth.test.ts` covered the gate, and **nothing covered the layer
between them, where a request becomes a status code.** Every refusal Phase 12
added lives exactly there. `app.dbtest.ts` is that layer, 13 cases, and the db
suite is **36 tests, up from 23**.

**It is a `dbtest` because `createApp()` cannot be built without a database and
an Anthropic key** — it configures the transport at construction and every route
reads Postgres. Faking either would be testing a fake, which is the thing these
files exist not to do. A real ES256 key pair is generated per run and a real
token minted from it, verified through `jose` against a JWKS served from a
stubbed `fetch` — the `auth.test.ts` arrangement. **A suite that stubbed
`requireUser` would be a suite in which every request arrived pre-authorised.**

**Cleanup is the schema's, not a transaction's.** The other db file wraps each
case in a rolled-back transaction; that is not available here, because the
handlers open their own connections through `db()` and know nothing about a
transaction the test is holding. Everything Phase 11 built cascades from
`auth.users`, so deleting the one test account at the end takes its characters,
dungeons, runs, chunks and events with it.

What it proves: a free character goes down and a busy one is refused **with the
run named**, from a different dungeon so nothing but the character can be what
refused it; a partial dungeon and another player's dungeon are both turned away,
the latter as a 404; an abandon with no version is a 400 and a stale one is a 409
carrying what is actually true, **with the run still `active` after both**;
ending a run twice is refused; abandoning frees the character; deleting somebody
still down there is a 409 that says *abandon it first* and leaves them on the
roster, and goes through once the run is over; and the roster's record moves
from four zeroes to one abandoned while `activeRun` disappears.

🔴 **It was flaky first, and the flake was the test's fault.** Every case built
its own finished dungeon, so the suite wrote the entire world — half a megabyte
of jsonb — thirteen times, and roughly one run in three failed one of those
inserts with `invalid byte sequence for encoding "UTF8": 0x00`, never twice in
the same place. Two dungeons are made once for the whole file now: a character
holds one run at a time and every case mints its own character, so one world
serves nearly all of them and the second exists only so the double-run refusal
can be shown to be about the CHARACTER. **A flaky test is worse than no test**,
so this was fixed rather than retried — three consecutive clean runs before it
was called done.

---

## 9a. Phase 13a — A world outlives the run played in it ✅ **BUILT**

The first of the three things Phase 11 specified and deliberately did not build
(§8.9). **The other two are still open and §11 carries them**, with one premise
corrected below that they should start from rather than from the Phase 11 text.

Every run before this bought a fresh dungeon whether or not the player already
had one they wanted to go back down, **because there was no way to say so**. A
world was written for N+2 model calls, played once, and then unreachable: `GET
/api/dungeons` had been serving summaries since Phase 10 with nothing on earth
fetching them, and `RunSetup` always minted a seed. The dungeon was the most
expensive object in the system and the only one with no second use.

### 9a.1 What was found before anything was written

- **`POST /api/dungeons/:id/duplicate` had nowhere to land.** No screen listed
  dungeons and nothing could run one. Built on its own it would have been an
  endpoint no client could reach, so the phase is the endpoint *and* the way to
  a world that already exists — `beginIn` on the session, and the World question
  at the top of run setup.
- 🔴 **`(seed, size, level)` is the wrong key for the generation cache, and the
  Phase 11 spec's premise for it does not hold.** `App.tsx`'s `seedForNewRun()`
  draws from `randomSeed()` — `seeds.ts:52`, uniform over 0–999,999 — so two
  players landing on one seed at one size and level is a coincidence that does
  not happen at this scale: `dungeons_cache_idx` does not begin to pay until the
  corpus is thousands of dungeons **per (size, level) bucket**. The author's call
  when this was put to them is that seeds do not matter after generation, and
  what is wanted is sharing plus saving calls. **So 13b keys the pool on
  `(size, level)` alone** — reuse any complete world of the right shape this
  player does not already hold — which hits the first time anybody has built one.
  That needs an index `dungeons_cache_idx` cannot serve, since it leads on
  `seed`.
- **Two dungeons from one seed are not the same dungeon.** The seed fixes the
  structure, the stocking and the floorplan (`deriveSeeds`, and the CLAUDE.md
  rule that the model never generates a number); the prose, the names and the
  objective text are content-pass output. **The same skeleton wearing different
  writing.** This is why the second-click guard below matches on the source row
  and not on `dungeon_key`.

### 9a.2 Duplicating

`repo.duplicateDungeon` is **the one statement in `repo.ts` that reads a row
without asking whose it is**, and §8.3's rule is not being bent: what it reads
cross-owner is the ROW, and what it does with it is write a new one belonging to
the caller. Nothing about the source is ever returned — the reply is
`{ dungeonId, already }` and no name, no objective and no `doc`. *A dungeon is
the one thing another player may see* now means exactly one thing: they may have
one of their own like it.

| | |
|---|---|
| the row and its `doc` | copied, under a fresh uuid. `doc.id` is left as generated — that is the name of the WORLD and both copies are that world |
| `dungeon_events` | **copied**. A run's journal is generation then play (`readJournal`), so a copy without them is a world whose record begins after it was built, and nothing would say so. The `kind: "dungeon"` baseline `journal-render.ts:170` prints lives here |
| `generation_chunks` | **not copied.** Only `finish` reads them, a complete dungeon never finishes again, and they are the unapplied raw responses — the largest thing in the schema and the least use to anyone holding the applied world |
| a partial dungeon | refused, as `undefined` → 404. Half a world is not worth copying and the copy would have no chunks to finish from |

**"Not there" and "still being written" are one answer**, for the same reason
"not there" and "not yours" are one everywhere else in this API.

**`dungeons.copied_from` is provenance, not a uniqueness rule.** It exists for
the second click: pressing *take a copy* twice must not mint two half-megabyte
rows, and there is no other way to tell the player already has this one. There is
deliberately **no unique index** — generating seed 4201 twice yields two
different worlds and stays legitimate; what is refused is copying one *source*
twice, the only case where the second row is guaranteed identical to the first.
`on delete set null` and not cascade: a copy is a standalone world and must
survive its source's owner deleting their account.

### 9a.3 The way to a world that exists

`beginIn` on `PlayableSession` — **one request instead of N+3, and none of them a
model call.** It takes a dungeon id and NOT a `RunRequest`: size, level and seed
are facts about a world that already exists, and a client restating them could
state them wrongly, leaving the server to decide which of the two it believed.
Optional on the interface for the same reason `resume` is — `?offline` has one
fixture and no database to name a row in.

`RunSetup` **asks which world first**, and size and level appear only under the
branch that is actually rolling one. Beside a chosen dungeon they would be
controls that change nothing, which is worse to put in front of a player than an
absence. `onConfirm` hands back a **tagged union** — a size and a level, or a
dungeon id, never both — so there is no shape in which the screen answers one
question twice. The list is read when the screen opens rather than kept in step
with the roster: it is asked once per run, and a list fetched at the moment it is
shown cannot be stale.

### 9a.4 What proves it

**899 tests and build clean** (887 after the shop), plus **47 in `npm run
test:db`** — eleven of them new.

- `ownership.dbtest.ts`: the copy belongs to whoever asked and the original is
  untouched and still invisible to them; the generation journal comes across and
  the copy's own sequence carries on from it; a second duplicate returns the
  first; **a world of the same seed the player already owns is not mistaken for
  the one being asked for**; a partial and a missing dungeon both answer nothing.
- `app.dbtest.ts`: a stranger's dungeon is a 404 to `POST /api/runs` before the
  copy and still a 404 after it, while the copy itself can be walked into; the
  reply carries `dungeonId` and `already` **and nothing else**; the route is
  behind the gate like everything under `/api`.
- `remote-session.test.ts`: `beginIn` is `POST /api/runs` and the room entry and
  **nothing else** — the failure mode is a path that quietly generates anyway.
- `RunSetup.test.tsx`, new and in the jsdom project, because choosing a world is
  a `useState` branch a static render cannot reach: the two answers are different
  requests, the cost line disappears when a written world is chosen, changing
  your mind goes back, and **a chosen world that stops existing under the screen
  falls back to a new one** rather than becoming a run into a dungeon nobody can
  name.

---

## 9b. Phase 13b — The library ✅ **BUILT**

13a made a world reusable and left it unshared: the endpoint could copy any
finished dungeon, but **the only id a player could name was one of their own**.
This is the shelf, and it is the second and last cross-owner read this project
has.

### 9b.1 What crosses the line, and what does not

`GET /api/dungeons/library` serves **`DungeonSummary` and nothing else** — name,
objective, size, level. Never `doc`, which is every answer in the world; a browse
screen that could read one would be a walkthrough for a dungeon nobody had
walked. The summary shape has been sitting in `repo.ts` since Phase 11 with
nothing to serve it, and this is what it was for.

**No maker is named.** The only name this project holds for an account is
`profiles.email`, so a shelf that printed one would be a way to enumerate the
invite list. A world is offered on what it is.

### 9b.2 Paging, and the three defects the tests found

**Keyset and not offset.** A batch boundary has to survive a dungeon being
written while the player is scrolling: `offset 12` after an insert shows row 12
twice and never shows row 13. The cursor is `(created_at, id)` of the last row
actually seen, **opaque to the client** for the same reason a run's version is an
integer — nothing outside `repo.ts` knows what is in one, so nothing outside it
can compose a flattering one.

**The id is in the key because `created_at` is the transaction clock.** Two
dungeons written in one transaction share it exactly, and a page break landing on
that tie would drop a row or repeat one forever. `dungeons_library_idx` is
`(created_at desc, id desc) where status = 'complete'`.

🔴 **Three real defects, all found by `ownership.dbtest.ts` and none of them
visible by reading the code**:

| | |
|---|---|
| **Microsecond truncation silently dropped rows.** `${cursor}::timestamptz` makes the server describe the parameter as a timestamp, so postgres.js serialises the string through its `Date` encoder — and a JS `Date` holds **milliseconds**. `…:22.123456+00` was bound as `…:22.123+00`, strictly less than the row it came from, so `<` skipped every row sharing that microsecond. It lost **exactly the rows a `created_at` tie put at the break** — the case the keyset was designed around. Fixed with `::text::timestamptz`, which makes it a text parameter Postgres converts itself |
| **A malformed cursor was a 500.** `?cursor=x\|y` reached the same binding and postgres.js threw `RangeError: Invalid time value` while serialising, before the statement was sent. A bad page token is a caller saying nothing legible, not an internal error; `readCursor` validates the uuid and the timestamp and reads anything else as no cursor at all |
| **`limit=0` returned twelve.** `Math.trunc(…) \|\| LIBRARY_BATCH` was written as a NaN guard and also swallowed a stated zero, turning the smallest possible ask into the largest. An explicit `Number.isFinite` check separates "unreadable" from "small" |

A fourth was found by `Library.test.tsx`: **the `IntersectionObserver` never
attached**, in a browser as much as in a test. The foot of the shelf does not
exist on the render the effect first runs on — the screen still says *Reading the
shelf…* — and `next` is stable, so an effect keyed on a `useRef` ran once against
`null` and never again. The node is `useState` behind a callback ref now, so the
effect is keyed on it actually being there.

🔴 **And a lesson about `*.dbtest.ts` worth keeping**: these run against the real
database, and the author's own dungeons are on it. To a freshly minted test user
every one of them is "somebody else's", so `toEqual([])` and `toHaveLength(5)`
were both wrong. Every assertion in `the library` is about **that test's own
rows** — which costs nothing, because `created_at` being the transaction clock
makes them strictly the newest on the shelf and therefore exactly the front of
the ordering.

### 9b.3 The screen

`Library.tsx`, reached from **a second button on a character's row**. `Send down`
rolls a world for a minute and a real bill; `Browse worlds` picks one somebody
already wrote for neither. Far enough apart to be separate doors rather than a
field on one, and absent — like the shop — for anybody already in a run, and
absent entirely on `?offline`/`?stub`, which have no library to read.

**The character comes with the player.** Every card's button says their name,
because the choice is not *add this to my library* — it is *send Testy down this
one*, and the next thing that happens is the dungeon.

**Two triggers for the next batch, and the button is the floor.** The sentinel at
the foot of the grid is a real button; an `IntersectionObserver` presses it early
when the player scrolls near it. An observer is a convenience that can fail to
fire — no layout, no constructor, a container that never scrolls — and a shelf
that then has no way to show its next batch has rows nobody can reach. So the
observer is the polish rather than the button being a fallback that has to be
detected into existence.

**Choosing is two requests and no model call**: duplicate, then `beginIn`. The
copy cannot be skipped — `POST /api/runs` reads the dungeon under an owner
filter, so the source is a 404 to this player until they hold one of their own —
and it is idempotent, so browsing to the same world twice does not accumulate
rows.

### 9b.4 What proves it

**913 tests and build clean**, plus **58 in `npm run test:db`**.

- `ownership.dbtest.ts`: the viewer's own worlds are absent and other people's
  are there; a partial one is never shelved; the summary carries no `doc`, no
  `cursor` and no owner; batches partition the shelf with no gaps and no repeats
  **across a break that is always a `created_at` tie**; the `limit + 1` probe row
  never leaks; four shapes of malformed cursor all read as the front of the shelf.
- `app.dbtest.ts`: the route serves other players' worlds and not the caller's;
  it pages with the cursor it handed out; **it is not shadowed by the `:id`
  routes** — `library` is a plausible dungeon id, and a test that only checked the
  query would pass against a server answering *no such dungeon: library*; and it
  is behind the gate.
- `Library.test.tsx`: batches append rather than replace; the cursor sent is the
  last row's; two triggers arriving at once ask once; a failed batch keeps what is
  already on the screen; a card shows what a summary holds and no address for a
  person; the pressed card says what it is doing and the others shut while it
  does; and the observer, stood up by hand because jsdom has none, asks for the
  next batch when the foot comes into view.

---

## 10. Order of remaining work

```
  Phase 8a A7 ─┐
           8b ─┤
           8c ─┼─ independent of each other, any order or in parallel
           8d ─┤
           8e ─┤
           8f ─┘
  Phase 7   — the three remaining affordances, independent
```

**The shop is done** and no longer on this list — §3.7.

**8a is done bar A7, and no longer leads this list.** It led because a machine that cannot
finish a turn makes every other item hard to see: A8 refused a commit the player was
entitled to, and A9 printed the referee's discarded drafts as narration. Both are fixed —
A8 by asking the guard the right question, A9 by moving the post onto the commit so there
is nowhere for a draft to go.

**What is left of 8a is A7**, and it is a different kind of thing: a DOM shift nobody has
reproduced yet, which is an interface report rather than a turn the machine got wrong. It
belongs with 8b, which is the rest of the interface work, and it has no claim on going
first — **reproduce it before fixing it**, and if it will not reproduce, that is worth
knowing before a session is spent on it.

**Two soft orderings among the rest.** 8f's exit-count fix had to land before 8c writes
step-file rules about exits, or 8c would be writing instructions for a room block that was
about to change. **It has landed** — the geometry sentence no longer counts a concealed
way, the ways-out list marks one, and the content pass no longer writes counts or concealed
ways into a room's `base` — so the step-file line is now unblocked. And 8e's creature work reads
much better after 8f's `properNamed`, since "who is this person" and "what do they do about
what was just said" are the same scene.

---

## 11. What is still open

**Open outside Phase 8**, from Phase 5 and named in §3.6:

- ~~The shop~~ — §3.7, **done**. Slot cost reads as loudly as price, per the brief.
- ~~Whether a made character survives a reload~~ — settled in Phase 10; the record is the
  sheet, whole, in a jsonb column. See the header of `store/characters.ts`.

Everything else settled through Phase 7 is either in §2 or in the code.

**Open out of Phase 9**, and worth doing before the server work rather than after:

- ~~A generation failure is undebuggable~~ — §6.7, **done**. Nothing left open.

**Open out of Phase 11.** All three were specified with the phase and left out of
it, because the schema they need landed with the ownership migration and the
endpoints did not. **The duplicate half is built — §9a** — and what is left is:

- ~~Duplicate another player's dungeon~~ ✅ §9a. `POST /api/dungeons/:id/duplicate`
  copies the row, the `doc` and the generation journal under a new uuid with the
  new owner. **This is why the key split had to happen first**: under 10a's
  schema a copy collided on the primary key.
- ~~Browse — the screen that makes duplicating reachable from outside~~ ✅ §9b.
  `GET /api/dungeons/library` in keyset batches, `Library.tsx` reading it down a
  grid at a time, and a *Browse worlds* button beside each character.
- **Use existing dungeons as a generation cache** — and 🔴 **not on
  `dungeons_cache_idx`, whose key is wrong.** §9a.1 has the reasoning and the
  author's call: seeds do not matter after generation, so the pool is keyed on
  **`(size, level)`** and hands back any complete world of the right shape this
  player does not already hold. That hits the first time anybody has built one,
  where the seeded key does not hit until the corpus is in the thousands. Still
  to settle: whether a hit duplicates silently or is offered, and whether a
  player may opt out — noting that opting out buys the same skeleton for real
  money, so it may be a dev switch rather than a player control.
- **Nothing rate-limits a signed-in player**, and generation is the expensive
  call. The Google consent screen's Testing mode — 100 invited addresses — is the
  only quota today, which is enough while it is invite-only and is not enough at
  the point Phase 13 lets anyone in. **It cannot be in-process**: one stateless
  Vercel function and no Redis on Hobby, so the counter is in Postgres and is
  charged explicitly at the top of the handlers that call the model rather than
  in middleware that would have to guess what a route costs. **And it must not
  read `profiles.tier` yet** — every account defaults to `byok` while in fact
  spending the author's key, so a tier-aware limiter today exempts everyone.

**Open in Phase 8**, none of it blocking the rest of 8a, which is fully specified:

- ~~Whether narration moves onto the commit or the last text block simply wins (8a A9)~~
  ✅ **Settled: the commit.** Solution 1, in full — the cheap one was never written. §5, A9.
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

## 12. Non-goals for this prototype

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
