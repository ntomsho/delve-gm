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
 *   per chunk: buildContentPassPayload -> LLM                   [N calls, parallel]
 *              applyContentPass                                 [SERIAL, ascending chunk]
 *
 * The Dungeon Pass needs only the rolled genome, so it overlaps the pure
 * stocking branch. Chunk generations all fire at once; their APPLIES are
 * serialised in ascending chunk order, which is a CLAUDE.md rule and also
 * plainly necessary — apply mutates shared state throughout (ep.items,
 * ep.features, ep.bindings, ep.registry, and it rebuilds ep.creatures).
 *
 * `state` and `composed` are NOT written here. Every entity stays unencountered
 * until the player walks in on it; room entry is a runtime pass.
 */

import {
  applyContentPass,
  buildContentPassPayload,
  contentPassOmissions,
  renderContentPassPrompt,
  type ContentPassResponse,
} from "./content/passes/content-pass.ts";
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
import {
  applySeamsPass,
  buildSeamsPassPayload,
  seamsPassOmissions,
  renderSeamsPassPrompt,
} from "./content/passes/seams-pass.ts";
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
import { stockDungeon } from "./content/stock.ts";
import type { StockedDungeon } from "./content/types.ts";
import { addUsage, callForJson, type FailedAttempt, type Usage } from "../llm/client.ts";
import {
  contentPassSchema,
  dungeonPassSchema,
  keysPassSchema,
  seamsPassSchema,
} from "./content/passes/schemas.ts";
import { chunksFor, deriveSeeds, type RunSeeds } from "./seeds.ts";
import { NO_LOG, type GenerationLog } from "./log.ts";

// ---------------------------------------------------------------------------
// PROGRESS
// ---------------------------------------------------------------------------

/**
 * The stages the loading screen reports, named here rather than in the UI so
 * there is nothing for the UI to invent. "writing" is the long one and is the
 * only one that carries a count; "joining" is the short call after it that
 * writes the ways between regions, and "keys" the shorter one after THAT which
 * writes the objects answering the dungeon's questions.
 */
export type GenerationStage =
  | "layout"
  | "inhabitants"
  | "history"
  | "stocking"
  | "writing"
  | "joining"
  | "keys";

export interface GenerationProgress {
  stage: GenerationStage;
  chunksDone?: number;
  chunksTotal?: number;
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
  /** phase A output, for the map */
  graph: Dungeon;
  stocked: StockedDungeon;
  /** every entity, plus the registry that resolves their shared bases */
  entities: EntityPassResult;
  /**
   * The drawing. Persisted rather than recomputed, because the prose will come
   * to refer to it and a map that drifts between generations of the same seed
   * is worse than prose that drifts.
   *
   * Null when no layout could be drawn for this graph — uncommon at sizes 1-3
   * and still real at 5 — so everything downstream treats the plan as an
   * enhancement over the point layout. A dungeon with no plan is playable.
   */
  blockplan: BlockPlan | null;
  usage: Usage;
}

// `floorArea` lived here: a floor a room needed for what the entities pass had
// put in it, which the old packer used to raise a room's size class. It is gone
// deliberately. A room's size is now capped by the ground its neighbours left it,
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
 * Curried on the pass — and, for the content pass, the chunk — because that is
 * exactly what `callForJson` does not know and what a reader of the journal
 * most needs. The chunks run in parallel, so "a content-pass call failed" is
 * not an answer.
 */
