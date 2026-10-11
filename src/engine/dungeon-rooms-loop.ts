/**
 * dungeon-rooms-loop.ts
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
 * NOTE ON TABLES: the MAZE / Cairn tables live inline here for convenience while
 * we test this phase. They are destined for their own module(s) alongside the
 * blueprint tables -- nothing here should assume they stay local.
 *
 * NOTE ON IMPORTS: this expects `genMonster`, `genNpc`, `Rng` and the treasure
 * tables to be exported from dungeon-blueprint.ts (a one-word change each in the
 * source; they are currently module-private).
 */

import {
  Rng,
  genMonster,
  genMonsterGroup,
  genPeopleGroup,
  BUILDING_ROOMS,
  DUNGEON_ENTRANCES,
  DUNGEON_HAZARDS,
  DUNGEON_CORRIDORS,
  DUNGEON_ROOMS,
  DUNGEON_ROOM_DETAILS,
  DUNGEON_TRICKS,
  LOWER_CLASS_BUILDINGS,
  TRAP_EFFECTS,
  TRAP_TRIGGERS,
  UPPER_CLASS_BUILDINGS,
  TREASURE_ITEMS,
  VALUABLE_MATERIALS,
  WEAPON_ITEMS,
  type DungeonBlueprintSeed,
  type InhabitantGroup,
  type MonsterSeed,
  type NpcSeed,
  type Rolled,
  type Size,
  type Tier,
} from "./dungeon-blueprint.ts";

import type { Dungeon, Edge, Room } from "./dungeon-phase-a.ts";
import { enumerateChallenges, type Challenge } from "./dungeon-challenges.ts";
import { placeRewards, type Pot, type Reward, type ReserveEntry } from "./dungeon-rewards.ts";
import { sizeAllows, type SizeClass } from "./dungeon-room-size.ts";

// ---------------------------------------------------------------------------
// TABLES
// Shared Maze Rats tables now live in dungeon-blueprint.ts and are imported
// above -- keeping second copies here is what let "Maze potion" drift into
// "Maze pattern". Only tables used by nothing but the rooms loop stay local.
// ---------------------------------------------------------------------------

const t = (s: string): string[] => s.split("|");

// --- Maze Rats: THE MAZE -----------------------------------------------------

const DUNGEON_ACTIVITIES = t(
  "Besiege|Capture|City Activity|Collect|Construct|Control|Deliver|Demolish|Escape|Feed|Fortify|Guard|Hide|Hunt|Loot|Map|Mine|{Monster} Tactic|Negotiate|Patrol|Perform ritual|Purge|Question|Raid|Repair|Rescue|Research|Revive|Riddle|Scavenge|Seize|Tunnel|Unearth|Vandalize|Wild. Activity|Worship"
);

// --- Cairn 2e ---------------------------------------------------------------

const CAIRN_SPECIAL = t(
  "Books|Bridge|Contraption|Creature|Door|Flames|Furniture|Hole|Liquid|Mirror|Mural|Pool|Shadows|Smoke|Statue|Surface|Treasure|Voices|Wheel|Writing"
);

const CAIRN_FEATURE = t(
  "Ages|Alarms|Animates|Attracts|Charges|Closes|Falls|Glows|Grows|Illusion|Levitates|Locks|Opens|Reflects|Repels|Reveals|Shifts|Silences|Teleport|Transforms"
);

const CAIRN_CLUE = t(
  "Decay|Decor|Draft|Echoes|Footprints|Leavings|Light|Markings|Moisture|Noise|Paraphernalia|Residue|Scurrying|Signs|Smell|Stains|Tapping|Temperature|Vibrations|Writing"
);

// ---------------------------------------------------------------------------
// CASCADES
// ---------------------------------------------------------------------------

const CASCADE_TABLES: Record<string, readonly string[]> = {
  "Building Room": BUILDING_ROOMS,
  "Dungeon Room": DUNGEON_ROOMS,
  "L. Cl. Building": LOWER_CLASS_BUILDINGS,
  "U. Cl. Building": UPPER_CLASS_BUILDINGS,
  "Treasure Item": TREASURE_ITEMS,
  "Val. Material": VALUABLE_MATERIALS,
  "Weapon Item": WEAPON_ITEMS,
};

/** Entity cascades emit a stub for the LLM instead of recursing. */
const ENTITY_CASCADES = new Set(["Monster", "NPC", "faction", "monster"]);
const MAX_CASCADE_DEPTH = 2;

function resolveCascades(entry: string, rng: Rng, depth = 0): string {
  return entry.replace(/\{([^}]+)\}/g, (_m, key: string) => {
    // An entity reference names something the writing pass must supply; it
    // cannot come from a table, so the marker stays inline.
    if (ENTITY_CASCADES.has(key)) return key;
    const table = CASCADE_TABLES[key];
    if (!table || depth >= MAX_CASCADE_DEPTH) return key;
    return resolveCascades(rng.pick(table), rng, depth + 1);
  });
}

