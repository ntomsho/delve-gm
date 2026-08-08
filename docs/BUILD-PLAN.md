# Dungeon Crawler — Prototype Build Plan

A single-player, LLM-refereed dungeon crawl built on Knave 1.0 and Maze Rats tables. The generation engine is already written as framework-free TypeScript. This plan wires it into a playable local web app.

**Scope:** local dev server only. No backend, no auth, no deployment. One player, one character, one dungeon, start to finish.

---

## 1. What already exists

Seven engine modules, all pure TypeScript with no framework dependencies. They must stay that way — nothing in here may import React.

| Module | Role |
|---|---|
| `dungeon-phase-a.ts` | Graph topology. Rooms, connectors, chunks, force-relaxed positions. Emits `Dungeon` + `DungeonBlueprint`. |
| `dungeon-blueprint.ts` | The dungeon "genome": purpose, ruination, inhabitant groups, goal seed. Also the seeded `Rng` class and the Maze Rats / Cairn tables. |
| `dungeon-rooms-loop.ts` | Stocking. Headline quotas, danger scoring, reward budget, creature placement. Emits `StockedDungeon`. |
| `dungeon-entities-pass.ts` | Deterministic entity emission. One entity per separable thing, references resolved, all prose fields empty. |
| `dungeon-content-pass.ts` | Builds the per-chunk LLM prompt, and applies the response back onto entities. |
| `dungeon-entities.ts` | The entity model. `base` / `state` / `composed` lifetimes, creature stats, derived-stat helpers. |
| `dungeon-character.ts` | `PlayerCharacter`, inventory slots, equipment validation, derived combat numbers. |

**Read `dungeon-entities.ts` first.** The three prose lifetimes are the load-bearing idea in the whole system:

- `base` — immutable identity, written once at generation. **Never writable at runtime.**
- `state` — what's true right now. `undefined` means *the player has not encountered this yet*.
- `composed` — rendered from base + state, and the only one the player has read. Derived, but not ignorable: when it and `state` disagree about something the player is acting on, `composed` wins and `state` is what gets corrected. Going back on what the player was told is the one failure a run does not recover from.

There is a `dungeon-loop` skill (SKILL.md plus one file per step under `steps/`) that is the runtime referee playbook — prose the model performs, not code. It should live in the repo as `src/prompts/dungeon-loop/` and be imported as raw text.

### Known gaps

1. **The Dungeon Pass does not exist.** `rollSheet(bp)` produces the text intended for it; nothing consumes that text. It should be one LLM call producing the `dungeonContext` string (theme → history → goal spec → starting prose) that both the content pass and the runtime consume. Build it as `src/engine/dungeon-pass.ts`, mirroring the shape of `dungeon-content-pass.ts`: a `build*Payload` / `render*Prompt` / response schema / `apply*` quartet.
2. **`dungeon-rolls` does not exist.** Needs `saveRoll`, `attackRoll`, `moraleRoll`, damage-die evaluation, and advantage/disadvantage, per Knave. All rolls draw from a seeded run RNG that is separate from the generation seed.
3. **Starting equipment tables** for character creation are not transcribed. They're in `Knave_1_0.pdf` in the project.
4. **`dungeon-rooms-loop.ts` still contains `buildRoomsPassPayload` / `ROOMS_PASS_INSTRUCTIONS`**, which appear superseded by `dungeon-content-pass.ts`. Confirm with the author before removing — don't assume.

---

## 2. Stack

- **Vite + React + TypeScript.** No Next, no SSR.
- **Tailwind** for styling. No component library for now.
- **Zustand** for state, with `persist` middleware → IndexedDB.
- **Zod** for validating every model response and every state diff.
- **SVG** for the map, React-rendered. No canvas library.
- **Vitest** for engine tests.
- **Anthropic API via a Vite dev-server proxy.** Key lives in `.env.local`, injected by the proxy, never reaches the browser. Client calls `/api/anthropic/...`. This keeps the client call shape identical to what a real backend would serve later.

---

## 3. Repo layout

