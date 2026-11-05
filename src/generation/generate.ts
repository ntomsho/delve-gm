/**
 * THE GENERATION PIPELINE
 * =======================
 *
 * Runs once, up front. Produces a dungeon that is completely written before the
 * player takes a single turn.
 *
 *   A: generateBlueprintSeed                                    [pure]
 *      -> Dungeon Pass                                          [1 call]   ─┐
 *   B: generateBlueprint -> stockDungeon -> runEntitiesPass     [pure]     ─┘ concurrent
 *   join
 *   buildContentPassPayload -> LLM -> applyContentPass          [1 call, the whole dungeon]
 *   buildKeysPassPayload -> LLM -> applyKeysPass                [1 call]
 *
 * The Dungeon Pass needs only the rolled genome, so it overlaps the pure
 * stocking branch. Everything after the join is one call at a time: the server
 * runs each as its own request (`/steps/:step`, then `/finish`), because no one
 * Vercel invocation may hold more than one model call.
 *
 * `state` and `composed` are NOT written here. Every entity stays unencountered
 * until the player walks in on it; room entry is a runtime pass.
 */

import { applyContentPass } from "./content/passes/content-pass/apply.ts";
import { renderContentPassPrompt } from "./content/passes/content-pass/prompt.ts";
import {
  askForRooms,
  contentPassOmissions,
  mergeRooms,
  type ContentPassResponse,
} from "./content/passes/content-pass/response.ts";
import { buildContentPassPayload } from "./content/passes/content-pass/build.ts";
import {
  applyDungeonPass,
  buildDungeonPassPayload,
  renderDungeonPassPrompt,
  type DungeonPassResponse,
} from "./content/passes/dungeon-pass.ts";
import {
  applyKeysPass,
  buildKeysPassPayload,
  keysPassOmissions,
  unwritableKeys,
  renderKeysPassPrompt,
} from "./content/passes/keys-pass.ts";
import { generateBlueprint, type Dungeon } from "./floorplan/graph.ts";
import {
  generateBlueprintSeed,
  type DungeonBlueprintSeed,
  type Size,
} from "./content/blueprint.ts";
import { Rng } from "../shared/utils/rng.ts";
import { blockPlanValid, roomSizes, type BlockPlan } from "./floorplan/blockplan.ts";
import { resolveBase } from "../shared/world/entities.ts";
import { runEntitiesPass } from "./content/entities-pass.ts";
import type { EntityPassResult } from "../shared/world/entities.ts";
import { siteRooms } from "./floorplan/geometry.ts";
import { stockDungeon } from "./content/stock/stock.ts";
import type { StockedDungeon } from "./content/types.ts";
import { addUsage, callForJson, type FailedAttempt, type Usage } from "../llm/client.ts";
import {
  contentPassSchema,
  dungeonPassToolSchema,
  fromDungeonPassTool,
  keysPassSchema,
} from "./content/passes/schemas.ts";
import { deriveSeeds, shapeFor, type RunSeeds } from "./seeds.ts";
import { NO_LOG, type GenerationLog } from "./log.ts";

// ---------------------------------------------------------------------------
// PROGRESS
// ---------------------------------------------------------------------------

/**
 * The stages the loading screen reports, named here rather than in the UI so
 * there is nothing for the UI to invent. "writing" is the long one and is the
 * one the player waits on; "keys" is the shorter call after it which writes
 * the objects answering the dungeon's questions.
 */
export type GenerationStage =
  | "layout"
  | "inhabitants"
  | "history"
  | "stocking"
  | "writing"
  | "keys";

export interface GenerationProgress {
  stage: GenerationStage;
}

export type ProgressFn = (p: GenerationProgress) => void;

// ---------------------------------------------------------------------------
// OUTPUT
// ---------------------------------------------------------------------------

/**
 * The write-once half of persisted state. Large, and written exactly once, so
 * it is stored under its own key rather than re-serialised on every turn.
 */
export interface GeneratedDungeon {
  id: string;
  seeds: RunSeeds;
  size: Size;
  level: number;
  /** built once by applyDungeonPass; never appended to (see DungeonPassResult) */
  readonly dungeonContext: string;
  pass: DungeonPassResponse;
  blueprint: DungeonBlueprintSeed;
  /** the room graph (`floorplan/graph.ts`), for the map */
  graph: Dungeon;
  stocked: StockedDungeon;
  /** every entity, plus the registry that resolves their shared bases */
  entities: EntityPassResult;
  /**
   * The drawing. Persisted rather than recomputed, because the prose will come
   * to refer to it and a map that drifts between generations of the same seed
   * is worse than prose that drifts.
   *
   * Null when no layout could be drawn for this graph — not seen at 5-12 rooms,
   * where every measured seed drew first time, but possible — so everything
   * downstream treats the plan as an enhancement over the point layout. A
   * dungeon with no plan is playable.
   */
  blockplan: BlockPlan | null;
  usage: Usage;
}

