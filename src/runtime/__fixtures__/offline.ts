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
  applySeamsPass,
  buildContentPassPayload,
  buildDungeonPassPayload,
  buildSeamsPassPayload,
  generateBlueprint,
  generateBlueprintSeed,
  generateFloorplanValid,
  Rng,
  runEntitiesPass,
  stockDungeon,
  type ContentPassPayload,
  type IItem,
  type ContentPassResponse,
  type DungeonPassResponse,
  type PlayerCharacter,
  type SeamsPassPayload,
  type SeamsPassResponse,
  type Size,
} from "../../engine/index.ts";
import type { GeneratedDungeon } from "../generate.ts";
import { chunksFor, deriveSeeds } from "../seeds.ts";
import { contentPassSchema, dungeonPassSchema, seamsPassSchema } from "../llm/schemas.ts";
import { validate } from "../llm/json.ts";

export function fakeDungeonPass(groupIds: string[]): DungeonPassResponse {
  return {
    name: "The Sunken Mint",
    theme: "Wet limestone, green light through flooded shafts, a constant drip.",
    history: "A coin works drowned by the river it was built to exploit.",
    goal: { summary: "Recover the master die.", spec: "The player carries the master die out through the entrance." },
    // Short, but carrying the four things the real instruction asks for — what
    // the place is, what is said about it, what is down there, and the errand —
    // so anything reading the opening for shape gets the right shape offline.
    openingProse:
      "The Sunken Mint sits under the water meadows a half-day east of the town, " +
      "where the river took back the coin works it was built to feed.\n\n" +
      "They say the masters stayed at the presses while it filled. They say a good " +
      "deal else besides, and not much of it agrees.\n\n" +
      "Something lives in the flooded shafts. Nobody who says so has stayed long " +
      "enough to say what.\n\n" +
      "You were paid half in advance. You are here to recover the master die.",
    groups: groupIds.map((id, i) => ({
      id,
      name: `Group ${i + 1} Folk`,
      base: `A standing description of group ${i + 1}, true of every one of them.`,
    })),
  };
}

// ---------------------------------------------------------------------------
// PROSE, WITHOUT A MODEL
// ---------------------------------------------------------------------------
//
// The fake used to answer with its own field names — `base: "A Chasm, calm, at
// threshold depth."` and an entity called "entrance thing". That proved the
// wiring, which was its job, and it was actively misleading for everything
// else: a referee handed a room whose identity is four words of metadata has
// nothing to reason from, so it improvises, and then contradicts what it
// improvised. Two live runs were lost to exactly that.
//
// So the fake still answers the payload point for point — every field is
// derived from what was asked for, and nothing is invented that the payload did
// not name — but it answers in prose. `depth` becomes how deep the water is,
// which suits a drowned mint and, more usefully, gives the referee a hard
// physical fact per room that it cannot talk itself out of.

const WATER: Record<string, string> = {
  threshold: "Water lies ankle-deep across the floor, still and cold.",
  shallow: "The water is shin-deep here and slow-moving.",
  middle: "Water stands knee-deep, and the walls are wet a foot above it.",
  deep: "The water is waist-deep and black, and the floor underfoot is silt.",
  furthest: "The room is flooded to the chest, and the far end is submerged entirely.",
};

const AIR: Record<string, string> = {
  calm: "Nothing has disturbed it in a long time.",
  uneasy: "Something has been through recently; the silt is stirred.",
  dangerous: "There are fresh marks on the stonework, and the water is clouded.",
  lethal: "Bones lie where the water dropped them against the walls.",
};

/** What a written-up feature or item of each kind actually is. */
const THINGS: Record<string, { name: string; base: string }> = {
  obstacle: {
    name: "a fallen sluice gate",
    base: "An iron sluice gate off its runners, jammed across the passage at an angle.",
  },
  clue: {
    name: "a tally board",
    base: "A slate board on the wall, still carrying a chalked column of figures gone soft with damp.",
  },
  reward: {
    name: "a strongbox",
    base: "A banded strongbox, its lid sprung and its lock long since broken open.",
  },
  hazard: {
    name: "a rotted walkway",
    base: "A timber walkway over the deep end, its planks soft and its supports eaten through.",
  },
};

