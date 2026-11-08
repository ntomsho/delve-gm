/**
 * THE GENERATION PIPELINE
 * =======================
 *
 * Runs once, up front. Produces a dungeon that is completely written before the
 * player takes a single turn.
 *
 *   A: generateBlueprintSeed                                    [pure]
 *      -> Dungeon Pass                                          [1 call]   ─┐
 *   B: generateBlueprint -> rollOutline                         [pure]     ─┘ concurrent
 *   join
 *   Outline: what goes where, and why                           [1 call, plus repairs]
 *   Outline polish: a review of that plan, optional             [1 call]
 *   settleOutline -> runEntitiesPass                            [pure, saved once]
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
  askForKeys,
  buildKeysPassPayload,
  keysPassLeaks,
  keysPassOmissions,
  mergeKeys,
  unwritableKeys,
  renderKeysPassPrompt,
} from "./content/passes/keys-pass.ts";
import { renderOutlinePrompt, renderPolishPrompt } from "./content/passes/outline/prompt.ts";
import { changedFiction, type Outline, type PolishEdit } from "./content/passes/outline/response.ts";
import { rollOutline, type OutlineDraft } from "./content/passes/outline/roll.ts";
import { polishOutline, writeOutline } from "./content/passes/outline/run.ts";
import { settleOutline } from "./content/passes/outline/settle.ts";
import { generateBlueprint, type Dungeon } from "./floorplan/graph.ts";
import {
  generateBlueprintSeed,
  type DungeonBlueprintSeed,
  type Size,
} from "./content/blueprint.ts";
import { Rng } from "../shared/utils/rng.ts";
import { blockPlanValid, roomSizes, type BlockPlan } from "./floorplan/blockplan.ts";
import { resolveBase, resolveName } from "../shared/world/entities.ts";
import { nameGoalLocation } from "./content/challenges.ts";
import { runEntitiesPass } from "./content/entities-pass.ts";
import type { EntityPassResult } from "../shared/world/entities.ts";
import { siteRooms } from "./floorplan/geometry.ts";
import type { StockedDungeon } from "./content/types.ts";
import { addUsage, callForJson, type FailedAttempt, type Usage } from "../llm/client.ts";
import {
  contentPassSchema,
  dungeonPassToolSchema,
  fromDungeonPassTool,
  keysPassSchema,
} from "./content/passes/schemas.ts";
import { deriveSeeds, shapeFor, type RunSeeds } from "./seeds.ts";
import { NO_LOG, type GenerationLog, type GenerationPass } from "./log.ts";

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
  | "planning"
  | "reviewing"
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
  /** the plan this dungeon was built from. Absent on dungeons from before there was one. */
  outline?: Outline;
  usage: Usage;
}

/**
 * The dungeon before its plan exists: the fiction, the drawing and the dice. What
 * the server stores between the first request and the outline's answer.
 */
export interface PlannedDungeon {
  id: string;
  seeds: RunSeeds;
  size: Size;
  level: number;
  readonly dungeonContext: string;
  pass: DungeonPassResponse;
  blueprint: DungeonBlueprintSeed;
  graph: Dungeon;
  blockplan: BlockPlan | null;
  draft: OutlineDraft;
  usage: Usage;
}