// NO FLOOR AREA FROM CONTENTS. A room's size is capped by the ground its
// neighbours left it,
// so a floor demanded by its contents cannot be honoured — and the entities pass
// runs after the drawing regardless. Stocking decides what fits in the room
// rather than the room being sized to the stocking.

export interface GenerateOptions {
  seed: number;
  size: Size;
  level?: number;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
  /** where the generation writes itself down. Omitted means it does not. */
  journal?: GenerationLog;
}

// ---------------------------------------------------------------------------
// PIPELINE
// ---------------------------------------------------------------------------

/**
 * How many graphs to try before giving up on a seed.
 *
 * Size 5 fails about one graph in eight, so eight tries leaves a failure rate
 * around one seed in ten million. Cheap enough to be generous with: the whole
 * branch is pure and takes milliseconds.
 */
const GRAPH_ATTEMPTS = 8;

/**
 * What a failed generation call writes down.
 *
 * Curried on the pass, because that is exactly what `callForJson` does not
 * know and what a reader of the journal most needs.
 */
function reportFailure(
  journal: GenerationLog,
  pass: "dungeon-pass" | "content-pass" | "keys-pass"
) {
  return (r: FailedAttempt): void => {
    journal.log({
      kind: "generation-error",
      pass,
      attempt: r.attempt,
      willRetry: r.willRetry,
      message: r.message,
      issues: r.issues,
      ...(r.raw !== undefined ? { raw: r.raw } : {}),
    });
    // And to the console, because the person who hits this in a browser has
    // devtools open and no journal file within reach.
    console.warn(
      `[generate] ${pass} ` +
        `attempt ${r.attempt} failed: ${r.message}` +
        (r.willRetry ? " — retrying" : " — giving up"),
      { issues: r.issues, raw: r.raw }
    );
  };
}

/**
 * Options for a pass that already has a partial dungeon in hand — it does not
 * need the seed, the size or the level, because those are on the partial.
 */
export type PassOptions = Pick<GenerateOptions, "signal" | "journal" | "onProgress">;

/** The content-pass response, as it came back and before it is applied. */
export interface ContentResult {
  value: ContentPassResponse;
  usage: Usage;
}

/**
 * The model calls between the structure and `finishGeneration`, in the order
 * they run. Each is its own server request, saved unapplied on arrival.
 */
export const STEPS = ["content"] as const;
export type Step = (typeof STEPS)[number];

/** One step's answer, as the server keeps it between requests. */
export interface StepResult extends ContentResult {
  step: Step;
}

export function isStep(s: string): s is Step {
  return (STEPS as readonly string[]).includes(s);
}

/**
 * The drawing, read back as words.
 *
 * Derived rather than persisted — the plan is the durable thing and this is one
 * function over it, so the vocabulary can change without a migration. Which
 * also means a partial that has been round-tripped through a database recovers
 * it without having had to store it.
 */
function siteOf(partial: GeneratedDungeon) {
  if (!partial.blockplan) return undefined;
  const corridors = new Set(
    partial.stocked.rooms.filter((r) => r.isCorridor).map((r) => r.index)
  );
  return siteRooms(partial.blockplan, partial.graph, { isCorridor: (i) => corridors.has(i) });
}

/**
 * The content pass's payload, built from the partial.
 *
 * Rebuilt rather than persisted, and it must be built from UNAPPLIED entities:
 * a payload says what needs writing, and entities that have been written no
 * longer need writing. So `finishGeneration` builds it before it applies.
 */
function contentPayload(partial: GeneratedDungeon) {
  return buildContentPassPayload(
    partial.stocked,
    partial.blueprint,
    partial.entities,
    partial.dungeonContext,
    siteOf(partial)
  );
}

// ---------------------------------------------------------------------------
// STEP 1: STRUCTURE  (one model call)
// ---------------------------------------------------------------------------

