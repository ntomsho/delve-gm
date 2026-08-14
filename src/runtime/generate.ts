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
  applyDungeonPass,
  applySeamsPass,
  buildContentPassPayload,
  buildDungeonPassPayload,
  buildSeamsPassPayload,
  contentPassOmissions,
  seamsPassOmissions,
  generateBlueprint,
  generateBlueprintSeed,
  blockPlanValid,
  roomSizes,
  renderContentPassPrompt,
  renderDungeonPassPrompt,
  renderSeamsPassPrompt,
  resolveBase,
  Rng,
  runEntitiesPass,
  siteRooms,
  stockDungeon,
  type Dungeon,
  type DungeonBlueprintSeed,
  type DungeonPassResponse,
  type EntityPassResult,
  type BlockPlan,
  type Size,
  type StockedDungeon,
} from "../engine/index.ts";
import { callForJson, type Usage } from "./llm/client.ts";
import { contentPassSchema, dungeonPassSchema, seamsPassSchema } from "./llm/schemas.ts";
import { chunksFor, deriveSeeds, type RunSeeds } from "./seeds.ts";
import { NO_JOURNAL, type Journal } from "./journal.ts";

// ---------------------------------------------------------------------------
// PROGRESS
// ---------------------------------------------------------------------------

/**
 * The stages the loading screen reports, named here rather than in the UI so
 * there is nothing for the UI to invent. "writing" is the long one and is the
 * only one that carries a count; "joining" is the short call after it that
 * writes the ways between regions.
 */
export type GenerationStage =
  | "layout"
  | "inhabitants"
  | "history"
  | "stocking"
  | "writing"
  | "joining";

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
  journal?: Journal;
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

export async function generateDungeon(opts: GenerateOptions): Promise<GeneratedDungeon> {
  const { size, signal } = opts;
  const level = opts.level ?? 1;
  const seeds = deriveSeeds(opts.seed);
  const report = opts.onProgress ?? (() => {});
  const journal = opts.journal ?? NO_JOURNAL;

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
      // The drawing, read back as words. Derived rather than persisted — the
      // plan is the durable thing and this is one function over it, so the
      // vocabulary can change without a migration.
      const corridors = new Set(stocked.rooms.filter((r) => r.isCorridor).map((r) => r.index));
      const site = siteRooms(plan, dungeon, { isCorridor: (i) => corridors.has(i) });
      return { dungeon, stocked, entities, plan, site };
    }
  })();

  const [
    { result: fictionResult, usage: fictionUsage },
    { dungeon, stocked, entities, plan, site },
  ] = await Promise.all([fiction, structure]);

  // The Dungeon Pass wrote the inhabitant bases; they belong on the registry,
  // which is the thing that gets persisted alongside the entities.
  Object.assign(entities.registry.groups, fictionResult.groups);

  // --- the content pass: generate in parallel, apply in order --------------
  const chunks = [...new Set(stocked.rooms.map((r) => r.chunk))].sort((a, b) => a - b);
  let done = 0;
  report({ stage: "writing", chunksDone: 0, chunksTotal: chunks.length });

  const generated = await Promise.all(
    chunks.map(async (chunk) => {
      const payload = buildContentPassPayload(
        stocked,
        blueprint,
        entities,
        chunk,
        fictionResult.dungeonContext,
        site
      );
      const prompt = renderContentPassPrompt(payload);
      const { value, usage } = await callForJson({
        task: "content-pass",
        schema: contentPassSchema,
        toolName: "write_region",
        toolDescription: "Name and write every room, entity, connector, and creature group in this region.",
        messages: [{ role: "user", content: prompt }],
        signal,
        // A chunk that answers five of six connectors is well-formed and wrong.
        // Asked here, the omission is a retryable failure; noticed after the
        // pass, it is an unwritten entity nobody can fix. See §1.1.
        check: (v) => contentPassOmissions(payload, v),
      });
      journal.log({ kind: "generation", pass: "content-pass", chunk, prompt, response: value, usage });
      report({ stage: "writing", chunksDone: ++done, chunksTotal: chunks.length });
      return { chunk, payload, value, usage };
    })
  );

  // SERIAL, ascending. Apply is pure and cheap; ordering it costs nothing and
  // is what keeps concurrent mutation of `entities` out of the picture.
  let usage: Usage = fictionUsage;
  for (const g of generated.sort((a, b) => a.chunk - b.chunk)) {
    applyContentPass(g.value, g.payload, entities, blueprint, stocked, new Rng(stocked.seed + g.chunk));
    usage = {
      inputTokens: usage.inputTokens + g.usage.inputTokens,
      outputTokens: usage.outputTokens + g.usage.outputTokens,
    };
  }

  // --- the seams: the ways between chunks ----------------------------------
  //
  // LAST, and alone, because it is the only pass that needs the others finished.
  // A connector joining two chunks cannot be written by either of them — see the
  // header in dungeon-seams-pass.ts — so it waits here until both its rooms have
  // names and descriptions, and is written once with both in front of it.
  const seamsPayload = buildSeamsPassPayload(stocked, entities, fictionResult.dungeonContext);
  if (seamsPayload.seams.length > 0) {
    report({ stage: "joining" });
    const prompt = renderSeamsPassPrompt(seamsPayload);
    const { value, usage: seamsUsage } = await callForJson({
      task: "seams-pass",
      schema: seamsPassSchema,
      toolName: "write_ways_through",
      toolDescription: "Name and write every way through between the regions of the dungeon.",
      messages: [{ role: "user", content: prompt }],
      signal,
      check: (v) => seamsPassOmissions(seamsPayload, v),
    });
    journal.log({ kind: "generation", pass: "seams-pass", prompt, response: value, usage: seamsUsage });
    applySeamsPass(value, seamsPayload, entities);
    usage = {
      inputTokens: usage.inputTokens + seamsUsage.inputTokens,
      outputTokens: usage.outputTokens + seamsUsage.outputTokens,
    };
  }

  const result: GeneratedDungeon = {
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

  // The `dungeon` event is written by the SESSION rather than here. It is the
  // baseline every later diff is a delta from, so a run needs it whatever
  // produced the dungeon — including the offline fixture, which does not come
  // through this function at all and used to leave the journal with no world
  // in it.
  return result;
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