function roll(table: readonly string[], rng: Rng): Rolled {
  return resolveCascades(rng.pick(table), rng);
}

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type Headline = "creature" | "special" | "quiet" | "none";
export type RoomRole = "entrance" | "goal" | "normal";
export type Disposition = "hostile" | "neutral" | "friendly";
export interface SpecialContent {
  kind: "hazard" | "obstacle";
  /** hazard: an environmental hazard, or a trap (trigger + effect) */
  hazard?: Rolled;
  trapTrigger?: Rolled;
  trapEffect?: Rolled;
  /** obstacle: Cairn Special + (Cairn Feature | MR Trick) */
  subject?: Rolled;
  behaviour?: Rolled;
  behaviourSource?: "cairn-feature" | "mr-trick";
}

export interface ClueContent {
  keyword: Rolled;
  /** what this clue is actually about -- resolved after all placement */
  targetRoomId?: string;
  targetMobileId?: string;
  about: string;
}

/**
 * What the composition pass must create to embody the dungeon goal. We do not
 * pick the entity TYPE here -- the goal may be a creature, an object, a person,
 * a feature of the room, or something stranger, and only the fiction settled in
 * the Dungeon Pass can say which. The room is fixed; the form is not.
 */
export interface GoalDirective {
  reward: Rolled;
  mission: Rolled;
  instruction: string;
}

export interface MobileEntity {
  id: string;
  kind: "group-member" | "wanderer-monster" | "wanderer-npc";
  /**
   * Id of the group this creature belongs to. Inhabitant groups come from the
   * dungeon pass; wanderer groups are created here during stocking and held in
   * StockedDungeon.wandererGroups. Either way the creature's rolled identity
   * lives on a group at dungeon level, never on the creature itself.
   */
  groupId?: string;
  name: string;
  locationRoomId: string;
  /** index into blueprint.inhabitants, when affiliated */
  groupIndex?: number;
  isBase?: boolean;
  tier?: Tier;
  activity?: Rolled;
  disposition?: Disposition;
  monster?: MonsterSeed;
  npc?: NpcSeed;
  /**
   * Nameless rank and file attached to an inhabitant group. Minions share their
   * parent's tier and are always simple complexity -- for people minions, treat
   * them as simple wherever complexity is needed.
   */
  minion?: "young" | "thrall" | "ecology" | "hirelings";
  notes?: string;
}

export interface RoomStock {
  /** stable entity id carried through from Phase A */
  roomId: string;
  /** graph index, for adjacency work and human-readable reports */
  index: number;
  /** Phase A chunk -- purely a batching unit, never a content input */
  chunk: number;
  role: RoomRole;
  headline: Headline;
  /** true when load-bearing placement claimed this room */
  claimed: boolean;
  /** a claimed room that also stacked a second headline */
  stacked?: Headline;

  /**
   * This room is a passage rather than a place: it rolled `identity` on the
   * Dungeon Corridors table and the floorplan draws it as whatever shape the
   * connection needed rather than as a chamber with an area band.
   *
   * A corridor is an ordinary room in every other respect -- it keeps its
   * headline and its contents, occupancy and travel and fog work on it
   * unchanged. It costs roughly 17% of the content rooms at every size, which
   * is the point rather than the price: a dungeon of nothing but stocked rooms
   * reads as beads on a string, and corridors are the pacing.
   */
  isCorridor: boolean;

  /**
   * How big the room came out once the layout drew it, read off its floor area.
   *
   * This arrives from OUTSIDE stocking, via the `layout` hook, and it arrives
   * before `identity` is rolled -- which is the whole reason the hook exists. A
   * room's size is decided by where its neighbours ended up and how much ground
   * they left it, and no roll can know that in advance. So the geometry settles
   * first and the size then constrains what the room may be: a four-cell closet
   * does not get to be a banquet hall. See `sizeAllows`.
   *
   * Undefined when no layout ran, in which case identity rolls unconstrained.
   */
  sizeClass?: SizeClass;

  identity: Rolled;
  detail?: Rolled;
  entranceFeature?: Rolled;

  depth: number;
  degree: number;
  isDeadEnd: boolean;

  danger: number;
  special?: SpecialContent;
  clue?: ClueContent;
  /**
   * Everything placed here, whoever ends up holding it. An array because there
   * is deliberately NO CAP per room or per entity -- more than one reward in a
   * room is fine, and sometimes you stumble on an awesome find.
   */
  rewards: Reward[];

  /** mobile entity ids currently located here */
  occupants: string[];

  /** present on exactly one room */
  goalDirective?: GoalDirective;
}

export interface StockedConnector {
  id: string;
  a: string;
  b: string;
  /**
   * A connection is either freely usable or it is not. Whatever stands in the
   * way -- locked, blocked, concealed, flooded, too dangerous -- is one idea,
   * not three, so we only mark THAT a connector is gated. What it actually
   * demands falls out of the LLM pass, which can see both rooms it joins, and
   * lands in `requirement` -> the entity's `conditional` field.
   */
  gated: boolean;
  /**
   * Concealed: the player does not know this way exists until they find it.
   * Rolled here rather than decided by the writing pass — see gateConnectors.
   * Independent of `gated`; a way can be hidden, blocked, or both.
   */
  hidden: boolean;
  /** filled by the composition pass; becomes IRoomConnector.conditional */
  requirement?: string;
}