/**
 * Everything knowable before a room is written: the graph, the drawing, the
 * stocking, the entities, and the standing fiction.
 *
 * Comes back as a `GeneratedDungeon` whose entities are UNWRITTEN — no names,
 * no prose. That is a real state now rather than a moment inside a function,
 * because the steps below happen in separate HTTP requests and this is what is
 * persisted between them.
 */
export async function generateStructure(opts: GenerateOptions): Promise<GeneratedDungeon> {
  const { size, signal } = opts;
  const level = opts.level ?? 1;
  const seeds = deriveSeeds(opts.seed);
  const report = opts.onProgress ?? (() => {});
  const journal = opts.journal ?? NO_LOG;

  const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, level);

  // --- branch A: the standing fiction (one call) ---------------------------
  const fiction = (async () => {
    report({ stage: "inhabitants" });
    const payload = buildDungeonPassPayload(blueprint);
    report({ stage: "history" });
    const prompt = renderDungeonPassPrompt(payload);
    const { value: answer, usage } = await callForJson({
      task: "dungeon-pass",
      schema: dungeonPassToolSchema,
      toolName: "establish_dungeon",
      toolDescription: "Record the dungeon's name, theme, history, goal, opening prose, and the standing identity of each inhabitant group.",
      messages: [{ role: "user", content: prompt }],
      signal,
      onAttemptFailed: reportFailure(journal, "dungeon-pass"),
    });
    const value = fromDungeonPassTool(answer);
    // The dungeon is written exactly once and cannot be re-examined by playing
    // differently, so what was asked for is worth keeping.
    journal.log({ kind: "generation", pass: "dungeon-pass", prompt, response: value, usage });
    return { result: applyDungeonPass(value, payload), usage };
  })();

  // --- branch B: structure and entities (pure, instant) --------------------
  const structure = (async () => {
    report({ stage: "layout" });

    // A GRAPH THAT WILL NOT DRAW IS THROWN AWAY WHOLE.
    //
    // `blockPlanValid` already tries a hundred layout seeds, so reaching here
    // with nothing means the graph itself is the problem — untangling did not
    // get the crossings to zero, which is about one size-5 dungeon in eight.
    // The escalation is therefore a different graph, not another layout seed.
    //
    // It costs nothing to do: this whole branch is pure and runs in
    // milliseconds, and the fiction branch reads `blueprint` rather than the
    // graph, so nothing already in flight is invalidated and no tokens are
    // re-spent. The seed still names one dungeon, because the retry is
    // derived rather than random.
    //
    // At 5-12 rooms every measured seed draws first time, so this loop is a
    // guard rather than a cost.
    // Rolled once from the dungeon's own seed, so a redrawn graph keeps the
    // dungeon's room and loop counts.
    const shape = shapeFor(size, seeds.graphSeed);
    for (let attempt = 0; ; attempt++) {
      // `generateValid` appends `#n` internally when a graph fails validation,
      // so a different separator keeps these seeds out of that space.
      const graphSeed = attempt === 0 ? seeds.graphSeed : `${seeds.graphSeed}~${attempt}`;
      const { dungeon } = generateBlueprint(graphSeed, shape, true);
      report({ stage: "stocking" });

      // THE DRAWING RUNS INSIDE STOCKING, between the corridors and the fiction.
      //
      // It needs the graph and which rooms are passages, and nothing else. Putting
      // it first means each room's size is settled before its identity is rolled,
      // so the roll can be conditioned on it — a four-cell closet does not get to
      // be a banquet hall. The alternative, which is what 6a did, is to let the
      // roll demand a size and hope the ground obliges; it usually did not.
      let blockplan: BlockPlan | null = null;
      const stocked = stockDungeon(dungeon, blueprint, {
        level,
        seed: seeds.stockSeed,
        layout: (rooms) => {
          const corridor = new Set<number>(rooms.filter((r) => r.isCorridor).map((r) => r.index));
          blockplan = blockPlanValid(dungeon, (i) => corridor.has(i), seeds.layoutSeed);
          return blockplan ? roomSizes(blockplan.rooms) : rooms.map(() => undefined);
        },
      });

      const plan = blockplan as BlockPlan | null;
      if (plan === null && attempt < GRAPH_ATTEMPTS - 1) continue;
      if (plan === null) {
        throw new Error(
          `no drawable layout for seed ${opts.seed} at size ${size} after ${GRAPH_ATTEMPTS} graphs`
        );
      }

      const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));
      return { dungeon, stocked, entities, plan };
    }
  })();

  const [{ result: fictionResult, usage }, { dungeon, stocked, entities, plan }] =
    await Promise.all([fiction, structure]);

  // The Dungeon Pass wrote the inhabitant bases; they belong on the registry,
  // which is the thing that gets persisted alongside the entities.
  Object.assign(entities.registry.groups, fictionResult.groups);

  return {
    id: blueprint.id,
    seeds,
    size,
    level,
    dungeonContext: fictionResult.dungeonContext,
    pass: fictionResult.pass,
    blueprint,
    graph: dungeon,
    stocked,
    entities,
    blockplan: plan,
    usage,
  };
}

