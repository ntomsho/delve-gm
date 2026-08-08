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
  generateBlueprint,
  generateBlueprintSeed,
  generateFloorplanValid,
  renderContentPassPrompt,
  renderDungeonPassPrompt,
  renderSeamsPassPrompt,
  resolveBase,
  Rng,
  runEntitiesPass,
  stockDungeon,
  type Dungeon,
  type DungeonBlueprintSeed,
  type DungeonPassResponse,
  type EntityPassResult,
  type Floorplan,
  type Size,
  type StockedDungeon,
} from "../engine/index.ts";
import { callForJson, type Usage } from "./llm/client.ts";
import { contentPassSchema, dungeonPassSchema, seamsPassSchema } from "./llm/schemas.ts";
import { chunksFor, deriveSeeds, type RunSeeds } from "./seeds.ts";
import { log } from "./journal.ts";

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
   * **Null when the packer could not draw this graph.** That is not rare at
   * sizes 4 and 5 — see the measurement in CODING-PLAN §6a — so everything
   * downstream treats the plan as an enhancement and falls back to the point
   * layout. A dungeon with no floorplan is still completely playable.
   */
  floorplan: Floorplan | null;
  usage: Usage;
}

/**
 * Floor a room needs for what is already standing in it, keyed by room id.
 * Six cells — a hundred and fifty square feet — per creature and per feature:
 * enough that a room with a warband and three sarcophagi in it does not come
 * out a broom cupboard.
 */
function floorArea(entities: EntityPassResult): Record<string, number> {
  const out: Record<string, number> = {};
  const bump = (roomId: string | undefined) => {
    if (!roomId) return;
    out[roomId] = (out[roomId] ?? 0) + 6;
  };
  for (const c of entities.creatures) bump(c.roomId);
  for (const f of entities.features) bump(f.roomId);
  return out;
}

export interface GenerateOptions {
  seed: number;
  size: Size;
  level?: number;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// PIPELINE
// ---------------------------------------------------------------------------

export async function generateDungeon(opts: GenerateOptions): Promise<GeneratedDungeon> {
  const { size, signal } = opts;
  const level = opts.level ?? 1;
  const seeds = deriveSeeds(opts.seed);
  const report = opts.onProgress ?? (() => {});

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
    log({ kind: "generation", pass: "dungeon-pass", prompt, response: value, usage });
    return { result: applyDungeonPass(value, payload), usage };
  })();

  // --- branch B: structure and entities (pure, instant) --------------------
  const structure = (async () => {
    report({ stage: "layout" });
    const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: chunksFor(size) }, true);
    report({ stage: "stocking" });
    const stocked = stockDungeon(dungeon, blueprint, { level, seed: seeds.stockSeed });
    const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));

    // The plan is drawn before anything is written, so the prose can be given
    // the room it is describing. It is allowed to fail: see GeneratedDungeon.
    const floorplan = generateFloorplanValid(dungeon, stocked, {
      seed: seeds.layoutSeed,
      minCells: floorArea(entities),
    });
    return { dungeon, stocked, entities, floorplan };
  })();

  const [
    { result: fictionResult, usage: fictionUsage },
    { dungeon, stocked, entities, floorplan },
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
        fictionResult.dungeonContext
      );
      const prompt = renderContentPassPrompt(payload);
      const { value, usage } = await callForJson({
        task: "content-pass",
        schema: contentPassSchema,
        toolName: "write_region",
        toolDescription: "Name and write every room, entity, connector, and creature group in this region.",
        messages: [{ role: "user", content: prompt }],
        signal,
      });
      log({ kind: "generation", pass: "content-pass", chunk, prompt, response: value, usage });
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
    });
    log({ kind: "generation", pass: "seams-pass", prompt, response: value, usage: seamsUsage });
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
    floorplan,
    usage,
  };

  // The baseline. Every diff in the rest of the journal is a delta from this,
  // which is what makes the file a complete history rather than a highlight
  // reel — any moment in the run can be rebuilt from here plus the commits.
  log({ kind: "dungeon", dungeon: result });
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
