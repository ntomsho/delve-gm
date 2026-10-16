/**
 * THE STOCKING STEPS that are pure functions of the graph: depth and structure,
 * the headline budget and where it goes, danger, and what each clue points at.
 * `stock.ts` runs them in order.
 */

import { Rng } from "../../../shared/utils/rng.ts";
import type { Dungeon, Edge, Room } from "../../floorplan/graph.ts";
import type { MobileEntity, RoomStock, StockedConnector } from "../types.ts";

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

export interface Structure {
  entrance: number;
  depth: number[];
  maxDepth: number;
  deadEnds: Set<number>;
  goal: number;
  secret: number | null;
  adj: number[][];
}

export function structuralPrePass(d: Dungeon, rng: Rng): Structure {
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
export function gateConnectors(
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

export function computeQuota(
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

export function placeHeadlines(
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

export function scoreDanger(room: RoomStock, mobiles: MobileEntity[], maxDepth: number): number {
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

export function resolveClueTargets(
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