function reportFailure(
  journal: GenerationLog,
  pass: "dungeon-pass" | "content-pass" | "seams-pass" | "keys-pass",
  chunk?: number
) {
  return (r: FailedAttempt): void => {
    journal.log({
      kind: "generation-error",
      pass,
      ...(chunk !== undefined ? { chunk } : {}),
      attempt: r.attempt,
      willRetry: r.willRetry,
      message: r.message,
      issues: r.issues,
      ...(r.raw !== undefined ? { raw: r.raw } : {}),
    });
    // And to the console, because the person who hits this in a browser has
    // devtools open and no journal file within reach.
    console.warn(
      `[generate] ${pass}${chunk === undefined ? "" : ` chunk ${chunk}`} ` +
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

/** One content-pass response, as it came back and before it is applied. */
export interface ChunkResult {
  chunk: number;
  value: ContentPassResponse;
  usage: Usage;
}

/** The regions of a dungeon, ascending. One content-pass call each. */
export function chunksOf(partial: GeneratedDungeon): number[] {
  return [...new Set(partial.stocked.rooms.map((r) => r.chunk))].sort((a, b) => a - b);
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
 * A region's payload, built from the partial.
 *
 * Rebuilt rather than persisted, and it must be built from UNAPPLIED entities:
 * a payload says what a region needs written, and entities that have been
 * written no longer need writing. So `finishGeneration` builds every payload
 * before it applies anything — which is what the single-process pipeline always
 * did, it just kept them in a local instead.
 */
function contentPayload(partial: GeneratedDungeon, chunk: number) {
  return buildContentPassPayload(
    partial.stocked,
    partial.blueprint,
    partial.entities,
    chunk,
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
    const { value, usage } = await callForJson({
      task: "dungeon-pass",
      schema: dungeonPassSchema,
      toolName: "establish_dungeon",
      toolDescription: "Record the dungeon's name, theme, history, goal, opening prose, and the standing identity of each inhabitant group.",
      messages: [{ role: "user", content: prompt }],
      signal,
      onAttemptFailed: reportFailure(journal, "dungeon-pass"),
    });
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
    // TODO: the real fix is to derive the centres from the planar embedding
    // Phase A already computes, instead of hill-climbing toward it — see
    // CODING-PLAN §6a.3 Outstanding 1. Then this loop runs once, always.
    for (let attempt = 0; ; attempt++) {
      // `generateValid` appends `#n` internally when a graph fails validation,
      // so a different separator keeps these seeds out of that space.
      const graphSeed = attempt === 0 ? seeds.graphSeed : `${seeds.graphSeed}~${attempt}`;
      const { dungeon } = generateBlueprint(graphSeed, { chunks: chunksFor(size) }, true);
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
// STEP 2: ONE REGION  (one model call, and nothing mutated)
// ---------------------------------------------------------------------------

/**
 * Write one region of the dungeon.
 *
 * PURE WITH RESPECT TO THE PARTIAL. It reads it to build the payload and hands
 * back what came in; it applies nothing. That is what lets the regions be
 * called in parallel — from separate requests, on separate machines — and
 * applied serially afterwards, which is the rule in CLAUDE.md.
 */
export async function generateChunk(
  partial: GeneratedDungeon,
  chunk: number,
  opts: PassOptions = {}
): Promise<ChunkResult> {
  const journal = opts.journal ?? NO_LOG;
  const payload = contentPayload(partial, chunk);
  const prompt = renderContentPassPrompt(payload);

  const { value, usage } = await callForJson({
    task: "content-pass",
    schema: contentPassSchema,
    toolName: "write_region",
    toolDescription: "Name and write every room, entity, connector, and creature group in this region.",
    messages: [{ role: "user", content: prompt }],
    ...(opts.signal ? { signal: opts.signal } : {}),
    // A chunk that answers five of six connectors is well-formed and wrong.
    // Asked here, the omission is a retryable failure; noticed after the
    // pass, it is an unwritten entity nobody can fix. See §1.1.
    check: (v) => contentPassOmissions(payload, v),
    onAttemptFailed: reportFailure(journal, "content-pass", chunk),
  });

  journal.log({ kind: "generation", pass: "content-pass", chunk, prompt, response: value, usage });
  return { chunk, value, usage };
}

// ---------------------------------------------------------------------------
// STEP 3: APPLY, AND JOIN  (one model call)
// ---------------------------------------------------------------------------

/**
 * Apply what the regions wrote, then write the ways between them.
 *
 * The applies are SERIAL and ASCENDING — see CLAUDE.md. Apply is pure and
 * cheap, so ordering it costs nothing and is what keeps concurrent mutation of
 * `entities` out of the picture.
 *
 * `entities` is mutated in place, which is why the result spreads `partial`:
 * the object handed in IS the object written to, and a caller that reloaded the
 * partial from a row a moment ago owns it outright.
 */
export async function finishGeneration(
  partial: GeneratedDungeon,
  results: readonly ChunkResult[],
  opts: PassOptions = {}
): Promise<GeneratedDungeon> {
  const report = opts.onProgress ?? (() => {});
  const journal = opts.journal ?? NO_LOG;
  const { blueprint, stocked, entities } = partial;

  // A region that was never written would otherwise be discovered as an
  // unwritten entity at the end of a pass nobody can rerun.
  const missing = chunksOf(partial).filter((c) => !results.some((r) => r.chunk === c));
  if (missing.length > 0) {
    throw new Error(`cannot finish generation: region ${missing.join(", ")} was never written`);
  }

  // EVERY PAYLOAD FIRST, THEN EVERY APPLY. A payload built after an earlier
  // region had been applied would describe a different job from the one its
  // response was answering.
  const ordered = [...results].sort((a, b) => a.chunk - b.chunk);
  const withPayloads = ordered.map((r) => ({ ...r, payload: contentPayload(partial, r.chunk) }));

  let usage = partial.usage;
  for (const g of withPayloads) {
    applyContentPass(g.value, g.payload, entities, blueprint, stocked, new Rng(stocked.seed + g.chunk));
    usage = addUsage(usage, g.usage);
  }

  // --- the seams: the ways between chunks ----------------------------------
  //
  // LAST, and alone, because it is the only pass that needs the others finished.
  // A connector joining two chunks cannot be written by either of them — see the
  // header in seams-pass.ts — so it waits here until both its rooms have
  // names and descriptions, and is written once with both in front of it.
  const seamsPayload = buildSeamsPassPayload(stocked, entities, partial.dungeonContext);
  if (seamsPayload.seams.length > 0) {
    report({ stage: "joining" });
    const prompt = renderSeamsPassPrompt(seamsPayload);
    const { value, usage: seamsUsage } = await callForJson({
      task: "seams-pass",
      schema: seamsPassSchema,
      toolName: "write_ways_through",
      toolDescription: "Name and write every way through between the regions of the dungeon.",
      messages: [{ role: "user", content: prompt }],
      ...(opts.signal ? { signal: opts.signal } : {}),
      check: (v) => seamsPassOmissions(seamsPayload, v),
      onAttemptFailed: reportFailure(journal, "seams-pass"),
    });
    journal.log({ kind: "generation", pass: "seams-pass", prompt, response: value, usage: seamsUsage });
    applySeamsPass(value, seamsPayload, entities);
    usage = addUsage(usage, seamsUsage);
  }

  // --- the keys: the objects that answer the dungeon's questions ------------
  //
  // AFTER the seams, and last of all, because it needs more finished than any
  // other pass does. A key and the thing it answers are usually in different
  // chunks — that is what makes it a pass rather than part of one — and where
  // the answer is a blocked way, the lock it rewrites may be a seam that only
  // the call above just wrote. It also mints the objective's own keyable
  // properties, which do not exist until a chunk has decided what the objective
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

  // --- the content pass: generate in parallel, apply in order --------------
  const chunks = chunksOf(partial);
  let done = 0;
  report({ stage: "writing", chunksDone: 0, chunksTotal: chunks.length });

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const result = await generateChunk(partial, chunk, pass);
      report({ stage: "writing", chunksDone: ++done, chunksTotal: chunks.length });
      return result;
    })
  );

  return finishGeneration(partial, results, pass);
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
 * the CLI runs and the Phase 1 exit criterion: a seed that passes it produced a
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
