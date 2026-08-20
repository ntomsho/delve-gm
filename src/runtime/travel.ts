/**
 * WALKING ACROSS THE DUNGEON
 * =========================
 *
 * "Go back to the Laboratory" is one thing the player says and three rooms of
 * walking. This works out which rooms those are, and — more usefully — where
 * the walk actually ends, which is often not where they meant.
 *
 * WHY THIS IS NOT THE REFEREE'S JOB. It is a graph question with one right
 * answer, and the referee is handed only the room it is standing in: it can see
 * one step, has to infer the rest from turn records, and was observed inferring
 * it wrong three times in a row. Nothing about routing needs judgement, so
 * nothing about it should be guessed.
 *
 * WHAT STOPS A WALK. Crossing a room is not free. A creature standing in it, a
 * fire spreading through it, a trap in it — sprung or waiting — a way that is
 * barred: any of these ends the journey there, and the player is left facing the
 * thing that stopped them rather than teleported past it. That is the whole
 * point of letting them name a far room: it is a convenience for empty
 * corridors, not a way to skip what is standing in them.
 *
 * The DESTINATION is never checked. Arriving is what they asked for, and
 * whatever is waiting there is the arrival pass's business.
 *
 * WHERE THEY MAY GO. Through rooms they have been in — a route is retracing
 * steps, and you cannot retrace a step you never took. The far end may be
 * somewhere new, because walking into the next room is the ordinary case and
 * that room is new by definition.
 *
 * ALL OF THAT IS ABOUT THE PLAYER. Creatures cross the same graph under none of
 * those rules — see `roomDistances` and `stepToward` at the foot of the file,
 * which are the same argument made for a thing that lives here.
 */

import { farSide, isSurfaceExit, touches } from "../engine/index.ts";
import type { IHazard, IRoomConnector } from "../engine/index.ts";
import type { World } from "./diffs/types.ts";

/** One room crossed, and the way taken into it. */
export interface Leg {
  connectorId: string;
  roomId: string;
}

export interface Route {
  /** Rooms entered, in order. Empty when they end up where they started. */
  legs: Leg[];
  /** Where they actually are when the walk ends. */
  endsAt: string;
  /**
   * Why it ended early, phrased for the referee. Absent when they arrived.
   * Present means the player is standing in front of something.
   */
  stoppedBy?: string;
  /** No route at all — nothing to walk, so nothing to apply. */
  unreachable?: string;
}

/**
 * A way through that can be part of a route.
 *
 * Undiscovered ways are not routes. Neither is the way OUT of the dungeon: it
 * joins one room to nothing, so it is a terminus rather than an edge, and a walk
 * that took it would be leaving rather than travelling. Departure is its own
 * thing — see `Stage` / `departed` — and it never happens by accident on the way
 * to somewhere else.
 */
const walkable = (c: IRoomConnector) => c.isHidden !== true && !isSurfaceExit(c);

/**
 * Fewest rooms crossed, refusing anything `clear` turns down.
 *
 * Run twice by `routeTo`: once demanding a route with nothing in the way at all,
 * and once taking whatever exists. The obstacle checks are the same ones the
 * walk itself applies, so the two passes cannot disagree about what counts.
 *
 * Only rooms the player has stood in are expanded THROUGH; the goal itself may
 * be new, and is never tested — arriving is what they asked for. Deterministic:
 * connectors are visited in world order.
 */
function shortestPath(world: World, from: string, to: string, clear: boolean): Leg[] | undefined {
  if (from === to) return [];

  const passable = (roomId: string) => {
    const room = world.entities.rooms.find((r) => r.id === roomId);
    if (room?.composed === undefined) return false; // never stood in it
    return !clear || obstacleIn(world, roomId) === undefined;
  };

  const cameBy = new Map<string, Leg>();
  const seen = new Set([from]);
  let frontier = [from];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const here of frontier) {
      for (const c of world.entities.connectors) {
        if (!touches(c, here) || !walkable(c)) continue;
        if (clear && obstacleOn(world, c) !== undefined) continue;

        // Never null: `walkable` has already refused the surface.
        const there = farSide(c, here)!;
        if (seen.has(there)) continue;
        seen.add(there);
        cameBy.set(there, { connectorId: c.id, roomId: there });

        if (there === to) {
          const legs: Leg[] = [];
          for (let at = to; at !== from; at = stepBefore(world, cameBy, at, from)) {
            legs.unshift(cameBy.get(at)!);
          }
          return legs;
        }
        // Somewhere they have never been is a place to arrive, not to pass
        // through: they cannot retrace a step they never took.
        if (passable(there)) next.push(there);
      }
    }
    frontier = next;
  }
  return undefined;
}