```
src/
  engine/          # existing modules, unchanged. Never imports React.
    dungeon-phase-a.ts
    dungeon-blueprint.ts
    dungeon-rooms-loop.ts
    dungeon-entities-pass.ts
    dungeon-entities.ts
    dungeon-content-pass.ts
    dungeon-character.ts
    dungeon-pass.ts          # NEW
    dungeon-seams-pass.ts    # NEW
    dungeon-rolls.ts         # NEW
    character-creation.ts    # NEW
  runtime/
    llm/
      client.ts              # fetch wrapper, streaming, retry
      models.ts              # task → model registry
      schemas.ts             # zod for every model response
    prompts/
      dungeon-loop/          # the skill, as raw markdown
      assemble.ts            # builds messages array per stage
      render.ts              # PC block, room block, turn records
    diffs/
      types.ts
      apply.ts               # the diff applier
      paths.ts               # writable-path whitelist
    generate.ts              # full generation pipeline, orchestrated
    turn.ts                  # the turn state machine
  store/
    game.ts                  # zustand store
    characters.ts            # saved characters. async; an array now, a db later
    persist.ts
  ui/                        # React. See the design brief.
  dev/
    cli-generate.ts          # headless generation, dumps JSON
    replay.ts
```

---

## 4. Core contracts

Settle these before writing UI. Everything else hangs off them.

### 4.1 The stage machine

One shared enum drives the turn. The model returns the next stage, the store holds it, the UI renders from it.

```ts
type Stage =
  | "room_entry"      // composing / narrating a newly entered room
  | "awaiting_action" // "What do you do?"
  | "clarifying"      // model needs the player to disambiguate a target
  | "rejected"        // action turned away; no state changed
  | "roll_offered"    // roll spec on the table; Roll button live
  | "rolling"         // dice in flight
  | "resolving"       // model writing the outcome
  | "dead"
  | "goal_met";
```

This maps onto the `dungeon-loop` steps. Use it as a cheap correctness check: a response carrying a `rollRequest` while claiming `nextStage: "awaiting_action"` is a schema violation, caught in zod, not a confused UI.

**Rejections never mutate.** `clarifying` and `rejected` must produce zero diffs. Enforce it in the applier, not by trusting the model.

### 4.2 The response envelope

Narration is ordinary assistant text. Structured output arrives as a terminal tool call, `commit_state`, and the text is not shown until that call has validated and applied — see Phase 4:

```ts
interface Commit {
  nextStage: Stage;
  rollRequest?: RollSpec;   // only when nextStage === "roll_offered"
  diffs: Diff[];
}
```

Rolls are made in two places, and the split is deliberate.

**The player's roll is client-side.** The referee offers it as a `rollRequest` and the interface throws it, from the run RNG, the moment the player takes it — that is what the `rolling` stage is. The result goes into the next call as the step-5 input. A roll the player takes is a thing they should watch happen, not a number that arrives inside a paragraph.

**Everything else is the model's, through a batched dice tool.** Creature attacks, morale, a trap going off — rolls the referee cannot anticipate before it knows what the player's roll did. `roll` takes a **list** of requests, each with a caller-chosen `id`, and returns every result in one go:

```ts
roll({ rolls: [
  { id: "ghoul-1", kind: "attack", bonus: 2, targetDefense: 12, damage: "1d6" },
  { id: "nerve",   kind: "morale", rating: 7 },
] })
```

