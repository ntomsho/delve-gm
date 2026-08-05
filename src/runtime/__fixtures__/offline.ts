/**
 * A whole generated dungeon, with the model stood in for.
 *
 * Everything in the pipeline except the two calls is deterministic, so the full
 * shape of generation can be exercised for free. The fakes answer exactly what
 * the payload asked for — which is also the bar a real response has to clear,
 * and both are put through zod on the way in so a fake cannot drift from the
 * schema the real path validates against.
 *
 * Not a test file: it lives under __fixtures__ so the runner does not collect
 * it, and is imported by the suites that need a world to work on.
 */

import {
  applyContentPass,
  applyDungeonPass,
  buildContentPassPayload,
  buildDungeonPassPayload,
  generateBlueprint,
  generateBlueprintSeed,
  Rng,
  runEntitiesPass,
  stockDungeon,
  type ContentPassPayload,
  type ContentPassResponse,
  type DungeonPassResponse,
  type PlayerCharacter,
  type Size,
} from "../../engine/index.ts";
import type { GeneratedDungeon } from "../generate.ts";
import { chunksFor, deriveSeeds } from "../seeds.ts";
import { contentPassSchema, dungeonPassSchema } from "../llm/schemas.ts";
import { validate } from "../llm/json.ts";

export function fakeDungeonPass(groupIds: string[]): DungeonPassResponse {
  return {
    name: "The Sunken Mint",
    theme: "Wet limestone, green light through flooded shafts, a constant drip.",
    history: "A coin works drowned by the river it was built to exploit.",
    goal: { summary: "Recover the master die.", spec: "The player carries the master die out through the entrance." },
    openingProse: "The stair goes down into standing water.",
    groups: groupIds.map((id, i) => ({
      id,
      name: `Group ${i + 1} Folk`,
      base: `A standing description of group ${i + 1}, true of every one of them.`,
    })),
  };
}

/** Answer a content-pass payload point for point, the way the schema demands. */
export function fakeContentPass(p: ContentPassPayload): ContentPassResponse {
  return {
    rooms: p.rooms.map((r) => ({
      ref: r.ref,
      name: `Room ${r.ref}`,
      base: `A ${r.identity}, ${r.tension}, at ${r.depth} depth.`,
      entities: r.entities.map((e) => ({ ref: e.ref, name: `${e.kind} thing`, base: `A written ${e.kind}.` })),
      connectors: r.connectors.map((c) => ({
        ref: c.ref,
        name: c.gated ? "Barred door" : "Low arch",
        form: c.gated ? "a plank door, barred from the far side" : "a low arch",
        ...(c.gated ? { requirement: "the bar must be lifted from the other side" } : {}),
      })),
      encounters: r.encounters.map((en) => ({
        ref: en.ref,
        ...(en.group
          ? { group: { name: "Rank and file", base: "The mass, written once.", activity: en.activity } }
          : {}),
        ...(en.distinct.length
          ? {
              distinct: en.distinct.map((d) => ({
                kind: d.kind,
                ...(d.member ? { member: d.member } : {}),
                name: d.kind === "elite" ? "The big one" : "A named person",
                base: `A distinct ${d.kind}.`,
                ...(d.isLeader ? { isLeader: true } : {}),
                activity: en.activity,
              })),
            }
          : {}),
      })),
      ...(r.goal ? { goal: { entityType: "Item" as const, name: "The master die", base: "A steel coin die." } } : {}),
    })),
  };
}

export function generateOffline(seed: number, size: Size): GeneratedDungeon {
  const seeds = deriveSeeds(seed);
  const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, 1);
  const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: chunksFor(size) }, true);
  const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
  const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));

  const dpPayload = buildDungeonPassPayload(blueprint);
  const dp = applyDungeonPass(validate(dungeonPassSchema, fakeDungeonPass(dpPayload.groupIds)), dpPayload);
  Object.assign(entities.registry.groups, dp.groups);

  const chunks = [...new Set(stocked.rooms.map((r) => r.chunk))].sort((a, b) => a - b);
  for (const chunk of chunks) {
    const payload = buildContentPassPayload(stocked, blueprint, entities, chunk, dp.dungeonContext);
    applyContentPass(
      validate(contentPassSchema, fakeContentPass(payload)),
      payload, entities, blueprint, stocked, new Rng(stocked.seed + chunk)
    );
  }

  return {
    id: blueprint.id,
    seeds,
    size,
    level: 1,
    dungeonContext: dp.dungeonContext,
    pass: dp.pass,
    blueprint,
    graph: dungeon,
    stocked,
    entities,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

export function testCharacter(over: Partial<PlayerCharacter> = {}): PlayerCharacter {
  return {
    id: "pc-1",
    name: "Wren",
    level: 1,
    hp: { current: 6, max: 6 },
    abilities: { str: 2, dex: 1, con: 2, int: 1, wis: 1, cha: 1 },
    traits: {
      physique: "Wiry", face: "Bony", skin: "Ashen", hair: "Cropped", clothing: "Patched",
      virtue: "Cautious", vice: "Greedy", speech: "Blunt", background: "Burglar",
      misfortunes: "Exiled", alignment: "Neutrality",
    },
    inventory: [],
    equipped: {},
    conditions: [],
    ...over,
  };
}