/** Walk the parent chain back one link. */
function stepBefore(world: World, cameBy: Map<string, Leg>, at: string, from: string): string {
  const leg = cameBy.get(at);
  if (!leg) return from;
  const c = world.entities.connectors.find((x) => x.id === leg.connectorId)!;
  return farSide(c, at)!;
}

/**
 * A hazard that a walk cannot simply pass through, and how to say so.
 *
 * TWO STATES STOP THEM, for opposite reasons. One going off is a wall — fire in
 * the room, the floor coming down. One that has NOT gone off is worse: walking
 * through is exactly what sets it off, so a route that carried the player over
 * it would spring it in silence, three rooms from where they were looking. The
 * walk ends in front of it instead and the turn resolves it properly.
 *
 * What does NOT stop them is a hazard already spent — sprung, and no longer
 * doing anything. That is scenery, and a collapsed pit is a hole you step round.
 *
 * The player does not read this. It goes to the referee, and only about a room
 * they are now standing in, which is a room the arrival pass is about to show
 * them anyway.
 */
function hazardStop(h: IHazard | undefined): string | undefined {
  if (!h) return undefined;
  const name = h.name || "a hazard";
  if (h.active === true) return `${name} is going off`;
  if (h.sprung !== true) return `${name} lies between them and the far side, unsprung`;
  return undefined;
}

const hazardOf = (world: World, id: string | undefined) =>
  id ? world.entities.hazards.find((h) => h.id === id) : undefined;

/**
 * What is in this room that a person could not simply walk past.
 *
 * A creature is anything still standing there — the applier removes the slain,
 * so presence is the whole test and the referee decides what it does about it.
 * Effects are fires and gas, which are exactly walls.
 */
function obstacleIn(world: World, roomId: string): string | undefined {
  const e = world.entities;

  const creature = e.creatures.find((c) => c.roomId === roomId);
  if (creature) return `${creature.name || "a creature"} is in the way`;

  const room = e.rooms.find((r) => r.id === roomId);
  const hazard = hazardStop(hazardOf(world, room?.hazardId));
  if (hazard) return hazard;

  const effect = e.effects.find((x) => x.roomIds.includes(roomId));
  if (effect) return `${effect.name || "something"} fills it`;

  return undefined;
}

/** The same question, asked of a way through rather than a room. */
function obstacleOn(world: World, c: IRoomConnector): string | undefined {
  if (c.conditional !== undefined) return `${c.name || "the way"} is blocked: ${c.conditional}`;
  const hazard = hazardStop(hazardOf(world, c.hazardId));
  return hazard ? `${hazard}, in ${c.name || "the way through"}` : undefined;
}

/**
 * Where the player gets to, trying to reach `to` from where they stand.
 *
 * Prefers a route that is open the whole way. Only when there is none does it
 * consider blocked ways — and then only to walk them up to the barrier, so the
 * player ends the turn looking at the thing that stopped them rather than being
 * told the room does not exist.
 */