Batching is what keeps this affordable: a resolution with three creatures in it costs **one** extra exchange rather than three, and the prompt tells the referee to roll wide and discard rather than go back for more. The kinds map one-to-one onto `dungeon-rolls` — `save`, `attack`, `stunt`, `morale`, `damage` — so every Knave rule (advantage keep-best, the natural 20's extra die and armour loss, well-suited bonuses, damage summation) stays in tested code rather than moving into the prompt.

Together these are the *only* sources of randomness; the model never states a number it did not receive from one of them.

### 4.3 Diffs

```ts
type Diff =
  | { op: "set"; entityId: string; path: string; value: unknown }
  | { op: "addChild"; parentId: string; entity: AnyEntity }
  | { op: "removeChild"; parentId: string; childId: string };
```

The applier is the single robust chokepoint. It must:

- Resolve `entityId` across rooms, connectors, creatures, features, items, hazards, effects, and the PC.
- Validate `path` against a **per-entity-type whitelist**. `base` is never writable. `id` and `type` are never writable. Anything not whitelisted is rejected and logged, not silently applied.
- **Special-case relational keys.** There is no `move` op — writing `roomId` on a creature must also pull it from the old room's occupant list and push it to the new one; writing `parentId` on an item must move it between inventories. Referential integrity lives here and nowhere else.
- Enforce invariants after each apply: slot capacity (`isOverburdened`), equipment legality (`validateEquipment`), HP clamped to `[0, max]`.
- Recompose `composed` for any entity whose `base` or `state` changed.
- Be **atomic per commit** — validate the whole batch, then apply, or reject the batch and surface a retry.

Return a structured result (`applied`, `rejected` with reasons) so rejections can be fed back to the model on retry.

### 4.4 Context policy

Rebuild the messages array fresh each call. Never append-and-grow.

- **System:** `dungeon-loop/SKILL.md` + **only the current stage's step file**. Not the whole playbook. This is the single biggest context saving available.
- **Static prefix (cached):** `dungeonContext` from the Dungeon Pass.
- **Ground truth, re-rendered each turn:** full PC sheet, full current room — the room's `composed` plus every contained entity's current `state`.
- **Transcript:** the full exchange for the *in-progress* action (a single action may take several round trips through clarify / negotiate / roll), plus the resolution record of the **previous 2 completed turns**. Hard cap the in-progress exchange at 12 messages so a player renegotiating forever can't blow the budget.
- Completed turns carry forward as **structured records**, not raw prose: `{ action, target, roll, outcome, diffsApplied }`.

The entity `state` fields are the long-term memory. The transcript only carries conversational continuity.

### 4.5 Model registry

Task-keyed, so any task can be repointed independently:

```ts
type Task = "dungeon-pass" | "content-pass" | "seams-pass" | "room-entry" | "turn-loop";
const MODELS: Record<Task, string> = { /* ... */ };
```

Start with one cheap fast model for everything during testing. Expect the split to grow — do not hardcode a model string anywhere outside this file.

---

## 5. Generation pipeline

Runs once, up front, behind a loading screen.

```
1. generateBlueprint(seed, params, true)      → { dungeon, blueprint }   [pure]
2. generateBlueprintSeed(size, seed, level)   → DungeonBlueprintSeed     [pure]
3. rollSheet(bp) → Dungeon Pass (LLM)         → dungeonContext           [1 call]
4. stockDungeon(dungeon, bp, { level, seed }) → StockedDungeon           [pure]
5. runEntitiesPass(sd, bp, rng)               → EntityPassResult         [pure]
6. per chunk:
     buildContentPassPayload(sd, bp, ep, chunk, dungeonContext)
     → renderContentPassPrompt → LLM → zod validate
     → applyContentPass(...)                                             [N calls]
7. buildSeamsPassPayload(sd, ep, dungeonContext)
     → renderSeamsPassPrompt → LLM → applySeamsPass                      [1 call]
```

Steps 3 and 4–5 are independent; run them concurrently.

**Chunk parallelism, carefully.** Fire all chunk *generations* in parallel, but call `applyContentPass` **serially in ascending chunk order**. `applyContentPass` threads a `groupBases` map through: an inhabitant group can appear in several chunks and its `base` must be written exactly once. Apply is pure and cheap, so serializing it costs nothing.

**A connector is written by whoever can see both its rooms.** Inside a chunk that is free — six rooms are named in one response — and the lower graph index owns it so it is written once rather than by each of its two rooms. A connector *leaving* the chunk cannot be: every chunk payload is built before any of them is applied, so the room on the far side has no name yet. Those are **seams**, they are skipped by the chunks, and step 7 writes them at the end with both rooms in front of it. Without that split both chunks write every connector between them, blind to the far room, and the later apply silently wins — which is what shipped until the seams pass existed. There are about two per chunk boundary, so one call covers a whole dungeon.

On zod failure: retry that chunk once with the validation errors appended to the prompt. On a second failure, surface it — do not fall back to partial content.

**`state` and `composed` are not written during generation.** They stay `undefined` until the player encounters the entity. Room entry at runtime is its own LLM pass that returns narration plus a batch of `set` diffs for `state` / `composed`.

---

## 6. Build order

Each phase should end somewhere demonstrable.

**Phase 0 — Scaffold.** Vite + React + TS + Tailwind. Move engine files into `src/engine/`. Vitest running. Dev proxy hitting the API with a hello-world call. `.env.local.example` committed.

**Phase 1 — Headless generation.** Build the Dungeon Pass. Write `dev/cli-generate.ts` that runs the full pipeline for a seed and dumps the result to JSON. **No UI.** This de-risks the expensive, high-uncertainty part in an environment where iteration is fast. Ship when a seed reliably produces a fully-written dungeon.

**Phase 2 — State and rules.** Zustand store, the serializable `GameState` root, IndexedDB persistence, `dungeon-rolls`, the diff applier with its whitelist and tests. Add a `turnCount` to `GameState` now, even though nothing consumes it yet — retrofitting a clock into a state model with no notion of elapsed time is miserable, and the rooms loop already generates wandering groups that will want one.

**Phase 3 — Turn loop against a stub.** Wire the stage machine with a fake model that returns canned envelopes. Exercise every stage transition, every diff op, every rejection path without spending a token.

**Phase 4 — Real model.** Swap the stub for the client. `commit_state`, dice, retry-on-invalid. Room entry pass. Death and goal-met terminals.

**No streaming.** Narration is held back until the commit validates and applies. The two cannot both be had: text streamed as it is written is text already on the player's screen when the commit that was supposed to justify it fails validation, and there is no honest way to take it back. So a turn shows the `thinking` stage while it works and the prose arrives whole, with the world already changed to match it. That is what `thinking` is for, and why `Narration.tsx` renders an indeterminate marker rather than a fake one.

**Phase 4.5 — The way in.** The two screens in front of a run, because until now
there weren't any: the app generated a dungeon on mount from whatever the URL said
and handed the test character to it. `Characters` lists the saved characters and
offers the two doors — creation, disabled until Phase 5, and a new run.
`RunSetup` takes size, level, and which character, and confirming drops straight
into the loading screen with generation already running.

Characters come from `store/characters.ts`, which is async against an array today
and a database later — that module is the only thing that should have to change.
Creation being disabled means the empty-stock state is currently unreachable; it
is written but it is not designed, and it gets designed with the flow that can
cause it.

The dev switches still bypass all of it. Any of `?seed` `?size` `?level`
`?offline` `?stub` skips the front and generates immediately, because interface
work against a real dungeon is unbearable if every iteration costs two clicks and
a minute. A run started from the front page mints a random seed unless `?seed=`
pinned one; the bypass keeps its fixed default, so `?stub=1` alone still returns
to the same dungeon every time.

**Phase 5 — Character creation.** `character-creation.ts`: ability rolls (Knave 3d6-drop-two-highest → bonus), a point-buy alternative, the eleven traits, HP d8, starting equipment rolls, and a shop against 3d6×20 copper. Save/load characters to local storage — this doubles as the dev quick-start.

**Phase 6 — Map.** SVG, fog of war from `state === undefined`.

**Phase 7 — Dev affordances.** Seed in the URL, quick-start PC, jump-to-room, a call log viewer, and replay from `(dungeonSeed, runSeed, playerInputs)`.

---

## 7. The map boundary

Phase A gives force-relaxed **points** — no room shapes, sizes, or corridor geometry. The long-term intent is a traditional dungeon map with real room outlines.

So: the map component consumes a `layout` object, never `dungeon.rooms[].pos` directly.

```ts
interface Layout {
  rooms: { id: string; shape: Shape; label?: string }[];
  connectors: { id: string; path: Path }[];
  bounds: { w: number; h: number };
}
```

Ship a `pointLayout(dungeon)` that emits circles and straight lines. When a real geometry pass arrives, it implements the same interface and the map component doesn't change.

---

## 8. Testing

- **Engine:** seeded determinism — same seed in, identical dungeon out, asserted on a hash of the emitted structure. `dungeon-phase-a` already has a validator; assert `dungeon.valid` across a spread of seeds and chunk counts.
- **Applier:** the whole point of it is rejecting bad input. Test that `base` writes are refused, that unknown paths are refused, that a `roomId` write maintains occupant lists on both sides, that an over-capacity `addChild` is refused, that a rejected batch applies nothing.
- **Rolls:** distribution sanity plus the Knave edge cases — advantage/disadvantage, natural 20 dealing +1d and costing the defender's armor a point of `currentQuality`.
- **Prompt assembly:** snapshot tests so a prompt change is a visible diff in review.

---

## 9. Non-goals for this prototype

No multiplayer, no party (one PC). No leveling. No between-dungeon persistence beyond saved characters. No light or ration clocks yet, though `turnCount` exists for them. No mobile layout — desktop-first, must not break at tablet width.
