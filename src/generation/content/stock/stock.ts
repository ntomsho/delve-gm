/**
 * STOCKING
 * ========
 *
 * Phase C -- the rooms loop. Takes the Phase A graph (pure topology) plus the
 * dungeon blueprint seed (the genome) and stocks every room, producing the
 * bundles that the LLM composition pass turns into prose.
 *
 * Sources:
 *   - Maze Rats v4.3 by Ben Milton (CC BY 4.0)          -- THE MAZE tables
 *   - Cairn 2e "Dungeon Seeds", Yochai Gal (CC BY-SA 4.0) -- Special/Feature/Clue
 *
 * PIPELINE
 *   0.  structural pre-pass  -- entrance pick, BFS depth, dead ends, eccentricity,
 *                               core/secret selection, connector promotion
 *   1.  load-bearing         -- entrance features, goal entity, one base room per
 *                               inhabitant group
 *   2.  identity             -- every room gets a name/function. No blank rooms.
 *   3.  headline quota       -- target mix over ALL rooms, minus load-bearing
 *                               claims. The remainder is a conserved budget.
 *   4.  headline placement   -- assign the budget by depth fit, then local swaps
 *                               to break up same-category neighbours (pacing)
 *   5.  danger scoring       -- per room, from headline + occupancy + depth
 *   6.  reward distribution  -- fixed budget K. Guarantees off the top, remainder
 *                               by weighted draw. Conserved, so an empty monster
 *                               room pushes its share elsewhere.
 *   7.  content layers       -- details, hazards/specials, clues-with-pointers
 *   8.  emit                 -- room bundles + mobile entity list
 *
 * DESIGN INVARIANTS
 *   - Headlines and rewards are BUDGETS, not per-room rolls. Load-bearing
 *     placement has already skewed the pool; only subtraction can correct it.
 *   - Headline mix is level-agnostic. Level moves reward GRADE only.
 *   - Creatures are mobile entities referencing a room via locationRoomId. They
 *     are never children of the room.
 *   - Everything is seeded. Same seed in, same dungeon out.
 *
 * THE PASS IN FIVE FILES:
 *
 *   stock.ts      `stockDungeon`, the pipeline above in order (this file)
 *   steps.ts      the steps that are pure functions of the graph
 *   creatures.ts  inhabitants, minions and wanderers
 *   tables.ts     the tables only stocking rolls on, and their cascades
 *   ids.ts        the mobile-id counter both this file and creatures.ts use
 */

import type { DungeonBlueprintSeed, InhabitantGroup, Size } from "../blueprint.ts";
import {
  DUNGEON_ENTRANCES,
  DUNGEON_CORRIDORS,
  DUNGEON_ROOMS,
  DUNGEON_ROOM_DETAILS,
} from "../../../rules/maze-rats/tables.ts";
import { Rng } from "../../../shared/utils/rng.ts";
import type { Dungeon } from "../../floorplan/graph.ts";
import { enumerateChallenges } from "../challenges.ts";
import { placeRewards } from "../rewards.ts";
import { sizeAllows, type SizeClass } from "../../floorplan/room-size.ts";
import type { MobileEntity, RoomStock, StockedDungeon } from "../types.ts";
import {
  computeQuota,
  gateConnectors,
  placeHeadlines,
  resolveClueTargets,
  scoreDanger,
  structuralPrePass,
  type Structure,
} from "./steps.ts";
import {
  makeGroupMobile,
  makeMinionOrWanderer,
  rollDisposition,
  rollSpecial,
} from "./creatures.ts";
import { CAIRN_CLUE, DUNGEON_ACTIVITIES, roll } from "./tables.ts";
import { resetMobileIds } from "./ids.ts";

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

