# Dungeon Crawler — Coding Plan

Derived from `BUILD-PLAN.md` and `DESIGN-BRIEF.md`, against the seven engine modules
as they actually stand today. Where this document departs from BUILD-PLAN it says so
and why.

Status of the repo at time of writing: `src/engine/` holds seven `.ts` files and
nothing else. No `package.json`, no `tsconfig.json`, no test runner, no lockfile.

---

## Part 0 — Findings that change the plan

These are things BUILD-PLAN assumes to be true that are not, or that it leaves open
and shouldn't. Each is assigned to a phase below.

### 0.1 Blockers (need author input or a missing file)

**B1. ~~The `dungeon-loop` skill is not in the repo.~~ LANDED** — `SKILL.md` plus six
step files are now present. It is a complete referee and Phase 3 can proceed on it.
It is **not** shaped the way BUILD-PLAN §4.1/§4.4 assumed, though, and the difference
changes the context policy — see §0.5. Two pieces still need authoring: the room-entry
pass and the `commit_state` envelope contract.

The files are currently at `src/engine/*.md`, flat, while `SKILL.md` references them
as `steps/<n>-<name>.md` and sits at the repo root. Phase 0 moves them to
`src/runtime/prompts/dungeon-loop/` with `SKILL.md` at its root and the six under
`steps/`, which is both what the skill's own links expect and what keeps markdown out
of `src/engine/` (CLAUDE.md: that directory is framework-free TypeScript runnable
under vitest).

**B2. ~~`Knave_1_0.pdf` is not in the repo.~~ RESOLVED** — `docs/Knave 1.0.pdf` has
been added and contains everything Phase 5 needs: the Starting Gear tables (Armor,
Helmets and Shields, Dungeoneering Gear, General Gear 1 and 2), all eleven trait
tables, the full Item Costs price list, and the weapon/armor stat lines. Transcribed
into Phase 5 below. It also corrected two rules this plan had wrong — see §0.2 D5/D6.

**B3. ~~Dead code in `dungeon-rooms-loop.ts`.~~ DELETED.** The superseded Rooms Pass —
`RoomsPassPayload`, `RoomBrief`, `CreatureBrief`, `BorderBrief`,
`buildRoomsPassPayload`, `renderRoomsPassPrompt`, `ROOMS_PASS_INSTRUCTIONS`,
`ROOMS_PASS_SCHEMA`, and a duplicate `DepthBand`/`TensionBand` pair — is gone, 364
lines, confirmed by the author. It built and rendered a per-chunk prompt but had no
response type and no apply function, so nothing could get the model's answer back into
the world; `dungeon-content-pass.ts` does the same job in entity refs and has
`applyContentPass`. Nothing outside the block referenced any of it.

Three pre-existing dead imports went with it (`TIER_COMPLEXITY`, `genNpc`,
`Complexity`) — all already unreferenced beforehand. Left alone: several unused `rng`
parameters (`:369`, `:574`, `:1143`) and one unused destructured `r` (`:385`), since
removing those changes function signatures. Decide them with `noUnusedParameters` in
Phase 0.

### 0.2 Defects to fix in Phase 0

**D1. `ArmorType` does not exist.**
`dungeon-character.ts:20` imports `ArmorType` from `dungeon-entities`;
`slotAcceptsItem` (:178) reads `item.armor?.type`. `IItem.armor` is declared
`{ defense: number }` and `dungeon-entities.ts` exports no `ArmorType`. The engine
does not typecheck as-is. This is the armor update that got missed.

Fix, in `dungeon-entities.ts`:

```ts
export type ArmorType = "body" | "helmet" | "shield";

// IItem
armor?: { armorType: ArmorType; defense: number };
```

`body` — not `armor` — is the value, because the *slot* is called `armor` and the
*kind* is body armor; using one word for both is what makes this class of bug. The
body armors are Gambeson (def 12), Brigandine (13), Chain (14), Half Plate (15),
Full Plate (16). Helmet and shield each contribute a flat +1 and carry no meaningful
`defense` of their own; store `defense: 1` so the field is never `undefined` and
nothing is tempted to read it as a total.

One corresponding one-line fix in `dungeon-character.ts:179-186` —
`slotAcceptsItem` reads `item.armor?.type` and compares the `armor` slot against
`"armor"`:

```ts
const armorType: ArmorType | undefined = item.armor?.armorType;
switch (slot) {
  case "weapon": return !!item.weapon;
  case "armor":  return armorType === "body";     // was: === "armor"
  case "helmet": return armorType === "helmet";
  case "shield": return armorType === "shield";
}
```

**The equip machinery the author described already exists and is correct** —
`EquippedSlots` (:56) with `weapon` / `armor` / `helmet` / `shield` each holding an
`IItem` id, `heldItem` (:169) resolving the id against `pc.inventory` so only carried
gear can be equipped, `canEquip` (:189) checking kind-fits-slot and refusing a shield
alongside a two-handed weapon *in both directions* (:200 and :203), `equip` (:210)
validating before writing, and `validateEquipment` (:222) re-checking every filled
slot. `armorDefense(pc)` (:253) already computes body-armor defense (or 11
unarmored) +1 per helmet +1 per shield, which matches the rulebook exactly.

None of that needs writing — only the `ArmorType` gap and the `"armor"`→`"body"`
comparison. Nothing in the generation path writes `IItem.armor` yet, so the change is
otherwise additive. Phase 5's equipment tables are the first producer.

**D2. Top-level `process.argv` demo block.**
`dungeon-blueprint.ts:895-901` runs at module load and touches `process`. It will
throw in a browser bundle. Delete it, or move it behind `import.meta.vitest` /
into `dev/`.

**D3. `mobileCounter` is module-level mutable state.**
`dungeon-rooms-loop.ts:916` increments a module-scoped counter for mobile ids. Two
`stockDungeon` calls in one process produce different ids for the same seed. That
breaks prompt snapshot tests (mob ids appear in payload refs) and any
same-seed-twice assertion. Fix: derive the counter from `sd.seed`, or export a
`resetMobileIds()` the tests call. Prefer the former.

**D4. Name collisions across engine modules.** Not bugs, but they will cause import
mistakes, so document them in a barrel file:

| Name | `dungeon-phase-a.ts` | elsewhere |
|---|---|---|
| `Rng` | `type Rng = () => number` (:107) | `class Rng` in `dungeon-blueprint.ts` (:43) |
| `DungeonBlueprint` | graph output, `Partial<IRoom>[]` (:22) | `DungeonBlueprintSeed`, the genome (`dungeon-blueprint.ts:529`) |
| ~~`DepthBand`/`TensionBand`~~ | — | *resolved by the B3 deletion; now only in `dungeon-content-pass.ts:59`* |
| `makeEntityId` / `makeId` | phase-a (:113) | blueprint (:453) — identical implementations |

`dungeon-rolls.ts` must use the **class** `Rng`.

**D5. HP must be allowed to go negative.** Knave, Combat: "When a character reaches 0
HP, they are unconscious. When they reach -1 HP or less, they are dead." An earlier
draft of this plan had the diff applier clamp `hp.current` to `[0, max]`, which makes
death structurally unreachable. Clamp the **upper** bound only. `dead` is
`hp.current <= -1`; `hp.current === 0` is unconscious and is a distinct, playable
situation the referee needs to be able to write. See Phase 2c step 5.

**D6. The critical-hit rule runs in both directions.** BUILD-PLAN §8 mentions only
"natural 20 dealing +1d and costing the defender's armor a point of `currentQuality`".
The full rule (Knave, Critical Hits and Quality) is symmetric:

| Roll | Consequence |
|---|---|
| attacker nat 20, ~~or defender nat 1~~ | defender's **armor** loses 1 quality; attacker adds an extra damage die of the weapon's type |
| attacker nat 1, ~~or defender nat 20~~ | attacker's **weapon** loses 1 quality |

At 0 quality the item is **destroyed** (not merely unusable). Repair costs 10% of the
item's price per point.

The struck halves exist in the book because Knave lets an attack be resolved from
either side — the defender may instead roll d20 + armor bonus against the attacker's
ability defense.

**Decided: attacks are always resolved attacker-side, under the hood.** Enemy turns
happen *inside* action resolution, and stopping a resolution to hand the player a
defense roll against each incoming attack would break the one thing the turn is
supposed to do — resolve and narrate as a piece. Everything rolls at once and the
player reads the result.

Two consequences worth stating, because both simplify code:

1. **Only two crit branches are reachable.** The defender never rolls, so
   "defender nat 1" and "defender nat 20" can never fire. `critEffects` takes the
   attacker's `RollOutcome` and nothing else.
2. **`roll_offered` is always the player's own action, never a reaction.** No stage
   exists in which the game is waiting on a defensive roll, which keeps the stage
   machine exactly as BUILD-PLAN §4.1 draws it.

A monster's natural 20 therefore costs **the PC's** armor a point of
`currentQuality`, applied through the same path as any other quality loss (Phase 2c
step 5).

Also from the same section: saves and attacks must be **strictly greater** than the
target, never equal. An ordinary save is `total > 15`; an attack hits on
`total > armorDefense`. Opposed saves beat the opposing *defense*, not 15.

### 0.3 Contract gaps to close before Phase 2

**G1. `resolveBase()` is referenced in doc comments and does not exist.**
`dungeon-entities.ts:45` tells callers to use it. A creature's `base` currently
resolves from one of three places depending on how it was minted:

| Creature kind | Where `base` lives |
|---|---|
| Consolidated mass from a group | `ContentApplyResult.groupBases[group.id]` |
| Named person from a people group | inline `creature.base` (`dungeon-content-pass.ts:852`) |
| Elite / loose seed / goal creature | `registry.creatures[narrative.blueprintId].base` |
| Hazard | `registry.hazards[blueprintId].base` |

Searched the repo: **nothing currently resolves this.** `resolveBase` appears exactly
once, in the doc comment telling callers to use it. `entitySheet()`
(`dungeon-entities-pass.ts:530`) is a debug dump and does no resolution. The
mechanism is all there — `registry`, `narrative.blueprintId`, `groupBases` — but the
lookup that walks it has never been written.

**Author's decision: the Dungeon Pass writes the bases for the rolled inhabitants**
(`bp.inhabitants`). That is the right home — inhabitant groups are dungeon-level, the
Dungeon Pass already sees every one of them in `rollSheet(bp)`, and a resident
population's shared identity belongs next to the dungeon's history. It also removes
the cross-chunk write-once hazard for the groups that actually have one: an
inhabitant group can be placed in several rooms across several chunks.

**Wanderer groups are not part of this and stay with the content pass.** Two reasons,
and the second is the load-bearing one:

- *Structurally they cannot collide.* `makeMinionOrWanderer`
  (`dungeon-rooms-loop.ts:1262`) runs only at step 5a, spending leftover creature
  budget into unclaimed `creature`-headline rooms. On the non-cohesion branch it
  mints a **brand-new group per mobile** (`:1299-1300`, `:1313-1314`), bound to one
  mobile in one room. A wanderer group therefore lives in exactly one chunk, and the
  content pass writing its base locally is safe by construction.
- *They are not the dungeon's population.* `StockedDungeon.wandererGroups`
  (`:315-318`) is explicitly "not part of the dungeon's resident population" — filler
  drawn when the rolled inhabitants are already placed. Writing them into the
  dungeon's standing fiction would misdescribe the place.

So the existing line at `dungeon-content-pass.ts:803` —
`if (groupBases[group.id] === undefined) groupBases[group.id] = er.group.base` — is
**not** dead code. It is the live path for wanderers, and the `undefined` guard is
what keeps a chunk from overwriting an inhabitant base the Dungeon Pass already set.
Leave it exactly as it is.

**Serial-in-chunk-order apply still stands** — a CLAUDE.md rule, and independently
necessary regardless of `groupBases`, because `applyContentPass` mutates shared state
throughout: it pushes to `ep.items` / `ep.features`, writes
`ep.registry.creatures[...]`, calls `promoteDetail` (appending to `ep.features` and
`ep.bindings`), and filters/rebuilds `ep.creatures` (`:822-824`).

**Where the bases live: a third map on `TemplateRegistry`.** Author's decision — group
bases stay authored by the Dungeon Pass (who lives here is an input to how the dungeon
generates) but get *stored* as templates rather than as a loose side map. Both
constraints hold at once, because authorship and storage are separate concerns:

```ts
// dungeon-entities.ts
export interface GroupTemplate { id: string; name?: string; base?: string; }

export interface TemplateRegistry {
  creatures: Record<string, CreatureTemplate>;
  hazards: Record<string, HazardSeed>;
  groups: Record<string, GroupTemplate>;      // NEW — blueprintId -> shared base
}
```

This fixes the original bug directly. `groupBases` was a value `applyContentPass`
*returned* and every caller had to remember to keep; `registry` is already part of
`EntityPassResult` and is already persisted, so the base cannot go missing by
omission.

`runEntitiesPass` creates the registry, and it runs in the branch parallel to the
Dungeon Pass, so the Dungeon Pass cannot write into it directly. It doesn't need to:
`applyDungeonPass` returns `groups: Record<string, GroupTemplate>` and the join step
merges it into `ep.registry.groups` before the first chunk is built. Wanderer groups
are added to the same map by `applyContentPass` as their chunks land.

**The inhabitants must also be *in* `dungeonContext`, not only in the registry.**
Storing a base on `registry.groups` makes it resolvable; it does not put it in front
of the model. `dungeonContext` is consumed in two places — the content pass
(`buildContentPassPayload(..., dungeonContext)`) and the runtime's cached static
prefix (BUILD-PLAN §4.4) — and who lives here is load-bearing context for both. So
`applyDungeonPass` renders a **"who lives here"** section into the `dungeonContext`
string from the inhabitant groups: each group's name, its base, its tier, and its
disposition toward the player's goal (`PeopleGroup.goalBranch` — ally, rival, or
pursuing its own end). Theme and history without the population would describe an
empty building.

**And wanderers must never leak into it.** They will be written into
`registry.groups` later, chunk by chunk, so anything that re-derives `dungeonContext`
*from* the registry would silently pull them in and start describing corridor filler
as the dungeon's population. The guard is to build the string exactly once:

> `dungeonContext` is constructed in `applyDungeonPass` from `bp.inhabitants` alone
> and is immutable thereafter. Nothing appends to it. No later pass regenerates it.

Store it as a plain `readonly string` on `GeneratedDungeon` and test it: after a full
generation, assert that no id or name from `sd.wandererGroups` appears anywhere in
`dungeonContext`, and that every `bp.inhabitants` name does.

The resolver then collapses to almost nothing:

```ts
// dungeon-entities.ts
export function resolveBase(e: IEntity, reg: TemplateRegistry): string | undefined;
```

- inline `e.base` wins (named people carry their own — `dungeon-content-pass.ts:852`)
- else, for a creature: `reg.groups[bid]?.base ?? reg.creatures[bid]?.base`
- else, for a hazard: `reg.hazards[bid]?.base`

Both id spaces are UUIDs — `genMonsterGroup` (`dungeon-blueprint.ts:752`) and
`genPeopleGroup` (`:715`) mint theirs from `makeId()`, notwithstanding the
`<dungeonId>:g<i>` doc comment on `MonsterGroup`/`PeopleGroup`, which is stale. So
the two lookups could be one map without risk of collision — but keeping them
separate preserves the distinction between "a rolled population" and "a one-off
template", which is worth more than the line it saves. **The stale comment should be
corrected** so nobody builds on the format it advertises.

**G2. Rooms have no occupant list — and don't get one. SETTLED.**
BUILD-PLAN §4.3 requires that writing `roomId` on a creature "must also pull it from
the old room's occupant list and push it to the new one". No such list exists in the
entity model. `RoomStock.occupants` is a *stocking-time* artefact holding mobile ids,
not entity ids, and does not survive into `EntityPassResult`. `IRoom.children` is
declared on `IEntity` but never populated.

**Author's decision: occupancy is derived at runtime** by scanning entities for those
whose `roomId` or `parentId` matches the room. So there is no second list, and
BUILD-PLAN §4.3's "maintain both sides" requirement is satisfied vacuously — a
`roomId` write is a plain field write and cannot desynchronise anything.

The scan spans three different link fields, so the index builder has to know all
three:

| Entity | Link field | Note |
|---|---|---|
| `ICreature` | `roomId` | |
| `IRoomFeature` | `roomId` | |
| `IItem` | `parentId` | may be a room, a creature, **or** a feature (chests) — so items nest |
| `IMobileEffect` | `roomIds` | an **array**; one effect can be in several rooms at once |
| `IRoomConnector` | `endpointA` / `endpointB` | two-sided by nature; never written at runtime |

Items nesting through creatures and features means "what's in this room" is a
*transitive* question — a dagger in a chest in a room is in the room. Ship two
functions and keep them distinct:

```ts
// src/runtime/occupancy.ts
export function directContents(roomId: string, e: EntityPassResult): AnyEntity[];
export function roomIndex(e: EntityPassResult): Map<string, AnyEntity[]>;  // all rooms, transitive
```

Rebuild the index after each applied commit; it is O(n) over a few hundred entities
and not worth incrementalising. `render.ts` uses the transitive form for the room
block; the applier uses the direct form.

The one genuine two-sided relation is the PC: `PlayerCharacter.inventory` is a real
array *and* each item carries `parentId`. So `parentId` writes that cross the PC
boundary are the applier's only true special case — see Phase 2c step 4.

**G3. Seed derivation is unspecified and the two entry points disagree on type.**
`generateBlueprint(seed: string, ...)` takes a string; `generateBlueprintSeed(size,
seed: number, ...)` takes a number; `stockDungeon` defaults to `blueprint.seed + 7919`.
Define one canonical derivation in Phase 1 so a "seed" in the URL means exactly one
dungeon:

```ts
// src/runtime/seeds.ts
export interface RunSeeds {
  dungeonSeed: number;    // the user-facing number
  graphSeed: string;      // `${dungeonSeed}` -> generateBlueprint
  blueprintSeed: number;  // dungeonSeed
  stockSeed: number;      // dungeonSeed + 7919 (matches current default)
  runSeed: number;        // separate stream for play-time rolls
}
```

**G4. Size ↔ chunks is identity. SETTLED.** A size *n* dungeon is *n* chunks: size 1 →
1 chunk → 6 rooms, size 5 → 5 chunks → 30 rooms. So `generate.ts` passes
`{ chunks: size }` straight through and no mapping table is needed. Worth one assert
that `Size` and the legal chunk range stay in step if either ever widens.

**G5. Entity ids are deliberately unseeded. SETTLED — this was never open.**
`makeId()` (`dungeon-blueprint.ts:453`) and `makeEntityId()`
(`dungeon-phase-a.ts:113`) both use `crypto.randomUUID()` and both carry the comment:
*"Deliberately NOT drawn from the seeded rng — ids are identity, not content, so
they're fresh on every run and consume no seed draws."*

Two consequences for tooling, which are facts rather than choices:

- BUILD-PLAN §8's "same seed in, identical dungeon out, asserted on a hash of the
  emitted structure" must hash an **id-stripped canonical form** — ids removed, arrays
  sorted by a stable content key. Hashing raw output would fail every run.
- Phase 7 replay replays the **run**, not the generation: load the persisted
  `GeneratedDungeon`, reset `runSeed`/`rngDraws`, feed `playerInputs` back through
  `turn.ts`. Regenerating from a seed would produce different ids and invalidate every
  recorded diff — and would re-spend every content-pass token besides.

### 0.4 What the `dungeon-loop` skill changes

Read the six step files before Phase 3. The important structural fact:

**The steps are a sequential pipeline inside one turn, not one file per `Stage`.**
BUILD-PLAN §4.1 says the enum "maps onto the `dungeon-loop` steps" and §4.4 says to
load "only the current stage's step file". Neither is quite true of the skill as
written. Stages and steps cross:

| `Stage` | Where it is produced |
|---|---|
| `room_entry` | **nowhere** — see gap S1 |
| `awaiting_action` | entry to step 1; also the exit of `3-information` and of step 5 |
| `clarifying` | step 1C (justify a target) **and** step 4 (settle weapon / mode / advantage use) — two unrelated kinds |
| `rejected` | step 1B, step 1C, step 2, `3-information` §A — four sites in three files |
| `roll_offered` | the confirmation post ending `3-standard`, and the re-offer loop in step 4 |
| `rolling` | inside step 4, "Confirm → roll" |
| `resolving` | step 5 |
| `dead` / `goal_met` | step 5 §5 |

**Fix: track position and presentation separately.**

```ts
type Step = "1-target" | "2-classify" | "3-information" | "3-standard"
          | "4-confirm-roll" | "5-resolution" | "room-entry";

// GameState
stage: Stage;   // drives the UI — what the input area tells the player
step: Step;     // drives prompt assembly — which file(s) load
```

`stage` is derived from the step's outcome and is what DESIGN-BRIEF's eight input
states render from. `step` is the referee's position in the pipeline. Keeping them
apart costs one field and makes both well-defined.

**Call boundaries — SETTLED: steps 1→3 are one call.** They are described as a
sequence because the reasoning is sequential, not because each is a separate
generation. So one call loads steps 1, 2, `3-handle-by-type` and both handlers; step 4
and step 5 are their own calls, each naturally gated (on the player's confirmation and
on the roll result respectively). Three calls for an action that rolls, one for an
action that doesn't.

The inter-step records (`{ outcome, scope, entities, newElement, … }`) therefore stay
**internal reasoning scaffolding, not a wire format**. Nothing parses them; they exist
to keep the model from skipping ahead, which is exactly what SKILL.md:30 and :43 ask
for. Only the `commit_state` envelope crosses the boundary.

