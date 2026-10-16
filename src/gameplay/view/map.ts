/**
 * THE MAP: the drawn layout with this run's fog, position and fixtures on it.
 */

import { type AnyEntity, isSurfaceExit, resolveBase } from "../../shared/world/entities.ts";
import { positionPhrase } from "../../shared/world/placement.ts";
import {
  pointLayout,
  type Layout,
  type LayoutConnector,
  type LayoutFixture,
  type LayoutRoom,
} from "../../generation/floorplan/map-layout.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import type { RunState } from "../state/store.ts";
import { shownRoom } from "./room.ts";

// ===========================================================================
// THE MAP
// ===========================================================================

export interface MapRoomView extends LayoutRoom {
  /** the player has been here; unvisited rooms are drawn as nothing */
  known: boolean;
  current: boolean;
  /** only once known — an unvisited room has no name to show */
  name?: string;
  /**
   * What the player read on arrival, for the hover. Withheld under exactly the
   * same test as `name`: a description of a room they have not entered is the
   * one thing fog exists to withhold.
   */
  composed?: string;
  /**
   * A REGION KEY PUT THIS ROOM ON THE MAP WITHOUT THE PLAYER EVER STANDING IN
   * IT. Drawn, named, and describable — from `base`, which is what the mapmaker
   * recorded, rather than from `composed`, which is what somebody saw.
   *
   * DISPLAY ONLY, and `known` stays FALSE. `travel.ts` is untouched and
   * `shortestPath` keeps refusing these: a player does not get to walk through
   * a room they have never entered because they read about it. And fog stays
   * exactly one thing — `composed === undefined`, never encountered — which is
   * what `mapView` and `needUpdate` both rest on.
   */
  mapped: boolean;
}

export interface MapConnectorView extends LayoutConnector {
  /** at least one end has been visited, so the player knows this way exists */
  known: boolean;
  /** it leads somewhere the player has not been — draw it as a stub, not a link */
  toUnknown: boolean;
  blocked: boolean;
  requirement?: string;
  /** out of the dungeon entirely — drawn and confirmed unlike any other way */
  surface: boolean;
  /** what it is, for the hover. A connector is named for what it is, never where it goes. */
  name: string;
  composed?: string;
}

/**
 * A thing standing in a room, as the player is entitled to see it.
 *
 * THE RULE: an entity appears on the map, and changes on the map, only when its
 * `composed` changes. Nothing else about it reaches the drawing.
 *
 * That single test does every job at once, because `composed` is written in
 * exactly one circumstance — the player is looking at the thing. So:
 *
 *   never encountered   `composed === undefined`, and nothing is drawn
 *   concealed           room entry never composes a hidden thing, so likewise
 *   two rooms away       `setState` marks `needUpdate` and LEAVES `composed`;
 *                        the marker keeps saying where it was last seen
 *
 * The map is therefore a record of what the player observed, corrected only
 * when they observe again — which is the same precedence `entities.ts`
 * sets for prose. What they were told binds.
 */
/**
 * The marks a thing standing in a room is drawn with, on the map and on the
 * room's illustration, in the order they are handed out. See `MapFixtureView.shape`.
 */
export const FIXTURE_SHAPES = ["circle", "diamond", "triangle", "square", "star", "hexagon"] as const;
export type FixtureShape = (typeof FIXTURE_SHAPES)[number];

export interface MapFixtureView extends LayoutFixture {
  /**
   * Its mark, so the map and the illustration can be matched at a glance.
   *
   * Handed out by its order among everything placed in its room, as the
   * dungeon was generated: the first gets a circle, the second a diamond, and
   * so on round `FIXTURE_SHAPES`. Counted over the CONCEALED ones too, so
   * finding a secret never changes the mark of anything already on the map.
   * No room in the measured dungeons placed more than four, so two marks in
   * one room do not repeat in practice; past six they would.
   */
  shape: FixtureShape;
  /** the entity's name, for the hover */
  name: string;
  /** what the player read about it. Never undefined: it is why this is drawn. */
  composed: string;
  /**
   * Where it stands, as prose — "along the north wall". The same fact the
   * game master is given, said the same way, so the hover and the narration match
   * word for word rather than merely agreeing.
   */
  position?: string;
}

export interface MapViewOptions {
  /** draw concealed ways too. Debug and the jump-to-room tool only. */
  includeHidden?: boolean;
}

export interface MapView {
  bounds: Layout["bounds"];
  rooms: MapRoomView[];
  connectors: MapConnectorView[];
  fixtures: MapFixtureView[];
}

/**
 * The layout with fog of war and gating laid over it.
 *
 * Fog is `composed === undefined` — never encountered. That is why `needUpdate`
 * exists rather than clearing `composed`: a room whose state moved while the
 * player was elsewhere must stay drawn on the map, not blink out of existence.
 *
 * An exit from a known room into an unknown one is an INFERRED exit — the
 * player knows a way leads off there without knowing what is on the other side
 * — so it is marked rather than dropped, and the room it points at stays dark.
 *
 * A CONCEALED way is dropped entirely. Drawing it, even as a stub, would tell
 * the player a secret door is there, which is the one thing a secret door must
 * not do. It reappears the moment `isHidden` goes false.
 *
 * The same is true of everything standing in a room — see `MapFixtureView`.
 * `Layout.fixtures` deliberately carries every placed entity, concealed ones
 * included, because that module knows only geometry; this is the only place the
 * filter exists, and it is the one filter in the file that cannot be walked
 * back if it is wrong.
 */