/** Whether the plan has been turned into rooms yet. */
export function isSettled(d: PlannedDungeon | GeneratedDungeon): d is GeneratedDungeon {
  return "stocked" in d;
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
  pass: GenerationPass
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

/** The review's answer: the outline to use, and what happened to the proposed edits. */
export interface PolishResult {
  outline: Outline;
  proposed: PolishEdit[];
  kept: boolean;
  rolledBack?: string;
}

/**
 * The model calls between the structure and `finishGeneration`, in the order
 * they run. Each is its own server request, saved unapplied on arrival.
 */
export const STEPS = ["outline", "polish", "content"] as const;
export type Step = (typeof STEPS)[number];

/** One step's answer, as the server keeps it between requests. */
export type StepResult =
  | { step: "outline"; value: Outline; usage: Usage }
  | { step: "polish"; value: PolishResult; usage: Usage }
  | ({ step: "content" } & ContentResult);

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
 * Everything knowable before the plan: the graph, the drawing, the dice the outline
 * chooses among, and the standing fiction.
 *
 * That is a real state rather than a moment inside a function, because the steps
 * below happen in separate HTTP requests and this is what is persisted between them.
 */
export async function generateStructure(opts: GenerateOptions): Promise<PlannedDungeon> {
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

      // THE DRAWING RUNS INSIDE THE ROLL, between the corridors and the fiction.
      //
      // It needs the graph and which rooms are passages, and nothing else. Putting
      // it first means each room's size is settled before its identity is rolled,
      // so the roll can be conditioned on it — a four-cell closet does not get to
      // be a banquet hall. The alternative, which is what 6a did, is to let the
      // roll demand a size and hope the ground obliges; it usually did not.
      let blockplan: BlockPlan | null = null;
      const draft = rollOutline(dungeon, blueprint, {
        seed: seeds.stockSeed,
        level,
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

      return { dungeon, draft, plan };
    }
  })();

  const [{ result: fictionResult, usage }, { dungeon, draft, plan }] =
    await Promise.all([fiction, structure]);

  return {
    id: blueprint.id,
    seeds,
    size,
    level,
    dungeonContext: fictionResult.dungeonContext,
    pass: fictionResult.pass,
    blueprint,
    graph: dungeon,
    blockplan: plan,
    draft,
    usage,
  };
}

// ---------------------------------------------------------------------------
// STEP 2: THE PLAN  (the outline, then a review of it)
// ---------------------------------------------------------------------------

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

/** Decide what goes where. An outline that can't be repaired fails the generation. */
export async function generateOutline(
  planned: PlannedDungeon,
  opts: PassOptions = {}
): Promise<Extract<StepResult, { step: "outline" }>> {
  const journal = opts.journal ?? NO_LOG;
  const { outline, usage } = await writeOutline(planned.draft, planned.pass, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    onAttemptFailed: reportFailure(journal, "outline"),
  });
  journal.log({
    kind: "generation",
    pass: "outline",
    prompt: renderOutlinePrompt(planned.draft, planned.pass),
    response: outline,
    usage,
  });
  return { step: "outline", value: outline, usage };
}

/**
 * Review the outline. Optional by design: a review that fails or doesn't hold up is
 * dropped, and the outline stands as written, so a bad review can't cost a dungeon.
 */
export async function generatePolish(
  planned: PlannedDungeon,
  outline: Outline,
  opts: PassOptions = {}
): Promise<Extract<StepResult, { step: "polish" }>> {
  const journal = opts.journal ?? NO_LOG;
  try {
    const { usage, ...value } = await polishOutline(planned.draft, planned.pass, outline, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      onAttemptFailed: reportFailure(journal, "outline-polish"),
    });
    journal.log({
      kind: "generation",
      pass: "outline-polish",
      prompt: renderPolishPrompt(planned.draft, planned.pass, outline),
      response: value,
      usage,
    });
    return { step: "polish", value, usage };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const rolledBack = e instanceof Error ? e.message : String(e);
    journal.log({ kind: "error", where: "outline-polish", message: `review dropped: ${rolledBack}` });
    return { step: "polish", value: { outline, proposed: [], kept: false, rolledBack }, usage: NO_USAGE };
  }
}

/**
 * Turn the plan into rooms. Pure, but SAVE THE RESULT ONCE: its entity ids are random,
 * and the content pass's answer addresses them.
 */