/**
 * Pick the rooms that are passages rather than places.
 *
 * Count is N-1 / N / N+1 at 25 / 50 / 25 where N is the size, which comes to
 * roughly a sixth of the rooms. Size 1 is a coin flip between 0 and 1.
 *
 * Eligibility is **degree >= 2** and nothing else. A corridor connects
 * somewhere, so dead ends are out; the goal room is never one. Dropping every
 * further degree preference removes the one degenerate case -- a size-1 chunk
 * whose 3-cycle carries three spurs has degrees 3,3,3,1,1,1 and therefore no
 * degree-2 rooms at all, which under "exactly 2" would yield none and under
 * ">= 2" yields three.
 *
 * Two corridors are never adjacent: that is one hallway with a pointless door
 * in it. Picks are spread across **depth** bands rather than chunks, because
 * `RoomStock.chunk` is a batching unit and never a content input, and because
 * corridors are about rhythm along the path inward.
 */
function designateCorridors(rooms: RoomStock[], s: Structure, size: Size, rng: Rng): void {
  const target =
    size === 1 ? (rng.coin() ? 1 : 0) : Math.max(0, size + rng.pick([-1, 0, 0, 1]));
  if (target === 0) return;

  const BANDS = 3;
  const bandOf = (r: RoomStock) =>
    s.maxDepth > 0 ? Math.min(BANDS - 1, Math.floor((r.depth / s.maxDepth) * BANDS)) : 0;

  const byIndex = new Map(rooms.map((r) => [r.index, r]));
  const pools: RoomStock[][] = Array.from({ length: BANDS }, () => []);
  for (const r of rooms) {
    if (r.degree < 2 || r.role === "goal") continue;
    pools[bandOf(r)].push(r);
  }

  const taken = new Array<number>(BANDS).fill(0);
  for (let n = 0; n < target; n++) {
    // The emptiest band that still has a legal room in it, so the picks spread
    // along the way in rather than clumping wherever the graph is densest.
    let band = -1;
    for (let b = 0; b < BANDS; b++) {
      if (!pools[b].some(free)) continue;
      if (band < 0 || taken[b] < taken[band]) band = b;
    }
    if (band < 0) return; // fewer legal rooms than the roll asked for

    const choice = rng.pick(pools[band].filter(free));
    choice.isCorridor = true;
    taken[band]++;
  }

  function free(r: RoomStock): boolean {
    return !r.isCorridor && !s.adj[r.index].some((n) => byIndex.get(n)?.isCorridor);
  }
}