One consequence for prompt assembly: the triage call must make clear that the model
works the steps in order and stops at the first one that bounces, rather than reading
five files and forming a single impression. The ordering discipline is the whole point
of the heuristic.

#### Gaps in the skill

**S1. Room entry is not written.** SKILL.md:12 says it is "already done by room
entry"; `5-resolution.md:53` says a newly entered room is run "the way the entrance
room was run" — collect entities, compose anything stale bottom-up, describe the
location. Nothing specifies that pass. It is its own LLM call (BUILD-PLAN Phase 4) and
needs a `steps/room-entry.md` or an equivalent prompt. *Author's prose, not mine.*

**S2. The `commit_state` envelope is absent.** The skill describes player-facing posts
and inter-step JSON records, but never the `{ nextStage, rollRequest, diffs }`
envelope from BUILD-PLAN §4.2, nor the diff shape, nor the writable-path rules. That
is the wiring contract between the referee and the applier, and it belongs in
`SKILL.md` because it is true in every step. **Written** — see the S2 section below.

**S3. `needUpdate` must be added to the entity model.** `5-resolution.md:53` names it
and it does not exist yet — `dungeon-entities.ts` has only `composed?: string`, and
`setState` (:295) marks staleness by clearing `composed` to `undefined`.

**Clearing `composed` is the wrong mechanism**, because state changes on entities the
player is nowhere near. A creature that flees to another room and bleeds out there has
its `state` written immediately; its description need not be regenerated until the
player next lays eyes on it. Clearing `composed` at the moment of the state change
would (a) throw away the last good description for no reason, and (b) make
`composed === undefined` mean two different things — "never encountered" and
"encountered but stale" — which is precisely the distinction fog of war reads.

So add the flag and change `setState`:

```ts
// IEntity
/** state has moved since `composed` was written; recompose on next encounter */
needUpdate?: boolean;

export function setState(e: IEntity, state: string): void {
  e.state = state;
  e.needUpdate = true;      // was: e.composed = undefined
}
```

`composed === undefined` continues to mean **never encountered** and stays the fog-of-war
signal. `needUpdate === true` means **stale, recompose when next seen**. Room entry
composes the union of the two (S1); everything else keeps the description it has.

#### Rule conflicts to reconcile

**S4. DC 16, `>=`. SETTLED.** `success = total >= dc`, and `ORDINARY_DC = 16` — the
skill's number (`3-standard.md:41`, `4-confirm-and-roll.md:24`) is the number the code
takes, so the model and the roll function never disagree.

The `>=` convention needs one conversion, and it should exist in exactly one place.
Knave's *opposed* rolls must **exceed** the opposing defense, while the skill's prose
says to use a creature's defense as the DC directly (`3-standard.md:41`) and a
target's defense as an attack's target number (`:29`). Taken literally with `>=` that
is one point generous on every contested roll. So:

```ts
export const ORDINARY_DC = 16;
/** A defense used as a target: Knave contests must EXCEED it. One place, one +1. */
export function dcFromDefense(defense: number): number { return defense + 1; }
```

`attackRoll` and `stuntRoll` take a **defense** (the vocabulary the skill uses) and
apply `dcFromDefense` internally; `saveRoll` takes a **DC**, which is `ORDINARY_DC` for
an ordinary save and `dcFromDefense(creatureDefense)` when a creature is the source of
the risk. No caller ever writes `+ 1` by hand, and the two conventions meet in one
tested function.

**S5. 0 HP is death. SETTLED.** `5-resolution.md:59` stands: at 0 or below the PC is
slain. Knave's unconscious-at-0 rule assumes a party to drag you out, and solo play has
none, so the distinction has no gameplay behind it. Revisitable if a hireling or
companion ever exists.

The applier still does **not** clamp HP at zero (D5): overkill is worth narrating, and
a floor at 0 would make "reduced to exactly 0" and "hit for 12 past dead" the same
state. `dead` is `hp.current <= 0`.

**S6. Stunts are unspecified in `dungeon-rolls`.** The skill uses them throughout —
`mode: "damage" | "stunt"`, and advantage optionally spent as "stunt-and-damage"
(`3-standard.md:30`, `4-confirm-and-roll.md:32-34`, `5-resolution.md:18`). Knave
resolves a stunt as a **versus save**, dealing no damage directly. Phase 2a needs a
`stuntRoll`, and the `RollSpec` shown to the player needs a `mode` field.

**S7. Initiative and reactions are unused.** Step 5 has creatures act as part of
resolution with no initiative roll, and no step consults a reaction table. Keep
`initiativeRoll` / `reactionRoll` out of Phase 2a until something calls them.

#### S2 — the `commit_state` envelope contract. **WRITTEN.**

Authored, in two files:

All of it in **`SKILL.md`**, loaded on every call because every call commits: the
envelope (`nextStage` / `nextStep` / `rollRequest` / `diffs`), the stage table, the two
iff-rules, the four diff rules, the never-writable list, `state` vs `composed`, entity
creation, the writable-path table, and the roll functions. About 90 lines.

An earlier draft split the catalogue into a second file loaded only on state-changing
calls. The `applyDiff` design made that unnecessary — the vocabulary is one table
instead of twenty named operations, and it is small enough that conditional loading
would buy less than it costs in complexity.

##### The diff shape, and where the intelligence lives

One uniform diff — `{ entityId, path, value }` — exactly as BUILD-PLAN §4.3 has it.
The model states **the destination value**, never a procedure.

The intelligence is in the applier, not in the vocabulary the model has to learn.
`applyDiff` does not blind-write the value: it **reads `(entityId, path, value)` to
work out which operation is being described**, then dispatches to a handler that
performs it correctly and returns a validation error if it can't.

```
{ entityId: "<player>", path: "inventory[1]", value: null }
```

is recognised as a drop: clear the slot, compact the inventory, clear any equipment
slot that pointed at the item, reparent it to the player's current room. Three
consequences from one stated fact. Likewise `parentId` → the player is a pickup with a
slot check; `currentQuality` → 0 is destruction plus unequip; `conditional` → null
opens a way; `stats.hp` ≤ 0 kills a creature.

This is better than the named-operation catalogue I first drafted — it keeps the
prompt surface to one tool and a path table, and it moves every rule into code where
it is testable rather than into prose the model has to follow correctly. The safety
property is the same: nothing reaches a raw field write without passing the handler
that owns that field's invariants.

Phase 2c accordingly: `apply.ts` holds the **dispatch table** (path pattern + value
shape → handler), each handler delegating to the engine function that owns the rule —
`equip` / `unequip` / `addItem` / `removeItem` from `dungeon-character.ts`, `setState`
from `dungeon-entities.ts`. `paths.ts` stays as the per-type writable-path allowlist,
consulted first: an unrecognised path is refused before dispatch is attempted.

Requirements the contract satisfies, for reference:

**1. The envelope itself.** Narration streams as ordinary assistant text; structure
arrives as one terminal tool call.

```ts
interface Commit {
  nextStage: Stage;         // what the input area tells the player
  nextStep: Step;           // where the pipeline resumes
  rollRequest?: RollSpec;   // present iff nextStage === "roll_offered"
  diffs: Diff[];            // MUST be empty when nextStage is "clarifying" | "rejected"
}
```

Both "iff" clauses are zod refinements. The diffs-empty rule restates SKILL.md:42
("Rejections never change the world") in a form the applier can enforce.

**2. One diff shape**, `{ entityId, path, value }`, with creation expressed as an
append to `children[]`. That covers the case the skill already implies but never
names: step 1's `newElement: { needsEntity: true }` — the keyring established on the
guard's belt — is `{ entityId: <guard>, path: "children[]", value: {…} }`. The spec
must arrive complete enough to mint from (`type`, `name`, `base`), because a
half-formed entity rejects the batch.

**3. What may be written.** State it as an allowlist from the model's side, mirroring
`paths.ts` (Phase 2c). The prohibitions matter more than the permissions and should be
stated flatly: **`base`, `name`, `id`, `type`, `keywords`, `blueprintId`,
`stats.hitDice`, and `stats.modifiers` are never writable.** `base` is identity
(`dungeon-entities.ts:14`); if a thing changed enough that its `base` would change, it
should be a new entity via `addChild`.

**4. `state` and `composed` travel together.** Writing `state` without regenerating
`composed` leaves a stale cache. The skill already says to recompose
(`3-information.md:25`, `5-resolution.md:51`); the envelope section should say it is
two `set` diffs on the same entity, and that `composed` is rendered from base + state
and is **never** read to make a decision.

**5. Relational keys are plain writes.** `creature.roomId`, `item.parentId`,
`effect.roomIds` — write the field and nothing else. Occupancy is derived (G2), so the
model must **not** try to maintain any room-side list. Worth stating, because a model
that knows about containment will otherwise invent one.

**6. Ids are quoted, never invented.** Every `entityId` must be one given in the room
block or the PC block, verbatim. New entities get their ids from `addChild`.

**7. Atomicity and retry.** The batch is validated whole and applied whole; one bad
diff rejects all of them. On rejection the model receives the reasons and retries
once. Saying this in the prompt is what makes the retry productive rather than a
repeat of the same mistake.

**8. Numbers come only from the dice tool.** Restate the CLAUDE.md rule at the
envelope boundary: any HP delta, damage figure, or roll total in the narration or in a
diff must trace to a `roll` tool result. The referee never picks a number.

#### S1 — room entry. **WRITTEN** (`steps/room-entry.md`).

**Whether it runs at all is decided in code** (author's design). Room entry begins
with a deterministic sweep, before any model call:

```ts
// src/runtime/room-entry.ts
export function needsComposition(roomId: string, ep: EntityPassResult): AnyEntity[];
// every entity in the room (transitively, per roomIndex) that is either
//   composed === undefined   (never encountered)
//   or needUpdate === true   (state moved since it was last described)
// plus the room itself under the same test
```

- **Empty → no model call.** Nothing here has changed since the player last stood in
  it. Render `room.composed` verbatim and go to `awaiting_action`. Free, instant, and
  consistent by construction — a room the player hasn't affected can't drift in its
  retelling.
- **Non-empty → one call**, handed only those entities. First entry is the degenerate
  case where everything qualifies.

So the step file never reasons about whether this is a first visit; it composes what
it is given. The written file covers: inside-out composition order, the four jobs the
room's `composed` has to do (the place, its contents, its occupants via `activity`,
the ways out with their `conditional` text), the hard rule that hidden features
surface only as clues, the four things entry never does (roll, start combat, spring a
hazard, change anything but prose), tone, and the exit to
`awaiting_action` / `1-target`.

**Compose bottom-up.** Contents first, then the room, so the room's `composed` can
speak about what is in it. `5-resolution.md:53` already says this for mid-turn room
changes; room entry is where the rule originates.