export function settleDungeon(planned: PlannedDungeon, results: readonly StepResult[]): GeneratedDungeon {
  const outlineStep = results.find((r) => r.step === "outline");
  const polishStep = results.find((r) => r.step === "polish");
  const outline = polishStep?.step === "polish" ? polishStep.value.outline : outlineStep?.step === "outline" ? outlineStep.value : undefined;
  if (!outline) throw new Error("cannot settle a dungeon: step outline was never run");

  const { blueprint, seeds, level, draft: _draft, ...rest } = planned;
  const groupIds = blueprint.inhabitants.map((g) => g.id);
  const fiction = applyDungeonPass(
    changedFiction(planned.pass, groupIds, outline.fictionChanges),
    buildDungeonPassPayload(blueprint)
  );

  const stocked = settleOutline(planned.draft, outline, { level, seed: seeds.stockSeed });
  const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));
  // The Dungeon Pass wrote the inhabitant bases; they belong on the registry,
  // which is the thing that gets persisted alongside the entities.
  Object.assign(entities.registry.groups, fiction.groups);

  let usage = planned.usage;
  for (const r of results) if (r.step !== "content") usage = addUsage(usage, r.usage);

  return {
    ...rest,
    blueprint,
    seeds,
    level,
    dungeonContext: fiction.dungeonContext,
    pass: fiction.pass,
    stocked,
    entities,
    outline,
    usage,
  };
}

// ---------------------------------------------------------------------------
// STEP 3: THE ROOMS  (one model call, and nothing mutated)
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

/**
 * Run one named step: what `POST /api/dungeons/:id/steps/:step` calls. The rooms need a
 * settled dungeon, and the steps before them need one that isn't yet.
 */
export async function generateStep(
  dungeon: PlannedDungeon | GeneratedDungeon,
  step: Step,
  saved: readonly StepResult[],
  opts: PassOptions = {}
): Promise<StepResult> {
  if (step === "content") {
    if (!isSettled(dungeon)) throw new Error("cannot write the rooms: the plan has not been settled");
    return { step, ...(await generateContent(dungeon, opts)) };
  }
  if (isSettled(dungeon)) throw new Error(`cannot run step ${step}: the plan has already been settled`);
  if (step === "outline") return generateOutline(dungeon, opts);
  const written = saved.find((r) => r.step === "outline");
  if (written?.step !== "outline") throw new Error("cannot review the outline: step outline was never run");
  return generatePolish(dungeon, written.value, opts);
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
  const content = results.find((r) => r.step === "content");
  if (content?.step !== "content") throw new Error("cannot finish generation: step content was never run");
  return { value: content.value, usage: content.usage };
}

// ---------------------------------------------------------------------------
// STEP 4: APPLY, AND THE KEYS  (one model call)
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
  const objective = entities.goalEntityId
    ? [...entities.items, ...entities.features, ...entities.creatures].find((e) => e.id === entities.goalEntityId)
    : undefined;
  // Only a planned dungeon: an older one's fact came from the rolled reward, and its
  // keys were placed answering that wording.
  if (objective && partial.outline) {
    nameGoalLocation(stocked, resolveName(objective, entities.registry), objective.type === "Creature");
    for (const r of stocked.rooms) {
      for (const w of r.rewards) {
        const c = w.kind === "key" ? stocked.challenges.find((x) => x.id === w.challengeId) : undefined;
        if (w.kind === "key" && c?.kind === "goal-location") w.answers = c.property;
      }
    }
  }
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
      check: (v) => [...keysPassOmissions(keysPayload, v), ...keysPassLeaks(keysPayload, v)],
      // Game shorthand in what the player reads comes back as a requirement, key by key.
      repair: { ask: askForKeys, merge: mergeKeys },
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
 * The steps above, composed.
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

  const planned = await generateStructure(opts);

  report({ stage: "planning" });
  const outline = await generateOutline(planned, pass);
  report({ stage: "reviewing" });
  const polish = await generatePolish(planned, outline.value, pass);
  const settled = settleDungeon(planned, [outline, polish]);

  report({ stage: "writing" });
  const content = await generateContent(settled, pass);

  return finishGeneration(settled, content, pass);
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