export function stockDungeon(
  dungeon: Dungeon,
  blueprint: DungeonBlueprintSeed,
  opts: {
    level?: number;
    seed?: number;
    /**
     * Draw the dungeon, given the rooms once their roles and passages are fixed,
     * and return the size class each one came out. Called between step 1d and
     * step 2 -- after corridors, before identity.
     */
    layout?: (rooms: RoomStock[]) => Array<SizeClass | undefined>;
  } = {}
): StockedDungeon {
  const level = opts.level ?? blueprint.level ?? 1;
  const seed = opts.seed ?? blueprint.seed + 7919;
  const rng = new Rng(seed);
  resetMobileIds(seed);

  // ---- 0. structural pre-pass ----
  // Per-dungeon cohesion: how much of the creature budget ties back to the
  // roster. Low values give the "menagerie of unrelated things" dungeon.
  const cohesion = 0.55 + rng.next() * 0.35;

  const s = structuralPrePass(dungeon, rng);
  const connectors = gateConnectors(dungeon, s, rng);

  const rooms: RoomStock[] = dungeon.rooms.map((r, i) => ({
    roomId: r.entityId,
    index: i,
    chunk: r.chunk,
    role: i === s.entrance ? "entrance" : i === s.goal ? "goal" : "normal",
    headline: "quiet",
    claimed: false,
    isCorridor: false,
    identity: "",
    depth: s.depth[i],
    degree: s.adj[i].length,
    isDeadEnd: s.deadEnds.has(i),
    danger: 0,
    occupants: [],
    rewards: [],
  }));
  const byIndex = new Map(rooms.map((r) => [r.index, r]));
  const mobiles: MobileEntity[] = [];
  const wandererGroups: InhabitantGroup[] = [];

  // ---- 1. load-bearing placement ----

  // 1a. Entrance -- set dressing only. No hazard, no reward. Overrides the
  //     dead-end reward guarantee if it happens to land on one.
  const entranceRoom = byIndex.get(s.entrance)!;
  entranceRoom.headline = "none";
  entranceRoom.claimed = true;
  entranceRoom.entranceFeature = roll(DUNGEON_ENTRANCES, rng);

  // 1b. Goal entity, into the room furthest from the entrance. Emitted as a
  //     mobile so it can equally be a creature, a person, or an object that
  //     something later picks up and carries.
  const goalRoom = byIndex.get(s.goal)!;
  goalRoom.claimed = true;
  goalRoom.headline = "special";
  goalRoom.goalDirective = {
    reward: blueprint.goalSeed.reward,
    mission: blueprint.goalSeed.mission,
    instruction:
      "Create one entity in this room that embodies the dungeon goal. Read the " +
      "dungeon context and decide what type it needs to be -- a creature, a " +
      "person, an object, a feature of the room itself, or something else the " +
      "fiction demands. It must be a thing the party can act on, and reaching " +
      "or resolving it must plausibly satisfy the mission below.",
  };

  // 1c. One base room per inhabitant group. A goal-implicated group is forced
  //     to the goal room first; the rest are placed at random among rooms that
  //     are not the entrance.
  const groupImplicatesGoal = (g: InhabitantGroup): boolean =>
    g.kind === "people" && (g.goalBranch === "same" || g.goalBranch === "opposed");

  const available = rooms
    .filter((r) => r.role !== "entrance")
    .map((r) => r.index);

  const takenBases = new Set<number>();
  let goalGroupAssigned = false;

  blueprint.inhabitants.forEach((group, gi) => {
    let baseIdx: number;

    if (!goalGroupAssigned && groupImplicatesGoal(group)) {
      baseIdx = s.goal;
      goalGroupAssigned = true;
    } else {
      const pool = available.filter(
        (i) => !takenBases.has(i) && i !== s.entrance
      );
      baseIdx = pool.length ? rng.pick(pool) : rng.pick(available);
    }
    takenBases.add(baseIdx);

    const baseRoom = byIndex.get(baseIdx)!;
    baseRoom.claimed = true;
    baseRoom.headline = "creature";

    const m = makeGroupMobile(group, gi, baseRoom.roomId, true, rng);
    mobiles.push(m);
    baseRoom.occupants.push(m.id);
  });

  // ---- 1d. corridors ----
  // Here because this is the first point at which every input exists: it cannot
  // be earlier than Phase A because it needs degree, and it cannot be in Phase A
  // because the goal room is stocking's. Before identity, since a corridor rolls
  // on a different table.
  designateCorridors(rooms, s, blueprint.size, rng);

  // ---- 1e. layout ----
  // THE GEOMETRY RUNS HERE, between the corridors and the fiction.
  //
  // It needs exactly two things -- the graph, and which rooms are passages --
  // and both exist by this line. Everything after it is fiction, and putting the
  // drawing first is what lets a room's size be a fact the fiction works from
  // rather than a demand the drawing has to satisfy. The caller supplies the
  // hook because the layout module sits downstream of this one.
  if (opts.layout) {
    const sizes = opts.layout(rooms);
    rooms.forEach((r, i) => {
      r.sizeClass = sizes[i];
    });
  }

  // ---- 2. identity ----
  // Rerolled until the noun suits the size the room actually came out. Most of
  // the table is unannotated and passes at any size; the ones that are not are
  // the closets and the courtyards, which genuinely cannot be any size at all.
  // Bounded, and falls through to whatever it last rolled -- a slightly wrong
  // noun beats an empty one.
  for (const r of rooms) {
    const table = r.isCorridor ? DUNGEON_CORRIDORS : DUNGEON_ROOMS;
    let id = roll(table, rng);
    for (let t = 0; t < 12 && r.sizeClass && !sizeAllows(id, r.sizeClass); t++) {
      id = roll(table, rng);
    }
    r.identity = id;
  }

  // ---- 3. headline quota ----
  const claimedCounts = { creature: 0, special: 0, quiet: 0 };
  for (const r of rooms) {
    if (!r.claimed || r.headline === "none") continue;
    claimedCounts[r.headline as "creature" | "special" | "quiet"]++;
  }
  const unclaimed = rooms.filter((r) => !r.claimed).map((r) => r.index);
  const quota = computeQuota(rooms.length, claimedCounts, unclaimed.length);

  // ---- 4. headline placement ----
  const assignment = placeHeadlines(unclaimed, quota, s, rng);
  for (const [idx, cat] of assignment) byIndex.get(idx)!.headline = cat;

  // ---- 4b. stacking, deep rooms only, capped ----
  const stackCap = rooms.length >= 18 ? 2 : 1;
  let stacked = 0;
  for (const r of rooms) {
    if (stacked >= stackCap) break;
    if (r.role === "entrance") continue;
    const deep = s.maxDepth ? r.depth / s.maxDepth : 0;
    if (deep < 0.6) continue;
    if (r.headline === "creature" && rng.chance(0.3)) {
      r.stacked = "special";
      stacked++;
    }
  }

  // ---- 5a. spend the creature budget into actual creatures ----
  for (const r of rooms) {
    if (r.headline !== "creature" || r.claimed) continue;
    const m = makeMinionOrWanderer(blueprint, r.roomId, cohesion, wandererGroups, rng);
    mobiles.push(m);
    r.occupants.push(m.id);
  }

  // Every creature gets an activity + a disposition, base rooms included.
  for (const m of mobiles) {
    if (!m.activity) m.activity = roll(DUNGEON_ACTIVITIES, rng);
    if (!m.disposition) m.disposition = rollDisposition(blueprint, m, rng);
  }

  // ---- 5b. special content ----
  for (const r of rooms) {
    const wantsSpecial = r.headline === "special" || r.stacked === "special";
    if (!wantsSpecial) continue;
    // The goal room's "special" is the objective itself, not a puzzle.
    if (r.role === "goal" && r.headline === "special" && !r.stacked) continue;
    r.special = rollSpecial(rng);
  }

  // ---- 5c. quiet content ----
  for (const r of rooms) {
    if (r.headline !== "quiet") continue;
    if (!rng.chance(0.5)) continue; // 50% just a breather
    r.clue = {
      keyword: roll(CAIRN_CLUE, rng),
      about: "",
    };
  }

  // ---- 5d. universal detail layer ----
  for (const r of rooms) {
    if (rng.chance(0.5)) r.detail = roll(DUNGEON_ROOM_DETAILS, rng);
  }

  // ---- 5e. danger ----
  for (const r of rooms) r.danger = scoreDanger(r, mobiles, s.maxDepth);

  // ---- 6. challenges, then rewards ----
  // The enumeration comes FIRST and everything after reads from it: a key is a
  // reward that answers one challenge, so there is nothing to place until the
  // dungeon's questions are written down.
  const challenges = enumerateChallenges({
    rooms,
    mobiles,
    connectors,
    goalRoomId: goalRoom.roomId,
  });
  const placement = placeRewards({
    rooms,
    connectors,
    mobiles,
    entranceRoomId: entranceRoom.roomId,
    goalRoomId: goalRoom.roomId,
    size: blueprint.size,
    challenges,
    maxDepth: s.maxDepth,
    rng,
  });

  // ---- 7. clue pointers (after everything is placed) ----
  resolveClueTargets(rooms, byIndex, s, connectors, mobiles, rng);

  return {
    seed,
    size: blueprint.size,
    level,
    entranceRoomId: entranceRoom.roomId,
    goalRoomId: goalRoom.roomId,
    maxDepth: s.maxDepth,
    rooms,
    mobiles,
    wandererGroups,
    connectors,
    cohesion,
    quota: { ...quota, none: 1 },
    challenges,
    reserve: placement.reserve,
    pot: placement.pot,
    rewardBudget: placement.stats,
  };
}