export function routeTo(world: World, to: string): Route {
  const from = world.currentRoomId;
  if (from === to) return { legs: [], endsAt: from };

  // A way with something in it is not a way, if there is another. Only when
  // every route has something in it does the second pass run — and then the
  // walk below stops at whatever that something is, so the player ends the turn
  // looking at it rather than being told the room cannot be reached.
  const path = shortestPath(world, from, to, true) ?? shortestPath(world, from, to, false);

  if (!path) {
    return {
      legs: [],
      endsAt: from,
      unreachable:
        `no way leads from the room the player is standing in to ${JSON.stringify(to)} ` +
        `through rooms they have been in. They can only walk where they have already been, ` +
        `plus one step into somewhere new.`,
    };
  }

  const legs: Leg[] = [];
  let at = from;

  for (const leg of path) {
    const c = world.entities.connectors.find((x) => x.id === leg.connectorId)!;
    const shut = obstacleOn(world, c);
    if (shut) return { legs, endsAt: at, stoppedBy: shut };

    legs.push(leg);
    at = leg.roomId;
    if (at === to) break;

    // A room on the way has to be crossed, and something in it is something
    // they have to deal with. The destination is exempt — see the header.
    const held = obstacleIn(world, at);
    if (held) {
      return {
        legs,
        endsAt: at,
        stoppedBy: `they got as far as ${roomName(world, at)}, where ${held}`,
      };
    }
  }

  return { legs, endsAt: at };
}

function roomName(world: World, id: string): string {
  return world.entities.rooms.find((r) => r.id === id)?.name || id;
}

// ---------------------------------------------------------------------------
// THE OTHER GRAPH: WHAT A CREATURE KNOWS
// ---------------------------------------------------------------------------

/**
 * HOW FAR EVERY ROOM IS FROM `from`, IN ROOMS CROSSED.
 *
 * The same graph `shortestPath` walks and deliberately NOT the same rule. That
 * one expands only through rooms the player has stood in, because a route is
 * retracing steps. This one expands through everything, because the thing being
 * routed is not the player: a creature knows its own dungeon, and the player's
 * map is not its map.
 *
 * That is why it is a second function rather than a flag on the first. A
 * parameter would make "where may the player walk" configurable, and it is not
 * — it is the one restriction that keeps a walk honest.
 *
 * Feeds two things: the "N rooms away" on every census line, and `stepToward`.
 * `from` itself is in the map at 0; a room with no route to it is absent, which
 * reads as `undefined` and is the answer.
 *
 * OBSTACLES ARE NOT CONSULTED. `routeTo` runs its clear-then-blocked two-pass
 * because the player's walk stops in front of whatever is in the way and the
 * turn resolves it. A creature crossing its own home is not that, and what it
 * does about a fire in the next room is the referee's to say.
 */
export function roomDistances(
  // NARROWER THAN `World` on purpose. This walks the connector graph and reads
  // nothing else, and `censusView` hands it a `RunState` — which satisfies a
  // whole `World` only by accident, and stopped doing so the moment `World`
  // grew a field about challenges that a BFS has no opinion about.
  world: { entities: Pick<World["entities"], "connectors"> },
  from: string
): Map<string, number> {
  const out = new Map<string, number>([[from, 0]]);
  let frontier = [from];
  let depth = 0;

  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const here of frontier) {
      for (const c of world.entities.connectors) {
        if (!touches(c, here) || !walkable(c)) continue;
        // Never null: `walkable` has already refused the surface.
        const there = farSide(c, here)!;
        if (out.has(there)) continue;
        out.set(there, depth);
        next.push(there);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * ONE ROOM ALONG THE WAY FROM `from` TO `to` — which is all a creature moves in
 * a turn.
 *
 * Read off distances measured from the DESTINATION, so the next room is
 * whichever neighbour stands one closer to it. That is a shortest path by
 * construction and needs no path to be built or reversed.
 *
 * Deterministic: connectors are visited in world order, so two neighbours tied
 * at the same distance always resolve the same way — the same guarantee
 * `shortestPath` makes, for the same reason.
 *
 * `undefined` means no route at all, and the applier turns that into a refusal
 * rather than a creature that quietly stays put. Returns `from` itself when it
 * is already there, which is how arrival is recognised.
 */
export function stepToward(world: World, from: string, to: string): string | undefined {
  if (from === to) return from;

  const away = roomDistances(world, to);
  const here = away.get(from);
  if (here === undefined) return undefined;

  for (const c of world.entities.connectors) {
    if (!touches(c, from) || !walkable(c)) continue;
    const there = farSide(c, from)!;
    if (away.get(there) === here - 1) return there;
  }
  return undefined;
}