/** Answer a content-pass payload point for point, the way the schema demands. */
export function fakeContentPass(p: ContentPassPayload): ContentPassResponse {
  return {
    rooms: p.rooms.map((r) => ({
      ref: r.ref,
      name: `The ${r.identity}`,
      base:
        `A ${r.identity.toLowerCase()} of the drowned mint, its walls pale limestone crusted with mineral scale. ` +
        `${WATER[r.depth] ?? WATER.middle} ${AIR[r.tension] ?? AIR.calm}`,
      entities: r.entities.map((e) => {
        const thing = THINGS[e.kind] ?? { name: `a ${e.kind}`, base: `A ${e.kind}, written up.` };
        return { ref: e.ref, name: thing.name, base: thing.base };
      }),
      // Seams are listed for the count and written by the seams pass — a chunk
      // answering with one would be writing a room it cannot see.
      connectors: r.connectors.filter((c) => !c.seam).map((c) => {
        // The way out of the dungeon: one end is a room and the other is
        // daylight. Named as a thing, like every other connector.
        if (c.surface) {
          return {
            ref: c.ref,
            name: "the mint's stair",
            form: "A broad flight of worn limestone steps rising out of the water toward the surface.",
          };
        }
        return {
          ref: c.ref,
          name: c.gated ? "a barred door" : "a low arch",
          form: c.gated
            ? "a plank door swollen with water, barred from the far side"
            : "a low arch of fitted stone, its keystone dropped an inch",
          ...(c.gated ? { requirement: "the bar must be lifted from the other side" } : {}),
        };
      }),
      encounters: r.encounters.map((en) => ({
        ref: en.ref,
        ...(en.group
          ? {
              group: {
                name: "the drowned hands",
                base: "Mint workers who never got out, still in the leather aprons they died in.",
                activity: en.activity,
              },
            }
          : {}),
        ...(en.distinct.length
          ? {
              distinct: en.distinct.map((d) => ({
                kind: d.kind,
                ...(d.member ? { member: d.member } : {}),
                name: d.kind === "elite" ? "the shift foreman" : "a drowned clerk",
                base:
                  d.kind === "elite"
                    ? "A heavy figure in a foreman's apron, carrying the mallet it used on the presses."
                    : "A slight figure with an inkhorn still tied at the belt.",
                ...(d.isLeader ? { isLeader: true } : {}),
                activity: en.activity,
              })),
            }
          : {}),
      })),
      ...(r.goal
        ? {
            goal: {
              entityType: "Item" as const,
              name: "the master die",
              base: "A steel coin die the size of a fist, its face still sharp under the tarnish.",
            },
          }
        : {}),
    })),
  };
}

/**
 * Answer a seams payload point for point.
 *
 * It names both rooms in the form, which is what the real instruction asks for
 * and what the pass exists to make possible — a fake that ignored it would hide
 * the one thing worth checking offline.
 */
export function fakeSeamsPass(p: SeamsPassPayload): SeamsPassResponse {
  return {
    connectors: p.seams.map((s) => ({
      ref: s.ref,
      name: s.hidden ? "a hollow-sounding panel" : "a flooded stair",
      form:
        `A short flight of steps between the regions, ${s.a.name} at its head and ` +
        `${s.b.name} at its foot, standing in water for the lower half.`,
      ...(s.gated ? { requirement: "the way is silted up and must be dug clear" } : {}),
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

  // Last, with every room written — the ways between the chunks.
  const seams = buildSeamsPassPayload(stocked, entities, dp.dungeonContext);
  if (seams.seams.length > 0) {
    applySeamsPass(validate(seamsPassSchema, fakeSeamsPass(seams)), seams, entities);
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
    // Drawn for real rather than stubbed, so the offline fixture exercises the
    // packer. It is nullable by design and the fixture does not force it.
    floorplan: generateFloorplanValid(dungeon, stocked, { seed: seeds.layoutSeed }),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

export function testCharacter(over: Partial<PlayerCharacter> = {}): PlayerCharacter {
  return {
    id: "pc-1",
    name: "Testy",
    level: 1,
    hp: { current: 15, max: 15 },
    abilities: { str: 3, dex: 3, con: 3, int: 3, wis: 3, cha: 3 },
    traits: {
      physique: "Wiry", face: "Bony", skin: "Ashen", hair: "Cropped", clothing: "Patched",
      virtue: "Cautious", vice: "Greedy", speech: "Blunt", background: "Burglar",
      misfortunes: "Exiled", alignment: "Neutrality",
    },
    inventory: testInventory,
    equipped: { helmet: "test-helmet", armor: "test-chain", weapon: "test-sword" },
    conditions: [],
    ...over,
  };
}

/**
 * NOTE ON `armor.defense`: it is the DEFENSE, not the Knave bonus. Unarmoured
 * is 11 and a +1 gambeson is 12, so chain (+3) is 14. A bonus written here
 * directly makes the character easier to hit than going naked.
 *
 * The helmet's own `defense` is never read — a helmet and a shield are worth a
 * flat +1 each on top of the body armour. See `armorDefense` in
 * dungeon-character.ts.
 */
const testInventory: IItem[] = [
  { id: 'test-sword', 'name': 'Sword', type: 'Item', parentId: 'pc-1', slots: 2, weapon: { damage: '1d8', hands: 1 }, quality: 3, currentQuality: 3 },
  { id: 'test-chain', 'name': 'Chain', type: 'Item', parentId: 'pc-1', slots: 3, armor: { armorType: 'body', defense: 14 }, quality: 5, currentQuality: 5 },
  { id: 'test-spellbook', 'name': 'Spellbook: Telekinesis', type: 'Item', parentId: 'pc-1', slots: 1, spellBook: { spellName: 'Telekinesis', spellDescription: 'You may mentally move items equal to your level.', exhausted: false } },
  { id: 'test-helmet', 'name': 'Helmet', type: 'Item', parentId: 'pc-1', slots: 1, armor: { armorType: 'helmet', defense: 1 }, quality: 1, currentQuality: 1 },
  { id: 'test-rations', 'name': 'Travel Rations', type: 'Item', parentId: 'pc-1', slots: 1, amount: '3 days' },
  { id: 'test-lantern', 'name': 'Lantern', type: 'Item', parentId: 'pc-1', slots: 1 },
  { id: 'test-rope', 'name': 'Rope', type: 'Item', parentId: 'pc-1', slots: 1, amount: '50 feet' },
]
