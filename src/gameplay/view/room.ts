/**
 * VIEW MODELS: THE CURRENT ROOM
 * =============================
 *
 * Everything the interface renders, derived here rather than in JSX. Components
 * that compute their own view state put logic somewhere it cannot be tested and
 * duplicate it the moment a second component needs the same answer.
 *
 * Framework-free on purpose: these are plain functions over state, so the turn
 * machine can use the same room view for prompt assembly that the screen uses
 * for display. One place where "what is in this room" is decided means the
 * player and the game master cannot end up looking at different rooms.
 *
 * The other view models sit beside this one: `entities.ts` (one entity, as
 * either reader sees it), `census.ts` (every other creature in the dungeon),
 * `character.ts` (the character panel) and `map.ts`.
 */

import {
  needsComposition as entityNeedsComposition,
  resolveBase,
  type AnyEntity,
  type IRoomConnector,
} from "../../shared/world/entities.ts";
import { farSide, isSurfaceExit, touches } from "../../shared/world/entities.ts";
import { describeGeometry, exitPhrase, siteRooms } from "../../generation/floorplan/geometry.ts";
import type { RoomGeometry } from "../../generation/floorplan/geometry.ts";
import { directContents } from "../mechanics/occupancy.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import type { RunState } from "../state/store.ts";
import { toView, type EntityView } from "./entities.ts";

// ===========================================================================
// THE CURRENT ROOM
// ===========================================================================

export interface ExitView {
  connectorId: string;
  /** the room on the other side, or null for a way out of the dungeon */
  toRoomId: string | null;
  /**
   * Out of the dungeon entirely. Stepping through it ends the run, so it is
   * marked wherever it is shown rather than reading as one more door.
   */
  surface: boolean;
  /** its name — for `exitLabel`, which decides whether it may be shown */
  toRoomName: string;
  /**
   * The connector's own name, which says what it is and never where it goes.
   * Read `exitLabel` instead unless you specifically want the bare form.
   */
  name: string;
  /** what it physically is */
  form?: string;
  /** something stands in the way */
  blocked: boolean;
  /** what stands in the way, as it looks from this side */
  requirement?: string;
  /** the player has been through to the other side */
  toKnown: boolean;
  /** the way they walked in by — first in the list, and set apart from it */
  cameFrom: boolean;
  /**
   * The player has not found it yet.
   *
   * Only ever true under `includeHidden`, since without it a concealed way is
   * filtered out of this list entirely — so on anything the player looks at
   * this is false throughout, and it exists for the one reader that is shown
   * concealed things and must not describe them.
   */
  isHidden: boolean;
  /**
   * Which wall of THIS room it cuts, and where along it — "the east wall,
   * toward the north end". The same phrase the content pass was given when it
   * wrote the room, so the game master and the prose already on the page agree.
   */
  wall?: string;
}

export interface RoomView {
  id: string;
  name: string;
  /** the paragraph the player reads on arrival */
  composed?: string;
  state?: string;
  base?: string;
  needUpdate: boolean;
  /** everything in the room, each carrying what it holds */
  contents: EntityView[];
  exits: ExitView[];
  /** theme, history, who lives here, the goal — so nothing contradicts it */
  fiction: string;
  /**
   * The room as it was DRAWN — size, proportions, outline, ways out by wall.
   * Absent for a dungeon with no block plan.
   *
   * The same sentence `buildContentPassPayload` was given, from the same
   * function, on purpose. The prose on the page was written to it, so the
   * game master reading a different description of the same room is the one way
   * this could go wrong — and rendering it twice from one derivation is how
   * that is made impossible rather than merely unlikely.
   */
  geometry?: string;
}

export interface RoomViewOptions {
  /**
   * Include what the player is not aware of. FALSE for anything the player
   * sees — a concealed thing listed in the panel is a concealed thing no
   * longer. TRUE for prompt assembly, where the game master has to know what is
   * there to be found.
   *
   * Concealment is transitive: a coin in a false-backed drawer is not visible
   * because the drawer is not, even though nobody marked the coin.
   */
  includeHidden?: boolean;
  /**
   * Include each creature's defenses, attack bonus, damage die and morale.
   * TRUE for prompt assembly, where the game master sets difficulties off them.
   * FALSE — always — for anything the player sees. See CombatView.
   */
  includeStats?: boolean;
}