export interface StockedDungeon {
  seed: number;
  size: Size;
  level: number;
  entranceRoomId: string;
  goalRoomId: string;
  maxDepth: number;
  rooms: RoomStock[];
  mobiles: MobileEntity[];
  /**
   * Groups created for wandering encounters. Same shape as inhabitants, but
   * rolled during stocking rather than during dungeon generation, so they are
   * not part of the dungeon's resident population.
   */
  wandererGroups: InhabitantGroup[];
  connectors: StockedConnector[];
  /** per-dungeon share of creature encounters tied to the roster */
  cohesion: number;
  quota: Record<Headline, number>;
  /**
   * Every keyable property in the dungeon, enumerated. Keys answer these,
   * accomplishments resolve them, and XP prices them -- see dungeon-challenges.
   */
  challenges: Challenge[];
  /**
   * The challenges no placed key answers, held for a draw in play. Pure data:
   * a reserve entry is written only when it is drawn.
   */
  reserve: ReserveEntry[];
  /** the dungeon's money, conserved */
  pot: Pot;
  rewardBudget: { general: number; keys: number; reserved: number };
}

// ---------------------------------------------------------------------------
// GRAPH HELPERS
// ---------------------------------------------------------------------------

function buildAdjacency(rooms: Room[], edges: Edge[]): number[][] {
  const adj: number[][] = rooms.map(() => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  return adj;
}

function bfsDepth(adj: number[][], from: number): number[] {
  const dist = new Array<number>(adj.length).fill(-1);
  dist[from] = 0;
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const u = q[i];
    for (const v of adj[u]) {
      if (dist[v] === -1) {
        dist[v] = dist[u] + 1;
        q.push(v);
      }
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// STEP 0 -- STRUCTURAL PRE-PASS
// ---------------------------------------------------------------------------
// Phase A leaves category/tier/role blank and every connector "standard", so
// everything downstream that reads depth or role has to be derived here first.

interface Structure {
  entrance: number;
  depth: number[];
  maxDepth: number;
  deadEnds: Set<number>;
  goal: number;
  secret: number | null;
  adj: number[][];
}

function structuralPrePass(d: Dungeon, rng: Rng): Structure {
  const adj = buildAdjacency(d.rooms, d.edges);

  // ONE entrance, and it is where the player starts.
  //
  // Phase A currently emits 2-3 of these (see the REVISIT note on
  // chooseEntrances). That was unintended, and honouring it would wreck the
  // depth gradient that danger, reward weighting and headline placement all
  // read from. We deliberately take entrances[0] and drop the rest; the extras
  // are not marked, not described, and not treated as ways in.
  const entrance = d.entrances.length ? d.entrances[0] : 0;

  const depth = bfsDepth(adj, entrance);
  const maxDepth = Math.max(...depth);

  const deadEnds = new Set<number>();
  d.rooms.forEach((r, i) => {
    if (adj[i].length <= 1 && i !== entrance) deadEnds.add(i);
  });

  // Goal: eccentricity from the entrance -- the honest "opposite side of the
  // map". Ties break toward the better-connected room so the climax has routes.
  let goal = entrance;
  let best = -1;
  d.rooms.forEach((_r, i) => {
    if (i === entrance) return;
    const score = depth[i] * 10 + adj[i].length;
    if (score > best) {
      best = score;
      goal = i;
    }
  });

  // Secret: the deepest dead end that isn't the goal. May be null in small
  // dungeons with no spare dead ends.
  let secret: number | null = null;
  let secretDepth = -1;
  for (const i of deadEnds) {
    if (i === goal) continue;
    if (depth[i] > secretDepth) {
      secretDepth = depth[i];
      secret = i;
    }
  }

  return { entrance, depth, maxDepth, deadEnds, goal, secret, adj };
}

/**
 * Gate a share of connectors. Cairn distinguishes "hidden" from "conditional",
 * but they are the same mechanism wearing two hats: a connection that demands
 * something of the player before it can be used. So they share one budget.
 *
 * Cairn gives no number, so: between 1/6 and 1/4 of all connectors, spread
 * more or less evenly rather than clumped.
 *
 * Two structural guards. A room may never have ALL of its connectors gated --
 * that turns a gate into a wall -- with one deliberate exception: the secret
 * room, where being wholly behind a gate is the entire point. And the entrance
 * always keeps an open way in.
 */
function gateConnectors(
  d: Dungeon,
  s: Structure,
  rng: Rng
): StockedConnector[] {
  const E = d.edges.length;
  const gated: boolean[] = d.edges.map(() => false);

  const lo = Math.ceil(E / 6);
  const hi = Math.max(lo, Math.floor(E / 4));
  const target = rng.range(lo, hi);

  // incident edge indices per room
  const incident: number[][] = d.rooms.map(() => []);
  d.edges.forEach((e, i) => {
    incident[e.a].push(i);
    incident[e.b].push(i);
  });

  const ungated = d.rooms.map((_r, i) => incident[i].length);
  const gatedTouching = d.rooms.map(() => 0);

  const canGate = (ei: number): boolean => {
    const e = d.edges[ei];
    for (const v of [e.a, e.b]) {
      if (v === s.secret) continue; // the secret room may sit wholly behind gates
      if (ungated[v] - 1 < 1) return false;
    }
    return true;
  };

  let placed = 0;
  while (placed < target) {
    // Spread: prefer edges whose endpoints are not already near a gate. The
    // secret room's edges get a pull so the hidden zone actually materialises.
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < E; i++) {
      if (gated[i]) continue;
      if (!canGate(i)) continue;
      const e = d.edges[i];
      const touchesSecret = s.secret !== null && (e.a === s.secret || e.b === s.secret);
      const score =
        gatedTouching[e.a] + gatedTouching[e.b] - (touchesSecret ? 5 : 0) + rng.next() * 0.5;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // guards exhausted the candidates

    const e = d.edges[bestIdx];
    gated[bestIdx] = true;

    ungated[e.a]--;
    ungated[e.b]--;
    gatedTouching[e.a]++;
    gatedTouching[e.b]++;
    placed++;
  }

  // Concealment, decided here rather than by the writing pass.
  //
  // Every other kind of hidden thing is settled when it is first described, by
  // whoever is looking at the prose. A way through is different: it is
  // topology, and the map, the exit list and the player's whole sense of what
  // is reachable hang off it. That wants a seeded roll that replays identically
  // and cannot drift, not a judgement made afresh each run.
  //
  // Drawn only from connectors that were already going to be special, so the
  // count of ordinary open ways is untouched — a gated way becomes a concealed
  // one 25% of the time, and is concealed AND blocked another 10%. Secret
  // passages are meant to be an occasional pleasure; make them common and they
  // stop being a discovery and start being a progression tax.
  //
  // Progression is safe by construction: `canGate` above keeps at least one
  // ungated edge on every room bar the deliberate secret one, and concealment
  // only ever draws from the gated set. No room can have all its ways hidden.
  const hidden: boolean[] = d.edges.map(() => false);
  const stillGated = [...gated];
  for (let i = 0; i < E; i++) {
    if (!gated[i]) continue;
    const roll = rng.next();
    if (roll < 0.25) {
      hidden[i] = true;
      stillGated[i] = false; // concealed instead of blocked
    } else if (roll < 0.35) {
      hidden[i] = true; // concealed AND blocked
    }
  }

  return d.edges.map((e, i) => ({
    id: e.entityId,
    a: d.rooms[e.a].entityId,
    b: d.rooms[e.b].entityId,
    gated: stillGated[i],
    hidden: hidden[i],
  }));
}

// ---------------------------------------------------------------------------
// STEP 3 -- HEADLINE QUOTA
// ---------------------------------------------------------------------------
// Target mix over ALL rooms, minus what load-bearing already claimed. Level
// agnostic by design. Roughly thirds, which lands on the Moldvay ratio once
// Special absorbs both traps and tricks.

const BASE_MIX: Record<"creature" | "special" | "quiet", number> = {
  creature: 0.34,
  special: 0.33,
  quiet: 0.33,
};

function computeQuota(
  totalRooms: number,
  claimed: Record<"creature" | "special" | "quiet", number>,
  unclaimedCount: number
): Record<"creature" | "special" | "quiet", number> {
  // The entrance is set dressing and sits outside the accounting.
  const pool = totalRooms - 1;

  const target = {
    creature: Math.round(pool * BASE_MIX.creature),
    special: Math.round(pool * BASE_MIX.special),
    quiet: Math.round(pool * BASE_MIX.quiet),
  };

  const remainder = {
    creature: Math.max(0, target.creature - claimed.creature),
    special: Math.max(0, target.special - claimed.special),
    quiet: Math.max(0, target.quiet - claimed.quiet),
  };

  // Reconcile so the budget exactly fills the unclaimed rooms. Surplus is
  // shaved off the largest bucket; shortfall is added to Quiet, because a
  // breather is the safest thing to over-supply.
  let sum = remainder.creature + remainder.special + remainder.quiet;
  const order: Array<"creature" | "special" | "quiet"> = [
    "creature",
    "special",
    "quiet",
  ];
  while (sum > unclaimedCount) {
    const biggest = order.reduce((a, b) => (remainder[a] >= remainder[b] ? a : b));
    if (remainder[biggest] === 0) break;
    remainder[biggest]--;
    sum--;
  }
  while (sum < unclaimedCount) {
    remainder.quiet++;
    sum++;
  }

  return remainder;
}

// ---------------------------------------------------------------------------
// STEP 4 -- HEADLINE PLACEMENT
// ---------------------------------------------------------------------------
// Assign the budget over unclaimed rooms by depth fit, then local swaps that
// reduce same-category adjacency. The adjacency term is the actual pacing
// lever -- it stops four fights chaining into a slog. Per-room rolling cannot
// express this at all.

/** Preferred normalised depth per category. */
const DEPTH_FIT: Record<"creature" | "special" | "quiet", number> = {
  creature: 0.75,
  special: 0.6,
  quiet: 0.25,
};

function placeHeadlines(
  unclaimed: number[],
  quota: Record<"creature" | "special" | "quiet", number>,
  s: Structure,
  rng: Rng
): Map<number, "creature" | "special" | "quiet"> {
  const norm = (i: number) => (s.maxDepth ? s.depth[i] / s.maxDepth : 0);

  // Build the multiset of categories to place.
  const pool: Array<"creature" | "special" | "quiet"> = [];
  (["creature", "special", "quiet"] as const).forEach((c) => {
    for (let i = 0; i < quota[c]; i++) pool.push(c);
  });

  // Greedy: sort rooms by depth, sort the pool by preferred depth, zip.
  const rooms = [...unclaimed].sort((a, b) => norm(a) - norm(b));
  pool.sort((a, b) => DEPTH_FIT[a] - DEPTH_FIT[b]);

  const assign = new Map<number, "creature" | "special" | "quiet">();
  rooms.forEach((r, i) => assign.set(r, pool[i]));

  // Local improvement: swap pairs while it lowers total cost.
  const cost = (r: number, c: "creature" | "special" | "quiet") => {
    const fit = Math.abs(norm(r) - DEPTH_FIT[c]);
    let clash = 0;
    for (const n of s.adj[r]) if (assign.get(n) === c) clash++;
    return fit + clash * 0.45;
  };

  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const ri = rooms[i];
        const rj = rooms[j];
        const ci = assign.get(ri)!;
        const cj = assign.get(rj)!;
        if (ci === cj) continue;
        const before = cost(ri, ci) + cost(rj, cj);
        assign.set(ri, cj);
        assign.set(rj, ci);
        const after = cost(ri, cj) + cost(rj, ci);
        if (after < before) {
          improved = true;
        } else {
          assign.set(ri, ci);
          assign.set(rj, cj);
        }
      }
    }
    if (!improved) break;
  }

  return assign;
}