// ---------------------------------------------------------------------------
// STEP 2: THE ROOMS  (one model call, and nothing mutated)
// ---------------------------------------------------------------------------

/**
 * Write every room of the dungeon.
 *
 * PURE WITH RESPECT TO THE PARTIAL. It reads it to build the payload and hands
 * back what came in; it applies nothing. That is what lets the server save the
 * answer from one request and apply it in another.
 */
export async function generateContent(
  partial: GeneratedDungeon,
  opts: PassOptions = {}
): Promise<ContentResult> {
  const journal = opts.journal ?? NO_LOG;
  const payload = contentPayload(partial);
  const prompt = renderContentPassPrompt(payload);

  const { value, usage } = await callForJson({
    task: "content-pass",
    schema: contentPassSchema,
    toolName: "write_rooms",
    toolDescription: "Name and write every room, entity, connector, and creature group in this dungeon.",
    messages: [{ role: "user", content: prompt }],
    ...(opts.signal ? { signal: opts.signal } : {}),
    // An answer that writes five of six connectors is well-formed and wrong.
    // Asked here, the omission is a retryable failure; noticed after the
    // pass, it is an unwritten entity nobody can fix.
    check: (v) => contentPassOmissions(payload, v),
    // And an omission is repaired rather than redone: the rooms that lost
    // something are asked for again, alone, and the rest of the answer kept.
    repair: { ask: (missing) => askForRooms("write_rooms", missing), merge: mergeRooms },
    onAttemptFailed: reportFailure(journal, "content-pass"),
  });

  journal.log({ kind: "generation", pass: "content-pass", prompt, response: value, usage });
  return { value, usage };
}

/** Run one named step: what `POST /api/dungeons/:id/steps/:step` calls. */
export async function generateStep(
  partial: GeneratedDungeon,
  step: Step,
  opts: PassOptions = {}
): Promise<StepResult> {
  switch (step) {
    case "content":
      return { step, ...(await generateContent(partial, opts)) };
  }
}

/**
 * The saved steps, checked and unpacked for `finishGeneration`. Throws when one
 * is missing, which turns a lost step into a retryable request rather than an
 * unwritten entity discovered at the end of a pass nobody can rerun.
 */
export function contentFrom(results: readonly StepResult[]): ContentResult {
  const missing = STEPS.filter((s) => !results.some((r) => r.step === s));
  if (missing.length > 0) {
    throw new Error(`cannot finish generation: step ${missing.join(", ")} was never run`);
  }
  const { value, usage } = results.find((r) => r.step === "content")!;
  return { value, usage };
}

// ---------------------------------------------------------------------------
// STEP 3: APPLY, AND THE KEYS  (one model call)
// ---------------------------------------------------------------------------

/**
 * Apply what the content pass wrote, then write the keys.
 *
 * `entities` is mutated in place, which is why the result spreads `partial`:
 * the object handed in IS the object written to, and a caller that reloaded the
 * partial from a row a moment ago owns it outright.
 */