export function roomView(
  run: RunState,
  dungeon: GeneratedDungeon,
  roomId: string = run.currentRoomId,
  opts: RoomViewOptions = {}
): RoomView | undefined {
  const e = run.entities;
  const room = e.rooms.find((r) => r.id === roomId);
  if (!room) return undefined;

  const registry = e.registry;
  const showAll = opts.includeHidden === true;
  const stats = opts.includeStats === true;
  const visible = (x: AnyEntity) => showAll || x.isHidden !== true;

  const contents = directContents(roomId, e)
    .filter(visible)
    .map((x) => toView(x, e, registry, stats))
    // A thing inside a concealed thing is concealed too, whoever marked it.
    .map((v) => (showAll ? v : { ...v, contains: v.contains.filter((c) => !c.isHidden) }));

  // The drawing, read back. Derived rather than persisted — see the note on
  // `RoomView.geometry` for why it comes from the same function the content
  // pass used rather than from a copy of what that function once said.
  const drawn = geometryOf(dungeon, roomId);

  // CONCEALED WAYS ARE NOT COUNTED IN THE SENTENCE. The geometry line says how
  // many ways out there are and which walls they are in, and it is read by the
  // game master and rendered beside prose the player will read. A secret door
  // included in that count is a secret door described. It comes back the moment
  // `isHidden` goes false, which is exactly when the player has found it.
  const concealed = new Set(
    e.connectors.filter((c) => touches(c, roomId) && c.isHidden === true).map((c) => c.id)
  );

  const exits: ExitView[] = e.connectors
    .filter((c) => touches(c, roomId))
    .filter(visible)
    .map((c: IRoomConnector) => {
      const toRoomId = farSide(c, roomId);
      const to = toRoomId === null ? undefined : e.rooms.find((r) => r.id === toRoomId);
      return {
        connectorId: c.id,
        toRoomId,
        surface: isSurfaceExit(c),
        toRoomName: to?.name ?? "",
        name: c.name,
        form: resolveBase(c, registry),
        blocked: c.conditional !== undefined,
        requirement: c.conditional,
        // The surface is somewhere they have certainly been — they walked in
        // through it — and it is the one destination that needs no describing.
        toKnown: isSurfaceExit(c) || to?.composed !== undefined,
        // Only in the room they are actually standing in. Asked about anywhere
        // else, the way they last came in by is a fact about a different room.
        cameFrom: roomId === run.currentRoomId && c.id === run.arrivedVia,
        // Only reachable with `includeHidden`, which is prompt assembly — where
        // the game master has to know a secret way is there without being free to
        // mention it. Rendered as the same NOT YET FOUND mark a concealed thing
        // standing in the room carries, because it means the same thing and
        // reading it twice two ways is how one of them gets missed.
        isHidden: c.isHidden === true,
        // The surface exit is on no graph edge, so the geometry knows it by its
        // missing far end rather than by an id — the same join `mapView` makes.
        wall: drawn?.walls.get(isSurfaceExit(c) ? null : c.id),
      };
    })
    .sort(byUsefulness);

  return {
    id: room.id,
    name: room.name,
    composed: room.composed,
    state: room.state,
    base: resolveBase(room, registry),
    needUpdate: room.needUpdate === true,
    contents,
    exits,
    fiction: dungeon.dungeonContext,
    geometry: drawn && describeGeometry(drawn.geometry, { omit: concealed }),
  };
}

/**
 * The GEOMETRY is memoised, not the sentence it renders to.
 *
 * The drawing is write-once and the walls with it, but which ways out are
 * concealed is run state — a secret door found on turn nine has to start being
 * counted — so the sentence is rendered per call against the concealed set of
 * the moment. `describeGeometry` is a map over four or five exits; the siting
 * pass it is memoising is the expensive half.
 */
const SITED = new WeakMap<GeneratedDungeon, Map<string, SitedRoom>>();

/**
 * One room's drawing, as the sentence and the per-connector walls.
 *
 * MEMOISED ON THE DUNGEON, because `roomView` runs on every render and on every
 * prompt assembly while `siteRooms` covers all thirty rooms. It is pure and the
 * inputs are write-once — `blockplan` and `graph` are set at generation and
 * never written again — so a WeakMap keyed on the dungeon is a cache that
 * cannot go stale and cannot leak.
 */

interface SitedRoom {
  geometry: RoomGeometry;
  walls: Map<string | null, string>;
}