// ---------------------------------------------------------------------------
// STEP 5 -- DANGER SCORING
// ---------------------------------------------------------------------------

function scoreDanger(room: RoomStock, mobiles: MobileEntity[], maxDepth: number): number {
  let d = 0;

  switch (room.headline) {
    case "creature":
      d += 0.5;
      break;
    case "special":
      d += room.special?.kind === "hazard" ? 0.45 : 0.2;
      break;
    case "quiet":
      d += 0.05;
      break;
    case "none":
      return 0; // entrance is set dressing, full stop
  }
  if (room.stacked === "special") d += 0.15;
  if (room.stacked === "creature") d += 0.2;

  const here = mobiles.filter((m) => m.locationRoomId === room.roomId);
  for (const m of here) {
    const tierBonus = m.tier === "Horde" ? 0.22 : m.tier === "Band" ? 0.15 : 0.1;
    d += m.isBase ? tierBonus : tierBonus * 0.6;
    if (m.disposition === "friendly") d -= 0.12;
    if (m.disposition === "neutral") d -= 0.06;
  }

  const depthNorm = maxDepth ? room.depth / maxDepth : 0;
  d += depthNorm * 0.35;
  if (room.role === "goal") d += 0.25;

  return Math.max(0, Math.min(1, d));
}

// ---------------------------------------------------------------------------
// STEP 7 -- CLUE POINTERS
// ---------------------------------------------------------------------------
// Cairn's Clue column is not lore -- Draft, Echoes, Scurrying, Leavings are all
// telegraphs of something NEARBY. We have the adjacency graph, so a clue points
// at a real neighbour's real contents. Prefer hidden or dangerous targets;
// pointing at something already obvious is a wasted clue.