export async function finishGeneration(
  partial: GeneratedDungeon,
  content: ContentResult,
  opts: PassOptions = {}
): Promise<GeneratedDungeon> {
  const report = opts.onProgress ?? (() => {});
  const journal = opts.journal ?? NO_LOG;
  const { blueprint, stocked, entities } = partial;

  // Built before the apply, from unwritten entities; see `contentPayload`.
  const payload = contentPayload(partial);
  applyContentPass(content.value, payload, entities, blueprint, stocked, new Rng(stocked.seed));
  let usage = addUsage(partial.usage, content.usage);

  // --- the keys: the objects that answer the dungeon's questions ------------
  //
  // Last of all, because it needs more finished than any other pass does: a
  // key is written with its lock in front of it, and the lock is written by
  // the content pass. It also mints the objective's own keyable properties,
  // which do not exist until the content pass has decided what the objective
  // physically is. See the header in keys-pass.ts.
  const keysPayload = buildKeysPassPayload(stocked, entities, partial.dungeonContext);
  const orphaned = unwritableKeys(stocked, entities, keysPayload);
  if (orphaned.length > 0) {
    // Not fatal and not retryable: the gap is in the dungeon, not the response.
    // Journalled so it is visible without a playthrough — a placed key whose
    // target nobody wrote is a bug upstream of here.
    journal.log({
      kind: "error",
      where: "keys-pass",
      message: `keys with no written target: ${orphaned.join("; ")}`,
    });
  }
  if (keysPayload.keys.length > 0 || keysPayload.goal) {
    report({ stage: "keys" });
    const prompt = renderKeysPassPrompt(keysPayload);
    const { value, usage: keysUsage } = await callForJson({
      task: "keys-pass",
      schema: keysPassSchema,
      toolName: "write_keys",
      toolDescription:
        "Write the objects that answer this dungeon's questions, and name what must be learned about its objective.",
      messages: [{ role: "user", content: prompt }],
      ...(opts.signal ? { signal: opts.signal } : {}),
      check: (v) => keysPassOmissions(keysPayload, v),
      onAttemptFailed: reportFailure(journal, "keys-pass"),
    });
    journal.log({ kind: "generation", pass: "keys-pass", prompt, response: value, usage: keysUsage });
    applyKeysPass(value, keysPayload, stocked, entities);
    usage = addUsage(usage, keysUsage);
  }

  return { ...partial, entities, usage };
}

// ---------------------------------------------------------------------------
// THE WHOLE THING, IN ONE PROCESS
// ---------------------------------------------------------------------------

/**
 * The three steps above, composed.
 *
 * This is what the browser and the CLI call and what every generation test
 * exercises. The server calls the three separately, because no one Vercel
 * invocation may hold more than one model call — but it is the same pipeline,
 * and this composition is what keeps that true rather than aspirational.
 */
export async function generateDungeon(opts: GenerateOptions): Promise<GeneratedDungeon> {
  const report = opts.onProgress ?? (() => {});
  const pass: PassOptions = {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.journal ? { journal: opts.journal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  };

  const partial = await generateStructure(opts);

  report({ stage: "writing" });
  const content = await generateContent(partial, pass);

  return finishGeneration(partial, content, pass);
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

export interface WrittenProblem {
  kind: "missing-base" | "missing-name" | "unwritten-connector" | "no-goal";
  entityId: string;
  detail: string;
}

/**
 * Every entity a player can meet must have been written. This is the assertion
 * the CLI runs: a seed that passes it produced a
 * fully-written dungeon, and one that does not is a bug rather than a taste
 * question.
 *
 * It deliberately checks `resolveBase`, not `entity.base` — a creature's
 * identity legitimately lives on its group or its template, and checking the
 * field directly would report false failures for the consolidated masses that
 * make up most of the population.
 */
export function validateWritten(gd: GeneratedDungeon): WrittenProblem[] {
  const problems: WrittenProblem[] = [];
  const reg = gd.entities.registry;

  const check = (list: { id: string; name: string; type: string }[]) => {
    for (const e of list) {
      if (!resolveBase(e as never, reg)?.trim()) {
        problems.push({ kind: "missing-base", entityId: e.id, detail: `${e.type} has no resolvable base` });
      }
      if (!e.name?.trim()) {
        problems.push({ kind: "missing-name", entityId: e.id, detail: `${e.type} is unnamed` });
      }
    }
  };

  check(gd.entities.rooms);
  check(gd.entities.creatures);
  check(gd.entities.features);
  check(gd.entities.items);
  check(gd.entities.hazards);

  for (const c of gd.entities.connectors) {
    if (!c.base?.trim()) {
      problems.push({
        kind: "unwritten-connector",
        entityId: c.id,
        detail: "connector has no physical form",
      });
    }
  }

  const goalRoom = gd.stocked.goalRoomId;
  const hasGoalEntity =
    gd.entities.items.some((i) => i.parentId === goalRoom && i.keywords?.["Mission"]) ||
    gd.entities.features.some((f) => f.roomId === goalRoom && f.keywords?.["Mission"]) ||
    gd.entities.creatures.some((c) => c.roomId === goalRoom && c.keywords?.["Mission"]);
  if (!hasGoalEntity) {
    problems.push({ kind: "no-goal", entityId: goalRoom, detail: "the goal room holds no goal entity" });
  }

  return problems;
}