export function mapView(
  run: RunState,
  dungeon: GeneratedDungeon,
  layout?: Layout,
  opts: MapViewOptions = {}
): MapView {
  const base = layout ?? pointLayout(dungeon.graph);
  const rooms = new Map(run.entities.rooms.map((r) => [r.id, r]));
  const connectors = new Map(run.entities.connectors.map((c) => [c.id, c]));
  // Rooms are never hidden, so a written description means the player has
  // stood here — stale or not.
  const known = (id: string) => rooms.get(id)?.composed !== undefined;
  // What a region key revealed. Kept apart from `known` throughout — see
  // `MapRoomView.mapped` — so that nothing which asks "has the player been
  // here" gets a different answer because they found a map.
  const mapped = new Set(run.challengeState?.mapped ?? []);
  const shown = (id: string) => known(id) || mapped.has(id);

  const view = (c: LayoutConnector): MapConnectorView => {
    const entity = connectors.get(c.id);
    const fromKnown = known(c.from);
    // A way OUT is known exactly when the room it leaves from is, and it never
    // leads into the dark — the player walked in through it. Answering the
    // far-side question with `true` instead would draw the exit stub hanging in
    // blank paper before the entrance room itself has been described.
    const toKnown = c.to === null ? fromKnown : known(c.to);
    // A mapped room's ways out were on the chart with it. Still not `known` in
    // the sense that matters to travel — that is the room's own flag — but the
    // line is drawn, because a map that showed rooms and no corridors between
    // them would be a worse lie than showing nothing.
    const onChart = mapped.has(c.from) || (c.to !== null && mapped.has(c.to));
    return {
      ...c,
      known: fromKnown || toKnown || onChart,
      toUnknown: fromKnown !== toKnown,
      blocked: entity?.conditional !== undefined,
      requirement: entity?.conditional,
      surface: c.to === null,
      name: entity?.name ?? "",
      composed: entity?.composed,
    };
  };

  // The way out is not on `graph.edges` — it is minted by the entities pass
  // with a null far end — so the layout can place it but cannot name it. This
  // is where the geometry and the entity meet.
  const surface = base.surface;
  const exit = surface && run.entities.connectors.find(isSurfaceExit);

  // --- what is standing in the rooms ---------------------------------------
  //
  // Four tests, and every one of them is load-bearing. `includeHidden` is
  // honoured for the same debugging reason connectors honour it, and for no
  // other: it is never true on anything the player sees.
  const placed = new Map<string, AnyEntity>();
  for (const f of run.entities.features) placed.set(f.id, f);
  for (const i of run.entities.items) placed.set(i.id, i);

  // Every placed thing's mark, by its order in its room — before any filtering.
  const shapes = new Map<string, FixtureShape>();
  const perRoom = new Map<string, number>();
  for (const f of base.fixtures) {
    const n = perRoom.get(f.roomId) ?? 0;
    perRoom.set(f.roomId, n + 1);
    shapes.set(f.id, FIXTURE_SHAPES[n % FIXTURE_SHAPES.length]);
  }

  const fixtures: MapFixtureView[] = [];
  for (const f of base.fixtures) {
    const entity = placed.get(f.id);
    if (!entity) continue;
    if (!known(f.roomId)) continue;
    if (opts.includeHidden !== true && entity.isHidden === true) continue;
    // THE RULE. Undrawn until the player has been shown it, and thereafter
    // showing what they were shown.
    if (entity.composed === undefined) continue;
    // An item that has left the room it was placed in is no longer lying there.
    // Every path that moves one today happens with the player watching — they
    // picked it up — so dropping the marker is what they saw. A thief carrying
    // something off while they are elsewhere wants a "last seen here" snapshot
    // instead, and that arrives with creature markers, which need it too.
    if (entity.type === "Item" && entity.parentId !== f.roomId) continue;
    const place = (entity as { place?: { position: string } }).place;
    fixtures.push({
      ...f,
      shape: shapes.get(f.id)!,
      name: entity.name,
      composed: entity.composed,
      position: place ? positionPhrase(place.position) : undefined,
    });
  }

  return {
    bounds: base.bounds,
    rooms: base.rooms.map((r) => ({
      ...r,
      known: known(r.id),
      mapped: !known(r.id) && mapped.has(r.id),
      // The marker moves with the narration, not with the commit — otherwise it
      // points into an unlit room for as long as the arrival takes to write.
      current: r.id === (shownRoom(run) ?? run.currentRoomId),
      name: shown(r.id) ? rooms.get(r.id)?.name : undefined,
      // WHAT THE MAP RECORDED, NOT WHAT IS THERE NOW. A visited room shows what
      // the player read; a mapped one shows the room's standing description,
      // because a chart cannot know that something has moved in since.
      composed: known(r.id)
        ? rooms.get(r.id)?.composed
        : mapped.has(r.id)
          ? resolveBase(rooms.get(r.id)!, dungeon.entities.registry)
          : undefined,
    })),
    connectors: [
      ...base.connectors,
      ...(surface && exit
        ? [
            {
              id: exit.id,
              from: surface.roomId,
              to: null,
              interChunk: false,
              door: surface.door,
              path: { kind: "line" as const, from: surface.door.at, to: surface.door.through },
            },
          ]
        : []),
    ]
      .filter((c) => opts.includeHidden === true || connectors.get(c.id)?.isHidden !== true)
      .map(view),
    fixtures,
  };
}