function resolveClueTargets(
  rooms: RoomStock[],
  byIndex: Map<number, RoomStock>,
  s: Structure,
  connectors: Array<{ id: string; a: string; b: string; gated: boolean }>,
  mobiles: MobileEntity[],
  rng: Rng
): void {
  const hiddenRoomIds = new Set<string>();
  for (const c of connectors) {
    if (c.gated) {
      hiddenRoomIds.add(c.a);
      hiddenRoomIds.add(c.b);
    }
  }

  for (const room of rooms) {
    if (!room.clue) continue;

    const neighbours = s.adj[room.index]
      .map((i) => byIndex.get(i))
      .filter((r): r is RoomStock => !!r);

    const scored = neighbours.map((n) => {
      let score = 0.1;
      if (n.special?.kind === "hazard") score += 1.0;
      if (n.headline === "creature") score += 0.8;
      if (n.role === "goal") score += 1.2;
      if (hiddenRoomIds.has(n.roomId)) score += 1.0;
      if (n.rewards.length) score += 0.5;
      if (n.headline === "quiet" && !n.rewards.length) score -= 0.05;
      return { n, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const target = scored.length ? scored[0].n : undefined;

    if (target) {
      room.clue.targetRoomId = target.roomId;
      const occ = mobiles.filter((m) => m.locationRoomId === target.roomId);
      if (occ.length) room.clue.targetMobileId = rng.pick(occ).id;
      room.clue.about =
        target.role === "goal"
          ? "the objective"
          : target.special?.kind === "hazard"
          ? "a hazard in an adjoining room"
          : occ.length
          ? "creatures in an adjoining room"
          : hiddenRoomIds.has(target.roomId)
          ? "a way that is not obvious"
          : "an adjoining room";
    } else {
      room.clue.about = "the dungeon at large";
    }
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

/**
 * Mobile ids are derived from the stocking seed and a counter that resets at
 * the top of every stockDungeon() call, so stocking the same seed twice in one
 * process yields the same ids. A bare module-level counter did not: the second
 * run continued from wherever the first stopped, which quietly broke
 * same-seed-twice assertions and any snapshot of a payload carrying mob refs.
 */
let mobilePrefix = "mob";
let mobileCounter = 0;
function resetMobileIds(seed: number): void {
  mobilePrefix = `mob_${(seed >>> 0).toString(36)}`;
  mobileCounter = 0;
}
function mobileId(): string {
  return `${mobilePrefix}_${(++mobileCounter).toString(36)}`;
}

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

// ---------------------------------------------------------------------------
// CREATURE HELPERS
// ---------------------------------------------------------------------------

/**
 * A Creature entity is a STACK, not an individual: a statblock template, a
 * count, and a location. Any group of creatures sharing a room and a statline
 * is one entity. It splits when part of the group is sent elsewhere and merges
 * back when they reunite, so entity identity is not stable over play.
 *
 * DEFERRED -- counts and split/merge live in `state` for now rather than being
 * modelled here. Two things to pick up if that stops being good enough:
 *   - merging needs a stable key (same template + same room), so templates want
 *     an id rather than being compared structurally
 *   - a split produces a new entity that shares its parent's immutable `base`
 *     while diverging in `state`; base is template-level, state is stack-level
 *
 * The blueprint already carries the template split this implies: people Hordes
 * get one named leader plus `undefinedUnderlings`, monster Hordes get `monster`
 * (simple minions) alongside `biggerSpecimen` (same silhouette, higher tier).
 * Named NPCs are just count-1 stacks whose stats happen to be unique, so they
 * never merge with anything.
 */
function groupLabel(g: InhabitantGroup, gi: number): string {
  return g.kind === "monsters"
    ? `Group ${gi + 1} (${g.tier} ${g.monster.silhouette} monsters)`
    : `Group ${gi + 1} (${g.tier} ${g.faction})`;
}

function makeGroupMobile(
  group: InhabitantGroup,
  gi: number,
  roomId: string,
  isBase: boolean,
  rng: Rng
): MobileEntity {
  const m: MobileEntity = {
    id: mobileId(),
    kind: "group-member",
    name: `${groupLabel(group, gi)}${isBase ? " -- BASE" : " -- outpost"}`,
    locationRoomId: roomId,
    groupIndex: gi,
    groupId: group.id,
    isBase,
    tier: group.tier,
  };
  if (group.kind === "monsters") m.monster = group.monster;
  return m;
}

/**
 * Downgrade a Solo's statline to something a satellite can carry: same creature,
 * fewer moving parts. Matches what genMonster would have produced at "simple"
 * (one trait/ability line, one feature/mutation line).
 *
 * The weakness is deliberately INHERITED rather than trimmed. Young share the
 * parent's flaw, so a party that fights the brood can learn how to kill the
 * thing that spawned it -- which is the same cross-link the knowledge parcels
 * lean on, arrived at from the other direction.
 */
function downgradeToSimple(m: MonsterSeed): MonsterSeed {
  return {
    ...m,
    complexity: "simple",
    traitsAndAbilities: m.traitsAndAbilities.slice(0, 1),
    featuresAndMutations: m.featuresAndMutations.slice(0, 1),
    weaknesses: m.weaknesses.slice(0, 1),
  };
}

/**
 * A Solo is one creature and cannot literally appear twice, but it can have a
 * minions. For people, that is a handful of hirelings under their command. For
 * monsters, a knot of simple creatures related to it by blood, thrall, or
 * ecology.
 */
function makeMinion(
  group: InhabitantGroup,
  gi: number,
  roomId: string,
  rng: Rng
): MobileEntity {
  const base: MobileEntity = {
    id: mobileId(),
    kind: "group-member",
    name: "",
    locationRoomId: roomId,
    groupIndex: gi,
    groupId: group.id,
    isBase: false,
    // Minions share their parent's tier -- tier describes how many creatures
    // the entity stands for, and a minion stack mirrors the group it serves.
    tier: group.tier,
  };

  if (group.kind === "people") {
    return {
      ...base,
      name: `${groupLabel(group, gi)} -- hirelings`,
      minion: "hirelings",
      notes:
        "A handful of hired hands under the Solo's command. Undefined as " +
        "individuals unless one of them earns a name in play.",
    };
  }

  const kind = rng.pick(["young", "thrall", "ecology"] as const);
  if (kind === "young") {
    return {
      ...base,
      name: `${groupLabel(group, gi)} -- young`,
      minion: "young",
      monster: downgradeToSimple(group.monster),
      notes: "The Solo's brood. Same creature, scaled down; shares its weakness.",
    };
  }
  if (kind === "thrall") {
    return {
      ...base,
      name: `${groupLabel(group, gi)} -- thralls`,
      minion: "thrall",
      monster: genMonster("simple", rng),
      notes: "Simple creatures held under the Solo's control, not its kin.",
    };
  }
  // Ecology: something that simply lives alongside it. Rolled independently --
  // the composition pass is on the hook for working out how it fits the Solo's
  // ecology, which is a judgement call, not a table lookup.
  return {
    ...base,
    name: `${groupLabel(group, gi)} -- attendant creatures`,
    minion: "ecology",
    monster: genMonster("simple", rng),
    notes:
      "Tied to the Solo by ecology rather than obedience or blood. Composition " +
      "pass establishes the relationship (prey, scavenger, symbiote, parasite...).",
  };
}

/**
 * Spend one unit of Creature budget. With probability `cohesion` the encounter
 * belongs to the roster; otherwise it is unaffiliated. Cohesion is rolled once
 * per dungeon, so some dungeons read as tightly populated by their inhabitants
 * and others as a menagerie of unrelated things -- which is its own valid vibe,
 * not a failure mode.
 *
 * Solos now participate, but through minions rather than by duplicating
 * themselves, and they weight lower than Bands and Hordes so they still mostly
 * stay home.
 */
function makeMinionOrWanderer(
  bp: DungeonBlueprintSeed,
  roomId: string,
  cohesion: number,
  wandererGroups: InhabitantGroup[],
  rng: Rng
): MobileEntity {
  const eligible = bp.inhabitants.map((g, gi) => ({ g, gi }));

  if (eligible.length && rng.chance(cohesion)) {
    const weights = eligible.map(({ g }) =>
      g.tier === "Horde" ? 3 : g.tier === "Band" ? 1.5 : 0.6
    );
    const total = weights.reduce((a, b) => a + b, 0);
    let x = rng.next() * total;
    let k = 0;
    for (; k < eligible.length; k++) {
      x -= weights[k];
      if (x <= 0) break;
    }
    if (k >= eligible.length) k = eligible.length - 1;
    const { g, gi } = eligible[k];
    return g.tier === "Solo"
      ? makeMinion(g, gi, roomId, rng)
      : makeGroupMobile(g, gi, roomId, false, rng);
  }

  // Unaffiliated. This branch is also where Cairn's "at least one NPC who
  // actually prefers dungeon life" comes from.
  //
  // Tier is rolled rather than fixed to Solo: an unaffiliated encounter can be
  // a swarm or a small pack as readily as one lone thing, and a wandering
  // threat that outclasses the resident faction is a feature -- it gives the
  // player something to turn against them. Complexity follows tier so the
  // creature's power matches what the entity represents.
  const tier: Tier = rng.pick(["Solo", "Band", "Horde"] as Tier[]);
  if (rng.chance(0.5)) {
    const group = genMonsterGroup(tier, rng);
    wandererGroups.push(group);
    return {
      id: mobileId(),
      kind: "wanderer-monster",
      name: "Unaffiliated creature",
      locationRoomId: roomId,
      tier,
      groupId: group.id,
      monster: group.monster,
    };
  }
  // Wanderers use the lighter Band weighting -- a group met in a corridor is
  // not worth as much apparatus as one that lives here.
  const group = genPeopleGroup(tier, rng, "wanderer");
  wandererGroups.push(group);
  return {
    id: mobileId(),
    kind: "wanderer-npc",
    name: "Unaffiliated person",
    locationRoomId: roomId,
    tier,
    groupId: group.id,
    npc: group.npcs[0],
  };
}

/**
 * Disposition is a property of the encounter, not of the category. Inhabitants
 * are usually hostile but genuinely need not be -- a faction whose goal aligns
 * with the party's has obvious reason to parley.
 */
function rollDisposition(
  bp: DungeonBlueprintSeed,
  m: MobileEntity,
  rng: Rng
): Disposition {
  if (m.groupIndex !== undefined) {
    const g = bp.inhabitants[m.groupIndex];
    if (g.kind === "people") {
      if (g.goalBranch === "opposed") {
        return rng.chance(0.85) ? "hostile" : "neutral";
      }
      if (g.goalBranch === "same") {
        // Ally or rival, leaning rival.
        const r = rng.next();
        return r < 0.45 ? "hostile" : r < 0.8 ? "neutral" : "friendly";
      }
      const r = rng.next();
      return r < 0.55 ? "hostile" : r < 0.85 ? "neutral" : "friendly";
    }
    // Monsters: mostly hostile, occasionally just busy.
    return rng.chance(0.8) ? "hostile" : "neutral";
  }
  const r = rng.next();
  return r < 0.6 ? "hostile" : r < 0.88 ? "neutral" : "friendly";
}

function rollSpecial(rng: Rng): SpecialContent {
  if (rng.coin()) {
    // Hazard half: an environmental hazard, or a built trap.
    if (rng.coin()) {
      return { kind: "hazard", hazard: roll(DUNGEON_HAZARDS, rng) };
    }
    return {
      kind: "hazard",
      trapTrigger: roll(TRAP_TRIGGERS, rng),
      trapEffect: roll(TRAP_EFFECTS, rng),
    };
  }
  // Obstacle half: Cairn Special + (Cairn Feature | MR Trick).
  const useTrick = rng.chance(0.4);
  return {
    kind: "obstacle",
    subject: roll(CAIRN_SPECIAL, rng),
    behaviour: useTrick ? roll(DUNGEON_TRICKS, rng) : roll(CAIRN_FEATURE, rng),
    behaviourSource: useTrick ? "mr-trick" : "cairn-feature",
  };
}

// ---------------------------------------------------------------------------
// REPORTING
// ---------------------------------------------------------------------------

const rr = (x?: Rolled) => (!x ? "" : x === x ? x : `${x} [${x}]`);

export function stockSheet(sd: StockedDungeon, bp: DungeonBlueprintSeed): string {
  const L: string[] = [];
  const mobById = new Map(sd.mobiles.map((m) => [m.id, m]));

  L.push(`=== STOCKED DUNGEON ===`);
  L.push(
    `${bp.id}  size ${sd.size}  level ${sd.level}  rooms ${sd.rooms.length}  seed ${sd.seed}`
  );
  L.push(
    `quota placed -> creature ${sd.quota.creature}  special ${sd.quota.special}  quiet ${sd.quota.quiet}  (entrance excluded)`
  );
  L.push(
    `rewards -> general ${sd.rewardBudget.general}  keys ${sd.rewardBudget.keys}  reserved ${sd.rewardBudget.reserved}`
  );
  L.push(
    `pot ${sd.pot.total}cp -> placed ${sd.pot.placed}  allowance ${sd.pot.allowance}   challenges ${sd.challenges.length}`
  );

  const counts: Record<string, number> = {};
  for (const r of sd.rooms) counts[r.headline] = (counts[r.headline] ?? 0) + 1;
  L.push(
    `final headline mix -> ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join("  ")}`
  );
  const withReward = sd.rooms.filter((r) => r.rewards.length).length;
  const keys = sd.rooms.reduce((n, r) => n + r.rewards.filter((w) => w.kind === "key").length, 0);
  L.push(
    `rooms with a reward: ${withReward}/${sd.rooms.length}  (placed keys: ${keys})`
  );
  L.push("");

  const sorted = [...sd.rooms].sort((a, b) => a.depth - b.depth || a.index - b.index);
  for (const r of sorted) {
    const tags = [
      r.role !== "normal" ? r.role.toUpperCase() : null,
      r.isDeadEnd ? "dead-end" : null,
      r.claimed ? "claimed" : null,
    ].filter(Boolean);
    L.push(
      `[${r.index}] ${rr(r.identity)}  --  ${r.headline}${
        r.stacked ? ` + ${r.stacked}` : ""
      }  (depth ${r.depth}, deg ${r.degree}, danger ${r.danger.toFixed(2)})${
        tags.length ? `  {${tags.join(", ")}}` : ""
      }`
    );

    if (r.entranceFeature) L.push(`      entrance: ${rr(r.entranceFeature)}`);
    if (r.detail) L.push(`      detail: ${rr(r.detail)}`);

    if (r.goalDirective) {
      L.push(
        `      GOAL DIRECTIVE: embody reward "${r.goalDirective.reward}" / ` +
          `mission "${r.goalDirective.mission}" -- type chosen by the composition pass`
      );
    }

    for (const id of r.occupants) {
      const m = mobById.get(id)!;
      {
        const extra = m.monster
          ? `${m.monster.complexity}/${m.monster.silhouette}`
          : m.npc
          ? m.npc.name
          : "";
        L.push(
          `      creature: ${m.name} [${m.disposition}] activity: ${rr(
            m.activity
          )}${extra ? `  (${extra})` : ""}`
        );
      }
    }

    if (r.special) {
      if (r.special.kind === "hazard") {
        L.push(
          r.special.hazard
            ? `      hazard: ${rr(r.special.hazard)}`
            : `      trap: ${rr(r.special.trapTrigger)} -> ${rr(r.special.trapEffect)}`
        );
      } else {
        L.push(
          `      obstacle: ${rr(r.special.subject)} / ${rr(r.special.behaviour)} (${r.special.behaviourSource})`
        );
      }
    }

    if (r.clue) {
      const tgt = r.clue.targetRoomId
        ? sd.rooms.find((x) => x.roomId === r.clue!.targetRoomId)
        : undefined;
      L.push(
        `      clue: ${rr(r.clue.keyword)} -> about ${r.clue.about}${
          tgt ? ` (room ${tgt.index})` : ""
        }`
      );
    }

    for (const w of r.rewards) {
      const held =
        w.holder.kind === "mobile" ? ` [carried by ${mobById.get(w.holder.id)?.name}]` : "";
      const flag = w.guaranteed ? ", guaranteed" : "";
      const what =
        w.kind === "equipment"
          ? `${w.row}: ${w.draws.map((d) => (d.kind === "catalog" ? d.key : d.spell)).join(", ")}`
          : w.kind === "treasure"
          ? `${w.row}: ${rr(w.content)} (${w.value}cp)`
          : `answers ${rr(w.answers)} (${w.value}cp)`;
      L.push(`      ${w.kind.toUpperCase()} (${w.id}${flag}): ${what}${held}`);
    }
  }

  L.push("");
  const gatedN = sd.connectors.filter((c) => c.gated).length;
  L.push(
    `CONNECTORS gated: ${gatedN}/${sd.connectors.length} ` +
      `(${((gatedN / sd.connectors.length) * 100).toFixed(0)}%)  ` +
      `cohesion ${sd.cohesion.toFixed(2)}`
  );
  for (const c of sd.connectors) {
    if (!c.gated) continue;
    const a = sd.rooms.find((r) => r.roomId === c.a)!;
    const b = sd.rooms.find((r) => r.roomId === c.b)!;
    L.push(`  ${a.index} <-> ${b.index}  [gated]`);
  }

  L.push("");
  L.push(`MOBILE ENTITIES (${sd.mobiles.length}):`);
  for (const m of sd.mobiles) {
    const room = sd.rooms.find((r) => r.roomId === m.locationRoomId)!;
    L.push(
      `  ${m.id}  ${m.name}  @room ${room.index}${
        m.disposition ? `  [${m.disposition}]` : ""
      }${m.minion ? `  <${m.minion}>` : ""}`
    );
  }

  return L.join("\n");
}
