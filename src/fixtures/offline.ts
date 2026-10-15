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
  buildContentPassPayload,
  type ContentPassPayload,
  type ContentPassResponse,
} from "../generation/content/passes/content-pass.ts";
import {
  applyDungeonPass,
  buildDungeonPassPayload,
  type DungeonPassResponse,
} from "../generation/content/passes/dungeon-pass.ts";
import {
  applyKeysPass,
  buildKeysPassPayload,
  type KeysPassPayload,
  type KeysPassResponse,
} from "../generation/content/passes/keys-pass.ts";
import {
  applySeamsPass,
  buildSeamsPassPayload,
  type SeamsPassPayload,
  type SeamsPassResponse,
} from "../generation/content/passes/seams-pass.ts";
import { generateBlueprint, type Dungeon } from "../generation/floorplan/graph.ts";
import { generateBlueprintSeed, type Size } from "../generation/content/blueprint.ts";
import { Rng } from "../shared/utils/rng.ts";
import { blockPlanValid, roomSizes, type BlockPlan } from "../generation/floorplan/blockplan.ts";
import { runEntitiesPass } from "../generation/content/entities-pass.ts";
import { siteRooms } from "../generation/floorplan/geometry.ts";
import { stockDungeon } from "../generation/content/stock.ts";
import type { StockedDungeon } from "../generation/content/types.ts";
import type { AnyItem } from "../shared/world/entities.ts";
import type { PlayerCharacter } from "../rules/knave/character.ts";
import type { GeneratedDungeon } from "../generation/generate.ts";
import { chunksFor, deriveSeeds } from "../generation/seeds.ts";
import {
  contentPassSchema,
  dungeonPassSchema,
  keysPassSchema,
  seamsPassSchema,
} from "../generation/content/passes/schemas.ts";
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
// else: a game master handed a room whose identity is four words of metadata has
// nothing to reason from, so it improvises, and then contradicts what it
// improvised. Two live runs were lost to exactly that.
//
// So the fake still answers the payload point for point — every field is
// derived from what was asked for, and nothing is invented that the payload did
// not name — but it answers in prose. `depth` becomes how deep the water is,
// which suits a drowned mint and, more usefully, gives the game master a hard
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

/**
 * The furniture the fake pass puts in a room, by size class.
 *
 * Deliberately varied across kinds and positions, because the fixture path is
 * the one the map layer reads and a fake that always answered "one altar in the
 * centre" would leave the multi-cell and wall-hugging cases untested. Passages
 * take a starred kind, as the menu requires.
 */
const POSITIONS = ["centre", "west wall", "far end", "a corner"];

const FURNITURE: { kind: string; position: string }[] = [
  { kind: "pillars", position: "throughout" },
  { kind: "shelves", position: "east wall" },
  { kind: "pool", position: "far end" },
  { kind: "sarcophagi", position: "north wall" },
  { kind: "hearth", position: "a corner" },
  { kind: "rubble", position: "near the entrance" },
];