**Hidden things stay hidden.** `IRoomFeature.hidden` entities are *not* revealed on
entry. If they surface at all it is as a clue in the room's prose — the front half of
the rule whose back half is `3-information.md:21` ("a directed look along the right
track turns a clue into the thing itself"). Getting this wrong makes searching
pointless, so it should be stated as a hard rule, not a preference.

**Exits.** Every connector out of the room, described as what it physically is (the
content pass wrote that into `base`), and for a gated one, what blocks it — the
`conditional` field. This is the player's only planning information and the map's fog
of war keys off it.

**Creatures.** Each creature's `activity` says what it is doing when first encountered;
it is the hook the arrival should turn on. Entry does **not** start combat, roll
anything, or take creature turns — a hostile creature is narrated as a present threat
and the turn hands to `awaiting_action`.

**Ends at** `nextStage: "awaiting_action"`, `nextStep: "1-target"`.

### 0.5 One layout inconsistency

BUILD-PLAN §1 says the skill "should live in the repo as `src/prompts/dungeon-loop/`".
BUILD-PLAN §3's tree puts it at `src/runtime/prompts/dungeon-loop/`. Use
**`src/runtime/prompts/dungeon-loop/`** — it matches the tree and keeps `assemble.ts`
and `render.ts` adjacent to the text they assemble.

---

## Part 1 — Cross-cutting decisions to settle in Phase 0

Nail these before writing feature code; every phase depends on them.

**Module resolution.** `"moduleResolution": "bundler"`, `"strict": true`,
`"noUncheckedIndexedAccess": false` (the engine indexes maps with `!` liberally;
turning this on would mean editing engine files). `verbatimModuleSyntax: true` so
`import type` stays type-only — the engine already writes it that way.

**Raw markdown import.** The skill files load via Vite's `?raw` suffix. For vitest,
the same import must work headlessly — configure `vite-plugin-*` free: Vite's
built-in `?raw` works under vitest since vitest uses the Vite pipeline. No extra
plugin. Declare it in `src/vite-env.d.ts`.

**Engine purity guard.** Add a test that greps `src/engine/**` for `react`,
`import.meta.env`, and `document` and fails on a hit. CLAUDE.md states the rule; make
it enforceable rather than aspirational.

**Zod version.** Zod 4 (`zod/v4`) if starting fresh — `z.output` inference and the
faster parser matter here because every model response goes through it.

**Structural sharing.** Zustand + `persist` serialises the whole store. The generated
dungeon is large (18–30 rooms plus every entity). Persist it *separately* from the
turn-by-turn state so a per-turn write doesn't re-serialise the dungeon. Two
IndexedDB keys: `dungeon:<id>` (write-once) and `run:<id>` (written per commit).

---

## Part 2 — Phase-by-phase

Each phase ends somewhere demonstrable. One phase per session.

---

### Phase 0 — Scaffold ✅ **DONE**

**Goal:** `npm run dev` serves a page, `npm test` runs green, and a hello-world call
reaches the Anthropic API through the dev proxy with the key never entering the
bundle.

**Outcome.** React 19 / Vite 8 / TypeScript 7 / Vitest 4 / Tailwind 4 (CSS-first, no
`tailwind.config`). 30 tests green, `npm run build` clean, proxy verified end to end
against the live API. Key-leak check is automated in spirit and was run by hand for
this phase: a sentinel key in `.env.local` produced **zero** occurrences in `dist/`.

Two things differed from the plan as written:

- **`dungeon-phase-a.ts` had the same `process.argv` demo block as
  `dungeon-blueprint.ts`** (D2 was under-scoped — it named only one file). The purity
  test caught it. Its `batch()` diagnostic is now exported rather than deleted.
- **The determinism filter has to strip every id-bearing key**, not a hand-listed
  few — `hazardId` was the one that surfaced. It now strips `id`, `*Id`, `*Ids`, and
  the id arrays hanging off stocking.

Deferred deliberately: no jsdom project (arrives with the first UI test), no
`tsconfig.node.json` (unnecessary — one tsconfig covers `src` and `vite.config.ts`).

**Files**

```
package.json
tsconfig.json
tsconfig.node.json
vite.config.ts
tailwind.config.ts        (or v4 CSS-first config)
postcss.config.js
vitest.config.ts          (or a `test` block in vite.config.ts)
index.html
.env.local.example        API_KEY=sk-ant-...
.gitignore                .env.local, node_modules, dist
src/main.tsx
src/App.tsx
src/index.css
src/vite-env.d.ts         declare module "*.md?raw"
src/engine/index.ts       barrel; documents the D4 collisions explicitly
src/engine/__tests__/purity.test.ts
```

**Work**

1. Scaffold Vite + React + TS. Tailwind. Vitest with `environment: "node"` for
   `src/engine/**` and `jsdom` for `src/ui/**` (use vitest projects/workspace).
2. **Fix D1** — add `ArmorType = "body" | "helmet" | "shield"`, widen `IItem.armor` to
   `{ armorType: ArmorType; defense: number }`, and change the `case "armor"`
   comparison in `slotAcceptsItem` to `"body"`. Add a test that round-trips all four
   equip slots plus both two-handed/shield conflict directions — the equip logic
   already handles these, so the test is guarding existing behaviour, not new code.
3. **Fix D2** — remove the `process.argv` demo block from `dungeon-blueprint.ts`.
4. **Fix D3** — seed the mobile-id counter from `sd.seed`.
5. Write `src/engine/index.ts` re-exporting everything with the four colliding names
   aliased and commented (`RngFn` for phase-a's, `GraphBlueprint` for phase-a's
   `DungeonBlueprint`).
5b. **Move the skill** out of `src/engine/` (B1): `SKILL.md` from the repo root to
   `src/runtime/prompts/dungeon-loop/SKILL.md`, and the six `*.md` step files to
   `steps/` beneath it — which is where `SKILL.md`'s own links already point. Add the
   `*.md?raw` declaration to `src/vite-env.d.ts` and one test that every `steps/…`
   path named in `SKILL.md` resolves to a real file, so a rename can't silently
   decapitate a prompt.
6. Dev proxy in `vite.config.ts`:

```ts
server: {
  proxy: {
    "/api/anthropic": {
      target: "https://api.anthropic.com",
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/anthropic/, ""),
      configure: (proxy) => proxy.on("proxyReq", (req) => {
        req.setHeader("x-api-key", process.env.ANTHROPIC_API_KEY!);
        req.setHeader("anthropic-version", "2023-06-01");
      }),
    },
  },
}
```

Load `.env.local` with `loadEnv(mode, cwd, "")` — note the **empty prefix**, so the
key is readable by the config but is *not* `VITE_`-prefixed and therefore never
inlined into client code. This is the mechanism that satisfies the CLAUDE.md rule;
make it a comment in the file.

7. `src/runtime/llm/models.ts` — the registry, populated with one model for all four
   tasks. The only file in the repo allowed to contain a model string. Add a test that
   greps for `claude-` outside this file.

**Tests:** purity guard; model-string guard; `dungeon.valid === true` across ~20 seeds
× chunk counts 1–5 (this exercises the existing phase-a validator and proves the
harness works end to end).

**Exit:** `npm test` green, `npm run dev` renders, a button in `App.tsx` makes a
one-token call through the proxy and prints the response.

**Risk:** low. The proxy header-injection detail is the only fiddly part.

---

### Phase 1 — Headless generation ⚠️ **BUILT, LIVE PATH UNVERIFIED**

**Goal:** `npm run generate -- --seed 1005 --size 3` runs the full pipeline and writes
a JSON file containing a completely written dungeon. No UI.

**Status.** Everything is built and the offline half is tested: 58 tests green,
including a full pipeline driven by fake model responses that produces zero
`validateWritten` problems across three seeds. `--dry` renders every prompt the run
would send.

**What has NOT happened: a real generation.** There is no `.env.local` in the repo, so
no call has ever been made through this code path. The Phase 1 exit criterion — three
consecutive seeds reliably producing a fully-written dungeon — is unmet and cannot be
met without a key. Expect prompt iteration when it first runs; that is what this phase
is for, and the tests only prove the plumbing, never the prose.

**Notes on what differed from the plan:**

- Runs under plain `node` (Node 24 strips types natively), so no `tsx` dependency. The
  cost is that constructor **parameter properties** are unsupported — strip-only mode
  cannot compile them — so `LlmError` and `ResponseFormatError` declare their fields
  explicitly. Worth knowing before adding a third error class.
- Node ESM needs explicit extensions. The engine's imports were mixed; all relative
  imports in `src/` now carry `.ts`.
- `applyContentPass` no longer takes or returns a `groupBases` map. It writes into
  `ep.registry.groups` with the same write-once guard, so the base cannot be dropped by
  a caller forgetting to keep a return value — which was the original bug.
- `configureTransport` added to the client: the browser keeps the relative
  `/api/anthropic` path through the proxy; the CLI points at the API directly, because
  it runs in Node where there is no proxy and a key is supposed to live.

This is the expensive, high-uncertainty phase and it deliberately happens where
iteration is a shell command.

**1a. The Dungeon Pass** — `src/engine/dungeon-pass.ts`

Mirrors `dungeon-content-pass.ts`'s quartet exactly.

```ts
export interface DungeonPassPayload {
  rollSheet: string;          // rollSheet(bp)
  size: Size;
  level: number;
  instructions: string;
  responseSchema: string;
}
export interface DungeonPassResponse {
  name: string;               // the dungeon's name
  theme: string;              // material, light, sound, smell — the sensory register
  history: string;            // what it was, what happened, who is here now
  goal: {                     // one objective resolved from reward + mission
    summary: string;          // one line, shown to the player
    spec: string;             // what satisfies it, for the referee
  };
  openingProse: string;       // what the player reads before room one
  groups: { id: string; name: string; base: string }[];   // G1 — one per inhabitant group
}
export function buildDungeonPassPayload(bp: DungeonBlueprintSeed): DungeonPassPayload;
export function renderDungeonPassPrompt(p: DungeonPassPayload): string;
export function applyDungeonPass(res: DungeonPassResponse): {
  dungeonContext: string;
  groupBases: Record<string, string>;    // inhabitants only; wanderers fill in per chunk
  pass: DungeonPassResponse;
};
```

`dungeonContext` is the flat string `buildContentPassPayload(..., dungeonContext)`
consumes. The structured response survives alongside it: `goal.summary` goes in the
UI, `openingProse` is the first thing the player reads, and `groupBases` is what
Phase 2's `resolveBase` reads.

**Inhabitant group bases are written here (G1).** The payload lists every group in
`bp.inhabitants` with its rolled keywords (reuse `describeGroup` from
`dungeon-content-pass.ts:321`, or lift it into a shared module — it is already
exactly the right rendering). The model returns one `name` + `base` per group id. The
prompt must say the base is the group's *standing identity* — what these things are
anywhere in the dungeon — not what they are doing in any particular room, since the
same base is shared by every instance across every chunk.

Wanderer groups are **not** in this payload; they don't exist yet and they aren't
part of the dungeon's population. The content pass writes their bases per chunk.

Validate in `applyDungeonPass` that the returned group ids are exactly
`bp.inhabitants.map(g => g.id)`: a missing group means creatures with no resolvable
base, which is a hard failure, not a degradation.

The prompt must also: resolve `goalSeed.reward` + `goalSeed.mission` into **one**
objective (`rollSheet` already tells it to pick one, discard, or combine); commit to
material and history so the content pass cannot contradict it; write no room-level
detail (that belongs to the content pass).

**1b. LLM client** — `src/runtime/llm/`

```
client.ts    callModel({ task, system, messages, tools?, stream? })
             — fetch to /api/anthropic/v1/messages, retry w/ backoff on 429/5xx,
               typed error for overloaded vs. invalid-request
models.ts    (from Phase 0)
schemas.ts   zod for DungeonPassResponse and ContentPassResponse
json.ts      extractJson(text) — tolerant fence-stripping, then zod
```

For generation passes, request JSON via a tool call rather than parsing prose — it
removes an entire class of failure. Keep `extractJson` as the fallback path.

**1c. Orchestrator** — `src/runtime/generate.ts`

```ts
export interface GenerationProgress {
  stage: "layout" | "inhabitants" | "history" | "stocking" | "writing";
  chunksDone?: number; chunksTotal?: number;
}
export async function generateDungeon(
  seeds: RunSeeds,
  size: Size,
  level: number,
  onProgress: (p: GenerationProgress) => void
): Promise<GeneratedDungeon>;
```

The stage names map 1:1 onto the five the design brief asks the loading screen to
report — define them here, not in the UI, so the UI has nothing to invent.

Ordering, as BUILD-PLAN §5 has it — the Dungeon Pass needs only `bp`, so it runs
concurrently with the pure stocking branch:

```
  A: generateBlueprintSeed(size, blueprintSeed, level)          [pure]
     -> buildDungeonPassPayload(bp) -> LLM -> applyDungeonPass  ────┐  [1 call]
  B: generateBlueprint(graphSeed, params, true)                     │  concurrent
     stockDungeon(dungeon, bp, {level, stockSeed})                  │
     runEntitiesPass(sd, bp, genRng)                            ────┘
  join, then per chunk:
     buildContentPassPayload(sd, bp, ep, chunk, dungeonContext)
     -> render -> LLM -> zod                        [parallel, all chunks at once]
     applyContentPass(..., groupBases)              [SERIAL, ascending chunk order]
```

`groupBases` enters step 6 pre-populated with the inhabitants and accumulates the
wanderers chunk by chunk.

**Serialise `applyContentPass`.** A CLAUDE.md rule, and independently necessary: apply
mutates `ep.items`, `ep.features`, `ep.bindings`, `ep.registry.creatures`, and
rebuilds `ep.creatures` (`dungeon-content-pass.ts:822`). Write it as an explicit `for`
loop over `chunks.sort((a,b) => a-b)` with a comment naming the shared-state
invariant, so nobody later "optimises" it into a `Promise.all`.

Retry policy per BUILD-PLAN §5: on zod failure, retry that chunk **once** with the
validation errors appended. On second failure, throw. No partial content.

**`GeneratedDungeon`** — the write-once half of persisted state:

```ts
export interface GeneratedDungeon {
  id: string;
  seeds: RunSeeds;
  size: Size; level: number;
  dungeonContext: string;
  pass: DungeonPassResponse;
  entities: EntityPassResult;      // rooms, connectors, creatures, features, items, hazards, effects
  groupBases: Record<string, string>;   // G1 — from the Dungeon Pass; feeds resolveBase
  stocked: StockedDungeon;              // needed for map layout + refs
  blueprint: DungeonBlueprintSeed;
  graph: Dungeon;                       // phase-a output, for the map
}
```

**1d. CLI** — `src/dev/cli-generate.ts`

Args: `--seed`, `--size`, `--level`, `--out`, `--dry` (skip LLM, emit the rendered
prompts only). `--dry` is the workhorse: it lets prompt iteration happen at zero cost.
Reads the key from `.env.local` directly (this path is Node, not the browser, so the
proxy isn't involved — document that clearly so nobody concludes the key rule is soft).

**Tests**

- Determinism: same seed → identical canonicalised hash (ids stripped per G5), across
  the pure steps 1–2 and 4–5.
- `dungeon.valid` across a seed spread (moved from Phase 0 if it fits better here).
- Dungeon Pass returns a base for **every** id in `bp.inhabitants`, and
  `applyDungeonPass` throws when one is missing.
- Group-base write-once: two chunk responses containing the same inhabitant group,
  applied serially, leave the Dungeon Pass's base intact.
- Wanderer bases arrive from the content pass and are never clobbered by a later
  chunk.
- After a full run, `resolveBase` returns a non-empty string for **every** creature
  and hazard — this is the assertion that catches the whole class of "base went
  missing" bugs, and it belongs in `validateWritten`.
- Snapshot the rendered content-pass and dungeon-pass prompts for one fixed seed
  (BUILD-PLAN §8). **Redact UUIDs first** — ids are unseeded (G5) and appear in both
  prompts (entity refs; group ids), so an un-redacted snapshot passes on the run that
  writes it and fails on every run after. Run the suite twice when adding a snapshot.

**Exit:** three consecutive seeds produce a fully-written dungeon with no empty
`base` on any room, connector, creature, feature, item, or hazard. Add a
`validateWritten(gd)` assertion function and run it in the CLI — it is also the
Phase 4 sanity check.

**Risk:** high. This is where model output quality is discovered. Budget the session
for prompt iteration, not just wiring.

---

### Phase 2 — State and rules ✅ **DONE**

**Goal:** a `GameState` that round-trips through IndexedDB, a dice module, and a diff
applier that refuses everything it should. Still no UI.

**Outcome.** 172 tests green, build clean. Everything runs headless — no jsdom, no
fake-indexeddb — because persistence sits behind a `KeyValueStore` interface with a
memory implementation for tests and Node and an IndexedDB one for the browser.

Three decisions that differed from the plan as written:

- **The applier is atomic by *construction*, not by dry-run validation.** It applies
  to a `structuredClone` of the world and adopts the clone only if every diff
  succeeded. Pre-validating against the starting state cannot handle a batch whose
  later diffs depend on its earlier ones — unequip the shield, then take up the
  two-hander — and would refuse the second for a conflict the first had already
  resolved. There is a test for exactly that.
- **Intra-commit references are `ref`-based.** `children[]` accepts an optional `ref`
  and later diffs *in the same commit* may use it as an `entityId`. The referee cannot
  know an id the applier is about to mint, and this is the only window where that
  matters. Refs do not survive the commit that created them.
- **Creature creation via `children[]` is refused**, with a message saying so.
  A creature needs hit dice, a stat block and a template to resolve its base through;
  a diff cannot supply those well, and a fabricated stat block is worse than a
  refusal. Items and features create fine. Revisit if the referee turns out to need it.

**`dungeon-rolls`** ships `saveRoll` / `attackRoll` / `stuntRoll` / `moraleRoll` /
`rollDamage`, with `dcFromDefense` holding the only `+1` in the codebase. Tests pin
the thresholds in both directions: 16 succeeds and 15 fails an ordinary save; a total
exactly equal to a target's defense **misses**.

**The run RNG resumes mid-stream.** `CountingRng` wraps `Rng` and counts draws;
`{ runSeed, rngDraws }` is persisted and replayed on load. A wrapper rather than a
subclass because `Rng`'s methods reach for its private generator directly, so
overriding `next()` would not catch them.

**2a. `src/engine/dungeon-rolls.ts`**

Pure, seeded, no model involvement. Uses the **class** `Rng` (D4).

```ts
export type Edge = "none" | "advantage" | "disadvantage";
export interface D20Result { rolled: number[]; kept: number; nat20: boolean; nat1: boolean; }
export interface RollOutcome extends D20Result { bonus: number; total: number; target: number; success: boolean; }
export interface DamageResult { expr: string; rolls: number[]; flat: number; total: number; }

export const ORDINARY_DC = 16;      // matches the skill's prose; see S4

export function d20(rng: Rng, edge?: Edge): D20Result;
export function saveRoll(rng: Rng, bonus: number, dc?: number, edge?: Edge): RollOutcome;
export function attackRoll(rng: Rng, bonus: number, targetDefense: number, edge?: Edge): RollOutcome;
export function stuntRoll(rng: Rng, bonus: number, targetDefense: number, edge?: Edge): RollOutcome;
export function moraleRoll(rng: Rng, morale: number): { total: number; holds: boolean };
export function rollDamage(rng: Rng, expr: string, extraDice?: number): DamageResult;
export function parseDamage(expr: string): { count: number; sides: number; flat: number };
export function critEffects(o: RollOutcome): { defenderArmor: boolean; attackerWeapon: boolean; extraDamageDice: number };
```

Rules to encode, confirmed against `docs/Knave 1.0.pdf` and the skill's step files:

- **One threshold convention: `success = total >= dc`, `ORDINARY_DC = 16` (S4).**
  `saveRoll` takes a **DC**; `attackRoll` and `stuntRoll` take a **defense** and apply
  `dcFromDefense` (`+1`) internally, because Knave contests must *exceed* a defense.
  That keeps every function's parameter named the same thing the skill's prose names,
  and puts the only `+1` in the codebase in one tested place. Pin it with tests: a
  save total of exactly 16 succeeds and 15 fails; an attack total of exactly the
  target's defense **misses**.
- Opposed saves need no extra function: a defense is always bonus + 10, so
  `saveRoll(rng, b, dcFromDefense(abilityDefense(other, "dex")))` is the whole thing.
- **Stunts (S6).** `3-standard.md:30` and `5-resolution.md:18`: a hit in `stunt` mode
  produces the stunt and **no damage**, unless advantage was spent as
  "stunt-and-damage", in which case both land and the roll is made at `edge: "none"`
  (`4-confirm-and-roll.md:34` — the advantage bought the combo, not a reroll).
- **`attackRoll` returns damage, not just hit/miss.** `5-resolution.md:32` says the
  crit's extra die "is automatic in the roll" and only the armor-quality loss is
  applied by hand. So the attack path rolls damage internally, including the crit die,
  and returns it — `{ ...RollOutcome, damage?: DamageResult }`.
- **Advantage/disadvantage** is roll 2d20 keep better/worse — on the **d20 only**,
  never on damage.
- **Crits (D6).** Attacks resolve attacker-side always, so only the attacker's nat 20
  and nat 1 branches are reachable. `critEffects` maps the attacker's `RollOutcome` to
  the three consequences. The roll module reports the *fact*; the **applier** performs
  the quality decrement and the destroy-at-zero, because rolls stay pure and stateless
  and quality lives on an entity.
- **Morale**: 2d6, flees when the roll is *higher* than the rating, so
  `holds = total <= morale`. Ratings run 5–9, default 7 (`morale()` in
  `dungeon-entities.ts:278` already returns that). `5-resolution.md:34-40` fixes the
  triggers: half the group eliminated, the leader down, or a lone creature at half HP.
- **No initiative, no reaction table (S7).** Step 5 has creatures act inside
  resolution without rolling initiative, and no step consults reactions. Both are in
  the book; neither has a caller. Leave them out until something needs them.
- **Unarmored is defense 11 / bonus +1.** Already correct in both
  `armorDefense(stats)` and `armorDefense(pc)`.
- **Monster HP is HD × 4** — `maxHp()` (`dungeon-entities.ts:262`) already matches.
- Healing (d8 + CON bonus on a full rest) is defined in the book but has nothing to
  hang on yet; skip until a rest clock exists.

Two RNG streams: `genRng` (dungeon seed, spent during generation) and `runRng`
(run seed, spent during play). Persist the run RNG's draw count so a reload resumes
the same stream — `Rng` doesn't expose its internal state, so store `runSeed` plus
`drawCount` and fast-forward on rehydrate. Add `Rng.prototype.draws` or wrap it in a
`CountingRng` in `runtime/`; prefer the wrapper so `dungeon-blueprint.ts` stays as-is.

**2b. `src/store/game.ts` + `src/store/persist.ts`**

```ts
export interface GameState {
  dungeon: GeneratedDungeon;        // write-once, persisted separately
  pc: PlayerCharacter;
  currentRoomId: string;
  stage: Stage;
  turnCount: number;                // per BUILD-PLAN §2 — add now, consume later
  runSeed: number; rngDraws: number;
  transcript: TranscriptEntry[];    // in-progress exchange
  turnRecords: TurnRecord[];        // structured, completed turns
  pendingRoll?: RollSpec;
  callLog: CallLogEntry[];          // Phase 7 uses it; write it from day one
}
```

`turnCount` is in from the start on the plan's own reasoning — the rooms loop already
generates wandering groups that will want a clock.

Persist split (Part 1): `dungeon:<id>` written once at generation end; `run:<id>`
written on each commit. Use `idb-keyval` behind a small `persist.ts` rather than a
Zustand IndexedDB adapter — the two-key split is easier to express directly.

**2c. The diff applier** — `src/runtime/diffs/`

The single most important piece of code in the project. It is the only thing standing
between a hallucinated field name and a corrupt save.

`types.ts`

```ts
export interface Diff { entityId: string; path: string; value: unknown }

export interface ApplyResult {
  ok: boolean;                                   // false => nothing was applied
  applied: Diff[];
  rejected: { diff: Diff; reason: string }[];
  recomposed: string[];                          // entity ids needing a `composed` refresh
}
```

`paths.ts` — the per-type writable-path allowlist, consulted **first**. An
unrecognised path is refused before dispatch is attempted, so a `base` write never
reaches a handler:

| Type | Writable paths |
|---|---|
| `Room` | `state`, `composed` |
| `RoomConnector` | `state`, `composed`, `conditional` (settable **and** deletable — deleting is how a lock gets resolved) |
| `Creature` | `state`, `composed`, `activity`, `count`, `stats.hp`, `roomId` *(relational)* |
| `RoomFeature` | `state`, `composed`, `hidden` |
| `Item` | `state`, `composed`, `currentQuality`, `amount`, `parentId` *(relational)* |
| `Hazard` | `state`, `composed`, `sprung`, `active` |
| `MobileEffect` | `state`, `composed`, `roomIds` *(relational)* |
| `PlayerCharacter` | `hp.current`, `conditions[]`, `inventory[i]`, `equipped.weapon\|armor\|helmet\|shield` |
| *(any)* | `children[]` — append, i.e. create |

Never writable, on any type, by any path: `id`, `type`, `base`, `name`, `keywords`,
`blueprintId`, `narrative.*`, `stats.hitDice`, `stats.modifiers`, `slots`, `quality`,
`endpointA`, `endpointB`, and on the PC `abilities`, `traits`, `level`, `hp.max`.

`dispatch.ts` — **the path-and-value dispatch table**, which is where `applyDiff`
earns its keep. Each row reads the diff and performs the operation it describes; none
of them blind-writes:

| Path | Value | Operation performed |
|---|---|---|
| `state` | string | write; set `needUpdate = true` (S3) |
| `composed` | string | write; clear `needUpdate` |
| `hp.current` | number | clamp to `hp.max` above, no floor; `<= 0` → `dead` |
| `conditions[]` | string | append |
| `conditions[i]` | `null` | remove, compact |
| `equipped.<slot>` | item id | `equip(pc, slot, id)` — refuses via `canEquip` |
| `equipped.<slot>` | `null` | `unequip(pc, slot)` |
| `inventory[i]` | `null` | **drop**: `removeItem` (clears the equip slot too), compact, reparent to `currentRoomId` |
| `parentId` | PC id | **pick up**: `addItem(force)`, flag overburdened rather than refuse |
| `parentId` | room / creature / feature id | move between containers |
| `parentId` | `null` | destroyed / gone from the world |
| `currentQuality` | number | clamp `[0, quality]`; at 0 destroy and unequip |
| `stats.hp` | number | clamp above; `<= 0` → creature dies, contents drop to its room |
| `count` | number | at 0 the group is wiped out |
| `roomId` | room id | move; occupancy is derived (G2), nothing else to update |
| `roomIds` | string[] | replace wholesale; validate every id |
| `conditional` | string / `null` | set or clear the barrier |
| `hidden` | `false` | reveal |
| `sprung` / `active` | boolean | write |
| `children[]` | entity spec | mint id, set `parentId`/`roomId` from the target, insert |

Every handler returns either success or a message the model can act on — "that item
isn't in the character's inventory", "a shield can't be used alongside a two-handed
weapon" (both already produced verbatim by `canEquip`, `dungeon-character.ts:189`).

**`name` is not runtime-writable** (author's decision). Names are identity: written
once by the content pass alongside `base`, and a referee renaming things mid-run makes
the transcript and the map disagree. If a thing changes enough to need a new name it
should be a new entity — the argument `dungeon-entities.ts:14` already makes about
`base`.

`apply.ts` — the algorithm, in order:

1. **Resolve.** Build (or reuse) a `Map<entityId, {entity, type}>` over every array in
   `EntityPassResult`, plus `pc.inventory`, plus the PC itself. Unknown id → reject.
2. **Validate the whole batch** dry, into a scratch list: every `entityId` resolves,
   every path is allowlisted for that entity's type, every dispatch handler's
   precondition holds (`canEquip`, id existence, value shape). Any rejection →
   `ok: false`, apply nothing (BUILD-PLAN §4.3: atomic per commit).
3. **Stage-gate.** If the commit's `nextStage` is `clarifying` or `rejected` and
   `diffs.length > 0`, reject the entire batch. Enforced here, not by trusting the
   model.
4. **Apply in order** through the dispatch table above. Order matters and is the
   model's to choose — pick the key up before unlocking the door. Rebuild the derived
   room index once at the end, not per diff.
5. **Invariants.** After the batch:
   - Clamp `hp.current` **above only**, to `hp.max`. Do *not* clamp at zero (D5/S5):
     `<= 0` is death, and letting overkill land keeps "dropped to exactly 0" distinct
     from "hit for 12 past dead" in the narration. A floor of `-hp.max` is a
     reasonable sanity bound against a runaway diff.
   - Clamp `currentQuality` to `[0, quality]`. At exactly 0 the item is **destroyed**:
     remove it from wherever it lives and clear any `equipped` slot pointing at it.
     Emit it in the result so the narration can acknowledge a shield coming apart.
   - Run `validateEquipment(pc)` and unequip anything now illegal — recorded in the
     result and surfaced to the player, never silently.
   - Recompute `isOverburdened`.
6. **Mark stale.** Any entity whose `state` changed gets `needUpdate = true` (S3) —
   **not** `composed = undefined`, which would discard a perfectly good description
   for an entity the player may be nowhere near, and would collide with the
   never-encountered signal. `composed` is rewritten at the next encounter.
7. **Return** the structured result so the caller can feed rejections back on retry.

**Tests** (BUILD-PLAN §8 names most of these — write them as the spec):

- a `base` write is refused via every spelling: `base`, `["base"]`, `narrative.base`,
  `stats.hitDice`
- an unknown path is refused and logged
- **the dispatch table, row by row** — this is the bulk of the suite, and each row is
  a test that the *consequences* fired, not just that the field changed:
  - `inventory[1] = null` clears the slot, compacts the array, clears an equip slot
    that pointed at it, and leaves the item parented to the current room
  - `equipped.shield = <id>` is refused while a two-handed weapon is equipped, and in
    the reverse order too — proving it routed through `canEquip` rather than writing
    the field
  - `parentId = <pc>` past slot capacity is *accepted with an overburdened flag*
  - `currentQuality = 0` destroys the item and clears the slot it filled
  - `stats.hp = 0` kills the creature and drops what it carried into its room
  - `roomId = <other>` leaves the derived room index consistent
  - `children[] = {…}` mints an id and parents correctly
- `state` writes set `needUpdate` and leave `composed` **intact**; `composed` writes
  clear `needUpdate`
- one bad diff in a batch of five applies nothing
- a `clarifying` commit carrying diffs applies nothing
- HP is **not** floored at 0: a diff taking a 3 HP character to −2 lands at −2, and
  `dead` fires on `<= 0`
- an item driven to 0 quality is removed and unequipped
- rolls: advantage/disadvantage distribution sanity (10k draws, seeded); `total === 15`
  **succeeds** and 15 fails an ordinary save, and `total === targetDefense`
  **misses** an attack; both reachable crit cases; a monster nat 20 decrements the
  PC's equipped armor and a monster nat 1 decrements the monster's own weapon;
  `parseDamage` on `"1d6"`/`"2d8+1"`/malformed; morale holds
  at exactly the rating and breaks one above it; the reaction table's five bands
- persistence: generate → save → reload → deep-equal

**Exit:** a vitest suite that drives a generated dungeon through ~30 synthetic
commits and ends with a valid, reloadable state.

**Risk:** medium. The work is well-specified; the volume of tests is the cost.

---

### Phase 2.5 — UI shell (proposed addition)

BUILD-PLAN's build order has no UI phase, but Phases 3, 4 and 6 all assume screens
exist, and DESIGN-BRIEF asks for static components with mock data as a standalone
deliverable. Slotting it here means Phase 3 has something real to drive, and it costs
no tokens.

Per the brief: character creation flow, generation screen, play screen in **all eight
input states**, both terminal screens. Static, mock data, no wiring. Deliver the
design plan first — palette as named hex, type pairing with roles, layout concept, and
the signature element — because the brief asks for it and because the narration
column's typeface is described as the most consequential decision in the document.

Structure the play screen so the input area is a single component keyed off `Stage`;
that component is the contract Phase 3 wires into.

**Exit:** every stage renderable from a URL query param (`?stage=roll_offered`) for
review.

---

### Phase 3 — Turn loop against a stub

**Goal:** every stage transition, every diff op, and every rejection path exercised
without spending a token.

**Files**

```
src/runtime/turn.ts               the state machine — drives Step, derives Stage
src/runtime/llm/stub.ts           scripted responses, keyed by (step, input pattern)
src/runtime/prompts/assemble.ts   builds the messages array per step
src/runtime/prompts/render.ts     PC block, room block, turn records
src/runtime/prompts/dungeon-loop/ the skill (moved in Phase 0)
```

**Prompt assembly follows `Step`, not `Stage`** (§0.4). Three call shapes:

| Call | Files loaded | Ends at |
|---|---|---|
| **A — triage** | `SKILL.md` + `steps/1-determine-target.md` + `2-validate-and-classify.md` + `3-handle-by-type.md` + `3-information.md` + `3-standard.md` | `rejected`, `clarifying`, `awaiting_action` (info delivered), `roll_offered`, or straight through to call C for a no-stakes auto-success |
| **B — confirm** | `SKILL.md` + `steps/4-confirm-and-roll.md` | `roll_offered` (re-offer), `clarifying`, `awaiting_action` (cancel), or `rolling` → C |
| **C — resolve** | `SKILL.md` + `steps/5-resolution.md` | `awaiting_action`, `dead`, `goal_met` |
| **D — room entry** | `SKILL.md` + `steps/room-entry.md`. Skipped entirely when `needsComposition` is empty. | `awaiting_action` |

Call A loads five files. That is still far short of the whole playbook and it keeps a
single player action to one round trip in the common case; §4.4's context saving
survives. See Q1 — chaining A into three calls is the alternative.

**The envelope is written** (S2), all of it in `SKILL.md`. Zod mirrors it in
`runtime/llm/schemas.ts`, with both iff-clauses as **refinements** rather than shape
checks:

```ts
interface Commit {
  nextStage: Stage;
  nextStep: Step;
  rollRequest?: RollSpec;   // iff nextStage === "roll_offered"
  diffs: Diff[];            // MUST be empty when nextStage is "clarifying" | "rejected"
}
```

The diffs-empty rule is independently enforced by the applier (Phase 2c step 3), and
the skill states it once in prose so the model complies often enough that the
enforcement is rarely reached.

**What the stub scripts.** Because the skill specifies its rejection and clarification
branches concretely, the stub can be faithful rather than invented. Cover at minimum,
one canned response each: target approved outright (1A), target rejected as
unfounded (1B), target on the fence → justify → persuaded (1C), on the fence →
unpersuaded (1C), invalid action (2), information action answered (3-info B), no-stakes
auto-success (3-standard), save offered → confirmed (3-standard → 4 → 5), attack
offered → weapon clarified → confirmed (4), roll renegotiated for advantage (4),
roll cancelled (4), and a resolution that kills the PC (5).

**`Stage` and `Step`** both go in `runtime/types.ts` — `Stage` is BUILD-PLAN §4.1
verbatim (nine members, drives the UI), `Step` is the seven-member pipeline position
from §0.4. `turn.ts` owns the mapping and is the only place that writes either.

**Context assembly** (BUILD-PLAN §4.4) — rebuild fresh every call, never append:

- system = `SKILL.md` + **only the current stage's step file**
- static prefix = `dungeonContext` (cache-control breakpoint here)
- ground truth, re-rendered each turn = full PC sheet (`render.ts`, using
  `equippedSummary`, `inventoryStatus`, `armorDefense`) + full current room
  (`composed` plus every contained entity's `state`, via the derived room index)
- transcript = the in-progress exchange, **hard-capped at 12 messages**, plus the
  resolution records of the previous **2** completed turns
- completed turns as `{ action, target, roll, outcome, diffsApplied }`, not prose

Write `assemble.ts` so the cap and the window size are named constants with the
reasoning in a comment — they are the two knobs that will get tuned first.

**Envelope validation.** Zod for `Commit`, with a **refinement**, not just a shape
check: `rollRequest` present iff `nextStage === "roll_offered"`. BUILD-PLAN §4.1 calls
this out as a cheap correctness check and it should be a zod error, not a UI
surprise.

#### Narration is buffered until the commit lands. SETTLED.

BUILD-PLAN §4.2 has narration streaming as ordinary assistant text "so the turn feels
alive", with `commit_state` arriving after it. That is unsafe against an atomic
applier: if any diff in the batch is refused, the whole batch is refused — but the
player has already read prose describing things that did not happen. The retry then
either repeats itself or contradicts what they just read.

**So: generate the whole turn, validate the commit, apply it, and only then show the
narration.** Prose the player has read is always true of the game state, with no
window in which it isn't.

What this costs and what it buys:

- The player waits for the full turn instead of watching it arrive. On Haiku a turn is
  a few seconds. The wait is honest and can be filled — the stage already tells the
  interface what the game is doing, and `resolving` is a legitimate thing to show.
- Streaming is still worth keeping *internally* to avoid HTTP timeouts on long
  resolutions; what changes is that deltas accumulate into a buffer rather than
  rendering as they arrive.
- A retry becomes invisible. The player never sees the rejected attempt, so the
  applier's atomicity stops being something they can observe at all.

This is a deliberate departure from BUILD-PLAN §4.2 and the reason is worth keeping in
view: the alternative is prose that can be wrong, and the whole point of routing every
change through one validating chokepoint is that the fiction and the state never
disagree.

**Tests:** a scripted playthrough — enter room, act, get asked to justify, answer, get
offered a roll, argue for advantage, get re-offered, roll, resolve, take damage, die.
Assert the `(step, stage)` sequence and the resulting state. Plus: a stub response with
a bad envelope triggers exactly one retry then surfaces; a `rejected` commit carrying
diffs applies nothing; the 12-message in-progress cap actually truncates during a long
step-4 renegotiation, which is exactly the loop BUILD-PLAN §4.4 wrote the cap for.

**Exit:** the Phase 2.5 UI plays a complete scripted dungeon run end to end, offline.

**Risk:** low once B1 lands. High if it doesn't — the stub would be guessing at a
contract.

---

### Phase 4 — Real model

**Goal:** replace `stub.ts` with `client.ts`. First real play.

**Work**

1. **Streaming narration.** SSE from the messages endpoint through the proxy; text
   deltas append to the current narration block. The proxy must not buffer — set
   `changeOrigin` and leave the response stream untouched.
2. **`commit_state` as a terminal tool call.** Narration is ordinary assistant text;
   structure arrives as the tool call. Treat "stream ended without a `commit_state`"
   as a retryable error.
3. **The dice tool (`roll`).** The model's only source of randomness. It draws from
   `runRng` and returns a `D20Result`/`DamageResult`. Needed mid-resolution when
   creature turns require rolls nobody could have anticipated. Enforce the CLAUDE.md
   rule structurally: every number in the narration should trace to a tool result, and
   the call log makes that auditable.
4. **Room entry pass (S1).** Its own call, and the one piece of the referee the skill
   doesn't specify. Returns narration plus a batch of `set` diffs writing
   `state`/`composed` for the room and everything in it — the entities' first
   transition out of `undefined`. This is the moment fog of war lifts, so it is also
   what Phase 6 keys off. `5-resolution.md:53` sketches the procedure (collect the
   room's entities, compose bottom-up from contents to room, describe the location)
   and `3-information.md:21` supplies the rule it has to honour: a hidden thing stays
   a *clue* on entry and only becomes the thing itself under a directed look. Write it
   as `steps/room-entry.md` in the skill's voice.
5. **Retry on invalid.** Feed `ApplyResult.rejected` reasons back and retry once.
   Second failure surfaces to the player as software-voice copy ("the referee lost the
   thread — retry?"), per the brief's rule about keeping diegetic and system voices
   apart.
6. **Terminals.** `dead` when `hp.current <= 0`; `goal_met` per the Dungeon Pass's
   `goal.spec`. Both freeze the input and route to the character library.

**Tests:** integration tests behind an env flag (they cost money) that run one real
turn per stage. Snapshot the assembled prompts (not the responses).

**Exit:** a complete real playthrough, death or goal, no manual intervention.

**Risk:** high — streaming + tool use + retry interacting is where the fiddly bugs
live. Keep the stub wired behind a flag so the loop stays debuggable offline.

---

### Phase 5 — Character creation

**Unblocked** — everything below is transcribed from `docs/Knave 1.0.pdf`.

`src/engine/character-creation.ts`, pure and seeded:

```ts
export function rollAbilities(rng: Rng): CharacterAbilities;   // 3d6 keep LOWEST die, x6
export function swapAbilities(a: CharacterAbilities, x: Ability, y: Ability): CharacterAbilities;
export const POINT_BUY: { budget: number; min: number; max: number };
export function validatePointBuy(a: CharacterAbilities): string[];
export function rollTraits(rng: Rng): CharacterTraits;         // the eleven
export function rollTrait(k: keyof CharacterTraits, rng: Rng): string;  // individual reroll
export function rollHp(rng: Rng): number;                      // d8, starting AND max
export function rollStartingGear(rng: Rng): IItem[];
export function startingCopper(rng: Rng): number;              // 3d6 x 20
export const SHOP: ShopEntry[];                                // slot cost is first-class
```

**Abilities.** Roll 3d6 per ability *in order*, the **lowest** die is the bonus,
defense is bonus + 10. Knave then allows swapping the scores of **two** abilities
after rolling — a small affordance the brief's "reroll-all, not per-ability" rule
doesn't cover, and worth having since it is the one place the player gets agency in
the rolled path.

**Starting gear**, per the book: everyone gets 2 days of rations and one weapon of
their choice, then rolls once on Armor, once on Helmets and Shields, **twice** on
Dungeoneering Gear, and once each on General Gear 1 and General Gear 2.

| Table | Result |
|---|---|
| Armor (d20) | 1-3 none · 4-14 Gambeson · 15-19 Brigandine · 20 Chain |
| Helmets and Shields (d20) | 1-13 none · 14-16 Helmet · 17-19 Shield · 20 both |

Armor stat lines — these are the first real producers of `IItem.armor` and so the
first real exercise of D1's `armorType`:

| Item | `armorType` | defense | slots | quality | cost (cp) |
|---|---|---|---|---|---|
| Gambeson | `body` | 12 | 1 | 3 | 60 |
| Brigandine | `body` | 13 | 2 | 4 | 500 |
| Chain | `body` | 14 | 3 | 5 | 1200 |
| Half Plate | `body` | 15 | 4 | 6 | 4000 |
| Full Plate | `body` | 16 | 5 | 7 | 8000 |
| Helmet | `helmet` | 1 (flat +1) | 1 | 1 | 40 |
| Shield | `shield` | 1 (flat +1) | 1 | 1 | 40 |

Weapons, as `IItem.weapon`:

| Class | damage | hands | slots | quality | cost |
|---|---|---|---|---|---|
| Dagger, cudgel, sickle, staff… | d6 | 1 | 1 | 3 | 5 |
| Spear, sword, mace, axe, flail… | d8 | 1 | 2 | 3 | 10 |
| Halberd, war hammer, long sword, battle axe… | d10 | 2 | 3 | 2 | 20 |
| Sling | d4 (ranged) | 1 | 1 | 3 | 5 |
| Bow | d6 (ranged) | 2 | 2 | 3 | 15 |
| Crossbow | d8 (ranged) | 2 | 3 | 3 | 60 |

Note the d10 class is **2 hands**, which is what makes `canEquip`'s shield conflict
bite in ordinary play rather than as an edge case.

**Traits.** All eleven tables (physique, face, skin, hair, clothing, virtue, vice,
speech, background, misfortunes, alignment) are in the PDF as d20 tables — alignment
is 1-5 Law / 6-15 Neutrality / 16-20 Chaos. **Check `dungeon-blueprint.ts` first**:
the Maze Rats character tables feeding `genNpc` overlap heavily, and duplicating a
table that already exists is how the two drift apart. Reuse where the lists match,
transcribe only the gaps.

**Shop.** The Item Costs page gives ~90 entries in copper. Slot cost is not printed
per item for most gear (the book's rule is "most items take 1 slot"), so default to 1
and carry the explicit slot counts for armor and weapons above. Per the brief, the
shop UI shows slot cost at least as prominently as price.

UI per the brief: five steps, back-navigable, nothing committed until the end;
per-trait reroll (not just reroll-all) on step 2; the slot meter visible from the
moment anything is carried, reading as a budget being spent.

Character library in local storage, separate from run state. This doubles as the dev
quick-start, so build the "load character → skip creation" path in the same session.

**Tests:** ability distribution over 10k seeded rolls; point-buy validation edges;
every equipment table roll produces a legal `IItem` (including a valid `armor.type`
after D1); slot arithmetic against `slotCapacity`.

---

### Phase 6 — Floorplan maps

A real dungeon map with room outlines, not the circles-and-lines placeholder.
`pointLayout` and `DungeonMap` already ship and already consume `Layout` with
`Shape`/`Path` as discriminated unions, so the `polygon` and `polyline` cases are
stubbed and waiting. Nothing downstream of `Layout` changes.

Three sessions: **6a** geometry (headless), **6b** the map on screen, **6c**
fixtures and the feedback loop into the content pass.

#### What is settled

**Corridors are rooms, drawn from the existing six-per-chunk budget.** Not a new
entity type, not a promoted connector — a room whose identity is a passage. This was
chosen over minting passage rooms and over giving `IRoomConnector` place-ness because
it is the only option that costs nothing anywhere: no new entities, no topology
change, no extra content-pass tokens, no ordering cycle, and no change to
`travel.ts`, `occupancy.ts`, fog, the room block or the referee's step files. A
corridor is a room and everything already works on it.

The cost is roughly 17% of the content rooms at every size. That is the point rather
than the price — a dungeon of nothing but stocked rooms reads as beads on a string,
and corridors are the pacing.

Count is **N−1 / N / N+1 at 25 / 50 / 25**, where N is the size. Size 1 is a coin
flip between 0 and 1.

Selection: **degree ≥ 2** (a corridor connects somewhere, so dead ends are out),
never the goal room, never adjacent to another corridor (that is one hallway with a
pointless door in it), **distributed across depth bands**. Depth rather than chunk,
deliberately — `RoomStock.chunk` is "purely a batching unit, never a content input",
and corridors are about rhythm along the path inward.

Dropping any degree preference beyond ≥ 2 removes the one degenerate case: a size-1
chunk with a 3-cycle and three spurs has degrees 3,3,3,1,1,1 and therefore *no*
degree-2 rooms. Under "≥ 2" that is three eligible rooms rather than none, and no
size needs a special case.

A corridor keeps its headline and its contents. It rolls `identity` on a new
**Dungeon Corridors** table and `detail` on the existing shared Dungeon Room Detail
table, so it swaps one table and changes no fields.

**Designation happens in stocking**, immediately after the entrance and goal roles
are fixed and before the headline quota. That is the first point at which every
input exists — it cannot be earlier than Phase A because it needs degree, and it
cannot be in Phase A because the goal room is stocking's.

**The plane is flat and nothing overlaps.** Stairs, shafts and ramps are flavour that
matters only inside the room where the change occurs; nothing in the model gets a z.
This makes the map a *planar* drawing of the Phase A graph — see below.

**Chambers get an area band and a shape.** `class >= degree - 1`. No goal-room bump.

| class | # | area |
|---|---|---|
| tiny | 1 | 4–11 |
| small | 2 | 12–41 |
| medium | 3 | 42–89 |
| large | 4 | 90–155 |
| vast | 5 | 156–225 |

Area bands, not dimension pairs, so a long room has somewhere to go. **The bands are
contiguous.** An earlier draft made them non-overlapping by leaving gaps — 9→12,
36→42, 81→90, 144→156 — and those gaps turned out to be a direct cause of the
size-4/5 packing failure. See 6a.2.

Shape is four axes that vary independently — **family** (`rect` · `L` · `T` ·
`cross` · `round`), **proportion** (`square` 1–1.25 · `moderate` 1.25–2 · `long`
2–4), **relief** (0 perfect · 1 irregular · 2 highly irregular), and the size band
above. 6a shipped a single five-valued `form` list that did all three jobs at once
and drew 86% of chambers as plain rectangles as a result; **6a.2 supersedes it** and
is the authority on the shape model. Band on **floor area**, cap the **bounding box**
separately at 24 cells a side.

`class >= degree - 1` replaces an earlier per-wall perimeter constraint, which was
solving the wrong problem. A 2×2 room has four sides and can technically take four
doors; what a high-degree room actually needs is **placement freedom** — neighbours
arranged on several sides at once — and that is what size buys. One comparison
instead of a perimeter calculation.

**Corridors get no class.** 1–3 cells wide by default and whatever shape the
connection needs: straight, L, cross, blob. Their length is whatever gap the packing
leaves, which makes them the **slack in the layout** — when two rooms cannot quite be
brought face to face the corridor between them stretches or bends instead of the
whole placement failing. That property is a direct consequence of corridors being
rooms and it is what makes the packer tractable.

#### Planarity — measured, not assumed. **LANDED** (`dungeon-planarity.ts`)

A flat plane with no overlaps means the drawing must be a planar embedding of the
Phase A graph, and Phase A does not currently guarantee one. Measured over 1000
dungeons per size with a Demoucron-based checker validated against K5, K3,3,
Petersen, a subdivided K5, two K5s at a cut vertex and planar controls:

| size | rooms | edges | not drawable flat |
|---|---|---|---|
| 1–3 | 6–18 | 6–21 | 0.00% |
| 4 | 24 | 30 | 4.00% |
| 5 | 30 | 36 | 8.50% |

For **all 125 failures the region-level wiring was fine** — the tangle is always in
which rooms the inter-chunk links landed on, never in how the regions connect. And
generating until a drawable dungeon appears took **1.10 attempts on average, worst 3**
across 200 samples at size 5.

**Decision: reject and retry.** One predicate added to Phase A's `validate()`; the
existing `generateValid` loop absorbs it with no new machinery. Repairing the stub
assignment instead would preserve every seed but costs real changes to `pickStubRoom`
for a problem that costs 0.1 of a generation to sidestep.

**Breaking change.** Adding a check to the validator makes `generateValid` advance
past seeds it used to accept, so a seed number maps to a different dungeon at sizes 4
and 5. Determinism snapshots move; saved runs at those sizes are invalidated. Sizes
1–3 are untouched. There is also a mild distribution bias — the most tangled 8.5% of
size-5 layouts are discarded — which is arguably desirable, since those are the ones
that would have drawn worst.

What the measurement does *not* prove: that a good-looking drawing exists with rooms
that have real width and height. Planarity is the necessary condition, not the
sufficient one. It was the one that could have killed the flat-plane rule outright.

**Outcome.** `src/engine/dungeon-planarity.ts` — Demoucron path addition, returning
the rotation system rather than a boolean. `Dungeon.embedding` is set iff the graph
is planar, and `validate()` reads exactly that. 29 tests; the whole suite stayed
green, and no snapshot moved, because nothing in it pinned a size-4 or size-5 seed.

Three things the session settled that the plan above did not anticipate:

- **Demoucron needs a biconnected graph and the dungeon graph is not one** — a sixth
  of its rooms are dead ends. So the graph is split into blocks, each embedded
  separately, and the rotations concatenated at the cut vertices. That is why "two
  K5s at a cut vertex" is in the test set: the split must not lose a non-planarity.
- **Faces are kept as *directed* cycles throughout.** The rotation then falls out of
  the face corners already consistently oriented, instead of needing a second pass to
  reconcile per-vertex directions.
- **Parallel edges go in opposite order at their two ends.** The sliver of face
  between two parallel edges is bounded by one of them in each direction. Getting it
  backwards yields a rotation that looks right and traces to the wrong face count —
  which is what caught it, and why every planar test verifies `V − E + F = 1 + C` by
  walking the returned rotation rather than trusting the boolean.

**Re-measured with the shipped checker**, 1000 seeds per size — same shape, slightly
different numbers than the session that made the decision, since the seed stream
differs:

| size | not drawable flat | mean attempts | worst |
|---|---|---|---|
| 1–3 | 0.00% | 1.00 / 1.02 / 1.06 | 2 |
| 4 | 3.50% | 1.17 | 4 |
| 5 | 10.00% | 1.22 | 4 |

Still a fifth of a generation at worst, against `generateValid`'s 50-attempt ceiling.

#### 6a — Geometry, headless

No React, no content-pass change. The risky half, built where iteration is a shell
command — the same discipline as Phase 1.

**Phase A gains planarity. ✅ DONE.** The checker becomes engine code and is extended
to return **the embedding** — the cyclic order of neighbours around each room —
rather than a boolean. That order is the placement plan: it tells the packer which
side each neighbour belongs on, turning placement from a blind search into a guided
one. Same computation, more of it returned. See the planarity section above for what
shipped.

**Stocking gains corridor designation**, per the rules above.

**`src/engine/dungeon-floorplan.ts`** — pure, seeded, never imports React.

1. **Footprints.** An exception table maps `identity` to a form and size class.
   `identity` rolls on `DUNGEON_ROOMS`, whose three nested references reach
   `BUILDING_ROOMS`, `LOWER_CLASS_BUILDINGS` and `UPPER_CLASS_BUILDINGS` — about
   **130 distinct nouns**, so a complete mapping is a chore that would rot. Annotate
   only the ~40 that genuinely imply a geometry (Banquet hall, Barracks, Catacombs →
   long; Well, Fountain, Oubliette → round; Cavern, Chasm, Mine shaft → irregular;
   Chapel, Throne room → composite; Privy, Cabinet, Wardrobe → tiny). The rest fall
   through to a default that **still rolls among the classes**, because monotony is
   the failure mode to design against, not inaccuracy. Then the hard floors:
   `class >= degree - 1`, and floor area sufficient for the entity count the entities
   pass has already minted.
2. **Placement.** Breadth-first from the entrance, each room placed on the side the
   embedding assigns, backtracking when a room will not fit. **Connected rooms share
   an exact wall** — no rock between them, no gap. The wall is a stroke on the shared
   boundary and the door is a break in it. **Author's call**; an earlier draft put a
   one-cell gap between rooms and claimed it was what made placement tractable, which
   was overstated. Both pin the facing coordinate of every connected pair; the gap
   only adds a unit of slack in one axis. Shared walls are in fact the simpler thing
   to write, because placing a room against its neighbour fixes the shared edge and
   leaves only the offset along it free.

   Two consequences worth holding onto. **Only connected pairs must abut** — the
   graph averages 2.4 edges per room, so a room shares walls with two or three
   neighbours and rock remains everywhere the graph is silent; this is not a
   honeycomb. And **corridors carry all of the slack** now, since nothing else in the
   layout can stretch. Unconnected rooms that happen to end up neighbours get a solid
   wall and no door, which is also correct.
3. **Doors.** One per connector, on the facing walls, typed from the connector's
   existing fields — plain, gated, concealed.
4. **Emit.** Room polygons, corridor polygons, door positions and orientations,
   bounds.

**`validateFloorplan()`** — the equivalent of `dungeon.valid`, and what makes
topological accuracy a guarantee rather than a hope. No two rooms overlap; every
connector's two rooms share a wall segment with that connector's door in it; every
connector has exactly one door; every room's door count equals its degree; bounds
contain everything. The map is planning information the referee has to be able to
agree with, so this is not optional.

**A `layoutSeed`** joins `RunSeeds`, and the floorplan is stored on
`GeneratedDungeon` — persisted rather than recomputed, because 6c makes the prose
refer to it.

**`--map out.svg`** on `cli-generate.ts`. Plain line art, no decoration. This is the
iteration surface and it is the whole reason 6a is headless.

**Tests:** the planarity checker against the eleven known graphs; every dungeon
planar after the validator change across a seed spread; corridor count distribution,
no corridor adjacent to another, goal never a corridor; `class >= degree - 1` and
area within band for every chamber; `validateFloorplan` across 200 seeds × sizes 1–5,
recording the attempt distribution; determinism on an id-stripped canonical form
per G5.

**Exit:** a hundred seeds across every size produce valid floorplans, dumped as SVG
and eyeballed.

**Risk: high, concentrated entirely in placement.** Everything else here is tables.
If backtracking is slow at size 5 the escape hatch is the same as everywhere else —
throw the seed away — and 6a measures and reports rather than tuning. **Author's
call: do not pre-optimise this.**

#### 6a outcome — ⚠️ **PLACEMENT MISSES ITS EXIT AT SIZES 4–5**

Everything except placement landed and is tested: planarity, corridor designation,
the two tables, footprints, doors, `validateFloorplan`, `layoutSeed`, the floorplan
on `GeneratedDungeon`, and `--map`. 457 tests green, build clean.

**The packer draws sizes 1–3 and does not draw 4–5.** Per-attempt success, measured
over 15 dungeons × 8 layout seeds per size:

| size | rooms | per-attempt | with 24 attempts | ms/attempt |
|---|---|---|---|---|
| 1 | 6 | ~100% | 100% | 30 |
| 2 | 12 | 50.8% | ~100% | 146 |
| 3 | 18 | 11.7% | ~95% | 289 |
| 4 | 24 | 0.8% | ~18% | 778 |
| 5 | 30 | 0.8% | ~18% | 800 |

The exit criterion asked for a hundred seeds at every size. It is met at 1–3 and
missed at 4–5, and the shape of the failure says the remaining gap is not tuning.
Three algorithms were tried and measured:

1. **Slide a fixed rectangle around looking for a fit.** Fails almost everywhere
   past size 1. A chunk interior is a *cycle*, and a cycle has to meet up: walked
   greedily around the ring, the last room arrives needing to touch two neighbours
   that are by then six rooms apart.
2. **Derive the rectangle from its neighbours** instead of guessing positions —
   assign each placed neighbour a side and the geometry is nearly determined, so
   only the slide along a shared wall is searched. Plus maximum-cardinality
   ordering, which closes each ring while it is still small. This is what shipped,
   and it is what got sizes 1–3.
3. **Let the size class follow the rectangle** rather than pin it. A room pinned on
   opposite sides has its width dictated outright, and one band of one form very
   rarely contains that exact number. `class >= degree - 1` still holds by
   construction because nothing below the floor is ever offered.

**What is actually needed is a rectangular dual**, built from the planar embedding
6a.1 already produces: triangulate the planar graph with dummy vertices that become
rock, compute a regular edge labeling, and read the mosaic off it. That produces a
valid drawing *by construction* rather than searching for one, which is the right
shape for a problem where the failure rate compounds with room count. It is its own
session, and it is the natural 6a.2.

Two consequences held in the meantime, both deliberate:

- **`GeneratedDungeon.floorplan` is nullable** and every consumer treats the map as
  an enhancement over `pointLayout`, not a dependency. A dungeon with no floorplan
  is completely playable. 6b must keep that true.
- **The guarantee the packer makes is soundness, not coverage.** It does not promise
  to draw every graph; a plan it hands back has been through `validateFloorplan` in
  the tests at every size — nothing overlapping, every footprint one piece, every
  connector exactly one door, and that door in a wall its two rooms really share.

Smaller things that differed from the plan as written:

- **Cells are packed integers, not `"x,y"` strings.** Placement tries tens of
  thousands of positions and the string version spent its time allocating and
  re-parsing keys. `Point`s at the boundary; the packing never leaves the file.
- **Form is carved after placement, never before.** A notch cut ahead of time is
  free to remove the very cell carrying a shared wall, so `irregular` and
  `composite` are applied to the placed rectangle and refuse to drop any cell that
  is load-bearing or that would break the bounding box the band is measured on.
- **The archetype table is asserted reachable**, per §6a — every key resolves in
  `DUNGEON_ROOMS` / `BUILDING_ROOMS` / `LOWER_CLASS_BUILDINGS` /
  `UPPER_CLASS_BUILDINGS`.
- **Corridor designation shifted the stocking RNG stream**, so six prompt snapshots
  moved and two `generation.test.ts` fixtures needed a seed that still stocks
  wanderers (1007 → 1008). Expected, and the comment naming why is still there.
- `--map` works under `--dry`: the geometry is pure, so iterating on it needs no
  key and no calls.

#### 6a.2 — Room shape ⚠️ **PARTLY SUPERSEDED BY 6a.3**

The size vocabulary below is live and load-bearing: `AREA`, `classOf`,
`ARCHETYPES` and `sizeAllows` are what 6a.3 reads. The rest of this section
describes the rectangle packer, which 6a.3 replaces — the family axis
(`rect`/`L`/`T`/`cross`/`round`), the relief carving and the placement search are
all still in `dungeon-floorplan.ts` and still tested, but nothing in the
generation path calls them. Read it for the size model; skip it for the geometry.

6a shipped with **86% of chambers drawn as plain rectangles**, measured over 728
chambers at sizes 1–3. Corridors were fine — 126 of 136 genuinely L-shaped, cross
or blob — but the chambers were flat, and the size-4/5 packing failure is entangled
with why.

Three separate causes, only one of them deliberate:

- **`round` was drawn as a square.** The spec line `round — square` meant square
  *proportions*; no circular outline existed in the code. 163 rooms — a fifth of the
  dungeon — rolled the well, the fountain, the fighting pit and got a box.
- **L, T and cross for chambers were never built.** 6a lists straight/L/cross/blob
  under *corridors* only; for chambers it says "roughly square with jogs" and
  "by construction", and that narrower reading is what got built.
- **Shape was carved after placement, with a guard that refused to touch any cell
  abutting another room.** So shape was suppressed exactly where rooms meet, and it
  silently did nothing on anything under 5×5. 70 of 119 "irregular" rooms came out
  as rectangles anyway.

##### The model

The old list did three jobs at once. Split into axes that vary independently:

| axis | values |
|---|---|
| **family** | `rect` · `L` · `T` · `cross` · `round` |
| **proportion** | `square` (1–1.25) · `moderate` (1.25–2) · `long` (2–4) |
| **relief** | `0` perfect · `1` irregular but the shape still reads · `2` highly irregular |
| **size** | five **contiguous** bands: 4–11 / 12–41 / 42–89 / 90–155 / 156–225 |

**Relief is a modifier, not a category.** That is the fix for the flatness: a T-shaped
room can have a niche, a round room can have a bay. Tangling it into `irregular` and
`composite` is why those were the only two forms that ever got carved.

**`cave` is not a family.** A cavern is relief 2 over whatever family is underneath —
which is more expressive than a category of its own, since a heavily relieved cross
is a natural fissure and a heavily relieved rectangle is a collapsed hall.

**Round takes proportion and relief like anything else.** Square + relief 0 is a
circle; long is an oval; relief 2 is a blob. One family, no special case.

**The size bands are contiguous, and the gaps were a bug.** 9→12, 36→42, 81→90,
144→156 were the side effect of making bands non-overlapping, and they are a direct
cause of the packing failure: a room pinned between two fixed neighbours has its
width dictated, and if the resulting area lands in a hole there is no legal room at
all. Contiguous bands make "the class describes the rectangle that fit" principled
rather than the workaround 6a shipped.

Band on **floor area**, cap the **bounding box** separately at 24 cells a side, which
relief 2 may exceed. A cross fills perhaps 40% of its box, so the two numbers come
apart badly on the shaped families and only one of them is what the fiction means.

**Rooms always have walls.** Two abutting rooms have a wall down the edge between
them; they are not one open space with a line drawn on it. The door is what connects
them, and it is a break in that wall. This is true of the drawing and of the fiction.

##### Hard, firm, soft

**Family is hard, proportion is firm, size is soft.** A well that is not round is
wrong; a banquet hall that is not long is wrong; a well one class larger than it
rolled is nobody's problem. In 6a everything was equally rigid and the packer had
nowhere to give — that rigidity is the failure.

##### The archetype table on the axes

Each noun constrains a subset and leaves the rest free, which is where the variety
comes from. Relief is now one of the things it constrains.

| group | constrains | free |
|---|---|---|
| Banquet hall, Ballroom, Barracks, Gallery, Dormitory, Stables, Kennel, Catacombs, Sewers | proportion = long | family, relief, size |
| Well, Fountain, Pool, Fighting pit, Oubliette, Observatory | family = round, relief ≤ 1 | proportion, size (Well also pins tiny) |
| Cavern, Chasm, Mine shaft | relief = 2 | family, proportion, size |
| Chapel, Shrine, Temple, Throne room, Courthouse, Opera house | family = T or cross, proportion = long, relief ≤ 1 | size |
| Courtyard, Garden, Marketplace, Park, Theater, Warehouse | size ≥ large, relief = 0 | family, proportion |
| Privy, Cabinet, Cloakroom, Wardrobe, Pantry, Larder | size = tiny, relief = 0 | — |

The axial group gains most: `composite` was an invented form that narrowed one end.
On these axes it is simply a **T** — stem and bar, nave and transept — a real shape
with ~10,800 distinct medium silhouettes behind it.

**Relief rolls 25 / 75 across 0 / 1. Relief 2 never rolls** — it appears only where
the archetype demands it. Tiny is pinned to relief 0.

##### Measured, before building

Distinct footprints per family within a band, and in brackets distinct *silhouettes*
ignoring rotation and mirroring:

| | tiny | small | medium | large | vast |
|---|---|---|---|---|---|
| rect | 6 (4) | 57 (30) | 63 (33) | 51 (27) | 27 (15) |
| L | 216 (29) | 7,200 (912) | 16,308 (2,052) | 17,316 (2,178) | 8,328 (1,052) |
| T | 308 (48) | 30,288 (4,199) | 78,696 (10,797) | 84,836 (11,632) | 36,592 (5,057) |
| cross | 76 (19) | 33,088 (5,090) | 104,624 (15,567) | 102,186 (15,446) | 29,617 (4,817) |

A medium cross has ~15,600 genuinely different shapes, because the bars need not be
centred and the two bars have independent thicknesses. Repetition is not a risk.

Round, where the doubt was. Relief 1 and 2 figures are distinct silhouettes out of
600 sampled draws, so they double as a collision rate:

| proportion | relief | tiny | small | medium | large | vast |
|---|---|---|---|---|---|---|
| square | 0 | 2 | 7 | 9 | 11 | 12 |
| square | 1 | 20/583 | 250/600 | 504/600 | 588/600 | 599/600 |
| square | 2 | 28/474 | 506/596 | 600/600 | 600/600 | 600/600 |
| long | 0 | 2 | 14 | 24 | 28 | 11 |
| long | 1 | 40/599 | 384/591 | 576/600 | 599/600 | 598/600 |

Three readings. **Relief 0 is genuinely repetitive and that is correct** — a medium
circle has nine possible shapes, and two perfect circles the same size *should* look
alike; it is why 0 is the minority roll. **Relief 1 is the workhorse**, 504 unique in
600 at medium and effectively 100% at large and vast. **Tiny cannot carry relief at
all** — 20 distinct in 583 draws — which is why it is pinned to 0. (The long/vast
relief-0 figure of 11 is depressed by the 24-cell enumeration cap, not by the design.)

##### Order of work, and the only real constraint

> **chambers → corridors → relief**

Niches only remove cells, so they can never cause an overlap. Bays add cells outside
the placed footprint, so they can — but applied *after* corridors, into cells already
verified as empty rock, they cannot fail. Relief becomes decoration on a plan that is
already sound, and `validateFloorplan` re-checks it regardless.

The carving guard is **three things and no more**: never remove a cell carrying a
door; keep the footprint in one piece; stop before the floor area leaves its band.
6a's guard also refused any cell abutting another room, which was wrong — the
validator only requires that a connector's door sits in a wall its two rooms share,
and says nothing about how long that wall is. Since a room has ~2.4 connections, the
old rule put the whole length of every shared wall off limits, often half the
perimeter; the door-only rule costs two or three cells. Roughly half the boundary
comes back, and it is the half the eye reads. Cap how far a shared wall may be eaten,
so two rooms are not left joined by a single cell that looks accidental.

The cost is a mild bias — bays appear where there is spare rock, so outer rooms get
more of them than tightly packed interior ones. That reads correctly: an interior room
genuinely has nowhere to bulge.

##### This is half a fix for the packer, and the half matters

**Family belongs inside the packer, chosen as part of placing each room.** Not
stamped on afterwards — that was 6a's mistake and it is why shape contributed nothing
to solving the layout.

The mechanism is worth stating because it is the same constraint that broke 6a. A
rectangle's area is width × height, so a room pinned between two fixed neighbours has
its width dictated, and its **achievable areas are then quantised to multiples of
that width** — one of those multiples has to land in the band, and the holes in the
old bands meant sometimes none did. Pinned on all four sides, both dimensions are
exact and there is a single candidate area. A cross in that same dictated bounding
box can take almost any area by varying arm thickness.
**The shaped families decouple the bounding box from the floor area**, which is
exactly the coupling that was strangling placement. Per-room options go from ~63
medium rectangles to well over 100,000 across families.

Relief does **not** help — it runs after corridors, by which point every loop is
already closed.

So: build the family axis into the packer and **re-measure the size-4/5 rate before
committing to the rectangular dual**. It improves the per-room odds substantially but
it is still a search, so failures still compound with room count; it may carry size 4
and leave 5 short. That measurement is an afternoon and the dual is a session, so it
is the cheap experiment to run first.

##### The types

All of it inside `dungeon-floorplan.ts`. `RoomForm` is retired.

```ts
export type Family     = "rect" | "L" | "T" | "cross" | "round";
export type Proportion = "square" | "moderate" | "long";
export type Relief     = 0 | 1 | 2;
export type SizeClass  = "tiny" | "small" | "medium" | "large" | "vast";  // unchanged

export interface RoomShape {
  family: Family;
  proportion: Proportion;
  relief: Relief;
  sizeClass: SizeClass;
}

// FloorplanRoom: `form: RoomForm` + `sizeClass?: SizeClass`  ->  `shape?: RoomShape`
```

`shape` is optional for the same reason `sizeClass` was: a corridor is whatever the
connection needed and has no shape to report. Making it one object rather than four
loose fields matters for 6c, which hands the whole thing to the content pass.

`AREA` becomes contiguous — 4–11 / 12–41 / 42–89 / 90–155 / 156–225. `ASPECT` is
re-keyed from family to **proportion**, which is the axis that actually governs it,
and a `BOX_CAP = 24` constant carries the bounding-box limit that `dimensionsFor`
currently hard-codes as its loop bound.

`Archetype` widens to constrain any subset of the axes, which is what makes the table
in §"The archetype table on the axes" expressible:

```ts
interface Archetype {
  family?: Family | Family[];     // Chapel: ["T", "cross"]
  proportion?: Proportion;
  relief?: Relief;                // pins it — Cavern: 2
  maxRelief?: Relief;             // caps it — the round group: 1
  sizeClass?: SizeClass;          // pins
  minClass?: SizeClass;           // floors
}
```

**This is a cheap change to make.** `form` and `sizeClass` escape
`dungeon-floorplan.ts` into exactly one place — the `class >= degree - 1` assertion at
`floorplan.test.ts:198`. No UI reads them (6b is unbuilt), no prompt payload carries
them (that is 6c), so **no prompt snapshot moves.** The floorplan determinism fixtures
move, because the layout RNG stream changes shape; that is the whole blast radius.

##### Where each piece lands

| Today | Becomes |
|---|---|
| `footprintFor(room, minCells, rng): Footprint` | `shapeFor(room, minCells, rng): ShapeRoll` — rolls the axes and returns what is pinned and what is free. No dimensions. |
| `dimensionsFor(cls, form): Rect[]` — precomputed per class × form | `candidatesFor(roll, box): Footprint[]` — **called from inside the packer**, given the bounding box the neighbours have already dictated |
| `carveForm(cells, form, box, grid, rng)` — runs before corridors | `applyRelief(cells, relief, grid, doors, rng)` — runs **after doors** |

**`candidatesFor` is the load-bearing change and the reason the signature moves.** 6a
precomputed a list of rectangles per class and asked placement to find one that fit;
that is backwards once families are shaped. The packer knows the box before it knows
the footprint, so the question is "given this box, what shapes of my family land in my
band" — and a cross answers it by varying arm thickness, where a rectangle can only
answer with the one area its dictated width permits. That inversion is the fix.

A `round` room is an ellipse inscribed in its box, rasterised by a new `ellipseCells`
primitive — the only genuinely new geometry in the session.

##### Order of work

The design says **chambers → corridors → relief**. The pipeline is one step longer
than that, because relief's guard needs to know where the doors are:

> **chambers → corridors → doors → relief**

Relief is last, which is stronger than the design claims and worth having: by then
every loop is closed, every door is placed, and `applyRelief` is decorating a plan
that has already passed. Today `carveForm` runs at `dungeon-floorplan.ts:958`, before
corridors — moving it past the door loop is most of the diff.

The guard is **three things and no more**: never remove a cell carrying a door; keep
the footprint in one piece; stop before the floor area leaves its band. Plus the cap
on how far a shared wall may be eaten, so two rooms are not left joined by a single
accidental-looking cell.

##### Round is capped at degree 4. SETTLED

**A round room's shared walls are short.** An ellipse meets an orthogonal neighbour
along a handful of cells at each cardinal point, and `validateFloorplan` requires
every connector's door to sit in a wall segment its two rooms genuinely share. A
degree-5 round room has nowhere to put the fifth door.

So **`round` is only offered at degree ≤ 4**, falling through to the next candidate
family otherwise. It costs nothing — the archetype group that pins round is six
nouns, and a well or an oubliette with five ways out was never the common case.

`class >= degree - 1` does not cover this on its own, and the reason is worth keeping
in view because it generalises: that floor buys **area**, on the theory that a bigger
room has room to arrange its neighbours on several sides. What a door actually needs
is a **flat run on the boundary**, and the two come apart on every shaped family — a
vast ellipse has exactly four, the same as a small one. Degree is a constraint on
perimeter shape, not on size.

This is the one place a rolled family can be refused outright, so it belongs in
`candidatesFor` alongside the band check rather than in `shapeFor`: the roll stays
honest and the packer declines what it cannot draw.

##### Tests

- every `ARCHETYPES` key still reachable from the four tables (the existing assert,
  extended to the new constraint shape)
- the roll: **relief 2 never rolls unbidden**, tiny is always relief 0, relief is
  25/75 across 0/1 everywhere else
- every chamber's floor area is inside its band; every bounding box is ≤ 24 a side
  except where relief 2 pushed it out
- `class >= degree - 1` still holds — rewritten against `shape.sizeClass`
- `applyRelief` never removes a door cell, never disconnects a footprint, never
  leaves the band, and never eats a shared wall past the cap
- every `round` archetype draws as an ellipse and not a box — the specific 6a bug
- **no `round` chamber has degree > 4**, across the full seed spread, and a room whose
  archetype pins round but whose degree is 5 still draws — as some other family, and
  still passing `validateFloorplan`. The fallback is the half that can silently fail.
- **the flatness metric as a regression test.** 6a shipped 86% plain rectangles. Assert
  the chamber family distribution over a seed spread and fail above **40%** `rect`.
  This is the one number the session exists to move, so it should be a test rather
  than a measurement somebody remembers to take.
- `validateFloorplan` across 200 seeds × sizes 1–5, unchanged
- determinism on the id-stripped canonical form per G5

#### 6a.3 — The block plan ✅ **BUILT AND WIRED IN**

`src/engine/dungeon-blockplan.ts`. The dungeon is drawn by dividing the ground
between the rooms rather than by searching for somewhere to put each of them.
Nothing backtracks and nothing compounds, so a thirty-room dungeon is not
meaningfully harder to draw than a six-room one.

##### The pipeline

```
1. CENTRES   Phase A positions, scaled so a connection is 5-9 cells round a
             corner (inter-chunk at the top of that), then spring-relaxed
             against those targets.
2. UNTANGLE  Hill-climb the crossing count to zero by swapping the two rooms on
             a crossing pair, with a jiggle to escape plateaus. Alternates with
             the spring pass and gets the last word.
3. BLOCKS    Each anchor becomes a 2x2, anchor at a randomly chosen corner.
4. PATHS     One-turn lines between block rims, shortest connection first. On a
             jam, MOVE A ROOM and re-route rather than rerolling the seed.
5. ZONES     Rooms take turns claiming ground -- rock, or a corridor they are an
             end of, never another room's. Interior rooms first, corridors last.
             Stops when every corridor cell has an owner.
6. ROOMS     A skeleton through the room's doors, then growth one cell at a time
             inside an aspect band toward a target area.
7. DOORS     One per connector, at random along the wall the two rooms share.
```

**Crossings have to go, and that is a hard requirement rather than a nicety.**
Phase A validates that the *graph* is planar — that a crossing-free drawing
exists — but `relax()` is a plain spring simulation with no notion of a crossing,
and its positions routinely contain them: every size-4 dungeon has at least one
and size 5 averages six. Two rooms sharing a wall is a contact representation and
cannot contain a crossing, so step 2 is what makes steps 4 onward possible at all.

**Adjacency holds by construction.** Both rooms are required to contain their
side of an agreed contact before either is drawn, so a connected pair always
shares a wall and there is never anything to search for or check afterwards.

**A 2x2 rather than a single cell**, because one cell has four ways out and a
one-turn line can only leave toward its target — a room with three or four
connections then has to find distinct exits among neighbours offering two options
each, and frequently cannot.

**Repair, not restart.** The spacing pass is a convergent relaxation, so a fresh
seed lands in much the same layout; when a connection jams, the fix is to move
the room that failed.

**Growth is cell by cell, not ring by ring**, and that is what lets proportion
steer. A ring adds to every side at once, so a long room could only ever get
fatter. Cell by cell it takes the cells at its ends and refuses its flanks, and
grows by getting longer.

##### Size is read off the room. **SETTLED**

An archetype's size pin used to be an instruction to the packer — a Well had to
come out tiny — and the ground available rarely obliged. Now the geometry settles
first, `roomSizes()` reads the class off the finished floor area, and the pin is
**a condition on the identity roll**: `sizeAllows(identity, class)`. A four-cell
closet does not get to be a banquet hall. Always satisfiable, because the roll is
what bends.

**Four bands, tight, against spacing of 5-9:** tiny 4-9, small 10-25, medium
26-35, large 36 and up. They describe what the block plan actually draws — rooms
of ten to forty cells on zones of twenty to forty — rather than an idealised
spread. An earlier five-band version ran to 196 and put three of its five bands
out of reach, which made the size a worse signal than no size at all. `vast` is
gone.

The *target areas* the room grows toward while filling its zone are a separate
roll and are unchanged.

##### Where it runs

The layout needs the Phase A graph and which rooms are passages, and nothing
else. So it runs *inside* stocking, between corridor designation and identity:

```
graph -> pre-pass + corridor designation -> BLOCK PLAN -> size per room
      -> identity conditioned on size -> headlines, danger, rewards, content
```

`stockDungeon` takes a `layout` hook called at that point; `generate.ts` supplies
it. `RoomStock.sizeClass` carries the result. Everything after identity is fiction
and works from the room as drawn.

**`minCells` is gone, deliberately.** The old packer raised a room's size class to
fit what the entities pass had put in it. A room's size is now capped by the
ground its neighbours left it, and the entities pass runs after the drawing
regardless, so stocking decides what fits in the room rather than the room being
sized to the stocking.

##### Measured

Per attempt, 8 dungeons x 100 attempts, roughly a millisecond each: **100% at
size 1, 98.8% at size 3, 39.7% at size 5.** Soundness across sizes 1/3/5: every
plan sound — no overlaps, every room one connected piece, every connected pair
sharing a real wall, exactly one door per connector and every door in a wall its
two rooms share.

##### Tests

`blockplan.test.ts`, 18 tests, about ten seconds. Four plans at each of the five
sizes, built once, and every guarantee asserted against all of them: no two rooms
share a cell, every room is one piece, **every connected pair shares a wall**,
exactly one door per connector and both rooms contain their side of it, and rooms
leave rock rather than tiling their zones. Plus determinism for a layout seed —
and its opposite, that a *different* seed draws a different plan, which is the
thing that was silently untrue when the jitter only reached the tie-breaks.

The spacing assertion is deliberately "most, not all". Untangling swaps rooms to
clear a crossing without regard for spacing and gets the last word, so about 83%
of connections land in the 5–9 band and that is correct behaviour, not slack.

##### Outstanding

1. **Size 5 fails about one dungeon in eight**, with ~0.5 crossings surviving the
   hill-climb. **HANDLED BY STARTING OVER — author's call.** `generate.ts` throws
   the graph away and generates another, up to 8 (`GRAPH_ATTEMPTS`), which puts
   the failure rate somewhere around one seed in ten million. It costs nothing:
   the branch is pure and runs in milliseconds, and the fiction branch reads
   `blueprint` rather than the graph, so nothing in flight is invalidated and no
   tokens are re-spent. The seed still names one dungeon, because the retry seed
   is derived (`<graphSeed>~<n>`) rather than random.

   **TODO, not this phase.** Cheapest ideas first: flip a whole branch across a
   crossing rather than swapping two rooms; allow occasional worsening steps;
   stop the spring pass reintroducing crossings; bail before routing when
   untangling did not reach zero. The proper answer is to derive positions from
   the planar embedding rather than hill-climbing toward it — then the retry
   loop runs once, always.
2. **Relief is not applied.** It was to run last, on the built rooms.
   **OUTSIDE MVP.** The axis and its carving code still exist in
   `dungeon-floorplan.ts` and are still tested; nothing calls them.
3. ~~**Nothing downstream consumes the plan.**~~ **DONE in 6b** — `floorplanLayout`
   turns it into a `Layout` and the map renders it.
4. **Large and vast rooms are unreachable.** Zones average 20–40 cells and `large`
   starts at 72. Accepted: size feeds only the identity roll, and the bands that
   matter for that are reachable.
5. **The family axis is unused**, so no round, cross or T-shaped rooms. Accepted
   for now — revisit if the drawings read as monotonous.
6. **Proportion cannot lengthen a room whose doors cluster**, because the skeleton
   runs between the doors, so "a banquet hall is long" is not honoured. Accepted.
7. **Target areas are a placeholder roll** (`[6, 9, 14, 20, 28, 40, 56]`) rather
   than derived from the size classes.
8. **Corridors are only mildly narrower than chambers.** Accepted for now.

**What size actually feeds.** `RoomStock.sizeClass` is written by the layout hook
and read by exactly one thing — the `sizeAllows` condition on the identity roll.
It is persisted, so the content pass and 6c can use it later, but nothing else
reads it today.

The vocabulary now lives in **`src/engine/dungeon-room-size.ts`** — the bands,
`classOf`, the archetype table and `sizeAllows` — because the rooms loop and the
block plan both need it and sit on opposite sides of the drawing. Tables and
predicates only, no geometry.

#### 6b — The map on screen ✅ **BUILT**

`floorplanLayout(plan, graph): Layout` alongside `pointLayout`. `DungeonMap.tsx` is
rewritten against the same interface, which is what the §7 boundary was for, and
both layouts render through the one component — the point layout is still the
fallback when `blockplan` is null, which a run saved before the plan existed will be.

Under the block plan a connector has **no corridor to draw**: corridors are rooms, so
a connected pair already shares a wall and the connector *is* the break in it. So
`Layout` gains a door rather than a polyline — `{ at, wall, through }` — and the
`polyline` case stays unused. Three other additions, each because the geometry
demanded it:

- **`Shape.polygon` gains `holes?`.** A room grown frontier-by-frontier can close a U
  on itself. Filled without the hole it draws floor over rock.
- **`LayoutRoom.centre`.** Not derivable from the shape: averaging the vertices of an
  L puts the player marker in the rock outside it. It is a cell the room owns.
- **`LayoutConnector.to` is `string | null`**, matching `IRoomConnector.endpointB`
  and `ExitView.toRoomId`. Null is the surface.

**The way out needed placing, not just drawing.** It is the one connector that is not
a graph edge — the entities pass mints it with `endpointB: null` — so `chooseDoors`,
which walks `graph.edges`, never saw it, and *the map had no door for the only exit
every dungeon has*. `BlockPlan.surface` now places it on a wall of the entrance room
facing open rock, chosen uniformly at random among those. It is drawn unlike anything
else: the gap, then a dashed torch stub reaching into blank paper and stopping,
because it is the only door on the map with nothing on its far side.

`Layout.surface` carries no connector id, because this module knows only geometry and
the surface connector is not in the graph. `mapView` joins it by its null end.

**Fixed cell scale, not normalised.** `pointLayout` normalises into a box; the
floorplan multiplies cells by a constant. A wall should be the same weight whether
the dungeon is six rooms or thirty, and the viewBox scales the whole thing anyway.
Normalise and size 1 draws in fat crayon while size 5 draws in hairline.

**A door is a white rectangle outlined in ink at the wall's own weight**, lying along
its wall, a little thicker than the wall line so it covers it rather than sitting on
it, and **three quarters of the wall's length** so it stops short of the corners at
either end. Outlined rather than bare, so it reads as a leaf set into the wall rather
than as a gap left in it. `LayoutDoor.length` carries the length, because the layout
is what knows the cell size and the renderer should not have to be told. A first pass
drew an open gap with a jamb at each side; it read as a hole somebody forgot to draw.
A blocked door is the same rectangle with the outline in torch.

**Every room takes the same fill, corridors included.** Tinting a passage `panel` to
set it apart made it match the ground the dungeon is cut out of, so a corridor read
as a hole in the map rather than as a place. What a corridor is comes across through
its shape and its prose. `LayoutRoom.corridor` stays, unread by the renderer, because
6c wants it.

Interactivity: hover on rooms and doors giving name + `composed`, as an HTML overlay
rather than `<title>` — `composed` is a paragraph, and the native tooltip renders it
in the system font at the system width after half a second. **Click a door to
travel**, through a confirmation, then dispatched as ordinary text through the normal
turn path so it is identical to typing it. A blocked door stays clickable so the
referee gets to be the one that says no. Player marker at `centre`. Wheel zoom, drag
pan, double-click to reset.

**The confirmation is not ceremony.** A misclick on a map costs a model call and a
slice of the run, where typing has a keystroke of friction built in; and the player
should read the sentence before it is sent, since text is the only thing they can
hold the referee to. `TravelConfirm` shows it in quotes.

**Only the current room's doors are clickable.** A door across the map is a route
rather than a step — `routeTo` can walk one, but phrasing a route as a sentence the
player never wrote is how the map starts saying things they did not mean. Far doors
are hover-only. Revisit with the route UI, if there is one.

`--map` on `cli-generate.ts` now dumps the **block plan** through `floorplanLayout`
and `layoutSvg`, not the superseded 6a floorplan. Through the same function the app
uses, deliberately: a dump that renders the plan its own way can look right while the
panel looks wrong.

The map may know more than the fiction but never differently. Nothing is drawn that
the referee has not been told about.

**Deferred out of 6b**, all recorded rather than dropped:

- **The second fog bit** — a corridor walked through but never stood in is *seen, not
  examined*, and should be drawn without having cost a composition call. Not built;
  `composed === undefined` is still the only fog signal.
- **The blank area beyond the surface exit** standing for the outside. The stub is
  there; the space around it is not designed.
- **Room labels drawn in the polygons.** The name is on the hover only.
- **Hover on features and items.** They are not drawn until 6c's fixtures.

#### 6c — Fixtures and the feedback loop

**Where 6b leaves this.** Read this part first; it is the difference between what 6c
was drafted against and what is actually in the tree.

- **`RoomShape` does not exist on a drawn room.** 6a.2's four axes are still typed and
  tested in `dungeon-floorplan.ts`, but the block plan does not use them: the family
  axis is unbuilt (§6a.3 Outstanding 5), relief is **outside MVP** (Outstanding 2),
  and proportion is a growth hint that a room whose doors cluster cannot honour
  (Outstanding 6). **What a drawn room actually knows is its `sizeClass`** — written
  by the layout hook onto `RoomStock.sizeClass`, persisted, and today read by exactly
  one thing, the `sizeAllows` condition on the identity roll.
- **So the first decision in 6c is what to send.** Either the payload carries size,
  dimensions and exits-by-direction and drops the shape axes, or the family axis gets
  built into the block plan first and 6c sends the full `RoomShape`. The second is a
  session of its own and buys a richer prompt; the first is available now. **Take the
  first unless the drawings read as monotonous** — the axes were designed to fix a
  packer that no longer exists.
- **The geometry 6c needs is all in `floorplanLayout`'s inputs.** `BlockPlan.rooms[i]`
  is the cell set, so dimensions and floor area are a bounding box away.
  `BlockPlan.doors` and `BlockPlan.surface` give exits, and their wall direction falls
  straight out of `LayoutDoor.wall` plus which side `through` points — a door whose
  `through` is north of its `at` is a north exit. Nothing new has to be computed.
- **`LayoutRoom.corridor` is already plumbed** and unread by the renderer. A corridor
  should get a different fixture menu from a chamber, and that flag is how.
- **The way out is a first-class thing on the map now** (`BlockPlan.surface`,
  `Layout.surface`) and the content pass should know which room has it.

The content pass gains a **fixture menu** — a fixed enum of drawable things (cells,
bunks, stalls, pews, pillars, pool, hearth, pit, altar, shelves, sarcophagi, well,
stair, rubble) plus a coarse position vocabulary ("along the north wall", "centre",
"far end") — and in return receives each room's dimensions, its size class and its
exits by wall direction. Geometry goes over as words rather than as coordinates, so
"a long hall with three ways off the east wall" is something the model can write to
without ever seeing a number.

This is the accuracy multiplier and the reason the floorplan runs **before** the
content pass. Prose gets written against the drawn room rather than the keyword the
room started from, and cardinal directions become something the referee can say and
the map can corroborate. Code owns the footprint — packing feasibility needs
iteration a model cannot do, and a persisted map that drifts between generations of
the same seed is worse than prose that drifts — while the model furnishes the
interior.

The model returns enum values, never numbers and never geometry, so the CLAUDE.md
rule holds. Unrecognised values are dropped, never fatal.

**Fixtures are stored as data — id, cells, orientation — and rendered separately**,
never baked into SVG at generation time. **Author's call: markers are plain dots on
their own layer for now**, with the line art deferred. Keeping them as facts about
the room rather than pictures of it is what leaves "the pillars are cover" available
later.

**Exit:** a live generation produces prose that agrees with the map.

**Cost:** prompt snapshots move, and this needs a real generation to verify — the
offline fixtures cannot prove it.

**Two things 6b left that 6c should not inherit by accident:**

- ~~**`DungeonMap.tsx` has no test behind it.**~~ **DONE in 6c.3.** There was no jsdom
  project configured (deferred since Phase 0: "arrives with the first UI test"). The
  geometry was covered — `layout.test.ts` and the `mapView` block in
  `selectors.test.ts` — but nothing rendered the component. 6c adds a fixture layer to
  it, which is the point at which that stopped being acceptable.
- **`dungeon-floorplan.ts` is now entirely dead to the generation path.** The 6a
  packer, `generateFloorplanValid`, `floorplanSvg` and `validateFloorplan` have no
  callers left outside `floorplan.test.ts` — `--map` was the last one and 6b moved it
  to the block plan. Roughly a thousand lines that still typecheck, still pass their
  tests, and describe a design that lost. **Confirm with the author before deleting**,
  per the B3 precedent, but it should go: the size vocabulary that is still live was
  already lifted into `dungeon-room-size.ts`.

#### 6c.1 outcome — geometry and fixtures, headless ✅ **BUILT**

The first of two sessions, split on the author's call: everything that runs without
React, built where iteration is a shell command — the same discipline as Phase 1 and
6a. 512 tests green, build clean. **The React half is 6c.2, below, and nothing here
is visible in the app yet.**

**The first decision went the way the section above recommends.** The payload carries
size, dimensions and exits-by-wall; the 6a.2 shape axes are not sent, because they do
not exist on a drawn room. Nothing suggested the drawings read as monotonous.

##### `src/engine/dungeon-geometry.ts` — the drawn room, as words

Pure, derived, never persisted. The block plan is the durable thing and this is one
function over it, so the vocabulary can change without a migration.

`roomGeometry(plan, graph, opts)` gives, per room: floor area, the bounding box in
cells **and in feet**, `sizeClass`, proportion, which way the long side runs, the
outline, the longest unbroken run against each of the four walls, every exit with the
wall it cuts and where along that wall it sits, and the exit the player most likely
arrives by. `siteRooms` returns that alongside `RoomGround` — the cells, the door
cells and the arrival cell — and **the two halves are kept apart on purpose:** the
words go in the prompt, the cells stay behind to place what the words come back
describing.

`describeGeometry` renders one line:

> `as drawn: a small chamber, about 10 by 35 feet -- long and narrow, running
> north-south, close to a rectangle, give or take a corner. Ways out: one off the
> south wall, one off the east wall`

Three things settled while building it:

- **`CELL_FEET = 5`, in one constant.** The moment two places convert cells to feet
  they disagree. Five is the dungeon-map convention and it is the number that makes
  the bands read right — a four-cell closet comes out 10 by 10.
- **The compass is map-absolute and the prompt says so.** North is up, the drawing
  never rotates, and nothing in the model knows which way the party is facing. So the
  instructions forbid "left", "right", "ahead" and "behind" outright, and a test
  asserts `describeGeometry` never emits one. A relative direction is a lie the moment
  the player walks back through.
- **`roomDepths` is computed here** by BFS from `graph.entrances` rather than read off
  `RoomStock.depth`, so the module needs the plan and the graph and nothing else. Same
  separation the block plan itself makes.

**The outline thresholds are measured, and the first pass was wrong.** Over 1,520
chambers across sizes 1–5 the box-fill runs min 0.04, p25 0.53, **median 0.67**, p75
0.78, max 1.00 — the block plan grows rooms cell by cell out of a skeleton, so a clean
rectangle is the rare case. Cutting at 0.95 / 0.68 called **56% of the dungeon
"ragged, nothing like a rectangle"**, which is a strong claim about the majority and
therefore no information at all. At **0.85 / 0.60** the three words come out near
16 / 48 / 36 and each distinguishes its rooms from the others. Re-measure before
changing either number.

The rest of the vocabulary, same corpus: proportion moderate 44 / long 33 / square 22;
long axis east-west 41 / north-south 37 / none 22; size small 58 / tiny 22 / medium 13
/ large 7; exits spread over 2 walls 56%, 3 walls 24%, 1 wall 18%, 4 walls 2%. Varied
enough that the line is worth its tokens.

##### `src/engine/dungeon-fixtures.ts` — the menu and the placement

Fourteen kinds and nine position words, both exported as `const` arrays with type
guards, and **both interpolated into the prompt from the same constants the validator
reads**, so the menu and what apply will accept cannot drift.

**The model picks a kind and a position. Code rolls the count and picks the cells.**
That is the CLAUDE.md rule stated for this pass, and it is a test: every kind is
placed twenty times and asserted inside its own `[lo, hi]`. "Pillars" is a decision
about the room; "six pillars" would be a number the model invented.

Placement refuses door cells and cells another fixture already took, uses
farthest-point sampling so a colonnade reads as a row rather than a clump, and moves a
wall-hugging kind to the longest wall when asked for the centre — the position word is
a preference, what the object *is* is a fact. A word that resolves to nothing falls
back through the whole room rather than dropping the fixture. It returns undefined
only when there is no legal floor at all.

**Caps rather than quotas**: tiny 1, small 2, medium/large 3, any passage 1. The model
has never been shown the grid and has no sense of what a stone coffin takes up.

**The menu is printed once**, in the instructions, with a `*` on the kinds a passage
can hold. A first pass repeated it under all six rooms — three kilobytes a call to say
the same fourteen things six times.

##### What the content pass gained

`ContentRoomBrief.geometry` (the sentence), `ConnectorBrief.wall` (which wall this
room's exit cuts, on the connector's own line rather than gathered elsewhere), and a
per-room fixture cap. In return `RoomResponse` gains `fixtures[]`, and `position` on
`entities`, `promotions` and `goal` — so **the stocked chest, clue, hazard and the
objective itself get placed alongside the furniture**, which was the author's call and
is the difference between a map that dots the scenery and one that dots what the
player came for.

`ContentPassPayload.ground` carries the cells from build to apply. **The renderer does
not touch it and must not:** the payload is already the channel for everything else
apply looks up by ref, and coordinates are the half of the geometry that stays on this
side of the boundary.

An unrecognised `kind` drops the fixture; an unrecognised `position` falls back to the
centre. Neither is ever fatal. The zod schema deliberately takes `position` as a loose
string and lets `applyContentPass` narrow it — a rejected batch is six unwritten rooms
and a retry, where a bad position word is a pillar in the wrong place.

##### Entities, and the map's headless half

`IRoomFeature.place` and `IItem.place` hold `{ cells, position, fixture? }`. `position`
sits next to the cells because it is what the **prose** may say while the cells are
what the **drawing** uses; re-deriving either from the other is how they drift. Written
once at generation and **not on the applier's writable-path allowlist** — a brazier
knocked over changes its `state`, not its footprint.

`addFixture` mirrors `promoteDetail` in the entities pass. It writes no
`ElementBinding`: a binding ties an entity to the *stocked* element it came from, and a
fixture came from no roll.

`Layout.fixtures` and `placedThings()` in `occupancy.ts` carry it to the drawing;
`layout-svg.ts` draws plain ink dots at a third of a cell. Verified end to end on an
offline size-3 dungeon: 18 rooms, 48 placed things, 86 marks, every one inside its room
and clear of every doorway.

##### A pre-existing bug this turned up

**`generateOffline` was never running the layout hook inside stocking.** It computed
the block plan alongside, which left `RoomStock.sizeClass` unset on the dev path — so
`sizeAllows`, the condition that stops a four-cell closet rolling "Banquet hall",
silently did not apply offline while it did apply live. Fixed by mirroring
`generate.ts`. That is why room identities moved in five snapshots, and it is the
reason `--dry` now runs the hook too: a dry run that skipped it would render prompts
without the "as drawn" line, which is most of what there is to iterate on.

##### `dungeon-floorplan.ts` — parked, not deleted. **AUTHOR'S CALL**

Kept as the record of a design that lost. What is *not* kept is the cost: the four
suites in `floorplan.test.ts` that exercise the packer are `describe.skip`, and the
top-level `beforeAll` that built a hundred drawn rooms is gone (`corpus()` is memoised
and lazy, so unskipping costs nothing). The module still typechecks, so it cannot
silently rot.

**Two suites stay live and must:** `corridor designation` covers stocking, and
`chamber archetypes` covers the vocabulary in `dungeon-room-size.ts` that the identity
roll reads through `sizeAllows`. Neither touches the packer. The live `traceOutline` is
`runtime/layout.ts`'s and is covered by `layout.test.ts`; the skipped one is the
engine's dead copy.

The author asked for the module commented out; parking the *test* was proposed instead
and accepted in effect — the module costs nothing to keep compiling, and the 488-line
suite was the whole of the runtime bill.

##### Tests

`geometry.test.ts`, 28 of them. The derivation is checked against hand-built cell sets
where the answer is obvious by eye — a 3×3, an L, a 12-cell L in a 4×4 box — and then
swept over real plans for the facts that have to hold: area never exceeds its own box,
proportion and long axis agree, a wall run never exceeds the box side it lies along,
**every room has exactly as many exits as it has doors** (the assertion that catches a
door indexed from one side only, which is what leaves a room describing fewer ways out
than it has and the writing pass inventing replacements), and the same door reads
through opposite walls from its two rooms.

The placement tests are written as the contract with the content pass, because those
are the ones that would go silently wrong: never in a doorway, never two things in one
cell, never outside the room, the count always inside the kind's range, "far end"
genuinely further from the arrival than "near the entrance", deterministic per seed and
different across seeds.

The offline fixture now returns fixtures and positions, so the whole apply path is
exercised for free on every run.

#### 6c.2 outcome — on screen and in the room block ✅ **BUILT**

524 tests green, build clean. Four of the five items below landed; the fifth, the
jsdom project, is deferred again by the author and is the only thing between here
and Phase 6 being finished.

##### THE RULE — an entity updates on the map only when its `composed` changes

**Author's, and it is the load-bearing idea in this half.** It is the same
precedence `dungeon-entities.ts` already sets for prose — *what the player was told
binds* — applied to the drawing.

One test does every job at once, because `composed` is written in exactly one
circumstance: the player is looking at the thing.

| case | why it falls out |
|---|---|
| never encountered | `composed === undefined`, nothing drawn |
| concealed | room entry never composes a hidden thing, so likewise |
| changed two rooms away | `setState` marks `needUpdate` and **leaves** `composed`, so the marker goes on saying where it was last seen |
| revealed by a search | `setIsHidden(false)` sets `needUpdate`, the next composition writes `composed`, and the dot arrives **with** the prose rather than before it |

That last row is worth stating plainly: **the applier already did its half.** No diff
handler changed. `setIsHidden` opening a description debt on reveal, and `setState`
declining to touch `composed`, are what make a `composed`-gated map correct without
any new bookkeeping.

The filter lives in `mapView` and nowhere else. `Layout.fixtures` deliberately carries
every placed entity, concealed ones included, because `layout.ts` knows only geometry —
the same arrangement `LayoutConnector` has. A second filter would be a second place for
the rule to be wrong.

**The one case the rule does not cover for free, recorded rather than solved:** the
*position* of a thing that moves. Features never move. Items can, and an item that
leaves its placed room currently loses its marker — right for every path that exists
today, since all of them happen with the player watching (they picked it up), and wrong
for a thief carrying something off while they are elsewhere, which wants a "last seen
here" snapshot of where the entity was when `composed` was last written. **Creatures
need that snapshot too and have no marker at all yet, so it arrives with creature
markers.** Not before: a field that nothing reads correctly is worse than a documented
gap.

##### What was built

1. **`MapView.fixtures`** (`selectors.ts`) — the four tests above, plus `includeHidden`
   honoured for the debug tools exactly as connectors honour it.
2. **`DungeonMap.tsx` fixture layer** — one `<g>` per entity, one dot per cell, drawn
   in `graphite` so contents sit under walls in the eye's reading order, with a
   transparent stroke widening the hit area because a three-unit dot is not a cursor
   target. Hover gives name, position and `composed`.
3. **`PlayScreen`** passes `placedThings(dungeon.entities)` — the **generated** copy,
   not the run's, since `place` is not on the writable-path allowlist and so the
   footprints really are fixed for the run. Which of them may be seen is `mapView`'s
   question, answered against the run copy by id.
4. **The geometry at runtime.** `RoomView.geometry`, `ExitView.wall`,
   `EntityView.position`, rendered by `renderRoom` as an `### As drawn on the map`
   section, a wall on each way out, and a position on each placed thing. Plus a
   **"The map is open beside them"** section in `steps/room-entry.md`.

   `geometryOf` memoises `siteRooms` in a `WeakMap` keyed on the `GeneratedDungeon`:
   `roomView` runs on every render and every prompt assembly, `siteRooms` covers all
   thirty rooms, and the inputs are write-once — so the cache cannot go stale and
   cannot leak.

**The referee reads the same sentence the content pass was given**, from the same
function, and there is a test that rebuilds it from the plan rather than comparing
against a literal. That is the whole of the feedback loop: prose written to the drawing
at generation, prose written to the drawing at runtime, one derivation behind both.

##### `positionPhrase`, and why the wire form and the prose form are separate

The position words are enum values — short, unambiguous, easy to pick off a list. They
do not survive being dropped into a sentence: prefixing with "at" produced **"at
throughout"** and **"at near the entrance"**, and both reached a prompt before this
existed. `positionPhrase` is the one place the prose form is decided, and the map hover
and the room block both go through it so they match word for word rather than merely
agreeing.

##### A vacuous test, caught

The first draft of "drops an item's marker once it is no longer lying in that room"
looked for a loose item in the **entrance** room and returned early if there was none.
Seed 1005 at size 2 has none, so it asserted nothing and passed. It now takes the first
placed item in any room and fails loudly when there is none. Worth recording as a
pattern rather than an incident: a guard clause that skips is a test that lies.

##### What is left of Phase 6

**One item, and then the exit criterion.**

5. **The jsdom project and the first `DungeonMap` test.** Deferred since Phase 0
   ("arrives with the first UI test"); §6c named the fixture layer as the point at
   which that stops being acceptable, and the fixture layer now exists. The geometry
   under it is covered — `layout.test.ts`, `geometry.test.ts`, and the `mapView`
   blocks in `selectors.test.ts` — so what is missing is specifically that nothing
   renders the component. **DONE in 6c.3, below.**

**The 6c exit criterion is unmet and can only be met live:** "a live generation
produces prose that agrees with the map" needs a real call. Everything built in 6c.1
and 6c.2 is plumbing and vocabulary; whether the prose is any good is discovered
against a model, and the offline fixtures cannot prove it. **MET — see 6c.4.**

#### 6c.4 — the live run ✅ **EXIT CRITERION MET**

`--seed 4201 --size 3`, 133s, 30,497 in / 16,845 out. "The Petrified Catacombs",
18 rooms (3 corridors), 22 doors plus the way out, 32 placed things, 40 marks.

**The prose agrees with the map, and closely.** The drawing said of the entrance
region's first chamber: *a small chamber, about 20 by 30 feet — oblong, running
north-south, ragged, nothing like a rectangle.* The model wrote: *a cramped, oblong
room … The chamber runs north to south, barely twenty feet wide but thirty feet long,
and the ragged outline of its walls suggests…* Dimensions, orientation and outline all
carried, and the same held across the rooms spot-checked at every size class — a large
roughly-square chamber written as *roughly square and ragged … perhaps forty feet
square*, a corridor as *a narrow passage running east-west, roughly twenty-five feet
long and ten feet wide, its walls stepping in and out*. The size vocabulary reached
the fiction rather than sitting in the payload.

**The map-absolute compass rule holds.** 74 pieces of written prose, **zero** relative
directions — no "to the left", "ahead of you", "behind you" — and 17 of 18 rooms use a
cardinal direction. That was the rule most at risk from a model writing scene-setting
prose, and the instructions carried it.

##### The one real finding, and it is not 6c's

**Three of about ninety written things came back unwritten**, and `validateWritten`
reported all three:

| | where |
|---|---|
| an item, no name and no base | in The Fungal Passage, chunk 1 |
| a hazard, no name and no resolvable base | `blueprintId` present, `registry.hazards` entry empty |
| a connector, no physical form | **The Pit ↔ The Stone Dormitory, both in chunk 1** |

The connector is the one that says what this is. Both its rooms are in the *same
chunk*, so it is not a seam and the seams pass was never going to write it — the chunk
that owned it simply left it out of an otherwise well-formed response.

**So the gap is that omission is not a schema error.** The retry policy is "on zod
failure, retry that chunk once" (BUILD-PLAN §5), and a response that answers with five
of six connectors is valid JSON against a valid schema. It passes, and nothing notices
until `validateWritten` sweeps at the end, by which point the pass is over and there is
no retry left to take. This is a **Phase 1 exit criterion failure** — "no empty `base`
on any room, connector, creature, feature, item, or hazard" — surfacing on the first
live run since 6c changed the payload, not a regression in the map work.

Worth fixing, and not in this session. The cheap version is a completeness check on
each chunk response before it is accepted — every ref the payload asked about is
present — which turns an omission into exactly the zod-shaped failure the retry
already handles.

#### 6c.3 outcome — the jsdom project ✅ **BUILT**

553 tests green (29 new), build clean, `tsc --noEmit` clean. The last structural item
in Phase 6; what remains is the live exit criterion above, which is the author's call
to spend.

##### Two projects, split on the file extension

`vite.config.ts` grows a `test.projects` pair. `.test.ts` is the headless project and
stays exactly as it was — the engine and the runtime are framework-free by rule, and
`src/ui/screens.test.ts` renders through `renderToStaticMarkup` and needs no DOM.
`.test.tsx` is the jsdom project. The extension is the whole of the rule, so a test
lands in the right project by being written in the syntax it needs, and nothing that
existed moved.

`@vitejs/plugin-react` is not involved: `tsconfig.json` sets `jsx: "react-jsx"` and
Vite's esbuild transform reads it, so JSX in a `.tsx` test compiles without the plugin
being part of the test pipeline.

##### One devDependency, and a twenty-line harness

**`jsdom` only — no testing library.** Author's call, on the reasoning that kept this
project off a component library. What these tests actually assert is
`container.querySelectorAll("path")`, because the map is SVG and has almost no roles
or text to query by; `render` and `fireEvent` are the whole of what a library would
have added, and they are the two functions in `src/ui/__fixtures__/dom.ts`
(`renderDom`, `fire`, plus `leave` and `drag`). `renderDom` unmounts in an `afterEach`
— a component left mounted keeps its window listeners, and `TravelConfirm`'s Escape
handler is one.

`src/ui/__fixtures__/jsdom-setup.ts` holds what jsdom does not implement and nothing
else. That is currently **`setPointerCapture` / `releasePointerCapture` /
`hasPointerCapture`**, which jsdom 29 lacks while shipping `PointerEvent`, and which
`DungeonMap.tsx:240` calls unconditionally so a drag survives the cursor leaving the
svg. Plus `IS_REACT_ACT_ENVIRONMENT`. The rule for that file is worth keeping: it
supplies missing entry points, it never fakes behaviour.

##### Two kinds of fixture, deliberately

**The real dungeon** — `generateOffline(1005, 2)` through `floorplanLayout` and
`mapView`, the same three calls `PlayScreen` makes — for anything about counts and
correspondence: fog, the §7 boundary, one mark per cell, the marker on `centre`.
Those have to hold against data nobody arranged.

**A hand-built `MapView`** for the interaction branches. Clicking the right one of
fourteen doors means first working out which `<rect>` it is, which means re-deriving
`doorRect` in the test — so the test would be checking its own arithmetic. One door,
placed by hand, checks the component.

##### What the 21 map tests cover

Fog (nothing drawn before the first room is described, and no marker either); the
marker on `LayoutRoom.centre` rather than an average corner; **the §7 boundary** —
the same `<path>` element drawn with arcs from `pointLayout` and with corners from
the block plan, which is the only test that renders the fallback a pre-blockplan save
comes back on; one `<g>` per fixture entity and one dot per cell; hover giving name,
`composed` and `positionPhrase`; travel restricted to the current room's doors, a
blocked way still clickable and outlined in torch, a read-only map not throwing; the
way out as the only door with a dashed stub; wheel zoom clamped at 1:1, drag, and
double-click reset. `TravelConfirm` adds 8: the sentence handed back is the sentence
shown, focus, Escape, the listener removed on unmount, backdrop versus dialog, and
the surface copy.

##### Two things the first run caught, both in the tests rather than the component

- **`pointerleave` dispatched directly reaches nothing.** Leave does not bubble, so
  React does not listen for it — it derives `onPointerLeave` from `pointerout` at the
  root by comparing target against `relatedTarget`. The helper is named `leave()` and
  says so, because the failure mode is a test that passes while asserting nothing.
- **`pointLayout` rooms are `<path>`, not `<circle>`.** `roomPath` answers the
  `Shape` union with an arc string. The corrected assertion is better than the one it
  replaced: it checks the `d` attribute for an arc and for the absence of a straight
  run, which is the §7 promise stated directly.

One test was written seed-dependently and then fixed before it could rot: the fixture
position assertion originally pinned the literal `"throughout"`. It now reads the
stored word off the entity and asserts `positionPhrase(stored)` differs from it, which
is the actual guard — the enum leaking into prose — and holds for every seed.

#### The tables — AUTHORED

**Dungeon Corridors** (author's). Replaces the `DUNGEON_ROOMS` roll for a designated
corridor; `detail` still rolls on the shared Dungeon Room Detail table.

> Antechamber, Atrium, Bridge, Burrow, Chute, Cloister, Concourse, Corridor, Gallery,
> Hallway, Hollow wall, Passageway, Ramp, Sewer, Shaft, Stairwell, Steps, Tunnel,
> Walkway, Waterway

Twenty entries against the house format of thirty-six. Deliberate and final —
`roll` uses `rng.pick`, so any length works. Flagged only so a later reader does not
"fix" it.

**Corridors get no shape mapping. AUTHOR'S CALL.** A draft of this section gave the
table its own width bands, on the grounds that Antechamber, Atrium, Concourse and
Cloister are rooms you pass through rather than passages. That was wrong, and the
reason matters: **fixed shapes break the thing corridors are for.** They are the only
part of the layout allowed to stretch, and with connected rooms now sharing exact
walls they carry *all* of the slack. Pinning their width would make the packer rigid
in precisely the place it needs to give.

So a corridor's `identity` informs the **prose only**. Its drawn shape is whatever
the connection required — 1–3 wide by default, and straight, L, cross or blob as
needed.

The known trade, accepted rather than overlooked: a rolled "Atrium" may be drawn as a
narrow passage, and the writing pass will be describing a shape the plan does not
show. Left to see how it reads against a live model before adding machinery for it.

`Bridge` implies crossing something the flat plane cannot show, and shares the
flavour-only status of stairs and shafts: it matters inside the room it names and
nowhere else.

**Chamber archetype exceptions** (author's, from the list drafted in session). Only
nouns that genuinely imply a geometry are annotated; the remaining ~90 fall through
to a default that still rolls among the size classes.

The groups are below in the prose the session settled them in. **6a.2's table is the
authority on what each group actually constrains** — the six groups are the same six,
restated on the four axes, and that is the version to build from. The difference is
that a group now pins only the axes it means and leaves the rest to roll, which is
where the variety comes from.

| form | entries |
|---|---|
| long and narrow | Banquet hall, Ballroom, Gallery, Barracks, Dormitory, Stables, Kennel, Catacombs, Sewers |
| round | Well, Fountain, Pool, Fighting pit, Oubliette, Observatory |
| irregular | Cavern, Chasm, Mine shaft |
| axial with an end feature | Chapel, Shrine, Temple, Throne room, Courthouse, Opera house |
| large and open | Courtyard, Garden, Marketplace, Park, Theater, Warehouse |
| tiny | Privy, Cabinet, Cloakroom, Wardrobe, Pantry, Larder |

Two of these names do not survive the move and it is worth saying which: `irregular`
is now **relief 2 over a rolled family**, and `axial with an end feature` — 6a's
invented `composite` — is a **T**. Neither was a shape; both were a shape and a
modifier tangled together.

**Every entry above is verified to exist** in `DUNGEON_ROOMS`, `BUILDING_ROOMS`,
`LOWER_CLASS_BUILDINGS` or `UPPER_CLASS_BUILDINGS`. Three from the first draft were
cut because they do not: `Silo` is on no table at all, `Tidal cave` is a Dungeon
Entrance, and `Sinkhole` is a Dungeon Hazard. An annotation keyed on a noun that
never rolls is dead weight that looks live, so **6a must assert that every key in
both exception lists is reachable from the tables** — otherwise the next entry added
from memory rots the same way silently.

`irregular` stays at three entries. `Attic`, `Garret`, `Root cellar` and `Junk room`
were considered and rejected — none of them is irregular in shape, only in contents.

---

### Phase 7 — Dev affordances

- Seed in the URL (`?seed=1005&size=3`), read by `runtime/seeds.ts`.
- Quick-start PC (Phase 5's library, plus one hardcoded fallback character).
- Jump-to-room — a debug diff that sets `currentRoomId` and fires the room-entry pass.
- Call log viewer, reading the `callLog` written since Phase 2.
- **Replay** — per G5, replays the *run*: load the persisted `GeneratedDungeon`, reset
  `runSeed`/`rngDraws`, feed `playerInputs` back through `turn.ts`. Deterministic
  because the dice come from the seeded run RNG and the dungeon is fixed. Model
  responses are not deterministic, so replay is only exact against the stub or a
  recorded-response cassette — record responses in the call log and add a cassette
  mode. Say this out loud in the code, because "replay" implying determinism through
  a live model would be a misleading affordance.

---

### Phase 8 — Playtest refinements 📋 **PLANNED, NOT STARTED**

The first complete playthrough happened on **2026-08-10**, seed 15341, size 1, level 1
— The Drowned Aviary. Start to finish, goal met. The log is
`out/runs/2026-08-10T00-32-05-seed15341/` (`journal.jsonl` plus a rendered
`transcript.md`), and it is the evidence base for everything below. Where a claim here
cites a `seq`, that is a line in that journal.

This phase is **the author's playtest feedback, sorted by what actually causes each
symptom** — which is not how it was reported, because several unrelated-looking
complaints turned out to be one defect. Nothing here is speculative UX polish; every
item traces to something observed in a real run.

Five sessions. **8a is first and is not negotiable in ordering**, because one defect in
it produced three separate items on the feedback list and will produce them again in
every playtest until it is fixed.

#### What the run proved, before any of it is fixed

The good news first, since a plan that only lists faults misreads the run: a level 1
character walked into a generated dungeon, explored eleven rooms, searched features,
negotiated with the referee, cast a spell, stole the objective and got out. The turn
machine, the applier, the dice, the map, travel, fog of war and the goal terminal all
held for a full run. **Four commits out of the whole session were refused**, and three
of the four were one bug wearing two hats.

---

#### 8a — The referee cannot finish a turn twice. **DO THIS FIRST.**

##### A1. A refused commit throws away the roll. **ROOT CAUSE FOUND.**

This is the "it made me roll repeatedly for the same thing" bug, and it is a
five-line defect in prompt assembly rather than anything the model did wrong.

The chain, from the lockbox theft at the end of the run:

1. The player casts Telekinesis on Demona's lockbox. A DEX save is offered. They roll
   **17 + 3 = 20 against DC 16 — success.**
2. The referee resolves it correctly and commits. One diff reads
   `{ entityId: "player", path: "inventory[8]", value: { …the lockbox… } }`.
3. `apply.ts:345` accepts `inventory[i]` **only** with `value: null` — see A2. The
   commit is refused whole. **Nothing is applied.**
4. `turn.ts:230` re-asks the referee with `rejections`. That is a **brand-new
   conversation**, rebuilt from scratch by `assemble()` per §4.4.
5. **`assemble.ts:183`** — the rejection branch `return`s early. It never reaches
   `if (req.roll)` at `:210`, so **`renderRoll(req.roll)` is never rendered.**

Step 5 is the whole bug. The roll result reaches the model through *exactly one
channel*: that `renderRoll` line. Rolls are pushed to `run.log` (`turn.ts:401`) and the
journal, and **never to `run.transcript`** — `pushTranscript` is called only for player
input (`:380`) and referee narration (`:271`). So the retry prompt contained no roll, no
"resolve the action at step 5", and no trace that a roll had ever been offered.

A model handed that, at step 5, with a rejection notice and an action it had not
resolved, does the only coherent thing available: it restarts the heuristic at step 1
and offers the roll again. Which it did. The player rolled a second time, got a 9, and
lost the lockbox they had already won.

**The same defect explains two more items on the feedback list:**

- **The duplicated establishing paragraph** — "You step into the chamber, the stench
  hitting you like a wall…" appears twice (`transcript.md:2945` and `:3012`). Both are
  the retry re-narrating an action it thought it had not yet narrated.
- **The referee "getting completely messed up"** on the theft generally. It was not
  confused. It was told nothing.

**The fix.** The rejection block must be **prepended to** the original task, never
substituted for it. A retry is the same turn asked again, so it needs everything the
first ask had — the roll, the room-entry `owed` list at `:195`, the "player has acted"
framing at `:214` — plus the reasons. One restructure of `task()` from an if/else
chain into a preamble and a body.

Two guards to add with it, so this class cannot recur silently:

- **A snapshot test that a retry prompt is a superset of the original.** Assemble a
  step-5 prompt with a roll, assemble the same one with `rejections`, and assert the
  roll text appears in both. The current tests never build a rejection prompt with a
  roll present, which is why this shipped.
- **Put the roll in the transcript as well.** Defence in depth: the retry should not
  be the only thing standing between the model and the number the player rolled.
  Cheap, and it makes the exchange readable on its own terms.

##### A2. `inventory[i]` is how the model says "they now have this", and the applier refuses it

`apply.ts:345-357` treats `inventory[#]` as drop-only: a non-null value fails with
`nothing carried at index N`. `SKILL.md:270` documents it the same way — *"null to
drop it where they stand"*.

But the model reached for it to express a **pickup of a newly created item** twice in
one run, in two unrelated situations:

| seq | What it wrote | Refusal |
|---|---|---|
| 193 | `inventory[7]` = a cloth bundle, `inventory[8]` = an iron key, both found by searching the Stables troughs and ledges | `nothing carried at index 7` / `at index 8` |
| — | `inventory[8]` = the lockbox, lifted by Telekinesis | `nothing carried at index 8` |

Both times the character had exactly seven items and was writing to the next free
slots. This is not the model being sloppy; it is the model stating a destination value
— which is precisely what `SKILL.md:206` tells it to do — through the path that most
obviously names where the thing ended up.

There is a documented way to do this: `children[]` on the player to mint it, or
`parentId` → player to move an existing item. But the writable-path table lists
`inventory[i]` immediately above `parentId`, describes it in terms of the player's
hands, and then only permits the destructive half of it. **The vocabulary invites the
mistake.**

**The fix, both halves:**

- **Applier.** Accept `inventory[i]` with a value: an **id string** resolves as a
  pickup (`addItem` with the slot check), and an **entity object** mints it into the
  inventory, exactly as `children[]` on the player already does. The index is
  advisory — the inventory is a compacted list, so the item goes where it goes and the
  stated index is not honoured as a position. Refuse only what genuinely cannot happen:
  over-capacity, or an id that is not an item.
- **Refusal messages must name the way through.** `nothing carried at index 8` is
  true and useless. Every refusal in `paths.ts` and `apply.ts` should end with the
  correct form — *"to put something in the player's hands, write the item's `parentId`
  to `player`, or append to `children[]`"*. The retry is only productive if the
  reasons are (§S2 rule 7), and this run is the proof that they were not.

##### A3. The referee attaches invented things to ids off the character sheet

**This is the lantern.** The report was "my lantern seemingly left my inventory and
ended up as an item in the stables." It never left. At **seq 454** the referee wrote
`state`, `composed` and `isHidden: false` onto **`test-lantern`** — the lantern the
player was carrying — with prose reading *"sits half-buried in old straw near one of
the stone stalls."*

The player had searched the Stables. The referee decided a lantern was a good thing to
find there, needed an entity for it, and reached for the nearest plausible id. The
commit was **valid** — every path is writable on an item — so the applier had no
grounds to refuse it, and the player's own lantern acquired a description of lying on
a floor across the dungeon.

`SKILL.md:246` ("Making something new") is correct and was not followed. Rule 3 at
`:214` — *"Ids are quoted, never invented"* — is the rule the model was obeying, and it
pulled in exactly the wrong direction: told never to invent an id, it reused one.

**The fix is a rule and a guard:**

- **Prompt.** Rule 3 gains its missing half: *an id on the character sheet or in the
  room block names that exact object and nothing else. A thing the player has just
  discovered is a new entity — `children[]` on whatever holds it — even when something
  of the same kind already exists elsewhere.*
- **Applier.** Refuse a write to `roomId` / `parentId` / `isHidden` on an item that is
  **in the player's inventory** when the write would place it in the room the player
  is standing in without a corresponding removal. Narrower than it sounds, and it
  catches the exact shape of this failure. Worth checking whether a cheaper guard
  exists — *composing* a carried item as scenery is the tell, and that is prose, so
  possibly not.

##### A4. Re-entering an unchanged room still costs a model call

BUILD-PLAN §S1 is explicit: *"Empty → no model call. Render `room.composed` verbatim
and go to `awaiting_action`. Free, instant, and consistent by construction."*

`turn.ts:363-371` does not implement it. `enterRoom()` calls `setStage` and then
`ask()` unconditionally. The staleness sweep runs, but it runs **inside**
`assemble.ts:196` as `needsComposition(req.run)`, by which point the prompt has been
built and the call is going out. On an empty sweep the instruction reads *"Nothing here
needs new prose. Commit no diffs and hand the turn straight back"* — a full-price round
trip to be told nothing happened.

**In this run, 11 room entries produced 5 of those.** Nearly half the arrivals were
paid for and discarded.

**The fix** is where the plan always said it was: hoist the sweep into `enterRoom()`,
ahead of the call. Empty sweep → push `room.composed` to the log, `showRoom`,
`awaiting_action` / `1-target`, return. No referee, no tokens, and re-entry becomes
instant.

This is also the author's *"refactor how we do room descriptions so that going back to
an already explored room can just show the room description"* item. It needs no
refactor. It needs the code the plan already specifies.

##### A5. A multi-cell fixture draws as several separate things

Reported as *"fixture dots getting duplicated (2 Rotted sleeping berths)"*.

Not a duplicate. There is exactly one berths entity in the dungeon
(`53ef546c…`), and its `place.cells` holds **two** cells — `(3,7)` and `(2,8)`.
`layout.ts:483` emits `at: p.place.cells.map(middle)`, one mark per cell, by design:
the comment at `:475` explains that a mark is a third of a cell *"so a colonnade reads
as a row of columns rather than as a filled stripe."*

For a colonnade that is right. For `bunks` it is wrong, and the two cells are
**diagonal** — not a row along the north wall, which is what the prose says and what
the fixture is.

**Two things to settle:**

- **Which fixture kinds are a row of marks and which are one thing.** A colonnade,
  rubble and a pool spread; bunks, an altar and a brazier are single objects that
  happen to occupy area. The kind already exists on `LayoutFixture`; it just is not
  consulted.
- **Multi-cell placement should be contiguous along its wall.** Diagonal cells for a
  wall-hugging fixture is a placement fault in `dungeon-fixtures.ts`, independent of
  how it is drawn.

##### A6. The related placement complaint: debris in a corner

*"Collapsed debris described as covering the floor had its marker in a corner against a
far wall when it probably should have been close to the center."* Same subsystem.
`placeFixture` (`dungeon-fixtures.ts:308`) falls back *"through the room as a whole
rather than dropping the fixture"*, and `positionPhrase` then narrates wherever it
landed. A fixture whose nature is *throughout* should not be assigned a wall at all.
Check that the `throughout` position survives placement rather than being overwritten
by the wall fallback.

##### A7. The layout shifts when the room changes

Reported and not yet reproduced: *"Something changes causing a shift in the DOM layout
when a room change occurs. I can't see what it is."* First job of the session is to
reproduce it, most likely by stepping between two rooms whose cards differ in height.
Prime suspects, in order: the room card growing or losing a section (occupants, ways
out) between rooms; the map re-centring; a scrollbar appearing. Fix by reserving the
space rather than by chasing the specific element.

---

#### 8b — The interface

All of this is the author's list, and it holds together as one session because most of
it is the same idea: **the things named in the prose should be inspectable, and the map
and the text should agree about where they are.**

- **Tooltips out of their parent, on `react-tooltip`.** The current ones are clipped
  by their container. This is the reason the package is being added, so the acceptance
  test is a tooltip on an entity near the panel edge rendering unclipped.
- **A click-dropdown of quick actions** on an entity — inspect, search, attack, take —
  writing the corresponding sentence into the input rather than bypassing it, so every
  action still goes through the same heuristic and the player can edit it first.
- **The room card entries get the same tooltip and menu.** Currently only the map
  markers do. The room card is the more likely place to reach for.
- **Hover on either highlights the other.** Room-card row ↔ map marker, both
  directions. This is the cheapest thing on the list that most directly attacks the
  "model got minor position details wrong" class of complaint — it lets the player see
  where the game thinks a thing is.
- **A header for the map section.** Proposed, since the question was asked: **the
  dungeon's name** (`dungeon.pass.name` — "The Drowned Aviary") with **rooms explored /
  total** beside it. The name is currently written by the Dungeon Pass and shown to the
  player nowhere, which is a waste of the one piece of prose that names the whole
  place; and explored-count is the only progress signal a dungeon crawl naturally has.
- **A compass rose.** Not decoration — see 8c. The prose is being held to absolute
  directions, and the map should state which way north is rather than assume it.
- **Floating labels on explored rooms.** Room names on the map itself, fog permitting.
- **A sticky room header at arrival** — room name, and enough of the description to
  stay oriented, pinned as the narration scrolls.
- **Roll entries larger and more prominent**, with success and failure carried by
  colour and weight rather than by the word at the end of a mono line. The roll is the
  moment the player was promised they would get to watch (BUILD-PLAN §4.2); it
  currently renders as the least prominent thing in the scrollback.
- **Auto-centre the map on the new room** when the player moves.
- **A turn tracker**, top right of the stage area. `run.turnCount` already exists and
  is already ticked correctly by `turn.ts:311`; nothing renders it.

---

#### 8c — Referee prose discipline

Every item here is a prompt change, and they are grouped because they share a cause:
**the referee is writing from the prose it was handed rather than from the geometry the
floorplan actually has.** Phase 6 gave the room block real geometry — walls,
positions, exits with sides — and the step files have not caught up with it.

**Space and direction**

- **Absolute directions only.** *"To your left"* — the player has
  no facing, the map has no facing, and left is undefined. North/south/east/west, and
  the room block already provides them.
- **Positions must match the plan.** *"The ramp at the north wall's western end"* when
  the connector is at the **eastern** end. The side and the end are both in the room
  block; the step file needs to say that they bind, in the same voice §4.4 uses for
  `composed`.
- **Shape claims must match the shape.** A room drawn as a pyramid or half-round
  described as *"running east to west"*. `describeGeometry` exists and is rendered;
  the instruction to prefer it over invention does not.
- **Elevation should not contradict itself.** *"The ramp slopes gently upward into
  deeper darkness."* Up is not deeper. Worth one line, since the flat-plane rule means
  ramps and stairs are flavour and the model has nothing constraining how it uses them.

**Exits**

- **Do not count the way the player came in.** *"Three ways lead out"* when there are
  two plus the entrance. Either omit it or mention it last, separately, and outside the
  count. The room block knows which connector was used — the turn record names it.

**Reuse and register**

- **Room descriptions are being reproduced verbatim.** The `composed` field binds the
  referee (`SKILL.md:236`) and it is being satisfied by quotation. Two candidate fixes,
  and they should be tried in this order: (1) instruct explicitly that `composed` is
  what the player has *already read* and must be built on rather than repeated; (2) if
  that does not hold, render the room block's prose fields in a deliberately
  **non-prose form** — fragments, keyword lists — so there is nothing grammatical to
  copy. The second is heavier but is the one that cannot be ignored.
- **The verbal tics.** *"Running my fingers over"* everything inspected, *"moving
  along"* everything traversed. A short list of banned constructions in the information
  handler is the cheap fix; the better one is to say what an inspection paragraph is
  *for* so it stops reaching for a stock gesture to open with.
- **The roll announcement does not belong in the narration.** *"You need to cast this
  without being noticed. Make a Dexterity save—DC 16. Roll 1d20+3."* The interface
  renders the roll offer from `rollRequest`; the prose should end at the moment of
  attempt. Anything the offer is missing should be added to `RollSpec`, not smuggled
  into the post. **This also fixes a rules leak**: `SKILL.md:196` forbids stating the
  DC to the player, and that paragraph states it.
- **Room names and their descriptions must agree.** A room called "The Laboratory"
  whose description was not of a laboratory. Needs diagnosis before a fix — the name
  comes from the rolled `identity` and the description from the content pass, so
  either the content-pass prompt is not treating the name as binding, or the naming
  instruction is loose enough that the name was the odd one out. Read the seed 15341
  content-pass prompt and response for that room before changing anything.

---

#### 8d — Rules gaps

- **Spellcasting has no guidance at all.** Author's design, to be written into
  `3-standard.md`: a spell is **auto-success** unless it targets another creature or
  attempts something difficult or flashy, in which case it rolls as normal. It is
  **exhausted after use** — with an explicit allowance for follow-up actions that are
  part of the same effect, so lifting a thing and then setting it down is not two
  castings. The lockbox theft is the worked example, and under this rule it would have
  been a clean success with no roll at all.
- **Hordes are too strong and half-HD creatures are not fodder.** Twelve creatures
  plus a leader against a level 1 character. Two separate questions: whether
  `dungeon-rooms-loop.ts` should be producing groups that large at level 1, and whether
  a ½ HD creature resolves as a mook — dying to any hit, attacking as a group rather
  than individually. The second is a rules addition to `dungeon-rolls`; the first is a
  stocking parameter. **Measure before tuning**: run the existing generator across a
  seed spread and get the actual distribution of group size against level.
- **The magnetic field did nothing.** The player walked through it wearing chain,
  carrying a sword and a helmet, and nothing happened. An effect with no mechanical
  consequence written for it is an effect the referee has no way to apply. Either
  effects need a consequence field the content pass fills in, or the resolution step
  needs to be told that walking into an effect is an event. Decide which in session.

---

#### 8e — Time, attention, and the world acting on its own

The largest item and the one that is genuinely new machinery, so it is last.

The author's observation is that these are one problem: *"we need a contingency for
loud sounds or other effects that would attract attention from elsewhere in the
dungeon. This probably also implicates a system for the passing of time and actions of
other creatures we don't have yet."* That is right, and the pursuit complaint —
*"enemies didn't actively pursue into adjoining rooms"* — is the same gap seen from the
other side.

What exists to build on: `turnCount` has been in `GameState` since Phase 2 precisely
for this (BUILD-PLAN Phase 2 says so in as many words); `stockDungeon` already
generates wandering groups; `roomIndex` makes "who is where" a cheap question; and
`travel.ts` already knows which rooms adjoin which.

What does not exist: anything that runs between turns. Design questions for the
session, none of them settled:

- Does the world act on a **clock** (every N turns) or on **events** (a loud noise, a
  fight, a scream)? Probably both, with the clock as the floor.
- Is off-screen action **simulated in code** or **narrated by a model call**? Code is
  cheaper and deterministic and fits the "the model never generates a number" rule;
  prose is richer. A hybrid — code decides who moves where, the referee is told about
  it on the next entry — is the obvious first cut.
- How does the player learn about it? Almost certainly through the room-entry pass and
  through `state` on the creatures that moved, which is what the three prose lifetimes
  are for.

**Multi-room travel is not part of this and is not missing.** The report says the
travel function *"was lost"*; it was not. `runtime/travel.ts` implements routing across
known rooms, stops the walk at a creature, a hazard, a spreading effect or a barred
way, and reports where the player actually ended up — and `turn.ts:296` reads the
`movement-stopped` event and writes it into the turn record. `SKILL.md:285` documents
it to the referee. So this is a **wiring or prompt-adherence** question: find out
whether the referee is failing to write a far `roomId`, or the UI is gating it to
adjacent rooms only, before assuming anything needs building. Check `TravelConfirm.tsx`
first.

---

#### Deferred out of Phase 8

**Letting the player tell the referee it got something wrong.** The author raised it
and was unsure of the shape (*"I don't know"*). **Deferred deliberately**, on the
grounds that 8a removes the failure that prompted it — the referee in this run was not
being stubborn, it was being handed a prompt with the roll missing — and a correction
affordance designed against the wrong failure would be designed wrong. Revisit after a
second playtest, with whatever still goes wrong then as the specification.

Three shapes were considered and are recorded so the next reader does not re-derive
them: a *"that's wrong"* button opening a correction turn that may rewrite `state` and
`composed`; a persistent out-of-character input channel addressed to the referee as a
referee; and nothing at all, on the theory that a referee which cannot be argued with
is part of the genre. No decision.

---

## Part 3 — Dependency order

```
Phase 0 ──┬─> Phase 1 ──> Phase 2 ──┬─> Phase 3 ──> Phase 4 ──> Phase 6 ──> Phase 7
          │                          │      ^                       │
          └─> Phase 2.5 ─────────────┘      │                       └─> Phase 8
                                       [B1 required]
Phase 5 needs Phase 2 (rolls); otherwise independent — can slot anywhere after 2.
Phase 8 is playtest-driven and needs a completed run behind it; the first one is
seed 15341, 2026-08-10. 8a before the rest — see the phase. 8b–8e are independent
of each other and can run in any order, or in parallel sessions.
```

Critical path is 0 → 1 → 2 → 3 → 4. Phase 2.5 and Phase 5 are the parallelisable ones.

---

## Part 4 — Open questions for the author

**Settled:** armor typing (D1 — `armorType: 'body' | 'helmet' | 'shield'`; the equip
machinery already existed and was correct); inhabitant group bases written by the
Dungeon Pass, wanderers by the content pass, both **stored on
`TemplateRegistry.groups`** (G1); occupancy derived at runtime (G2); all rolls
resolved attacker-side under the hood, collapsing the crit table to two branches and
making `roll_offered` only ever the player's own action (D6); `name` not
runtime-writable; size → chunks is identity (G4); entity ids deliberately unseeded,
so determinism hashes an id-stripped form and replay runs against the persisted
dungeon (G5); the rulebook (B2) and the skill (B1) both landed.

Also settled: the 1→3 triage is **one call**, with the inter-step records as internal
scaffolding rather than a wire format (§0.4); **0 HP is death** (S5); **`>= 16`**, with
`dcFromDefense` holding the only `+1` (S4); the inhabitants are rendered into
`dungeonContext` and wanderers are structurally kept out of it (G1).

Also settled: the envelope contract is **written** into `SKILL.md`, using one uniform
`{ entityId, path, value }` diff whose meaning the applier infers from path and value
(S2); `steps/room-entry.md` is **written**, and whether it runs at all is decided by a
deterministic staleness sweep (S1); `needUpdate` is **added to the entity model** and
`setState` sets it instead of clearing `composed` (S3).

And the superseded Rooms Pass is **deleted** (B3) — `dungeon-content-pass.ts` is now
the single per-chunk generator for rooms and their entities, running after the Dungeon
Pass has established the top-level fiction, batched by chunk.

**Nothing is open through Phase 7.**

**Open in Phase 8**, all of it recorded in the phase itself and none of it blocking
8a, which is fully specified:

- Whether a multi-cell fixture spreads or is one object, per fixture kind (8a A5).
- Which of the two fixes for verbatim room-description reuse is needed — the
  instruction, or rendering the room block's prose non-grammatically (8c).
- Why "The Laboratory" and its description disagreed: a loose naming instruction, or
  the content pass not treating the rolled name as binding. **Diagnose before
  changing** (8c).
- Whether group size at level 1 is a stocking fault or a rules one, and what a ½ HD
  mook does mechanically. **Measure the existing distribution first** (8d).
- How an effect with no written consequence — the magnetic field — reaches the
  resolution step at all (8d).
- Everything about time and off-screen action: clock or events, code or model call,
  and how the player finds out (8e).
- Whether the player gets a way to tell the referee it was wrong, and what shape it
  takes. **Deferred past Phase 8 on purpose** — see the phase.
