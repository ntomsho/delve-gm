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

**Chambers get an area band and a form.** `class >= degree - 1`. No goal-room bump.

| class | # | area | square example | long example |
|---|---|---|---|---|
| tiny | 1 | 4–9 | 3×3 | 2×4 |
| small | 2 | 12–36 | 6×6 | 3×10 |
| medium | 3 | 42–81 | 8×8 | 5×14 |
| large | 4 | 90–144 | 11×12 | 9×15 |
| vast | 5 | 156–225 | 14×15 | 7×30 |

Area bands, not dimension pairs, so a `long` form has somewhere to go — the bands
fall straight out of 2×2…3×3, 3×4…6×6 and so on, and do not overlap. Aspect is
governed by the form and there is no global dimension cap: `rect` 1:1–1.5:1, `long`
2:1–4:1, `round` square, `irregular` roughly square with jogs, `composite` by
construction.

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

#### 6b — The map on screen

`floorplanLayout(fp): Layout` alongside `pointLayout`, emitting the `polygon` and
`polyline` cases. `Layout` gains doors, fixture slots and labels. `DungeonMap.tsx` is
rewritten against the same interface, which is what the §7 boundary was for.

Fog with real geometry: undrawn space is simply undrawn, which under this rendering
*is* the classic look — a player map drawn as you explore — rather than a compromise.
A small blank area beyond the entrance's surface exit stands for the outside; the
entrance does **not** need to be on the outer face of the whole drawing, and other
parts of the dungeon may sit behind it.

**Fog gains a second bit.** A corridor walked through but never stood in is *seen,
not examined*: it should be drawn without having cost a composition call.
`composed === undefined` continues to mean never encountered.

Interactivity: hover on rooms, doors, features and items; **click a door to travel**,
dispatched through the normal turn path so it is identical to typing it — a door is a
better click target than a room because it stays unambiguous when the far side is
dark, and a locked door stays clickable so the referee gets to be the one that says
no. Player marker at room centre with no finer position, which is exactly what the
model knows. Pan/zoom, since this is a drawing rather than thirty dots.

The map may know more than the fiction but never differently. Nothing is drawn that
the referee has not been told about.

**Exit:** a run is playable against the real map.

#### 6c — Fixtures and the feedback loop

The content pass gains a **fixture menu** — a fixed enum of drawable things (cells,
bunks, stalls, pews, pillars, pool, hearth, pit, altar, shelves, sarcophagi, well,
stair, rubble) plus a coarse position vocabulary ("along the north wall", "centre",
"far end") — and in return receives each room's dimensions, form and exits by wall
direction.

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

| form | entries |
|---|---|
| long and narrow | Banquet hall, Ballroom, Gallery, Barracks, Dormitory, Stables, Kennel, Catacombs, Sewers |
| round | Well, Fountain, Pool, Fighting pit, Oubliette, Observatory |
| irregular | Cavern, Chasm, Mine shaft |
| axial with an end feature | Chapel, Shrine, Temple, Throne room, Courthouse, Opera house |
| large and open | Courtyard, Garden, Marketplace, Park, Theater, Warehouse |
| tiny | Privy, Cabinet, Cloakroom, Wardrobe, Pantry, Larder |

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

## Part 3 — Dependency order

```
Phase 0 ──┬─> Phase 1 ──> Phase 2 ──┬─> Phase 3 ──> Phase 4 ──> Phase 6 ──> Phase 7
          │                          │      ^
          └─> Phase 2.5 ─────────────┘      │
                                       [B1 required]
Phase 5 needs Phase 2 (rolls); otherwise independent — can slot anywhere after 2.
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

**Nothing is open. Phase 0 can start.**