function geometryOf(dungeon: GeneratedDungeon, roomId: string): SitedRoom | undefined {
  if (!dungeon.blockplan) return undefined;
  let byRoom = SITED.get(dungeon);
  if (!byRoom) {
    byRoom = new Map();
    const corridors = new Set(
      dungeon.stocked.rooms.filter((r) => r.isCorridor).map((r) => r.index)
    );
    const site = siteRooms(dungeon.blockplan, dungeon.graph, {
      isCorridor: (i) => corridors.has(i),
    });
    for (const [i, g] of site.geometry.entries()) {
      byRoom.set(dungeon.graph.rooms[i].entityId, {
        geometry: g,
        walls: new Map(g.exits.map((x) => [x.connectorId, exitPhrase(x)])),
      });
    }
    SITED.set(dungeon, byRoom);
  }
  return byRoom.get(roomId);
}

/**
 * THE ORDER THE WAYS OUT ARE READ IN.
 *
 * Three bands, and the reasoning is the same in each: put what the player is
 * most likely to be looking for where they will find it without reading.
 *
 *   1. the way they came in     — where they are, and the way back
 *   2. ways to rooms they know  — the ones they can plan a route through
 *   3. everything unexplored    — the decisions, at the bottom
 *
 * Stable within a band: `sort` on an array built in world order leaves ties in
 * world order, so a room's exits do not shuffle between turns. Used by the panel
 * AND by `renderRoom`, because the game master offering a way out in a different
 * order than the player is reading them is how "the second door" stops meaning
 * anything.
 */
function byUsefulness(a: ExitView, b: ExitView): number {
  const band = (e: ExitView) => (e.cameFrom ? 0 : e.toKnown ? 1 : 2);
  return band(a) - band(b);
}

/**
 * A way out, as it should be read from the side you are standing on.
 *
 * Connectors are named for what they are and never for where they go — one
 * entity, two ends, and a name that points is wrong from one of them. The
 * destination is joined on here instead, correct by construction whichever end
 * is being read.
 *
 * Withheld until the player has been through, because a room's name is a thing
 * they learn by arriving. That withholding is why this is the one place the
 * label is built: the panel and the game master's prompt must agree about what the
 * player is able to name, or the game master will offer them a room they cannot
 * ask for.
 */
export function exitLabel(e: ExitView): string {
  if (e.surface) return `${e.name} — out of the dungeon`;
  if (!e.toKnown || e.toRoomName === "") return e.name;
  return `${e.name} to ${theRoom(e.toRoomName)}`;
}

/**
 * A room name with an article in front, unless it brought its own.
 *
 * Names are written by the content pass and arrive both ways — "Kennel" and
 * "The Long Gallery" out of the same run. Anything building a sentence around
 * one goes through here rather than gambling on "the The Long Gallery".
 */
export function theRoom(name: string): string {
  return /^(the|a|an)\s/i.test(name) ? name : `the ${name}`;
}

/**
 * The room the interface should be showing, which is not always the room the
 * player is standing in.
 *
 * A move applies before the arrival is written, so between the two the player is
 * somewhere they have been told nothing about. The panel and the map marker stay
 * where the player's reading is until the arrival lands — see `shownRoomId` on
 * RunState. Undefined only before the first arrival of a run, when the honest
 * thing to show is nothing.
 *
 * The game master is NOT shown this. It is told where they actually stand.
 */
export function shownRoom(run: RunState): string | undefined {
  // A run saved before this existed comes back with nothing here; anything but
  // a room entry in flight means the narration has long since caught up.
  return run.shownRoomId ?? (run.stage === "room_entry" ? undefined : run.currentRoomId);
}

/**
 * Everything in the room that owes the player fresh prose. Empty means the room
 * can be re-shown exactly as they last read it, with no call at all.
 *
 * Concealed things fall out of this on their own — hiding something settles its
 * description debt, because `composed` is prose for the player and a concealed
 * thing owes them none. Revealing it opens the debt again, which is exactly
 * when there is somebody to read it.
 */
export function needsComposition(run: RunState, roomId: string = run.currentRoomId): AnyEntity[] {
  const e = run.entities;
  const room = e.rooms.find((r) => r.id === roomId);
  if (!room) return [];
  return [
    ...(entityNeedsComposition(room) ? [room] : []),
    ...directContents(roomId, e).filter(entityNeedsComposition),
  ];
}