/** Answer a content-pass payload point for point, the way the schema demands. */
export function fakeContentPass(p: ContentPassPayload): ContentPassResponse {
  return {
    // Room index, so different rooms get different furniture without anything
    // here being random — the fixture is a fixture and stays deterministic.
    rooms: p.rooms.map((r, n) => ({
      ref: r.ref,
      name: `The ${r.identity}`,
      base:
        `A ${r.identity.toLowerCase()} of the drowned mint, its walls pale limestone crusted with mineral scale. ` +
        `${WATER[r.depth] ?? WATER.middle} ${AIR[r.tension] ?? AIR.calm}`,
      entities: r.entities.map((e, i) => {
        const thing = THINGS[e.kind] ?? { name: `a ${e.kind}`, base: `A ${e.kind}, written up.` };
        return {
          ref: e.ref,
          name: thing.name,
          base: thing.base,
          // Only when the room was drawn — the response must be answerable
          // without a plan, since a dungeon with no drawing is supported.
          ...(r.geometry ? { position: POSITIONS[i % POSITIONS.length] } : {}),
        };
      }),
      ...(r.fixtures
        ? {
            fixtures: Array.from({ length: r.fixtures.cap }, (_, i) => {
              const f = FURNITURE[(n + i) % FURNITURE.length];
              // A passage only takes the starred half of the menu.
              const kind = r.fixtures!.corridor ? "rubble" : f.kind;
              return {
                kind,
                position: f.position,
                name: `the ${kind}`,
                base: `The ${kind} of the drowned mint, scaled with mineral crust.`,
              };
            }),
          }
        : {}),
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

/**
 * Answer a keys payload point for point.
 *
 * The fact is quoted VERBATIM in the base, which is exactly what the real
 * instruction demands and what the resolution write depends on. A fake that
 * paraphrased would let the one property worth checking offline go untested.
 */
export function fakeKeysPass(p: KeysPassPayload): KeysPassResponse {
  return {
    keys: p.keys.map((k) => ({
      ref: k.ref,
      name: "the almoner's daybook",
      base:
        `A water-stained ledger in a clerk's hand. One entry is underscored ` +
        `twice: "${k.target.fact}".`,
      ...(k.lockRef ? { lockRequirement: `shut fast, and the daybook names what opens it` } : {}),
    })),
    ...(p.goal ? { goalProperties: ["whose name is cut on the underside"] } : {}),
  };
}

export function generateOffline(seed: number, size: Size): GeneratedDungeon {
  const seeds = deriveSeeds(seed);
  const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, 1);
  // A graph that will not draw is thrown away whole, exactly as `generate.ts`
  // does it — the fixture is the interface's main dev path, and a map that is
  // sometimes missing is worse than one that costs a few more milliseconds.
  let dungeon!: Dungeon;
  let blockplan: BlockPlan | null = null;
  let stocked!: StockedDungeon;
  for (let attempt = 0; attempt < 8; attempt++) {
    const graphSeed = attempt === 0 ? seeds.graphSeed : `${seeds.graphSeed}~${attempt}`;
    dungeon = generateBlueprint(graphSeed, { chunks: chunksFor(size) }, true).dungeon;
    // THE DRAWING RUNS INSIDE STOCKING, as it does in `generate.ts`. It used to
    // be computed alongside, which left `RoomStock.sizeClass` unset offline and
    // so left `sizeAllows` — the condition that stops a four-cell closet rolling
    // "Banquet hall" — silently not applying on the dev path.
    let drawn: BlockPlan | null = null;
    const graph = dungeon;
    stocked = stockDungeon(dungeon, blueprint, {
      level: 1,
      seed: seeds.stockSeed,
      layout: (rooms) => {
        const corridor = new Set(rooms.filter((r) => r.isCorridor).map((r) => r.index));
        drawn = blockPlanValid(graph, (i) => corridor.has(i), seeds.layoutSeed);
        return drawn ? roomSizes(drawn.rooms) : rooms.map(() => undefined);
      },
    });
    blockplan = drawn;
    if (blockplan) break;
  }
  const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));
  const corridors = new Set(stocked.rooms.filter((r) => r.isCorridor).map((r) => r.index));
  const site = blockplan
    ? siteRooms(blockplan, dungeon, { isCorridor: (i) => corridors.has(i) })
    : undefined;

  const dpPayload = buildDungeonPassPayload(blueprint);
  const dp = applyDungeonPass(validate(dungeonPassSchema, fakeDungeonPass(dpPayload.groupIds)), dpPayload);
  Object.assign(entities.registry.groups, dp.groups);

  const chunks = [...new Set(stocked.rooms.map((r) => r.chunk))].sort((a, b) => a - b);
  for (const chunk of chunks) {
    const payload = buildContentPassPayload(stocked, blueprint, entities, chunk, dp.dungeonContext, site);
    applyContentPass(
      validate(contentPassSchema, fakeContentPass(payload)),
      payload, entities, blueprint, stocked, new Rng(stocked.seed + chunk)
    );
  }

  // Last but one, with every room written — the ways between the chunks.
  const seams = buildSeamsPassPayload(stocked, entities, dp.dungeonContext);
  if (seams.seams.length > 0) {
    applySeamsPass(validate(seamsPassSchema, fakeSeamsPass(seams)), seams, entities);
  }

  // Last of all — the keys. Offline as online: the content pass left every
  // placed key nameless, and nothing else will ever name it. Skipping it here
  // would leave the dev path with unwritten items in it, which is the exact
  // thing `validateWritten` exists to catch.
  const keys = buildKeysPassPayload(stocked, entities, dp.dungeonContext);
  if (keys.keys.length > 0 || keys.goal) {
    applyKeysPass(validate(keysPassSchema, fakeKeysPass(keys)), keys, stocked, entities);
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
    // block plan. Still typed nullable, because a saved run from before this
    // existed comes back without one.
    blockplan,
    usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
  };
}

/**
 * The test character, and A FRESH ONE EVERY CALL.
 *
 * `inventory` used to hand back `testInventory` itself rather than a copy, and a
 * shared mutable array in a fixture is a trap that springs at a distance: a test
 * that pushes a purse onto the inventory it was given changes the character
 * every later test in the file receives, so the failure lands somewhere that
 * never touched an inventory and passes when run alone. Everything else here is
 * already a fresh literal per call; this is the one thing that was not.
 *
 * `...over` still comes last, so a caller handing in its own inventory gets its
 * own inventory and pays for nothing.
 */
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
    inventory: structuredClone(testInventory),
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
 * character.ts.
 */
const testInventory: AnyItem[] = [
  { id: 'test-sword', name: 'Sword', type: 'Item', parentId: 'pc-1', slots: 2, value: 10, itemKind: 'weapon', weapon: { damage: '1d8', hands: 1 }, quality: 3, currentQuality: 3 },
  { id: 'test-chain', name: 'Chain', type: 'Item', parentId: 'pc-1', slots: 3, value: 1200, itemKind: 'armor', armor: { armorType: 'body', defense: 14 }, quality: 5, currentQuality: 5 },
  { id: 'test-spellbook', name: 'Spellbook: Telekinesis', type: 'Item', parentId: 'pc-1', slots: 1, value: 0, itemKind: 'spellbook', spellBook: { spellName: 'Telekinesis', spellDescription: 'You may mentally move items equal to your level.', exhausted: false } },
  { id: 'test-helmet', name: 'Helmet', type: 'Item', parentId: 'pc-1', slots: 1, value: 40, itemKind: 'armor', armor: { armorType: 'helmet', defense: 1 }, quality: 1, currentQuality: 1 },
  { id: 'test-rations', name: 'Travel Rations', type: 'Item', parentId: 'pc-1', slots: 1, value: 15, amount: '3 days' },
  { id: 'test-lantern', name: 'Lantern', type: 'Item', parentId: 'pc-1', slots: 1, value: 30 },
  { id: 'test-rope', name: 'Rope', type: 'Item', parentId: 'pc-1', slots: 1, value: 10, amount: '50 feet' },
]
